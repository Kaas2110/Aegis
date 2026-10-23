"""
Aegis ML Service — Wave 4 (LightGBM).

Заменяет pure-JS logistic regression в node-сервере для тех моделей, у которых
в БД engine='lightgbm'. Node-сервер ходит сюда HTTP'ом с timeout=200ms и
graceful fallback на LR (engine='logreg') при любой ошибке.

Эндпоинты:
  GET  /healthz                   — liveness
  POST /train                     — тренирует LightGBM на присланных samples
                                   и возвращает сериализованный blob + метрики
  POST /predict                   — инференс по blob + features

Модели НЕ хранятся в файлах — node-сервер передаёт blob каждый раз
(в кеше). Это упрощает атомарный swap (всё через model_versions в БД)
и позволяет сервису быть полностью stateless.
"""

from __future__ import annotations

import base64
import io
import logging
import os
import time
import warnings

warnings.filterwarnings(
    "ignore",
    message="X does not have valid feature names",
    category=UserWarning,
)
from contextlib import asynccontextmanager
from typing import Annotated

import hmac
import secrets

from typing import Literal

import joblib
import lightgbm as lgb
import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException
from .training_admission import require_legacy_http_training_admission, training_admission_status
from pydantic import BaseModel, Field
from sklearn.isotonic import IsotonicRegression

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("ml-service")


# ── Auth (defense-in-depth) ─────────────────────────────────────────────
# Service биндится только на localhost (paths=[] в artifact.toml), но на
# случай proxy-misconfig / future-exposure требуем X-ML-Token совпадающий
# с ML_SERVICE_TOKEN. Если переменная не задана — генерируем случайный и
# делимся им через файл /tmp/aegis_ml_token (api-server читает оттуда).
# Для прода рекомендуется задать ML_SERVICE_TOKEN как shared secret в обоих
# процессах — тогда файл-fallback не нужен.
_ML_TOKEN_FILE = "/tmp/aegis_ml_token"
_ML_SERVICE_TOKEN = os.environ.get("ML_SERVICE_TOKEN", "").strip()
if not _ML_SERVICE_TOKEN:
    _ML_SERVICE_TOKEN = secrets.token_urlsafe(32)
    try:
        os.umask(0o077)
        with open(_ML_TOKEN_FILE, "w") as f:
            f.write(_ML_SERVICE_TOKEN)
        os.chmod(_ML_TOKEN_FILE, 0o600)
    except OSError as e:
        log.error("failed to write %s: %s", _ML_TOKEN_FILE, e)
    log.warning("ML_SERVICE_TOKEN not set; generated ephemeral token (fingerprint=%s, written to %s)",
                _ML_SERVICE_TOKEN[:6] + "…", _ML_TOKEN_FILE)


def require_token(x_ml_token: Annotated[str | None, Header()] = None) -> None:
    if not x_ml_token or not hmac.compare_digest(x_ml_token, _ML_SERVICE_TOKEN):
        raise HTTPException(status_code=401, detail="invalid or missing X-ML-Token")


# ── Pydantic schemas ────────────────────────────────────────────────────


class TrainSample(BaseModel):
    features: list[float]
    # 0/1 для classification; произвольное число для regression.
    label: float


