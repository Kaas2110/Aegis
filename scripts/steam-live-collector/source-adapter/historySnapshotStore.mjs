/** Append-only diagnostic history snapshots; PostgreSQL pool is injected explicitly.
 * No credentials, provider calls, migrations, model fits or serving activation.
 */
import {instantNs} from './causalTime.mjs';
import {DRAFT_CONTRACT,FREEZE_POLICY,draftHash} from './observedDraft.mjs';
export const SNAPSHOT_CONTRACT='aegis.history-context-snapshot.v1';
export const IDENTITY_CONTRACT='aegis.history-context-identity.v1';
const MAX_BYTES=16*1024*1024,MAX_DEPENDENCIES=100000;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const id=x=>typeof x==='string'&&/^[1-9]\d{0,19}$/.test(x);
const text=x=>typeof x==='string'&&x.length>0&&x.length<=256;
const clone=x=>structuredClone(x);
async function deadline(promise,ms,reason){
 let timer;
 try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(reason)),ms);})]);}
 finally{clearTimeout(timer);}
}
function jsonBound(value){
 let nodes=0;
 const visit=(v,depth)=>{
  if(++nodes>1000000||depth>32)throw Error('history_snapshot_json_bound');
  if(v===null||typeof v==='boolean'||typeof v==='string')return;
  if(typeof v==='number'&&Number.isFinite(v))return;
  if(Array.isArray(v)){for(const x of v)visit(x,depth+1);return;}
  if(object(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v))){for(const [k,x] of Object.entries(v)){if(k==='__proto__'||k==='constructor'||k==='prototype')throw Error('history_snapshot_unsafe_key');visit(x,depth+1);}return;}
  throw Error('history_snapshot_not_json');
 };
 visit(value,0);
 if(Buffer.byteLength(JSON.stringify(value))>MAX_BYTES)throw Error('history_snapshot_bytes_bound');
}
function validateIdentity(x){
 jsonBound(x);
 if(!object(x)||x.contract!==IDENTITY_CONTRACT||!id(x.matchId)||x.cutoffPolicy!==FREEZE_POLICY||!text(x.producerVersion)||![x.schemaHash,x.sourceSnapshotHash,x.patchEvidenceHash,x.draftHash,x.rosterHash,x.sideIdentityHash,x.validFromObservationId,x.draftStateHash].every(digest))throw Error('history_snapshot_identity_contract');
 const cutoff=instantNs(x.historyCutoffAt),valid=instantNs(x.validFrom);
 if(cutoff===null||valid===null||cutoff>valid||!text(x.sourceProfile)||!['recorded_input_receipts','database_timestamp_reconstruction'].includes(x.availabilityBasis))throw Error('history_snapshot_identity_times_or_basis');
 if(x.learnedState!==null){
  const s=x.learnedState;
  if(!object(s)||!digest(s.learnedTransformStateSha256)||s.fitPartition!=='TRAIN'||!digest(s.trainingSplitSha256)||!text(s.foldId)||!text(s.cohortId))throw Error('history_snapshot_learned_state_binding');
 }
 return x;
}
/** The exact draft checkpoint is part of identity; a later disclosed account never
 * expands the first draft's historical cutoff or rewrites a previous snapshot.
 */
