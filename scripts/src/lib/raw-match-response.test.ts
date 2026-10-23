import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { RAW_MATCH_JSON_MAX_BYTES, retainRawMatchResponse, readRawMatchResponse } from './raw-match-response.js';
import { makeMatchObservation, planMatchObservationFile, readMatchObservation, writeMatchObservation } from './match-observation.js';
import { extractParsedPayload } from './parsed-payload.js';

const requested = new Date('2026-10-03T12:00:00.000Z'), received = new Date('2026-10-03T12:00:01.000Z'), persisted = new Date('2026-10-03T12:00:01.010Z');
function fixture() { return { match_id: 123, version: 21, start_time: 1700000000, duration: 1200, radiant_win: true,
  unlisted_top: { custom_state_t: [0, null, 9], schema_future: true },
  players: [0, 1, 2, 3, 4, 128, 129, 130, 131, 132].map((slot, i) => ({ player_slot: slot, account_id: 100 + i, hero_id: i + 1,
    times: [0, 60, 120], gold_t: [0, 700, 1500], networth_t: [600, 800, 500], level_t: [1, 2, 3],
    hero_damage_t: [0, 100, 400], future_optional: { values: [true, false, null] } })) }; }
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'aegis-full-json-retention-'));
  const observationFile = planMatchObservationFile(root, 123, requested);
  const options = { matchId: 123, job: 'refresh_match_details' as const, requestStartedAt: requested, receivedAt: received, observationFile, now: () => persisted };
  return { root, observationFile, options };
}
function payload(root: string, file: string) { const r = JSON.parse(readFileSync(file, 'utf8')); return JSON.parse(gunzipSync(readFileSync(join(root, 'observations', 'opendota-full-match-json', r.payloadFile))).toString('utf8')); }

