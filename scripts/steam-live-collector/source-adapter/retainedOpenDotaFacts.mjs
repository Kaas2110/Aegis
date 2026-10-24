/** Pure history versions from exact retained collector bytes. No providers, DB,
 * clock, filesystem, training or inference. Integrity is local, not a signature
 * from the provider or proof that an old forecast was actually recorded. */
import {createHash} from 'node:crypto';
import {instantNs} from './causalTime.mjs';
import {PERFORMANCE_FIELDS,PERFORMANCE_CONTRACT} from './historicalPerformanceFields.mjs';

export const RETAINED_FACT_VERSION_CONTRACT='aegis.retained-opendota-fact-version.v1';
export const RETAINED_FACT_DERIVATION='opendota.retained-response.fields.v1';
export const RETAINED_FACT_VERSION_CONTRACT_V2='aegis.retained-opendota-fact-version.v2';
export const RETAINED_FACT_DERIVATION_V2='opendota.retained-response.fields.v2';
export const RETAINED_CLOCK_BLOCK_CONTRACT='aegis.retained-opendota-clock-block.v2';
export const RETAINED_FACT_MAX_BYTES=40*1024*1024;
const MAX_BODY=16*1024*1024,MAX_VERSIONS=20000,MAX_TOTAL=64*1024*1024;
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const sha=x=>createHash('sha256').update(x).digest('hex');
const id=x=>typeof x==='string'&&/^[1-9]\d{0,19}$/.test(x);
const numId=x=>Number.isSafeInteger(x)&&x>0;
const finite=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&x<=Number.MAX_SAFE_INTEGER;
const account=x=>numId(x)&&x<4294967295;
const hero=x=>numId(x)&&x<=250;
const fail=reason=>{throw Error('retained_opendota_facts:'+reason);};
const exact=(x,keys)=>obj(x)&&Object.keys(x).sort().join(',')===[...keys].sort().join(',');
const freeze=x=>{if(x&&typeof x==='object'){Object.freeze(x);for(const v of Object.values(x))freeze(v);}return x;};
function canonical(x){if(Array.isArray(x))return x.map(canonical);if(obj(x))return Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])]));return x;}
export function pinRetainedHistoryJson(data,path='retained-history/content.json'){
 const utf8=JSON.stringify(canonical(data));return{utf8,pin:{path,bytes:Buffer.byteLength(utf8),sha256:sha(utf8)}};
}
function pinned(input,maxBytes=MAX_BODY){
 if(!obj(input)||typeof input.utf8!=='string'||!obj(input.pin)||typeof input.pin.path!=='string'||input.pin.path.length<1||input.pin.path.length>4096||!hash(input.pin.sha256)||!Number.isSafeInteger(input.pin.bytes)||input.pin.bytes<1||input.pin.bytes>maxBytes)fail('input_pin');
 const bytes=Buffer.from(input.utf8);if(bytes.length!==input.pin.bytes||sha(bytes)!==input.pin.sha256)fail('input_bytes');
 let data;try{data=JSON.parse(input.utf8);}catch{fail('input_json');}if(!obj(data))fail('input_object');
 return{data,input:{utf8:input.utf8,pin:{path:'retained-history/sha256/'+input.pin.sha256+'.json',bytes:bytes.length,sha256:input.pin.sha256}}};
}
function time(value){const result=instantNs(value);if(result===null||result<=0n)fail('receipt_time');return result;}

/** selectedInput is the persisted selected envelope, not an invented receipt
 * around a bare payload. Full receipts bind the separately retained decoded body.
 * Old selected envelopes have no persistence timestamp; preserve that limitation. */
