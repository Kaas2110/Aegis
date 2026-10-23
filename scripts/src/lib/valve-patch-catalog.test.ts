import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkPatchCatalog, compareDotaPatchVersions, comparePatchCatalogs, normalizeValvePatchCatalog,
  PATCH_CHECK_INTERVAL_MS, PATCH_FAILURE_RETRY_MS, PATCH_RETRAIN_DELAY_MS, PATCH_STATE_FILE,
  VALVE_PATCH_SOURCE, VALVE_PATCH_STATE_FILE } from './patch-catalog';

const NOW = Date.parse('2026-10-03T21:00:00Z');
const row = (name: string, date = '2026-09-15T07:00:00Z') => ({
  patch_number: name, patch_name: name, patch_timestamp: Date.parse(date) / 1000,
});
const body = (patches = [row('7.41e', '2026-07-30T07:00:00Z'), row('7.41f')]) => ({success: true, patches});
function fixture(t: { after: (fn: () => void) => void }) {
  const stateDir = mkdtempSync(join(tmpdir(), 'aegis-valve-patch-test-'));
  t.after(() => rmSync(stateDir, {recursive: true, force: true}));
  let clock = NOW, calls = 0;
  let respond = async () => Response.json(body());
  return {stateDir, provider: 'valve' as const, now: () => clock, assertGuard: () => {},
    fetchImpl: (async (input, init) => {
      assert.equal(input, VALVE_PATCH_SOURCE); assert.equal(init?.method, 'GET');
      assert.equal(init?.redirect, 'error'); assert.equal(init?.headers, undefined);
      calls++; return respond();
    }) as typeof fetch,
    advance: (ms: number) => {clock += ms;}, calls: () => calls,
    respond: (fn: typeof respond) => {respond = fn;},
    state: () => JSON.parse(readFileSync(join(stateDir, VALVE_PATCH_STATE_FILE), 'utf8')),
    revisions: () => readdirSync(stateDir).filter(file => file.startsWith('valve-patches-'))};
}

test('Valve versions preserve every letter and compare numeric major/minor before suffix', () => {
  const names = ['7.41f', '10.00', '7.41b', '7.41', '7.09', '7.10', '9.99', '7.41a', '7.41e'];
  const expected = ['7.09', '7.10', '7.41', '7.41a', '7.41b', '7.41e', '7.41f', '9.99', '10.00'];
  assert.deepEqual(names.slice().sort(compareDotaPatchVersions), expected);
  const normalized = normalizeValvePatchCatalog(body(names.map(name => row(name))), NOW);
  assert.deepEqual(normalized.catalog.map(patch => patch.name), expected);
  assert.equal(normalized.latest.name, '10.00');
  assert.equal(normalized.hash, normalizeValvePatchCatalog(body(names.reverse().map(name => row(name))), NOW).hash);
  assert.ok(normalized.catalog.every(patch => patch.id === undefined));
});

test('Valve schema rejects duplicates, conflicts, malformed versions and timestamp units', () => {
  const f = row('7.41f');
  for (const invalid of [null, {}, {success: false, patches: [f]}, {success: true, patches: []},
    body([f, f]), body([f, {...f, patch_timestamp: f.patch_timestamp + 60}]),
    body([{...f, patch_name: '7.41e'}]), body([{...f, patch_timestamp: String(f.patch_timestamp)} as never]),
    body([{...f, patch_timestamp: NOW}]), body([{...f, patch_timestamp: 1.5}]),
    ...['7.41aa', '7.41F', '7.41.1', '07.41', '7.4', '7.41 ', 'x7.41'].map(name => body([row(name)])),
  ]) assert.throws(() => normalizeValvePatchCatalog(invalid, NOW));
  const future = normalizeValvePatchCatalog(body([f, row('7.42', '2027-01-01T00:00:00Z')]), NOW);
  assert.equal(future.latest.name, '7.41f');
  assert.throws(() => normalizeValvePatchCatalog(body([row('7.42', '2027-01-01T00:00:00Z')]), NOW), /no_released_patch/);
});

test('Valve daily observation is immutable, arrival-aware and does not create OD state', async t => {
  const f = fixture(t); const first = await checkPatchCatalog(f);
  assert.equal(first.state, 'succeeded'); assert.equal(first.latestPatch, '7.41f');
  assert.equal(first.observation?.knownAt, new Date(NOW).toISOString());
  assert.equal(first.observation?.retrainingEligibilityAt, first.observation?.knownAt, 'late discovery never backdates eligibility');
  assert.equal(first.observation?.trainingEnabled, false); assert.equal(first.observation?.recommendationOnly, true);
  const original = readFileSync(join(f.stateDir, first.snapshotFile!), 'utf8');
  assert.equal(JSON.parse(original).calendarOnly, true);
  assert.equal(JSON.parse(original).identity, 'valve_patch_catalog');
  assert.equal(readdirSync(f.stateDir).includes(PATCH_STATE_FILE), false);
  assert.equal((await checkPatchCatalog(f)).state, 'skipped'); assert.equal(f.calls(), 1);
  f.advance(PATCH_CHECK_INTERVAL_MS);
  f.respond(async () => Response.json(body(body().patches.reverse())));
  const next = await checkPatchCatalog(f);
  assert.equal(next.reason, 'unchanged'); assert.equal(next.observation?.knownAt, first.observation?.knownAt);
  assert.equal(f.revisions().length, 1); assert.equal(readFileSync(join(f.stateDir, first.snapshotFile!), 'utf8'), original);
});

