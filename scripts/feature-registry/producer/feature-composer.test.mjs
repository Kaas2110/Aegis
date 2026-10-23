import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeatureComposer, instantNs, observedDraftTargetIdentity } from './feature-composer.mjs';
import { syntheticRegistry } from '../registry-contract.fixtures.mjs';
import { digest } from '../registry-contract.mjs';
import { fixture, profile, AT, CUTOFF, SHA } from './feature-composer.fixtures.mjs';
const [index, familyDocument, targetDocument] = syntheticRegistry();
const composer = createFeatureComposer({ index, familyDocument, targetDocument });
const run = x => composer.composeFeatureProjection(x);
const live = () => fixture({ targetId: 'LIVE_MAP_WIN', stateMode: 'LIVE', familyId: 'L01', scope: 'current_live' });

test('explicit diagnostic history projection retains all79 family statuses and missing masks', () => {
  const r = run(fixture()); assert.equal(r.status, 'diagnostic_complete'); assert.equal(r.familyStatuses.length, 79); assert.deepEqual(r.vector.values, [.6]); assert.deepEqual(r.vector.missing, [false]);
  assert.equal(r.eligibleForServing, false); assert.equal(r.eligibleForTraining, false); assert.equal(r.recordedPrediction, false);
  assert.ok(r.familyStatuses.some(f => f.status === 'out_of_profile')); assert.equal(r.completenessScope, 'explicit_diagnostic_profile');
});
test('default maximal projection cannot turn one completed family into compact success', () => {
  const a = fixture(); a.diagnosticProfile = null; const r = run(a);
  assert.equal(r.status, 'incomplete'); assert.equal(r.vector, null); assert.ok(r.missingRequiredFamilyIds.length > 30); assert.equal(r.familyStatuses.length, 79); assert.equal(r.profileId, 'canonical-maximal.v1');
});
test('partial implementation or absent block remains incomplete without pruning', () => {
  for (const mutate of [a => a.familyImplementations[0].status = 'partial', a => a.componentBlocks = [], a => a.familyImplementations = []]) {
    const a = fixture(); mutate(a); const r = run(a); assert.equal(r.status, 'incomplete'); assert.equal(r.vector, null); assert.deepEqual(r.missingRequiredFamilyIds, ['H01']);
  }
});
test('diagnostic profile requires exact explicit hash', () => { const a = fixture(); a.diagnosticProfile.familyIds.push('H02'); assert.throws(() => run(a), /diagnostic_profile_hash/); });
test('POST may use a draft; PRE cannot borrow its data', () => {
  const a = fixture({ targetId: 'POST_MAP_WIN', stateMode: 'POST', familyId: 'D01', scope: 'current_draft' }); assert.equal(run(a).status, 'diagnostic_complete');
  a.targetId = 'PRE_MAP_WIN'; a.stateMode = 'PRE'; assert.throws(() => run(a), /ineligible|draft_in_undrafted/);
});
test('LIVE current state has explicit source anchor', () => { assert.equal(run(live()).status, 'diagnostic_complete'); });
test('SERIES_LIVE postdraft accepts draft but excludes current live fields', () => {
  const a = fixture({ targetId: 'SERIES_LIVE', stateMode: 'observed_postdraft', familyId: 'D01', scope: 'current_draft' }); assert.equal(run(a).status, 'diagnostic_complete');
  const b = fixture({ targetId: 'SERIES_LIVE', stateMode: 'observed_postdraft', familyId: 'L01', scope: 'current_live' }); assert.throws(() => run(b), /dynamic_in_nonlive/);
  b.stateMode = 'observed_live'; assert.equal(run(b).status, 'diagnostic_complete');
});
test('SERIES_BETWEEN allows null current map and separately bound completed-map history', () => {
  const a = fixture({ targetId: 'SERIES_BETWEEN', stateMode: 'SERIES_BETWEEN', familyId: 'Q02', scope: 'previous_series_maps' }); assert.equal(run(a).status, 'diagnostic_complete');
  a.historyRefs[0].sourceSeriesId = 'another-series'; assert.throws(() => run(a), /previous_series_identity/);
});
test('current labels and presentation data cannot be projected', () => {
  const a = fixture(); a.definitions[0].inputScopes = ['current_map_label']; assert.throws(() => run(a), /current_map_label/);
  const b = fixture(); b.definitions[0].inputScopes = ['presentation']; assert.throws(() => run(b), /presentation/);
});
test('current map or series mismatch is rejected at component and reference boundaries', () => {
  for (const mutate of [a => a.componentBlocks[0].mapId = 'other', a => a.historyRefs[0].mapId = 'other', a => a.componentBlocks[0].seriesId = 'other']) { const a = fixture(); mutate(a); assert.throws(() => run(a), /identity/); }
});
test('source profile and producer normalization are semantically bound', () => {
  const a = live(); a.sourceRefs[0].sourceProfile = 'other-provider'; assert.throws(() => run(a), /source_reference/);
  const b = fixture(); b.componentBlocks[0].producer.normalizationContract = 'different.v2'; assert.throws(() => run(b), /version_or_profile/);
});
test('one-nanosecond future source, fact, block and late identity are rejected', () => {
  const a = live(); a.sourceRefs[0].availableAt = '2026-10-23T12:00:00.000000001Z'; a.sourceRefs[0].materializedAt = a.sourceRefs[0].availableAt; assert.throws(() => run(a), /not_available/);
  const b = fixture(); b.historyRefs[0].maxFactAvailableAt = '2026-10-23T11:58:00.000000001Z'; assert.throws(() => run(b), /cutoff_or_validity/);
  const c = fixture(); c.componentBlocks[0].availableAt = '2026-10-23T12:00:00.000000001Z'; assert.throws(() => run(c), /component_future/);
  const d = fixture(); d.historyRefs[0].validFrom = '2026-10-23T12:00:00.000000001Z'; assert.throws(() => run(d), /cutoff_or_validity/);
});
test('late disclosure preserves original cutoff but is unavailable before validFrom', () => {
  const a = fixture(); a.historyRefs[0].validFrom = '2026-10-23T11:59:30Z'; a.historyRefs[0].availableAt = a.historyRefs[0].materializedAt = a.historyRefs[0].validFrom;
  assert.equal(run(a).historyCutoffAt, CUTOFF); a.decisionAt = '2026-10-23T11:59:00Z'; assert.throws(() => run(a), /not_available|validity/);
});
test('current map cannot be reused as historical input', () => { const a = fixture(); a.historyRefs[0].sourceMapIds = [a.mapId]; assert.throws(() => run(a), /current_map/); });
test('empty history is rejected until a canonical verified empty-query contract exists', () => { const a = fixture(); a.historyRefs[0].sourceMapIds = []; assert.throws(() => run(a), /empty/); });
test('late offline materialization requires explicit reconstructed read mode', () => {
  const a = fixture(); a.historyRefs[0].materializedAt = '2026-10-24T12:00:00Z'; assert.throws(() => run(a), /not_available/); a.readMode = 'reconstructed'; assert.equal(run(a).status, 'diagnostic_complete');
});
test('unknown/missing values are explicit nulls with complementary masks', () => {
  const a = fixture(); a.componentBlocks[0].values = [null]; a.componentBlocks[0].missing = [true]; const r = run(a); assert.deepEqual(r.vector.values, [null]); assert.equal(r.familyStatuses.find(x => x.familyId === 'H01').status, 'complete_with_missing_values');
  a.componentBlocks[0].missing = [false]; assert.throws(() => run(a), /missing_mask/);
});
test('NaN/infinity and dtype overflow are rejected, never silently imputed', () => {
  for (const value of [NaN, Infinity]) { const a = fixture(); a.componentBlocks[0].values = [value]; assert.throws(() => run(a), /not_json/); }
  for (const [dtype, value] of [['float32', 1e100], ['int32', .5], ['int32', 2147483648]]) { const a = fixture(); a.definitions[0].dtype = dtype; a.componentBlocks[0].values = [value]; assert.throws(() => run(a), /dtype_or_finite/); }
});
test('feature order, duplicate block and duplicate reference identity are rejected', () => {
  const a = fixture(); a.componentBlocks[0].featureIds = ['other']; assert.throws(() => run(a), /column_order/);
  const b = fixture(); b.componentBlocks.push(structuredClone(b.componentBlocks[0])); assert.throws(() => run(b), /component_blocks/);
  const c = fixture(); c.historyRefs.push(structuredClone(c.historyRefs[0])); assert.throws(() => run(c), /reference_ids/);
});
test('same names with changed formula or normalization produce different semantic hashes', () => {
  const a = fixture(), old = run(a), b = fixture(); b.definitions[0].formulaVersion = 'new-formula.v2'; const changed = run(b);
  assert.deepEqual(changed.vector.names, old.vector.names); assert.notEqual(changed.semanticSchemaHash, old.semanticSchemaHash);
  const c = fixture(); c.componentSpecs[0].normalizationContract = c.componentBlocks[0].producer.normalizationContract = 'normalization.v2'; c.componentBlocks[0].componentSemanticHash = digest(c.componentSpecs[0]); assert.notEqual(run(c).semanticSchemaHash, old.semanticSchemaHash);
});
test('values/receipt variation changes output content but not semantic schema', () => { const a = fixture(), old = run(a); a.componentBlocks[0].values = [.7]; const changed = run(a); assert.equal(changed.semanticSchemaHash, old.semanticSchemaHash); assert.notEqual(changed.contentHash, old.contentHash); });
test('mutating caller input after composition cannot mutate returned frozen vector', () => { const a = fixture(), r = run(a); a.componentBlocks[0].values[0] = 99; assert.equal(r.vector.values[0], .6); assert.throws(() => { r.vector.values[0] = 5; }, TypeError); });
test('coherent prefix must be no later than its own anchor clock/receipt', () => {
  const a = live(), p = { ...a.sourceRefs[0], id: 'prior-frame', role: 'prefix', stateKey: 'b'.repeat(64), anchorStateKey: SHA, gameClockSeconds: 890, availableAt: '2026-10-23T11:59:50Z', materializedAt: '2026-10-23T11:59:50Z' };
  a.sourceRefs.push(p); a.componentBlocks[0].sourceRefIds.push(p.id); assert.equal(run(a).status, 'diagnostic_complete'); p.gameClockSeconds = 901; assert.throws(() => run(a), /future_or_mixed_live_prefix/);
});
test('different current anchors cannot be mixed even within one valid producer block', () => {
  const a = live(), other = { ...a.sourceRefs[0], id: 'other-anchor', stateKey: 'b'.repeat(64) }; a.sourceRefs.push(other); a.componentBlocks[0].sourceRefIds.push(other.id); assert.throws(() => run(a), /mixed_live_anchors/);
});
test('prefix-only dynamic component cannot pretend to have current state', () => { const a = live(); a.sourceRefs[0].role = 'prefix'; a.sourceRefs[0].anchorStateKey = SHA; assert.throws(() => run(a), /live_anchor_required/); });
test('components cannot smuggle undeclared current-live inputs into a history projection', () => {
  const a = fixture(), l = live().sourceRefs[0]; l.id = 'undeclared-live'; l.targetIdentityHash = digest(a.targetIdentity); a.sourceRefs.push(l); a.componentSpecs[0].sourceProfiles = [l.sourceProfile]; a.componentBlocks[0].componentSemanticHash = digest(a.componentSpecs[0]); a.componentBlocks[0].sourceRefIds.push(l.id); assert.throws(() => run(a), /undeclared_input_scope/);
});
test('family declaration cannot call an empty implemented family complete', () => { const a = fixture(); a.familyImplementations.push({ familyId: 'H02', status: 'implemented', definitionIds: [] }); assert.throws(() => run(a), /without_definitions/); });
test('timestamps reject invalid calendar dates and preserve timezone nanoseconds', () => {
  assert.throws(() => instantNs('2026-02-30T12:00:00Z'), /timestamp/);
  assert.equal(instantNs('2026-10-23T15:00:00.000000001+03:00') - instantNs(AT), 1n);
});
test('shared helper source version changes schema even with unchanged names and wrapper', () => {
  const a = fixture(), before = run(a); a.componentSpecs[0].sourceInventory.push({ path: 'shared-history-core.mjs', sha256: 'b'.repeat(64) });
  assert.throws(() => run(a), /semantic_binding/);
  a.componentBlocks[0].componentSemanticHash = digest(a.componentSpecs[0]); const after = run(a);
  assert.deepEqual(before.vector.names, after.vector.names); assert.notEqual(before.semanticSchemaHash, after.semanticSchemaHash);
});
test('same-map draft, account-roster and side revisions cannot reuse old references', () => {
  for (const field of ['draftHash', 'rosterHash', 'sideIdentityHash']) {
    const a = live(); a.targetIdentity.currentMapRevision[field] = 'b'.repeat(64);
    assert.throws(() => run(a), /reference_target_revision/);
  }
});
test('same-map component revision must match even when reference revision matches', () => {
  const a = live(); a.componentBlocks[0].targetIdentityHash = 'b'.repeat(64); assert.throws(() => run(a), /component_target_revision/);
});
test('matching late identity revision is valid and does not create a different semantic schema', () => {
  const a = live(), before = run(a), r = a.targetIdentity.currentMapRevision;
  r.revision = 1; r.rosterHash = 'b'.repeat(64); r.validFromObservationId = 'c'.repeat(64); r.validFrom = '2026-10-23T11:59:00Z';
  const h = digest(a.targetIdentity); a.sourceRefs[0].targetIdentityHash = h; a.componentBlocks[0].targetIdentityHash = h;
  const after = run(a); assert.equal(after.status, 'diagnostic_complete'); assert.equal(after.semanticSchemaHash, before.semanticSchemaHash); assert.notEqual(after.targetIdentityHash, before.targetIdentityHash);
});
test('late history revision cannot retain an old validFrom by copying the new identity hash', () => {
  const a = fixture({ targetId: 'LIVE_MAP_WIN', stateMode: 'LIVE' }), r = a.targetIdentity.currentMapRevision;
  r.revision = 1; r.validFrom = '2026-10-23T11:59:00Z'; r.validFromObservationId = 'b'.repeat(64); r.rosterHash = 'c'.repeat(64);
  const h = digest(a.targetIdentity); a.historyRefs[0].targetIdentityHash = h; a.componentBlocks[0].targetIdentityHash = h;
  a.historyRefs[0].availableAt = a.historyRefs[0].materializedAt = r.validFrom;
  assert.throws(() => run(a), /history_target_revision_validity/);
});
test('observed revision cutoff and validFrom are checked before composition', () => {
  const a = live(); a.targetIdentity.currentMapRevision.validFrom = '2026-10-23T12:00:00.000000001Z'; assert.throws(() => run(a), /revision_time/);
  const b = live(); b.historyCutoffAt = '2026-10-23T11:57:00Z'; assert.throws(() => run(b), /revision_time/);
});
test('PRE binds undrafted context and SERIES_BETWEEN cannot carry a stale current map', () => {
  const a = fixture(); a.targetIdentity.contextRevisionHash = null; assert.throws(() => run(a), /context_revision_hash/);
  const b = fixture({ targetId: 'SERIES_BETWEEN', stateMode: 'SERIES_BETWEEN', familyId: 'Q02', scope: 'previous_series_maps' });
  b.mapId = b.targetIdentity.mapId = '90001'; assert.throws(() => run(b), /undrafted_or_between_identity/);
  const c = fixture(); c.targetIdentity.currentMapRevision = live().targetIdentity.currentMapRevision; assert.throws(() => run(c), /undrafted_or_between_identity/);
});
test('stable observed identity excludes per-packet state hash, receipt and last observation', () => {
  const r = live().targetIdentity.currentMapRevision;
  const body = { contract: 'aegis.observed-draft.v1', cutoffPolicy: 'first_complete_draft_receipt', matchId: '90001', sourceProfile: r.sourceProfile, historyCutoffAt: r.historyCutoffAt, firstCompleteObservationId: r.firstCompleteObservationId, revision: 0, validFromObservationId: r.validFromObservationId, validFrom: r.validFrom, identity: { draftHash: r.draftHash, rosterHash: r.rosterHash, sideIdentityHash: r.sideIdentityHash }, lastObservationId: SHA, lastReceivedAt: CUTOFF };
  const first = observedDraftTargetIdentity({ ...body, stateHash: digest(body) });
  const next = { ...body, lastObservationId: 'd'.repeat(64), lastReceivedAt: AT };
  assert.notEqual(digest(body), digest(next)); assert.deepEqual(observedDraftTargetIdentity({ ...next, stateHash: digest(next) }), first);
  const changed = { ...next, identity: { ...next.identity, rosterHash: 'e'.repeat(64) }, revision: 1, validFrom: AT, validFromObservationId: 'f'.repeat(64) };
  assert.notEqual(digest(observedDraftTargetIdentity({ ...changed, stateHash: digest(changed) })), digest(first));
});
