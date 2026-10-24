/** Finite, opt-in retained replay host. No listener, provider, scheduler or model.
 * Successful replay restores opaque state from original bytes and verified traces;
 * JSON progress is a reference ledger, never a serialized admission token. */
import {readdir,lstat,realpath,readFile,mkdir,open,rename,unlink} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,join,isAbsolute,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {readCommittedSteamCapture} from './retainedFeaturePipeline.mjs';
import {instantNs} from './causalTime.mjs';
export const HOST_CONTRACT='aegis.finite-retained-diagnostic-host.v1';
const RECEIPT=/^\d{13}-[a-f0-9-]{36}\.json$/,SHA=/^[a-f0-9]{64}$/;
const flags={diagnosticOnly:true,eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false,providerCalls:0};
const sha=x=>createHash('sha256').update(x).digest('hex');
const fail=x=>{throw Error('retained_diagnostic_host:'+x);};
const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const defaults={maxReceipts:512,maxMetadataBytes:32*1024*1024,maxRawBytes:64*1024*1024,maxRunMs:60000,maxStateBytes:8*1024*1024};
const hard={maxReceipts:4096,maxMetadataBytes:128*1024*1024,maxRawBytes:512*1024*1024,maxRunMs:600000,maxStateBytes:16*1024*1024};
const result=(status,reason,extra={})=>({contract:HOST_CONTRACT,status,reason,...extra,...flags});
async function plainDirectory(directory){let p=resolve(directory);for(;;){const s=await lstat(p);if(!s.isDirectory()||s.isSymbolicLink())fail('plain_directory_required');const parent=dirname(p);if(parent===p)break;p=parent;}if(!same(await realpath(directory),resolve(directory)))fail('plain_directory_required');}
async function bounded(file,max){const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size<1||s.size>max)fail('file_bound');const b=await readFile(file);if(b.length>max||!Buffer.from(b.toString('utf8')).equals(b))fail('file_bytes');return b;}
function configuration(raw){
 const keys=['contract','enabled','archive','stateDirectory','historyFactDirectory','historyProfileSha256','materializationGeneration','stopFiles','limits','pipelineLimits'];
 if(!raw||Object.getPrototypeOf(raw)!==Object.prototype||Object.keys(raw).some(k=>!keys.includes(k))||raw.contract!==HOST_CONTRACT||raw.enabled!==true)fail('configuration');
 for(const k of ['archive','stateDirectory','historyFactDirectory'])if(typeof raw[k]!=='string'||!isAbsolute(raw[k])||raw[k].startsWith('\\\\'))fail('explicit_absolute_directories');
 const archive=resolve(raw.archive),stateDirectory=resolve(raw.stateDirectory),historyFactDirectory=resolve(raw.historyFactDirectory);
 const nested=(a,b)=>same(a,b)||(process.platform==='win32'?a.toLowerCase():a).startsWith((process.platform==='win32'?b.toLowerCase():b)+(/^[a-z]:/i.test(b)?'\\':'/'));
 if(nested(stateDirectory,archive)||nested(archive,stateDirectory)||nested(stateDirectory,historyFactDirectory)||nested(historyFactDirectory,stateDirectory))fail('separate_input_output_directories');
 if(!SHA.test(raw.historyProfileSha256??'')||typeof(raw.materializationGeneration??'initial')!=='string'||!/^[-A-Za-z0-9_.]{1,64}$/.test(raw.materializationGeneration??'initial')||!Array.isArray(raw.stopFiles)||!raw.stopFiles.length||raw.stopFiles.length>16||raw.stopFiles.some(p=>typeof p!=='string'||!isAbsolute(p)))fail('history_policy_or_manual_stops');
 if(raw.limits!==undefined&&(!raw.limits||typeof raw.limits!=='object'||Array.isArray(raw.limits)||Object.keys(raw.limits).some(k=>!Object.hasOwn(defaults,k))))fail('limit_keys');
 const limits={...defaults,...raw.limits};for(const[k,v]of Object.entries(limits))if(!Number.isSafeInteger(v)||v<1||v>hard[k])fail('limit_bound');
 if(raw.pipelineLimits!==undefined&&(!raw.pipelineLimits||typeof raw.pipelineLimits!=='object'||Array.isArray(raw.pipelineLimits)))fail('pipeline_limits');
 return{...raw,archive,stateDirectory,historyFactDirectory,materializationGeneration:raw.materializationGeneration??'initial',limits,pipelineLimits:raw.pipelineLimits??{}};
}
export async function readRetainedDiagnosticHostConfig(filename){if(!isAbsolute(filename??''))fail('explicit_config_file');return JSON.parse((await bounded(filename,32768)).toString('utf8'));}

