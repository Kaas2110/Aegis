/** Pure diagnostic feature composition. No IO, imports selected by input, fitting,
 * source acquisition, formula evaluation or implicit feature selection. */
import { canonical, digest, FAMILY_IDS, validateRegistry, validateProjection } from '../registry-contract.mjs';

export const COMPOSER_CONTRACT = 'aegis.common-feature-composition.v1';
export const COMPONENT_CONTRACT = 'aegis.feature-component-block.v1';
export const REF_CONTRACT = 'aegis.immutable-feature-input-reference.v1';
export const TARGET_IDENTITY_CONTRACT = 'aegis.feature-target-identity-revision.v1';
const HEX = /^[a-f0-9]{64}$/;
const MAX_FEATURES = 250000, MAX_REFS = 100000, MAX_BYTES = 256 * 1024 * 1024;
const IMPLEMENTATIONS = new Set(['implemented', 'partial', 'planned', 'unimplemented']);
const SOURCE_SCOPES = new Set(['current_draft', 'current_live', 'series_context', 'candidate_axis']);
const HISTORY_SCOPES = new Set(['prior_maps', 'previous_series_maps']);
const metadataKeys = ['contract', 'version', 'sourceSha256', 'normalizationContract', 'sourceProfile'];
const fail = reason => { throw Error('feature_composer:' + reason); };
const object = x => x !== null && Object.getPrototypeOf(x) === Object.prototype;
function nonempty(x, name) { if (typeof x !== 'string' || !x.length || x.length > 4096) fail(name); }
function hash(x, name) { if (typeof x !== 'string' || !HEX.test(x)) fail(name); }
function identity(x, name, nullable = false) { if (nullable && x === null) return; if (typeof x !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(x)) fail(name); }
function unique(values, name) { if (!Array.isArray(values) || values.some(x => typeof x !== 'string' || !x) || new Set(values).size !== values.length) fail(name); }
function setEqual(a, b, name) { unique(a, name); unique(b, name); if (a.length !== b.length || a.some(x => !b.includes(x))) fail(name); }
function freeze(x) { if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); } return x; }
function copiedBounded(x) {
  // Reject non-JSON values and cycles before copying. Limits reject; never truncate.
  let nodes = 0;
  const walk = (v, depth) => {
    if (++nodes > 15000000 || depth > 40) fail('input_structure_bound');
    if (v === null || ['string', 'boolean'].includes(typeof v)) return;
    if (typeof v === 'number' && Number.isFinite(v)) return;
    if (Array.isArray(v)) { for (const a of v) walk(a, depth + 1); return; }
    if (object(v)) { for (const [key, a] of Object.entries(v)) { if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('unsafe_key'); walk(a, depth + 1); } return; }
    fail('input_not_json');
  };
  walk(x, 0);
  if (Buffer.byteLength(JSON.stringify(x)) > MAX_BYTES) fail('input_byte_bound');
  return structuredClone(x);
}

/** Exact UTC nanoseconds, including nanosecond differences within one millisecond. */
export function instantNs(value) {
  if (typeof value !== 'string') fail('timestamp');
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) fail('timestamp');
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  if (year < 1970 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) fail('timestamp');
  const ms = Date.UTC(year, month - 1, day, hour, minute, second), check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) fail('timestamp');
  let offset = 0;
  if (m[8] !== 'Z') { const h = Number(m[8].slice(1, 3)), min = Number(m[8].slice(4, 6)); if (h > 23 || min > 59) fail('timestamp'); offset = (m[8][0] === '+' ? 1 : -1) * (h * 60 + min); }
  return BigInt(ms - offset * 60000) * 1000000n + BigInt((m[7] ?? '').padEnd(9, '0'));
}
/** Derive only stable identity-revision fields. Last packet, receipt and clock are
 * deliberately excluded. A self-consistent state is not raw-source authentication. */