export function readRetainedOpenDotaResponse(inputs){
 let payload,source,sourceInputs;
 if(exact(inputs,['selectedInput'])){
  const selected=pinned(inputs.selectedInput),r=selected.data;
  if(r.schemaVersion!==1||r.source!=='opendota'||!numId(r.matchId)||r.endpoint!==`https://api.opendota.com/api/matches/${r.matchId}`||r.availabilityBasis!=='collector_response_receipt'||r.payloadKind!=='selected_match_detail_v1'||!obj(r.payload)||r.payload.match_id!==r.matchId||!hash(r.payloadSha256)||sha(JSON.stringify(r.payload))!==r.payloadSha256)fail('selected_receipt_contract');
  time(r.receivedAt);payload=r.payload;sourceInputs={selectedInput:selected.input};
  source={sourceProfile:'opendota.selected_match_detail_v1',matchId:String(r.matchId),receivedAt:r.receivedAt,payloadPersistedAt:null,receiptSha256:selected.input.pin.sha256,payloadSha256:r.payloadSha256,persistedBodySha256:selected.input.pin.sha256,payloadRepresentation:'selected_match_detail_v1',persistenceTimeKnown:false};
 }else if(exact(inputs,['receiptInput','payloadInput'])){
  const receipt=pinned(inputs.receiptInput,65536),body=pinned(inputs.payloadInput),r=receipt.data;
  if(r.contract!=='opendota_full_decoded_match_json.v1'||r.source!=='opendota'||r.sourceEndpoint!=='GET_matches_by_id'||!['refresh_match_details','ingest_parsed'].includes(r.job)||!numId(r.matchId)||r.evidenceCohort!=='post_match'||r.actualLive!==false||r.terminalStateIndependentlyVerified!==false||r.originalHistoricalAvailabilityProven!==false||r.payloadRepresentation!=='full_decoded_json_with_explicit_secret_redaction'||r.providerWireBytesRetained!==false||r.originalWireSha256!==null||r.requestTimeMeaning!=='bounded_get_operation_start_including_policy_waits_and_retries'||r.receiptTimeMeaning!=='collector_json_decode_completed'||!hash(r.payloadSha256)||r.payloadSha256!==body.input.pin.sha256||r.payloadBytes!==body.input.pin.bytes||r.payloadFile!==`payloads/${r.payloadSha256}.json.gz`||body.data.match_id!==r.matchId||!Number.isSafeInteger(r.redactedFields)||r.redactedFields<0||!Number.isSafeInteger(r.redactedUrlValues)||r.redactedUrlValues<0||!(r.selectedObservationFilename===null||typeof r.selectedObservationFilename==='string'&&new RegExp(`^${r.matchId}-[a-f0-9-]+\\.json\\.gz$`).test(r.selectedObservationFilename)))fail('full_receipt_contract');
  if(time(r.requestStartedAt)>time(r.receivedAt)||time(r.receivedAt)>time(r.payloadPersistedAt))fail('full_receipt_chronology');
  payload=body.data;sourceInputs={receiptInput:receipt.input,payloadInput:body.input};
  source={sourceProfile:'opendota.full_decoded_match_json.v1',matchId:String(r.matchId),receivedAt:r.receivedAt,payloadPersistedAt:r.payloadPersistedAt,receiptSha256:receipt.input.pin.sha256,payloadSha256:r.payloadSha256,persistedBodySha256:body.input.pin.sha256,payloadRepresentation:r.payloadRepresentation,persistenceTimeKnown:true};
 }else fail('source_inputs_contract');
 return freeze({sourceInputs,source:{...source,availabilityBasis:'retained_collector_response_receipt',trustScope:'local_collector_receipt_assertion',originalHistoricalAvailabilityProven:false,providerWireBytesRetained:false,terminalStateIndependentlyVerified:false,actualLive:false},payload});
}
const TOP={start_time:x=>Number.isSafeInteger(x)&&x>0,duration:x=>finite(x)&&x>0&&x<=86400,radiant_win:x=>typeof x==='boolean',radiant_score:x=>Number.isSafeInteger(x)&&x>=0,dire_score:x=>Number.isSafeInteger(x)&&x>=0,radiant_team_id:numId,dire_team_id:numId,patch:x=>Number.isSafeInteger(x)&&x>=0,leagueid:x=>Number.isSafeInteger(x)&&x>=0};
const slotSide=slot=>Number.isInteger(slot)&&slot>=0&&slot<=4?'radiant':Number.isInteger(slot)&&slot>=128&&slot<=132?'dire':null;
function derive(source,payload,{includeLegacyClock=true}={}){
 const fields=[],missing=[];
 const field=(path,value,valid,identity=null)=>{const status=value===null?'explicit_null':valid(value)?'observed':'invalid';fields.push({path,value:status==='observed'?structuredClone(value):null,status,knownAt:source.receivedAt,playerIdentity:identity});if(status!=='observed')missing.push({path,reason:status});};
 for(const [name,valid]of Object.entries(TOP))if(Object.hasOwn(payload,name))field('/'+name,payload[name],valid);else missing.push({path:'/'+name,reason:'absent'});
 if(Object.hasOwn(payload,'players')){
  if(!Array.isArray(payload.players)||payload.players.length>10)fail('roster_structure');
  const slots=new Set(),heroes=new Set(),accounts=new Set();
  for(const p of payload.players){
   if(!obj(p)||!slotSide(p.player_slot)||slots.has(p.player_slot))fail('roster_slot_conflict');slots.add(p.player_slot);
   if(hero(p.hero_id)){if(heroes.has(p.hero_id))fail('roster_hero_conflict');heroes.add(p.hero_id);}
   if(account(p.account_id)){if(accounts.has(p.account_id))fail('roster_account_conflict');accounts.add(p.account_id);}
   const identity={playerSlot:p.player_slot,side:slotSide(p.player_slot),heroId:hero(p.hero_id)?p.hero_id:null,accountId:account(p.account_id)?String(p.account_id):null};
   const prefix='/players/'+p.player_slot+'/';
   if(Object.hasOwn(p,'hero_id'))field(prefix+'hero_id',p.hero_id,hero,identity);
   if(Object.hasOwn(p,'account_id'))field(prefix+'account_id',p.account_id,account,identity);
   if(!identity.heroId)continue;
   for(const name of new Set([...Object.values(PERFORMANCE_FIELDS),'lane_role','is_roaming']))if(Object.hasOwn(p,name))field(prefix+name,p[name],name==='is_roaming'?x=>typeof x==='boolean':finite,identity);
   // Time series are one indivisible response clock. Never fill new values using
   // an old times axis, nor manufacture minute values from final statistics.
   if(includeLegacyClock&&Array.isArray(p.times)&&p.times.length>0&&p.times.length<=20000&&p.times.every((x,i)=>Number.isSafeInteger(x)&&(i===0||x>p.times[i-1]))){
    const series={times:p.times};for(const key of ['networth_t','gold_t','xp_t','lh_t','dn_t'])if(Array.isArray(p[key])&&p[key].length===p.times.length&&p[key].every(finite))series[key]=p[key];
    field(prefix+'clock_series',series,()=>true,identity);
   }
  }
 }
 return{fields:fields.sort((a,b)=>a.path.localeCompare(b.path,'en')),missing};
}
export function deriveHistoricalFactVersion(sourceInputs){
 const checked=readRetainedOpenDotaResponse(sourceInputs),derived=derive(checked.source,checked.payload);
 const version={contract:RETAINED_FACT_VERSION_CONTRACT,derivationVersion:RETAINED_FACT_DERIVATION,source:checked.source,sourceInputs:checked.sourceInputs,...derived,eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false};
 const versionInput=pinRetainedHistoryJson(version,'retained-history/fact-version.json');if(versionInput.pin.bytes>RETAINED_FACT_MAX_BYTES)fail('version_bytes_bound');
 return freeze({versionInput,versionSha256:versionInput.pin.sha256,version});
}
export function verifyHistoricalFactVersion(versionInput){
 const candidate=pinned(versionInput,RETAINED_FACT_MAX_BYTES),rebuilt=candidate.data.contract===RETAINED_FACT_VERSION_CONTRACT_V2?deriveHistoricalFactVersionV2(candidate.data.sourceInputs):deriveHistoricalFactVersion(candidate.data.sourceInputs);
 if(rebuilt.versionInput.utf8!==versionInput.utf8||rebuilt.versionSha256!==versionInput.pin.sha256)fail('version_not_rederived_from_source');
 return rebuilt;
}

