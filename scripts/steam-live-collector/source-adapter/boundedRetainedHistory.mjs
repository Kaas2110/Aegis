/** Exact retained-history field resolution, one map chain at a time. The
 * reference corpus owns grouping and original byte intake; this reducer still
 * rederives every supplied original version. It does not turn hashes or a
 * retained-response population into provider authentication or serving consent.
 * V1 serialization is lexical by map id; arithmetic consumers sort numerically.
 */
import {instantNs} from './causalTime.mjs';
import {verifyHistoricalFactVersion,pinRetainedHistoryJson} from './retainedOpenDotaFacts.mjs';
import {PERFORMANCE_FIELDS,PERFORMANCE_CONTRACT} from './historicalPerformanceFields.mjs';
import {measureBoundedJsonBytes} from './diagnosticResourceArena.mjs';

export const BOUNDED_RETAINED_REDUCER_CONTRACT='aegis.bounded-retained-map-reducer.v2';
export const BOUNDED_RETAINED_REDUCER_LIMITS=Object.freeze({maxVersions:20000,maxVersionBytes:40*1024*1024,maxTotalVersionBytes:128*1024*1024,maxSelectedFieldBytes:40*1024*1024,maxFields:512,maxIdentityEntries:400000});
const flags=Object.freeze({eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false});
const fail=reason=>{throw Error('bounded_retained_history:'+reason);};
const id=x=>typeof x==='string'&&/^[1-9]\d{0,19}$/.test(x);
const time=x=>{const n=instantNs(x);if(n===null||n<=0n)fail('time');return n;};
const latest=values=>values.reduce((a,b)=>!a||time(b)>time(a)||time(b)===time(a)&&b<a?b:a,null);
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const canonical=x=>Array.isArray(x)?x.map(canonical):x!==null&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const equalField=(a,b)=>JSON.stringify(canonical({value:a.value,status:a.status,playerIdentity:a.playerIdentity}))===JSON.stringify(canonical({value:b.value,status:b.status,playerIdentity:b.playerIdentity}));
export const numericHistoryMapIdCompare=(a,b)=>a.length-b.length||a.localeCompare(b,'en');

/** No dense all-version array is created. Latest fields, identity transitions
 * and equal-receipt conflict witnesses are retained within fixed bounds. The
 * aggregate original-byte cap is the v2 corpus cap; the v1 64 MiB cap is intact.
 * Identity evidence includes null/invalid/conflicting transitions, including
 * A -> B -> A, so an old player metric cannot be resurrected in a new epoch.
 */
