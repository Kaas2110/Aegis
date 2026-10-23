import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertCandidateOnlyArgs, prepareLegacyCandidates, saveLegacyCandidates, type CandidateRow, type TrainingDatabase } from './training-candidates';
import { firstBloodRadiantLabel } from './first-blood-label';
import { selectLiveBucketSnapshots } from './live-training-samples';
import { fitIsotonic, applyCalibration } from './isotonic';
import { trainingSeed, seededRandom, shuffleInPlace } from './training-random';

const provenance = { trainer: 'test', seed: 42, limitations: ['as_of_validation_missing'], runId: 'fixture' };
const candidate = (overrides: Partial<CandidateRow> = {}): CandidateRow => ({
  version: 'candidate', kind: 'prematch_winner', featuresVersion: 1, engine: 'logreg',
  algorithm: 'logistic_regression', features: ['bias'], weights: { w0: 0 }, ...overrides,
});

test('candidate persistence preserves all champions/fallbacks and overrides unsafe input metadata', async () => {
  const active = [
    { ...candidate(), id: 1, version: 'lr', isActive: true },
    { ...candidate({ engine: 'lightgbm' }), id: 2, version: 'lgbm', isActive: true },
    { ...candidate({ kind: 'prematch_winner_t1', featuresVersion: 4 }), id: 3, version: 'tier', isActive: true },
  ];
  let stored: CandidateRow[] = [...active];
  let transactionCount = 0;
  const fake = {
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      transactionCount++;
      const working = [...stored];
      await fn({
        insert: () => ({ values: async (rows: CandidateRow[]) => { working.push(...rows); } }),
        update: () => { throw new Error('Candidates must never update existing rows'); },
        delete: () => { throw new Error('Candidates must never delete existing rows'); },
      });
      stored = working;
    },
  } as unknown as TrainingDatabase;
  await saveLegacyCandidates(fake, [candidate({ isActive: true, metadata: { validationStatus: 'validated', eligibleForPromotion: true, calibration: 'keep' } })], provenance);
  assert.equal(transactionCount, 1);
  assert.deepEqual(stored.slice(0, active.length), active);
  assert.equal(stored[3].isActive, false);
  assert.equal(stored[3].metadata?.validationStatus, 'legacy_unvalidated');
  assert.equal(stored[3].metadata?.eligibleForPromotion, false);
  assert.equal(stored[3].metadata?.calibration, 'keep');
  assert.match(stored[3].version, /-candidate-fixture$/);
});

test('failed candidate batch rolls back and never replaces active IDs', async () => {
  let stored = [candidate({ version: 'champion', isActive: true })];
  const before = structuredClone(stored);
  const fake = {
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      const working = [...stored];
      await fn({ insert: () => ({ values: async (rows: CandidateRow[]) => {
        working.push(rows[0]);
        throw new Error('simulated database failure');
      } }) });
      stored = working;
    },
  } as unknown as TrainingDatabase;
  await assert.rejects(saveLegacyCandidates(fake, [candidate(), candidate({ featuresVersion: 2 })], provenance), /simulated database failure/);
  assert.deepEqual(stored, before);
});

test('candidate identity is explicit and duplicate exact keys fail before writing', () => {
  assert.throws(() => prepareLegacyCandidates([candidate({ engine: undefined })], provenance), /explicit/);
  assert.throws(() => prepareLegacyCandidates([candidate({ featuresVersion: undefined })], provenance), /explicit/);
  assert.throws(() => prepareLegacyCandidates([candidate(), candidate({ version: 'another' })], provenance), /Duplicate candidate key/);
  assert.equal(prepareLegacyCandidates([candidate(), candidate({ engine: 'lightgbm' })], provenance).length, 2);
  assert.throws(() => prepareLegacyCandidates([candidate()], { ...provenance, limitations: [] }), /limitations/);
});

test('legacy CLI cannot promote or pretend to be validated', () => {
  assert.doesNotThrow(() => assertCandidateOnlyArgs(['--seed', '123', '--label', 'v1/t1']));
  for (const arg of ['--activate', '--activate=true', '--promote', '--validated']) {
    assert.throws(() => assertCandidateOnlyArgs([arg]), /validated-manifest/);
  }
});

function fbFixture(slot: number, time: number) {
  return {
    objectives: [{ type: 'CHAT_MESSAGE_FIRSTBLOOD', time, player_slot: slot, slot: slot < 128 ? slot : slot - 123 }],
    players: [{ player_slot: slot, kills_log: [{ time, key: 'npc_dota_hero_fixture' }] }],
  };
}

test('first blood derives the event side, including negative and zero time, independently of map winner', () => {
  const radiant = fbFixture(2, -15);
  const dire = fbFixture(130, 0);
  assert.equal(firstBloodRadiantLabel([{ ...radiant.objectives[0], radiant_win: false }], radiant.players), 1);
  assert.equal(firstBloodRadiantLabel([{ ...dire.objectives[0], radiant_win: true }], dire.players), 0);
});

