"""Research-only conditional empirical remaining totals, with a learned tail.

Duration is integer seconds (> elapsed); kills are integer (>= observed).
CDFs share one normalized distribution, not independent per-line classifiers.
"""
from __future__ import annotations
from collections import defaultdict
import math
import numpy as np
from sklearn.ensemble import RandomForestRegressor
from sklearn.impute import SimpleImputer

DISTRIBUTION_KIND = 'empirical_remaining_v1'
QUANTILES = (.05, .25, .5, .75, .95)
PHASE_SECONDS = 600
PHASE_MIN_MAPS = 15
FOREST_MASS = .8
PHASE_TAIL_MASS = .02
LOGLOSS_EPSILON = 1e-6
FOREST_PARAMETERS = dict(n_estimators=100, max_depth=8, min_samples_leaf=20,
                         max_features=.8, bootstrap=False, random_state=42, n_jobs=2)


def row_map_weights(rows):
    counts = defaultdict(int)
    for r in rows:
        counts[r['match_id']] += 1
    return np.asarray([1 / counts[r['match_id']] for r in rows], dtype=float)


def map_mean(values, rows):
    weights = row_map_weights(rows)
    return float(np.sum(np.asarray(values) * weights) / weights.sum())


class RemainingDistribution:
    def __init__(self, residuals, weights, tail_mass, tail_mean, target, observed):
        raw_values = np.asarray(residuals, dtype=float)
        if (target not in ('duration', 'kills') or not math.isfinite(observed)
                or observed < 0 or observed != int(observed)
                or not len(raw_values) or not np.isfinite(raw_values).all()
                or np.any(raw_values != np.floor(raw_values))):
            raise ValueError('unknown target, invalid observed state or noninteger residuals')
        self.values = np.asarray(residuals, dtype=int)
        self.weights = np.asarray(weights, dtype=float)
        self.tail_mass, self.target, self.observed = float(tail_mass), target, int(observed)
        self.lower = 1 if target == 'duration' else 0
        if (self.weights.shape != self.values.shape or not np.isfinite(self.weights).all()
                or not 0 <= tail_mass <= 1 or not math.isfinite(tail_mean)
                or np.any(self.values < self.lower) or np.any(self.weights < 0)
                or not np.isclose(self.weights.sum() + tail_mass, 1)):
            raise ValueError('invalid conditional support or normalization')
        # Phase mean is estimated from train only. A fixed support-safe lower
        # bound avoids a degenerate tail for a tiny all-zero kills phase.
        mean = max(2.0 if self.lower else 1.0, float(tail_mean))
        self.tail_p = 1 / mean if self.lower else 1 / (mean + 1)

    def cdf_remaining(self, value):
        k = math.floor(value)
        if k < self.lower:
            return 0.0
        empirical = self.weights[self.values <= k].sum()
        exponent = k if self.lower else k + 1
        geometric = -math.expm1(exponent * math.log1p(-self.tail_p))
        return float(np.clip(empirical + self.tail_mass * geometric, 0, 1))

    def probabilities(self, line):
        if not math.isfinite(line):
            raise ValueError('line must be finite in native units')
        remaining = line - self.observed
        below = self.cdf_remaining(math.ceil(remaining) - 1)
        through = self.cdf_remaining(remaining)
        return {'pOver': max(0.0, 1 - through), 'pUnder': below,
                'pPush': max(0.0, through - below)}

    def quantile(self, probability):
        if not 0 < probability < 1:
            raise ValueError('finite quantile needs 0<q<1')
        low = self.lower - 1
        high = max(1, int(self.values.max()))
        while self.cdf_remaining(high) < probability:
            high *= 2
            if high > 10**9:
                raise ValueError('quantile exceeds research support guard')
        while high - low > 1:
            middle = (low + high) // 2
            if self.cdf_remaining(middle) >= probability:
                high = middle
            else:
                low = middle
        return self.observed + high


