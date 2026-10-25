/** Frozen export/split metadata, not a data loader or fitting authority. The host
 * must verify pinned bytes and original source evidence separately. This module
 * refuses feature/label co-location, future inputs and split leakage; it cannot
 * prove that caller-supplied timestamps or column dispositions are truthful. */
import {digest,TARGET_IDS,projectionScopeRejection} from './registry-contract.mjs';
import {isProxy} from 'node:util/types';
import {LEGACY_FEATURE_CAPACITY_PROFILE as LEGACY,FULL_FEATURE_CAPACITY_PROFILE as FULL,featureCapacityProfileForSchema} from '../steam-live-collector/source-adapter/featureCapacityProfiles.mjs';

export const PINNED_DATASET_MANIFEST_CONTRACT='aegis.pinned-dataset-manifest.v1';
export const PINNED_DATASET_MANIFEST_FULL_CONTRACT='aegis.pinned-dataset-manifest.v2';
export const FIXED_LIVE_LANDMARK_SECONDS=Object.freeze(Array.from({length:16},(_,i)=>(i+1)*300));
const SHA=/^[a-f0-9]{64}$/,ROLES=['train','tune','early_stop','holdout'],PROVENANCE=['observed_live','retrospective_reconstruction','synthetic'];
const fail=x=>{throw Error('pinned_dataset:'+x);};
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>obj(x)&&Object.keys(x).sort().join(',')===[...keys].sort().join(',');
const text=x=>typeof x==='string'&&x.length>0&&x.length<=256;
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const bounded=(a,n,key)=>{if(!Array.isArray(a)||a.length>n)fail(key+'_bound');return a;};
const unique=(a,key)=>{if(new Set(a).size!==a.length)fail(key+'_duplicate');};
function at(value,key){
 // Retain sub-millisecond order. Date.parse alone silently erases nanoseconds.
 const m=typeof value==='string'&&/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(value);if(!m)fail(key+'_time');
 const ms=Date.parse(m[1]+'Z');if(!Number.isFinite(ms)||new Date(ms).toISOString().slice(0,19)!==m[1])fail(key+'_time');return BigInt(ms)*1000000n+BigInt((m[2]??'').padEnd(9,'0'));
}
function pin(p,key){if(!obj(p)||!text(p.id)||!SHA.test(p.sha256??'')||!Number.isSafeInteger(p.bytes)||p.bytes<1)fail(key+'_pin');return p;}
function schemaCapacity(schema){
 if(!Object.hasOwn(schema,'schemaContract')&&!Object.hasOwn(schema,'capacityProfile'))return LEGACY;
 return featureCapacityProfileForSchema({contract:schema.schemaContract,...(Object.hasOwn(schema,'capacityProfile')?{capacityProfile:schema.capacityProfile}:{})});
}
function mode(targetId,stateMode){return TARGET_IDS.includes(targetId)&&(targetId==='SERIES_LIVE'?['observed_postdraft','observed_live']:[targetId.startsWith('SERIES_')?targetId:targetId.split('_')[0]]).includes(stateMode);}
const disabled={trainingAdmitted:false,qualityEvaluationPerformed:false,sourceAvailabilityAttested:false,prospectiveCoverageAttested:false};

/** All feature rows are metadata references; target values stay in separately
 * pinned label tables. A series (and its linked component) belongs to one role.
 * predictionStartAt is the earliest included forecast horizon; startAt is actual
 * series play. Grouping spans BOTH, so legitimate prematch rows cannot be dropped
 * or assigned to a different split. Cross-boundary series must be purged. */