export function historySnapshotIdentity({draftState,producerVersion,schemaHash,sourceSnapshotHash,patchEvidenceHash,availabilityBasis,learnedState=null}={}){
 if(!object(draftState)||draftState.contract!==DRAFT_CONTRACT)throw Error('history_snapshot_draft_required');
 const {stateHash,...body}=draftState;
 if(!digest(stateHash)||draftHash(body)!==stateHash)throw Error('history_snapshot_draft_hash');
 const d=draftState.identity;
 return validateIdentity({contract:IDENTITY_CONTRACT,matchId:draftState.matchId,
  cutoffPolicy:draftState.cutoffPolicy,historyCutoffAt:draftState.historyCutoffAt,
  validFrom:draftState.validFrom,validFromObservationId:draftState.validFromObservationId,
  draftStateHash:draftHash({contract:draftState.contract,matchId:draftState.matchId,historyCutoffAt:draftState.historyCutoffAt,
   firstCompleteObservationId:draftState.firstCompleteObservationId,revision:draftState.revision,
   validFromObservationId:draftState.validFromObservationId,validFrom:draftState.validFrom,identity:d}),
  draftHash:d.draftHash,rosterHash:d.rosterHash,sideIdentityHash:d.sideIdentityHash,
  sourceProfile:draftState.sourceProfile,producerVersion,schemaHash,sourceSnapshotHash,patchEvidenceHash,availabilityBasis,learnedState:clone(learnedState)});
}
/** One source reference must represent the facts actually used by the producer. */
function validatePayload(payload,identity){
 jsonBound(payload);
 if(!object(payload)||!object(payload.featurePayload)||!Array.isArray(payload.dependencies)||payload.dependencies.length>MAX_DEPENDENCIES)throw Error('history_snapshot_payload_contract');
 const cutoff=instantNs(identity.historyCutoffAt),outcomes=new Set();
 for(const d of payload.dependencies){
  if(!object(d)||!['outcome','roster','hero_roster','native_frame','static_reference'].includes(d.kind)||!digest(d.sha256)||!text(d.evidenceRef)||instantNs(d.availableAt)===null||instantNs(d.availableAt)>cutoff)throw Error('history_snapshot_future_or_unproven_dependency');
  if(d.matchId!==null&&(!id(d.matchId)||d.matchId===identity.matchId))throw Error('history_snapshot_current_map_dependency');
  if(d.matchId===null&&d.kind!=='static_reference')throw Error('history_snapshot_match_dependency_required');
  if(d.kind==='outcome'){
   if(instantNs(d.endedAt)===null||instantNs(d.endedAt)>instantNs(d.availableAt)||typeof d.value!=='boolean')throw Error('history_snapshot_outcome_dependency');
   outcomes.add(d.matchId);
  }
 }
 if(payload.dependencies.some(d=>d.matchId!==null&&!outcomes.has(d.matchId)))throw Error('history_snapshot_prior_completion_required');
 if(['label','currentOutcome','targetLabel'].some(k=>Object.hasOwn(payload,k)))throw Error('history_snapshot_current_label_not_allowed');
 return payload;
}
export function buildHistorySnapshot(identity,payload,{generatedAt}={}){
 validateIdentity(identity);validatePayload(payload,identity);
 const generated=instantNs(generatedAt);
 if(generated===null||generated<instantNs(identity.validFrom))throw Error('history_snapshot_generated_at');
 const body={contract:SNAPSHOT_CONTRACT,identity:clone(identity),payload:clone(payload),generatedAt};
 return {...body,cacheKey:draftHash(identity),contentHash:draftHash(body),eligibleForServing:false,eligibleForTraining:false};
}
export function verifyHistorySnapshot(snapshot,{expectedIdentity=null,matchId=null,decisionAt=null,readMode='recorded'}={}){
 if(!['recorded','reconstructed'].includes(readMode))throw Error('history_snapshot_read_mode');
 if(!object(snapshot)||snapshot.contract!==SNAPSHOT_CONTRACT||snapshot.eligibleForServing!==false||snapshot.eligibleForTraining!==false)throw Error('history_snapshot_contract');
 const rebuilt=buildHistorySnapshot(snapshot.identity,snapshot.payload,{generatedAt:snapshot.generatedAt});
 if(rebuilt.cacheKey!==snapshot.cacheKey||rebuilt.contentHash!==snapshot.contentHash||expectedIdentity!==null&&draftHash(expectedIdentity)!==snapshot.cacheKey)throw Error('history_snapshot_hash_or_identity_mismatch');
 if(matchId!==null&&snapshot.identity.matchId!==matchId)throw Error('history_snapshot_reader_match');
 if(decisionAt!==null&&(instantNs(decisionAt)===null||instantNs(decisionAt)<instantNs(snapshot.identity.validFrom)))throw Error('history_snapshot_not_yet_valid');
 if(decisionAt!==null&&readMode==='recorded'&&instantNs(decisionAt)<instantNs(snapshot.generatedAt))throw Error('history_snapshot_not_yet_materialized');
 return snapshot;
}
export const SELECT_SNAPSHOT_SQL='SELECT snapshot FROM history_context_snapshots WHERE cache_key=$1';
export const INSERT_SNAPSHOT_SQL=`INSERT INTO history_context_snapshots
 (cache_key,content_hash,match_id,history_cutoff_at_text,valid_from_at_text,snapshot)
 VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (cache_key) DO NOTHING RETURNING snapshot`;
const rowValue=r=>{if(!Array.isArray(r?.rows)||r.rows.length>1)throw Error('history_snapshot_db_row_bound');const x=r.rows[0]?.snapshot;return typeof x==='string'?JSON.parse(x):x??null;};