class EmpiricalRemainingForest:
    def fit(self, rows):
        if not rows:
            raise ValueError('empty training cohort')
        self.train_rows = rows
        self.weights = row_map_weights(rows)
        self.imputer = SimpleImputer(strategy='constant', fill_value=0, keep_empty_features=True)
        features = self.imputer.fit_transform(np.asarray([r['features'] for r in rows], dtype=float))
        self.models, self.leaves, self.residuals = {}, {}, {}
        for target in ('duration', 'kills'):
            values = np.asarray([r['remaining_' + target] for r in rows], dtype=int)
            if np.any(values < (1 if target == 'duration' else 0)):
                raise ValueError('outcome precedes observed state')
            model = RandomForestRegressor(**FOREST_PARAMETERS)
            model.fit(features, np.log1p(values), sample_weight=self.weights)
            train_leaves = model.apply(features)
            indexes = []
            for column in range(train_leaves.shape[1]):
                groups = defaultdict(list)
                for index, leaf in enumerate(train_leaves[:, column]):
                    groups[int(leaf)].append(index)
                indexes.append({leaf: np.asarray(ids) for leaf,ids in groups.items()})
            self.models[target], self.leaves[target], self.residuals[target] = model, indexes, values
        self.phases = defaultdict(list)
        for index, r in enumerate(rows):
            self.phases[int(r['elapsed_seconds']) // PHASE_SECONDS].append(index)
        return self

    def predict_distributions(self, rows, target, baseline=False):
        features = self.imputer.transform(np.asarray([r['features'] for r in rows], dtype=float))
        query_leaves = self.models[target].apply(features) if not baseline else None
        result = []
        for offset, row in enumerate(rows):
            indexes = self.phases.get(int(row['elapsed_seconds']) // PHASE_SECONDS, [])
            if len({self.train_rows[i]['match_id'] for i in indexes}) < PHASE_MIN_MAPS:
                indexes = list(range(len(self.train_rows)))
            phase_weights = np.zeros(len(self.train_rows))
            phase_weights[indexes] = self.weights[indexes]
            phase_weights /= phase_weights.sum()
            tail_mean = float(np.sum(phase_weights * self.residuals[target]))
            if baseline:
                empirical = phase_weights * (1 - PHASE_TAIL_MASS)
                tail_mass = PHASE_TAIL_MASS
            else:
                leaf_weights = np.zeros(len(self.train_rows))
                for tree, leaf in enumerate(query_leaves[offset]):
                    ids = self.leaves[target][tree][int(leaf)]
                    leaf_weights[ids] += self.weights[ids] / self.weights[ids].sum() / len(self.leaves[target])
                empirical = FOREST_MASS * leaf_weights + (1 - FOREST_MASS) * (1 - PHASE_TAIL_MASS) * phase_weights
                tail_mass = (1 - FOREST_MASS) * PHASE_TAIL_MASS
            observed = row['elapsed_seconds'] if target == 'duration' else row['observed_kills']
            result.append(RemainingDistribution(self.residuals[target], empirical, tail_mass, tail_mean, target, observed))
        return result


def evaluate_distributions(distributions, rows, target, lines):
    scale = 60 if target == 'duration' else 1
    truth = np.asarray([r['final_' + target] for r in rows], dtype=float)
    qs = {str(q): np.asarray([d.quantile(q) for d in distributions], dtype=float) for q in QUANTILES}
    loss_arrays = {'mae': np.abs(qs['0.5'] - truth) / scale}
    pinball = {}
    for q in QUANTILES:
        error = (truth - qs[str(q)]) / scale
        pinball[str(q)] = map_mean(np.maximum(q * error, (q - 1) * error), rows)
    coverage = {}
    for label, low, high in [('central50', '0.25', '0.75'), ('central90', '0.05', '0.95')]:
        covered = ((truth >= qs[low]) & (truth <= qs[high])).astype(float)
        coverage[label] = {'observed': map_mean(covered, rows), 'mean_width': map_mean((qs[high] - qs[low]) / scale, rows)}
        loss_arrays['coverage_' + label] = covered
    line_scores = {}
    line_predictions = []
    for line in lines:
        p = np.asarray([d.probabilities(line)['pOver'] for d in distributions])
        y = (truth > line).astype(float)
        clipped = np.clip(p, LOGLOSS_EPSILON, 1 - LOGLOSS_EPSILON)
        losses = {'brier': (p-y)**2, 'log_loss': -(y*np.log(clipped)+(1-y)*np.log(1-clipped)),
                  'accuracy': ((p >= .5) == y).astype(float)}
        observed = np.asarray([r['elapsed_seconds'] if target == 'duration' else r['observed_kills'] for r in rows])
        unresolved = observed <= line
        scores = {'all': {name: map_mean(value, rows) for name,value in losses.items()},
                  'unresolved_rows': int(unresolved.sum()), 'all_rows': len(rows)}
        if unresolved.any():
            subset = [r for r,keep in zip(rows,unresolved) if keep]
            scores['unresolved'] = {name:map_mean(value[unresolved], subset) for name,value in losses.items()}
            scores['unresolved_maps'] = len({r['match_id'] for r in subset})
        line_scores[str(line)] = scores
        line_predictions.append(p)
    result = {'maps': len({r['match_id'] for r in rows}), 'frames': len(rows), 'unit': 'minutes' if target=='duration' else 'kills',
      'mae': map_mean(loss_arrays['mae'], rows), 'pinball': pinball, 'coverageMetrics': coverage,
      'calibratedCoverage': None, 'lineScores': line_scores, 'weighting': 'equal maps; equal frames within map'}
    return result, loss_arrays, qs


def paired_cluster_interval(model_losses, baseline_losses, rows, replicates=2000):
    maps = defaultdict(list)
    for index,r in enumerate(rows):
        maps[r['match_id']].append(index)
    groups = defaultdict(list)
    delta = np.asarray(model_losses) - np.asarray(baseline_losses)
    for ids in maps.values():
        group = {rows[i]['group'] for i in ids}
        if len(group) != 1:
            raise ValueError('map split between series')
        groups[next(iter(group))].append(float(delta[ids].mean()))
    keys = sorted(groups)
    counts = np.asarray([len(groups[k]) for k in keys])
    sums = np.asarray([sum(groups[k]) for k in keys])
    draws = np.random.default_rng(42).integers(0,len(keys),size=(replicates,len(keys)))
    values = sums[draws].sum(axis=1) / counts[draws].sum(axis=1)
    return {'delta': float(sums.sum()/counts.sum()), 'lower95':float(np.quantile(values,.025)),
            'upper95':float(np.quantile(values,.975)), 'maps':len(maps), 'clusters':len(keys),
            'replicates':replicates, 'seed':42, 'estimand':'equal maps; paired whole-series resampling; exploratory'}