export function observedDraftTargetIdentity(draftState, { seriesId = null } = {}) {
  const state = copiedBounded(draftState), { stateHash, ...body } = state;
  if (state.contract !== 'aegis.observed-draft.v1' || state.cutoffPolicy !== 'first_complete_draft_receipt' || !HEX.test(stateHash ?? '') || digest(body) !== stateHash) fail('observed_identity_state');
  const d = state.identity;
  if (!object(d)) fail('observed_identity_fields');
  return freeze({ contract: TARGET_IDENTITY_CONTRACT, mode: 'observed_map', mapId: state.matchId, seriesId, contextRevisionHash: null, contextRevisionKnownAt: null,
    currentMapRevision: { sourceProfile: state.sourceProfile, historyCutoffAt: state.historyCutoffAt, firstCompleteObservationId: state.firstCompleteObservationId, revision: state.revision, validFromObservationId: state.validFromObservationId, validFrom: state.validFrom, draftHash: d.draftHash, rosterHash: d.rosterHash, sideIdentityHash: d.sideIdentityHash } });
}
function validateTargetIdentity(q, decision, cutoff) {
  const b = q.targetIdentity;
  if (!object(b) || b.contract !== TARGET_IDENTITY_CONTRACT || b.mapId !== q.mapId || b.seriesId !== q.seriesId) fail('target_identity_contract');
  const keys = ['contract', 'mode', 'mapId', 'seriesId', 'contextRevisionHash', 'contextRevisionKnownAt', 'currentMapRevision'];
  setEqual(Object.keys(b), keys, 'target_identity_fields');
  const observed = ['POST', 'LIVE', 'observed_postdraft', 'observed_live'].includes(q.stateMode);
  if (observed) {
    const r = b.currentMapRevision;
    if (b.mode !== 'observed_map' || b.contextRevisionHash !== null || b.contextRevisionKnownAt !== null || !object(r)) fail('observed_identity_required');
    setEqual(Object.keys(r), ['sourceProfile', 'historyCutoffAt', 'firstCompleteObservationId', 'revision', 'validFromObservationId', 'validFrom', 'draftHash', 'rosterHash', 'sideIdentityHash'], 'observed_identity_revision_fields');
    nonempty(r.sourceProfile, 'observed_identity_source_profile');
    for (const name of ['firstCompleteObservationId', 'validFromObservationId', 'draftHash', 'rosterHash', 'sideIdentityHash']) hash(r[name], 'observed_identity_' + name);
    const valid = instantNs(r.validFrom);
    if (cutoff === null || instantNs(r.historyCutoffAt) !== cutoff || valid < cutoff || valid > decision || !Number.isSafeInteger(r.revision) || r.revision < 0 || r.revision === 0 && (valid !== cutoff || r.validFromObservationId !== r.firstCompleteObservationId)) fail('observed_identity_revision_time');
    return { hash: digest(b), validFrom: valid };
  }
  const between = q.targetId === 'SERIES_BETWEEN';
  if (b.mode !== (between ? 'between_maps' : 'undrafted_context') || b.currentMapRevision !== null || between && q.mapId !== null) fail('undrafted_or_between_identity');
  hash(b.contextRevisionHash, 'context_revision_hash');
  const known = instantNs(b.contextRevisionKnownAt);
  if (known > decision) fail('context_revision_future');
  return { hash: digest(b), validFrom: known };
}
function semanticComponent(spec) {
  if (!object(spec)) fail('component_spec');
  nonempty(spec.id, 'component_id');
  for (const key of metadataKeys) nonempty(spec[key], 'component_' + key);
  hash(spec.sourceSha256, 'component_source_hash');
  if (!Array.isArray(spec.sourceInventory) || !spec.sourceInventory.length || spec.sourceInventory.length > 256) fail('component_source_inventory');
  unique(spec.sourceInventory.map(pin => pin.path), 'component_source_inventory_paths');
  for (const pin of spec.sourceInventory) { nonempty(pin.path, 'component_source_path'); hash(pin.sha256, 'component_dependency_hash'); }
  if (!spec.sourceInventory.some(pin => pin.sha256 === spec.sourceSha256)) fail('component_primary_source_missing');
  for (const key of ['featureIds', 'familyIds', 'sourceProfiles', 'historyProfiles']) unique(spec[key], 'component_' + key);
  if (!spec.featureIds.length || !spec.familyIds.length) fail('empty_component_spec');
  return spec;
}
function verifyRef(ref, kind, request, decision, cutoff, targetBinding) {
  if (!object(ref) || ref.contract !== REF_CONTRACT || ref.kind !== kind) fail('reference_contract');
  nonempty(ref.id, 'reference_id'); hash(ref.sha256, 'reference_hash'); nonempty(ref.sourceProfile, 'reference_profile');
  nonempty(ref.evidenceContract, 'reference_evidence_contract'); nonempty(ref.evidenceRef, 'reference_evidence_ref');
  if (!Number.isSafeInteger(ref.bytes) || ref.bytes < 1) fail('reference_bytes');
  identity(ref.mapId, 'reference_map', true); identity(ref.seriesId, 'reference_series', true);
  if (ref.mapId !== request.mapId || ref.seriesId !== request.seriesId) fail('reference_target_identity');
  if (ref.targetIdentityHash !== targetBinding.hash) fail('reference_target_revision');
  const available = instantNs(ref.availableAt), materialized = instantNs(ref.materializedAt);
  if (available > decision || available < targetBinding.validFrom || materialized < available || request.readMode === 'recorded' && materialized > decision) fail('reference_not_available');
  const allowed = kind === 'source' ? SOURCE_SCOPES : HISTORY_SCOPES;
  if (!allowed.has(ref.scope)) fail('reference_scope');
  if (kind === 'history') {
    if (cutoff === null || instantNs(ref.historyCutoffAt) !== cutoff || instantNs(ref.validFrom) > decision || instantNs(ref.validFrom) < cutoff || instantNs(ref.maxFactAvailableAt) > cutoff || available < instantNs(ref.maxFactAvailableAt) || available < instantNs(ref.validFrom)) fail('history_cutoff_or_validity');
    if (request.targetIdentity.mode === 'observed_map' && instantNs(ref.validFrom) !== targetBinding.validFrom) fail('history_target_revision_validity');
    unique(ref.sourceMapIds, 'history_source_maps');
    if (!ref.sourceMapIds.length || ref.sourceMapIds.some(x => x === request.mapId)) fail('history_current_map_or_empty');
    ref.sourceMapIds.forEach(x => identity(x, 'history_source_map'));
    if (ref.scope === 'previous_series_maps') {
      if (!request.seriesId || ref.sourceSeriesId !== request.seriesId) fail('previous_series_identity');
    }
  } else if (ref.scope === 'current_live') {
    if (!['anchor', 'prefix'].includes(ref.role)) fail('live_reference_role');
    hash(ref.stateKey, 'live_state_key');
    if (typeof ref.gameClockSeconds !== 'number' || !Number.isFinite(ref.gameClockSeconds) || ref.gameClockSeconds < 0) fail('live_clock');
    if (ref.role === 'prefix') hash(ref.anchorStateKey, 'live_prefix_anchor');
  }
  return ref;
}

