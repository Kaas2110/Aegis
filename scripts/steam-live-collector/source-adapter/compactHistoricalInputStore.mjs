/** Static PRE/series history inputs in the same owned persistent writer used
 * by compact feature evidence. Source bytes are chunked; the header is committed
 * last. Actual dependencies are re-read before an opaque proof is returned.
 * Storage integrity does not attest original provider availability or semantics.
 */
import {createHash} from 'node:crypto';
import {instantNs} from './causalTime.mjs';
import {canonical} from '../../feature-registry/registry-contract.mjs';
import {createDiagnosticResourceArena,snapshotPlainRecord,measureBoundedJsonBytes} from './diagnosticResourceArena.mjs';
import {inspectBoundedJsonSource} from './boundedJsonSource.mjs';
import {readPrematchHistoryTargetInput,readSeriesHistoryTargetInput} from './staticHistoryTargetContracts.mjs';
import {produceSeriesContext} from './seriesContextFeatures.mjs';

export const COMPACT_HISTORICAL_INPUT_STORE_CONTRACT='aegis.compact-historical-input-store.v2';
export const COMPACT_HISTORICAL_INPUT_REFERENCE_CONTRACT='aegis.static-historical-input-reference.v2';
export const COMPACT_HISTORICAL_INPUT_LIMITS=Object.freeze({maxSourceBytes:64*1024*1024,maxInputBytes:64*1024*1024,maxChunkBytes:1024*1024,maxChunks:256,maxManifestBytes:16384,maxReadBatchBytes:8*1024*1024,maxReadBatchRefs:8,maxActiveProofs:64});
const HEADER='aegis.static-historical-feature-inputs.v1',BODY='aegis.compact-static-historical-feature-inputs.v2',MANIFEST='compact-historical-input-set-v2',CHUNK='compact-historical-input-chunk-v2',PROOF='aegis.verified-compact-historical-input-proof.v2';
const proofs=new WeakMap(),MODES=['PRE','SERIES_PRE','BETWEEN'];
const flags=Object.freeze({eligibleForTraining:false,eligibleForServing:false,recordedPrediction:false});
const sha=x=>createHash('sha256').update(x).digest('hex'),bytes=x=>Buffer.byteLength(x,'utf8'),hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const fail=x=>{throw Error('compact_historical_input_store:'+x);};
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
function exact(value,keys,label){const record=snapshotPlainRecord(value,{maxKeys:keys.length});if(Object.getOwnPropertySymbols(value).length||Object.keys(record).sort().join(',')!==[...keys].sort().join(','))fail(label);return record;}
function config(limits){const value=snapshotPlainRecord(limits,{maxKeys:Object.keys(COMPACT_HISTORICAL_INPUT_LIMITS).length}),out={...COMPACT_HISTORICAL_INPUT_LIMITS,...value};for(const [k,v]of Object.entries(out))if(!Object.hasOwn(COMPACT_HISTORICAL_INPUT_LIMITS,k)||!Number.isSafeInteger(v)||v<1||v>COMPACT_HISTORICAL_INPUT_LIMITS[k])fail('limit_'+k);return Object.freeze(out);}
function refOf(reference,cfg){const r=exact(reference,['contract','kind','sha256','bytes'],'reference');if(r.contract!==COMPACT_HISTORICAL_INPUT_REFERENCE_CONTRACT||r.kind!==MANIFEST||!hash(r.sha256)||!Number.isSafeInteger(r.bytes)||r.bytes<1||r.bytes>cfg.maxManifestBytes)fail('reference');return freeze(r);}
const artifactRef=r=>({kind:r.kind,sha256:r.sha256,bytes:r.bytes});
function chunkRef(raw,cfg){const r=exact(raw,['kind','sha256','bytes'],'chunk_reference');if(r.kind!==CHUNK||!hash(r.sha256)||!Number.isSafeInteger(r.bytes)||r.bytes<1||r.bytes>cfg.maxChunkBytes)fail('chunk_reference');return freeze(r);}
function parse(utf8,label){try{inspectBoundedJsonSource(utf8);return JSON.parse(utf8);}catch{fail(label+'_json');}}
function inputOf(raw,cfg){const p=exact(raw,['utf8','pin'],'input'),pin=exact(p.pin,['path','sha256','bytes'],'pin');if(typeof p.utf8!=='string'||p.utf8.length>cfg.maxInputBytes||typeof pin.path!=='string'||pin.path.length<1||pin.path.length>4096||!hash(pin.sha256)||!Number.isSafeInteger(pin.bytes)||pin.bytes<1||pin.bytes>cfg.maxInputBytes||bytes(p.utf8)!==pin.bytes)fail('source_input_bound');return {utf8:p.utf8,pin};}
function supportOf(minimumSupport,minSupport){const selected=minimumSupport!==undefined?minimumSupport:minSupport!==undefined?minSupport:5;if(minimumSupport!==undefined&&minSupport!==undefined&&minimumSupport!==minSupport||!Number.isSafeInteger(selected)||selected<3||selected>1000)fail('minimum_support');return selected;}
function bindingOptions(raw={}){
 const o=snapshotPlainRecord(raw,{maxKeys:8});if(Object.keys(o).some(k=>!['mode','historicalBindings','seriesReceiptPin','decisionAt','targetBinding','matchId','seriesId','requireParsedTargetBinding'].includes(k)))fail('verification_options');
 for(const key of ['historicalBindings','seriesReceiptPin'])if(o[key]!==undefined&&o[key]!==null){const value=snapshotPlainRecord(o[key],{maxKeys:key==='historicalBindings'?16:4});if(Object.values(value).some(v=>v!==null&&v!==undefined&&!['string','number','boolean'].includes(typeof v)))fail('verification_binding_scalars');o[key]=Object.freeze(value);}
 if(o.requireParsedTargetBinding!==undefined&&typeof o.requireParsedTargetBinding!=='boolean')fail('parsed_target_option');
 if(o.targetBinding!==undefined&&o.targetBinding!==null){measureBoundedJsonBytes(o.targetBinding,{maxBytes:16384,maxNodes:256,maxDepth:8});o.targetBinding=freeze(structuredClone(o.targetBinding));}
 return Object.freeze(o);
}
function validateParsedTarget(binding,options){
 // A parsed private proof keeps its causal/identity claims even when a later
 // reader does not request stricter parsing. A caller cannot erase those facts.
 if(!binding){if(options.requireParsedTargetBinding)fail('parsed_target_proof_required');return;}
 if(options.decisionAt!==undefined&&options.decisionAt!==null&&(instantNs(binding.requiredInputAvailableAt)===null||instantNs(binding.requiredInputAvailableAt)>instantNs(options.decisionAt)))fail('parsed_target_input_after_decision');
 const b=options.historicalBindings,t=options.targetBinding;
 if(b&&(b.historyCutoffAt!==binding.historyCutoffAt||b.validFrom!==binding.validFrom||binding.kind==='series_history'&&(b.transitionId!==binding.transitionId||b.identityRevision!==binding.identityRevision)))fail('parsed_target_horizon_or_revision');
 if(options.matchId!==undefined&&options.matchId!==binding.matchId||options.seriesId!==undefined&&options.seriesId!==binding.seriesId)fail('parsed_target_identity');
 if(t){if(t.mapId!==binding.matchId)fail('parsed_target_map_binding');
  if(binding.kind==='map_prematch'){if(!t.mapSides||t.mapSides.radiant!==binding.mapSides.radiant||t.mapSides.dire!==binding.mapSides.dire)fail('parsed_target_side_binding');}
  else if(t.mapSides!==null||!t.series||t.series.seriesId!==binding.seriesId||t.series.team1Id!==binding.team1Id||t.series.team2Id!==binding.team2Id)fail('parsed_target_series_binding');
 }
}
function validateBindings(header,{mode,historicalBindings,seriesReceiptPin,decisionAt}={}){
 // These times are caller-bound metadata, not a parsed-target/source causality
 // proof. The store proves static byte integrity and the requested pin binding.
 if(mode!==undefined&&mode!==header.mode)fail('mode_binding');
 if(historicalBindings!==undefined){const b=snapshotPlainRecord(historicalBindings,{maxKeys:16});if(b.factsSha256!==header.inputs.facts.sha256||b.targetSha256!==header.inputs.target.sha256)fail('historical_input_binding');
  const cutoff=b.historyCutoffAt===null||b.historyCutoffAt===undefined?null:instantNs(b.historyCutoffAt),valid=b.validFrom===null||b.validFrom===undefined?null:instantNs(b.validFrom);
  if(b.historyCutoffAt!==null&&b.historyCutoffAt!==undefined&&cutoff===null||b.validFrom!==null&&b.validFrom!==undefined&&valid===null||cutoff!==null&&valid!==null&&cutoff>valid)fail('historical_horizon');
  if(decisionAt!==undefined&&decisionAt!==null){const decision=instantNs(decisionAt);if(decision===null||cutoff!==null&&cutoff>decision||valid!==null&&valid>decision)fail('historical_horizon');}
 }
 if(decisionAt!==undefined&&decisionAt!==null&&instantNs(decisionAt)===null)fail('decision_time');
 const expectedSeries=seriesReceiptPin===null||seriesReceiptPin===undefined?undefined:snapshotPlainRecord(seriesReceiptPin,{maxKeys:4}).sha256;
 if(seriesReceiptPin!==undefined&&header.inputs.series?.sha256!==expectedSeries)fail('series_input_binding');
 if(seriesReceiptPin!==null&&seriesReceiptPin!==undefined){const p=snapshotPlainRecord(seriesReceiptPin,{maxKeys:4});if(!hash(p.sha256)||p.bytes!==undefined&&p.bytes!==header.inputs.series.bytes)fail('series_input_binding');}
}

