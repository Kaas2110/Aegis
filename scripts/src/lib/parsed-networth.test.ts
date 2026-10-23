import test from 'node:test';
import assert from 'node:assert/strict';
import { extractParsedPayload, mergeParsedPayload, PARSED_PAYLOAD_SCHEMA_VERSION } from './parsed-payload';
import { prepareMatchDetail } from './match-detail-payload';

const slots = [0, 1, 2, 3, 4, 128, 129, 130, 131, 132];
const detail = (extra: Record<string, unknown> = {}) => ({
  match_id: 42, version: 22,
  players: slots.map((player_slot, i) => ({ player_slot, hero_id: i + 1, account_id: 100 + i, ...extra })),
});
const payload = (extra: Record<string, unknown> = {}) => extractParsedPayload(detail(extra))!;

test('optional networth uses exact own clock, preserving zero and real decreases through JSON storage', () => {
  const p = payload({ times: [-60, 0, 60, 120], networth_t: [0, 600, 900, 450], gold_t: [0, 600, 1000, 1500], net_worth: 25000 });
  const stored = JSON.parse(JSON.stringify(p));
  assert.deepEqual(stored.players[0].networth_t, [0, 600, 900, 450]);
  assert.deepEqual(stored.players[0].gold_t, [0, 600, 1000, 1500]);
  assert.equal(stored.players[0].net_worth, 25000);
  assert.equal(stored.payloadSchemaVersion, 3);
  assert.equal(PARSED_PAYLOAD_SCHEMA_VERSION, 3);
});

test('missing, null and empty optional series are unavailable, never a zero-filled vector', () => {
  for (const extra of [{}, { networth_t: null }, { networth_t: [] }]) {
    const p = payload({ times: [0, 60], ...extra });
    assert.equal(p.players[0].networth_t, null);
    assert.deepEqual(p.players[0].times, [0, 60]);
  }
  assert.deepEqual(payload({ times: [0, 60], networth_t: [0, 0] }).players[0].networth_t, [0, 0]);
});

test('neither final net_worth nor gold_t nor a similarly named alias can supply networth_t', () => {
  const p = payload({ times: [0, 60], net_worth: 50000, gold_t: [700, 1100], net_worth_t: [600, 900] });
  assert.equal(p.players[0].networth_t, null);
  assert.equal('net_worth_t' in p.players[0], false);
});

test('shorter, longer and sparse value vectors are rejected without discarding valid legacy fields', () => {
  for (const networth_t of [[5], [5, 6, 7], [, 8]]) {
    const p = payload({ times: [0, 60], networth_t, kills_log: [{ time: 20, key: 'target' }] });
    assert.equal(p.players[0].networth_t, null);
    assert.deepEqual(p.players[0].kills_log, [{ time: 20, key: 'target' }]);
  }
});

test('invalid networth observations do not pass coercion, infinities or unsafe integers', () => {
  for (const value of [NaN, Infinity, -Infinity, -1, 0.5, '100', true, null, undefined, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(payload({ times: [0, 60], networth_t: [0, value] }).players[0].networth_t, null);
});

test('missing, empty, sparse, duplicate, unordered and invalid time axes fail closed', () => {
  for (const times of [undefined, null, [], [0], [0, 0], [60, 0], [0, '60'], [0, 60.5], [0, NaN], [0, Infinity], [, 60], [0, true]])
    assert.equal(payload({ times, networth_t: [10, 20] }).players[0].networth_t, null);
});

test('per-player validity does not borrow a teammate clock or erase other players', () => {
  const input = detail({ times: [0, 60], networth_t: [600, 1000] });
  input.players[0] = { ...input.players[0], times: undefined } as typeof input.players[0];
  const p = extractParsedPayload(input)!;
  assert.equal(p.players[0].networth_t, null);
  assert.deepEqual(p.players[1].networth_t, [600, 1000]);
  assert.equal(p.players.length, 10);
});

test('changing the clock clears an older optional series instead of silently realigning it', () => {
  const old = payload({ times: [0, 60], networth_t: [600, 1000] });
  const fresh = payload({ times: [0, 120], gold_t: [600, 3000] });
  const p = mergeParsedPayload(old, fresh);
  assert.deepEqual(p.players[0].times, [0, 120]);
  assert.equal(p.players[0].networth_t, null);
});

test('even identical new clock is a new observation bundle and does not inherit omitted networth', () => {
  const old = payload({ times: [0, 60], networth_t: [600, 1000] });
  const p = mergeParsedPayload(old, payload({ times: [0, 60] }));
  assert.equal(p.players[0].networth_t, null);
});

test('partial refresh without a new clock keeps valid old networth with its old clock', () => {
  const old = payload({ times: [0, 60], networth_t: [600, 1000] });
  const p = mergeParsedPayload(old, payload({ networth_t: [1234, 5678], net_worth: 40000 }));
  assert.deepEqual(p.players[0].times, [0, 60]);
  assert.deepEqual(p.players[0].networth_t, [600, 1000]);
  assert.equal(p.players[0].net_worth, 40000);
});

test('new valid bundle replaces old networth with no source mutation or array aliasing', () => {
  const old = payload({ times: [0, 60], networth_t: [600, 1000] });
  const fresh = payload({ times: [0, 60, 120], networth_t: [0, 800, 500] });
  const before = JSON.stringify({ old, fresh });
  const p = mergeParsedPayload(old, fresh);
  assert.deepEqual(p.players[0].networth_t, [0, 800, 500]);
  (p.players[0].networth_t as number[])[0] = 99;
  assert.equal(JSON.stringify({ old, fresh }), before);
});

test('legacy stored optional vectors are revalidated before retention', () => {
  for (const changed of [{ times: null }, { networth_t: [50] }, { networth_t: [0, NaN] }]) {
    const old = payload({ times: [0, 60], networth_t: [600, 1000] });
    Object.assign(old.players[0], changed);
    const p = mergeParsedPayload(old, payload());
    assert.equal(p.players[0].networth_t, null);
  }
});

test('merge without previous payload still rejects an invalid manually constructed optional row', () => {
  const incoming = payload({ times: [0, 60] });
  incoming.players[0].networth_t = [900];
  assert.equal(mergeParsedPayload(null, incoming).players[0].networth_t, null);
});

test('different hero in the same slot never receives previous hero networth', () => {
  const old = payload({ times: [0, 60], networth_t: [600, 1000] });
  const incoming = payload();
  incoming.players[0].hero_id = 99;
  assert.equal(mergeParsedPayload(old, incoming).players[0].networth_t, null);
});

test('legacy v21 fixture without new field still yields a useful payload', () => {
  const input = { ...detail({ times: [-60, 0, 60], gold_t: [0, 500, 800] }), version: 21 };
  const p = extractParsedPayload(input)!;
  assert.equal(p.odVersion, 21); assert.equal(p.payloadSchemaVersion, 3);
  assert.equal(p.players[0].networth_t, null);
  assert.deepEqual(p.players[0].gold_t, [0, 500, 800]);
});

test('actual detail preparation path preserves valid optional series without requiring a draft', () => {
  const parts = prepareMatchDetail(detail({ times: [0, 60], networth_t: [600, 900] }), 42);
  assert.equal(parts.draft, null);
  assert.deepEqual(parts.parsed?.players[0].networth_t, [600, 900]);
});