export async function reduceRetainedMapVersions({versionInputs,matchId,targetMapId,historyCutoffAt,shouldContinue=()=>true}={}){
 if(!id(matchId)||!id(targetMapId)||!versionInputs||typeof versionInputs[Symbol.iterator]!=='function'&&typeof versionInputs[Symbol.asyncIterator]!=='function'||typeof shouldContinue!=='function')fail('input');
 const cutoff=time(historyCutoffAt),selected=new Map(),sources=new Map(),seen=new Set(),identityEvidence=new Map(),candidateHashes=new Map();
 const audit={providedVersions:0,uniqueVersions:0,currentMapExcluded:0,futureVersionsExcluded:0,conflictingFields:0};
 let bytes=0,fieldBytes=0,identityEntries=0;
 for await(const input of versionInputs){
  if(await shouldContinue()!==true)fail('stopped');
  if(++audit.providedVersions>BOUNDED_RETAINED_REDUCER_LIMITS.maxVersions||!Number.isSafeInteger(input?.pin?.bytes)||input.pin.bytes<1||input.pin.bytes>BOUNDED_RETAINED_REDUCER_LIMITS.maxVersionBytes||(bytes+=input.pin.bytes)>BOUNDED_RETAINED_REDUCER_LIMITS.maxTotalVersionBytes)fail('version_bound');
  const checked=verifyHistoricalFactVersion(input),v=checked.version,versionSha256=checked.versionSha256;
  if(v.source.matchId!==matchId)fail('mixed_map_chain');
  if(seen.has(versionSha256))continue;seen.add(versionSha256);audit.uniqueVersions++;sources.set(versionSha256,v.source);
  if(matchId===targetMapId){audit.currentMapExcluded++;continue;}
  if(time(v.source.receivedAt)>cutoff){audit.futureVersionsExcluded++;continue;}
  for(const f of v.fields){
   const key=f.path,at=time(f.knownAt),old=selected.get(key),prior=candidateHashes.get(key);
   if(!prior||at>prior.at)candidateHashes.set(key,{at,versions:new Set([versionSha256])});else if(at===prior.at)prior.versions.add(versionSha256);
   if(/^\/players\/\d+\/(hero_id|account_id)$/.test(key)){
    if(++identityEntries>BOUNDED_RETAINED_REDUCER_LIMITS.maxIdentityEntries)fail('identity_bound');
    if(!identityEvidence.has(key))identityEvidence.set(key,[]);
    identityEvidence.get(key).push({value:f.value,status:f.status,knownAt:f.knownAt,playerIdentity:f.playerIdentity,versionSha256});
   }
   if(!old||at>time(old.field.knownAt)||at===time(old.field.knownAt)&&versionSha256<old.field.versionSha256){
    const n=measureBoundedJsonBytes(f,{maxBytes:BOUNDED_RETAINED_REDUCER_LIMITS.maxSelectedFieldBytes});
    if(fieldBytes-(old?.bytes??0)+n>BOUNDED_RETAINED_REDUCER_LIMITS.maxSelectedFieldBytes||!old&&selected.size>=BOUNDED_RETAINED_REDUCER_LIMITS.maxFields)fail('selected_fields_bound');
    const conflict=old&&at===time(old.field.knownAt)?old.field.conflict||!equalField(f,old.field):false;
    fieldBytes+=n-(old?.bytes??0);selected.set(key,{bytes:n,field:{...f,matchId,versionSha256,source:v.source,conflict}});
   }else if(at===time(old.field.knownAt))old.field.conflict=old.field.conflict||!equalField(f,old.field);
  }
 }
 if(await shouldContinue()!==true)fail('stopped');
 const fields=[...selected.values()].map(x=>x.field).sort((a,b)=>a.path.localeCompare(b.path,'en')),identityBarriers=[],barrierVersions=new Set();
 for(const f of fields)if(f.conflict){f.value=null;f.status='conflicting_receipt';audit.conflictingFields++;for(const h of candidateHashes.get(f.path).versions)barrierVersions.add(h);}
 for(const h of fields.filter(f=>/^\/players\/\d+\/hero_id$/.test(f.path)&&f.status==='observed')){
  const prefix=h.path.slice(0,-'hero_id'.length),a=selected.get(prefix+'account_id')?.field;
  const heroConflicts=(identityEvidence.get(prefix+'hero_id')??[]).filter(f=>f.status!=='observed'||f.value!==h.value),heroBarrierAt=latest(heroConflicts.map(f=>f.knownAt));
  const accountId=a?.status==='observed'&&a.playerIdentity?.heroId===h.value&&(!heroBarrierAt||time(a.knownAt)>time(heroBarrierAt))?String(a.value):null;
  const accountConflicts=(identityEvidence.get(prefix+'account_id')??[]).filter(f=>f.playerIdentity?.heroId===h.value&&(f.status==='observed'?String(f.value):null)!==accountId),accountBarrierAt=latest(accountConflicts.map(f=>f.knownAt));
  for(const f of [...heroConflicts,...accountConflicts])if(heroBarrierAt&&time(f.knownAt)===time(heroBarrierAt)||accountBarrierAt&&time(f.knownAt)===time(accountBarrierAt))barrierVersions.add(f.versionSha256);
  identityBarriers.push({matchId,playerSlot:h.playerIdentity.playerSlot,heroBarrierAt,accountBarrierAt,accountId});
 }
 const dependencies=new Set([...fields.filter(f=>!f.conflict).map(f=>f.versionSha256),...barrierVersions]);
 const sourceVersions=[...dependencies].sort((a,b)=>a.localeCompare(b,'en')).map(versionSha256=>({versionSha256,source:sources.get(versionSha256)}));
 return freeze({contract:BOUNDED_RETAINED_REDUCER_CONTRACT,matchId,targetMapId,historyCutoffAt,fields,identityBarriers,sourceVersions,audit,selectedFieldBytes:fieldBytes,...flags});
}

/** The map projection mirrors the v1 exporter exactly. A corpus assembler must
 * supply the GLOBAL selected-version-set digest before publishing any row.
 * Clock blocks remain provenance fields; they never become final-to-live fills.
 */