/** pipelineFactory receives the actual stop/abort policy and onTraceIntent.
 * It returns {pipeline,hasCommittedTrace}. The latter verifies a saved CAS trace;
 * a pending JSON intent alone can never claim a completed trace or watermark. */
export async function runRetainedDiagnosticHost(raw,{pipelineFactory,signal=null,now=()=>new Date().toISOString(),monotonicNow=()=>performance.now(),loadCapture=readCommittedSteamCapture}={}){
 if(raw?.enabled!==true)return result('disabled','explicit_enable_required');
 const config=configuration(raw);if(typeof pipelineFactory!=='function'||typeof now!=='function'||typeof monotonicNow!=='function'||typeof loadCapture!=='function')fail('owned_ports');
 const started=monotonicNow(),shouldContinue=()=>!signal?.aborted&&monotonicNow()-started<config.limits.maxRunMs&&!config.stopFiles.some(existsSync);
 if(!shouldContinue())return result('blocked','manual_stop_abort_or_deadline');
 await plainDirectory(config.archive);await plainDirectory(join(config.archive,'observations'));await plainDirectory(config.historyFactDirectory);
 await plainDirectory(dirname(config.stateDirectory));await mkdir(config.stateDirectory,{recursive:false}).catch(e=>{if(e.code!=='EEXIST')throw e;});await plainDirectory(config.stateDirectory);
 const lock=join(config.stateDirectory,'HOST.lock'),owner=randomUUID(),checkpoint=join(config.stateDirectory,'HOST-PROGRESS.json');
 let handle;try{handle=await open(lock,'wx',0o600);await handle.writeFile(owner);await handle.sync();}catch(e){if(e.code==='EEXIST')return result('blocked','owned_host_lock_exists');throw e;}
 const semanticConfig={archive:config.archive,historyFactDirectory:config.historyFactDirectory,historyProfileSha256:config.historyProfileSha256,materializationGeneration:config.materializationGeneration,pipelineLimits:config.pipelineLimits},configurationSha256=sha(JSON.stringify(semanticConfig));
 let state={contract:HOST_CONTRACT,configurationSha256,processed:[],pending:null},current=null,totalRaw=0,replayed=0,consumed=0,restartContinuityBroken=false;
 async function save(){
  if(!shouldContinue())fail('manual_stop_abort_or_deadline');await plainDirectory(config.stateDirectory);
  const body={...state,savedAt:now()},utf8=JSON.stringify({...body,contentSha256:sha(JSON.stringify(body))});if(Buffer.byteLength(utf8)>config.limits.maxStateBytes)fail('progress_state_bound');
  if(existsSync(checkpoint)){const s=await lstat(checkpoint);if(!s.isFile()||s.isSymbolicLink())fail('progress_file_type');}
  const temporary=join(config.stateDirectory,'.'+owner+'.progress');let file;
  try{file=await open(temporary,'wx',0o600);await file.writeFile(utf8);await file.sync();await file.close();file=null;await rename(temporary,checkpoint);}finally{if(file)await file.close();await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
 }
 const onTraceIntent=async({matchId,traceSha256})=>{
  if(!current||typeof matchId!=='string'||!SHA.test(traceSha256??''))fail('trace_intent_identity');
  if(!state.pending)state.pending={...current,traceIntentsByMap:{}};
  if(state.pending.receiptSha256!==current.receiptSha256)fail('trace_intent_receipt');
  state.pending.traceIntentsByMap[matchId]=traceSha256;await save();
 };
 try{
  if(existsSync(checkpoint)){
   const body=JSON.parse((await bounded(checkpoint,config.limits.maxStateBytes)).toString('utf8')),{contentSha256,...contents}=body;
   if(sha(JSON.stringify(contents))!==contentSha256||body.contract!==HOST_CONTRACT||body.configurationSha256!==configurationSha256||!Array.isArray(body.processed)||body.processed.length>config.limits.maxReceipts)fail('progress_integrity_or_configuration');
   state={contract:HOST_CONTRACT,configurationSha256,processed:body.processed,pending:body.pending};
  }
  const filenames=await readdir(join(config.archive,'observations'));if(filenames.some(n=>!RECEIPT.test(n))||filenames.length>config.limits.maxReceipts)fail('receipt_inventory_bound_or_unexpected_entry');
  const entries=[];let metadataBytes=0;
  for(const file of filenames){
   if(!shouldContinue())return result('blocked','manual_stop_abort_or_deadline',{replayed,consumed});
   const bytes=await bounded(join(config.archive,'observations',file),65536);metadataBytes+=bytes.length;if(metadataBytes>config.limits.maxMetadataBytes)fail('metadata_bytes_bound');
   const r=JSON.parse(bytes),received=instantNs(r.receivedAt);if(received===null||r.requestId+'.json'!==file||!SHA.test(r.rawSha256??''))fail('committed_receipt_metadata');
   entries.push({receiptFile:file,receiptSha256:sha(bytes),rawSha256:r.rawSha256,receivedAt:r.receivedAt,received});
  }
  entries.sort((a,b)=>a.received<b.received?-1:a.received>b.received?1:a.receiptFile.localeCompare(b.receiptFile,'en'));
  if(state.processed.length>entries.length||state.processed.some((p,i)=>p.receiptFile!==entries[i].receiptFile||p.receiptSha256!==entries[i].receiptSha256||p.rawSha256!==entries[i].rawSha256))fail('retained_prefix_changed_or_reordered');
  const ports=await pipelineFactory({config,shouldContinue,signal,now,onTraceIntent});
  if(typeof ports?.pipeline?.consumeCapture!=='function'||typeof ports?.hasCommittedTrace!=='function')fail('pipeline_factory_contract');
  const restorationPrefixCount=state.processed.length+Number(state.pending!==null);
  for(let index=0;index<entries.length;index++){
   if(!shouldContinue())return result('blocked','manual_stop_abort_or_deadline',{replayed,consumed});
   const e=entries[index],{received,...reference}=e;current=reference;
   const input=await loadCapture({archive:config.archive,receiptFile:e.receiptFile});
   if(input.receiptInput.pin.sha256!==e.receiptSha256||input.rawInput.pin.sha256!==e.rawSha256)fail('receipt_changed_during_read');
   totalRaw+=input.rawInput.pin.bytes;if(totalRaw>config.limits.maxRawBytes)fail('raw_bytes_bound');
   const old=state.processed[index],restoreTracesByMap={...(old?.traceRefsByMap??{})};
   if(!old&&state.pending){
    if(state.pending.receiptFile!==e.receiptFile||state.pending.receiptSha256!==e.receiptSha256||state.pending.rawSha256!==e.rawSha256)fail('pending_receipt_changed');
    for(const[mapId,hash]of Object.entries(state.pending.traceIntentsByMap??{})){if(!SHA.test(hash))fail('pending_trace_reference');if(await ports.hasCommittedTrace(hash))restoreTracesByMap[mapId]=hash;}
   }
   const replayOnly=!!old;
   if(restorationPrefixCount>0&&index===restorationPrefixCount){
    // Restore identity and LIVE/clock high-water marks, then require a fresh pair.
    if(typeof ports.pipeline.breakSourceContinuity!=='function')fail('restart_continuity_port_required');
    await ports.pipeline.breakSourceContinuity();restartContinuityBroken=true;
    if(!shouldContinue())return result('blocked','manual_stop_abort_or_deadline',{replayed,consumed});
   }
   const output=await ports.pipeline.consumeCapture(input,{replayOnly,restoreTracesByMap});
   if(!shouldContinue())return result('blocked','manual_stop_abort_or_deadline',{replayed,consumed});
   if(!output||output.status==='failed'||!Array.isArray(output.results)&&output.status!=='blocked')fail('pipeline_result');
   const rows=output.results??[];
   if(rows.some(r=>r.status==='failed'))return result('failed','diagnostic_capture_failed',{replayed,consumed,receiptFile:e.receiptFile});
   for(const[mapId,hash]of Object.entries(restoreTracesByMap))if(!rows.some(r=>r.matchId===mapId&&r.status==='restored_diagnostic_state'&&r.traceSha256===hash))fail('diagnostic_state_restore_failed');
   if(replayOnly){replayed++;continue;}
   const traceRefsByMap={...restoreTracesByMap};for(const r of rows)if(r.status==='recorded_diagnostic'&&r.traceCommitted===true&&SHA.test(r.traceSha256??''))traceRefsByMap[r.matchId]=r.traceSha256;
   state.processed.push({...reference,traceRefsByMap,sourceStatus:output.status});state.pending=null;await save();consumed++;
  }
  return result('completed','finite_retained_snapshot_processed',{replayed,consumed,restartContinuityBroken,receiptCount:entries.length,totalRawBytes:totalRaw,successfulMapTraceReferences:state.processed.reduce((n,p)=>n+Object.keys(p.traceRefsByMap).length,0),pipeline:ports.pipeline.status?.()??null});
 }catch(e){return result('failed',String(e.message).startsWith('retained_diagnostic_host:')?e.message.split(':').at(-1):'retained_host_io_or_pipeline_failure',{replayed,consumed});}
 finally{await handle.close();if(await readFile(lock,'utf8').catch(()=>null)===owner)await unlink(lock);}
}
