"""Bounded offline experiment; reads analytics, inserts INACTIVE candidates only.

Run from artifacts/ml-service: python -m src.research.run_audit_training --output DIR
No provider calls, no automatic publication, no serving contract is implied.
"""
from __future__ import annotations
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import numpy as np
import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from ..main import TrainRequest, TrainSample, train, _deserialize_bundle, _metrics, _reg_metrics
from .causal_dataset import (CONTRACT, BASE_NAMES, DRAFT_NAMES, ROSTER_NAMES, LIVE_NAMES,
                             UNSUPPORTED_LIVE_FEATURES,
                             prematch_rows, live_rows, split_rows, fingerprint, first_blood)
from .evaluation import (grouped_metrics, grouped_regression_metrics, reliability, bootstrap_delta, map_indexes)

def load_data(connection):
    # Keep the target contract in one testable Python extractor. SQL only
    # projects necessary evidence; a server cursor bounds memory from JSON.
    query = """
    SELECT m.*, d.radiant_picks, d.dire_picks, d.radiant_account_ids, d.dire_account_ids,
      CASE WHEN jsonb_typeof(p.objectives)='array' THEN
        (SELECT jsonb_agg(e) FROM jsonb_array_elements(p.objectives) e
         WHERE e->>'type'='CHAT_MESSAGE_FIRSTBLOOD') END first_blood_objectives,
      CASE WHEN jsonb_typeof(p.players)='array' THEN
        (SELECT jsonb_agg(jsonb_build_object('player_slot',player->'player_slot',
                                           'kills_log',player->'kills_log'))
         FROM jsonb_array_elements(p.players) player
         WHERE jsonb_typeof(player)='object') END first_blood_players
    FROM pro_matches m LEFT JOIN match_drafts d USING(match_id)
    LEFT JOIN match_parsed p USING(match_id)
    ORDER BY m.start_time,m.match_id
    """
    matches = []
    with connection.cursor(row_factory=dict_row) as c:
        c.execute("SET LOCAL statement_timeout='120s'")
    with connection.cursor(name="causal_match_reader", row_factory=dict_row) as c:
        c.execute(query)
        while batch := c.fetchmany(256):
            for row in batch:
                row["first_blood_label"] = first_blood(row.pop("first_blood_objectives"),
                                                       row.pop("first_blood_players"))
                matches.append(row)
    with connection.cursor(row_factory=dict_row) as c:
        snapshots = c.execute("SELECT id,match_id,captured_at,game_time_sec,radiant_lead,radiant_score,"
          "dire_score,building_state,source,raw_payload FROM live_snapshots WHERE source='live' "
          "ORDER BY captured_at,id").fetchall()
        active = c.execute("SELECT id,version,kind,features_version,engine,md5(binary_blob) blob_hash "
                           "FROM model_versions WHERE is_active ORDER BY id").fetchall()
    return matches, snapshots, active


def prediction(bundle, x):
    if bundle.get("task_type") in ("regression", "quantile"):
        return bundle["model"].predict(x)
    p = bundle["model"].predict_proba(x)[:, 1]
    return bundle["calibrator"].predict(p) if bundle.get("calibrator") is not None else p


def natural_target(target, value):
    return math_log(value + 1) if target == "kills" else math_log(value) if target == "duration" else value

def math_log(value):
    return float(np.log(max(value, 1e-9)))

def parse_live_boundaries(value):
    """Explicit UTC midnight boundaries, selected before live quality is scored."""
    parts = [part.strip() for part in value.split(",")]
    try:
        dates = [datetime.strptime(part, "%Y-%m-%d").replace(tzinfo=timezone.utc) for part in parts]
        if (len(dates) != 3 or any(date.strftime("%Y-%m-%d") != part for date, part in zip(dates, parts))
                or not dates[0] < dates[1] < dates[2]):
            raise ValueError()
    except ValueError as error:
        raise argparse.ArgumentTypeError("use three increasing UTC dates: YYYY-MM-DD,YYYY-MM-DD,YYYY-MM-DD") from error
    return [int(date.timestamp()) for date in dates]


def requested_datasets(dataset, prematch, live):
    return [(name, rows) for name, rows in (("prematch", prematch), ("live", live))
            if dataset in ("all", name)]