test('retains all unknown optional series before whitelist without interpreting gold_t/networth_t', () => {
  const x = setup(), input = fixture(), before = structuredClone(input);
  const result = retainRawMatchResponse(x.root, input, x.options); assert.equal(result.status, 'retained');
  if (result.status !== 'retained') return;
  assert.deepEqual(payload(x.root, result.receiptFile), input); assert.deepEqual(input, before);
  assert.equal(result.receipt.actualLive, false); assert.equal(result.receipt.evidenceCohort, 'post_match');
  assert.equal(result.receipt.providerWireBytesRetained, false); assert.equal(result.receipt.originalWireSha256, null);
  assert.equal(result.receipt.requestStartedAt, requested.toISOString()); assert.equal(result.receipt.receivedAt, received.toISOString());
  assert.equal(result.receipt.payloadPersistedAt, persisted.toISOString());
});
test('networth survives both direct parsed and selected receipt paths; raw retention does not change selection', () => {
  const x = setup(), input = fixture(), selectedBefore = makeMatchObservation(input, 123, received, received.getTime());
  assert.deepEqual(extractParsedPayload(input)!.players[0].networth_t, [600, 800, 500]);
  assert.deepEqual((selectedBefore.payload.players as Record<string, unknown>[])[0].networth_t, [600, 800, 500]);
  assert.deepEqual(extractParsedPayload(selectedBefore.payload)!.players[0].networth_t, [600, 800, 500]);
  retainRawMatchResponse(x.root, input, x.options);
  assert.deepEqual(makeMatchObservation(input, 123, received, received.getTime()), selectedBefore);
  const saved = readRawMatchResponse(x.root, x.observationFile, 123)!;
  assert.deepEqual(extractParsedPayload(saved.payload)!.players[0].networth_t, [600, 800, 500]);
});
test('explicit secret keys and credential-bearing URLs are redacted; request metadata is never copied', () => {
  const x = setup(), input = { ...fixture(), api_key: 'secret-AAA', headers: { Authorization: 'secret-BBB' },
    nested: { token: 'secret-CCC', response_link: 'https://example.invalid/?api_key=secret-DDD', public_link: 'https://example.invalid/?page=2' } };
  const r = retainRawMatchResponse(x.root, input, { ...x.options, requestUrl: 'secret-EEE', requestHeaders: { key: 'secret-FFF' } } as typeof x.options);
  assert.equal(r.status, 'retained'); if (r.status !== 'retained') return;
  const data = payload(x.root, r.receiptFile), text = JSON.stringify(data) + JSON.stringify(r.receipt);
  assert.ok(!text.includes('secret-')); assert.equal(data.nested.public_link, 'https://example.invalid/?page=2');
  assert.equal(r.receipt.redactedFields, 3); assert.equal(r.receipt.redactedUrlValues, 1);
});
test('oversize/invalid JSON returns safe status before writing sidecars and does not manufacture optional arrays', () => {
  const x = setup(), big = { match_id: 123, unknown: 'x'.repeat(RAW_MATCH_JSON_MAX_BYTES) };
  const r = retainRawMatchResponse(x.root, big, x.options); assert.deepEqual(r, { status: 'not_retained', reason: 'raw_json_bound_or_invalid' });
  assert.equal(existsSync(join(x.root, 'observations', 'opendota-full-match-json')), false);
  const input = fixture(); delete (input.players[0] as { networth_t?: number[] }).networth_t;
  const kept = retainRawMatchResponse(x.root, input, x.options); assert.equal(kept.status, 'retained'); if (kept.status !== 'retained') return;
  assert.equal(Object.hasOwn(payload(x.root, kept.receiptFile).players[0], 'networth_t'), false);
});
test('path escape/undefined state/wrong identity fail safely without altering source projection', () => {
  const x = setup();
  for (const [state, input, options] of [[undefined, fixture(), x.options], [x.root, { match_id: 124 }, x.options],
    [x.root, fixture(), { ...x.options, observationFile: join(x.root, 'outside.json.gz') }]] as const) {
    assert.equal(retainRawMatchResponse(state, input, options).status, 'not_retained');
  }
  assert.equal(existsSync(join(x.root, 'observations', 'opendota-full-match-json')), false);
});
test('immutable receipt is idempotent; conflicting same attempt never overwrites earlier payload', () => {
  const x = setup(), input = fixture(), r = retainRawMatchResponse(x.root, input, x.options); assert.equal(r.status, 'retained'); if (r.status !== 'retained') return;
  const bytes = readFileSync(r.receiptFile);
  const again = retainRawMatchResponse(x.root, input, { ...x.options, now: () => new Date(persisted.getTime() + 1000) });
  assert.equal(again.status, 'retained'); assert.deepEqual(readFileSync(r.receiptFile), bytes);
  input.players[0].networth_t[1] = 999; assert.equal(retainRawMatchResponse(x.root, input, x.options).status, 'not_retained');
  assert.equal(payload(x.root, r.receiptFile).players[0].networth_t[1], 800);
});
test('full receipt crash window recovers original response without an added GET or selected schema change', () => {
  const x = setup(), input = fixture(); retainRawMatchResponse(x.root, input, x.options);
  assert.equal(readMatchObservation(x.root, x.observationFile, 123), null);
  const recovered = readRawMatchResponse(x.root, x.observationFile, 123)!;
  const selected = makeMatchObservation(recovered.payload, 123, new Date(recovered.receipt.receivedAt), received.getTime());
  writeMatchObservation(x.root, selected, x.observationFile);
  assert.deepEqual(readMatchObservation(x.root, x.observationFile, 123), makeMatchObservation(input, 123, received, received.getTime()));
});
test('corrupt immutable content fails recovery with static safe error instead of forcing a fetch fallback', () => {
  const x = setup(), r = retainRawMatchResponse(x.root, fixture(), x.options); assert.equal(r.status, 'retained'); if (r.status !== 'retained') return;
  writeFileSync(r.receiptFile, '{"secret-token":"do-not-log"');
  assert.throws(() => readRawMatchResponse(x.root, x.observationFile, 123), e => e instanceof Error && e.message === 'raw_response_recovery_invalid');
});
test('direct ingest uses the same optional full-JSON retention without an existing selected receipt', () => {
  const x = setup(), r = retainRawMatchResponse(x.root, fixture(), { ...x.options, job: 'ingest_parsed', observationFile: undefined });
  assert.equal(r.status, 'retained'); if (r.status !== 'retained') return;
  assert.equal(r.receipt.job, 'ingest_parsed'); assert.equal(r.receipt.selectedObservationFilename, null);
  assert.equal(r.receipt.actualLive, false);
});
