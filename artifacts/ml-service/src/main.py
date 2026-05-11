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

import joblib
import lightgbm as lgb
import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from sklearn.calibration import CalibratedClassifierCV
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
    label: int = Field(ge=0, le=1)


class TrainRequest(BaseModel):
    """Тренировка LightGBM-классификатора с изотонической калибровкой.

    Хронологический split на train/calib/test делается на стороне Node
    (там полный контекст по startTime); сюда приходят УЖЕ разбитые наборы.
    """

    label: str  # человекочитаемый ярлык, напр. "v3/prematch_winner_t1"
    feature_names: list[str]
    train: list[TrainSample]
    calib: list[TrainSample]
    test: list[TrainSample]
    # Гиперпараметры. Дефолты из ML_ROADMAP.md §4.5.
    num_leaves: int = 31
    learning_rate: float = 0.05
    n_estimators: int = 200
    min_data_in_leaf: int = 20
    feature_fraction: float = 0.8
    early_stopping_rounds: int = 20


class TrainMetrics(BaseModel):
    accuracy: float
    log_loss: float
    brier: float
    n: int


class TrainResponse(BaseModel):
    label: str
    blob_b64: str  # base64-encoded joblib bundle
    feature_names: list[str]
    train_metrics: TrainMetrics
    calib_metrics: TrainMetrics
    test_metrics_raw: TrainMetrics
    test_metrics_calibrated: TrainMetrics
    baseline_acc: float
    feature_importance: dict[str, float]
    train_seconds: float


class PredictRequest(BaseModel):
    blob_b64: str
    features: list[float]


class PredictResponse(BaseModel):
    raw_prob: float
    calibrated_prob: float


# ── Bundle helpers ──────────────────────────────────────────────────────


def _serialize_bundle(model: lgb.LGBMClassifier, calibrator: IsotonicRegression | None,
                      feature_names: list[str]) -> bytes:
    buf = io.BytesIO()
    joblib.dump(
        {
            "version": 1,
            "model": model,
            "calibrator": calibrator,
            "feature_names": feature_names,
            "lightgbm_version": lgb.__version__,
        },
        buf,
        compress=3,
    )
    return buf.getvalue()


def _deserialize_bundle(blob: bytes) -> tuple[lgb.LGBMClassifier, IsotonicRegression | None, list[str]]:
    bundle = joblib.load(io.BytesIO(blob))
    return bundle["model"], bundle.get("calibrator"), bundle.get("feature_names", [])


# ── In-process bundle cache (по hash blob'а) ────────────────────────────


_BUNDLE_CACHE: dict[str, tuple[lgb.LGBMClassifier, IsotonicRegression | None, list[str]]] = {}
_CACHE_MAX = 32  # достаточно для 8 моделей × tier


def _load_cached(blob_b64: str) -> tuple[lgb.LGBMClassifier, IsotonicRegression | None, list[str]]:
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


# ── FastAPI app ─────────────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("ml-service starting (lightgbm=%s, sklearn=%s)", lgb.__version__,
             __import__("sklearn").__version__)
    yield
    log.info("ml-service stopping")


app = FastAPI(title="Aegis ML Service", version="0.1.0", lifespan=lifespan)


@app.get("/ml/healthz")
@app.get("/healthz")
def healthz() -> dict[str, str | int]:
    return {
        "status": "ok",
        "lightgbm": lgb.__version__,
        "cached_bundles": len(_BUNDLE_CACHE),
        "pid": os.getpid(),
    }


