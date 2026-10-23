import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { coolingMatchIds, openDetailRefreshCheckpoint, parseDetailRefreshState, selectDetailRefresh } from './detail-refresh-state.js';
import { makeMatchObservation, planMatchObservationFile, readMatchObservation, writeMatchObservation } from './match-observation.js';
import { prepareMatchDetail } from './match-detail-payload.js';

const now = Date.parse('2026-10-03T15:00:00Z');
function cleanup(root: string) {
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert.ok(basename(root).startsWith('aegis-detail-recovery-'));
  rmSync(root, { recursive: true, force: true });
}

test('interrupted pending attempt reloads its published payload with original receipt; older local retry outranks new provider requests', () => {
  const root = mkdtempSync(join(tmpdir(), 'aegis-detail-recovery-'));
  try {
    const path = planMatchObservationFile(root, 123, new Date(now));
    const checkpoint = openDetailRefreshCheckpoint(root);
    checkpoint.state.attempts['123'] = { at: now, outcome: 'pending', observationFile: path };
    checkpoint.save();
    const detail = { match_id: 123, version: 21, first_blood_time: 99,
      players: [0, 1, 2, 3, 4, 128, 129, 130, 131, 132].map((slot, i) => ({
        player_slot: slot, hero_id: i + 1, account_id: i + 100, times: [0, 60], gold_t: [0, 150] })),
      picks_bans: Array.from({ length: 10 }, (_, i) => ({ is_pick: true, hero_id: i + 1, team: Number(i >= 5), order: i })) };
    const observation = makeMatchObservation(detail, 123, new Date(now), now);
    writeMatchObservation(root, observation, path);
    // Simulate interruption after publication, before DB/checkpoint completion.
    checkpoint.release();
    const resumed = openDetailRefreshCheckpoint(root);
    try {
      assert.deepEqual(coolingMatchIds(resumed.state, now + 1000), []);
      const selected = selectDetailRefresh([
        { matchId: 999, startTime: now / 1000 - 3600, missingDraft: true, missingParsed: true },
        { matchId: 123, startTime: now / 1000 - 90 * 86400, missingDraft: true, missingParsed: true },
      ], resumed.state, now + 1000, 1);
      assert.equal(selected[0].matchId, 123);
      const recovered = readMatchObservation(root, resumed.state.attempts['123'].observationFile!, 123)!;
      assert.equal(recovered.receivedAt, new Date(now).toISOString());
      assert.deepEqual(prepareMatchDetail(recovered.payload, 123), prepareMatchDetail(detail, 123));
    } finally { resumed.release(); }
  } finally { cleanup(root); }
});

test('local persistence failure never incurs replay cooldown, HTTP errors retain existing cooldown, invalid paths fail closed', () => {
  const state = parseDetailRefreshState({ version: 1, attempts: {
    '1': { at: now, outcome: 'persistence_retry' },
    '2': { at: now, outcome: 'error' },
    '3': { at: now, outcome: 'unavailable' },
  } });
  assert.deepEqual(coolingMatchIds(state, now + 1), [2, 3]);
  assert.throws(() => parseDetailRefreshState({ version: 1, attempts: {
    '1': { at: now, outcome: 'pending', observationFile: '../untrusted' },
  } }), /checkpoint entry/);
});