/** V1 byte rederivation remains unchanged. V2 treats the time axis and its
 * metrics as one response block, including explicit empty/null/invalid updates.
 * This is retained historical evidence, not admission as a live observation. */
export function deriveHistoricalFactVersionV2(sourceInputs){
 const checked=readRetainedOpenDotaResponse(sourceInputs),base=derive(checked.source,checked.payload,{includeLegacyClock:false}),keys=['networth_t','gold_t','xp_t','lh_t','dn_t'];
 const fields=base.fields.filter(f=>!f.path.endsWith('/clock_series')),missing=base.missing.filter(f=>!f.path.endsWith('/clock_series'));
 for(const p of checked.payload.players??[]){
  if(!['times',...keys].some(k=>Object.hasOwn(p,k)))continue;
  const playerIdentity={playerSlot:p.player_slot,side:slotSide(p.player_slot),heroId:hero(p.hero_id)?p.hero_id:null,accountId:account(p.account_id)?String(p.account_id):null},path='/players/'+p.player_slot+'/clock_series';
  const validTimes=Array.isArray(p.times)&&p.times.length<=20000&&p.times.every((x,i)=>Number.isSafeInteger(x)&&(i===0||x>p.times[i-1]));
  const status=Object.hasOwn(p,'times')&&p.times===null?'explicit_null':validTimes?'observed':'invalid';
  let value=null;
  if(status==='observed'){
   const metrics={};
   for(const key of keys){
    const v=p[key],s=!Object.hasOwn(p,key)?'absent':v===null?'explicit_null':Array.isArray(v)&&v.length===p.times.length&&v.every(finite)?'observed':'invalid';
    metrics[key]={status:s,values:s==='observed'?structuredClone(v):null};
   }
   value={contract:RETAINED_CLOCK_BLOCK_CONTRACT,times:structuredClone(p.times),metrics};
  }else missing.push({path,reason:status});
  fields.push({path,value,status,knownAt:checked.source.receivedAt,playerIdentity});
 }
 fields.sort((a,b)=>a.path.localeCompare(b.path,'en'));
 const version={contract:RETAINED_FACT_VERSION_CONTRACT_V2,derivationVersion:RETAINED_FACT_DERIVATION_V2,source:checked.source,sourceInputs:checked.sourceInputs,fields,missing,eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false};
 const versionInput=pinRetainedHistoryJson(version,'retained-history/fact-version-v2.json');if(versionInput.pin.bytes>RETAINED_FACT_MAX_BYTES)fail('version_bytes_bound');
 return freeze({versionInput,versionSha256:versionInput.pin.sha256,version});
}