def save_candidate(c, response, manifest, feature_version, kind, view, run_id):
    blob = base64.b64decode(response.blob_b64)
    version = f"causal-{run_id}-{kind}-{view}"
    metadata = {"contract": CONTRACT, "validationStatus": "research_candidate",
                "eligibleForServing": False, "eligibleForPromotion": False, "blockers": ["online_feature_parity_not_implemented", "prospective_shadow_validation_required"],
                "taskType": response.task_type, "target": kind, "targetTransform": manifest["target_transform"],
                "metrics": response.model_dump(exclude={"blob_b64"}),
                "experiment": manifest, "sourceRevision": manifest["source_revision"]}
    classification = response.task_type == "classification"
    result = c.execute("""INSERT INTO model_versions
       (version,kind,algorithm,features,weights,features_version,engine,binary_blob,
        train_accuracy,test_accuracy,brier_score,train_sample_size,test_sample_size,metadata,is_active)
       VALUES (%s,%s,%s,%s,%s,%s,'lightgbm',%s,%s,%s,%s,%s,%s,%s,false) RETURNING id""",
       (version, kind, "causal_lightgbm_research", Jsonb(response.feature_names), Jsonb({}), feature_version,
        blob, response.train_metrics.accuracy if classification else None,
        response.test_metrics_calibrated.accuracy if classification else None,
        response.test_metrics_calibrated.brier if classification else None,
        response.train_metrics.n, response.test_metrics_calibrated.n, Jsonb(metadata)))
    return result.fetchone()["id"]

