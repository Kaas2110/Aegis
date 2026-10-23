"""Exploratory, file-only winner experiment: prepare -> fit/select -> evaluate.

The database is opened READ ONLY. All windows/views share eligible maps in each
split, histories are reconstructed once, and test labels never enter fitting or
window selection. This is not a new independent confirmation of the old test.
"""
from __future__ import annotations

import argparse
import base64
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sys

for _thread_variable in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ[_thread_variable] = "4"

import numpy as np
import psycopg
from psycopg.rows import dict_row

from ..main import TrainRequest, TrainSample, train, _deserialize_bundle
from .causal_dataset import (DAY, CONTRACT, BASE_NAMES, DRAFT_NAMES, ROSTER_NAMES,
                             prematch_rows, split_rows, fingerprint)
from .evaluation import grouped_metrics, classification_losses, reliability

WINDOWS = (30, 90, 180, 365)
VIEWS = ("base", "roster")
BOUNDARIES = ("2026-05-21", "2026-05-26", "2026-06-01")
PROTOCOL = "training_window_comparison_v1"
MIN_TRAIN_MAPS = 500
MIN_HOLDOUT_MAPS = 100
MIN_HOLDOUT_GROUPS = 50


def utc(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat() if value is not None else None


def epoch(value):
    return int(datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False), encoding="utf-8", newline="\n")
    temporary.replace(path)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_hashes():
    folder = Path(__file__).parent
    paths = [folder / name for name in ("run_window_comparison.py", "causal_dataset.py", "evaluation.py")]
    paths.append(folder.parent / "main.py")
    return {path.name: sha(path) for path in paths}


def active_models(connection):
    return connection.execute("SELECT id,version,kind,features_version,engine,md5(binary_blob) AS blob_hash "
                              "FROM model_versions WHERE is_active ORDER BY id").fetchall()


def load_matches(connection):
    # No player profile data, parsed replay blobs, provider calls or mutations.
    return connection.execute("""SELECT m.match_id,m.start_time,m.duration,m.radiant_team_id,m.dire_team_id,
      m.radiant_win,m.radiant_score,m.dire_score,m.series_id,m.series_type,m.league_id,
      d.radiant_picks,d.dire_picks,d.radiant_account_ids,d.dire_account_ids
      FROM pro_matches m LEFT JOIN match_drafts d USING(match_id)
      ORDER BY m.start_time,m.match_id""").fetchall()


def common_splits(rows, boundaries):
    # Split the entire cohort BEFORE selecting roster coverage: missing fields
    # cannot make an otherwise crossing series look disjoint.
    splits, manifest = split_rows(rows, boundaries=boundaries)
    common = {name: [r for r in data if r["roster"] is not None and r["winner"] in (0, 1)]
              for name, data in splits.items()}
    assert_disjoint(common)
    return common, splits, manifest


def assert_disjoint(splits):
    seen_ids, seen_groups = set(), set()
    previous_available = None
    for name in ("train", "validation", "calib", "test"):
        rows = splits[name]
        ids, groups = {r["match_id"] for r in rows}, {r["group"] for r in rows}
        if len(ids) != len(rows) or ids & seen_ids or groups & seen_groups:
            raise ValueError("duplicate maps or overlapping series in window experiment")
        if rows and previous_available is not None and min(r["start"] for r in rows) <= previous_available:
            raise ValueError("a prior split outcome is not yet available")
        if rows:
            previous_available = max(r["label_available"] for r in rows)
        for row in rows:
            if row["latest_feature_outcome"] >= row["start"]:
                raise ValueError("future outcome in reconstructed feature vector")
        seen_ids |= ids
        seen_groups |= groups


def window_train(common_train, complete_train, cutoff, days):
    if days not in WINDOWS:
        raise ValueError("window not in the preregistered set")
    groups = {}
    for r in complete_train:
        first, available = groups.get(r["group"], (r["start"], r["label_available"]))
        groups[r["group"]] = min(first, r["start"]), max(available, r["label_available"])
    keep = {g for g, (first, available) in groups.items()
            if first >= cutoff - days * DAY and available < cutoff}
    return [r for r in common_train if r["group"] in keep]


