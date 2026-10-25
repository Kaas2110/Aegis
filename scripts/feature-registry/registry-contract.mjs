import { createHash } from 'node:crypto';

export const TARGET_IDS = Object.freeze(['PRE_MAP_WIN','PRE_KILLS','PRE_DURATION','POST_MAP_WIN','POST_KILLS','POST_DURATION','LIVE_MAP_WIN','LIVE_KILLS','LIVE_DURATION','SERIES_PRE','SERIES_BETWEEN','SERIES_LIVE']);
export const CATALOGUE_IDS = Object.freeze(['postdraft6668','observed-live268','historical-prior7148','wide-live36114','series14255','totals37024','totals-state6','totals-draft1006','individual-live45938','corrected-rich-totals46848','phase-totals37024','c3-networth80142','earned-economy114450','steam-coherent38468-v2']);
export const FAMILY_IDS = Object.freeze(Object.entries({I:4,H:14,D:8,P:5,S:6,L:20,R:7,Q:7,T:4,O:4}).flatMap(([p,n])=>Array.from({length:n},(_,i)=>p+String(i+1).padStart(2,'0'))));
const TARGET_CONTRACTS=Object.fromEntries(TARGET_IDS.map(id=>[id,{
 phase:id.startsWith('SERIES_')?id:id.split('_')[0],
 target:id.startsWith('SERIES_')?'series_team1_win':id.endsWith('_WIN')?'map_radiant_win':id.endsWith('_KILLS')?(id.startsWith('LIVE_')?'remaining_kills_distribution':'map_total_kills_distribution'):(id.startsWith('LIVE_')?'remaining_duration_seconds_distribution':'map_total_duration_seconds_distribution')
}]));
const SHA = /^[a-f0-9]{64}$/;
const SCOPES = new Set(['prior_maps','current_identity','current_draft','current_live','series_context','previous_series_maps','current_map_label','candidate_axis','presentation']);
// One scope policy for producer filtering and final projection validation. Family
// target unions remain necessary but never attest a particular input's scope.
export const TARGET_SCOPE_POLICY = Object.freeze({
 contract:'aegis.feature-target-scope-policy.v1',version:'2026-10-24.r1',
 undraftedTargets:Object.freeze(['PRE_MAP_WIN','PRE_KILLS','PRE_DURATION','SERIES_PRE','SERIES_BETWEEN']),
 previousSeriesMapTargets:Object.freeze(['SERIES_BETWEEN','SERIES_LIVE']),
 forbiddenPredictiveScopes:Object.freeze(['current_map_label','presentation']),
 historyTimePolicy:'Every historical fact availableAt <= historyCutoffAt; current identity validFrom <= decisionAt; current map excluded.',
 currentTimePolicy:'One admitted source profile per coherent current frame; receipt <= decisionAt; no inferred event latency.',
 betweenPolicy:'Separate immutable team1/team2-oriented context; never reuse the previous map draft or sides as next-map inputs.'
});
export function projectionScopeRejection(definition,targetId,stateMode) {
 if(!TARGET_IDS.includes(targetId))return 'projection_target';
 const expected=targetId==='SERIES_LIVE'?['observed_postdraft','observed_live']:[TARGET_CONTRACTS[targetId].phase];
 if(!expected.includes(stateMode))return 'projection_state_mode';
 if(!definition||!Array.isArray(definition.inputScopes)||!definition.inputScopes.length||definition.inputScopes.some(s=>!SCOPES.has(s))||new Set(definition.inputScopes).size!==definition.inputScopes.length)return 'input_scope';
 if(!Array.isArray(definition.allowedTargets)||!definition.allowedTargets.length||definition.allowedTargets.some(t=>!TARGET_IDS.includes(t))||new Set(definition.allowedTargets).size!==definition.allowedTargets.length)return 'allowed_targets';
 if(!definition.allowedTargets.includes(targetId))return 'feature_target_ineligible';
 const scopes=definition.inputScopes,live=stateMode==='LIVE'||stateMode==='observed_live',draft=live||stateMode==='POST'||stateMode==='observed_postdraft';
 if(scopes.includes('current_map_label'))return 'current_map_label_predictive';
 if(scopes.includes('presentation'))return 'presentation_is_not_predictor';
 if(scopes.includes('current_live')&&!live)return 'dynamic_in_nonlive_projection';
 if(scopes.includes('current_draft')&&!draft)return 'draft_in_undrafted_projection';
 if(scopes.includes('previous_series_maps')&&!TARGET_SCOPE_POLICY.previousSeriesMapTargets.includes(targetId))return 'previous_series_scope';
 if(scopes.includes('candidate_axis')){
  const expectedCoordinate=targetId.startsWith('LIVE_')?'remaining':'final';
  if(!/_(KILLS|DURATION)$/.test(targetId)||definition.coordinate!==expectedCoordinate)return 'candidate_axis_coordinate';
  if(definition.units!==(targetId.endsWith('_DURATION')?'seconds':'kills'))return 'candidate_axis_units';
 }
 return null;
}
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
  if(!Number.isSafeInteger(index)||index<0||index>=catalogue.count) fail('column_index'); text(name,'column_name');sha(catalogue.orderedNameHash,'orderedNameHash');sha(catalogue.source?.sha256,'sourceSha256');
  return catalogue.id+'@'+catalogue.source.sha256+'@'+catalogue.orderedNameHash+':'+index+':'+encodeURIComponent(name);
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
  for(const d of definitions) {
    validateDefinition(d,registry);
    const rejection=projectionScopeRejection(d,targetId,stateMode);if(rejection)fail(rejection+':'+d.id);
  }
  return {contract:'aegis.feature-projection-validation.v1',targetId,stateMode,featureCount:definitions.length,definitionHash:digest(definitions),trainingAdmitted:false,servingAdmitted:false};
}