def run(args):
    out = Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=True)
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    repository = Path(__file__).resolve().parents[4]
    # This explicitly chosen local checkout may be owned by the desktop sandbox
    # account. Do not alter the user's global Git trust configuration.
    revision = subprocess.check_output(["git", "-c", f"safe.directory={repository.as_posix()}",
                                        "-C", str(repository), "rev-parse", "HEAD"], text=True).strip()
    source_paths = [Path(__file__).parent / name for name in ("causal_dataset.py", "evaluation.py", "run_audit_training.py")]
    source_paths.append(Path(__file__).parent.parent / "main.py")
    source_hashes = {str(path.relative_to(Path(__file__).parent.parent)): hashlib.sha256(path.read_bytes()).hexdigest()
                     for path in source_paths}
    code_hash = hashlib.sha256(json.dumps(source_hashes, sort_keys=True).encode()).hexdigest()
    with psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as c:
        c.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        matches, snapshots, before = load_data(c)
    rows = prematch_rows(matches)
    live = live_rows(snapshots, rows)
    report = {"run_id": run_id, "contract": CONTRACT, "source_revision": revision, "code_sha256": code_hash,
              "source_file_hashes": source_hashes,
              "requested_dataset": args.dataset, "live_calendar_boundaries_unix": args.live_boundaries,
              "unsupported_live_features": UNSUPPORTED_LIVE_FEATURES,
              "generated_at": datetime.now(timezone.utc).isoformat(), "prematch_rows": len(rows), "live_rows": len(live),
              "live_matches": len({r["match_id"] for r in live}), "dataset_hash": fingerprint(rows + live),
              "active_models_before": before, "candidates": [], "skipped": [],
              "limitations": ["Historical data availability reconstructed at game end plus five minutes; not a prospective replay.",
                "No patch identifiers in source match table; hero statistics pool several patches.",
                "No online feature contract yet; all saved models remain inactive.",
                "Live archive contains only observed OpenDota fields, no rich STRATZ telemetry.",
                "Tower features excluded: live building_state bit layout is not verified; it is not the assumed 22-bit tower mask.",
                "No candidate may be promoted on this offline test alone.",
                "Missing series IDs use a pair/league/day grouping heuristic; true series identity is unverified.",
                "Archived completed drafts/rosters are assumed observed at prematch decision time; historical timestamps are not proof of that availability.",
                "Exploratory multi-model comparisons; bootstrap intervals are not adjusted for multiple comparisons.",
                "Live fitting weights every sampled frame equally, so longer maps contribute more training rows; map-balanced scores are reported separately."]}
    for dataset_name, dataset in requested_datasets(args.dataset, rows, live):
        try:
            splits, split_manifest = split_rows(dataset, boundaries=args.live_boundaries if dataset_name == "live" else None)
        except ValueError as error:
            report["skipped"].append({"dataset": dataset_name, "reason": str(error)})
            continue
        (out / f"{dataset_name}-split-manifest.json").write_text(json.dumps(split_manifest, indent=2), encoding="utf-8")
        views = ("base", "draft", "roster") if dataset_name == "prematch" else ("base", "draft")
        targets = ("winner", "first_blood", "kills", "duration") if dataset_name == "prematch" else ("winner", "kills", "duration")
        for view in views:
            for target in targets:
                name = f"{dataset_name}_{target}/{view}"
                selected = {k: [r for r in data if r.get(view) is not None and r.get(target) is not None]
                            for k, data in splits.items()}
                sizes = {k: len({r["match_id"] for r in data}) for k, data in selected.items()}
                group_sizes = {k: len({r["group"] for r in data}) for k, data in selected.items()}
                if sizes["train"] < 80 or min(sizes["validation"], sizes["calib"], sizes["test"]) < 15:
                    report["skipped"].append({"model": name, "reason": "insufficient_independent_matches", "split_matches": sizes})
                    continue
                feature_names = BASE_NAMES + (DRAFT_NAMES if view != "base" else []) + (ROSTER_NAMES if view == "roster" else [])
                if dataset_name == "live":
                    feature_names += LIVE_NAMES
                classification = target in ("winner", "first_blood")
                if classification and len({r[target] for r in selected["train"]}) < 2:
                    report["skipped"].append({"model": name, "reason": "single_class_train"})
                    continue
                data = {k: [TrainSample(features=r[view], label=natural_target(target, r[target])) for r in v]
                        for k, v in selected.items()}
                req = TrainRequest(label=name, feature_names=feature_names,
                  task_type="classification" if classification else "regression", **data,
                  target_transform="log1p" if target == "kills" else "log" if target == "duration" else "identity",
                  calibration="none", n_jobs=4, num_leaves=15, n_estimators=180,
                  min_data_in_leaf=40, random_seed=42)
                print(f"Training {name}: independent maps {sizes}", flush=True)
                response = train(req)
                bundle = _deserialize_bundle(base64.b64decode(response.blob_b64))
                x = {k: np.array([r[view] for r in v], dtype=float) for k, v in selected.items()}
                y = {k: np.array([natural_target(target, r[target]) for r in v], dtype=float) for k, v in selected.items()}
                p = prediction(bundle, x["test"])
                result = {"model": name, "feature_names": feature_names, "split_matches": sizes, "split_groups": group_sizes,
                    "target_transform": req.target_transform,
                    "metrics": response.model_dump(exclude={"blob_b64", "feature_names"}),
                    "first_test_start": min(r["start"] for r in selected["test"]),
                    "last_test_start": max(r["start"] for r in selected["test"]),
                    "calibration": "identity_prespecified; independent calibration block reserved for future calibration research"}
                if classification:
                    constant = np.full(len(p), np.mean([y["train"][ix].mean() for ix in map_indexes(selected["train"]).values()]))
                    result["constant_prior"] = _metrics(constant, y["test"]).model_dump()
                    result["constant_prior_macro_per_match"] = grouped_metrics(constant, y["test"], selected["test"])
                    lr = make_pipeline(SimpleImputer(add_indicator=True), StandardScaler(),
                                       LogisticRegression(C=1, max_iter=1000, random_state=42))
                    # Fixed regularization, same train/holdout. No test-based tuning.
                    lr.fit(x["train"], y["train"])
                    lr_p = lr.predict_proba(x["test"])[:, 1]
                    result["logistic_baseline"] = _metrics(lr_p, y["test"]).model_dump()
                    result["logistic_baseline_macro_per_match"] = grouped_metrics(lr_p, y["test"], selected["test"])
                    result["delta_vs_logistic"] = bootstrap_delta(p, lr_p, y["test"], selected["test"])
                    result["reliability"] = reliability(p, y["test"])
                    result["reliability_map_weighted"] = reliability(p, y["test"], selected["test"])
                    result["macro_per_match"] = grouped_metrics(p, y["test"], selected["test"])
                    if target == "winner":
                        elo = x["test"][:, 1]
                        result["elo_baseline"] = _metrics(elo, y["test"]).model_dump()
                        result["elo_baseline_macro_per_match"] = grouped_metrics(elo, y["test"], selected["test"])
                    if dataset_name == "live":
                        result["by_phase"] = {}
                        for lo, hi in ((0, 10), (10, 20), (20, 30), (30, 45), (45, 180)):
                            mask = np.array([lo <= r["game_minute"] < hi for r in selected["test"]])
                            if mask.any():
                                result["by_phase"][f"{lo}-{hi}"] = {
                                    "row_metrics": _metrics(p[mask], y["test"][mask]).model_dump(),
                                    "macro_per_match": grouped_metrics(p[mask], y["test"][mask],
                                        [r for r, keep in zip(selected["test"], mask) if keep])}
                else:
                    constant = np.full(len(p), np.mean([y["train"][ix].mean() for ix in map_indexes(selected["train"]).values()]))
                    result["constant_baseline"] = _reg_metrics(constant, y["test"], req.target_transform).model_dump()
                    result["macro_per_match"] = grouped_regression_metrics(p, y["test"], selected["test"], req.target_transform)
                    result["constant_baseline_macro_per_match"] = grouped_regression_metrics(constant, y["test"], selected["test"], req.target_transform)
                    result["delta_vs_constant"] = bootstrap_delta(p, constant, y["test"], selected["test"], req.target_transform, classification=False)
                result["by_month"] = {}
                months = [datetime.fromtimestamp(r["start"], timezone.utc).strftime("%Y-%m") for r in selected["test"]]
                for month in sorted(set(months)):
                    mask = np.array([v == month for v in months])
                    month_rows = [r for r, keep in zip(selected["test"], mask) if keep]
                    result["by_month"][month] = {
                        "row_metrics": (_metrics(p[mask], y["test"][mask]) if classification else
                            _reg_metrics(p[mask], y["test"][mask], req.target_transform)).model_dump(),
                        "macro_per_match": (grouped_metrics(p[mask], y["test"][mask], month_rows) if classification else
                            grouped_regression_metrics(p[mask], y["test"][mask], month_rows, req.target_transform))}
                manifest = {"source_revision": revision, "code_sha256": code_hash, "dataset_hash": report["dataset_hash"],
                    "split": split_manifest, "target_transform": req.target_transform, "seed": 42, "availability": "event_end_plus_300_seconds_reconstructed",
                    "contract": CONTRACT, "unsupported_live_features": UNSUPPORTED_LIVE_FEATURES if dataset_name == "live" else [],
                    "eligibleForServing": False}
                if args.save_candidates:
                    with psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as c:
                        result["candidate_id"] = save_candidate(c, response, manifest, 101 + views.index(view),
                                                              dataset_name + "_" + target, view, run_id)
                blob_file = out / (name.replace("/", "-") + ".joblib")
                blob_file.write_bytes(base64.b64decode(response.blob_b64))
                result["blob_sha256"] = hashlib.sha256(blob_file.read_bytes()).hexdigest()
                # Keep individual predictions for paired ablations on common test maps.
                pred_path = out / (name.replace("/", "-") + "-predictions.json")
                pred_path.write_text(json.dumps([{"match_id": r["match_id"], "snapshot_id": r.get("snapshot_id"),
                    "group": r["group"], "prediction": float(prob), "target": float(label), "target_transform": req.target_transform}
                    for r, prob, label in zip(selected["test"], p, y["test"])], separators=(",", ":")), encoding="utf-8")
                report["candidates"].append(result)
                (out / "training-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    with psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as c:
        after = c.execute("SELECT id,version,kind,features_version,engine,md5(binary_blob) blob_hash "
                          "FROM model_versions WHERE is_active ORDER BY id").fetchall()
    report["active_models_unchanged"] = before == after
    (out / "training-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    if before != after:
        raise RuntimeError("Active model manifest changed during candidate training")
    print(json.dumps({"candidates": len(report["candidates"]), "skipped": report["skipped"],
                      "active_models_unchanged": True, "report": str(out / "training-report.json")}))

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--save-candidates", action="store_true")
    parser.add_argument("--dataset", choices=("all", "prematch", "live"), default="all")
    parser.add_argument("--live-boundaries", type=parse_live_boundaries,
                        help="prespecified UTC midnight dates, e.g. 2026-05-21,2026-05-26,2026-05-29")
    run(parser.parse_args())