@app.post("/ml/train", response_model=TrainResponse, dependencies=[Depends(require_token)])
@app.post("/train", response_model=TrainResponse, dependencies=[Depends(require_token)])
def train(req: TrainRequest) -> TrainResponse:
    if not req.train:
        raise HTTPException(400, "empty train set")
    if any(len(s.features) != len(req.feature_names) for s in req.train):
        raise HTTPException(400, "feature dim mismatch in train set")

    t0 = time.perf_counter()

    X_train = np.array([s.features for s in req.train], dtype=np.float64)
    y_train = np.array([s.label for s in req.train], dtype=np.int32)
    X_calib = np.array([s.features for s in req.calib], dtype=np.float64) if req.calib else np.empty((0, X_train.shape[1]))
    y_calib = np.array([s.label for s in req.calib], dtype=np.int32) if req.calib else np.empty(0, dtype=np.int32)
    X_test = np.array([s.features for s in req.test], dtype=np.float64) if req.test else np.empty((0, X_train.shape[1]))
    y_test = np.array([s.label for s in req.test], dtype=np.int32) if req.test else np.empty(0, dtype=np.int32)

    # Single-class guard (LightGBM упадёт на одном классе)
    if len(np.unique(y_train)) < 2:
        raise HTTPException(400, "train set has only one class")

    use_eval = len(X_calib) >= 10 and len(np.unique(y_calib)) >= 2
    callbacks = []
    if use_eval and req.early_stopping_rounds > 0:
        callbacks.append(lgb.early_stopping(req.early_stopping_rounds, verbose=False))
    callbacks.append(lgb.log_evaluation(0))

    model = lgb.LGBMClassifier(
        objective="binary",
        num_leaves=req.num_leaves,
        learning_rate=req.learning_rate,
        n_estimators=req.n_estimators,
        min_data_in_leaf=req.min_data_in_leaf,
        feature_fraction=req.feature_fraction,
        bagging_fraction=0.9,
        bagging_freq=5,
        random_state=42,
        verbose=-1,
        n_jobs=1,
    )

    if use_eval:
        model.fit(
            X_train, y_train,
            eval_set=[(X_calib, y_calib)],
            eval_metric="binary_logloss",
            callbacks=callbacks,
        )
    else:
        model.fit(X_train, y_train, callbacks=callbacks)

    # Изотоническая калибровка на holdout (calib set).
    calibrator: IsotonicRegression | None = None
    if len(X_calib) >= 20 and len(np.unique(y_calib)) >= 2:
        raw_calib_probs = model.predict_proba(X_calib)[:, 1]
        calibrator = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
        calibrator.fit(raw_calib_probs, y_calib)

    # Метрики
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

    blob = _serialize_bundle(model, calibrator, req.feature_names)
    blob_b64 = base64.b64encode(blob).decode("ascii")

    elapsed = time.perf_counter() - t0
    log.info(
        "[%s] trained in %.2fs n_train=%d n_calib=%d n_test=%d test_cal_acc=%.3f brier=%.4f bytes=%d",
        req.label, elapsed, len(X_train), len(X_calib), len(X_test),
        test_metrics_calibrated.accuracy, test_metrics_calibrated.brier, len(blob),
    )

    return TrainResponse(
        label=req.label,
        blob_b64=blob_b64,
        feature_names=req.feature_names,
        train_metrics=train_metrics,
        calib_metrics=calib_metrics,
        test_metrics_raw=test_metrics_raw,
        test_metrics_calibrated=test_metrics_calibrated,
        baseline_acc=baseline_acc,
        feature_importance=importance,
        train_seconds=elapsed,
    )


@app.post("/ml/predict", response_model=PredictResponse, dependencies=[Depends(require_token)])
@app.post("/predict", response_model=PredictResponse, dependencies=[Depends(require_token)])
def predict(req: PredictRequest) -> PredictResponse:
    try:
        model, calibrator, feature_names = _load_cached(req.blob_b64)
    except Exception as e:
        log.exception("failed to load bundle")
        raise HTTPException(400, f"bad blob: {e}")

    if feature_names and len(req.features) != len(feature_names):
        raise HTTPException(
            400,
            f"feature dim mismatch: got {len(req.features)}, expected {len(feature_names)}",
        )

    X = np.array([req.features], dtype=np.float64)
    raw = float(model.predict_proba(X)[0, 1])
    cal = float(calibrator.predict(np.array([raw]))[0]) if calibrator is not None else raw
    cal = max(0.0, min(1.0, cal))
    return PredictResponse(raw_prob=raw, calibrated_prob=cal)
