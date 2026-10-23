/** Explicit bounded replay into diagnostic PostgreSQL only. Never calls a provider. */
import {readFileSync,readdirSync,writeFileSync,lstatSync} from 'node:fs';
import {resolve,join,isAbsolute} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {normalizeLocalCapture,sha} from './steamLiveAdapter.mjs';
import {persistDynamicCapture,loadTotalsRoshanPrefix} from './dynamicDbSink.mjs';
export function readArchivedCapture(archive,receipt){
 if(!isAbsolute(archive)||!receipt||receipt.endpoint!=='GetLiveLeagueGames/v1'||receipt.httpStatus!==200||!/^[a-f0-9]{64}$/.test(receipt.rawSha256??'')||!receipt.receivedAt)throw Error('archive_receipt_contract');
 const file=join(archive,'raw',receipt.rawSha256+'.body'),st=lstatSync(file);
 if(st.isSymbolicLink()||!st.isFile()||st.size>6*1024**2)throw Error('archive_body_bound');
 const body=readFileSync(file);if(sha(body)!==receipt.rawSha256)throw Error('archive_body_changed');
 return normalizeLocalCapture({body,endpoint:'GetLiveLeagueGames/v1',httpStatus:200,requestStartedAt:receipt.requestStartedAt,receivedAt:receipt.receivedAt,persistedAt:receipt.rawPersistedAt??receipt.persistedAt,rawSha256:receipt.rawSha256,payloadRef:'journal:'+receipt.rawSha256,authenticatedAttempt:true});
}
export async function ingestArchive(archive,db,{maxCaptures=3}={}){
 if(!isAbsolute(archive)||!Number.isInteger(maxCaptures)||maxCaptures<1||maxCaptures>1000)throw Error('bounded_archive_required');
 const dir=join(archive,'observations');let files=readdirSync(dir).filter(n=>/^[0-9]{13}-[a-f0-9-]{36}\.json$/.test(n)).sort();
 const report={contract:'aegis.dynamic-archive-db-ingest.v1',captures:0,observations:0,inserted:0,duplicates:0,rejected:0,providerCalls:0,trainingRuns:0,publicPromotion:false,preservedOriginalReceiptTimes:true,prospectiveValidation:false,sample:null};
 for(const name of files){if(report.captures>=maxCaptures)break;const f=join(dir,name),st=lstatSync(f);if(st.isSymbolicLink()||st.size>65536)throw Error('receipt_bound');
  const r=JSON.parse(readFileSync(f));if(r.httpStatus!==200||!r.rawSha256)continue;
  const c=readArchivedCapture(archive,r),receipt=await persistDynamicCapture(c,db);report.captures++;report.observations+=c.observations.length;report.inserted+=receipt.inserted;report.duplicates+=receipt.duplicates;report.rejected+=c.rejections.length;
  const sample=c.observations.find(o=>o.dynamic.roshan.respawnTimer.value>0);
  if(sample){const got=await loadTotalsRoshanPrefix(db,{matchId:sample.matchId,sourceProfile:sample.dynamic.sourceProfile,asOf:sample.source.capture.receivedAt});
   report.sample={mapId:sample.matchId,knownAt:got.result.knownAt,rawSha256:got.result.rawSha256,roshanTimerRaw:got.result.features.roshan_timer_raw,featureCount:got.vector.names.length,source:'actual_postgres_query',eligibleForServing:false};}
 }
 return report;
}
export async function main(args){
 const flags=new Map();for(let i=0;i<args.length;i++){if(args[i]==='--allow-diagnostic-write')flags.set(args[i],true);else{if(!args[i].startsWith('--')||i+1>=args.length)throw Error('arguments');flags.set(args[i],args[++i]);}}
 if(flags.get('--allow-diagnostic-write')!==true)throw Error('explicit_diagnostic_write_required');
 const archive=flags.get('--archive'),reportPath=flags.get('--report'),app=flags.get('--app-root'),envName=flags.get('--database-env')??'DATABASE_URL',max=Number(flags.get('--max-captures')??3);
 if(!isAbsolute(archive??'')||!isAbsolute(reportPath??'')||!isAbsolute(app??'')||!/^\w+$/.test(envName))throw Error('absolute_paths_and_env_name_required');
 const connection=process.env[envName];if(typeof connection!=='string')throw Error('database_env_missing');
 let target;try{target=new URL(connection);}catch{throw Error('database_url_invalid');}
 if(!['postgres:','postgresql:'].includes(target.protocol)||!['127.0.0.1','localhost','[::1]'].includes(target.hostname))throw Error('local_postgres_only');
 const require=createRequire(join(app,'lib/db/package.json')),{Client}=require('pg'),db=new Client({connectionString:connection,connectionTimeoutMillis:5000,statement_timeout:15000});
 try{await db.connect();const report=await ingestArchive(archive,db,{maxCaptures:max});writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));return report;}
 finally{await db.end();}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).catch(()=>{console.error('diagnostic_archive_ingest_failed; inspect local schema/configuration without printing credentials');process.exitCode=1;});