class TrainRequest(BaseModel):
    """Тренировка LightGBM-классификатора (или регрессора/квантильного регрессора)
    с изотонической калибровкой для classification.

    Хронологический split на train/calib/test делается на стороне Node
    (там полный контекст по startTime); сюда приходят УЖЕ разбитые наборы.
    """

    label: str  # человекочитаемый ярлык, напр. "v3/prematch_winner_t1"
    feature_names: list[str]
    task_type: Literal["classification", "regression", "quantile"] = "classification"
    # Для task_type="quantile": квантиль [0,1]. 0.5 = медиана (= regression median).
    alpha: float = Field(default=0.5, gt=0, lt=1)
    train: list[TrainSample]
    calib: list[TrainSample]
    test: list[TrainSample]
    # Calibration must never select the stopping iteration. Older callers without
    # this split use a fixed tree count, leaving calib independent of fitting.
    validation: list[TrainSample] = Field(default_factory=list)
    calibration: Literal["none", "isotonic"] = "none"
    min_calibration_samples: int = Field(default=1000, ge=1000)
    target_transform: Literal["identity", "log", "log1p"] = "identity"
    n_jobs: int = Field(default=1, ge=1, le=4)
    random_seed: int = 42
    # Гиперпараметры. Дефолты из ML_ROADMAP.md §4.5.
    num_leaves: int = 31
    learning_rate: float = 0.05
    n_estimators: int = 200
    min_data_in_leaf: int = 20
    feature_fraction: float = 0.8
    early_stopping_rounds: int = 20
    # Wave 5: «hard-match» evaluation. Если задан hard_feature_index —
    # после теста на полном test-сете считаем дополнительные метрики на
    # subset где |X_test[:, hard_feature_index]| < hard_threshold.
    # Для prematch_winner это elo_diff_norm — близкие по силе матчи.
    hard_feature_index: int | None = None
    hard_threshold: float = 0.4


class TrainMetrics(BaseModel):
    # accuracy/log_loss/brier — для classification; для regression
    # переиспользуем поля как rmse (в `brier`) и r2-pseudo (в `accuracy`).
    accuracy: float
    log_loss: float
    brier: float
    n: int
    # Legacy aliases above remain for old clients. New code must use these
    # task-specific names; RMSE is not a Brier score and R2 is not accuracy.
    metric_type: str = "classification"
    rmse: float | None = None
    mae: float | None = None
    r2: float | None = None
    natural_rmse: float | None = None
    natural_mae: float | None = None
    pinball: float | None = None
    quantile_coverage: float | None = None


class TrainResponse(BaseModel):
    label: str
    task_type: Literal["classification", "regression", "quantile"] = "classification"
    blob_b64: str  # base64-encoded joblib bundle
    feature_names: list[str]
    train_metrics: TrainMetrics
    calib_metrics: TrainMetrics
    test_metrics_raw: TrainMetrics
    test_metrics_calibrated: TrainMetrics
    baseline_acc: float
    feature_importance: dict[str, float]
    train_seconds: float
    residual_std: float | None = None  # только для regression
    alpha: float | None = None  # только для quantile
    # Wave 5: метрики на «близких» матчах (subset test'а).
    # Не None если в TrainRequest задан hard_feature_index И в subset было n>=10.
    hard_test_metrics: TrainMetrics | None = None


class PredictRequest(BaseModel):
    blob_b64: str
    features: list[float]


class PredictResponse(BaseModel):
    # classification → raw_prob/calibrated_prob; regression/quantile → mean/std.
    raw_prob: float | None = None
    calibrated_prob: float | None = None
    mean: float | None = None
    std: float | None = None
    task_type: Literal["classification", "regression", "quantile"] = "classification"


# ── Bundle helpers ──────────────────────────────────────────────────────


def _serialize_bundle(
    model,
    calibrator: IsotonicRegression | None,
    feature_names: list[str],
    task_type: str = "classification",
    residual_std: float | None = None,
    target_transform: str = "identity",
    random_seed: int = 42,
) -> bytes:
    buf = io.BytesIO()
    joblib.dump(
        {
            "version": 2,
            "task_type": task_type,
            "model": model,
            "calibrator": calibrator,
            "feature_names": feature_names,
            "residual_std": residual_std,
            "target_transform": target_transform,
            "random_seed": random_seed,
            "lightgbm_version": lgb.__version__,
        },
        buf,
        compress=3,
    )
    return buf.getvalue()


def _deserialize_bundle(blob: bytes) -> dict:
    bundle = joblib.load(io.BytesIO(blob))
    # v1 bundles не имели task_type — это всегда classification.
    bundle.setdefault("task_type", "classification")
    bundle.setdefault("residual_std", None)
    bundle.setdefault("feature_names", [])
    return bundle


