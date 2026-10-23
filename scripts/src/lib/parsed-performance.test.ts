import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractParsedPayload,
  mergeParsedPayload,
  PARSED_PAYLOAD_SCHEMA_VERSION
} from './parsed-payload';
const detail = (extra: Record<string, unknown>) => ({
  version: 22,
  players: Array.from({ length: 10 }, (_, i) => ({
    player_slot: i < 5 ? i : 128 + i - 5,
    hero_id: i + 1,
    ...extra
  }))
});
test('schema3 retains actual finite performance scalars including zero', () => {
  const x = extractParsedPayload(
    detail({
      gold_per_min: 513,
      xp_per_min: 688,
      hero_damage: 30000,
      kills: 0,
      deaths: 0,
      assists: 17,
      obs_placed: 0,
      level: 25
    })
  )!;
  assert.equal(PARSED_PAYLOAD_SCHEMA_VERSION, 3);
  assert.equal(x.payloadSchemaVersion, 3);
  assert.equal(x.players[0].gold_per_min, 513);
  assert.equal(x.players[0].xp_per_min, 688);
  assert.equal(x.players[0].kills, 0);
  assert.equal(x.players[0].obs_placed, 0);
  assert.equal(x.players[0].hero_damage, 30000);
});
test('missing, invalid, negative, string and boolean performance values stay unknown', () => {
  const x = extractParsedPayload(
    detail({ gold_per_min: NaN, xp_per_min: Infinity, kills: -1, deaths: '0', assists: true })
  )!;
  for (const field of ['gold_per_min', 'xp_per_min', 'kills', 'deaths', 'assists', 'hero_damage'])
    assert.equal(x.players[0][field], null);
});
test('partial refresh preserves previous valid scalars but new observed zero replaces old nonzero', () => {
  const old = extractParsedPayload(detail({ gold_per_min: 500, kills: 8, hero_damage: 18000 }))!;
  const incoming = extractParsedPayload(detail({ kills: 0 }))!;
  const merged = mergeParsedPayload(old, incoming);
  assert.equal(merged.players[0].kills, 0);
  assert.equal(merged.players[0].gold_per_min, 500);
  assert.equal(merged.players[0].hero_damage, 18000);
});