for (const [before, after] of [['7.41a', '7.41b'], ['7.41e', '7.41f']]) {
  test(`letter change ${before} to ${after} is a new patch even within the same release timestamp`, async t => {
    const f = fixture(t); f.respond(async () => Response.json(body([row(before)])));
    const first = await checkPatchCatalog(f);
    f.advance(PATCH_CHECK_INTERVAL_MS); f.respond(async () => Response.json(body([row(before), row(after)])));
    const next = await checkPatchCatalog(f);
    assert.equal(next.reason, 'new_patch'); assert.equal(next.latestPatch, after);
    assert.notEqual(next.observation?.knownAt, first.observation?.knownAt);
    assert.equal(f.revisions().length, 2);
    assert.equal((await checkPatchCatalog(f)).state, 'skipped'); assert.equal(f.calls(), 2);
  });
}

test('future release becomes current only on successful later receipt; seven-day recommendation is not activation', async t => {
  const f = fixture(t); const release = NOW + PATCH_CHECK_INTERVAL_MS;
  f.respond(async () => Response.json(body([row('7.41f'), row('7.42', new Date(release).toISOString())])));
  const first = await checkPatchCatalog(f); assert.equal(first.latestPatch, '7.41f');
  f.advance(PATCH_CHECK_INTERVAL_MS);
  const second = await checkPatchCatalog(f);
  assert.equal(second.latestPatch, '7.42'); assert.equal(second.reason, 'new_patch');
  assert.equal(second.hash, first.hash); assert.notEqual(second.snapshotFile, first.snapshotFile);
  assert.equal(second.observation?.knownAt, new Date(release).toISOString());
  assert.equal(second.observation?.retrainingEligibilityAt, new Date(release + PATCH_RETRAIN_DELAY_MS).toISOString());
  assert.equal(second.observation?.requiresDataAndQualityGate, true); assert.equal(second.observation?.trainingEnabled, false);
});

test('Valve Retry-After throttles independently and keeps the last good observation', async t => {
  const f = fixture(t); const first = await checkPatchCatalog(f); f.advance(PATCH_CHECK_INTERVAL_MS);
  f.respond(async () => new Response('', {status: 429, headers: {'retry-after': '10800'}}));
  const failed = await checkPatchCatalog(f);
  assert.equal(failed.state, 'degraded'); assert.equal(failed.reason, 'http_429');
  assert.equal(failed.nextCheckAt, new Date(f.now() + 3 * PATCH_FAILURE_RETRY_MS).toISOString());
  assert.equal(failed.latestPatch, first.latestPatch); assert.deepEqual(failed.observation, first.observation);
  f.advance(PATCH_FAILURE_RETRY_MS); assert.equal((await checkPatchCatalog(f)).reason, 'retry_cooldown');
  assert.equal(f.calls(), 2); assert.equal(f.revisions().length, 1);
});

test('regressed or malformed catalog cannot replace current official patch', async t => {
  const f = fixture(t); const first = await checkPatchCatalog(f);
  for (const payload of [body([row('7.41e')]), body([{...row('7.41f'), patch_name: 'wrong'}]), body([row('7.99', '2099-01-01')])]) {
    f.advance(PATCH_CHECK_INTERVAL_MS); f.respond(async () => Response.json(payload));
    const result = await checkPatchCatalog(f); assert.equal(result.state, 'degraded');
    assert.equal(result.latestPatch, '7.41f'); assert.deepEqual(result.observation, first.observation);
    assert.equal(f.state().snapshot.file, first.snapshotFile);
  }
  assert.equal(f.revisions().length, 1);
});

test('corrupt or cross-provider checkpoint cannot cause network or assign OpenDota IDs', async t => {
  const f = fixture(t); await checkPatchCatalog(f);
  const state = f.state(); state.observation.trainingEnabled = true;
  writeFileSync(join(f.stateDir, VALVE_PATCH_STATE_FILE), JSON.stringify(state));
  f.advance(PATCH_CHECK_INTERVAL_MS);
  assert.equal((await checkPatchCatalog(f)).reason, 'invalid_checkpoint'); assert.equal(f.calls(), 1);
});

test('comparison reports disagreement explicitly and never substitutes a coarse catalog for Valve', () => {
  const official = {state: 'succeeded' as const, reason: 'new_patch', attempted: true, latestPatch: '7.41f'};
  const secondary = {state: 'skipped' as const, reason: 'cooldown', attempted: false, latestPatch: '7.41'};
  const compared = comparePatchCatalogs(official, secondary);
  assert.equal(compared.latestOfficial, '7.41f'); assert.equal(compared.latestOpenDota, '7.41');
  assert.equal(compared.catalogsDisagree, true); assert.equal(compared.matchVersionsAssigned, false);
  assert.equal(compared.trainingEnabled, false);
  const unavailable = comparePatchCatalogs({state: 'degraded', reason: 'http_503', attempted: true}, secondary);
  assert.equal(unavailable.latestOfficial, null); assert.equal(unavailable.catalogsDisagree, null);
});