# ── In-process bundle cache (по hash blob'а) ────────────────────────────


_BUNDLE_CACHE: dict[str, dict] = {}
_CACHE_MAX = 32  # достаточно для 8 моделей × tier


def _load_cached(blob_b64: str) -> dict:
    cached = _BUNDLE_CACHE.get(blob_b64)
    if cached is not None:
        return cached
    blob = base64.b64decode(blob_b64)
    bundle = _deserialize_bundle(blob)
    if len(_BUNDLE_CACHE) >= _CACHE_MAX:
        # Drop одну случайную (FIFO-ish — берём первый ключ).
        first_key = next(iter(_BUNDLE_CACHE))
        _BUNDLE_CACHE.pop(first_key, None)
    _BUNDLE_CACHE[blob_b64] = bundle
    return bundle


# ── Metrics ─────────────────────────────────────────────────────────────


def _metrics(probs: np.ndarray, labels: np.ndarray) -> TrainMetrics:
    n = len(labels)
    if n == 0:
        return TrainMetrics(accuracy=0.0, log_loss=0.0, brier=0.0, n=0)
    eps = 1e-9
    p = np.clip(probs, eps, 1 - eps)
    preds = (p >= 0.5).astype(int)
    acc = float((preds == labels).mean())
    ll = float(-np.mean(labels * np.log(p) + (1 - labels) * np.log(1 - p)))
    brier = float(np.mean((p - labels) ** 2))
    return TrainMetrics(accuracy=acc, log_loss=ll, brier=brier, n=n)


def _reg_metrics(preds: np.ndarray, labels: np.ndarray,
                 transform: str = "identity", alpha: float | None = None) -> TrainMetrics:
    """Метрики регрессии. accuracy = pseudo-R² (1 - SSE/SST), brier = RMSE."""
    n = len(labels)
    if n == 0:
        return TrainMetrics(accuracy=0.0, log_loss=0.0, brier=0.0, n=0)
    err = preds - labels
    rmse = float(np.sqrt(np.mean(err ** 2)))
    mae = float(np.mean(np.abs(err)))
    sst = float(np.sum((labels - labels.mean()) ** 2))
    r2 = float(1.0 - (np.sum(err ** 2) / sst)) if sst > 1e-9 else 0.0
    inverse = np.exp if transform == "log" else np.expm1 if transform == "log1p" else lambda x: x
    natural_error = inverse(preds) - inverse(labels)
    residual = labels - preds
    return TrainMetrics(accuracy=r2, log_loss=mae, brier=rmse, n=n,
        metric_type="quantile" if alpha is not None else "regression",
        rmse=rmse, mae=mae, r2=r2,
        natural_rmse=float(np.sqrt(np.mean(natural_error ** 2))),
        natural_mae=float(np.mean(np.abs(natural_error))),
        pinball=float(np.maximum(alpha * residual, (alpha - 1) * residual).mean()) if alpha is not None else None,
        quantile_coverage=float((labels <= preds).mean()) if alpha is not None else None)


# ── FastAPI app ─────────────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("ml-service starting (lightgbm=%s, sklearn=%s)", lgb.__version__,
             __import__("sklearn").__version__)
    yield
    log.info("ml-service stopping")


app = FastAPI(title="Aegis ML Service", version="0.1.0", lifespan=lifespan)

# Authenticated diagnostic route; independent of the serving model registry.
from .shadow_live_winner.router import create_live_winner_router
app.include_router(create_live_winner_router(require_token))
from .shadow_postdraft.router import create_postdraft_router
app.include_router(create_postdraft_router(require_token))
from .shadow_hazard.router import create_hazard_router
app.include_router(create_hazard_router(require_token))
from .shadow_wide.router import create_wide_router
app.include_router(create_wide_router(require_token))

# Read-only C2 diagnostics consume root-pinned local evidence; serving stays separate.
from .shadow_wide_c2.router import create_c2_local_router
app.include_router(create_c2_local_router(require_token))