/** A dedicated checked-out connection owns each transaction. Advisory locking
 * prevents duplicate exports across processes; single-flight coalesces local readers.
 * The pure builder may perform bounded as-of DB reads, never a user-card API poll.
 */
export function createHistorySnapshotStore(pool,{acquireTimeoutMs=2000,lockTimeoutMs=2000,statementTimeoutMs=3000,buildTimeoutMs=5000,requestTimeoutMs=10000,now=()=>new Date().toISOString()}={}){
 if(typeof pool?.connect!=='function')throw Error('history_snapshot_owned_pool_required');
 if(typeof now!=='function')throw Error('history_snapshot_clock_required');
 for(const ms of [acquireTimeoutMs,lockTimeoutMs,statementTimeoutMs,buildTimeoutMs,requestTimeoutMs])if(!Number.isSafeInteger(ms)||ms<5||ms>60000)throw Error('history_snapshot_timeout_bounds');
 const flights=new Map();
 async function transaction(callback){
  const pending=Promise.resolve().then(()=>pool.connect());let client;
  try{client=await deadline(pending,acquireTimeoutMs,'history_snapshot_pool_timeout');}
  catch(error){pending.then(late=>late.release(),()=>{});throw error;}
  if(typeof client?.query!=='function'||typeof client?.release!=='function')throw Error('history_snapshot_connection_contract');
  try{
   await client.query('BEGIN');
   await client.query("SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)",[lockTimeoutMs+'ms',statementTimeoutMs+'ms']);
   const value=await callback(client);await client.query('COMMIT');return value;
  }
  catch(error){try{await client.query('ROLLBACK');}catch{}throw error;}
  finally{client.release();}
 }
 return {
  async getOrCreate(identity,{generatedAt,build}={}){
   if(generatedAt!==undefined)throw Error('history_snapshot_materialization_clock_owned');
   identity=clone(identity);
   validateIdentity(identity);
   if(typeof build!=='function')throw Error('history_snapshot_builder_required');
   const key=draftHash(identity);
   if(!flights.has(key)){
    const promise=transaction(async db=>{
     await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
     const existing=rowValue(await db.query(SELECT_SNAPSHOT_SQL,[key]));
     if(existing)return verifyHistorySnapshot(existing,{expectedIdentity:identity});
     const controller=new AbortController(),timer=setTimeout(()=>controller.abort(Error('history_snapshot_build_timeout')),buildTimeoutMs);
     let payload;
     try{payload=await build({db,historyCutoffAt:identity.historyCutoffAt,signal:controller.signal,buildTimeoutMs});controller.signal.throwIfAborted();}
     finally{clearTimeout(timer);}
     const built=buildHistorySnapshot(identity,payload,{generatedAt:now()});
     const inserted=rowValue(await db.query(INSERT_SNAPSHOT_SQL,[key,built.contentHash,identity.matchId,identity.historyCutoffAt,identity.validFrom,JSON.stringify(built)]));
     if(inserted)return verifyHistorySnapshot(inserted,{expectedIdentity:identity});
     const raced=rowValue(await db.query(SELECT_SNAPSHOT_SQL,[key]));
     if(!raced)throw Error('history_snapshot_insert_missing');
     const verified=verifyHistorySnapshot(raced,{expectedIdentity:identity});
     if(verified.contentHash!==built.contentHash)throw Error('history_snapshot_identity_payload_conflict');
     return verified;
    });
    flights.set(key,promise);
    promise.then(()=>{if(flights.get(key)===promise)flights.delete(key);},()=>{if(flights.get(key)===promise)flights.delete(key);});
   }
   // A timed-out caller never releases a connection owned by an unfinished builder.
   // The producer must cooperate with signal and bound its own loops/DB reads.
   return clone(await deadline(flights.get(key),requestTimeoutMs,'history_snapshot_request_timeout'));
  },
  async loadRef(ref,{matchId,decisionAt,readMode='recorded'}={}){
   ref=clone(ref);
   if(!digest(ref?.cacheKey)||!digest(ref?.contentHash)||!id(matchId)||instantNs(decisionAt)===null)throw Error('history_snapshot_reference_contract');
   const stored=await deadline(transaction(db=>db.query(SELECT_SNAPSHOT_SQL,[ref.cacheKey])),requestTimeoutMs,'history_snapshot_request_timeout');
   const snapshot=rowValue(stored);if(!snapshot)return null;
   verifyHistorySnapshot(snapshot,{matchId,decisionAt,readMode});
   if(snapshot.contentHash!==ref.contentHash)throw Error('history_snapshot_reference_hash');
   return clone(snapshot);
  }
 };
}