export function createPinnedDatasetManifest({datasetId,createdAt,sourcePins=[],featureSchemas=[],labelTables=[],splits=[],series=[],rows=[],policy,limits={}}={}){
 if(!text(datasetId))fail('dataset_id');const created=at(createdAt,'created');
 const maxRows=limits.maxRows??1000000,maxSeries=limits.maxSeries??100000;if(!Number.isSafeInteger(maxRows)||maxRows<1||maxRows>1000000||!Number.isSafeInteger(maxSeries)||maxSeries<1||maxSeries>100000)fail('limits');
 bounded(sourcePins,4096,'sources');bounded(featureSchemas,64,'schemas');bounded(labelTables,64,'labels');bounded(series,maxSeries,'series');bounded(rows,maxRows,'rows');
 if(!sourcePins.length||!featureSchemas.length||!labelTables.length||splits.length!==ROLES.length||!series.length)fail('required_inventory');
 if(!obj(policy)||!text(policy.historyWindowPolicy)||!text(policy.patchPolicy)||!text(policy.snapshotWeightPolicy)||!text(policy.collectionAvailabilityPolicy)||policy.aggregateFitPolicy!=='eligible_past_train_only'||policy.childPredictionPolicy!=='chronological_out_of_fold_version_bound'||policy.holdoutPolicy!=='inspected_holdout_is_not_untouched'||policy.refreshPolicy!=='reuse_pinned_sources_no_automatic_refresh')fail('policy');
 const sourceById=new Map(),schemaByHash=new Map(),labelsById=new Map(),allInputHashes=new Set(),labelHashes=new Set();
 let columnCount=0,hasFullSchema=false;
 for(const p of sourcePins){pin(p,'source');if(!exact(p,['id','sha256','bytes','provenance','availableAt'])||!PROVENANCE.includes(p.provenance))fail('source_provenance');if(at(p.availableAt,'source_available')>created)fail('future_source');if(sourceById.has(p.id))fail('source_duplicate');sourceById.set(p.id,p);allInputHashes.add(p.sha256);}
 for(const schema of featureSchemas){pin(schema,'schema');const capacity=schemaCapacity(schema),full=capacity===FULL;hasFullSchema||=full;if(!exact(schema,['id','sha256','bytes','schemaSha256',...(full?['schemaContract','capacityProfile']:[]),'targetId','stateMode','columns'])||!SHA.test(schema.schemaSha256??'')||!mode(schema.targetId,schema.stateMode)||!Array.isArray(schema.columns)||!schema.columns.length||schema.columns.length>capacity.maxFeatures||schemaByHash.has(schema.schemaSha256))fail('feature_schema');
  columnCount+=schema.columns.length;if(columnCount>300000)fail('total_columns_bound');
   if(schema.columns.some(c=>!obj(c)))fail('feature_column');unique(schema.columns.map(c=>c.id),'column');for(const c of schema.columns){if(Object.keys(c).some(k=>!['id','semanticRole','inputScopes','coordinate','units','learnedStatePolicy','learnedStateBinding'].includes(k))||!text(c.id)||c.semanticRole!=='predictor'||projectionScopeRejection({inputScopes:c.inputScopes,allowedTargets:[schema.targetId],coordinate:c.coordinate,units:c.units},schema.targetId,schema.stateMode)!==null)fail('label_input_isolation_or_phase');
    if(c.learnedStatePolicy!==undefined&&!['none','TRAIN_fold_cohort_pinned'].includes(c.learnedStatePolicy))fail('learned_column_policy');
    if(c.learnedStatePolicy==='TRAIN_fold_cohort_pinned'){if(!exact(c.learnedStateBinding,['learnedTransformStateSha256','foldSha256','trainingCohortSha256'])||Object.values(c.learnedStateBinding).some(v=>!SHA.test(v??'')))fail('learned_column_binding');}else if(c.learnedStateBinding!==undefined&&c.learnedStateBinding!==null)fail('unexpected_learned_column_binding');
   }
  schemaByHash.set(schema.schemaSha256,schema);allInputHashes.add(schema.sha256);
 }
 for(const label of labelTables){pin(label,'label');if(!exact(label,['id','sha256','bytes','targetIds','inputEligible'])||labelsById.has(label.id)||allInputHashes.has(label.sha256)||!Array.isArray(label.targetIds)||!label.targetIds.length||label.targetIds.some(t=>!TARGET_IDS.includes(t))||label.inputEligible!==false)fail('label_table_isolation');unique(label.targetIds,'label_targets');labelsById.set(label.id,label);labelHashes.add(label.sha256);}
 const splitByRole=new Map();let previousEnd=null;
 for(let i=0;i<splits.length;i++){const s=splits[i];if(s?.role!==ROLES[i])fail('split_roles');const start=at(s.startAt,'split_start'),end=at(s.endAt,'split_end');if(start>=end||previousEnd!==null&&start<previousEnd||end>created)fail('split_chronology');previousEnd=end;splitByRole.set(s.role,{...s,start,end});}
 const bySeries=new Map(),mapOwners=new Map(),components=new Map(),assignments=[];
 for(const s of series){if(!obj(s)||!text(s.seriesId)||!text(s.componentId)||bySeries.has(s.seriesId)||!Array.isArray(s.mapIds)||!s.mapIds.length||s.mapIds.length>5||s.mapIds.some(id=>!text(id)))fail('series_identity');unique(s.mapIds,'series_maps');
  const predictionStart=at(s.predictionStartAt,'series_prediction_start'),start=at(s.startAt,'series_start'),end=at(s.endAt,'series_end'),available=at(s.availableAt,'series_available');if(predictionStart>start||start>end||available<end||available>created)fail('series_times');
  if(s.splitRole==='purged'){if(!text(s.purgeReason))fail('purge_reason');}else{
   const split=splitByRole.get(s.splitRole);if(!split||predictionStart<split.start||end>=split.end||available>=split.end)fail('series_crosses_split_or_availability');
   if(s.splitRole==='holdout'&&typeof s.holdoutInspected!=='boolean')fail('holdout_inspection_disclosure');
   if(components.has(s.componentId)&&components.get(s.componentId)!==s.splitRole)fail('linked_component_split');components.set(s.componentId,s.splitRole);
  }
  for(const id of s.mapIds){if(mapOwners.has(id))fail('map_cross_series');mapOwners.set(id,s.seriesId);}bySeries.set(s.seriesId,s);assignments.push({seriesId:s.seriesId,componentId:s.componentId,mapIds:[...s.mapIds],role:s.splitRole,purgeReason:s.splitRole==='purged'?s.purgeReason:null,untouchedHoldout:s.splitRole==='holdout'&&!s.holdoutInspected});
 }
 const rowIds=new Set(),labelOwners=new Map(),provenanceCounts=Object.fromEntries(PROVENANCE.map(p=>[p,0])),historicalAvailabilityCounts={retained_as_of:0,reconstruction_only:0,synthetic:0,not_applicable:0},roleCounts=Object.fromEntries([...ROLES,'purged'].map(p=>[p,0]));
 for(const r of rows){if(!obj(r)||!text(r.rowId)||rowIds.has(r.rowId)||!PROVENANCE.includes(r.provenance)||!text(r.sourcePinId)||!SHA.test(r.schemaSha256??'')||!SHA.test(r.inputSha256??'')||!text(r.labelTableId)||!text(r.labelRowId))fail('row_identity');rowIds.add(r.rowId);
  if(Object.keys(r).some(k=>!['rowId','seriesId','mapId','targetId','stateMode','decisionAt','historyCutoffAt','historicalAvailability','eventAt','inputKnownAt','collectedAt','materializedAt','replayHorizonAt','originalAvailability','provenance','sourcePinId','schemaSha256','inputSha256','labelTableId','labelRowId'].includes(k)))fail('row_unrecognized_or_label_payload');
  const s=bySeries.get(r.seriesId),schema=schemaByHash.get(r.schemaSha256),source=sourceById.get(r.sourcePinId),label=labelsById.get(r.labelTableId);
  // Keep predicates explicit: map IDs are required only for selected-map targets.
  if(!s||!schema||schema.targetId!==r.targetId||schema.stateMode!==r.stateMode||!mode(r.targetId,r.stateMode)||!source||source.provenance!==r.provenance||!label||!label.targetIds.includes(r.targetId)||labelHashes.has(r.inputSha256)||(!r.targetId.startsWith('SERIES_')&&!s.mapIds.includes(r.mapId))||(r.mapId!==null&&!s.mapIds.includes(r.mapId)))fail('row_bindings');
  const labelKey=JSON.stringify([r.labelTableId,r.labelRowId]),labelOwner=JSON.stringify([r.seriesId,r.targetId.startsWith('SERIES_')?'whole_series':r.mapId]);if(labelOwners.has(labelKey)&&labelOwners.get(labelKey)!==labelOwner)fail('label_cross_target_identity');labelOwners.set(labelKey,labelOwner);
  const decision=at(r.decisionAt,'decision'),cutoff=at(r.historyCutoffAt,'history_cutoff'),event=at(r.eventAt,'event'),collected=at(r.collectedAt,'collected'),materialized=at(r.materializedAt,'materialized');
  if(cutoff>decision||event>decision||decision<at(s.predictionStartAt,'series_prediction_start')||decision>at(s.endAt,'series_end')||collected>materialized||materialized>created)fail('row_future_or_materialization');
  const historical=schema.columns.some(c=>c.inputScopes.some(s=>s==='prior_maps'||s==='previous_series_maps')),h=r.historicalAvailability;
  if(!historical){if(h!==null)fail('history_nonapplicability');historicalAvailabilityCounts.not_applicable++;}
  else{
   if(!exact(h,['basis','maxKnownAt'])||!['retained_as_of','reconstruction_only','synthetic'].includes(h.basis)||h.basis==='synthetic'&&r.provenance!=='synthetic')fail('history_availability_basis');
   if(h.basis==='retained_as_of'){if(at(h.maxKnownAt,'history_max_known')>cutoff)fail('history_after_frozen_cutoff');}else if(h.maxKnownAt!==null)fail('history_original_availability_unknown');
   historicalAvailabilityCounts[h.basis]++;
  }
  if(r.provenance==='observed_live'){
   const known=at(r.inputKnownAt,'input_known');if(r.originalAvailability!=='confirmed'||r.replayHorizonAt!==null||known>decision||known>collected||event>known||collected>decision)fail('observed_availability');
  }else if(r.provenance==='retrospective_reconstruction'){
   if(r.originalAvailability!=='unknown'||r.inputKnownAt!==null||at(r.replayHorizonAt,'replay_horizon')>decision)fail('replay_provenance');
  }else if(r.originalAvailability!=='synthetic'||r.inputKnownAt!==null||r.replayHorizonAt!==null)fail('synthetic_provenance');
  provenanceCounts[r.provenance]++;roleCounts[s.splitRole]++;
 }
 const body={contract:hasFullSchema?PINNED_DATASET_MANIFEST_FULL_CONTRACT:PINNED_DATASET_MANIFEST_CONTRACT,...(hasFullSchema?{capacityProfile:FULL.id}:{}),datasetId,createdAt,sourcePins:structuredClone(sourcePins),featureSchemas:structuredClone(featureSchemas),labelTables:structuredClone(labelTables),splits:structuredClone(splits),series:structuredClone(series),assignments,rows:structuredClone(rows),policy:structuredClone(policy),liveLandmarks:{gameSeconds:[...FIXED_LIVE_LANDMARK_SECONDS],overflowStratum:'80+',selection:'last_eligible_at_or_before_landmark_and_available_by_decision',ageBounds:'must_be_predeclared_for_game_clock_and_source_state',atRiskDenominator:'all_ongoing_maps_including_missing_error_stale_slots',independentUnit:'series_or_linked_component_never_frames'},counts:{series:series.length,maps:mapOwners.size,rows:rows.length,provenance:provenanceCounts,historicalAvailability:historicalAvailabilityCounts,roles:roleCounts,inspectedHoldoutSeries:series.filter(s=>s.splitRole==='holdout'&&s.holdoutInspected).length},evidenceMeaning:'Pinned metadata and split/causal checks only. Observed current frames may still have reconstruction-only history. Retrospective rows are not observed-live or prospective source coverage. Pinned byte verification, source semantics and future training permission remain separate.',...disabled};
 return freeze({...body,contentHash:digest(body)});
}