/** Compile the canonical catalogue once. All 79 families remain visible in every
 * output; this factory accepts no executable callbacks or dynamic code paths.
 * Definitions, implementation declarations and reference metadata are code-host
 * structural claims, not authenticated evidence. Upstream adapters own verified
 * bytes, vetted full-family inventories and source/normalizer parity. Never expose
 * these declarations as client-controlled production admission inputs. */
export function createFeatureComposer({ index, familyDocument, targetDocument }) {
  const docs = copiedBounded({ index, familyDocument, targetDocument });
  const registry = validateRegistry(docs.index, docs.familyDocument, docs.targetDocument);
  const registrySha256 = digest(docs);
  return Object.freeze({
    contract: COMPOSER_CONTRACT, registrySha256,
    composeFeatureProjection(raw) {
      const q = copiedBounded(raw);
      if (!Array.isArray(q.definitions) || !q.definitions.length || q.definitions.length > MAX_FEATURES) fail('definition_count');
      const projection = validateProjection({ targetId: q.targetId, stateMode: q.stateMode, definitions: q.definitions }, registry);
      if (!['recorded', 'reconstructed'].includes(q.readMode)) fail('read_mode');
      const series = q.targetId.startsWith('SERIES_');
      identity(q.mapId, 'map_id', ['SERIES_PRE', 'SERIES_BETWEEN'].includes(q.targetId));
      identity(q.seriesId, 'series_id', !series);
      const decision = instantNs(q.decisionAt), cutoff = q.historyCutoffAt === null ? null : instantNs(q.historyCutoffAt);
      if (cutoff !== null && cutoff > decision) fail('future_history_cutoff');
      const targetBinding = validateTargetIdentity(q, decision, cutoff);
      const eligible = FAMILY_IDS.filter(id => { const f = registry.families.get(id); return f.eligibleTargets.includes(q.targetId) && !['label_only', 'presentation_context'].includes(f.kind); });
      let required = eligible, profile = { contract: 'aegis.maximal-feature-profile.v1', profileId: 'canonical-maximal.v1', familyIds: eligible };
      if (q.diagnosticProfile !== null) {
        const p = q.diagnosticProfile;
        if (!object(p) || p.contract !== 'aegis.diagnostic-feature-profile.v1') fail('diagnostic_profile');
        nonempty(p.profileId, 'diagnostic_profile_id'); unique(p.familyIds, 'diagnostic_profile_families');
        if (!p.familyIds.length || p.familyIds.some(id => !eligible.includes(id))) fail('diagnostic_profile_ineligible');
        const { profileHash, ...body } = p;
        if (!HEX.test(profileHash ?? '') || digest(body) !== profileHash) fail('diagnostic_profile_hash');
        profile = body; required = p.familyIds;
      }
      const profileHash = digest(profile);
      if (q.definitions.some(d => !required.includes(d.familyId))) fail('definition_outside_profile');
      for (const key of ['componentSpecs', 'componentBlocks', 'familyImplementations', 'sourceRefs', 'historyRefs']) if (!Array.isArray(q[key])) fail('array_' + key);
      if (q.sourceRefs.length + q.historyRefs.length > MAX_REFS || q.componentSpecs.length > MAX_FEATURES || q.componentBlocks.length > MAX_FEATURES) fail('collection_bound');
      unique(q.componentSpecs.map(x => x.id), 'component_ids'); unique(q.componentBlocks.map(x => x.componentId), 'component_blocks');
      unique(q.familyImplementations.map(x => x.familyId), 'family_implementations');
      unique([...q.sourceRefs, ...q.historyRefs].map(x => x.id), 'reference_ids');
      const refs = new Map([...q.sourceRefs.map(r => verifyRef(r, 'source', q, decision, cutoff, targetBinding)), ...q.historyRefs.map(r => verifyRef(r, 'history', q, decision, cutoff, targetBinding))].map(r => [r.id, r]));
      const definitions = new Map(q.definitions.map(d => [d.id, d]));
      const specs = new Map(), owner = new Map();
      for (const rawSpec of q.componentSpecs) {
        const spec = semanticComponent(rawSpec); specs.set(spec.id, spec);
        if (spec.featureIds.some(id => !definitions.has(id) || owner.has(id))) fail('component_column_identity');
        setEqual(spec.familyIds, [...new Set(spec.featureIds.map(id => definitions.get(id).familyId))], 'component_families');
        for (const id of spec.featureIds) {
          const d = definitions.get(id); owner.set(id, spec.id);
          if (d.producer.sourceSha256 !== spec.sourceSha256 || d.sourceProfile !== spec.sourceProfile) fail('definition_component_semantics');
        }
      }
      if (owner.size !== definitions.size) fail('definitions_without_component_spec');
      const implementations = new Map();
      for (const impl of q.familyImplementations) {
        if (!registry.families.has(impl.familyId) || !IMPLEMENTATIONS.has(impl.status)) fail('family_implementation');
        unique(impl.definitionIds, 'family_definition_ids');
        setEqual(impl.definitionIds, q.definitions.filter(d => d.familyId === impl.familyId).map(d => d.id), 'family_definition_inventory');
        if (impl.status === 'implemented' && !impl.definitionIds.length) fail('implemented_family_without_definitions');
        implementations.set(impl.familyId, impl);
      }
      const blocks = new Map(), usedRefs = new Set(), values = new Map(), missing = new Map(), blockRefs = new Map();
      for (const block of q.componentBlocks) {
        const spec = specs.get(block.componentId);
        if (!spec || block.contract !== COMPONENT_CONTRACT || !object(block.producer)) fail('component_block_contract');
        if (metadataKeys.some(k => block.producer[k] !== spec[k])) fail('component_version_or_profile');
        if (block.componentSemanticHash !== digest(spec)) fail('component_semantic_binding');
        if (block.mapId !== q.mapId || block.seriesId !== q.seriesId) fail('component_target_identity');
        if (block.targetIdentityHash !== targetBinding.hash) fail('component_target_revision');
        const at = instantNs(block.availableAt);
        if (at > decision || at < targetBinding.validFrom) fail('component_future_or_preidentity');
        if (canonical(block.featureIds) !== canonical(spec.featureIds)) fail('component_column_order');
        if (!Array.isArray(block.values) || !Array.isArray(block.missing) || block.values.length !== spec.featureIds.length || block.missing.length !== block.values.length) fail('component_value_shape');
        unique(block.sourceRefIds, 'component_source_refs'); unique(block.historyRefIds, 'component_history_refs');
        const selected = [...block.sourceRefIds.map(id => { const r = refs.get(id); if (!r || r.kind !== 'source' || !spec.sourceProfiles.includes(r.sourceProfile)) fail('component_source_reference'); return r; }), ...block.historyRefIds.map(id => { const r = refs.get(id); if (!r || r.kind !== 'history' || !spec.historyProfiles.includes(r.sourceProfile)) fail('component_history_reference'); return r; })];
        const scopes = new Set(selected.map(r => r.scope));
        const declaredScopes = new Set(spec.featureIds.flatMap(id => definitions.get(id).inputScopes));
        if ([...scopes].some(scope => !declaredScopes.has(scope))) fail('component_undeclared_input_scope');
        for (const id of spec.featureIds) if (definitions.get(id).inputScopes.some(s => !scopes.has(s))) fail('component_scope_evidence_missing');
        if (selected.some(r => instantNs(r.availableAt) > at)) fail('component_precedes_input');
        if (selected.some(r => r.kind === 'history') && (block.historyCutoffAt === null || instantNs(block.historyCutoffAt) !== cutoff)) fail('component_history_cutoff');
        if (!selected.some(r => r.kind === 'history') && block.historyCutoffAt !== null) fail('unexpected_component_history_cutoff');
        selected.forEach(r => usedRefs.add(r.id)); blockRefs.set(spec.id, selected);
        spec.featureIds.forEach((id, i) => {
          const value = block.values[i], isMissing = block.missing[i], d = definitions.get(id);
          if (typeof isMissing !== 'boolean' || isMissing !== (value === null)) fail('value_missing_mask');
          if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || d.dtype === 'int32' && (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) || d.dtype === 'float32' && !Number.isFinite(Math.fround(value)))) fail('value_dtype_or_finite');
          values.set(id, value); missing.set(id, isMissing);
        });
        blocks.set(spec.id, block);
      }
      const liveRefs = [...usedRefs].map(id => refs.get(id)).filter(r => r.scope === 'current_live');
      const anchors = liveRefs.filter(r => r.role === 'anchor');
      if (liveRefs.length) {
        if (!anchors.length) fail('live_anchor_required');
        const first = anchors[0];
        if (anchors.some(r => r.stateKey !== first.stateKey || r.sourceProfile !== first.sourceProfile || r.gameClockSeconds !== first.gameClockSeconds || instantNs(r.availableAt) !== instantNs(first.availableAt))) fail('mixed_live_anchors');
        for (const r of liveRefs.filter(r => r.role === 'prefix')) if (r.anchorStateKey !== first.stateKey || r.sourceProfile !== first.sourceProfile || r.gameClockSeconds > first.gameClockSeconds || instantNs(r.availableAt) > instantNs(first.availableAt)) fail('future_or_mixed_live_prefix');
        for (const [id, selected] of blockRefs) if (specs.get(id).featureIds.some(x => definitions.get(x).inputScopes.includes('current_live')) && !selected.some(r => r.role === 'anchor' && r.stateKey === first.stateKey)) fail('component_live_anchor_missing');
      }
      const familyStatuses = FAMILY_IDS.map(id => {
        const f = registry.families.get(id), impl = implementations.get(id), ids = q.definitions.filter(d => d.familyId === id).map(d => d.id);
        const requiredHere = required.includes(id), present = ids.filter(x => values.has(x)).length;
        const status = !eligible.includes(id) ? 'ineligible' : !requiredHere ? 'out_of_profile' : !impl || impl.status !== 'implemented' ? impl?.status ?? 'unimplemented' : !ids.length ? 'unimplemented' : present < ids.length ? 'missing_component' : ids.some(x => missing.get(x)) ? 'complete_with_missing_values' : 'complete';
        return { familyId: id, catalogueStatus: f.status, eligible: eligible.includes(id), required: requiredHere, implementationStatus: impl?.status ?? 'unimplemented', status, declaredFeatures: ids.length, presentFeatures: present, missingValues: ids.filter(x => missing.get(x) === true).length };
      });
      const incomplete = familyStatuses.filter(f => f.required && !['complete', 'complete_with_missing_values'].includes(f.status));
      const schema = { contract: 'aegis.semantic-feature-projection-schema.v1', registrySha256, targetId: q.targetId, stateMode: q.stateMode, profile, definitions: q.definitions, componentSpecs: q.componentSpecs, familyImplementations: q.familyImplementations };
      const semanticSchemaHash = digest(schema);
      const vector = incomplete.length ? null : { names: q.definitions.map(d => d.name), featureIds: q.definitions.map(d => d.id), values: q.definitions.map(d => values.get(d.id)), missing: q.definitions.map(d => missing.get(d.id)), semanticSchemaHash };
      const out = { contract: COMPOSER_CONTRACT, status: incomplete.length ? 'incomplete' : 'diagnostic_complete', completenessScope: q.diagnosticProfile === null ? 'declared_maximal_projection' : 'explicit_diagnostic_profile', implementationCompletenessAttested: false, sourceVerification: 'upstream_adapter_responsibility', targetId: q.targetId, stateMode: q.stateMode, mapId: q.mapId, seriesId: q.seriesId, targetIdentity: q.targetIdentity, targetIdentityHash: targetBinding.hash, decisionAt: q.decisionAt, historyCutoffAt: q.historyCutoffAt, readMode: q.readMode, registrySha256, profileId: profile.profileId, profileHash, semanticSchemaHash, orderedDefinitionHash: projection.definitionHash, familyStatuses, missingRequiredFamilyIds: incomplete.map(f => f.familyId), vector, inputReferences: [...usedRefs].sort().map(id => refs.get(id)), componentOutputHashes: [...blocks].map(([componentId, b]) => ({ componentId, sha256: digest(b) })), eligibleForTraining: false, eligibleForServing: false, recordedPrediction: false };
      return freeze({ ...out, contentHash: digest(out) });
    }
  });
}