@app.get("/diagnostics/training-admission", dependencies=[Depends(require_token)])
def legacy_http_training_status():
    return training_admission_status()

@app.get("/ml/healthz")
@app.get("/healthz")
def healthz() -> dict[str, str | int]:
    return {
        "status": "ok",
        "lightgbm": lgb.__version__,
        "cached_bundles": len(_BUNDLE_CACHE),
        "pid": os.getpid(),
    }


@app.post("/ml/train", response_model=TrainResponse, dependencies=[Depends(require_token), Depends(require_legacy_http_training_admission)])
@app.post("/train", response_model=TrainResponse, dependencies=[Depends(require_token), Depends(require_legacy_http_training_admission)])
def train(req: TrainRequest) -> TrainResponse:
    if not req.train:
        raise HTTPException(400, "empty train set")
    if not req.feature_names or len(set(req.feature_names)) != len(req.feature_names):
        raise HTTPException(400, "feature names must be nonempty and unique")
    for split_name in ("train", "validation", "calib", "test"):
        for sample in getattr(req, split_name):
            if len(sample.features) != len(req.feature_names):
                raise HTTPException(400, f"feature dim mismatch in {split_name} set")
            if not np.isfinite(sample.label) or any(np.isinf(v) for v in sample.features):
                raise HTTPException(400, f"invalid numeric value in {split_name} set")
            if req.task_type == "classification" and sample.label not in (0, 1):
                raise HTTPException(400, f"classification label must be 0 or 1 in {split_name}")

    t0 = time.perf_counter()

    is_reg = req.task_type == "regression"
    is_quantile = req.task_type == "quantile"

    X_train = np.array([s.features for s in req.train], dtype=np.float64)
    y_dtype = np.float64 if (is_reg or is_quantile) else np.int32
    y_train = np.array([s.label for s in req.train], dtype=y_dtype)
    X_calib = np.array([s.features for s in req.calib], dtype=np.float64) if req.calib else np.empty((0, X_train.shape[1]))
    y_calib = np.array([s.label for s in req.calib], dtype=y_dtype) if req.calib else np.empty(0, dtype=y_dtype)
    X_test = np.array([s.features for s in req.test], dtype=np.float64) if req.test else np.empty((0, X_train.shape[1]))
    y_test = np.array([s.label for s in req.test], dtype=y_dtype) if req.test else np.empty(0, dtype=y_dtype)
    X_validation = np.array([s.features for s in req.validation], dtype=np.float64) if req.validation else np.empty((0, X_train.shape[1]))
    y_validation = np.array([s.label for s in req.validation], dtype=y_dtype) if req.validation else np.empty(0, dtype=y_dtype)

    if not (is_reg or is_quantile) and len(np.unique(y_train)) < 2:
        raise HTTPException(400, "train set has only one class")

    use_eval = len(X_validation) >= 10 and (is_reg or is_quantile or len(np.unique(y_validation)) >= 2)
    callbacks = []
    if use_eval and req.early_stopping_rounds > 0:
        callbacks.append(lgb.early_stopping(req.early_stopping_rounds, verbose=False))
    callbacks.append(lgb.log_evaluation(0))

    if is_quantile:
        model = lgb.LGBMRegressor(
            objective="quantile",
            alpha=req.alpha,
            num_leaves=req.num_leaves,
            learning_rate=req.learning_rate,
            n_estimators=req.n_estimators,
            min_data_in_leaf=req.min_data_in_leaf,
            feature_fraction=req.feature_fraction,
            bagging_fraction=0.9,
            bagging_freq=5,
            random_state=req.random_seed,
            verbose=-1,
            n_jobs=req.n_jobs,
        )
    elif is_reg:
        model = lgb.LGBMRegressor(
            objective="regression",
            num_leaves=req.num_leaves,
            learning_rate=req.learning_rate,
            n_estimators=req.n_estimators,
            min_data_in_leaf=req.min_data_in_leaf,
            feature_fraction=req.feature_fraction,
            bagging_fraction=0.9,
            bagging_freq=5,
            random_state=req.random_seed,
            verbose=-1,
            n_jobs=req.n_jobs,
        )
    else:
        model = lgb.LGBMClassifier(
            objective="binary",
            num_leaves=req.num_leaves,
            learning_rate=req.learning_rate,
            n_estimators=req.n_estimators,
            min_data_in_leaf=req.min_data_in_leaf,
            feature_fraction=req.feature_fraction,
            bagging_fraction=0.9,
            bagging_freq=5,
            random_state=req.random_seed,
            verbose=-1,
            n_jobs=req.n_jobs,
        )

    eval_metric = "quantile" if is_quantile else "rmse" if is_reg else "binary_logloss"
    if use_eval:
        model.fit(
            X_train, y_train,
            eval_set=[(X_validation, y_validation)],
            eval_metric=eval_metric,
            callbacks=callbacks,
        )
    else:
        model.fit(X_train, y_train, callbacks=callbacks)

    calibrator: IsotonicRegression | None = None
    residual_std: float | None = None

    if is_reg or is_quantile:
        # Residual std из calib set (или из train, если calib пуст).
        # Для quantile: std не имеет смысла (квантиль сам задаёт интервал),
        # оставляем None.
        if is_reg:
            if len(X_calib) >= 5:
                residuals = y_calib - model.predict(X_calib)
                residual_std = float(np.std(residuals, ddof=1))

        train_pred = model.predict(X_train)
        train_metrics = _reg_metrics(train_pred, y_train, req.target_transform, req.alpha if is_quantile else None)
        calib_metrics = TrainMetrics(accuracy=0, log_loss=0, brier=0, n=0)
        if len(X_calib) > 0:
            calib_pred = model.predict(X_calib)
            calib_metrics = _reg_metrics(calib_pred, y_calib, req.target_transform, req.alpha if is_quantile else None)
        test_metrics_raw = TrainMetrics(accuracy=0, log_loss=0, brier=0, n=0)
        test_metrics_calibrated = TrainMetrics(accuracy=0, log_loss=0, brier=0, n=0)
        if len(X_test) > 0:
            test_pred = model.predict(X_test)
            test_metrics_raw = _reg_metrics(test_pred, y_test, req.target_transform, req.alpha if is_quantile else None)
            test_metrics_calibrated = test_metrics_raw
        baseline_acc = float(y_test.mean()) if len(y_test) > 0 else 0.0
    else:
        if req.calibration == "isotonic" and len(X_calib) >= req.min_calibration_samples and len(np.unique(y_calib)) >= 2:
            raw_calib_probs = model.predict_proba(X_calib)[:, 1]
            calibrator = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
            calibrator.fit(raw_calib_probs, y_calib)

        train_probs = model.predict_proba(X_train)[:, 1]
        train_metrics = _metrics(train_probs, y_train)

        calib_metrics = TrainMetrics(accuracy=0, log_loss=0, brier=0, n=0)
        if len(X_calib) > 0:
            calib_raw = model.predict_proba(X_calib)[:, 1]
            calib_cal = calibrator.predict(calib_raw) if calibrator is not None else calib_raw
            calib_metrics = _metrics(calib_cal, y_calib)

        test_metrics_raw = TrainMetrics(accuracy=0, log_loss=0, brier=0, n=0)
        test_metrics_calibrated = TrainMetrics(accuracy=0, log_loss=0, brier=0, n=0)
        if len(X_test) > 0:
            test_raw = model.predict_proba(X_test)[:, 1]
            test_cal = calibrator.predict(test_raw) if calibrator is not None else test_raw
            test_metrics_raw = _metrics(test_raw, y_test)
            test_metrics_calibrated = _metrics(test_cal, y_test)

        baseline_acc = float(y_test.mean()) if len(y_test) > 0 else 0.0

    importance = {
        name: float(imp)
        for name, imp in zip(req.feature_names, model.feature_importances_)
    }

    # Wave 5: hard-match метрики (только для classification, и только если
    # клиент указал hard_feature_index с разумными границами).
    hard_test_metrics: TrainMetrics | None = None
    if (
        not (is_reg or is_quantile)
        and req.hard_feature_index is not None
        and 0 <= req.hard_feature_index < X_train.shape[1]
        and len(X_test) > 0
    ):
        feat_col = X_test[:, req.hard_feature_index]
        mask = np.abs(feat_col) < req.hard_threshold
        if int(mask.sum()) >= 10:
            X_hard = X_test[mask]
            y_hard = y_test[mask]
            hard_raw = model.predict_proba(X_hard)[:, 1]
            hard_cal = calibrator.predict(hard_raw) if calibrator is not None else hard_raw
            hard_test_metrics = _metrics(hard_cal, y_hard)
            log.info(
                "[%s] hard-match eval: n=%d acc=%.3f brier=%.4f (threshold |x[%d]|<%.2f)",
                req.label, hard_test_metrics.n, hard_test_metrics.accuracy,
                hard_test_metrics.brier, req.hard_feature_index, req.hard_threshold,
            )

    blob = _serialize_bundle(model, calibrator, req.feature_names,
                             task_type=req.task_type, residual_std=residual_std,
                             target_transform=req.target_transform, random_seed=req.random_seed)
    blob_b64 = base64.b64encode(blob).decode("ascii")

    elapsed = time.perf_counter() - t0
    log.info(
        "[%s/%s] trained in %.2fs n_train=%d n_calib=%d n_test=%d test_acc=%.3f brier=%.4f bytes=%d",
        req.label, req.task_type, elapsed, len(X_train), len(X_calib), len(X_test),
        test_metrics_calibrated.accuracy, test_metrics_calibrated.brier, len(blob),
    )

    return TrainResponse(
        label=req.label,
        task_type=req.task_type,
        blob_b64=blob_b64,
        feature_names=req.feature_names,
        train_metrics=train_metrics,
        calib_metrics=calib_metrics,
        test_metrics_raw=test_metrics_raw,
        test_metrics_calibrated=test_metrics_calibrated,
        baseline_acc=baseline_acc,
        feature_importance=importance,
        train_seconds=elapsed,
        residual_std=residual_std,
        alpha=req.alpha if is_quantile else None,
        hard_test_metrics=hard_test_metrics,
    )