/** Select fixed 5..80 minute landmarks plus ONE explicitly frozen 80+ anchor.
 * Missing/error/stale ongoing maps remain in the coverage denominator. Both
 * game-clock and confirmed source-state age are bounded; repeated HTTP receipts
 * cannot renew an old sourceStateAt. Selection never uses a future game frame or
 * one unavailable at that landmark's decision time. The trusted host supplies
 * active epochs and ordered explicit barrier evidence; these metadata assertions
 * are not equivalent to producer eligibility or an owned runtime proof. */
export function selectFixedMinuteLandmarks({maps=[],observations=[],policy}={}){
 bounded(maps,100000,'landmark_maps');bounded(observations,1000000,'landmark_observations');
 if(!obj(policy)||!Number.isSafeInteger(policy.maximumGameAgeSeconds)||policy.maximumGameAgeSeconds<0||!Number.isSafeInteger(policy.maximumSourceStateAgeSeconds)||policy.maximumSourceStateAgeSeconds<0||!Number.isSafeInteger(policy.overflowAnchorSeconds)||policy.overflowAnchorSeconds<=4800)fail('landmark_policy');
 const anchors=[...FIXED_LIVE_LANDMARK_SECONDS.map(s=>({label:String(s/60),gameSecond:s})),{label:'80+',gameSecond:policy.overflowAnchorSeconds}],byMap=new Map(),mapById=new Map(),observationIds=new Set();
 for(const m of maps){if(!obj(m)||!text(m.mapId)||!text(m.seriesId)||mapById.has(m.mapId)||m.endedGameSecond!==null&&(!finite(m.endedGameSecond)||m.endedGameSecond<0)||!obj(m.decisionAtByLandmark)||!obj(m.activeSourceEpochByLandmark))fail('landmark_map');mapById.set(m.mapId,m);byMap.set(m.mapId,[]);}
 for(const o of observations){if(!obj(o)||!text(o.observationId)||observationIds.has(o.observationId)||!byMap.has(o.mapId)||!finite(o.gameSecond)||o.gameSecond<0||!['eligible','missing','error','stale','identity_barrier','continuity_barrier','terminal','stop'].includes(o.status)||!PROVENANCE.includes(o.provenance)||!text(o.sourceEpoch)||!Number.isSafeInteger(o.sequence)||o.sequence<0||typeof o.barrier!=='boolean')fail('landmark_observation');observationIds.add(o.observationId);const m=mapById.get(o.mapId);if(o.seriesId!==m.seriesId)fail('landmark_series');const available=at(o.availableAt,'observation_available'),source=o.sourceStateAt===null?null:at(o.sourceStateAt,'observation_state');if(source!==null&&source>available)fail('landmark_state_future');byMap.get(o.mapId).push({...o,available,source});}
 for(const slots of byMap.values()){
  slots.sort((a,b)=>a.sequence-b.sequence);let prior=null;const closedEpochs=new Set();
  for(const o of slots){if(prior&&(o.sequence===prior.sequence||o.available<prior.available))fail('landmark_event_order');if(prior&&o.sourceEpoch!==prior.sourceEpoch){closedEpochs.add(prior.sourceEpoch);if(closedEpochs.has(o.sourceEpoch))fail('landmark_epoch_reuse');}prior=o;}
 }
 for(const m of maps){let previousDecision=null;for(const a of anchors){if(m.endedGameSecond!==null&&m.endedGameSecond<=a.gameSecond)continue;const decision=at(m.decisionAtByLandmark[a.label],'landmark_decision');if(previousDecision!==null&&decision<=previousDecision)fail('landmark_decision_order');previousDecision=decision;}}
 const selections=[],summary=anchors.map(a=>({...a,totalMaps:maps.length,atRiskMaps:0,endedBeforeOrAt:0,selectedMaps:0,observedSelectedMaps:0,reconstructedSelectedMaps:0,syntheticSelectedMaps:0,missingMaps:0}));
 for(const m of maps)for(let i=0;i<anchors.length;i++){
  const a=anchors[i],sum=summary[i];if(m.endedGameSecond!==null&&m.endedGameSecond<=a.gameSecond){sum.endedBeforeOrAt++;selections.push({mapId:m.mapId,seriesId:m.seriesId,landmark:a.label,gameSecond:a.gameSecond,status:'ended_before_or_at_landmark',observationId:null});continue;}
  sum.atRiskMaps++;const decision=at(m.decisionAtByLandmark[a.label],'landmark_decision'),activeEpoch=m.activeSourceEpochByLandmark[a.label];if(!text(activeEpoch))fail('landmark_active_source_epoch');
  const available=byMap.get(m.mapId).filter(o=>o.available<=decision),latest=available.at(-1),epochConfirmed=latest?.sourceEpoch===activeEpoch;
  const permanentBarrier=available.some(o=>o.status==='terminal'||o.status==='stop'),identityBarrier=available.filter(o=>o.status==='identity_barrier'||o.status==='continuity_barrier').at(-1),identityRequalified=!identityBarrier||identityBarrier.sourceEpoch!==activeEpoch;
  const barrierSequence=available.reduce((last,o)=>o.barrier||o.status!=='eligible'?Math.max(last,o.sequence):last,-1);
  const candidates=available.filter(o=>o.sourceEpoch===activeEpoch&&o.gameSecond<=a.gameSecond&&o.sequence>barrierSequence).sort((x,y)=>y.gameSecond-x.gameSecond||y.sequence-x.sequence);
  let selected=null;if(epochConfirmed&&!permanentBarrier&&identityRequalified)for(const o of candidates)if(o.status==='eligible'&&a.gameSecond-o.gameSecond<=policy.maximumGameAgeSeconds&&o.source!==null&&decision-o.source<=BigInt(policy.maximumSourceStateAgeSeconds)*1000000000n){selected=o;break;}
  if(selected){sum.selectedMaps++;sum[selected.provenance==='observed_live'?'observedSelectedMaps':selected.provenance==='retrospective_reconstruction'?'reconstructedSelectedMaps':'syntheticSelectedMaps']++;selections.push({mapId:m.mapId,seriesId:m.seriesId,landmark:a.label,gameSecond:a.gameSecond,status:'selected',observationId:selected.observationId,selectedGameSecond:selected.gameSecond,sourceEpoch:selected.sourceEpoch,sequence:selected.sequence,provenance:selected.provenance});}
  else{sum.missingMaps++;selections.push({mapId:m.mapId,seriesId:m.seriesId,landmark:a.label,gameSecond:a.gameSecond,status:'ongoing_without_eligible_past_observation',observationId:null,sourceEpoch:activeEpoch,latestSlotStatus:latest?.status??'missing',barrierSequence:barrierSequence<0?null:barrierSequence,reason:!available.length?'no_past_available_slot':permanentBarrier?'source_terminal_or_stop_barrier':!epochConfirmed?'active_source_epoch_not_confirmed':!identityRequalified?'identity_or_continuity_epoch_not_requalified':!candidates.length&&barrierSequence>=0?'source_barrier_blocks_older_observations':candidates.some(o=>o.status==='eligible'&&o.source===null)?'source_state_age_unknown':'ineligible_or_outside_predeclared_age_bounds'});}
 }
 const body={contract:'aegis.fixed-minute-landmark-selection.v1',policy:structuredClone(policy),summary,selections,evidenceMeaning:'Deterministic selection from host-declared ordered eligibility/barrier/epoch metadata, not producer-equivalent authority. Observed and reconstructed coverage stay separate; repeated frames are not independent maps/series.',...disabled};return freeze({...body,contentHash:digest(body)});
}

