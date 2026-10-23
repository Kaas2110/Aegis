import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractParsedPayload, mergeParsedPayload, PARSED_PAYLOAD_SCHEMA_VERSION } from './parsed-payload';
import { prepareMatchDetail } from './match-detail-payload';
import { coolingMatchIds, completedDetailAttempt, detailRetryAt, detailLimit, DETAIL_COOLDOWN_MS, openDetailRefreshCheckpoint,
  parseDetailRefreshState, schemaUpgradeRetryIds, selectDetailRefresh, type DetailCandidate, type DetailRefreshState } from './detail-refresh-state';

function players() {
  return [0, 1, 2, 3, 4, 128, 129, 130, 131, 132].map((slot, index) => ({
    player_slot: slot, hero_id: index + 1, account_id: index + 100,
    times: [-60, 0, 60], gold_t: [0, 100, 200], xp_t: [0, 0, 50],
    kills_log: [{ time: -15, key: 'npc_dota_hero_example' }],
    obs_left_log: [{ time: 50, key: 'ward' }], runes_log: [{ time: 0, key: 0 }],
  }));
}
const detail = () => ({ match_id: 99, version: 21, players: players(),
  picks_bans: Array.from({ length: 10 }, (_, i) => ({ is_pick: true, hero_id: i + 1, team: Number(i >= 5), order: i })) });

function removeTestDirectory(directory: string) {
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('aegis-detail-test-'));
  rmSync(resolved, { recursive: true, force: true });
}

test('schema v3 preserves provider times and temporal events without inventing net worth', () => {
  const input = detail();
  const payload = extractParsedPayload(input)!;
  assert.equal(payload.payloadSchemaVersion, 3);
  assert.equal(PARSED_PAYLOAD_SCHEMA_VERSION, 3);
  assert.deepEqual(payload.players[0].times, [-60, 0, 60]);
  assert.deepEqual(payload.players[0].gold_t, [0, 100, 200]);
  assert.deepEqual(payload.players[0].obs_left_log, input.players[0].obs_left_log);
  assert.deepEqual(payload.players[0].runes_log, input.players[0].runes_log);
  assert.equal(payload.players[0].net_worth, null);
  assert.equal('net_worth_t' in payload.players[0], false);
  assert.equal(payload.players[0].dn_t, null);
});

test('parsed partial payload survives missing draft and missing optional gold arrays', () => {
  const input = { match_id: 99, version: 21, players: players().map(p => ({ player_slot: p.player_slot, hero_id: p.hero_id })) };
  const parts = prepareMatchDetail(input, 99);
  assert.equal(parts.draft, null);
  assert.equal(parts.parsed?.players.length, 10);
  assert.equal(parts.parsed?.players[0].gold_t, null);
  assert.equal(parts.parsed?.players[0].times, null);
});

test('valid draft can be retained while replay is still unavailable', () => {
  const parts = prepareMatchDetail({ ...detail(), version: null }, 99);
  assert.equal(parts.parsed, null);
  assert.deepEqual(parts.draft?.radiantPicks, [1, 2, 3, 4, 5]);
  assert.deepEqual(parts.draft?.direAccountIds, [105, 106, 107, 108, 109]);
  assert.throws(() => prepareMatchDetail(detail(), 100), /different match/);
});

test('ten records must have exactly the ten unique valid player slots', () => {
  for (const slot of [0, 127, 133, '132', true]) {
    const input: Record<string, unknown> = detail();
    const rows: Record<string, unknown>[] = players();
    rows[9].player_slot = slot;
    input.players = rows;
    assert.equal(extractParsedPayload(input), null);
  }
  assert.equal(extractParsedPayload({ ...detail(), players: players().slice(1) }), null);
  assert.equal(extractParsedPayload({ ...detail(), version: NaN }), null);
});

