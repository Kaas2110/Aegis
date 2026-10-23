"""Offline evaluation with explicit map/series weights; no fitting or I/O."""
from __future__ import annotations
from collections import defaultdict
import numpy as np


def map_indexes(rows):
    indexes = defaultdict(list)
    for i, row in enumerate(rows):
        indexes[row["match_id"]].append(i)
    return {key: np.asarray(value) for key, value in indexes.items()}


def map_weights(rows):
    weights = np.zeros(len(rows), dtype=float)
    for indexes in map_indexes(rows).values():
        weights[indexes] = 1 / len(indexes)
    return weights


def classification_losses(probs, labels):
    p, y = np.asarray(probs, dtype=float), np.asarray(labels, dtype=float)
    clipped = np.clip(p, 1e-9, 1 - 1e-9)
    return {"brier": (p - y) ** 2,
            "log_loss": -(y * np.log(clipped) + (1 - y) * np.log(1 - clipped)),
            "accuracy": ((p >= .5) == y).astype(float)}


def grouped_metrics(probs, labels, rows):
    """Mean of per-map losses, not mean of all correlated snapshots."""
    indexes = map_indexes(rows)
    losses = classification_losses(probs, labels)
    return {"matches": len(indexes), "rows": len(rows),
            **{name: float(np.mean([values[ix].mean() for ix in indexes.values()]))
               for name, values in losses.items()}}


def grouped_regression_metrics(predictions, labels, rows, transform="identity"):
    indexes = map_indexes(rows)
    p, y = np.asarray(predictions), np.asarray(labels)
    inverse = np.exp if transform == "log" else np.expm1 if transform == "log1p" else lambda x: x
    errors, natural_errors = p - y, inverse(p) - inverse(y)
    # Root of macro MSE retains RMSE's usual interpretation; never average R2
    # over one-target maps, where the denominator is zero.
    def scores(error):
        return (float(np.sqrt(np.mean([np.mean(error[ix] ** 2) for ix in indexes.values()]))),
                float(np.mean([np.mean(np.abs(error[ix])) for ix in indexes.values()])))
    rmse, mae = scores(errors)
    natural_rmse, natural_mae = scores(natural_errors)
    return {"matches": len(indexes), "rows": len(rows), "rmse": rmse, "mae": mae,
            "natural_rmse": natural_rmse, "natural_mae": natural_mae}


def reliability(probs, labels, rows=None):
    p, y = np.asarray(probs), np.asarray(labels)
    weights = map_weights(rows) if rows is not None else np.ones(len(p))
    bins = []
    for i in range(10):
        mask = (p >= i / 10) & (p < (i + 1) / 10 if i < 9 else p <= 1)
        if mask.any():
            item = {"lower": i / 10, "n": int(mask.sum()), "weight": float(weights[mask].sum()),
                    "mean_probability": float(np.average(p[mask], weights=weights[mask])),
                    "observed_rate": float(np.average(y[mask], weights=weights[mask]))}
            if rows is not None:
                item["matches"] = len({r["match_id"] for r, keep in zip(rows, mask) if keep})
            bins.append(item)
    return bins


def bootstrap_delta(model, baseline, labels, rows, transform="identity", classification=True):
    """Paired series bootstrap: equal maps within each equally weighted series.

    This estimand is intentionally distinct from macro_per_match when series
    have different map counts. Its CI is exploratory, not multiplicity-adjusted.
    """
    p, b, y = np.asarray(model), np.asarray(baseline), np.asarray(labels)
    if not classification:
        inverse = np.exp if transform == "log" else np.expm1 if transform == "log1p" else lambda x: x
        p, b, y = inverse(p), inverse(b), inverse(y)
    delta = (p - y) ** 2 - (b - y) ** 2
    per_series = defaultdict(list)
    for indexes in map_indexes(rows).values():
        groups = {rows[i]["group"] for i in indexes}
        if len(groups) != 1:
            raise ValueError("one map cannot belong to several bootstrap groups")
        per_series[next(iter(groups))].append(float(delta[indexes].mean()))
    if not per_series:
        raise ValueError("cannot bootstrap an empty holdout")
    d = np.array([np.mean(per_series[group]) for group in sorted(per_series)])
    rng = np.random.default_rng(42)
    samples = np.array([rng.choice(d, size=len(d), replace=True).mean() for _ in range(500)])
    metric = "brier" if classification else "natural_mse"
    return {f"mean_series_delta_{metric}": float(d.mean()),
            "lower95": float(np.quantile(samples, .025)), "upper95": float(np.quantile(samples, .975)),
            "series": len(d), "matches": len(map_indexes(rows)), "replicates": 500, "seed": 42,
            "weighting": "equal maps within equally weighted series",
            "interval_scope": "exploratory paired cluster bootstrap; not multiplicity-adjusted"}