/** Explicit v2-only view: all retained responses must be rederived using the v2
 * contract so a later v1 omitted-null cannot hide a correction. Target-independent
 * storage keeps every version; this selector resolves only one declared cutoff. */
export function selectHistoricalClockSeriesV2(options={}){
 if(!Array.isArray(options.versionInputs)||options.versionInputs.length>MAX_VERSIONS)fail('clock_v2_versions_required');
 let bytes=0;
 for(const input of options.versionInputs){if(!Number.isSafeInteger(input?.pin?.bytes)||(bytes+=input.pin.bytes)>MAX_TOTAL)fail('selection_bytes_bound');const x=pinned(input,RETAINED_FACT_MAX_BYTES).data;if(x.contract!==RETAINED_FACT_VERSION_CONTRACT_V2)fail('clock_v2_requires_v2_versions');}
 const selected=selectHistoricalFactVersions(options),fields=new Map(selected.fields.map(f=>[f.matchId+':'+f.path,f])),barriers=new Map(selected.identityBarriers.map(b=>[b.matchId+':'+b.playerSlot,b])),blocks=[],rejected=[];
 for(const f of selected.fields.filter(f=>f.path.endsWith('/clock_series'))){
  const slot=f.playerIdentity?.playerSlot,prefix='/players/'+slot+'/',h=fields.get(f.matchId+':'+prefix+'hero_id'),a=fields.get(f.matchId+':'+prefix+'account_id'),barrier=barriers.get(f.matchId+':'+slot)??{};
  const reason=f.status!=='observed'?'clock_block_'+f.status:f.value?.contract!==RETAINED_CLOCK_BLOCK_CONTRACT?'clock_block_contract':h?.status!=='observed'||f.playerIdentity?.heroId!==h.value||barrier.heroBarrierAt&&time(f.knownAt)<=time(barrier.heroBarrierAt)?'clock_block_hero_epoch_unavailable':null;
  if(reason){rejected.push({matchId:f.matchId,playerSlot:slot,knownAt:f.knownAt,reason,versionSha256:f.versionSha256});continue;}
  const currentAccount=a?.status==='observed'&&a.playerIdentity?.heroId===h.value&&(!barrier.heroBarrierAt||time(a.knownAt)>time(barrier.heroBarrierAt))?String(a.value):null;
  const accountEligible=currentAccount!==null&&f.playerIdentity.accountId===currentAccount&&(!barrier.accountBarrierAt||time(f.knownAt)>time(barrier.accountBarrierAt));
  blocks.push({matchId:f.matchId,playerSlot:slot,side:f.playerIdentity.side,heroId:h.value,accountId:accountEligible?currentAccount:null,heroHistoryEligible:true,playerHistoryEligible:accountEligible,knownAt:f.knownAt,versionSha256:f.versionSha256,block:structuredClone(f.value)});
 }
 return freeze({contract:'aegis.selected-retained-clock-blocks.v2',targetMapId:selected.targetMapId,historyCutoffAt:selected.historyCutoffAt,blocks,rejected,sourceVersions:selected.sourceVersions,sourceVersionSetSha256:selected.sourceVersionSetSha256,eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false});
}