export const FEATURE_PREPARATION_CONTRACT='aegis.feature-dataset-preparation.v1';
export const FEATURE_PREPARATION_LIMITS=Object.freeze({maxMetadataBytes:32*1024*1024,maxMetadataNodes:2000000,maxScalarCharacters:1024*1024,maxCombinedStateSeriesIds:1000000,maxRowStateBindings:1000000});
export const FEATURE_PREPARATION_MODES=freeze(TARGET_IDS.flatMap(targetId=>
 (targetId==='SERIES_LIVE'?['observed_postdraft','observed_live']:[targetId.startsWith('SERIES_')?targetId:targetId.split('_')[0]])
 .map(stateMode=>({targetId,stateMode,logicalTask:targetId,labelUnit:targetId.startsWith('SERIES_')?'whole_series':'selected_map',labelValueUnits:targetId.endsWith('_KILLS')?'kills':targetId.endsWith('_DURATION')?'seconds':'binary_team1_win',outputKind:targetId.endsWith('_KILLS')||targetId.endsWith('_DURATION')?'coherent_totals_distribution':'binary_probability'}))));
const isLiveMode=r=>r.stateMode==='LIVE'||r.stateMode==='observed_live';
const profileProvenance={retained_steam_observed:'observed_live',opendota_retrospective:'retrospective_reconstruction',synthetic:'synthetic'};
function preparationBudget(value){
 let total=0,nodes=0;const ancestors=new Set();
 const add=n=>{total+=n;if(total>FEATURE_PREPARATION_LIMITS.maxMetadataBytes)fail('preparation_metadata_bound');};
 function walk(v,depth){
  if(++nodes>FEATURE_PREPARATION_LIMITS.maxMetadataNodes||depth>32)fail('preparation_metadata_bound');
  if(v===null){add(4);return;}if(typeof v==='string'){if(v.length>FEATURE_PREPARATION_LIMITS.maxScalarCharacters)fail('preparation_metadata_bound');add(Buffer.byteLength(JSON.stringify(v)));return;}
  if(typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)){add(String(v).length);return;}
  if(typeof v!=='object'||isProxy(v)||ancestors.has(v))fail('preparation_plain_metadata');ancestors.add(v);
  if(Array.isArray(v)){const length=Object.getOwnPropertyDescriptor(v,'length').value;if(length>1000000)fail('preparation_metadata_bound');const keys=Reflect.ownKeys(v);if(keys.length!==length+1||keys.some(k=>k!=='length'&&(typeof k!=='string'||!/^\d+$/.test(k)||Number(k)>=length||String(Number(k))!==k)))fail('preparation_plain_metadata');add(2+Math.max(0,length-1));for(let i=0;i<length;i++){const field=Object.getOwnPropertyDescriptor(v,String(i));if(!field||!Object.hasOwn(field,'value'))fail('preparation_plain_metadata');walk(field.value,depth+1);}}
  else{if(![Object.prototype,null].includes(Object.getPrototypeOf(v)))fail('preparation_plain_metadata');const keys=Reflect.ownKeys(v);if(keys.length>64||keys.some(k=>typeof k!=='string'))fail('preparation_plain_metadata');add(2+Math.max(0,keys.length-1));for(const key of keys){const field=Object.getOwnPropertyDescriptor(v,key);if(!Object.hasOwn(field,'value'))fail('preparation_plain_metadata');add(Buffer.byteLength(JSON.stringify(key))+1);walk(field.value,depth+1);}}
  ancestors.delete(v);
 }
 walk(value,0);return total;
}