test('unknown, conflicting, invalid or uncorroborated first blood is excluded', () => {
  const fixture = fbFixture(0, 20);
  assert.equal(firstBloodRadiantLabel(null, fixture.players), null);
  assert.equal(firstBloodRadiantLabel([], fixture.players), null);
  assert.equal(firstBloodRadiantLabel([...fixture.objectives, ...fixture.objectives], fixture.players), null);
  assert.equal(firstBloodRadiantLabel([{ ...fixture.objectives[0], player_slot: 5 }], fixture.players), null);
  assert.equal(firstBloodRadiantLabel([{ ...fixture.objectives[0], slot: 7 }], fixture.players), null);
  assert.equal(firstBloodRadiantLabel([{ ...fixture.objectives[0], time: NaN }], fixture.players), null);
  assert.equal(firstBloodRadiantLabel(fixture.objectives, [{ player_slot: 1, kills_log: [{ time: 20 }] }]), null);
  assert.equal(firstBloodRadiantLabel(fixture.objectives, [{ player_slot: 0, kills_log: [{ time: 21 }] }]), null);
  assert.equal(firstBloodRadiantLabel(fixture.objectives, [...fixture.players, ...fixture.players]), null);
});

test('overlapping live windows cannot double-count the same snapshot or include backfill', () => {
  const rows = [
    { matchId: 1, gameTimeSec: 330, source: 'live' },
    { matchId: 1, gameTimeSec: 330, source: 'live' },
    { matchId: 2, gameTimeSec: 180, source: 'backfill' },
    { matchId: 3, gameTimeSec: 480, source: 'synthetic' },
    { matchId: 4, gameTimeSec: 59, source: 'live' },
    { matchId: 5, gameTimeSec: 3000, source: 'live' },
  ];
  assert.deepEqual(selectLiveBucketSnapshots(rows, [3, 8]), [rows[0]]);
});

test('live window selection has stable chronological tie-breaking', () => {
  const earlier = { matchId: 1, gameTimeSec: 150, source: 'live' };
  const later = { matchId: 1, gameTimeSec: 210, source: 'live' };
  assert.deepEqual(selectLiveBucketSnapshots([later, earlier], [3]), [earlier]);
});

test('isotonic equal scores have one weighted value independent of label ordering', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ prob: 0.5, label: i < 10 ? 0 : 1 }));
  const forward = fitIsotonic(rows);
  const reverse = fitIsotonic([...rows].reverse());
  assert.deepEqual(forward, reverse);
  assert.equal(forward.bins.length, 1);
  assert.equal(applyCalibration(0.5, forward), 0.5);
});

test('isotonic weighted pooling remains monotonic and handles unsupported calibration sets', () => {
  const rows = [
    ...Array.from({ length: 10 }, () => ({ prob: 0.2, label: 1 })),
    ...Array.from({ length: 20 }, () => ({ prob: 0.8, label: 0 })),
  ];
  const model = fitIsotonic(rows);
  for (const p of [0, 0.2, 0.5, 0.8, 1]) assert.equal(applyCalibration(p, model), 1 / 3);
  assert.equal(fitIsotonic(rows.slice(0, 5)).identity, true);
  assert.equal(fitIsotonic(Array.from({ length: 25 }, () => ({ prob: 0.3, label: 1 }))).identity, true);
});

test('seeded epoch order is reproducible and preserves every training sample', () => {
  const run = (seed: number) => {
    const rows = Array.from({ length: 30 }, (_, i) => i);
    const random = seededRandom(seed);
    for (let epoch = 0; epoch < 200; epoch++) shuffleInPlace(rows, random);
    return rows;
  };
  assert.deepEqual(run(42), run(42));
  assert.notDeepEqual(run(42), run(43));
  assert.deepEqual(run(42).sort((a, b) => a - b), Array.from({ length: 30 }, (_, i) => i));
  assert.equal(trainingSeed([]), 42);
  assert.equal(trainingSeed(['--seed', '0']), 0);
  for (const args of [['--seed'], ['--seed', '-1'], ['--seed', '1.2'], ['--seed', '4294967296']]) {
    assert.throws(() => trainingSeed(args), /32-bit integer/);
  }
});

test('all eight entrypoints use candidate-only persistence; all live SQL rejects synthetic rows', () => {
  const names = ['train-model', 'train-lightgbm', 'train-market-models', 'train-live-model', 'train-live-totals', 'train-series-model', 'train-asym-prematch', 'train-asym-live'];
  for (const name of names) {
    const source = readFileSync(new URL(`../${name}.ts`, import.meta.url), 'utf8');
    assert.match(source, /assertCandidateOnlyArgs\(\)/, name);
    assert.match(source, /await saveLegacyCandidates\(db,/, name);
    assert.doesNotMatch(source, /isActive:\s*true|\.update\(modelVersionsTable\)|\.insert\(modelVersionsTable\)/, name);
    assert.doesNotMatch(source, /Math\.random\(/, name);
    if (['train-live-model', 'train-asym-live'].includes(name)) assert.match(source, /AND ls\.source = 'live'/, name);
    if (name === 'train-live-totals') assert.match(source, /liveSnapshotsTable\.source\} = 'live'/, name);
  }
});