@app.post("/ml/predict", response_model=PredictResponse, dependencies=[Depends(require_token)])
@app.post("/predict", response_model=PredictResponse, dependencies=[Depends(require_token)])
def predict(req: PredictRequest) -> PredictResponse:
    try:
        bundle = _load_cached(req.blob_b64)
    except Exception as e:
        log.exception("failed to load bundle")
        raise HTTPException(400, f"bad blob: {e}")

    model = bundle["model"]
    calibrator = bundle.get("calibrator")
    feature_names = bundle.get("feature_names", [])
    task_type = bundle.get("task_type", "classification")

    if feature_names and len(req.features) != len(feature_names):
        raise HTTPException(
            400,
            f"feature dim mismatch: got {len(req.features)}, expected {len(feature_names)}",
        )

    X = np.array([req.features], dtype=np.float64)

    if task_type in ("regression", "quantile"):
        mean = float(model.predict(X)[0])
        # Missing uncertainty is unknown, not zero uncertainty.
        std = float(bundle["residual_std"]) if task_type == "regression" and bundle.get("residual_std") is not None else None
        return PredictResponse(mean=mean, std=std, task_type=task_type)  # type: ignore[arg-type]

    raw = float(model.predict_proba(X)[0, 1])
    cal = float(calibrator.predict(np.array([raw]))[0]) if calibrator is not None else raw
    cal = max(0.0, min(1.0, cal))
    return PredictResponse(raw_prob=raw, calibrated_prob=cal, task_type="classification")


# Authenticated rich-series diagnostic reader; public prediction guards unchanged.
from .shadow_series_rich.router import create_series_diagnostic_router
app.include_router(create_series_diagnostic_router(require_token))