/** Derive, rather than guess, one role for the entire linked component. No
 * outcome-based boundary selection or fallback same-team/day series identity. */
export function assignChronologicalSeriesSplits({series=[],splits=[],createdAt}={}){
 bounded(series,100000,'preparation_series');if(!series.length||splits.length!==ROLES.length)fail('preparation_split_inventory');
 const created=at(createdAt,'created'),intervals=[];let previousEnd=null;
 for(let i=0;i<splits.length;i++){
  const s=splits[i],start=at(s?.startAt,'split_start'),end=at(s?.endAt,'split_end');
  if(s.role!==ROLES[i]||start>=end||previousEnd!==null&&start<previousEnd||end>created)fail('split_chronology');
  intervals.push({role:s.role,start,end});previousEnd=end;
 }
 const groups=new Map(),ids=new Set(),maps=new Set();
 for(const s of series){
  if(!obj(s)||!text(s.seriesId)||!text(s.componentId)||ids.has(s.seriesId)||!Array.isArray(s.mapIds)||!s.mapIds.length||s.mapIds.length>5)fail('series_identity');ids.add(s.seriesId);unique(s.mapIds,'series_maps');
  for(const id of s.mapIds){if(!text(id)||maps.has(id))fail('map_cross_series');maps.add(id);}
  const first=at(s.predictionStartAt,'series_prediction_start'),start=at(s.startAt,'series_start'),end=at(s.endAt,'series_end'),last=at(s.availableAt,'series_available');
  if(first>start||start>end||last<end||last>created)fail('series_times');
  const group=groups.get(s.componentId)??{first,last,series:[]};if(first<group.first)group.first=first;if(last>group.last)group.last=last;group.series.push(s);groups.set(s.componentId,group);
 }
 const assigned=[];
 for(const group of groups.values()){
  const role=intervals.find(s=>group.first>=s.start&&group.last<s.end)?.role??'purged';
  for(const s of group.series){if(s.splitRole!==undefined&&s.splitRole!==role)fail('declared_split_mismatch');assigned.push({...structuredClone(s),splitRole:role,...(role==='purged'?{purgeReason:'linked_component_crosses_frozen_split_or_label_availability'}:{})});}
 }
 // Input order is retained; roles depend only on frozen component horizons.
 const byId=new Map(assigned.map(s=>[s.seriesId,s]));return freeze(series.map(s=>byId.get(s.seriesId)));
}

/** Hash declared TRAIN/fold lineage, not model fitting or byte verification.
 * The returned three pins use the executable-definition binding grammar. */
