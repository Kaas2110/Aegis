/** Pure metadata verifier. No datasets, outcomes, native imports or execution. */
export const CONTRACT='aegis.whole-component-TRAIN-folds.v2';
export const EMBARGO_SECONDS=86400;
export const FAMILIES=Object.freeze(['prematch_map_winner','postdraft_map_winner','live_map_winner','prematch_kills_total','prematch_duration_total','live_kills_total','live_duration_total','series_winner']);
const NS=1000000000n;
const need=(ok,reason)=>{if(!ok)throw Error(reason);};
export function record(value,keys,reason='metadata_shape'){
 need(value!==null&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype,reason);
 const descriptors=Object.getOwnPropertyDescriptors(value);
 need(Reflect.ownKeys(descriptors).every(k=>typeof k==='string'&&keys.includes(k)),reason);
 need(Object.values(descriptors).every(d=>'value'in d&&d.enumerable),reason);
 return value;
}
function array(value,minimum,maximum,reason){
 need(Array.isArray(value)&&Object.getPrototypeOf(value)===Array.prototype&&value.length>=minimum&&value.length<=maximum,reason);
 const descriptors=Object.getOwnPropertyDescriptors(value);
 need(Reflect.ownKeys(descriptors).length===value.length+1&&Reflect.ownKeys(descriptors).every(k=>k==='length'||/^(0|[1-9][0-9]*)$/.test(k)&&Number(k)<value.length&&'value'in descriptors[k]),reason);
 return value;
}
const id=v=>typeof v==='string'&&v.length>0&&v.length<=256&&!/[\u0000-\u001f]/.test(v);
const digest=v=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
/** Aware ISO, exact nanoseconds; Date.parse would round the embargo boundary. */
export function instantNs(value){
 need(typeof value==='string','aware_timestamp_required');
 const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
 need(m!==null,'aware_timestamp_required');
 const [y,mo,d,h,mi,s]=m.slice(1,7).map(Number);
 need(y>=1&&mo>=1&&mo<=12&&d>=1&&d<=31&&h<=23&&mi<=59&&s<=59,'calendar_timestamp_invalid');
 const date=new Date(0);date.setUTCFullYear(y,mo-1,d);date.setUTCHours(h,mi,s,0);
 need(date.getUTCFullYear()===y&&date.getUTCMonth()===mo-1&&date.getUTCDate()===d,'calendar_timestamp_invalid');
 let offset=0;
 if(m[8]!=='Z'){
  const oh=Number(m[8].slice(1,3)),om=Number(m[8].slice(4,6));
  need(oh<=23&&om<=59,'timezone_offset_invalid');
  offset=(m[8][0]==='+'?1:-1)*(oh*60+om)*60;
 }
 return BigInt(date.getTime())*1000000n-BigInt(offset)*NS+BigInt((m[7]??'').padEnd(9,'0'));
}
const min=values=>values.reduce((a,b)=>a<b?a:b);
const max=values=>values.reduce((a,b)=>a>b?a:b);
function member(raw,asOf,family){
 record(raw,['mapId','seriesId','componentId','partition','startTime','predictionAt','endTime','labelAvailability']);
 need(id(raw.mapId)&&id(raw.seriesId)&&id(raw.componentId)&&raw.partition==='TRAIN','TRAIN_member_identity_required');
 const start=instantNs(raw.startTime),origin=instantNs(raw.predictionAt);
 const end=raw.endTime===null?null:instantNs(raw.endTime);
 need(start<=asOf&&origin<=asOf&&(end===null||end<=asOf),'member_after_scope_asof');
 need(end===null||end>=start,'member_end_before_start');
 let availability=null,kind='unknown';
 if(raw.labelAvailability!==null){
  const a=record(raw.labelAvailability,['at','kind','sourceRevisionKnownAt','basis','basisEndTime']);
  availability=instantNs(a.at);const known=instantNs(a.sourceRevisionKnownAt),basisEnd=instantNs(a.basisEndTime);kind=a.kind;
  need(end!==null&&basisEnd>=end&&basisEnd<=asOf&&known>=basisEnd&&known<=asOf&&availability<=asOf,'label_availability_metadata_invalid');
  need(family==='series_winner'?a.basis==='terminal_series_end':a.basis==='map_end'&&basisEnd===end,'family_label_availability_basis_required');
  if(kind==='historical_end_plus_300_reconstruction')need(availability===basisEnd+300n*NS,'reconstruction_end_plus_300_required');
  else if(kind==='recorded_label_receipt')need(availability>=basisEnd&&known>=availability,'recorded_label_receipt_invalid');
  else throw Error('explicit_label_availability_kind_required');
 }
 return {...raw,start,origin,end,availability,kind};
}
export function verifyComponentFolds(input){
 record(input,['contract','family','scope','componentMembers','mapRows','folds']);
 need(input.contract===CONTRACT&&FAMILIES.includes(input.family),'versioned_family_contract_required');
 const scope=record(input.scope,['scopeId','asOf','sourceManifestSha256','componentIdentityPolicySha256','protectionPolicySha256','membershipCompleteness']);
 need(id(scope.scopeId)&&digest(scope.sourceManifestSha256)&&digest(scope.componentIdentityPolicySha256)&&digest(scope.protectionPolicySha256)&&scope.membershipCompleteness==='complete_within_pinned_scope','pinned_scope_policies_required');
 const asOf=instantNs(scope.asOf),universe=new Map(),components=new Map(),series=new Map();
 for(const raw of array(input.componentMembers,1,100000,'bounded_component_members_required')){
  const r=member(raw,asOf,input.family);need(!universe.has(r.mapId),'duplicate_universe_map');
  need(!series.has(r.seriesId)||series.get(r.seriesId)===r.componentId,'series_component_identity_conflict');
  series.set(r.seriesId,r.componentId);universe.set(r.mapId,r);
  if(!components.has(r.componentId))components.set(r.componentId,[]);components.get(r.componentId).push(r);
 }
 const selected=new Map(),selectedComponents=new Map();
 for(const r of array(input.mapRows,1,100000,'bounded_family_map_rows_required')){
  record(r,['mapId','seriesId','componentId','partition','startTime','predictionAt','featureKnownAt']);
  const u=universe.get(r.mapId);need(u&&!selected.has(r.mapId),'selected_map_missing_or_duplicate');
  need(r.partition==='TRAIN'&&r.seriesId===u.seriesId&&r.componentId===u.componentId&&instantNs(r.startTime)===u.start,'selected_universe_identity_mismatch');
  const prediction=instantNs(r.predictionAt),known=instantNs(r.featureKnownAt);
  need(known<=prediction&&prediction>=u.origin&&prediction<=asOf,'family_feature_or_origin_asof_invalid');
  selected.set(r.mapId,r);if(!selectedComponents.has(r.componentId))selectedComponents.set(r.componentId,[]);selectedComponents.get(r.componentId).push(r.mapId);
 }
 const counts=[],validatedComponents=new Set();let priorValidationOrigin=null;
 for(const [index,f]of array(input.folds,4,4,'four_TRAIN_folds_required').entries()){
  record(f,['fold','trainMapIds','validationMapIds']);need(f.fold===index,'fold_order_required');
  const train=array(f.trainMapIds,1,100000,'nonempty_train_required'),validation=array(f.validationMapIds,1,100000,'nonempty_validation_required');
  const assigned=new Map(),trainComponents=new Set(),validationComponents=new Set();
  for(const [partition,ids,out]of [['train',train,trainComponents],['validation',validation,validationComponents]]){
   for(const mapId of ids){
    need(typeof mapId==='string'&&selected.has(mapId)&&!assigned.has(mapId),'fold_map_overlap_duplicate_or_unknown');
    assigned.set(mapId,partition);out.add(selected.get(mapId).componentId);
   }
  }
  need([...trainComponents].every(c=>!validationComponents.has(c)),'whole_component_crossed_fold');
  for(const [partition,ids]of [['train',trainComponents],['validation',validationComponents]])
   for(const c of ids)need(selectedComponents.get(c).every(m=>assigned.get(m)===partition),'selected_component_partially_assigned');
  need([...validationComponents].every(c=>!validatedComponents.has(c)),'validation_component_reused');
  const trainMembers=[...trainComponents].flatMap(c=>components.get(c)),validationMembers=[...validationComponents].flatMap(c=>components.get(c));
  need(trainMembers.every(r=>r.availability!==null),'training_component_label_availability_unknown');
  const latestLabel=max(trainMembers.map(r=>r.availability)),earliestOrigin=min(validationMembers.map(r=>r.origin));
  need(max(trainMembers.map(r=>r.start))<min(validationMembers.map(r=>r.start)),'whole_component_temporal_order');
  const gap=earliestOrigin-latestLabel;need(gap>=BigInt(EMBARGO_SECONDS)*NS,'whole_component_24h_embargo');
  need(priorValidationOrigin===null||earliestOrigin>priorValidationOrigin,'validation_origins_not_increasing');
  priorValidationOrigin=earliestOrigin;for(const c of validationComponents)validatedComponents.add(c);
  counts.push({fold:index,trainMaps:train.length,validationMaps:validation.length,trainComponents:trainComponents.size,validationComponents:validationComponents.size,trainUniverseMembers:trainMembers.length,validationUniverseMembers:validationMembers.length,gapNanoseconds:gap.toString(),labelAvailabilityKinds:[...new Set(trainMembers.map(r=>r.kind))].sort()});
 }
 return {contract:'aegis.whole-component-fold-verification.v2',status:'metadata_verified',family:input.family,scopeId:scope.scopeId,embargoSeconds:EMBARGO_SECONDS,componentUniverseMaps:universe.size,selectedFamilyMaps:selected.size,components:components.size,folds:counts,completenessClaim:'complete_within_pinned_scope; external source/protection/identity review still required',historicalReceiptTruthClaim:false,parityVerified:false,familyReadinessProduced:false,fitAuthorized:false,dispatchEnabled:false,publicPromotion:false,nativeFits:0};
}