def summary(rows):
    return {"maps": len(rows), "groups": len({r["group"] for r in rows}),
            "first_start": utc(min((r["start"] for r in rows), default=None)),
            "last_start": utc(max((r["start"] for r in rows), default=None)),
            "last_label_available": utc(max((r["label_available"] for r in rows), default=None))}


def research_flags():
    return {"validationStatus": "exploratory_window_candidate", "eligibleForServing": False,
            "eligibleForPromotion": False, "active": False,
            "blockers": ["online_feature_parity_not_implemented", "prospective_confirmation_required"]}


def prepare(out):
    if (out / "protocol.json").exists():
        raise ValueError("frozen protocol already exists; use it rather than overwriting")
    with psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as c:
        c.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        c.execute("SET LOCAL statement_timeout='120s'")
        matches, active = load_matches(c), active_models(c)
    rows = prematch_rows(matches)
    boundaries = [epoch(v) for v in BOUNDARIES]
    common, complete, split_manifest = common_splits(rows, boundaries)
    cutoff = boundaries[0] - DAY
    training = {str(days): window_train(common["train"], complete["train"], cutoff, days) for days in WINDOWS}
    eligible, skipped = [], []
    for days in WINDOWS:
        data = training[str(days)]
        if len(data) < MIN_TRAIN_MAPS or len({r["winner"] for r in data}) < 2:
            skipped.append({"days": days, "reason": "insufficient_train_maps_or_classes", **summary(data)})
        else:
            eligible.append(days)
    for split in ("validation", "calib", "test"):
        data = common[split]
        if len(data) < MIN_HOLDOUT_MAPS or len({r["group"] for r in data}) < MIN_HOLDOUT_GROUPS:
            raise ValueError(f"insufficient common {split}: {summary(data)}")
    if len(eligible) < 2:
        raise ValueError("fewer than two eligible windows")
    # Freeze only features/labels/identifiers needed by this experiment. No
    # account IDs, profiles, raw replays or external credentials are exported.
    keys = ("match_id", "group", "start", "label_available", "latest_feature_outcome", "base", "roster", "winner")
    clean = lambda values: [{key: r[key] for key in keys} for r in values]
    frozen = {"holdouts": {k: clean(common[k]) for k in ("validation", "calib", "test")},
              "training": {str(days): clean(training[str(days)]) for days in eligible}}
    write_json(out / "frozen-dataset.json", frozen)
    now = datetime.now(timezone.utc).isoformat()
    protocol = {"protocol": PROTOCOL, "contract": CONTRACT, "prepared_at": now,
        "source_hashes": source_hashes(), "dataset_sha256": sha(out / "frozen-dataset.json"),
        "historical_rows_fingerprint": fingerprint(rows), "active_models_before": active,
        "source_data": summary(rows), "eligible_windows_days": eligible, "skipped_windows": skipped,
        "boundaries_utc": list(BOUNDARIES), "train_cutoff_utc": utc(cutoff), "purge_seconds": DAY,
        "train_windows": {str(days): {"requested_lower_utc": utc(cutoff - days * DAY), **summary(training[str(days)])}
                          for days in WINDOWS},
        "common_holdouts": {k: summary(common[k]) for k in ("validation", "calib", "test")},
        "complete_holdouts_before_roster_filter": {k: summary(complete[k]) for k in ("validation", "calib", "test")},
        "split_manifest": split_manifest,
        "selection_rule": "Per view: minimum validation macro-map Brier; exact ties: log_loss, then shorter window. Test excluded.",
        "window_semantics": "Training map eligibility only. History features are built once identically using all prior available outcomes; team history 180d, Elo and hero/player counters retain earlier history.",
        "model_parameters": {"n_jobs": 4, "n_estimators": 180, "num_leaves": 15, "min_data_in_leaf": 40,
                             "learning_rate": .05, "early_stopping_rounds": 20, "random_seed": 42, "calibration": "none"},
        "prospective_reserved_from_utc": "2026-10-04T00:00:00+00:00",
        "limitations": ["Exploratory: calendar holdouts overlap the previously inspected historical test.",
          "No new claim of independent confirmation; prospective period is reserved and not collected by this script.",
          "365-day training window does not mean every feature has a 365-day history window.",
          "Training windows differ in both recency and sample size; this does not isolate a pure aging effect.",
          "Roster availability is sparse after June; common test is not representative of all recent pro maps.",
          "Labels available at end+300 are reconstructed; completed roster/draft observation timestamps are unverified.",
          "No per-match patch IDs; mixture of patches cannot be controlled in this experiment.",
          "Bootstrap is exploratory and unadjusted for multiple window/view comparisons.",
          "Calibration block is held apart and no calibrator is fitted."], **research_flags()}
    write_json(out / "protocol.json", protocol)
    print(json.dumps({k: protocol[k] for k in ("source_data", "train_cutoff_utc", "train_windows", "common_holdouts", "eligible_windows_days")}, indent=2), flush=True)


