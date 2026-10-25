/** Frozen export/split metadata, not a data loader or fitting authority. The host
 * must verify pinned bytes and original source evidence separately. This module
 * refuses feature/label co-location, future inputs and split leakage; it cannot
 * prove that caller-supplied timestamps or column dispositions are truthful. */
import {digest,TARGET_IDS,projectionScopeRejection} from './registry-contract.mjs';

export const PINNED_DATASET_MANIFEST_CONTRACT='aegis.pinned-dataset-manifest.v1';
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
 let columnCount=0;
 for(const p of sourcePins){pin(p,'source');if(!exact(p,['id','sha256','bytes','provenance','availableAt'])||!PROVENANCE.includes(p.provenance))fail('source_provenance');if(at(p.availableAt,'source_available')>created)fail('future_source');if(sourceById.has(p.id))fail('source_duplicate');sourceById.set(p.id,p);allInputHashes.add(p.sha256);}
 for(const schema of featureSchemas){pin(schema,'schema');if(!exact(schema,['id','sha256','bytes','schemaSha256','targetId','stateMode','columns'])||!SHA.test(schema.schemaSha256??'')||!mode(schema.targetId,schema.stateMode)||!Array.isArray(schema.columns)||!schema.columns.length||schema.columns.length>150000||schemaByHash.has(schema.schemaSha256))fail('feature_schema');
  columnCount+=schema.columns.length;if(columnCount>300000)fail('total_columns_bound');
  if(schema.columns.some(c=>!obj(c)))fail('feature_column');unique(schema.columns.map(c=>c.id),'column');for(const c of schema.columns)if(Object.keys(c).some(k=>!['id','semanticRole','inputScopes','coordinate','units'].includes(k))||!text(c.id)||c.semanticRole!=='predictor'||projectionScopeRejection({inputScopes:c.inputScopes,allowedTargets:[schema.targetId],coordinate:c.coordinate,units:c.units},schema.targetId,schema.stateMode)!==null)fail('label_input_isolation_or_phase');
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
  const labelKey=r.labelTableId+'\0'+r.labelRowId,labelOwner=r.seriesId+'\0'+(r.targetId.startsWith('SERIES_')?'whole_series':r.mapId);if(labelOwners.has(labelKey)&&labelOwners.get(labelKey)!==labelOwner)fail('label_cross_target_identity');labelOwners.set(labelKey,labelOwner);
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
 const body={contract:PINNED_DATASET_MANIFEST_CONTRACT,datasetId,createdAt,sourcePins:structuredClone(sourcePins),featureSchemas:structuredClone(featureSchemas),labelTables:structuredClone(labelTables),splits:structuredClone(splits),series:structuredClone(series),assignments,rows:structuredClone(rows),policy:structuredClone(policy),liveLandmarks:{gameSeconds:[...FIXED_LIVE_LANDMARK_SECONDS],overflowStratum:'80+',selection:'last_eligible_at_or_before_landmark_and_available_by_decision',ageBounds:'must_be_predeclared_for_game_clock_and_source_state',atRiskDenominator:'all_ongoing_maps_including_missing_error_stale_slots',independentUnit:'series_or_linked_component_never_frames'},counts:{series:series.length,maps:mapOwners.size,rows:rows.length,provenance:provenanceCounts,historicalAvailability:historicalAvailabilityCounts,roles:roleCounts,inspectedHoldoutSeries:series.filter(s=>s.splitRole==='holdout'&&s.holdoutInspected).length},evidenceMeaning:'Pinned metadata and split/causal checks only. Observed current frames may still have reconstruction-only history. Retrospective rows are not observed-live or prospective source coverage. Pinned byte verification, source semantics and future training permission remain separate.',...disabled};
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
