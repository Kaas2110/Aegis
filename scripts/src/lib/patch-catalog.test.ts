import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertPatchPipelineGuard, checkPatchCatalog, normalizePatchCatalog,
  PATCH_CATALOG_SOURCE, PATCH_CHECK_INTERVAL_MS, PATCH_FAILURE_RETRY_MS, PATCH_STATE_FILE } from './patch-catalog';

const NOW = Date.parse('2026-10-03T17:00:00.000Z');
const catalog = [{ id: 1, name: '7.40', date: '2026-01-01' }, { id: 2, name: '7.41', date: '2026-03-24T00:00:00Z' }];
function fixture(t: { after: (fn: () => void) => void }) {
  const stateDir = mkdtempSync(join(tmpdir(), 'aegis-patch-test-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  let clock = NOW, calls = 0;
  let responder = async () => Response.json(catalog);
  return { stateDir, now: () => clock, assertGuard: () => {},
    fetchImpl: (async () => { calls++; return responder(); }) as typeof fetch,
    advance: (ms: number) => { clock += ms; }, calls: () => calls,
    respond: (fn: typeof responder) => { responder = fn; },
    state: () => JSON.parse(readFileSync(join(stateDir, PATCH_STATE_FILE), 'utf8')),
    snapshots: () => readdirSync(stateDir).filter(file => file.startsWith('opendota-patches-')) };
}
test('catalog schema, dates, duplicate IDs and canonical hashing are validated', () => {
  const normalized = normalizePatchCatalog(catalog, NOW);
  assert.equal(normalized.latest.name, '7.41');
  assert.equal(normalized.hash, normalizePatchCatalog([...catalog].reverse(), NOW).hash);
  assert.equal(normalizePatchCatalog(catalog[0], NOW).catalog.length, 1);
  for (const bad of [null, [], {}, '<html>error</html>', [{ name: '7.41', date: '2026-02-30' }],
    [{ name: '7.41', date: 'bad' }], [...catalog, catalog[0]], [{...catalog[0], id: -1}],
    [{...catalog[0], id: 2}, catalog[1]]]) assert.throws(() => normalizePatchCatalog(bad, NOW));
  const future = normalizePatchCatalog([...catalog, { id: 3, name: '7.42', date: '2027-01-01' }], NOW);
  assert.equal(future.latest.name, '7.41', 'a future catalog entry is not a released patch');
});
test('initial receipt is after body completion; daily cooldown makes no network call', async t => {
  const f = fixture(t);
  f.respond(async () => {
    const response = Response.json(catalog);
    Object.defineProperty(response, 'json', {value: async () => { f.advance(4000); return catalog; }});
    return response;
  });
  const first = await checkPatchCatalog(f);
  assert.equal(first.state, 'succeeded'); assert.equal(first.reason, 'initial_catalog');
  assert.equal(first.receivedAt, new Date(NOW + 4000).toISOString());
  assert.equal(f.calls(), 1);
  const snapshot = JSON.parse(readFileSync(join(f.stateDir, first.snapshotFile!), 'utf8'));
  assert.equal(snapshot.source, PATCH_CATALOG_SOURCE); assert.equal(snapshot.calendarOnly, true);
  assert.equal(snapshot.identity, 'opendota_patch_catalog');
  f.advance(PATCH_CHECK_INTERVAL_MS - 1);
  assert.equal((await checkPatchCatalog(f)).state, 'skipped'); assert.equal(f.calls(), 1);
});
test('unchanged checks keep immutable first revision; new catalog creates a second dated revision', async t => {
  const f = fixture(t);
  const first = await checkPatchCatalog(f);
  const original = readFileSync(join(f.stateDir, first.snapshotFile!), 'utf8');
  f.advance(PATCH_CHECK_INTERVAL_MS);
  const unchanged = await checkPatchCatalog(f);
  assert.equal(unchanged.reason, 'unchanged'); assert.equal(f.snapshots().length, 1);
  assert.equal(f.state().snapshot.receivedAt, first.receivedAt);
  assert.notEqual(f.state().lastSuccessfulReceivedAt, first.receivedAt);
  f.advance(PATCH_CHECK_INTERVAL_MS);
  f.respond(async () => Response.json([...catalog, { id: 3, name: '7.42', date: '2026-10-04' }]));
  const changed = await checkPatchCatalog(f);
  assert.equal(changed.reason, 'new_patch'); assert.equal(f.snapshots().length, 2);
  assert.equal(readFileSync(join(f.stateDir, first.snapshotFile!), 'utf8'), original);
});
test('failure keeps the last good catalog, retries after an hour and never prints upstream secrets', async t => {
  const f = fixture(t);
  const first = await checkPatchCatalog(f);
  f.advance(PATCH_CHECK_INTERVAL_MS);
  f.respond(async () => { throw new Error('Bearer TOP_SECRET https://bad.invalid/?api_key=TOP_SECRET'); });
  const failed = await checkPatchCatalog(f);
  assert.equal(failed.state, 'degraded'); assert.equal(f.calls(), 2);
  assert.equal(f.state().snapshot.hash, first.hash); assert.equal(f.snapshots().length, 1);
  assert.equal(Date.parse(failed.nextCheckAt!), f.now() + PATCH_FAILURE_RETRY_MS);
  assert.equal((await checkPatchCatalog(f)).reason, 'retry_cooldown'); assert.equal(f.calls(), 2);
  assert.doesNotMatch(JSON.stringify({failed, state: f.state()}), /TOP_SECRET|bad\.invalid/);
  f.advance(PATCH_FAILURE_RETRY_MS); f.respond(async () => Response.json(catalog));
  assert.equal((await checkPatchCatalog(f)).state, 'succeeded'); assert.equal(f.calls(), 3);
});
test('HTTP Retry-After and shared-ledger deferral are respected, with no retry inside one check', async t => {
  for (const shared of [false, true]) {
    const f = fixture(t); const retryAt = NOW + 3 * PATCH_FAILURE_RETRY_MS;
    f.respond(async () => {
      if (shared) throw Object.assign(new Error('sensitive upstream'), {code: 'OD_DEFERRED', retryAt});
      return new Response('', {status: 429, headers: {'retry-after': '10800'}});
    });
    const result = await checkPatchCatalog(f);
    assert.equal(result.state, 'degraded'); assert.equal(result.nextCheckAt, new Date(retryAt).toISOString());
    assert.equal(f.calls(), 1); f.advance(PATCH_FAILURE_RETRY_MS);
    assert.equal((await checkPatchCatalog(f)).state, 'degraded'); assert.equal(f.calls(), 1);
  }
});
test('invalid response preserves good snapshot; corrupt checkpoint fails closed without network', async t => {
  const f = fixture(t); const first = await checkPatchCatalog(f);
  f.advance(PATCH_CHECK_INTERVAL_MS); f.respond(async () => Response.json({error: 'private'}));
  assert.equal((await checkPatchCatalog(f)).state, 'degraded'); assert.equal(f.state().snapshot.hash, first.hash);
  writeFileSync(join(f.stateDir, PATCH_STATE_FILE), '{partial'); f.advance(PATCH_FAILURE_RETRY_MS);
  assert.equal((await checkPatchCatalog(f)).reason, 'invalid_checkpoint'); assert.equal(f.calls(), 2);
});
test('collector requires the current live pipeline owner and fails closed after ownership is lost', async t => {
  const f = fixture(t); const ownerPath = join(f.stateDir, 'pipeline.lock');
  mkdirSync(ownerPath);
  writeFileSync(join(ownerPath, 'owner.json'), JSON.stringify({runId: 'test', pid: process.pid}));
  const env = {AEGIS_PIPELINE_RUN_ID: 'test', AEGIS_PIPELINE_OWNER_PID: String(process.pid)};
  assert.doesNotThrow(() => assertPatchPipelineGuard(f.stateDir, env));
  assert.throws(() => assertPatchPipelineGuard(f.stateDir, {...env, AEGIS_PIPELINE_RUN_ID: 'other'}));
  const result = await checkPatchCatalog({...f, assertGuard: () => {throw new Error('lost');}});
  assert.equal(result.state, 'degraded'); assert.equal(f.calls(), 0);
});
test('a persisted interrupted attempt is bounded, and a body failure does not replace a snapshot', async t => {
  const f = fixture(t); const first = await checkPatchCatalog(f);
  f.advance(PATCH_CHECK_INTERVAL_MS);
  f.respond(async () => {
    assert.equal(f.state().status, 'pending', 'attempt persisted before the HTTP request');
    const response = Response.json(catalog);
    Object.defineProperty(response, 'json', {value: async () => { throw new Error('sensitive body error'); }});
    return response;
  });
  const failed = await checkPatchCatalog(f);
  assert.equal(failed.state, 'degraded'); assert.equal(f.state().snapshot.file, first.snapshotFile);
  assert.equal(f.snapshots().length, 1);
  const pending = {...f.state(), status: 'pending'};
  writeFileSync(join(f.stateDir, PATCH_STATE_FILE), JSON.stringify(pending));
  assert.equal((await checkPatchCatalog(f)).reason, 'retry_cooldown'); assert.equal(f.calls(), 2);
});

test('future-only catalog and invalid JSON cannot replace the last valid revision', async t => {
  const f = fixture(t); const first = await checkPatchCatalog(f);
  for (const response of [
    () => Response.json([{ name: '7.99', date: '2099-01-01' }]),
    () => new Response('<html>not JSON</html>', {status: 200}),
  ]) {
    f.advance(PATCH_CHECK_INTERVAL_MS); f.respond(async () => response());
    const result = await checkPatchCatalog(f);
    assert.equal(result.state, 'degraded');
    assert.equal(f.state().snapshot.file, first.snapshotFile);
    assert.equal(f.snapshots().length, 1);
  }
  assert.equal(f.calls(), 3);
});

test('future entry becomes current only after release and a new successful receipt', async t => {
  const f = fixture(t);
  f.respond(async () => Response.json([...catalog, {id: 3, name: '7.42', date: '2026-10-05'}]));
  const first = await checkPatchCatalog(f);
  assert.equal(first.latestPatch, '7.41');
  f.advance(2 * PATCH_CHECK_INTERVAL_MS);
  const second = await checkPatchCatalog(f);
  assert.equal(second.latestPatch, '7.42');
  assert.equal(second.reason, 'new_patch');
  assert.equal(second.hash, first.hash);
  assert.notEqual(second.snapshotFile, first.snapshotFile);
  assert.equal(f.snapshots().length, 2);
  const next = await checkPatchCatalog(f);
  assert.equal(next.state, 'skipped'); assert.equal(f.calls(), 2);
});

test('clock rollback keeps checkpoint valid and does not issue another request', async t => {
  const f = fixture(t); await checkPatchCatalog(f);
  f.advance(PATCH_CHECK_INTERVAL_MS);
  f.respond(async () => {f.advance(-5000); return Response.json(catalog);});
  const failed = await checkPatchCatalog(f);
  assert.equal(failed.reason, 'clock_moved_backwards');
  assert.ok(Date.parse(f.state().nextCheckAt) > Date.parse(f.state().lastAttemptAt));
  assert.equal((await checkPatchCatalog(f)).reason, 'clock_moved_backwards');
  assert.equal(f.calls(), 2);
  f.advance(PATCH_FAILURE_RETRY_MS + 5000); f.respond(async () => Response.json(catalog));
  assert.equal((await checkPatchCatalog(f)).state, 'succeeded');
});

test('invalid clock fails before attempting network or writing state', async t => {
  const f = fixture(t);
  for (const clock of [NaN, Infinity, 8.64e15]) {
    assert.equal((await checkPatchCatalog({...f, now: () => clock})).reason, 'invalid_clock');
  }
  assert.equal(f.calls(), 0); assert.equal(f.snapshots().length, 0);
});