def frozen_inputs(out):
    protocol = json.loads((out / "protocol.json").read_text(encoding="utf-8"))
    if protocol["source_hashes"] != source_hashes() or protocol["dataset_sha256"] != sha(out / "frozen-dataset.json"):
        raise ValueError("source or frozen data changed after preparation")
    return protocol, json.loads((out / "frozen-dataset.json").read_text(encoding="utf-8"))


def select_windows(results):
    """Deliberately accepts validation summaries only, never holdout arrays."""
    return {view: min((r for r in results if r["view"] == view),
                     key=lambda r: (r["validation"]["brier"], r["validation"]["log_loss"], r["days"]))["days"]
            for view in VIEWS}


def fit(out):
    protocol, frozen = frozen_inputs(out)
    if (out / "selection.json").exists() or list(out.glob("*.joblib")):
        raise ValueError("fit outputs already exist; refusing post-test refit or overwrite")
    validation = frozen["holdouts"]["validation"]
    results = []
    for view in VIEWS:
        names = BASE_NAMES if view == "base" else BASE_NAMES + DRAFT_NAMES + ROSTER_NAMES
        for days in protocol["eligible_windows_days"]:
            training = frozen["training"][str(days)]
            samples = lambda data: [TrainSample(features=r[view], label=r["winner"]) for r in data]
            request = TrainRequest(label=f"window-winner/{view}/{days}d", feature_names=names,
                train=samples(training), validation=samples(validation), calib=[], test=[],
                **protocol["model_parameters"])
            print(f"Fit {view} {days}d: {len(training)} maps, validation {len(validation)}; test withheld", flush=True)
            response = train(request)
            blob = base64.b64decode(response.blob_b64)
            bundle = _deserialize_bundle(blob)
            probability = bundle["model"].predict_proba(np.asarray([r[view] for r in validation]))[:, 1]
            path = out / f"winner-{view}-{days}d.joblib"
            path.write_bytes(blob)
            record = {"view": view, "days": days, "train_maps": len(training), "blob": path.name,
                      "blob_sha256": sha(path), "features": names,
                      "validation": grouped_metrics(probability, [r["winner"] for r in validation], validation),
                      "best_iteration": int(bundle["model"].best_iteration_), **research_flags()}
            results.append(record)
            write_json(out / "fit-progress.json", results)
    selection = {"selected_at": datetime.now(timezone.utc).isoformat(), "selected_windows": select_windows(results),
                 "criterion": protocol["selection_rule"], "models": results,
                 "protocol_sha256": sha(out / "protocol.json"), "test_accessed_for_selection": False,
                 "calibration_accessed_for_selection": False, **research_flags()}
    write_json(out / "selection.json", selection)
    print(json.dumps({"selected_windows_by_validation_only": selection["selected_windows"]}), flush=True)


def paired_intervals(p, baseline, labels, rows, replicates=2000):
    """Series resampling with a macro-map estimand (not equal-series means)."""
    groups = defaultdict(list)
    for i, r in enumerate(rows):
        groups[r["group"]].append(i)
    keys = sorted(groups)
    counts = np.asarray([len(groups[g]) for g in keys], dtype=float)
    rng = np.random.default_rng(42)
    draws = rng.integers(0, len(keys), size=(replicates, len(keys)))
    loss, reference = classification_losses(p, labels), classification_losses(baseline, labels)
    result = {"maps": len(rows), "groups": len(groups), "replicates": replicates, "seed": 42,
              "estimand": "equal maps; resample entire series; exploratory unadjusted intervals"}
    for metric in ("brier", "log_loss", "accuracy"):
        delta = loss[metric] - reference[metric]
        sums = np.asarray([delta[groups[g]].sum() for g in keys])
        boot = sums[draws].sum(axis=1) / counts[draws].sum(axis=1)
        result[metric] = {"delta": float(delta.mean()), "lower95": float(np.quantile(boot, .025)),
                          "upper95": float(np.quantile(boot, .975))}
    return result