// Projection validation preserves the historical definition contract. Aliasing
// has a stronger gate: omitted policies cannot silently mean not applicable.
export const SEMANTIC_IDENTITY_FIELDS=Object.freeze(['version','familyId','formula','formulaVersion','units','dtype','missingPolicy','timePolicy','sourceProfile','inputScopes','allowedTargets','learnedStatePolicy','learnedStateBinding','coordinate','orientation','inputFields','inputBindings','historyDefinitions','supportUnit','minimumSupport','historyWindowDays','supportPolicy','populationPolicy','eventTimePolicy','availabilityTimePolicy','gameClockPolicy','rolePolicy','patchPolicy','phasePolicy','missingReasonPolicy','windowPolicy','weightPolicy','tiePolicy','variancePolicy','quantilePolicy','formulaParameters']);
const identityOnly=new Set(['contract','id','name','producer','semanticStatus','knownAt']);
const setFields=new Set(['inputScopes','allowedTargets']);
const semanticTextFields=new Set(['version','familyId','formula','formulaVersion','units','dtype','missingPolicy','timePolicy','sourceProfile','learnedStatePolicy','coordinate','orientation','supportUnit','supportPolicy','populationPolicy','eventTimePolicy','availabilityTimePolicy','gameClockPolicy','rolePolicy','patchPolicy','phasePolicy','missingReasonPolicy','windowPolicy','weightPolicy','tiePolicy','variancePolicy','quantilePolicy']);
/** Canonical ALL-field descriptor. Unknown additive metadata is compared too;
 * only occurrence/source-code identity and observation-specific knownAt are
 * excluded. A parity proof remains separately bound to both full definitions. */
export function canonicalSemanticDescriptor(d){
 const missingFields=[];
 if(!d||d.semanticStatus!=='specified'||!SHA.test(d.producer?.sourceSha256??''))return{complete:false,missingFields:['semanticStatus_or_producer'],descriptor:null};
 if(d.semanticVerification!==undefined&&d.semanticVerification!=='authoritative_template')return{complete:false,missingFields:['semanticVerification:'+d.semanticVerification],descriptor:null};
 for(const key of SEMANTIC_IDENTITY_FIELDS){
  if(!Object.hasOwn(d,key)){missingFields.push(key);continue;}
  const v=d[key];
  if(semanticTextFields.has(key)&&(typeof v!=='string'||!v.trim()))missingFields.push(key);
  else if(['inputScopes','allowedTargets','inputFields','historyDefinitions'].includes(key)&&(!Array.isArray(v)||v.some(x=>typeof x!=='string'||!x.trim())||new Set(v).size!==v.length||(['inputScopes','allowedTargets','inputFields'].includes(key)&&!v.length)))missingFields.push(key);
  else if(key==='inputBindings'&&(!Array.isArray(v)||!v.length||v.some(x=>!x||Object.getPrototypeOf(x)!==Object.prototype||['normalizedField','rawField','sourceProfile','sourceKind','units','availabilityPolicy'].some(k=>typeof x[k]!=='string'||!x[k].trim()))))missingFields.push(key);
  else if(['minimumSupport','historyWindowDays'].includes(key)&&v!==null&&!(typeof v==='number'&&Number.isFinite(v)&&v>=0))missingFields.push(key);
  else if(['formulaParameters','learnedStateBinding'].includes(key)&&v!==null&&(!v||Object.getPrototypeOf(v)!==Object.prototype))missingFields.push(key);
 }
 if(missingFields.length)return{complete:false,missingFields,descriptor:null};
 const descriptor={};
 try{for(const key of Object.keys(d).sort()){if(identityOnly.has(key))continue;const v=setFields.has(key)?[...d[key]].sort():d[key];canonical(v);descriptor[key]=structuredClone(v);}}catch{return{complete:false,missingFields:['non_json_semantic_metadata'],descriptor:null};}
 return{complete:true,missingFields:[],descriptor};
}
export function compareSemantics(a,b) {
  const left=canonicalSemanticDescriptor(a),right=canonicalSemanticDescriptor(b);
  if(!left.complete||!right.complete)return{classification:'unresolved',reason:'complete_semantic_descriptor_required',missingFields:{left:left.missingFields,right:right.missingFields},aliasAllowed:false};
  const keys=[...new Set([...Object.keys(left.descriptor),...Object.keys(right.descriptor)])].sort();
  const differences=keys.filter(k=>Object.hasOwn(left.descriptor,k)!==Object.hasOwn(right.descriptor,k)||canonical(left.descriptor[k])!==canonical(right.descriptor[k]));
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
