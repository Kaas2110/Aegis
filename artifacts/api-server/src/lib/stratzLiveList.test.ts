import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStratzLiveList } from './stratzLiveList';

test('live listing preserves Valve IDs and real zero values without inventing missing scores', () => {
  const matches = normalizeStratzLiveList([
    { matchId: 8985356917, leagueId: 17000, radiantTeamId: 123, direTeamId: 456, radiantScore: 0, gameTime: -5 },
    { matchId: 8985356918, radiantTeamId: 123 },
    { matchId: 8985356919, leagueId: 17000, completed: true },
    { matchId: 8985356920 },
    { matchId: -1, leagueId: 17000 },
    null,
  ]);
  assert.equal(matches.length, 2);
  assert.equal(matches[0]?.source, 'stratz');
  assert.equal(matches[0]?.match_id, 8985356917);
  assert.equal(matches[0]?.team_id_radiant, 123);
  assert.equal(matches[0]?.team_id_dire, 456);
  assert.equal(matches[0]?.radiant_score, 0);
  assert.equal(matches[0]?.dire_score, null);
  assert.equal(matches[0]?.game_time, -5);
  assert.equal(matches[1]?.league_id, null);
  assert.equal(matches[1]?.radiant_score, null);
  assert.deepEqual(normalizeStratzLiveList(null), []);
});
