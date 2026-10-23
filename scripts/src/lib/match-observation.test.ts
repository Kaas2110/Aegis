import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { test } from 'node:test';
import { makeMatchObservation, planMatchObservationFile, readMatchObservation, writeMatchObservation } from './match-observation.js';

function cleanup(root: string) {
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert.ok(basename(root).startsWith('aegis-observations-'));
  rmSync(root, { recursive: true, force: true });
}

const date = new Date('2026-10-03T12:00:00Z');
const make = (detail: unknown, receipt = date) => makeMatchObservation(detail, 123, receipt, date.getTime());
const fixture = () => ({ match_id: 123, patch: 60, radiant_win: true, chat: ['private'],
  players: [{ player_slot: 128, hero_id: 4, account_id: 77, personaname: 'private',
    times: [0, 60, 120], gold_t: [3, 4, 5], purchase_log: [{ time: 120, key: 'blink', token: 'private' }] }] });

test('keeps original patch, slots, temporal axes and collector receipt without inventing patch suffix or historic availability', () => {
  const result = make(fixture());
  assert.equal(result.receivedAt, date.toISOString());
  assert.equal(result.availabilityBasis, 'collector_response_receipt');
  assert.equal(result.payload.patch, 60);
  assert.deepEqual(result.payload.players, [{ account_id: 77, gold_t: [3, 4, 5], hero_id: 4,
    player_slot: 128, purchase_log: [{ key: 'blink', time: 120 }], times: [0, 60, 120] }]);
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('canonical hash is independent of object insertion order, sensitive fields and receipt, but changes with provider data', () => {
  const first = make(fixture());
  const detail = fixture();
  const reordered = Object.fromEntries(Object.entries(detail).reverse());
  assert.equal(make(reordered).payloadSha256, first.payloadSha256);
  assert.equal(make({ ...detail, chat: ['changed'] }, new Date(date.getTime() - 1000)).payloadSha256, first.payloadSha256);
  assert.notEqual(make({ ...detail, patch: 61 }).payloadSha256, first.payloadSha256);
});

test('rejects mismatched identity, invalid receipt and malformed player data', () => {
  assert.throws(() => make({ match_id: 124 }), /identity/);
  assert.throws(() => make(fixture(), new Date(NaN)), /time/);
  assert.throws(() => make(fixture(), new Date(date.getTime() + 31_000)), /future/);
  assert.throws(() => make({ match_id: 123, players: null }), /array/);
  assert.throws(() => make({ match_id: 123, players: [null] }), /object/);
});

test('immutable compressed journal round trips, deduplicates same observation and preserves later receipts', () => {
  const root = mkdtempSync(join(tmpdir(), 'aegis-observations-'));
  try {
    const observation = make(fixture());
    const path = writeMatchObservation(root, observation);
    assert.deepEqual(JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')), observation);
    assert.equal(writeMatchObservation(root, observation), path);
    const later = makeMatchObservation(fixture(), 123, new Date(date.getTime() + 1000), date.getTime() + 1000);
    assert.notEqual(writeMatchObservation(root, later), path);
    const entries = readdirSync(join(root, 'observations', 'opendota-match-details', '2026-10-03'));
    assert.equal(entries.length, 2);
    assert.ok(entries.every(name => name.endsWith('.json.gz')));
    writeFileSync(path, 'corrupted');
    assert.throws(() => writeMatchObservation(root, observation));
    assert.equal(readFileSync(path, 'utf8'), 'corrupted');
  } finally { cleanup(root); }
});

test('requires explicit absolute state directory', () => {
  assert.throws(() => writeMatchObservation(undefined, make(fixture())), /absolute/);
  assert.throws(() => writeMatchObservation('../outside', make(fixture())), /absolute/);
});

test('preallocated checkpoint path recovers a published response after interruption without another fetch', () => {
  const root = mkdtempSync(join(tmpdir(), 'aegis-observations-'));
  try {
    const checkpointPath = planMatchObservationFile(root, 123, date);
    assert.equal(readMatchObservation(root, checkpointPath, 123), null);
    const original = make(fixture());
    assert.equal(writeMatchObservation(root, original, checkpointPath), checkpointPath);
    assert.deepEqual(readMatchObservation(root, checkpointPath, 123), original);
    assert.throws(() => readMatchObservation(root, checkpointPath, 124), /outside/);
    assert.throws(() => readMatchObservation(root, join(root, '..', 'unrelated.json.gz'), 123), /outside/);
    const changed = make({ ...fixture(), patch: 61 });
    assert.throws(() => writeMatchObservation(root, changed, checkpointPath), /immutable/);
    assert.deepEqual(readMatchObservation(root, checkpointPath, 123), original);
  } finally { cleanup(root); }
});