export function createLearnedStateTrainingBinding({series=[],state,createdAt,dataset,rowProfiles=[],landmarkPolicy=null}={}){
 bounded(series,100000,'learned_series');
 const fields=['stateId','kind','version','profileId','projectionSha256','statePin','foldId','trainingSeriesIds','applicationSeriesIds','fitCutoffAt','fittedAt','availableAt'];
 if(!exact(state,fields)||!text(state.stateId)||!['aggregate','target_encoding','calibration','representation','child_prediction'].includes(state.kind)||!text(state.version)||!text(state.profileId)||!SHA.test(state.projectionSha256??'')||!text(state.foldId))fail('learned_state');
 pin(state.statePin,'learned_state');if(!exact(state.statePin,['id','sha256','bytes']))fail('learned_state_pin');
 bounded(state.trainingSeriesIds,100000,'learned_training_series');bounded(state.applicationSeriesIds,100000,'learned_application_series');if(!state.trainingSeriesIds.length||!state.applicationSeriesIds.length)fail('learned_cohort_empty');unique(state.trainingSeriesIds,'learned_training_series');unique(state.applicationSeriesIds,'learned_application_series');
 const byId=new Map(series.map(s=>[s.seriesId,s]));if(byId.size!==series.length)fail('series_identity');
 const cutoff=at(state.fitCutoffAt,'fit_cutoff'),fitted=at(state.fittedAt,'fitted'),available=at(state.availableAt,'state_available');if(cutoff>fitted||fitted>available||available>at(createdAt,'created'))fail('learned_state_times');
 const training=state.trainingSeriesIds.map(id=>{const s=byId.get(id);if(!s||s.splitRole!=='train'||at(s.availableAt,'training_label_available')>cutoff)fail('learned_state_train_only');return s;});
 const trainingIds=new Set(training.map(s=>s.seriesId)),components=new Set(training.map(s=>s.componentId));
 for(const id of state.applicationSeriesIds){const s=byId.get(id);if(!s||s.splitRole==='purged'||trainingIds.has(id)||components.has(s.componentId)||cutoff>=at(s.predictionStartAt,'application_prediction_start'))fail('learned_state_oof_or_future');}
 const cohort=training.map(s=>({seriesId:s.seriesId,componentId:s.componentId,mapIds:[...s.mapIds],predictionStartAt:s.predictionStartAt,endAt:s.endAt,availableAt:s.availableAt})).sort((a,b)=>a.seriesId.localeCompare(b.seriesId,'en'));
 if(!obj(dataset))fail('learned_dataset_lineage');bounded(dataset.rows,1000000,'learned_rows');bounded(dataset.sourcePins,4096,'learned_sources');bounded(dataset.labelTables,64,'learned_labels');bounded(rowProfiles,1000000,'learned_row_profiles');
 const profiles=new Map(rowProfiles.map(b=>[b.rowId,b.profileId]));
 const cohortRows=dataset.rows.filter(r=>trainingIds.has(r.seriesId)&&profiles.get(r.rowId)===state.profileId).map(r=>({rowId:r.rowId,seriesId:r.seriesId,mapId:r.mapId,targetId:r.targetId,stateMode:r.stateMode,sourcePinId:r.sourcePinId,inputSha256:r.inputSha256,labelTableId:r.labelTableId,labelRowId:r.labelRowId,decisionAt:r.decisionAt,historyCutoffAt:r.historyCutoffAt,historicalAvailability:r.historicalAvailability})).sort((a,b)=>a.rowId.localeCompare(b.rowId,'en'));
 if(!cohortRows.length||training.some(s=>!cohortRows.some(r=>r.seriesId===s.seriesId)))fail('learned_training_rows_missing');
 const sourceIds=new Set(cohortRows.map(r=>r.sourcePinId)),labelIds=new Set(cohortRows.map(r=>r.labelTableId)),sources=dataset.sourcePins.filter(p=>sourceIds.has(p.id)).sort((a,b)=>a.id.localeCompare(b.id,'en')),labels=dataset.labelTables.filter(p=>labelIds.has(p.id)).sort((a,b)=>a.id.localeCompare(b.id,'en'));
 if(sources.length!==sourceIds.size||labels.length!==labelIds.size||labels.some(p=>p.sha256===state.projectionSha256||p.sha256===state.statePin.sha256))fail('learned_training_pin_lineage');
 const trainingCohortSha256=digest({contract:'aegis.declared-train-cohort.v1',profileId:state.profileId,projectionSha256:state.projectionSha256,series:cohort,rows:cohortRows,sources,labels,policy:dataset.policy,landmarkPolicy});
 const foldSha256=digest({contract:'aegis.declared-forward-fold.v1',foldId:state.foldId,fitCutoffAt:state.fitCutoffAt,trainingCohortSha256,applicationSeriesIds:[...state.applicationSeriesIds].sort()});
 return freeze({learnedTransformStateSha256:state.statePin.sha256,foldSha256,trainingCohortSha256});
}

/** One authoritative metadata preparation route. No source/label bytes are
 * loaded, no estimator is invoked, and no JSON assertion admits training.
 * Full rich modes may be prepared separately under the same global split hash;
 * the existing total-column/row limits are retained, not multiplied by13. */
