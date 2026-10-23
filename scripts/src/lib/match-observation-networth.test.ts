import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeMatchObservation, readMatchObservation, writeMatchObservation } from './match-observation.js';
import { prepareMatchDetail } from './match-detail-payload.js';
import { mergeParsedPayload } from './parsed-payload.js';

const receipt = new Date('2026-10-20T10:52:11.869Z');
const slots = [0, 1, 2, 3, 4, 128, 129, 130, 131, 132];
const detail = () => ({
  match_id: 123, version: 22, start_time: 1700000000, duration: 1800,
  players: slots.map((player_slot, i): Record<string, unknown> => ({
    player_slot, hero_id: i + 1, account_id: 100 + i,
    times: [-60, 0, 60, 120], networth_t: [0, 600 + i, 900 + i, 450 + i],
    gold_t: [0, 600, 1100, 1700], net_worth: 25000, kills_log: [],
  })),
});
function pipeline(raw: unknown, id = 123, previous: Parameters<typeof mergeParsedPayload>[0] = null) {
  const observation = makeMatchObservation(raw, id, receipt, receipt.getTime());
  // Match the real persistence boundary: selected JSON, then preparation, then merge.
  const parts = prepareMatchDetail(JSON.parse(JSON.stringify(observation.payload)), id);
  return { observation, parts, merged: parts.parsed ? mergeParsedPayload(previous, parts.parsed) : null };
}

test('raw detail -> observation -> preparation -> merge -> JSON preserves all ten own NW timelines', () => {
  const input = detail(), before = structuredClone(input);
  const { observation, merged } = pipeline(input);
  assert.ok(merged);
  const stored = JSON.parse(JSON.stringify(merged));
  for (let i = 0; i < 10; i++) {
    assert.deepEqual(stored.players[i].networth_t, input.players[i].networth_t);
    assert.deepEqual(stored.players[i].times, input.players[i].times);
    assert.deepEqual(stored.players[i].gold_t, input.players[i].gold_t);
    assert.notDeepEqual(stored.players[i].networth_t, stored.players[i].gold_t);
  }
  assert.deepEqual(input, before);
  assert.equal(observation.receivedAt, receipt.toISOString());
  assert.equal(observation.availabilityBasis, 'collector_response_receipt');
  assert.equal(observation.schemaVersion, 1);
  assert.equal(observation.payloadKind, 'selected_match_detail_v1');
});

test('immutable selected observation round-trip retains NW and never changes old content', () => {
  const root = mkdtempSync(join(tmpdir(), 'aegis-observation-nw-'));
  const observation = pipeline(detail()).observation;
  const file = writeMatchObservation(root, observation);
  const bytes = readFileSync(file);
  assert.deepEqual(readMatchObservation(root, file, 123), observation);
  assert.equal(writeMatchObservation(root, observation), file);
  assert.deepEqual(readFileSync(file), bytes);
  const recovered = readMatchObservation(root, file, 123)!;
  assert.deepEqual(prepareMatchDetail(recovered.payload, 123).parsed?.players[0].networth_t, [0, 600, 900, 450]);
});

test('missing, explicit null and empty series do not create measured zeros', () => {
  for (const mode of ['missing', 'null', 'empty']) {
    const raw = detail();
    if (mode === 'missing') delete raw.players[0].networth_t;
    else raw.players[0].networth_t = mode === 'null' ? null : [];
    const result = pipeline(raw);
    assert.equal(result.merged?.players[0].networth_t, null);
    assert.deepEqual(result.merged?.players[1].networth_t, [0, 601, 901, 451]);
    if (mode === 'missing') assert.equal(Object.hasOwn((result.observation.payload.players as object[])[0], 'networth_t'), false);
  }
  const zeros = detail(); zeros.players[0].networth_t = [0, 0, 0, 0];
  assert.deepEqual(pipeline(zeros).merged?.players[0].networth_t, [0, 0, 0, 0]);
});

test('final NW, earned gold and similarly named arrays are never timeline aliases', () => {
  const raw = detail(); delete raw.players[0].networth_t;
  raw.players[0].net_worth_t = [111, 222, 333, 444];
  const result = pipeline(raw);
  assert.equal(result.merged?.players[0].networth_t, null);
  assert.equal(Object.hasOwn((result.observation.payload.players as object[])[0], 'net_worth_t'), false);
});

