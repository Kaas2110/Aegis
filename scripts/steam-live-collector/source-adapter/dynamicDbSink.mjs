/** Inject a PostgreSQL-compatible port explicitly; no credentials, auto connection or migrations. */
import {DYNAMIC_CONTRACT} from './dynamicFields.mjs';
import {advanceRoshanFeatures,featureVector} from './roshanFeatures.mjs';
import {instantNs} from './causalTime.mjs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {resolve,dirname,join} from 'node:path';
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
export const INSERT_SQL=`INSERT INTO steam_dynamic_diagnostic_v1
 (observation_id,match_id,source_profile,known_at,game_clock_seconds,raw_sha256,source_input_hash,dynamic_contract,normalized_observation,phase_code,roshan_respawn_timer_raw)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11) ON CONFLICT (observation_id) DO NOTHING RETURNING observation_id`;
export async function openLocalDiagnosticDatabase({env=process.env,envName='DATABASE_URL'}={}){
 if(!/^[A-Z][A-Z0-9_]{0,63}$/.test(envName)||typeof env[envName]!=='string')throw Error('local_database_env_missing');
 let target;try{target=new URL(env[envName]);}catch{throw Error('local_database_url_invalid');}
 if(!['postgres:','postgresql:'].includes(target.protocol)||!['127.0.0.1','localhost','[::1]'].includes(target.hostname))throw Error('local_database_required');
 const app=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),require=createRequire(join(app,'lib/db/package.json')),{Client}=require('pg');
 const db=new Client({connectionString:env[envName],connectionTimeoutMillis:3000,statement_timeout:2000,query_timeout:3000});
 try{await db.connect();return db;}catch{try{await db.end();}catch{}throw Error('local_diagnostic_database_unavailable');}
}
export async function persistDynamicCapture(capture,db,{signal,deadlineMs=Infinity}={}){
 if(typeof db?.query!=='function'||!Array.isArray(capture?.observations))throw Error('dynamic_sink_contract');
 const receipt={contract:'steam-dynamic-db-sink-receipt.v1',attempted:0,inserted:0,duplicates:0,diagnosticOnly:true};
 for(const o of capture.observations){
  if(signal?.aborted||Date.now()>deadlineMs)throw Error('diagnostic_sink_bounded_stop');
  if(o.dynamic?.contract!==DYNAMIC_CONTRACT||o.eligibleForServing!==false||!hash(o.observationId)||!hash(o.inputHash)||!hash(o.source?.capture?.rawSha256)||!/^[1-9]\d{0,19}$/.test(o.matchId))throw Error('dynamic_observation_invalid');
  const cap=o.source.capture,started=instantNs(cap.requestStartedAt),received=instantNs(cap.receivedAt),persisted=instantNs(cap.persistedAt);
  if(started===null||received===null||persisted===null||started>received||received>persisted)throw Error('dynamic_capture_time_order');
  const text=JSON.stringify(o);if(Buffer.byteLength(text)>262144)throw Error('dynamic_observation_size_bound');
  receipt.attempted++;
  const result=await db.query(INSERT_SQL,[o.observationId,o.matchId,o.dynamic.sourceProfile,o.source.capture.receivedAt,o.providerGameClockSeconds.value,o.source.capture.rawSha256,o.inputHash,DYNAMIC_CONTRACT,text,o.dynamic.phase.value,o.dynamic.roshan.respawnTimer.rawValue]);
  if(result?.rowCount===1)receipt.inserted++;else if(result?.rowCount===0)receipt.duplicates++;else throw Error('dynamic_sink_unexpected_row_count');
 }
 return receipt;
}
/** A diagnostic totals consumer uses exactly the same feature function as archive training.
 * The query is as-of receipt time. No future frame interpolation and no outcome join.
 * Map profile must be selected by the caller; multiple Steam endpoints are not merged.
 */
export async function loadTotalsRoshanPrefix(db,{matchId,sourceProfile,asOf,limit=4096,featureOptions={}}){
 const cutoff=instantNs(asOf);
 if(typeof db?.query!=='function'||!/^[1-9]\d{0,19}$/.test(matchId)||typeof sourceProfile!=='string'||cutoff===null||!Number.isInteger(limit)||limit<1||limit>10000)throw Error('dynamic_reader_contract');
 const r=await db.query(`SELECT normalized_observation FROM steam_dynamic_diagnostic_v1 WHERE match_id=$1 AND source_profile=$2 AND known_at<=$3 ORDER BY known_at,observation_id LIMIT $4`,[matchId,sourceProfile,asOf,limit+1]);
 if(!Array.isArray(r?.rows)||r.rows.length>limit)throw Error('dynamic_prefix_limit_requires_explicit_window');
 // PostgreSQL timestamptz has microsecond precision. The retained JSON timestamp is
 // authoritative for the exact bound and ordering of the bounded prefix.
 const observations=r.rows.map(row=>{const o=typeof row.normalized_observation==='string'?JSON.parse(row.normalized_observation):row.normalized_observation,at=instantNs(o?.source?.capture?.receivedAt);
  if(o?.matchId!==matchId||o.dynamic?.sourceProfile!==sourceProfile||at===null||at>cutoff)throw Error('dynamic_reader_identity_or_future_row');
  return {o,at};
 }).sort((a,b)=>a.at<b.at?-1:a.at>b.at?1:String(a.o.observationId).localeCompare(String(b.o.observationId)));
 let state=null,last=null;
 for(const {o} of observations){
  last=advanceRoshanFeatures(state,o,featureOptions);state=last.state;
 }
 return last?{status:'diagnostic_features_ready',result:last,vector:featureVector(last),eligibleForServing:false}: {status:'no_observations',result:null,vector:null,eligibleForServing:false};
}