/** Selection is order independent. A conflict at the exact same receipt instant
 * is unavailable rather than resolved by file order or lexical hash. Missing
 * fields do not erase an earlier observed version; explicit nulls do. */
export function selectHistoricalFactVersions({versionInputs,targetMapId,historyCutoffAt}={}){
 const cutoff=time(historyCutoffAt);if(!id(targetMapId)||!Array.isArray(versionInputs)||versionInputs.length>MAX_VERSIONS)fail('selection_contract');
 let bytes=0;const versions=new Map(),selected=new Map(),audit={providedVersions:versionInputs.length,uniqueVersions:0,currentMapExcluded:0,futureVersionsExcluded:0,conflictingFields:0};
 for(const input of versionInputs){if(!Number.isSafeInteger(input?.pin?.bytes)||(bytes+=input.pin.bytes)>MAX_TOTAL)fail('selection_bytes_bound');const checked=verifyHistoricalFactVersion(input);versions.set(checked.versionSha256,checked.version);}
 const rosterEvidence=new Map(),fieldCandidates=new Map();
 for(const [versionSha256,v]of versions){audit.uniqueVersions++;
  if(v.source.matchId===targetMapId){audit.currentMapExcluded++;continue;}if(time(v.source.receivedAt)>cutoff){audit.futureVersionsExcluded++;continue;}
  for(const f of v.fields){const key=v.source.matchId+':'+f.path,old=selected.get(key),at=time(f.knownAt);
   const candidates=fieldCandidates.get(key);if(!candidates||at>candidates.at)fieldCandidates.set(key,{at,versions:new Set([versionSha256])});else if(at===candidates.at)candidates.versions.add(versionSha256);
   if(/^\/players\/\d+\/(hero_id|account_id)$/.test(f.path)){if(!rosterEvidence.has(key))rosterEvidence.set(key,[]);rosterEvidence.get(key).push({...f,versionSha256});}
   if(!old||at>time(old.knownAt))selected.set(key,{...structuredClone(f),matchId:v.source.matchId,versionSha256,source:structuredClone(v.source),conflict:false});else if(at===time(old.knownAt)){
    const same=JSON.stringify(canonical({value:f.value,status:f.status,playerIdentity:f.playerIdentity}))===JSON.stringify(canonical({value:old.value,status:old.status,playerIdentity:old.playerIdentity}));
    const conflict=old.conflict||!same;
    if(versionSha256<old.versionSha256)selected.set(key,{...structuredClone(f),matchId:v.source.matchId,versionSha256,source:structuredClone(v.source),conflict});else old.conflict=conflict;
   }
  }
 }
 const fields=[...selected.values()].sort((a,b)=>a.matchId.localeCompare(b.matchId,'en')||a.path.localeCompare(b.path,'en'));
 const identityBarriers=[],barrierVersions=new Set();
 for(const f of fields)if(f.conflict){f.value=null;f.status='conflicting_receipt';audit.conflictingFields++;for(const v of fieldCandidates.get(f.matchId+':'+f.path).versions)barrierVersions.add(v);}
 for(const h of fields.filter(f=>/^\/players\/\d+\/hero_id$/.test(f.path)&&f.status==='observed')){
  const prefix=h.path.slice(0,-'hero_id'.length),key=h.matchId+':'+prefix,a=selected.get(key+'account_id');
  const heroConflicts=(rosterEvidence.get(key+'hero_id')??[]).filter(f=>f.status!=='observed'||f.value!==h.value);
  const heroBarrierAt=latest(heroConflicts.map(f=>f.knownAt));
  const accountId=a?.status==='observed'&&a.playerIdentity?.heroId===h.value&&(!heroBarrierAt||time(a.knownAt)>time(heroBarrierAt))?String(a.value):null;
  const accountConflicts=(rosterEvidence.get(key+'account_id')??[]).filter(f=>f.playerIdentity?.heroId===h.value&&(f.status==='observed'?String(f.value):null)!==accountId);
  const accountBarrierAt=latest(accountConflicts.map(f=>f.knownAt));
  for(const f of [...heroConflicts,...accountConflicts])if(heroBarrierAt&&time(f.knownAt)===time(heroBarrierAt)||accountBarrierAt&&time(f.knownAt)===time(accountBarrierAt))barrierVersions.add(f.versionSha256);
  identityBarriers.push({matchId:h.matchId,playerSlot:h.playerIdentity.playerSlot,heroBarrierAt,accountBarrierAt,accountId});
 }
 // Bind selected dependencies, not irrelevant future appends or caller order.
 const sourceVersions=[...new Map([...fields.filter(f=>!f.conflict).map(f=>[f.versionSha256,{versionSha256:f.versionSha256,source:f.source}]),...[...barrierVersions].map(versionSha256=>[versionSha256,{versionSha256,source:versions.get(versionSha256).source}])]).values()].sort((a,b)=>a.versionSha256.localeCompare(b.versionSha256,'en'));
 const sourceVersionSetSha256=pinRetainedHistoryJson(sourceVersions).pin.sha256;
 return{contract:'aegis.selected-retained-history-fields.v1',targetMapId,historyCutoffAt,fields,identityBarriers,sourceVersions,sourceVersionSetSha256,audit,eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false};
}
function latest(values){return values.reduce((a,b)=>!a||time(b)>time(a)||time(b)===time(a)&&b<a?b:a,null);}
/** Adapter to the existing pure producer's prior-map fact shape. The supplied
 * corpus is never labelled a complete SQL, pro or global-meta population. */