/** Authoritative compact-journal proof read. The host must keep the returned
 * lease alive while using this immutable descriptor. A JSON copy is not a token.
 */
export function readCompactHistoricalInputProof(proof,{reference,...options}={}){
 const held=proofs.get(proof);if(!held||!held.active)fail('owned_active_proof_required');
 if(reference!==undefined&&(reference.contract!==held.descriptor.reference.contract||reference.kind!==held.descriptor.reference.kind||reference.sha256!==held.descriptor.reference.sha256||reference.bytes!==held.descriptor.reference.bytes))fail('proof_reference_binding');
 const ownedOptions=bindingOptions(options);validateBindings(held.descriptor.header,ownedOptions);validateParsedTarget(held.descriptor.parsedTargetBinding,ownedOptions);return held.descriptor;
}

export function createCompactHistoricalInputStore({writer,shouldContinue=()=>true,clock=()=>new Date().toISOString(),resourceArena=null,limits={}}={}){
 if(writer?.contract!=='aegis.persistent-artifact-writer.v1'||typeof writer.commit!=='function'||typeof writer.read!=='function'||typeof shouldContinue!=='function'||typeof clock!=='function')fail('owned_writer_or_ports');
 const cfg=config(limits),arena=resourceArena??createDiagnosticResourceArena(),active=new Set();let closed=false;
 if(typeof arena?.reserve!=='function'||typeof arena.status!=='function')fail('owned_resource_arena');
 async function proceed(){if(closed)fail('closed');const allowed=await shouldContinue();if(closed)fail('closed');if(allowed!==true)fail('stopped');}
 function reserve(n,label){const lease=arena.reserve(n);if(!lease)fail(label+'_memory_reservation');return lease;}
 function verifiedAt(){const at=clock();if(instantNs(at)===null||instantNs(at)<=0n)fail('clock');return at;}
 async function commit(kind,utf8,maximum){await proceed();if(bytes(utf8)>maximum)fail('artifact_bound');const expected={kind,sha256:sha(utf8),bytes:bytes(utf8)},ref=await writer.commit({kind,utf8,expectedSha256:expected.sha256});if(ref?.kind!==kind||ref.sha256!==expected.sha256||ref.bytes!==expected.bytes||Object.keys(ref).sort().join(',')!=='bytes,kind,sha256')fail('writer_reference');return freeze({...ref});}
 async function readObject(ref,maximum){await proceed();const utf8=await writer.read(ref);if(typeof utf8!=='string'||bytes(utf8)>maximum||bytes(utf8)!==ref.bytes||sha(utf8)!==ref.sha256)fail('artifact_bytes');return utf8;}
 async function writeBlob(input){
  const buffer=Buffer.from(input.utf8,'utf8'),chunks=[];
  for(let offset=0;offset<buffer.length;){await proceed();if(chunks.length>=cfg.maxChunks)fail('chunk_count');let end=Math.min(buffer.length,offset+cfg.maxChunkBytes);while(end<buffer.length&&(buffer[end]&0xc0)===0x80)end--;if(end===offset)fail('chunk_codepoint_bound');chunks.push(await commit(CHUNK,buffer.subarray(offset,end).toString('utf8'),cfg.maxChunkBytes));offset=end;}
  return freeze({sha256:input.pin.sha256,bytes:input.pin.bytes,chunks});
 }
 async function readBlob(blob){
  const chunks=[];let total=0;
  const capability=writer.readBatchLimits,maximumRefs=Number.isSafeInteger(capability?.maxReferences)&&capability.maxReferences>0?Math.min(cfg.maxReadBatchRefs,capability.maxReferences):1,maximumBytes=Number.isSafeInteger(capability?.maxBytes)&&capability.maxBytes>0?Math.min(cfg.maxReadBatchBytes,capability.maxBytes):cfg.maxChunkBytes;
  for(let index=0;index<blob.chunks.length;){await proceed();const refs=[];let size=0;
   while(index<blob.chunks.length&&refs.length<maximumRefs&&size+blob.chunks[index].bytes<=maximumBytes){const ref=blob.chunks[index++];size+=ref.bytes;refs.push(ref);}
   if(!refs.length){refs.push(blob.chunks[index++]);size=refs[0].bytes;}
   const values=typeof writer.readMany==='function'&&size<=maximumBytes?await writer.readMany(refs):await(async()=>{const out=[];for(const ref of refs)out.push(await writer.read(ref));return out;})();
   if(!Array.isArray(values)||values.length!==refs.length)fail('read_batch');
   for(let j=0;j<refs.length;j++){const text=values[j],ref=refs[j];if(typeof text!=='string'||bytes(text)!==ref.bytes||sha(text)!==ref.sha256)fail('chunk_bytes');total+=ref.bytes;if(total>blob.bytes)fail('blob_size');chunks.push(text);}
  }
  const utf8=chunks.join('');if(total!==blob.bytes||sha(utf8)!==blob.sha256)fail('blob_integrity');inspectBoundedJsonSource(utf8,{maxBytes:cfg.maxInputBytes});return utf8;
 }
 function mint(header,reference,sourceLease=null,inputs=null,parsedTargetBinding=null){
  if(closed)fail('closed');
  if(active.size>=cfg.maxActiveProofs){sourceLease?.release();fail('proof_count');}
  const descriptor=freeze({contract:'aegis.verified-compact-historical-inputs.v2',reference,header,mode:header.mode,inputs:header.inputs,calculationOptions:header.calculationOptions,parsedTargetBinding,parsedTargetVerified:parsedTargetBinding!==null,verifiedAt:verifiedAt(),sourceAvailabilityIndependentlyAttested:false,storageTimeIsNotOriginalAvailability:true,...flags});
  // The trusted clock/arena ports are synchronous, but may close this store
  // reentrantly. No proof may be registered after close drained active leases.
  if(closed)fail('closed');
  const lease=reserve(bytes(JSON.stringify(descriptor))*4+1024,'proof');if(closed){lease.release();fail('closed');}
  const proof=Object.freeze({contract:PROOF}),held={active:true,descriptor,lease,sourceLease};proofs.set(proof,held);active.add(proof);
  const release=()=>{if(!held.active)return false;held.active=false;active.delete(proof);lease.release();sourceLease?.release();return true;};held.release=release;
  return Object.freeze({proof,descriptor,header,reference,...(inputs?{inputs:freeze(inputs)}:{}),release,...flags});
 }
 async function load(reference,options,keepInputs){
  const ref=refOf(reference,cfg),ownedOptions=bindingOptions(options);await proceed();const manifestLease=reserve(cfg.maxManifestBytes*8+65536,'manifest');let sourceLease=null,manifestParseLease=null;
  try{
   const text=await readObject(artifactRef(ref),cfg.maxManifestBytes),shape=inspectBoundedJsonSource(text,{maxBytes:cfg.maxManifestBytes,maxNodes:8192});manifestParseLease=reserve(shape.estimatedParsedBytes,'manifest_parse');const body=parse(text,'manifest');if(canonical(body)!==text||body?.contract!==BODY||body.eligibleForTraining!==false||body.eligibleForServing!==false||body.recordedPrediction!==false)fail('manifest');
   const top=exact(body,['contract','header','blobs','sourceAvailabilityIndependentlyAttested','eligibleForTraining','eligibleForServing','recordedPrediction'],'manifest_keys'),header=exact(top.header,['contract','mode','inputs','calculationOptions'],'header');
   if(header.contract!==HEADER||!MODES.includes(header.mode)||top.sourceAvailabilityIndependentlyAttested!==false||Object.keys(exact(header.calculationOptions,['minimumSupport'],'support_options')).length!==1)fail('header');supportOf(header.calculationOptions.minimumSupport);
   const sourcePins=snapshotPlainRecord(header.inputs,{maxKeys:3}),rawBlobs=snapshotPlainRecord(top.blobs,{maxKeys:3}),keys=Object.keys(sourcePins).sort();if(keys.join(',')!==Object.keys(rawBlobs).sort().join(',')||!keys.includes('facts')||!keys.includes('target')||keys.some(k=>!['facts','target','series'].includes(k)))fail('source_set');
   const blobs={};let total=0,chunkCount=0;
   for(const key of keys){const pin=exact(sourcePins[key],['sha256','bytes'],'source_pin'),blob=exact(rawBlobs[key],['sha256','bytes','chunks'],'blob');if(!hash(pin.sha256)||!Number.isSafeInteger(pin.bytes)||pin.bytes<1||pin.bytes>cfg.maxInputBytes||blob.sha256!==pin.sha256||blob.bytes!==pin.bytes||!Array.isArray(blob.chunks)||blob.chunks.length<1||blob.chunks.length>cfg.maxChunks)fail('source_blob');
    const refs=blob.chunks.map(r=>chunkRef(r,cfg));if(refs.reduce((n,r)=>n+r.bytes,0)!==pin.bytes||(chunkCount+=refs.length)>cfg.maxChunks||(total+=pin.bytes)>cfg.maxSourceBytes)fail('source_bound');blobs[key]={...pin,chunks:refs};
   }
   validateBindings(header,ownedOptions);sourceLease=reserve(total*8+65536,'source');const inputs={},semanticInputs={};
   for(const key of keys){const utf8=await readBlob(blobs[key]),input={utf8,pin:{path:'compact-feature-journal/source-inputs/'+sourcePins[key].sha256+'.json',...sourcePins[key]}};if(keepInputs)inputs[key]=input;if(ownedOptions.requireParsedTargetBinding&&key!=='facts')semanticInputs[key]=input;}
   let parsedTargetBinding=null;
   if(ownedOptions.requireParsedTargetBinding){
    if(!ownedOptions.decisionAt)fail('parsed_target_decision_required');
    const inspected=Object.values(semanticInputs).map(x=>inspectBoundedJsonSource(x.utf8,{maxBytes:x===semanticInputs.target?262144:2*1024**2})),parseLease=reserve(inspected.reduce((n,x)=>n+x.estimatedParsedBytes,0)*3+65536,'parsed_target');
    try{
     if(header.mode==='PRE'){
      const read=readPrematchHistoryTargetInput({targetInput:semanticInputs.target,decisionAt:ownedOptions.decisionAt});let seriesId=null,requiredInputAvailableAt=read.validFrom;
      if(semanticInputs.series){const context=produceSeriesContext({seriesInput:semanticInputs.series,decisionAt:ownedOptions.decisionAt}),raw=JSON.parse(semanticInputs.series.utf8);if(context.terminal||![raw.team1Id,raw.team2Id].every(id=>[read.target.teams.radiant,read.target.teams.dire].includes(id))||raw.previousMaps.some(m=>String(m.mapId)===read.target.matchId))fail('parsed_prematch_series_binding');seriesId=raw.seriesId;if(instantNs(raw.availableAt)>instantNs(requiredInputAvailableAt))requiredInputAvailableAt=raw.availableAt;}
      parsedTargetBinding={kind:'map_prematch',matchId:read.target.matchId,seriesId,mapSides:read.target.teams,historyCutoffAt:read.historyCutoffAt,validFrom:read.validFrom,requiredInputAvailableAt,sourceTargetSha256:sourcePins.target.sha256,originalAvailabilityAuthenticated:false};
     }else{
      const read=readSeriesHistoryTargetInput({targetInput:semanticInputs.target,decisionAt:ownedOptions.decisionAt}),s=semanticInputs.series;if(!s||read.target.phase!==(header.mode==='BETWEEN'?'SERIES_BETWEEN':'SERIES_PRE'))fail('parsed_series_mode_or_receipt');
      const context=produceSeriesContext({seriesInput:s,decisionAt:ownedOptions.decisionAt}),raw=JSON.parse(s.utf8);
      if(context.terminal||raw.seriesId!==read.target.seriesId||raw.team1Id!==read.target.team1Id||raw.team2Id!==read.target.team2Id||raw.completeThroughMapNumber!==read.historyMapCount||instantNs(read.target.lastSeriesReceiptAt)!==instantNs(raw.availableAt))fail('parsed_series_identity_or_transition');
      const requiredInputAvailableAt=instantNs(raw.availableAt)>instantNs(read.validFrom)?raw.availableAt:read.validFrom;
      parsedTargetBinding={kind:'series_history',matchId:null,seriesId:read.target.seriesId,team1Id:read.target.team1Id,team2Id:read.target.team2Id,transitionId:read.target.transitionId,identityRevision:read.target.identityRevision,historyCutoffAt:read.historyCutoffAt,validFrom:read.validFrom,requiredInputAvailableAt,sourceTargetSha256:sourcePins.target.sha256,seriesDerivationVerified:false,originalAvailabilityAuthenticated:false};
     }
     validateParsedTarget(parsedTargetBinding,ownedOptions);
    }finally{parseLease.release();}
   }
   await proceed();if(!keepInputs){sourceLease.release();sourceLease=null;}
   const result=mint(freeze(header),ref,sourceLease,keepInputs?inputs:null,parsedTargetBinding);sourceLease=null;return result;
  }finally{sourceLease?.release();manifestParseLease?.release();manifestLease.release();}
 }
 return Object.freeze({contract:COMPACT_HISTORICAL_INPUT_STORE_CONTRACT,
  async writeHistoricalInputs(raw={}){
   const args=snapshotPlainRecord(raw,{maxKeys:7}),minimumSupport=supportOf(args.minimumSupport,args.minSupport);if(!MODES.includes(args.mode)||Object.keys(args).some(k=>!['mode','factsInput','targetInput','seriesInput','minimumSupport','minSupport'].includes(k)))fail('input_mode');
   const inputs={facts:inputOf(args.factsInput,cfg),target:inputOf(args.targetInput,cfg),...((args.seriesInput===null||args.seriesInput===undefined)?{}:{series:inputOf(args.seriesInput,cfg)})};
   const total=Object.values(inputs).reduce((n,p)=>n+p.pin.bytes,0);if(total>cfg.maxSourceBytes)fail('source_bound');const lease=reserve(total*8+65536,'write');let reference;
   try{
    const pins={},blobs={};let chunkCount=0;
    for(const [key,input]of Object.entries(inputs)){await proceed();if(sha(input.utf8)!==input.pin.sha256||Buffer.from(input.utf8,'utf8').toString('utf8')!==input.utf8)fail('source_hash_or_utf8');inspectBoundedJsonSource(input.utf8,{maxBytes:cfg.maxInputBytes});pins[key]={sha256:input.pin.sha256,bytes:input.pin.bytes};blobs[key]=await writeBlob(input);chunkCount+=blobs[key].chunks.length;if(chunkCount>cfg.maxChunks)fail('chunk_count');}
    const header={contract:HEADER,mode:args.mode,inputs:pins,calculationOptions:{minimumSupport}},body={contract:BODY,header,blobs,sourceAvailabilityIndependentlyAttested:false,...flags},utf8=canonical(body),ref=await commit(MANIFEST,utf8,cfg.maxManifestBytes);reference=freeze({contract:COMPACT_HISTORICAL_INPUT_REFERENCE_CONTRACT,...ref});
   }finally{lease.release();}
   const result=await load(reference,{mode:args.mode,historicalBindings:{factsSha256:inputs.facts.pin.sha256,targetSha256:inputs.target.pin.sha256},seriesReceiptPin:inputs.series?.pin??null},false);return Object.freeze({status:'committed_and_dependencies_verified',...result});
  },
  verifyHistoricalInputs(reference,options={}){return load(reference,options,false);},
  loadHistoricalInputs(reference,options={}){return load(reference,options,true);},
  status(){return {contract:COMPACT_HISTORICAL_INPUT_STORE_CONTRACT,activeProofs:active.size,closed,limits:cfg,resourceArena:arena.status()};},
  close(){if(closed)return false;closed=true;for(const proof of [...active])proofs.get(proof).release();return true;}
 });
}
