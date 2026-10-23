import assert from 'node:assert/strict';
import test from 'node:test';
import { createPatchResolver, makePatchRelease } from './match-patch-resolver';
import { providerPatchEvidence } from './patch-assignment-materializer';

const observedAt = '2026-10-04T00:00:00.000Z', source = 'https://www.dota2.com/datafeed/patchnoteslist?language=english';
const release = (version: string, date: string) => makePatchRelease({version, date, source, observedAt});
const hash = 'a'.repeat(64);
const calendar = [release('7.40', '2026-01-01T07:00:00.000Z'), release('7.40a', '2026-01-03T07:00:00.000Z'),
  release('7.40b', '2026-01-10T07:00:00.000Z'), release('7.41', '2026-03-01T07:00:00.000Z')];
const at = (value: string) => Date.parse(value) / 1000;

test('letter patches remain distinct and exact source boundary selects the newly released version', () => {
  const resolve = createPatchResolver(calendar, hash);
  assert.equal(resolve({matchId: 1, startTime: at('2026-01-03T06:59:59Z')}).inferredVersion, '7.40');
  assert.equal(resolve({matchId: 1, startTime: at('2026-01-03T07:00:00Z')}).inferredVersion, '7.40a');
  assert.equal(resolve({matchId: 1, startTime: at('2026-01-10T07:00:00Z')}).inferredVersion, '7.40b');
});
test('historical inference does not fabricate historical collection knowledge', () => {
  const result = createPatchResolver(calendar, hash)({matchId: 1, startTime: at('2026-01-05T12:00:00Z')});
  assert.equal(result.provenance, 'inferred_by_release_calendar');
  assert.equal(result.confirmedVersion, null); assert.equal(result.inferredVersion, '7.40a');
  assert.equal(result.releaseKnownAt, observedAt); assert.equal(result.releaseObservedAt, observedAt);
  assert.equal(result.inferenceBasis, 'retrospective_as_of_catalog_observation');
});
test('date-only boundary keeps estimate and previous plausible patch, without inventing an exact time', () => {
  const row = release('7.40b', '2026-01-10');
  assert.equal(row.timestampPrecision, 'date_only_utc');
  assert.equal(row.releaseTo, '2026-01-11T00:00:00.000Z');
  const resolve = createPatchResolver([...calendar.slice(0, 2), row], hash);
  const uncertain = resolve({matchId: 1, startTime: at('2026-01-10T13:00:00Z')});
  assert.equal(uncertain.inferredVersion, '7.40b'); assert.equal(uncertain.uncertainty, true);
  assert.deepEqual(uncertain.candidates, ['7.40a', '7.40b']);
  const nextDay = resolve({matchId: 1, startTime: at('2026-01-11T00:00:00Z')});
  assert.equal(nextDay.uncertainty, false); assert.deepEqual(nextDay.candidates, ['7.40b']);
});
test('several same-day letter releases keep every plausible version', () => {
  const resolve = createPatchResolver([calendar[0], release('7.40a', '2026-01-03'), release('7.40b', '2026-01-03')], hash);
  const result = resolve({matchId: 1, startTime: at('2026-01-03T12:00:00Z')});
  assert.deepEqual(result.candidates, ['7.40', '7.40a', '7.40b']); assert.ok(result.uncertainty);
});
test('explicit publication knowledge and collector observation remain separate', () => {
  const row = makePatchRelease({version: '7.40a', date: '2026-01-03', source, observedAt, publicationAt: '2026-01-03T17:00:00.000Z'});
  assert.equal(row.knowledgeBasis, 'official_publication_timestamp');
  assert.equal(row.knownAt, '2026-01-03T17:00:00.000Z'); assert.equal(row.observedAt, observedAt);
});
test('numeric provider IDs are base evidence and are never parser version or letter confirmation', () => {
  const provider = providerPatchEvidence(139, observedAt, hash, new Map([[139, '7.40']]), hash)!;
  const rawBefore = JSON.stringify(provider);
  const result = createPatchResolver(calendar, hash)({matchId: 1, startTime: at('2026-01-05T12:00:00Z'), provider});
  assert.equal(result.confirmedVersion, null); assert.equal(result.providerBaseVersion, '7.40');
  assert.equal(result.inferredVersion, '7.40a'); assert.equal(result.uncertainty, false);
  assert.equal(JSON.stringify(provider), rawBefore); assert.equal(result.providerEvidence!.rawPatch, 139);
});
test('provider base conflict keeps provider raw and flags tournament old-version possibility', () => {
  const provider = providerPatchEvidence(139, observedAt, hash, new Map([[139, '7.40']]))!;
  const result = createPatchResolver(calendar, hash)({matchId: 1, startTime: at('2026-03-05T12:00:00Z'), provider});
  assert.equal(result.inferredVersion, '7.41'); assert.equal(result.providerBaseVersion, '7.40');
  assert.ok(result.reasons.includes('provider_base_conflicts_calendar')); assert.equal(result.uncertainty, true);
  assert.equal(result.confirmedVersion, null);
});
test('provider exact version has its own provenance even when calendar disagrees', () => {
  const provider = providerPatchEvidence('7.40a', observedAt, hash, new Map())!;
  const result = createPatchResolver(calendar, hash)({matchId: 1, startTime: at('2026-01-12T12:00:00Z'), provider});
  assert.equal(result.confirmedVersion, '7.40a'); assert.equal(result.inferredVersion, '7.40b');
  assert.equal(result.provenance, 'provider_reported_exact'); assert.ok(result.reasons.includes('provider_exact_conflicts_calendar'));
});
test('unmapped provider ID is explicit, never interpreted as a version or discarded', () => {
  const provider = providerPatchEvidence(9999, observedAt, hash, new Map())!;
  const result = createPatchResolver(calendar, hash)({matchId: 1, startTime: at('2026-01-05T12:00:00Z'), provider});
  assert.equal(result.providerEvidence!.rawPatch, 9999); assert.ok(result.reasons.includes('provider_patch_unmapped'));
});
test('nothing before first known release is assigned a future patch', () => {
  const result = createPatchResolver(calendar, hash)({matchId: 1, startTime: at('2025-12-31T12:00:00Z')});
  assert.equal(result.inferredVersion, null); assert.equal(result.provenance, 'unresolved');
  assert.deepEqual(result.candidates, []);
});
test('fingerprint is deterministic, and changes when provider evidence changes', () => {
  const resolve = createPatchResolver(calendar, hash), input = {matchId: 1, startTime: at('2026-01-05T12:00:00Z')};
  assert.equal(resolve(input).inputFingerprint, resolve(input).inputFingerprint);
  assert.notEqual(resolve(input).inputFingerprint, resolve({...input, provider: providerPatchEvidence('7.40a', observedAt, hash, new Map())}).inputFingerprint);
});
test('malformed timestamps, duplicate versions and invalid match timestamps fail closed', () => {
  assert.throws(() => release('7.40a', '2026-02-30'));
  assert.throws(() => createPatchResolver([calendar[0], calendar[0]], hash));
  assert.throws(() => createPatchResolver(calendar, hash)({matchId: 1, startTime: 0}));
});