test('malformed NW values and unaligned, duplicate or fractional clocks remain unavailable', () => {
  const changes: Record<string, unknown>[] = [
    { networth_t: [0, 1] }, { networth_t: [0, -1, 2, 3] },
    { networth_t: [0, 1.5, 2, 3] }, { networth_t: [0, '1', 2, 3] },
    { networth_t: [0, true, 2, 3] }, { networth_t: [0, Number.MAX_SAFE_INTEGER + 1, 2, 3] },
    { times: [-60, 0, 0, 120] }, { times: [-60, 0, 60.5, 120] },
    { times: [-60, 0, 120, 60] }, { times: [-60, 0, '60', 120] },
  ];
  for (const change of changes) {
    const raw = detail(); Object.assign(raw.players[0], change);
    assert.equal(pipeline(raw).merged?.players[0].networth_t, null);
  }
});

test('non-JSON values fail before immutable observation publication', () => {
  for (const value of [NaN, Infinity, undefined]) {
    const raw = detail(); raw.players[0].networth_t = [0, value, 2, 3];
    assert.throws(() => pipeline(raw), /non-JSON/);
  }
});

test('wrong map identity, duplicated slots and invalid heroes cannot yield an admitted parsed NW row', () => {
  assert.throws(() => pipeline({ ...detail(), match_id: 456 }), /identity mismatch/);
  for (const change of [{ player_slot: 1 }, { hero_id: 1.5 }, { hero_id: 0 }]) {
    const raw = detail(); Object.assign(raw.players[0], change);
    assert.equal(pipeline(raw).parts.parsed, null);
  }
});

test('new clock does not borrow old NW; new valid observation replaces its own time bundle', () => {
  const old = pipeline(detail()).merged!;
  const partial = detail(); partial.players[0].times = [0, 180]; delete partial.players[0].networth_t;
  assert.equal(pipeline(partial, 123, old).merged?.players[0].networth_t, null);
  const fresh = detail(); fresh.players[0].times = [0, 180]; fresh.players[0].networth_t = [600, 400];
  const updated = pipeline(fresh, 123, old).merged!;
  assert.deepEqual(updated.players[0].times, [0, 180]);
  assert.deepEqual(updated.players[0].networth_t, [600, 400]);
  assert.deepEqual(old.players[0].networth_t, [0, 600, 900, 450]);
});

test('new whitelist field does not admit player PII, credentials or unrelated optional arrays', () => {
  const raw = detail();
  Object.assign(raw.players[0], { personaname: 'private-name', email: 'private-email',
    api_key: 'test-placeholder', level_t: [1, 2, 3, 4], future_optional: { value: 1 } });
  const p = (pipeline(raw).observation.payload.players as Record<string, unknown>[])[0];
  for (const key of ['personaname', 'email', 'api_key', 'level_t', 'future_optional']) assert.equal(Object.hasOwn(p, key), false);
  assert.deepEqual(p.networth_t, [0, 600, 900, 450]);
});

const capture = process.env.AEGIS_TEST_NW_CAPTURE;
test('single pinned already-saved OpenDota v22 TRAIN response survives the exact complete persistence pipeline',
  { skip: !capture }, () => {
    const bytes = readFileSync(capture!);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), '9492ddeadaa14c7d4549373986d5654d2306e5b6ad5766c1712d517f6bd7d161');
    const raw = JSON.parse(bytes.toString('utf8'));
    assert.equal(raw.match_id, 9052987576);
    const result = pipeline(raw, raw.match_id);
    assert.ok(result.merged);
    const sourceBySlot = new Map(raw.players.map((p: Record<string, unknown>) => [p.player_slot, p]));
    let preserved = 0;
    for (const p of result.merged.players) {
      const source = sourceBySlot.get(p.player_slot) as Record<string, unknown>;
      assert.deepEqual(p.networth_t, source.networth_t);
      assert.deepEqual(p.times, source.times);
      assert.deepEqual(p.gold_t, source.gold_t);
      preserved += Number(Array.isArray(p.networth_t) && p.networth_t.length > 0);
    }
    assert.equal(preserved, 10);
  });