export function projectReducedRetainedMap(reduced,{sourceVersionSetSha256}={}){
 if(reduced?.contract!==BOUNDED_RETAINED_REDUCER_CONTRACT||typeof sourceVersionSetSha256!=='string'||!/^[a-f0-9]{64}$/.test(sourceVersionSetSha256))fail('projection_binding');
 const {matchId}=reduced,fields=new Map(reduced.fields.map(f=>[f.path,f])),barriers=new Map(reduced.identityBarriers.map(b=>[b.playerSlot,b]));
 if(!fields.size)return {map:null,omitted:null};
 const get=path=>{const f=fields.get(path);return f?.status==='observed'?f:null;},omit=reason=>({map:null,omitted:{matchId,reason}});
 const start=get('/start_time'),duration=get('/duration'),outcome=get('/radiant_win');
 if(!start||!duration||!outcome)return omit('completed_prior_map_inputs_unavailable');
 const endSeconds=start.value+duration.value;if(!Number.isSafeInteger(endSeconds)||endSeconds*1000>8640000000000000)return omit('invalid_event_end');
 const endedAt=new Date(endSeconds*1000).toISOString(),completionInputsKnownAt=latest([start.knownAt,duration.knownAt,outcome.knownAt]);
 if(time(endedAt)>time(completionInputsKnownAt))return omit('event_end_after_actual_receipt');
 const outcomeKnownAt=latest([completionInputsKnownAt,...['radiant_score','dire_score','radiant_team_id','dire_team_id'].map(k=>get('/'+k)?.knownAt).filter(Boolean)]);
 const heroes=[],players=[],heroPerformances=[],rosterTimes=[],heroTimes=[];
 for(const slot of [0,1,2,3,4,128,129,130,131,132]){
  const prefix='/players/'+slot+'/',h=get(prefix+'hero_id');if(!h)continue;const side=slot<128?'radiant':'dire',a=get(prefix+'account_id'),barrier=barriers.get(slot);
  heroes.push({heroId:h.value,side});heroTimes.push(h.knownAt);
  const usableAccount=a&&a.playerIdentity?.heroId===h.value&&(!barrier.heroBarrierAt||time(a.knownAt)>time(barrier.heroBarrierAt))?a:null,accountId=usableAccount?String(usableAccount.value):null;
  if(accountId){players.push({accountId,heroId:h.value,side});rosterTimes.push(h.knownAt,usableAccount.knownAt);}
  const metrics={},metricAvailability={},metricSources={};let any=false;
  for(const [name,sourceField]of Object.entries(PERFORMANCE_FIELDS)){
   const f=get(prefix+sourceField),same=f?.playerIdentity?.heroId===h.value&&f.playerIdentity.accountId===accountId&&(!barrier.heroBarrierAt||time(f.knownAt)>time(barrier.heroBarrierAt))&&(!barrier.accountBarrierAt||time(f.knownAt)>time(barrier.accountBarrierAt));
   metrics[name]=same?f.value:null;if(same){any=true;metricAvailability[name]=latest([outcomeKnownAt,h.knownAt,...usableAccount?[usableAccount.knownAt]:[],f.knownAt]);metricSources[name]=f.versionSha256;}
  }
  if(any)heroPerformances.push({contract:PERFORMANCE_CONTRACT,accountId,heroId:h.value,side,knownAt:latest(Object.values(metricAvailability)),metrics,metricAvailability,metricSources,invalidFields:[],sourceProfile:'opendota.completed-map.retained-response-player',sourceFields:PERFORMANCE_FIELDS,availabilityBasis:'retained_collector_response_receipt'});
 }
 if(new Set(heroes.map(h=>h.heroId)).size!==heroes.length||new Set(players.map(p=>p.accountId)).size!==players.length)return omit('mixed_roster_identity_conflict');
 const radiantTeamId=get('/radiant_team_id')?.value??null,direTeamId=get('/dire_team_id')?.value??null;
 if(radiantTeamId!==null&&radiantTeamId===direTeamId)return omit('team_identity_conflict');
 const map={matchId,endedAt,outcomeKnownAt,outcomeObservedAt:outcome.knownAt,completionInputsKnownAt,durationKnownAt:duration.knownAt,playersKnownAt:latest([outcomeKnownAt,...rosterTimes]),heroesKnownAt:latest([outcomeKnownAt,...heroTimes]),radiantTeamId:radiantTeamId===null?null:String(radiantTeamId),direTeamId:direTeamId===null?null:String(direTeamId),durationSeconds:duration.value,radiantWon:outcome.value,radiantKills:get('/radiant_score')?.value??null,direKills:get('/dire_score')?.value??null,players,heroes,heroPerformances,identityContinuity:reduced.identityBarriers,fieldAvailability:Object.fromEntries([...fields].map(([path,f])=>[path,{knownAt:f.knownAt,status:f.status,versionSha256:f.versionSha256}])),availabilityBasis:'retained_collector_response_receipt',originalHistoricalAvailabilityProven:false,sourceVersionSetSha256,evidenceRef:'sha256:'+sourceVersionSetSha256+'#match/'+matchId};
 return freeze({map,omitted:null});
}

export function retainedReducedFactsScope({historyCutoffAt,rowCount,population='provided_retained_responses_only'}){
 if(typeof population!=='string'||!/^[a-zA-Z0-9_.-]{1,96}$/.test(population)||!Number.isSafeInteger(rowCount)||rowCount<0||rowCount>20000)fail('scope');time(historyCutoffAt);
 return {contract:'aegis.retained-history-selection-scope.v1',sourceUniverse:'locally_retained_opendota_responses',population,selection:'provided_version_inputs_only',asOf:historyCutoffAt,completeWithinProvidedInputs:true,globalPopulationComplete:false,truncated:false,rowCount};
}

export function retainedVersionSetBinding(sourceVersions){
 const unique=new Map();for(const s of sourceVersions){const prior=unique.get(s.versionSha256);if(prior&&JSON.stringify(prior)!==JSON.stringify(s))fail('source_version_conflict');unique.set(s.versionSha256,s);}
 const sorted=[...unique.values()].sort((a,b)=>a.versionSha256.localeCompare(b.versionSha256,'en'));
 return freeze({sourceVersions:sorted,sourceVersionSetSha256:pinRetainedHistoryJson(sorted).pin.sha256});
}