def evaluate(out):
    protocol, frozen = frozen_inputs(out)
    selection_path = out / "selection.json"
    selection = json.loads(selection_path.read_text(encoding="utf-8"))
    if selection["protocol_sha256"] != sha(out / "protocol.json"):
        raise ValueError("protocol changed after model selection")
    if (out / "window-report.json").exists():
        raise ValueError("test evaluation already recorded; refusing overwrite")
    if selection["selected_windows"] != select_windows(selection["models"]):
        raise ValueError("selection is inconsistent with validation-only rule")
    test = frozen["holdouts"]["test"]
    labels = np.asarray([r["winner"] for r in test])
    predictions, results = {}, []
    for record in selection["models"]:
        path = out / record["blob"]
        if sha(path) != record["blob_sha256"]:
            raise ValueError("candidate blob changed after selection")
        bundle = _deserialize_bundle(path.read_bytes())
        p = bundle["model"].predict_proba(np.asarray([r[record["view"]] for r in test]))[:, 1]
        key = f"{record['view']}-{record['days']}d"
        predictions[key] = p
        result = {**record, "selected_by_validation": selection["selected_windows"][record["view"]] == record["days"],
                  "exploratory_test": grouped_metrics(p, labels, test), "reliability": reliability(p, labels, test)}
        months = [utc(r["start"])[:7] for r in test]
        result["by_month"] = {}
        for month in sorted(set(months)):
            mask = np.asarray([m == month for m in months])
            subset = [r for r, keep in zip(test, mask) if keep]
            result["by_month"][month] = grouped_metrics(p[mask], labels[mask], subset)
        results.append(result)
        write_json(out / f"winner-{key}-predictions.json", [
            {"match_id": r["match_id"], "group": r["group"], "start": r["start"],
             "target": int(y), "prediction": float(prob)} for r, y, prob in zip(test, labels, p)])
    comparisons = {}
    if 365 in protocol["eligible_windows_days"]:
        for view in VIEWS:
            for days in protocol["eligible_windows_days"]:
                if days != 365:
                    comparisons[f"{view}-{days}d_minus_365d"] = paired_intervals(
                        predictions[f"{view}-{days}d"], predictions[f"{view}-365d"], labels, test)
    for days in protocol["eligible_windows_days"]:
        comparisons[f"roster_minus_base_{days}d"] = paired_intervals(
            predictions[f"roster-{days}d"], predictions[f"base-{days}d"], labels, test)
    with psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as c:
        c.execute("SET TRANSACTION READ ONLY")
        after = active_models(c)
    if after != protocol["active_models_before"]:
        raise ValueError("active models changed during experiment; investigate external writer")
    report = {"protocol": PROTOCOL, "evaluated_at": datetime.now(timezone.utc).isoformat(),
              "selection_sha256": sha(selection_path), "selected_at": selection["selected_at"],
              "selected_windows": selection["selected_windows"], "models": results, "paired_comparisons": comparisons,
              "test_baselines": {"elo": grouped_metrics([r["base"][1] for r in test], labels, test),
                                 "constant_half": grouped_metrics(np.full(len(test), .5), labels, test)},
              "active_models_unchanged": True, "active_count": len(after), "database_writes": 0,
              "limitations": protocol["limitations"], **research_flags()}
    write_json(out / "window-report.json", report)
    print(json.dumps({"selected_windows": report["selected_windows"], "active_models_unchanged": True,
                     "models": [{k: r[k] for k in ("view", "days", "train_maps", "validation", "exploratory_test")} for r in results]}, indent=2), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase", required=True, choices=("prepare", "fit", "evaluate"))
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    out = Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=True)
    {"prepare": prepare, "fit": fit, "evaluate": evaluate}[args.phase](out)


if __name__ == "__main__":
    main()