test('missing new clock cannot attach new arrays to an old clock or erase logs', () => {
  const previous = extractParsedPayload(detail())!;
  const incoming = extractParsedPayload({ ...detail(), players: players().map(p => ({ player_slot: p.player_slot, hero_id: p.hero_id, gold_t: [999] })) })!;
  const merged = mergeParsedPayload(previous, incoming);
  assert.deepEqual(merged.players[0].times, [-60, 0, 60]);
  assert.deepEqual(merged.players[0].gold_t, [0, 100, 200]);
  assert.deepEqual(merged.players[0].kills_log, previous.players[0].kills_log);
  const v1 = { players: previous.players.map(p => ({ ...p, times: null })) };
  const empty = extractParsedPayload({ ...detail(), players: players().map(p => ({ player_slot: p.player_slot, hero_id: p.hero_id })) })!;
  assert.deepEqual(mergeParsedPayload(v1, empty).players[0].gold_t, [0, 100, 200]);
});

test('new clock and aligned arrays replace the old temporal bundle together', () => {
  const previous = extractParsedPayload(detail())!;
  const incoming = extractParsedPayload({ ...detail(), players: players().map(p => ({ player_slot: p.player_slot, hero_id: p.hero_id, times: [0, 30], gold_t: [1, 2] })) })!;
  const merged = mergeParsedPayload(previous, incoming);
  assert.deepEqual(merged.players[0].times, [0, 30]);
  assert.deepEqual(merged.players[0].gold_t, [1, 2]);
  assert.equal(merged.players[0].xp_t, null);
});

const now = Date.UTC(2026, 9, 3);
const candidate = (matchId: number, overrides: Partial<DetailCandidate> = {}): DetailCandidate => ({
  matchId, startTime: now / 1000 - matchId * 3600, missingDraft: true, missingParsed: true, ...overrides,
});

test('selection includes missing draft OR missing parsed; completed matches are excluded', () => {
  const rows = [candidate(1, { missingDraft: false }), candidate(2, { missingParsed: false }),
    candidate(3, { missingDraft: false, missingParsed: false }), candidate(1)];
  const result = selectDetailRefresh(rows, { version: 1, attempts: {} }, now, 30);
  assert.deepEqual(result.map(r => r.matchId), [1, 2]);
});

test('seven-day cooldown includes pending interrupted work and expires at the exact boundary', () => {
  const state: DetailRefreshState = { version: 1, attempts: {
    '1': { at: now - 1000, outcome: 'pending' },
    '2': { at: now - DETAIL_COOLDOWN_MS + 1, outcome: 'unavailable' },
    '3': { at: now - DETAIL_COOLDOWN_MS, outcome: 'draft_only' },
  } };
  assert.deepEqual(coolingMatchIds(state, now), [1, 2]);
  assert.deepEqual(selectDetailRefresh([candidate(1), candidate(2), candidate(3)], state, now, 8).map(r => r.matchId), [3]);
});

test('new gaps then untouched archive precede expired retries and request limit stays bounded', () => {
  const state: DetailRefreshState = { version: 1, attempts: { '2': { at: now - 8 * 86400_000, outcome: 'unavailable' } } };
  const rows = [candidate(2, { startTime: now / 1000 - 9 * 86400 }),
    candidate(3, { startTime: now / 1000 - 50 * 86400 }), candidate(1)];
  assert.deepEqual(selectDetailRefresh(rows, state, now, 3).map(r => r.matchId), [1, 3, 2]);
  assert.deepEqual(selectDetailRefresh(rows, state, now, 1).map(r => r.matchId), [1]);
  for (const value of [0, 31, 1.2, 'NaN']) assert.throws(() => detailLimit(value), /1\.\.30/);
  assert.equal(detailLimit('8'), 8);
});