export function exportHistoricalFactsFromVersions({versionInputs,targetMapId,historyCutoffAt,scope=null}={}){
 if(scope!==null&&(!exact(scope,['population'])||typeof scope.population!=='string'||!/^[a-zA-Z0-9_.-]{1,96}$/.test(scope.population)))fail('scope_contract');
 const selected=selectHistoricalFactVersions({versionInputs,targetMapId,historyCutoffAt}),byMap=new Map(),barriersBySlot=new Map(),barriersByMap=new Map();
 for(const b of selected.identityBarriers){barriersBySlot.set(b.matchId+':'+b.playerSlot,b);if(!barriersByMap.has(b.matchId))barriersByMap.set(b.matchId,[]);barriersByMap.get(b.matchId).push(b);}
 for(const f of selected.fields){if(!byMap.has(f.matchId))byMap.set(f.matchId,new Map());byMap.get(f.matchId).set(f.path,f);}
 const maps=[],omitted=[];
 for(const [matchId,fields]of byMap){
  const get=path=>{const f=fields.get(path);return f?.status==='observed'?f:null;};
  const start=get('/start_time'),duration=get('/duration'),outcome=get('/radiant_win');
  if(!start||!duration||!outcome){omitted.push({matchId,reason:'completed_prior_map_inputs_unavailable'});continue;}
  const endSeconds=start.value+duration.value;if(!Number.isSafeInteger(endSeconds)||endSeconds*1000>8640000000000000){omitted.push({matchId,reason:'invalid_event_end'});continue;}
  const endedAt=new Date(endSeconds*1000).toISOString(),completionInputsKnownAt=latest([start.knownAt,duration.knownAt,outcome.knownAt]);
  if(time(endedAt)>time(completionInputsKnownAt)){omitted.push({matchId,reason:'event_end_after_actual_receipt'});continue;}
  // Compatibility algebra treats kills/team IDs as map-level dependencies. Use
  // a conservative combined gate while exposing the actual outcome receipt too.
  const outcomeKnownAt=latest([completionInputsKnownAt,...['radiant_score','dire_score','radiant_team_id','dire_team_id'].map(k=>get('/'+k)?.knownAt).filter(Boolean)]);
  const heroes=[],players=[],heroPerformances=[],rosterTimes=[],heroTimes=[];
  for(const slot of [0,1,2,3,4,128,129,130,131,132]){
   const prefix='/players/'+slot+'/',h=get(prefix+'hero_id');if(!h)continue;const side=slotSide(slot),a=get(prefix+'account_id');
   heroes.push({heroId:h.value,side});heroTimes.push(h.knownAt);
   const barrier=barriersBySlot.get(matchId+':'+slot);
   const usableAccount=a&&a.playerIdentity?.heroId===h.value&&(!barrier.heroBarrierAt||time(a.knownAt)>time(barrier.heroBarrierAt))?a:null,accountId=usableAccount?String(usableAccount.value):null;
   if(accountId){players.push({accountId,heroId:h.value,side});rosterTimes.push(h.knownAt,usableAccount.knownAt);}
   const metrics={},metricAvailability={},metricSources={};let any=false;
   for(const [name,sourceField]of Object.entries(PERFORMANCE_FIELDS)){
    const f=get(prefix+sourceField),same=f?.playerIdentity?.heroId===h.value&&f.playerIdentity.accountId===accountId&&(!barrier.heroBarrierAt||time(f.knownAt)>time(barrier.heroBarrierAt))&&(!barrier.accountBarrierAt||time(f.knownAt)>time(barrier.accountBarrierAt));
    metrics[name]=same?f.value:null;if(same){any=true;metricAvailability[name]=latest([outcomeKnownAt,h.knownAt,...(usableAccount?[usableAccount.knownAt]:[]),f.knownAt]);metricSources[name]=f.versionSha256;}
   }
   if(any)heroPerformances.push({contract:PERFORMANCE_CONTRACT,accountId,heroId:h.value,side,knownAt:latest(Object.values(metricAvailability)),metrics,metricAvailability,metricSources,invalidFields:[],sourceProfile:'opendota.completed-map.retained-response-player',sourceFields:PERFORMANCE_FIELDS,availabilityBasis:'retained_collector_response_receipt'});
  }
  if(new Set(heroes.map(h=>h.heroId)).size!==heroes.length||new Set(players.map(p=>p.accountId)).size!==players.length){omitted.push({matchId,reason:'mixed_roster_identity_conflict'});continue;}
  const team=s=>get('/'+s+'_team_id')?.value??null,radiantTeamId=team('radiant'),direTeamId=team('dire');
  if(radiantTeamId!==null&&radiantTeamId===direTeamId){omitted.push({matchId,reason:'team_identity_conflict'});continue;}
  // The compatibility consumer combines result with roster, so its public gate
  // is the maximum dependency time. Original field times remain separately bound.
  maps.push({matchId,endedAt,outcomeKnownAt,outcomeObservedAt:outcome.knownAt,completionInputsKnownAt,durationKnownAt:duration.knownAt,playersKnownAt:latest([outcomeKnownAt,...rosterTimes]),heroesKnownAt:latest([outcomeKnownAt,...heroTimes]),radiantTeamId:radiantTeamId===null?null:String(radiantTeamId),direTeamId:direTeamId===null?null:String(direTeamId),durationSeconds:duration.value,radiantWon:outcome.value,radiantKills:get('/radiant_score')?.value??null,direKills:get('/dire_score')?.value??null,players,heroes,heroPerformances,identityContinuity:barriersByMap.get(matchId)??[],fieldAvailability:Object.fromEntries([...fields].map(([path,f])=>[path,{knownAt:f.knownAt,status:f.status,versionSha256:f.versionSha256}])),availabilityBasis:'retained_collector_response_receipt',originalHistoricalAvailabilityProven:false,sourceVersionSetSha256:selected.sourceVersionSetSha256,evidenceRef:'sha256:'+selected.sourceVersionSetSha256+'#match/'+matchId});
 }
 maps.sort((a,b)=>a.matchId.localeCompare(b.matchId,'en'));
 const populationScope={contract:'aegis.retained-history-selection-scope.v1',sourceUniverse:'locally_retained_opendota_responses',population:scope?.population??'provided_retained_responses_only',selection:'provided_version_inputs_only',asOf:historyCutoffAt,completeWithinProvidedInputs:true,globalPopulationComplete:false,truncated:false,rowCount:maps.length};
 const factsInput=pinRetainedHistoryJson({contract:'aegis.prior-map-facts.v1',scope:populationScope,maps},'retained-history/prior-map-facts.json');
 return{contract:'aegis.retained-history-facts-export.v1',factsInput,audit:{...selected.audit,exportedMaps:maps.length,omittedMaps:omitted,availabilityBasis:'retained_collector_response_receipt',originalHistoricalAvailabilityProven:false,independentFieldAvailabilityAttested:false,sourceSelectionCompleteOnlyWithinProvidedInputs:true},bindings:{sourceVersionSetSha256:selected.sourceVersionSetSha256,sourceVersions:selected.sourceVersions},eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false};
}
