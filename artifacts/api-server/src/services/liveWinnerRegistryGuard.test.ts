import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveRegistryCache, validateLegacyLiveArtifact, type LiveRegistryArtifact } from './liveWinnerRegistryGuard';

const FEATURES = [
  'bias', 'game_time_norm', 'nw_lead_norm', 'kill_diff_norm', 'tower_diff_norm',
  'prematch_logit', 'is_real_live', 'has_draft', 'recency_days_norm',
];
function row(dimensions = 9): LiveRegistryArtifact & { featuresVersion: number } {
  return { engine: 'logreg', algorithm: 'logistic_regression_live', featuresVersion: 1,
    features: FEATURES.slice(0, dimensions),
    weights: Object.fromEntries(Array.from({ length: dimensions }, (_, i) => [`w${i}`, (i - 4) / 10])),
    binaryBlob: null };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function reload(cache: LiveRegistryCache<number[]>, pending: Promise<LiveRegistryArtifact | null>) {
  const generation = cache.beginReload();
  try {
    const model = await pending;
    const valid = model === null ? null : validateLegacyLiveArtifact(model);
    cache.finishReload(generation, valid?.ok ? valid.weights : null);
  } catch {
    cache.failReload(generation);
  }
  return cache.get();
}

test('confirmed nine-feature contract accepts registry fv=1 and preserves every weight', () => {
  const model = row(); const before = structuredClone(model);
  const valid = validateLegacyLiveArtifact(model);
  assert.equal(valid.ok, true);
  if (!valid.ok) return;
  assert.equal(valid.dimensions, 9);
  assert.deepEqual(valid.weights, Array.from({ length: 9 }, (_, i) => (i - 4) / 10));
  assert.deepEqual(model, before);
  valid.weights[0] = 999;
  assert.deepEqual(model, before);
});

test('confirmed six-feature contract alone receives three trailing zeros', () => {
  const valid = validateLegacyLiveArtifact(row(6));
  assert.equal(valid.ok, true);
  if (!valid.ok) return;
  assert.equal(valid.dimensions, 6);
  assert.deepEqual(valid.weights.slice(0, 6), Array.from({ length: 6 }, (_, i) => (i - 4) / 10));
  assert.deepEqual(valid.weights.slice(6), [0, 0, 0]);
});

test('LightGBM and unknown engine never become default zero weights even with matching fields', () => {
  for (const engine of ['lightgbm', 'xgboost', 'catboost', '', null, undefined]) {
    assert.deepEqual(validateLegacyLiveArtifact({ ...row(), engine }), { ok: false, reason: 'unsupported_engine' });
  }
  assert.equal(validateLegacyLiveArtifact({ ...row(6), engine: 'lightgbm', weights: {} }).ok, false);
});

test('wrong algorithm or binary payload cannot masquerade as logistic', () => {
  assert.equal(validateLegacyLiveArtifact({ ...row(), algorithm: 'lightgbm_live' }).ok, false);
  assert.equal(validateLegacyLiveArtifact({ ...row(), binaryBlob: Buffer.from('artifact') }).ok, false);
});

test('feature identity and order are exact; other historical logistic dimensions are unsupported', () => {
  const reordered = [...FEATURES]; [reordered[4], reordered[5]] = [reordered[5], reordered[4]];
  for (const features of [reordered, FEATURES.slice(0, 8), [...FEATURES, 'extra'], [], null, Array(9)]) {
    assert.equal(validateLegacyLiveArtifact({ ...row(), features }).ok, false);
  }
});

test('missing, extra, string, bool and nonfinite weights fail instead of zero-fill', () => {
  for (const value of [undefined, null, '0.1', true, NaN, Infinity, -Infinity]) {
    const weights = { ...(row().weights as Record<string, unknown>), w2: value };
    assert.equal(validateLegacyLiveArtifact({ ...row(), weights }).ok, false);
  }
  const missing = { ...(row().weights as Record<string, unknown>) }; delete missing.w2;
  for (const weights of [missing, {}, null, [], { ...(row().weights as object), w9: 0 }, { ...(row(6).weights as object), w6: 0 }]) {
    assert.equal(validateLegacyLiveArtifact({ ...row(), weights }).ok, false);
  }
});

test('valid explicit zero weights remain valid and are not confused with missing', () => {
  const model = row(); model.weights = Object.fromEntries(FEATURES.map((_, i) => [`w${i}`, 0]));
  const valid = validateLegacyLiveArtifact(model);
  assert.equal(valid.ok, true);
  if (valid.ok) assert.deepEqual(valid.weights, Array(9).fill(0));
});

test('unsupported latest registry row clears a previously loaded model', async () => {
  const cache = new LiveRegistryCache<number[]>();
  await reload(cache, Promise.resolve(row())); assert.ok(cache.get());
  await reload(cache, Promise.resolve({ ...row(), engine: 'lightgbm' }));
  assert.equal(cache.get(), null);
});

test('empty registry and latest load failure clear cached model', async () => {
  const cache = new LiveRegistryCache<number[]>();
  await reload(cache, Promise.resolve(row())); await reload(cache, Promise.resolve(null));
  assert.equal(cache.get(), null);
  await reload(cache, Promise.resolve(row())); await reload(cache, Promise.reject(new Error('DB failure')));
  assert.equal(cache.get(), null);
});

test('older successful response cannot resurrect after latest unsupported row', async () => {
  const cache = new LiveRegistryCache<number[]>(); const old = deferred<LiveRegistryArtifact | null>();
  const pending = reload(cache, old.promise);
  await reload(cache, Promise.resolve({ ...row(), engine: 'lightgbm' }));
  old.resolve(row()); await pending;
  assert.equal(cache.get(), null);
});

test('older successful response cannot resurrect after latest read failure', async () => {
  const cache = new LiveRegistryCache<number[]>(); const old = deferred<LiveRegistryArtifact | null>();
  const pending = reload(cache, old.promise);
  await reload(cache, Promise.reject(new Error('newest read failed')));
  old.resolve(row()); await pending;
  assert.equal(cache.get(), null);
});

test('older failed or unsupported response cannot clear newer valid model', async () => {
  for (const outcome of ['failure', 'unsupported']) {
    const cache = new LiveRegistryCache<number[]>(); const old = deferred<LiveRegistryArtifact | null>();
    const pending = reload(cache, old.promise);
    const latest = row(); (latest.weights as Record<string, number>).w0 = 123;
    await reload(cache, Promise.resolve(latest));
    if (outcome === 'failure') old.reject(new Error('older read failed'));
    else old.resolve({ ...row(), engine: 'lightgbm' });
    await pending;
    assert.equal(cache.get()?.[0], 123);
  }
});

test('older valid response cannot replace newer valid version', async () => {
  const cache = new LiveRegistryCache<number[]>(); const old = deferred<LiveRegistryArtifact | null>();
  const pending = reload(cache, old.promise);
  const latest = row(); (latest.weights as Record<string, number>).w0 = 456;
  await reload(cache, Promise.resolve(latest)); old.resolve(row()); await pending;
  assert.equal(cache.get()?.[0], 456);
});