test('schema upgrade refreshes successful legacy extracts without waiting seven days', () => {
  const state: DetailRefreshState = { version: 1, attempts: {
    '1': { at: now - 1000, outcome: 'parsed' },
    '2': { at: now - 1000, outcome: 'parsed', payloadSchemaVersion: 2 },
    '3': { at: now - 1000, outcome: 'parsed', payloadSchemaVersion: 3 },
    '4': { at: now - 1000, outcome: 'error' },
    '5': { at: now - 1000, outcome: 'draft_only' },
  } };
  assert.deepEqual(schemaUpgradeRetryIds(state, 3), [1, 2]);
  const rows = [1, 2, 3, 4, 5].map(id => candidate(id, { schemaUpgrade: true }));
  assert.deepEqual(selectDetailRefresh(rows, state, now, 8, 30, 3).map(r => r.matchId), [1, 2]);
  // Normal refresh and missing-draft-only rows do not bypass provider cooldown.
  assert.deepEqual(selectDetailRefresh(rows, state, now, 8), []);
  assert.deepEqual(selectDetailRefresh([candidate(1, { missingParsed: false })], state, now, 8, 30, 3), []);
  // An unsuccessful new attempt and an extraction of the current version both stop repeated upgrades.
  state.attempts['1'] = { at: now, outcome: 'draft_only' };
  state.attempts['2'] = { at: now, outcome: 'parsed', payloadSchemaVersion: 3 };
  assert.deepEqual(selectDetailRefresh(rows, state, now, 8, 30, 3), []);
});

test('checkpoint accepts legacy versions but rejects invalid schema markers', () => {
  for (const payloadSchemaVersion of [0, -1, 1.5, '3', null]) {
    assert.throws(() => parseDetailRefreshState({ version: 1, attempts: { '1': { at: now, outcome: 'parsed', payloadSchemaVersion } } }), /checkpoint entry/);
  }
  const state: DetailRefreshState = { version: 1, attempts: { '1': { at: now, outcome: 'parsed', payloadSchemaVersion: 3 } } };
  assert.equal(parseDetailRefreshState(state), state);
});

test('checkpoint persists before interruption, locks concurrent runs and resumes locally', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'aegis-detail-test-'));
  try {
    const first = openDetailRefreshCheckpoint(directory);
    try {
      first.state.attempts['99'] = { at: now, outcome: 'pending' };
      first.save();
      assert.throws(() => openDetailRefreshCheckpoint(directory), /already running/);
      assert.equal(JSON.parse(readFileSync(path.join(directory, 'opendota-detail-refresh.json'), 'utf8')).attempts['99'].outcome, 'pending');
    } finally { first.release(); }
    const resumed = openDetailRefreshCheckpoint(directory);
    try { assert.deepEqual(coolingMatchIds(resumed.state, now + 1000), [99]); }
    finally { resumed.release(); }
  } finally { removeTestDirectory(directory); }
});

test('corrupt checkpoint fails closed instead of restarting provider attempts', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'aegis-detail-test-'));
  try {
    writeFileSync(path.join(directory, 'opendota-detail-refresh.json'), '{broken');
    assert.throws(() => openDetailRefreshCheckpoint(directory));
    assert.throws(() => parseDetailRefreshState({ version: 1, attempts: { 'oops': { at: now, outcome: 'pending' } } }), /checkpoint entry/);
    assert.throws(() => openDetailRefreshCheckpoint(undefined), /AEGIS_STATE_DIR/);
  } finally { removeTestDirectory(directory); }
});

test('legacy network failures resume after thirty minutes; repeated transient failures back off across persisted runs', () => {
  const legacy = { at: now, outcome: 'error' as const };
  assert.deepEqual(coolingMatchIds({ version: 1, attempts: { '1': legacy } }, now + 30 * 60_000 - 1), [1]);
  assert.deepEqual(coolingMatchIds({ version: 1, attempts: { '1': legacy } }, now + 30 * 60_000), []);
  let previous: typeof legacy | ReturnType<typeof completedDetailAttempt> | undefined;
  for (const hours of [0.5, 2, 6, 24, 24]) {
    const next = completedDetailAttempt(previous, 'error', now, now / 1000 - 86400, { retryable: true, retryAfterMs: null });
    const restored = parseDetailRefreshState(JSON.parse(JSON.stringify({ version: 1, attempts: { '1': next } }))).attempts['1'];
    assert.equal(detailRetryAt(restored), now + hours * 3600_000);
    previous = restored;
  }
});