export function createFeaturePreparationPlan({dataset,profiles=[],rowProfiles=[],landmarks=null,learnedStates=[],rowStateBindings=[]}={}){
 const admittedMetadataBytes=preparationBudget({dataset,profiles,rowProfiles,landmarks,learnedStates,rowStateBindings});
 if(!obj(dataset))fail('preparation_dataset');
 const series=assignChronologicalSeriesSplits({series:dataset.series,splits:dataset.splits,createdAt:dataset.createdAt});
 const manifest=createPinnedDatasetManifest({...dataset,series});
 bounded(profiles,4096,'preparation_profiles');bounded(rowProfiles,manifest.rows.length,'row_profiles');bounded(learnedStates,4096,'learned_states');bounded(rowStateBindings,FEATURE_PREPARATION_LIMITS.maxRowStateBindings,'row_state_bindings');
 const sourceById=new Map(manifest.sourcePins.map(p=>[p.id,p])),profileById=new Map(),rowById=new Map(manifest.rows.map(r=>[r.rowId,r])),seriesById=new Map(series.map(s=>[s.seriesId,s]));
 const schemaPlans=new Map();for(const schema of manifest.featureSchemas){const columns=new Map(),groups=new Map();for(const column of schema.columns){columns.set(column.id,column);if(column.learnedStatePolicy==='TRAIN_fold_cohort_pinned'){const hash=digest(column.learnedStateBinding),ids=groups.get(hash)??[];ids.push(column.id);groups.set(hash,ids);}}schemaPlans.set(schema.schemaSha256,{columns,groups});}
 const profileSources=new Map();
 for(const p of profiles){
  if(!exact(p,['id','currentSource','historyBasis','sourcePinIds'])||!text(p.id)||profileById.has(p.id)||!Object.hasOwn(profileProvenance,p.currentSource)||!['retained_as_of','reconstruction_only','synthetic','not_applicable'].includes(p.historyBasis)||!Array.isArray(p.sourcePinIds)||!p.sourcePinIds.length||p.sourcePinIds.length>4096)fail('preparation_profile');unique(p.sourcePinIds,'profile_source_pins');
  for(const id of p.sourcePinIds)if(sourceById.get(id)?.provenance!==profileProvenance[p.currentSource])fail('profile_source_provenance');profileById.set(p.id,p);profileSources.set(p.id,new Set(p.sourcePinIds));
 }
 const profileByRow=new Map();
 for(const binding of rowProfiles){
  const r=rowById.get(binding?.rowId),p=profileById.get(binding?.profileId);
  if(!exact(binding,['rowId','profileId','observationId'])||!r||!p||profileByRow.has(r.rowId)||!profileSources.get(p.id).has(r.sourcePinId)||r.provenance!==profileProvenance[p.currentSource]||(r.historicalAvailability?.basis??'not_applicable')!==p.historyBasis)fail('row_profile_binding');
  if(isLiveMode(r)?!text(binding.observationId):binding.observationId!==null)fail('row_observation_binding');
  if((!r.targetId.startsWith('SERIES_')||r.targetId==='SERIES_LIVE')&&r.mapId===null)fail('preparation_current_map_required');profileByRow.set(r.rowId,binding);
 }
 if(profileByRow.size!==manifest.rows.length)fail('row_profile_missing');
 const selection=landmarks===null?null:selectFixedMinuteLandmarks(landmarks),observationById=new Map((landmarks?.observations??[]).map(o=>[o.observationId,o])),landmarkMaps=new Map((landmarks?.maps??[]).map(m=>[m.mapId,m]));
 if(manifest.rows.some(isLiveMode)&&selection===null)fail('live_landmarks_required');
 let stateSeriesIds=0;for(const state of learnedStates){if(!Array.isArray(state?.trainingSeriesIds)||!Array.isArray(state?.applicationSeriesIds))fail('learned_state');stateSeriesIds+=state.trainingSeriesIds.length+state.applicationSeriesIds.length;if(stateSeriesIds>FEATURE_PREPARATION_LIMITS.maxCombinedStateSeriesIds)fail('learned_cohort_total_bound');}
 const stateById=new Map(),stateByBinding=new Map(),stateBindings=[];
 for(const state of learnedStates){if(stateById.has(state?.stateId)||!profileById.has(state?.profileId))fail('learned_state_identity');const binding=createLearnedStateTrainingBinding({series,state,createdAt:manifest.createdAt,dataset:manifest,rowProfiles,landmarkPolicy:landmarks?.policy??null}),bindingHash=digest(binding);if(stateByBinding.has(bindingHash))fail('learned_state_binding_duplicate');const owner={state,binding,bindingHash,application:new Set(state.applicationSeriesIds)};stateById.set(state.stateId,owner);stateByBinding.set(bindingHash,owner);stateBindings.push({stateId:state.stateId,binding});}
 let requiredBindings=0;for(const r of manifest.rows)for(const [hash,ids]of schemaPlans.get(r.schemaSha256).groups){const owner=stateByBinding.get(hash);if(!owner)fail('row_learned_state_missing');requiredBindings+=owner.state.kind==='child_prediction'?ids.length:1;if(requiredBindings>1000000)fail('preparation_state_binding_bound');}
 const applied=new Map(),labelHashes=new Set(manifest.labelTables.map(l=>l.sha256));
 for(const b of rowStateBindings){
  if(!exact(b,['rowId','columnId','stateId','predictionPin','predictedAt']))fail('row_state_binding');const r=rowById.get(b.rowId),owner=stateById.get(b.stateId),plan=r&&schemaPlans.get(r.schemaSha256),column=b.columnId===null?null:plan?.columns.get(b.columnId),key=JSON.stringify([b.rowId,owner?.state.kind==='child_prediction'?'column':'state',owner?.state.kind==='child_prediction'?b.columnId:owner?.bindingHash]);
  if(!r||!owner||!plan.groups.has(owner.bindingHash)||applied.has(key)||owner.state.profileId!==profileByRow.get(r.rowId).profileId||!owner.application.has(r.seriesId)||at(owner.state.availableAt,'state_available')>at(r.materializedAt,'row_materialized')||labelHashes.has(owner.state.statePin.sha256))fail('row_state_lineage');
  if(owner.state.kind==='child_prediction'?!column||column.learnedStatePolicy!=='TRAIN_fold_cohort_pinned'||digest(column.learnedStateBinding)!==owner.bindingHash:b.columnId!==null)fail('row_state_column_scope');
  if(owner.state.kind==='child_prediction'){pin(b.predictionPin,'child_prediction');if(!exact(b.predictionPin,['id','sha256','bytes'])||labelHashes.has(b.predictionPin.sha256)||b.predictionPin.sha256===r.inputSha256||at(b.predictedAt,'child_predicted')<at(owner.state.availableAt,'state_available')||at(b.predictedAt,'child_predicted')>at(r.materializedAt,'row_materialized'))fail('child_prediction_lineage');}
  else if(b.predictionPin!==null||b.predictedAt!==null)fail('unexpected_child_prediction');applied.set(key,b);
 }
 for(const r of manifest.rows)for(const [hash,ids]of schemaPlans.get(r.schemaSha256).groups){const owner=stateByBinding.get(hash);if(owner.state.kind==='child_prediction'){for(const id of ids)if(!applied.has(JSON.stringify([r.rowId,'column',id])))fail('row_learned_state_missing');}else if(!applied.has(JSON.stringify([r.rowId,'state',hash])))fail('row_learned_state_missing');}
 const samples=[],excluded=[],sampleBound=dataset.limits?.maxRows??1000000,selectedByObservation=new Map();
 for(const s of selection?.selections??[])if(s.status==='selected'){const list=selectedByObservation.get(s.observationId)??[];list.push(s);selectedByObservation.set(s.observationId,list);}
 const liveKeys=new Set();
 for(const r of manifest.rows){
  const binding=profileByRow.get(r.rowId),s=seriesById.get(r.seriesId);
  if(s.splitRole==='purged'){excluded.push({rowId:r.rowId,reason:'series_component_purged'});continue;}
  const anchors=isLiveMode(r)?selectedByObservation.get(binding.observationId)??[]:[null];
  if(isLiveMode(r)){
   const o=observationById.get(binding.observationId),key=JSON.stringify([r.targetId,r.stateMode,binding.profileId,r.schemaSha256,binding.observationId]);
   if(!o||o.mapId!==r.mapId||o.seriesId!==r.seriesId||o.provenance!==r.provenance||at(o.availableAt,'observation_available')>at(r.decisionAt,'decision')||liveKeys.has(key))fail('row_live_observation_lineage');liveKeys.add(key);
  }
  let count=0;
  for(const anchor of anchors){if(anchor&&(anchor.mapId!==r.mapId||anchor.seriesId!==r.seriesId||at(r.decisionAt,'decision')>at(landmarkMaps.get(r.mapId).decisionAtByLandmark[anchor.landmark],'landmark_decision')))fail('row_landmark_lineage');
   if(samples.length>=sampleBound)fail('preparation_sample_bound');samples.push({sampleId:JSON.stringify([r.rowId,anchor?.landmark??null]),rowId:r.rowId,targetId:r.targetId,stateMode:r.stateMode,schemaSha256:r.schemaSha256,profileId:binding.profileId,role:s.splitRole,seriesId:r.seriesId,mapId:r.mapId,landmark:anchor?.landmark??null,weight:0});count++;
  }
  if(!count)excluded.push({rowId:r.rowId,reason:'not_selected_at_fixed_landmark'});
 }
 // Each exact projection/task/profile/role gives one unit per series, split
 // among maps and samples. Different schemas never silently share an estimator.
 const weightGroups=new Map();
 for(const sample of samples){const key=JSON.stringify([sample.targetId,sample.schemaSha256,sample.profileId,sample.role,sample.seriesId]),maps=weightGroups.get(key)??new Map(),map=JSON.stringify([sample.mapId]),rows=maps.get(map)??[];rows.push(sample);maps.set(map,rows);weightGroups.set(key,maps);}
 for(const maps of weightGroups.values())for(const rows of maps.values())for(const row of rows)row.weight=1/(maps.size*rows.length);
 const modes=FEATURE_PREPARATION_MODES.map(m=>({...m,schemaCount:manifest.featureSchemas.filter(s=>s.targetId===m.targetId&&s.stateMode===m.stateMode).length,sampleCount:samples.filter(s=>s.targetId===m.targetId&&s.stateMode===m.stateMode).length}));
 const splitInventoryHash=digest({splits:manifest.splits,series:manifest.series.map(s=>({seriesId:s.seriesId,componentId:s.componentId,mapIds:s.mapIds,predictionStartAt:s.predictionStartAt,endAt:s.endAt,availableAt:s.availableAt,splitRole:s.splitRole})).sort((a,b)=>a.seriesId.localeCompare(b.seriesId,'en'))});
 const body={contract:FEATURE_PREPARATION_CONTRACT,admittedMetadataBytes,metadataLimits:FEATURE_PREPARATION_LIMITS,datasetContentHash:manifest.contentHash,splitInventoryHash,manifest,modes,profiles:structuredClone(profiles),samples,excluded,landmarks:selection,learnedStates:structuredClone(learnedStates),stateBindings,rowStateBindings:structuredClone(rowStateBindings),weightPolicy:'equal_series_then_map_then_selected_sample_within_exact_projection_task_profile_role',independentUnit:'series_or_linked_component_never_frames',sourceAudit:manifest.rows.map(r=>({rowId:r.rowId,profileId:profileByRow.get(r.rowId).profileId,originalAvailability:r.originalAvailability,historicalAvailability:r.historicalAvailability,privateProofVerification:'required_not_performed',pinnedBytesVerified:false,originalPredictionTimingClaimed:false})),requiredGates:['feature_first_architecture_acceptance','explicit_training_lease','actual_pinned_byte_verification','actual_private_source_and_feature_proof_verification','label_timing_and_fold_artifact_verification'],runnerPolicy:{fits:0,modelScores:0,refresh:'reuse_pinned_sources_no_automatic_refresh',reference:'boosting_full_feature_set',projectionPolicy:'separate_exact_schema_pins_no_implicit_merge',liveVariants:['pooled_live','five_minute_specialists_plus_80+'],seriesVariants:['shared_context','staged_context'],supportedBestOf:[1,3,5],totals:'separate_PRE_POST_LIVE_coherent_kills_duration_distributions',holdout:'locked_before_experiments',uncertainty:'series_clustered',strengthDefinition:'pre_match_inputs_only_no_future_label_strength',winnerMetrics:['accuracy','logloss','Brier','calibration','coverage_by_minute_phase'],totalsMetrics:['MAE','pinball_distribution_score','interval_coverage_width','monotonic_CDF_push'],bookmakerLines:'actual_available_lines_separate_from_fixed_test_grid'},...disabled};
 return freeze({...body,contentHash:digest(body)});
}
