/** Diagnostic immutable byte exports of the history actually read.
 * Integrity and bounded local read completion are verified separately from source
 * authenticity/coverage. This is not a PostgreSQL MVCC snapshot or ML admission.
 */
import {createHash} from 'node:crypto';
import {instantNs} from './causalTime.mjs';
import {draftHash} from './observedDraft.mjs';
import {replayPinnedDraftPrefix} from './observedDraftHistory.mjs';
import {loadDraftHistoricalContextInputs} from './draftHistoricalFactsDb.mjs';
import {PERFORMANCE_CONTRACT,PERFORMANCE_FIELDS} from './historicalPerformanceFields.mjs';
export const HISTORY_SOURCE_EXPORT_CONTRACT='aegis.immutable-history-source-export.v1';
export const HISTORY_READ_RECEIPT_CONTRACT='aegis.bounded-history-read-receipt.v1';
export const HISTORY_EXPORT_REFERENCE_CONTRACT='aegis.history-source-export-reference.v1';
export const MAX_HISTORY_EXPORT_BYTES=64*1024*1024;
const FACTS='aegis.prior-map-facts.v1',NATIVE='aegis.pinned-native-economy-observations.v1';
const UNIVERSE='local_pro_matches_join_match_parsed',PROFILE='steam.GetLiveLeagueGames.v1.scoreboard';
const NS_DAY=86400n*1000000000n;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const id=x=>typeof x==='string'&&/^[1-9]\d{0,19}$/.test(x);
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const account=x=>id(x)&&BigInt(x)<4294967295n;
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const hero=x=>(typeof x==='number'&&Number.isSafeInteger(x)||typeof x==='string'&&/^[1-9]\d{0,2}$/.test(x))&&Number(x)>=1&&Number(x)<=250;
const sha=x=>createHash('sha256').update(x).digest('hex');
const equal=(a,b)=>draftHash(a)===draftHash(b);
const flags={eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false};
const fieldKeys=(x,allowed)=>object(x)&&Object.keys(x).every(k=>allowed.includes(k));
const boundedText=x=>typeof x==='string'&&x.length>0&&x.length<=256;
const sorted=xs=>[...new Set(xs)].sort((a,b)=>String(a).localeCompare(String(b),'en'));
const sortHeroes=xs=>[...new Set(xs.map(Number))].sort((a,b)=>a-b);
const freeze=x=>{if(object(x)||Array.isArray(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};

function jsonBound(value){
 let nodes=0;
 function visit(v,depth){
  if(++nodes>8000000||depth>40)throw Error('history_source_json_bound');
  if(v===null||typeof v==='boolean'||typeof v==='string')return;
  if(typeof v==='number'&&Number.isFinite(v))return;
  if(Array.isArray(v)){for(const y of v)visit(y,depth+1);return;}
  if(object(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v))){for(const [k,y]of Object.entries(v)){if(['__proto__','constructor','prototype'].includes(k))throw Error('history_source_unsafe_json_key');visit(y,depth+1);}return;}
  throw Error('history_source_not_json');
 }
 visit(value,0);
}
function pinJson(value,path){
 jsonBound(value);const utf8=JSON.stringify(value),bytes=Buffer.byteLength(utf8);
 if(bytes>MAX_HISTORY_EXPORT_BYTES)throw Error('history_source_bytes_bound');
 return{utf8,pin:{path,bytes,sha256:sha(utf8)}};
}
/** The path is an evidence label only; it is never opened by this pure module. */
function pinnedJson(input,maxBytes=MAX_HISTORY_EXPORT_BYTES){
 if(!fieldKeys(input,['utf8','pin'])||typeof input.utf8!=='string'||!fieldKeys(input.pin,['path','bytes','sha256']))throw Error('history_source_pinned_utf8_required');
 const p=input.pin,bytes=Buffer.byteLength(input.utf8);
 if(!boundedText(p.path)||!Number.isSafeInteger(p.bytes)||p.bytes!==bytes||bytes<1||bytes>maxBytes||!hash(p.sha256)||sha(input.utf8)!==p.sha256)throw Error('history_source_pin_or_bound');
 let data;try{data=JSON.parse(input.utf8);}catch{throw Error('history_source_invalid_json');}
 jsonBound(data);return{input:structuredClone(input),data};
}
function draftIdentity(state){
 const players=state.identity.players;
 const selectors={sourceUniverse:UNIVERSE,selection:'target_teams_or_accounts_or_heroes',windowDays:90,
  targetTeamIds:sorted(players.map(p=>p.teamId).filter(id)),targetAccountIds:sorted(players.map(p=>p.accountId).filter(account)),targetHeroIds:sortHeroes(players.map(p=>p.heroId))};
 const revisionBody={contract:state.contract,matchId:state.matchId,historyCutoffAt:state.historyCutoffAt,firstCompleteObservationId:state.firstCompleteObservationId,revision:state.revision,validFromObservationId:state.validFromObservationId,validFrom:state.validFrom,identity:state.identity};
 return{matchId:state.matchId,sourceProfile:state.sourceProfile,cutoffPolicy:state.cutoffPolicy,historyCutoffAt:state.historyCutoffAt,
  validFrom:state.validFrom,validFromObservationId:state.validFromObservationId,revision:state.revision,
  draftRevisionHash:draftHash(revisionBody),draftHash:state.identity.draftHash,rosterHash:state.identity.rosterHash,
  sideIdentityHash:state.identity.sideIdentityHash,selectors,selectorsSha256:draftHash(selectors)};
}
function checkSourceReceipt(r,input,rowCount,maxLimit,{native=false,parentEmpty=false}={}){
 const allowed=['state','queryCompleted','rowCount','limit','collectionSha256','truncated','reason'];
 if(!fieldKeys(r,allowed)||!['complete','skipped_complete_empty_parent','missing','failed','truncated'].includes(r.state)||!Number.isSafeInteger(r.limit)||r.limit<1||r.limit>maxLimit||typeof r.queryCompleted!=='boolean'||typeof r.truncated!=='boolean')throw Error('history_source_read_receipt_contract');
 if(r.state==='complete'||r.state==='skipped_complete_empty_parent'){
  if(input===null||r.rowCount!==rowCount||rowCount>r.limit||r.collectionSha256!==input.pin.sha256||r.truncated||r.state==='complete'&&(r.queryCompleted!==true||r.reason!==null))throw Error('history_source_complete_receipt_mismatch');
  if(r.state==='skipped_complete_empty_parent'&&(!native||!parentEmpty||rowCount!==0||r.queryCompleted!==false||r.reason!=='parent_population_complete_empty'))throw Error('history_source_skip_without_verified_empty_parent');
  return true;
 }
 if(r.state==='truncated'){
  if(r.truncated!==true||r.queryCompleted!==true||!boundedText(r.reason)||input===null&&(r.rowCount!==null||r.collectionSha256!==null)||input!==null&&(r.rowCount!==rowCount||r.collectionSha256!==input.pin.sha256))throw Error('history_source_truncated_receipt_mismatch');
  return false;
 }
 if(input!==null||r.queryCompleted!==false||r.rowCount!==null||r.collectionSha256!==null||r.truncated||!boundedText(r.reason))throw Error('history_source_unavailable_must_not_be_empty_collection');
 return false;
}
function checkFacts(data,identity,{complete}){
 if(!fieldKeys(data,['contract','scope','maps'])||data.contract!==FACTS||!Array.isArray(data.maps)||data.maps.length>50000)throw Error('history_source_facts_contract');
 const s=data.scope,expected=identity.selectors,cutoff=instantNs(identity.historyCutoffAt),seen=new Set();
 if(!object(s)||s.contract!=='aegis.prior-map-selection-scope.v1'||s.sourceUniverse!==UNIVERSE||s.selection!==expected.selection||s.windowDays!==90||instantNs(s.asOf)!==cutoff||s.rowCount!==data.maps.length||s.completeWithinSource!==complete||s.truncated!==!complete||!hash(s.selectionSqlSha256)||!boundedText(s.queryEvidenceRef))throw Error('history_source_facts_scope');
 for(const k of ['targetTeamIds','targetAccountIds','targetHeroIds']){
  if(!Array.isArray(s[k])||!equal(k==='targetHeroIds'?sortHeroes(s[k]):sorted(s[k]),expected[k])||s[k].length!==expected[k].length)throw Error('history_source_selector_scope_mismatch');
 }
 for(const m of data.maps){
  const end=instantNs(m?.endedAt),known=instantNs(m?.outcomeKnownAt),playersAt=instantNs(m?.playersKnownAt),heroesAt=instantNs(m?.heroesKnownAt);
  if(!object(m)||!id(m.matchId)||m.matchId===identity.matchId||seen.has(m.matchId)||end===null||known===null||end>known||known>cutoff||end<cutoff-90n*NS_DAY||playersAt===null||playersAt>cutoff||heroesAt===null||heroesAt>cutoff||typeof m.radiantWon!=='boolean'||!finite(m.durationSeconds)||m.durationSeconds<=0||[m.radiantKills,m.direKills].some(v=>v!==null&&(!Number.isSafeInteger(v)||v<0)))throw Error('history_source_current_future_or_invalid_fact');
  if([m.radiantTeamId,m.direTeamId].some(v=>v!==null&&!id(v))||!Array.isArray(m.players)||m.players.length>10||!Array.isArray(m.heroes)||m.heroes.length>10)throw Error('history_source_fact_roster');
  if(m.players.some(p=>!account(p?.accountId)||!hero(p.heroId)||!['radiant','dire'].includes(p.side))||m.heroes.some(p=>!hero(p?.heroId)||!['radiant','dire'].includes(p.side)))throw Error('history_source_fact_roster');
  if(s.playerPerformanceIncluded===true){
   if(!Array.isArray(m.heroPerformances)||m.heroPerformances.length>10)throw Error('history_source_performance_namespace');
   const seenHeroes=new Set();
   for(const p of m.heroPerformances){
    const at=instantNs(p?.knownAt),knownPlayer=m.players.find(q=>String(q.heroId)===String(p?.heroId)&&q.side===p?.side);
    if(p?.contract!==PERFORMANCE_CONTRACT||!hero(p.heroId)||seenHeroes.has(Number(p.heroId))||!m.heroes.some(q=>String(q.heroId)===String(p.heroId)&&q.side===p.side)||p.accountId!==null&&!account(p.accountId)||knownPlayer&&knownPlayer.accountId!==p.accountId||at===null||at!==playersAt||at>cutoff||at<known||p.sourceProfile!=='opendota.completed-map.parsed-player'||p.availabilityBasis!=='database_timestamp_reconstruction'||!object(p.sourceFields)||!equal(p.sourceFields,PERFORMANCE_FIELDS)||!object(p.metrics)||!equal(Object.keys(p.metrics).sort(),Object.keys(PERFORMANCE_FIELDS).sort())||Object.values(p.metrics).some(v=>v!==null&&(!finite(v)||v<0||v>Number.MAX_SAFE_INTEGER))||!Array.isArray(p.invalidFields)||p.invalidFields.some(f=>!Object.values(PERFORMANCE_FIELDS).includes(f)))throw Error('history_source_performance_identity_availability_or_values');
    seenHeroes.add(Number(p.heroId));
   }
  }else if(m.heroPerformances!==undefined)throw Error('history_source_performance_scope_required');
  if(!expected.targetTeamIds.includes(m.radiantTeamId)&&!expected.targetTeamIds.includes(m.direTeamId)&&!m.players.some(p=>expected.targetAccountIds.includes(p.accountId))&&!m.heroes.some(p=>expected.targetHeroIds.includes(Number(p.heroId))))throw Error('history_source_fact_outside_selectors');
  seen.add(m.matchId);
 }
 return seen;
}
function checkNative(data,identity,priorIds){
 if(!fieldKeys(data,['contract','observations'])||data.contract!==NATIVE||!Array.isArray(data.observations)||data.observations.length>20000)throw Error('history_source_native_contract');
 const cutoff=instantNs(identity.historyCutoffAt),seen=new Set();
 for(const o of data.observations){
  const c=o?.source?.capture,at=instantNs(c?.receivedAt);
  if(o?.contract!=='steam-live-scoreboard-candidate.v1'||!id(o.matchId)||o.matchId===identity.matchId||!priorIds.has(o.matchId)||!hash(o.observationId)||seen.has(o.observationId)||at===null||at>cutoff||o.dynamic?.sourceProfile!==PROFILE||c.endpoint!=='GetLiveLeagueGames/v1'||!hash(c.rawSha256)||c.originalPayloadRef!=='journal:'+c.rawSha256)throw Error('history_source_current_future_or_invalid_native');
  // Raw replay/profile alignment remains mandatory at the downstream producer.
  // This envelope pins candidate observations; it does not upgrade their phase.
  if(o.sourceQualityReasons?.includes('outcome_marker_present'))throw Error('history_source_terminal_native_candidate');
  seen.add(o.observationId);
 }
}

/** Source hash is SHA256 of the actual canonical envelope UTF-8. SQL/scope hashes
 * are metadata, never replacements for the exported facts/native value bytes.
 * A read receipt is a host assertion, not a signature or provider attestation.
 */
export function encodeHistorySourceExport({matchId,computedAt,exportedAt,draftPrefixInputs,factsInput=null,nativeInput=null,readReceiptInput}={}){
 const computed=instantNs(computedAt),exported=instantNs(exportedAt);
 if(computed===null||exported===null||exported<computed)throw Error('history_source_materialization_time');
 const replay=replayPinnedDraftPrefix({matchId,computedAt,draftPrefixInputs});
 if(!replay.accepted)throw Error('history_source_draft_not_accepted:'+replay.reason);
 const identity=draftIdentity(replay.state),receipt=pinnedJson(readReceiptInput,256*1024),r=receipt.data;
 const receiptKeys=['contract','matchId','draftRevisionHash','selectorsSha256','historyCutoffAt','sourceUniverse','startedAt','completedAt','availabilityBasis','databaseSnapshotMode','independentAvailabilityAttested','sources'];
 const start=instantNs(r?.startedAt),end=instantNs(r?.completedAt);
 if(!fieldKeys(r,receiptKeys)||r.contract!==HISTORY_READ_RECEIPT_CONTRACT||r.matchId!==matchId||r.draftRevisionHash!==identity.draftRevisionHash||r.selectorsSha256!==identity.selectorsSha256||instantNs(r.historyCutoffAt)!==instantNs(identity.historyCutoffAt)||r.sourceUniverse!==UNIVERSE||start===null||end===null||start>end||end>exported||start<instantNs(identity.validFrom)||r.availabilityBasis!=='database_timestamp_reconstruction'||r.databaseSnapshotMode!=='bounded_read_results_no_mvcc_snapshot_claim'||r.independentAvailabilityAttested!==false||!fieldKeys(r.sources,['facts','native']))throw Error('history_source_read_receipt_identity_or_time');
 const facts=factsInput===null?null:pinnedJson(factsInput),native=nativeInput===null?null:pinnedJson(nativeInput);
 const factsRows=facts?.data?.maps?.length??null,nativeRows=native?.data?.observations?.length??null;
 const factsComplete=checkSourceReceipt(r.sources.facts,facts?.input??null,factsRows,50000);
 const nativeComplete=checkSourceReceipt(r.sources.native,native?.input??null,nativeRows,20000,{native:true,parentEmpty:factsComplete&&factsRows===0});
 const priorIds=facts?checkFacts(facts.data,identity,{complete:factsComplete}):new Set();
 if(native)checkNative(native.data,identity,priorIds);
 const factsPopulation=factsComplete?(factsRows===0?'verified_complete_empty_within_local_source':'complete_nonempty_within_local_source'):'unavailable';
 const population={facts:factsPopulation,native:nativeComplete?(nativeRows===0?'complete_empty_candidate_collection':'complete_nonempty_candidate_collection'):'unavailable',factsUsable:factsComplete,nativeCandidatesPinned:nativeComplete,allCollectionsComplete:factsComplete&&nativeComplete,zeroHistoryStatisticsInvented:false};
 const body={contract:HISTORY_SOURCE_EXPORT_CONTRACT,identity,computedAt,exportedAt,
  draftPrefixInputs:structuredClone(draftPrefixInputs),factsInput:facts?.input??null,nativeInput:native?.input??null,readReceiptInput:receipt.input,population,
  evidencePolicy:{contentAddress:'sha256_of_actual_envelope_utf8',completenessBasis:'bounded_local_read_receipt_and_exact_selector_scope',sourceAuthenticity:'not_independently_attested',mutableDatabaseSnapshot:false,priorNativeRawAdmissionPerformed:false,learnedState:'externally_bound_by_history_snapshot_identity'},...flags};
 const envelopeInput=pinJson(body,'history-source/export.json');
 const sourceSnapshotHash=envelopeInput.pin.sha256;
 return freeze({contract:HISTORY_SOURCE_EXPORT_CONTRACT,envelopeInput,sourceSnapshotHash,identity:structuredClone(identity),population,
  reference:{contract:HISTORY_EXPORT_REFERENCE_CONTRACT,sha256:sourceSnapshotHash,bytes:envelopeInput.pin.bytes},...flags});
}

/** Verify bytes and replay selectors again after transport or disk reload. */
export function verifyHistorySourceExport(envelopeInput,{expectedSourceSnapshotHash=null,matchId=null,decisionAt=null,readMode='recorded'}={}){
 if(!['recorded','reconstructed'].includes(readMode)||expectedSourceSnapshotHash!==null&&!hash(expectedSourceSnapshotHash))throw Error('history_source_reader_contract');
 const {data}=pinnedJson(envelopeInput);
 if(data?.contract!==HISTORY_SOURCE_EXPORT_CONTRACT||expectedSourceSnapshotHash!==null&&expectedSourceSnapshotHash!==envelopeInput.pin.sha256||matchId!==null&&matchId!==data.identity?.matchId)throw Error('history_source_reader_hash_or_match');
 const rebuilt=encodeHistorySourceExport({matchId:data.identity?.matchId,computedAt:data.computedAt,exportedAt:data.exportedAt,draftPrefixInputs:data.draftPrefixInputs,factsInput:data.factsInput,nativeInput:data.nativeInput,readReceiptInput:data.readReceiptInput});
 if(rebuilt.envelopeInput.utf8!==envelopeInput.utf8)throw Error('history_source_noncanonical_or_derived_tamper');
 if(decisionAt!==null){
  const decision=instantNs(decisionAt);
  if(decision===null||decision<instantNs(rebuilt.identity.validFrom)||readMode==='recorded'&&decision<instantNs(data.exportedAt))throw Error('history_source_not_available_at_decision');
 }
 return rebuilt;
}

/** Wrapper emits completion only after the bounded loader returns successfully.
 * Query failure/bounds retain an explicit unavailable receipt, not empty maps.
 * Abort remains an abort, never a manufactured failed/empty export.
 */
export async function collectDraftHistorySourceExport(db,{matchId,computedAt,draftPrefixInputs,maxMaps=20000,maxFrames=10000,includePlayerPerformance=false,signal=null,now=()=>new Date().toISOString()}={}){
 if(typeof now!=='function')throw Error('history_source_clock_required');
 if(!Number.isSafeInteger(maxMaps)||maxMaps<1||maxMaps>50000||!Number.isSafeInteger(maxFrames)||maxFrames<1||maxFrames>20000||typeof includePlayerPerformance!=='boolean')throw Error('history_source_collection_contract');
 const replay=replayPinnedDraftPrefix({matchId,computedAt,draftPrefixInputs});
 if(!replay.accepted)throw Error('history_source_draft_not_accepted:'+replay.reason);
 const identity=draftIdentity(replay.state),startedAt=now();
 if(instantNs(startedAt)===null||instantNs(startedAt)<instantNs(identity.validFrom))throw Error('history_source_collection_start_time');
 let loaded=null,error=null;
 try{loaded=await loadDraftHistoricalContextInputs(db,{matchId,computedAt,draftPrefixInputs,maxMaps,maxFrames,includePlayerPerformance,signal});}
 catch(e){if(signal?.aborted)throw e;error=e;}
 const completedAt=now(),exportedAt=now();
 const unavailable=(state,limit,reason)=>({state,queryCompleted:state==='truncated',rowCount:null,limit,collectionSha256:null,truncated:state==='truncated',reason});
 let factsInput=null,nativeInput=null,sources;
 if(loaded){
  factsInput=loaded.factsInput;nativeInput=loaded.nativeInput;
  const factsRows=JSON.parse(factsInput.utf8).maps.length,nativeRows=JSON.parse(nativeInput.utf8).observations.length;
  const complete=(input,rows,limit)=>({state:'complete',queryCompleted:true,rowCount:rows,limit,collectionSha256:input.pin.sha256,truncated:false,reason:null});
  sources={facts:complete(factsInput,factsRows,maxMaps),native:factsRows===0?{state:'skipped_complete_empty_parent',queryCompleted:false,rowCount:0,limit:maxFrames,collectionSha256:nativeInput.pin.sha256,truncated:false,reason:'parent_population_complete_empty'}:complete(nativeInput,nativeRows,maxFrames)};
 }else{
  // No error text/SQL parameters are exported. The whole unsuccessful loader is
  // unavailable because it did not return a committed pair of value collections.
  const reason=/^draft_history_db_(map|native)_bound$/.test(error?.message??'')?'bounded_loader_truncated':'bounded_loader_failed';
  const state=reason==='bounded_loader_truncated'?'truncated':'failed';
  sources={facts:unavailable(state,maxMaps,reason),native:unavailable('missing',maxFrames,'successful_parent_export_not_returned')};
 }
 const receipt={contract:HISTORY_READ_RECEIPT_CONTRACT,matchId,draftRevisionHash:identity.draftRevisionHash,selectorsSha256:identity.selectorsSha256,historyCutoffAt:identity.historyCutoffAt,sourceUniverse:UNIVERSE,startedAt,completedAt,availabilityBasis:'database_timestamp_reconstruction',databaseSnapshotMode:'bounded_read_results_no_mvcc_snapshot_claim',independentAvailabilityAttested:false,sources};
 return encodeHistorySourceExport({matchId,computedAt,exportedAt,draftPrefixInputs,factsInput,nativeInput,readReceiptInput:pinJson(receipt,'history-source/local-read-receipt.json')});
}
