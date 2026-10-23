import { createHash } from 'node:crypto';

export const TARGET_IDS = Object.freeze(['PRE_MAP_WIN','PRE_KILLS','PRE_DURATION','POST_MAP_WIN','POST_KILLS','POST_DURATION','LIVE_MAP_WIN','LIVE_KILLS','LIVE_DURATION','SERIES_PRE','SERIES_BETWEEN','SERIES_LIVE']);
export const CATALOGUE_IDS = Object.freeze(['postdraft6668','observed-live268','historical-prior7148','wide-live36114','series14255','totals37024','totals-state6','totals-draft1006','individual-live45938','corrected-rich-totals46848','phase-totals37024','c3-networth80142','earned-economy114450','steam-coherent38468-v2']);
export const FAMILY_IDS = Object.freeze(Object.entries({I:4,H:14,D:8,P:5,S:6,L:20,R:7,Q:7,T:4,O:4}).flatMap(([p,n])=>Array.from({length:n},(_,i)=>p+String(i+1).padStart(2,'0'))));
const TARGET_CONTRACTS=Object.fromEntries(TARGET_IDS.map(id=>[id,{
 phase:id.startsWith('SERIES_')?id:id.split('_')[0],
 target:id.startsWith('SERIES_')?'series_team1_win':id.endsWith('_WIN')?'map_radiant_win':id.endsWith('_KILLS')?(id.startsWith('LIVE_')?'remaining_kills_distribution':'map_total_kills_distribution'):(id.startsWith('LIVE_')?'remaining_duration_seconds_distribution':'map_total_duration_seconds_distribution')
}]));
const SHA = /^[a-f0-9]{64}$/;
const SCOPES = new Set(['prior_maps','current_draft','current_live','series_context','previous_series_maps','current_map_label','candidate_axis','presentation']);
function fail(reason) { throw new Error(reason); }
function text(v, name) { if(typeof v!=='string'||!v.trim()) fail('required:'+name); }
function unique(v, name) { if(!Array.isArray(v)||v.some(x=>typeof x!=='string'||!x)||new Set(v).size!==v.length) fail('unique_strings:'+name); }
function equalSet(a,b,name) { unique(a,name);unique(b,name);if(a.length!==b.length||a.some(x=>!b.includes(x))) fail('set_mismatch:'+name); }
function sha(v,name) { if(typeof v!=='string'||!SHA.test(v)) fail('invalid_sha256:'+name); }
export function canonical(value) {
  if(value===null||typeof value==='string'||typeof value==='boolean') return JSON.stringify(value);
  if(typeof value==='number'&&Number.isFinite(value)) return JSON.stringify(value);
  if(Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if(value&&Object.getPrototypeOf(value)===Object.prototype) return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  fail('non_json_value');
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export function validateRegistry(index, familyDocument, targetDocument) {
  if(index?.contract!=='aegis.unified-feature-catalogue-index.v1'||familyDocument?.contract!=='aegis.unified-feature-families.v1'||targetDocument?.contract!=='aegis.twelve-logical-targets.v1') fail('registry_contract');
  const families=familyDocument.families,targets=targetDocument.targets,catalogues=index.catalogues;
  if(!Array.isArray(families)||!Array.isArray(targets)||!Array.isArray(catalogues)) fail('registry_arrays');
  equalSet(families.map(x=>x.id),FAMILY_IDS,'families'); equalSet(targets.map(x=>x.id),TARGET_IDS,'targets'); equalSet(catalogues.map(x=>x.id),CATALOGUE_IDS,'catalogues');
  if(index.featureFamilyCount!==79||index.logicalTargets!==12||index.totalCatalogues!==14) fail('registry_counts');
  const byFamily=new Map(families.map(x=>[x.id,x])),byTarget=new Map(targets.map(x=>[x.id,x]));
  for(const f of families) {
    for(const k of ['kind','formula','units','status','missingPolicy','availabilityGate']) text(f[k],f.id+'.'+k);
    unique(f.eligibleTargets,f.id+'.targets'); unique(f.eligiblePhases,f.id+'.phases');
    if(f.eligibleTargets.some(id=>!byTarget.has(id))) fail('unknown_target:'+f.id);
    equalSet(f.eligiblePhases,[...new Set(f.eligibleTargets.map(id=>byTarget.get(id).phase))],f.id+'.phases');
    if(f.kind==='label_only'&&f.eligibleTargets.length) fail('label_family_predictive:'+f.id);
  }
  for(const t of targets) {
    text(t.target,t.id+'.target'); unique(t.stateModes,t.id+'.stateModes');
    if(t.target!==TARGET_CONTRACTS[t.id].target||t.phase!==TARGET_CONTRACTS[t.id].phase) fail('target_semantics:'+t.id);
    const expectedMode=t.id==='SERIES_LIVE'?['observed_postdraft','observed_live']:[t.phase];
    equalSet(t.stateModes,expectedMode,t.id+'.modes');
    equalSet(t.eligibleFamilyIds,families.filter(f=>f.eligibleTargets.includes(t.id)).map(f=>f.id),t.id+'.families');
  }
  let total=0;
  for(const c of catalogues) {
    if(!Number.isSafeInteger(c.count)||c.count<1) fail('catalogue_count:'+c.id);
    sha(c.namesPin?.sha256,c.id+'.namesPin');sha(c.orderedNameHash,c.id+'.orderedNameHash');sha(c.source?.sha256,c.id+'.source');
    total+=c.count;
  }
  if(total!==index.catalogueOccurrenceCount) fail('occurrence_count');
  return {families:byFamily,targets:byTarget,catalogues:new Map(catalogues.map(c=>[c.id,c]))};
}

// This identity preserves all occurrences without making a semantic-alias claim.
export function occurrenceId(catalogue, index, name) {
  if(!Number.isSafeInteger(index)||index<0||index>=catalogue.count) fail('column_index'); text(name,'column_name');sha(catalogue.orderedNameHash,'orderedNameHash');
  return catalogue.id+'@'+catalogue.orderedNameHash+':'+index+':'+encodeURIComponent(name);
}

// The prose family catalogue is an inventory. Every executable projection needs
// this explicit per-feature semantic definition; broad family labels are not gates.
export function validateDefinition(d, registry) {
  if(d?.contract!=='aegis.executable-feature-definition.v1') fail('definition_contract');
  for(const k of ['id','name','version','familyId','formula','formulaVersion','units','dtype','missingPolicy','timePolicy','sourceProfile','learnedStatePolicy']) text(d[k],k);
  if(d.semanticStatus!=='specified') fail('semantic_definition_unresolved');
  const f=registry.families.get(d.familyId);if(!f) fail('unknown_family');
  unique(d.inputScopes,'inputScopes');if(!d.inputScopes.length||d.inputScopes.some(x=>!SCOPES.has(x))) fail('input_scope');
  unique(d.allowedTargets,'allowedTargets');if(!d.allowedTargets.length||d.allowedTargets.some(x=>!f.eligibleTargets.includes(x))) fail('family_target_ineligible');
  if(f.kind==='label_only'||d.inputScopes.includes('current_map_label')) fail('current_map_label_predictive');
  if(d.inputScopes.includes('presentation')||f.kind==='presentation_context') fail('presentation_is_not_predictor');
  if(d.dtype!=='float32'&&d.dtype!=='float64'&&d.dtype!=='int32') fail('dtype');
  sha(d.producer?.sourceSha256,'producer');text(d.producer?.symbol,'producer.symbol');
  if(d.learnedStatePolicy!=='none'&&d.learnedStatePolicy!=='TRAIN_fold_cohort_pinned') fail('learned_state_policy');
  if(d.learnedStatePolicy!=='none') for(const k of ['learnedTransformStateSha256','foldSha256','trainingCohortSha256']) sha(d.learnedStateBinding?.[k],k);
  return d;
}
export function validateProjection({targetId,stateMode,definitions}, registry) {
  const t=registry.targets.get(targetId);if(!t) fail('projection_target');if(!t.stateModes.includes(stateMode)) fail('projection_state_mode');
  if(!Array.isArray(definitions)||!definitions.length) fail('projection_definitions');
  unique(definitions.map(d=>d.id),'projection_ids');unique(definitions.map(d=>d.name),'projection_names');
  const live=stateMode==='LIVE'||stateMode==='observed_live';
  const draft=live||stateMode==='POST'||stateMode==='observed_postdraft';
  for(const d of definitions) {
    validateDefinition(d,registry);if(!d.allowedTargets.includes(targetId)) fail('feature_target_ineligible:'+d.id);
    if(d.inputScopes.includes('current_live')&&!live) fail('dynamic_in_nonlive_projection:'+d.id);
    if(d.inputScopes.includes('current_draft')&&!draft) fail('draft_in_undrafted_projection:'+d.id);
    if(d.inputScopes.includes('previous_series_maps')&&!['SERIES_BETWEEN','SERIES_LIVE'].includes(targetId)) fail('previous_series_scope:'+d.id);
    if(d.inputScopes.includes('candidate_axis')) {
      const expected=targetId.startsWith('LIVE_')?'remaining':'final';
      if(!/_(KILLS|DURATION)$/.test(targetId)||d.coordinate!==expected) fail('candidate_axis_coordinate:'+d.id);
      const unit=targetId.endsWith('_DURATION')?'seconds':'kills';if(d.units!==unit) fail('candidate_axis_units:'+d.id);
    }
  }
  return {contract:'aegis.feature-projection-validation.v1',targetId,stateMode,featureCount:definitions.length,definitionHash:digest(definitions),trainingAdmitted:false,servingAdmitted:false};
}

const semanticKeys=['version','formula','formulaVersion','units','dtype','missingPolicy','timePolicy','sourceProfile','inputScopes','learnedStatePolicy','learnedStateBinding','coordinate'];
export function compareSemantics(a,b) {
  if([a,b].some(d=>d?.semanticStatus!=='specified'||[...semanticKeys.slice(0,8),'learnedStatePolicy'].some(k=>typeof d[k]!=='string'||!d[k])||!Array.isArray(d.inputScopes)||!d.inputScopes.length||!SHA.test(d.producer?.sourceSha256??''))) return {classification:'unresolved',reason:'semantics_not_specified',aliasAllowed:false};
  const semanticValue=(d,k)=>k==='inputScopes'?[...d.inputScopes].sort():d[k]??null;
  const differences=semanticKeys.filter(k=>canonical(semanticValue(a,k))!==canonical(semanticValue(b,k)));
  if(differences.length) return {classification:'confirmed_contract_conflict',differences,aliasAllowed:false};
  return {classification:'matching_semantic_declarations',differences:[],aliasAllowed:false,reason:'requires_pinned_parity_proof_and_explicit_resolution'};
}
export function resolveAlias(a,b,resolution,verifyProofPin) {
  if(compareSemantics(a,b).classification!=='matching_semantic_declarations') fail('alias_semantics_conflict_or_unresolved');
  if(resolution?.contract!=='aegis.feature-alias-resolution.v1'||resolution.action!=='alias'||resolution.leftDefinitionHash!==digest(a)||resolution.rightDefinitionHash!==digest(b)) fail('alias_resolution_identity');
  sha(resolution.proofPin?.sha256,'proofPin');text(resolution.proofPin?.path,'proofPin.path');
  if(!Number.isSafeInteger(resolution.proofPin.bytes)||resolution.proofPin.bytes<1||typeof verifyProofPin!=='function') fail('alias_proof_unverified');
  const proof=verifyProofPin(resolution.proofPin);
  if(proof?.contract!=='aegis.feature-parity-proof.v1'||proof.passed!==true||proof.leftDefinitionHash!==digest(a)||proof.rightDefinitionHash!==digest(b)||!Number.isSafeInteger(proof.caseCount)||proof.caseCount<1) fail('alias_proof_unverified');
  text(resolution.canonicalFeatureId,'canonicalFeatureId');
  return {canonicalFeatureId:resolution.canonicalFeatureId,retainedOccurrenceIds:[a.id,b.id],proofPin:resolution.proofPin};
}