test('non-transient failures and server Retry-After never get a premature retry', () => {
  const fatal = completedDetailAttempt(undefined, 'error', now, now / 1000, { retryable: false, retryAfterMs: null });
  assert.equal(detailRetryAt(fatal), now + DETAIL_COOLDOWN_MS);
  const throttled = completedDetailAttempt(undefined, 'error', now, now / 1000, { retryable: true, retryAfterMs: 48 * 3600_000 });
  assert.equal(detailRetryAt(throttled), now + 48 * 3600_000);
});

test('recent absent replay retries with increasing delay and ages into weekly archive checks', () => {
  const start = now / 1000 - 3600;
  const first = completedDetailAttempt(undefined, 'draft_only', now, start);
  const second = completedDetailAttempt(first, 'unavailable', now, start);
  const third = completedDetailAttempt(second, 'draft_only', now, start);
  assert.equal(detailRetryAt(first), now + 3600_000);
  assert.equal(detailRetryAt(second), now + 6 * 3600_000);
  assert.equal(detailRetryAt(third), now + 86400_000);
  const aged = completedDetailAttempt(third, 'draft_only', now + 8 * 86400_000, start);
  assert.equal(detailRetryAt(aged), aged.at + DETAIL_COOLDOWN_MS);
  const success = completedDetailAttempt(third, 'parsed', now, start);
  assert.equal(success.retryCount, 0);
  assert.equal(detailRetryAt(success), now + DETAIL_COOLDOWN_MS);
});

test('an unresolved legacy draft becomes eligible after age hydration without deleting checkpoint evidence', () => {
  const state: DetailRefreshState = { version: 1, attempts: { '1': { at: now - 2 * 3600_000, outcome: 'draft_only' } } };
  assert.deepEqual(coolingMatchIds(state, now), [1]);
  state.attempts['1'].matchStartTime = now / 1000 - 86400;
  assert.deepEqual(selectDetailRefresh([candidate(1)], state, now, 1).map(row => row.matchId), [1]);
  assert.equal(state.attempts['1'].outcome, 'draft_only');
});

test('invalid persisted retry metadata fails closed', () => {
  for (const bad of [{ retryCount: -1 }, { retryCount: 1.5 }, { matchStartTime: '5' }, { retryAfterUntil: null }, { errorRetryable: 'true' }]) {
    assert.throws(() => parseDetailRefreshState({ version: 1, attempts: { '1': { at: now, outcome: 'error', ...bad } } }), /checkpoint entry/);
  }
});

test('pending or persistence recovery retains the previous retry stage and rounds a fractional delay upwards', () => {
  const previous = { at: now, outcome: 'draft_only' as const, retryCount: 2, matchStartTime: now / 1000 - 3600 };
  for (const outcome of ['pending', 'persistence_retry'] as const) {
    const recovered = completedDetailAttempt({ ...previous, outcome, observationFile: path.join(os.tmpdir(), 'observation.json'), retryOutcome: 'draft_only' }, 'draft_only', now, previous.matchStartTime);
    assert.equal(recovered.retryCount, 3);
    assert.equal(detailRetryAt(recovered), now + 86400_000);
  }
  const fraction = completedDetailAttempt(undefined, 'error', now, now / 1000, { retryable: true, retryAfterMs: 1234.5 });
  assert.equal(fraction.retryAfterUntil, now + 1235);
  parseDetailRefreshState({ version: 1, attempts: { '1': fraction } });
  const enormous = completedDetailAttempt(undefined, 'error', now, now / 1000, { retryable: true, retryAfterMs: 1e30 });
  const state: DetailRefreshState = { version: 1, attempts: { '1': enormous } };
  parseDetailRefreshState(JSON.parse(JSON.stringify(state)));
  assert.equal(detailRetryAt(enormous), Infinity);
  assert.deepEqual(coolingMatchIds(state, now + DETAIL_COOLDOWN_MS * 100), [1]);
});
