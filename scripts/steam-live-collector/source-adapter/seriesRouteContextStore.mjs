/** Owned series routing context, not a source authenticity or prediction proof.
 * Storage is a bounded host CAS port; no URL or filesystem path is accepted.
 * Write revision first, immutable current-pointer record last. The host must
 * recover its latest committed pointer from the writer journal after restart. */
import {createHash} from 'node:crypto';
import {produceSeriesContext} from './seriesContextFeatures.mjs';
import {instantNs} from './causalTime.mjs';
export const SERIES_ROUTE_STORE_CONTRACT='aegis.series-route-context-store.v1';
export const SERIES_ROUTE_REVISION_KIND='series-context-revision-v1';
export const SERIES_ROUTE_POINTER_KIND='series-context-pointer-v1';
const REVISION='aegis.series-route-context-revision.v1',POINTER='aegis.series-route-context-pointer.v1';
const SHA=/^[a-f0-9]{64}$/,SID=/^[A-Za-z0-9_.:-]{1,128}$/,ID=/^[1-9]\d{0,19}$/;
const PHASES=['SERIES_PRE','BETWEEN','PRE','POST','LIVE','COMPLETE'],RANK={PRE:0,POST:1,LIVE:2};
const flags={diagnosticOnly:true,eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false,publicPromotion:false};
const sha=x=>createHash('sha256').update(x).digest('hex');
const fail=reason=>{throw Error('series_route_context_store:'+reason);};
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){for(const v of Object.values(x))freeze(v);Object.freeze(x);}return x;};
function shape(x,keys,required=keys){
 if(!x||typeof x!=='object'||Array.isArray(x)||![Object.prototype,null].includes(Object.getPrototypeOf(x))||Object.getOwnPropertySymbols(x).length)fail('plain_object_required');
 const ds=Object.getOwnPropertyDescriptors(x);if(Object.keys(ds).some(k=>!keys.includes(k)||!Object.hasOwn(ds[k],'value'))||required.some(k=>!Object.hasOwn(ds,k)))fail('object_keys_or_accessor');
 return x;
}
function reference(ref,kind=null){shape(ref,['kind','sha256','bytes']);if(typeof ref.kind!=='string'||!/^series-context-(revision|pointer)-v1$/.test(ref.kind)||kind!==null&&ref.kind!==kind||typeof ref.sha256!=='string'||!SHA.test(ref.sha256)||!Number.isSafeInteger(ref.bytes)||ref.bytes<1||ref.bytes>(ref.kind===SERIES_ROUTE_POINTER_KIND?4096:6*1024*1024))fail('artifact_reference');return{kind:ref.kind,sha256:ref.sha256,bytes:ref.bytes};}
const equalRef=(a,b)=>a===null||b===null?a===b:a.kind===b.kind&&a.sha256===b.sha256&&a.bytes===b.bytes;
function pinned(input,maxBytes){
 shape(input,['utf8','pin']);shape(input.pin,['path','bytes','sha256']);
 if(typeof input.utf8!=='string'||input.utf8.length>maxBytes||typeof input.pin.path!=='string'||input.pin.path.length<1||input.pin.path.length>4096||!Number.isSafeInteger(input.pin.bytes)||input.pin.bytes<1||input.pin.bytes>maxBytes||typeof input.pin.sha256!=='string'||!SHA.test(input.pin.sha256))fail('pinned_input_bound');
 const bytes=Buffer.byteLength(input.utf8);if(bytes>maxBytes||bytes!==input.pin.bytes||sha(input.utf8)!==input.pin.sha256)fail('pinned_input_bytes');
 return{utf8:input.utf8,pin:{path:'series-receipts/'+input.pin.sha256+'.json',bytes,sha256:input.pin.sha256}};
}
function validateReceipt(input,decisionAt,currentMap,phase){
 const data=JSON.parse(input.utf8);shape(data,['contract','seriesId','team1Id','team2Id','bestOf','availableAt','completeThroughMapNumber','previousMaps']);
 if(!Array.isArray(data.previousMaps)||data.previousMaps.length>5)fail('map_prefix_bound');
 for(const map of data.previousMaps)shape(map,['mapId','mapNumber','winnerTeamId','durationSeconds','team1Kills','team2Kills','finishedAt','availableAt','team1Heroes','team2Heroes']);
 if(!PHASES.includes(phase))fail('phase');
 if(currentMap!==null){shape(currentMap,['mapId','mapNumber']);if(typeof currentMap.mapId!=='string'||!ID.test(currentMap.mapId)||!Number.isInteger(currentMap.mapNumber))fail('current_map');}
 if(['PRE','POST','LIVE'].includes(phase)!==(currentMap!==null))fail('phase_map_identity');
 const series=produceSeriesContext({seriesInput:input,decisionAt,currentMapId:currentMap?.mapId??null,currentMapNumber:currentMap?.mapNumber??null});
 if(phase==='SERIES_PRE'&&(series.sourceMapIds.length!==0||series.terminal)||phase==='BETWEEN'&&(series.sourceMapIds.length===0||series.terminal)||(phase==='COMPLETE')!==series.terminal)fail('phase_series_progress');
 return{data,series};
}
const mapFacts=map=>Object.fromEntries(['mapId','mapNumber','winnerTeamId','durationSeconds','team1Kills','team2Kills','finishedAt','team1Heroes','team2Heroes'].map(k=>[k,Array.isArray(map[k])?[...map[k]].sort((a,b)=>a-b):map[k]]));
const factKey=map=>JSON.stringify(mapFacts(map));
const receiptMeaning=data=>JSON.stringify({contract:data.contract,seriesId:data.seriesId,team1Id:data.team1Id,team2Id:data.team2Id,bestOf:data.bestOf,availableAt:data.availableAt,completeThroughMapNumber:data.completeThroughMapNumber,previousMaps:data.previousMaps.map(map=>({...mapFacts(map),availableAt:map.availableAt}))});
function validateTransition(previous,next){
 if(previous===null){if(next.correctionInput!==null)fail('initial_correction_without_parent');return;}
 const old=previous.context,n=next.context,a=JSON.parse(old.seriesInput.utf8),b=JSON.parse(n.seriesInput.utf8);
 if(a.seriesId!==b.seriesId||a.team1Id!==b.team1Id||a.team2Id!==b.team2Id)fail('known_series_identity_change_requires_review');
 if(instantNs(next.preparedAt)<instantNs(previous.preparedAt)||instantNs(b.availableAt)<instantNs(a.availableAt))fail('availability_regression');
 const changedReceipt=old.seriesInput.pin.sha256!==n.seriesInput.pin.sha256;
 if(changedReceipt&&instantNs(b.availableAt)===instantNs(a.availableAt)&&receiptMeaning(a)!==receiptMeaning(b))fail('same_time_series_receipt_conflict');
 if(b.previousMaps.length<a.previousMaps.length)fail('completed_prefix_regression');
 let corrected=a.bestOf!==b.bestOf;
 for(let i=0;i<a.previousMaps.length;i++){
  if(a.previousMaps[i].mapId!==b.previousMaps[i].mapId)fail('known_map_prefix_identity_change_requires_review');
  if(instantNs(b.previousMaps[i].availableAt)<instantNs(a.previousMaps[i].availableAt))fail('prior_map_availability_regression');
  corrected=corrected||factKey(a.previousMaps[i])!==factKey(b.previousMaps[i]);
 }
 if(old.phase==='COMPLETE'&&n.phase!=='COMPLETE')fail('terminal_series_cannot_reopen');
 if(old.currentMap!==null){
  if(b.previousMaps.length>=old.currentMap.mapNumber){if(b.previousMaps[old.currentMap.mapNumber-1].mapId!==old.currentMap.mapId)fail('completed_current_map_identity_conflict');}
  else if(n.currentMap===null||n.currentMap.mapId!==old.currentMap.mapId||n.currentMap.mapNumber!==old.currentMap.mapNumber)fail('known_current_map_retraction_or_replacement');
  else if(RANK[n.phase]<RANK[old.phase])fail('current_map_phase_regression');
 }
 if(corrected){
  if(next.correctionInput===null)fail('explicit_linked_correction_required');
  const c=JSON.parse(next.correctionInput.utf8);shape(c,['contract','seriesId','supersedesSeriesReceiptSha256','availableAt','reason']);
  if(c.contract!=='aegis.series-route-correction-receipt.v1'||c.seriesId!==b.seriesId||c.supersedesSeriesReceiptSha256!==old.seriesInput.pin.sha256||typeof c.reason!=='string'||c.reason.length<1||c.reason.length>256||instantNs(c.availableAt)===null||instantNs(c.availableAt)<=instantNs(a.availableAt)||instantNs(c.availableAt)>instantNs(b.availableAt))fail('correction_receipt_binding');
  // A corrected receipt cannot inherit any model/feature trace from its old
  // context. Router later verifies any newly supplied traces against new bytes.
  if(n.seriesTraceSha256!==null&&n.seriesTraceSha256===old.seriesTraceSha256||n.mapTraceSha256!==null&&n.mapTraceSha256===old.mapTraceSha256)fail('correction_reuses_prior_trace');
 }else if(next.correctionInput!==null)fail('correction_without_changed_known_fact');
}
export function createSeriesRouteContextStore({storage,now=()=>new Date().toISOString(),shouldContinue=()=>true,limits={}}={}){
 if(typeof storage?.commit!=='function'||typeof storage?.read!=='function'||typeof now!=='function'||typeof shouldContinue!=='function')fail('owned_ports_required');
 shape(limits,['maxSeries','maxPending','maxReceiptBytes','maxRestoreDepth','maxRestoreBytes'],[]);
 const config={maxSeries:64,maxPending:4,maxReceiptBytes:2*1024*1024,maxRestoreDepth:2048,maxRestoreBytes:32*1024*1024,...limits},ceilings={maxSeries:256,maxPending:8,maxReceiptBytes:2*1024*1024,maxRestoreDepth:4096,maxRestoreBytes:64*1024*1024};
 for(const[k,v]of Object.entries(config))if(!Number.isSafeInteger(v)||v<1||v>ceilings[k])fail('limit');
 const slots=new Map(),resolvedContexts=new WeakMap();let tail=Promise.resolve(),pending=0;
 const continuing=()=>{try{return shouldContinue()===true;}catch{return false;}};
 const check=()=>{if(!continuing())fail('manual_stop_or_abort');};
 function prepare(input){
  shape(input,['seriesInput','phase','currentMap','seriesTraceSha256','mapTraceSha256','correctionInput'],['seriesInput','phase']);
  if(!PHASES.includes(input.phase))fail('phase');
  if(input.currentMap!==undefined&&input.currentMap!==null){shape(input.currentMap,['mapId','mapNumber']);if(typeof input.currentMap.mapId!=='string'||!ID.test(input.currentMap.mapId)||!Number.isSafeInteger(input.currentMap.mapNumber)||input.currentMap.mapNumber<1||input.currentMap.mapNumber>5)fail('current_map');}
  const context={seriesInput:pinned(input.seriesInput,config.maxReceiptBytes),phase:input.phase,currentMap:input.currentMap===undefined||input.currentMap===null?null:{...shape(input.currentMap,['mapId','mapNumber'])},seriesTraceSha256:input.seriesTraceSha256??null,mapTraceSha256:input.mapTraceSha256??null};
  for(const h of [context.seriesTraceSha256,context.mapTraceSha256])if(h!==null&&(typeof h!=='string'||!SHA.test(h)))fail('trace_reference');
  if(context.currentMap===null&&context.mapTraceSha256!==null)fail('map_trace_without_current_map');
  return freeze({context,correctionInput:input.correctionInput===undefined||input.correctionInput===null?null:pinned(input.correctionInput,16384)});
 }
 async function commitArtifact(kind,value){check();const utf8=JSON.stringify(value),expectedSha256=sha(utf8),expected=reference({kind,sha256:expectedSha256,bytes:Buffer.byteLength(utf8)},kind),committed=reference(await storage.commit({kind,utf8,expectedSha256}),kind);if(!equalRef(expected,committed))fail('artifact_commit_receipt');return freeze(committed);}
 async function readArtifact(ref,budget){check();reference(ref);budget.bytes+=ref.bytes;if(budget.bytes>config.maxRestoreBytes)fail('restore_bytes_bound');const utf8=await storage.read(ref);check();if(typeof utf8!=='string'||utf8.length>ref.bytes||Buffer.byteLength(utf8)!==ref.bytes||sha(utf8)!==ref.sha256)fail('artifact_read_bytes');return JSON.parse(utf8);}
 function enqueue(operation){check();if(pending>=config.maxPending)fail('pending_bound');pending++;const promise=tail.catch(()=>{}).then(()=>{check();return operation();});tail=promise;return promise.finally(()=>{pending--;});}
 async function update(owned){
  check();const preparedAt=now();if(instantNs(preparedAt)===null)fail('owned_clock');
  const {data}=validateReceipt(owned.context.seriesInput,preparedAt,owned.context.currentMap,owned.context.phase),old=slots.get(data.seriesId)??null;
  if(old?.uncertainPointer)fail('pointer_outcome_unknown_requires_recovery');
  if(old===null&&slots.size>=config.maxSeries)fail('series_bound');
  const revision={contract:REVISION,seriesId:data.seriesId,ordinal:(old?.record.ordinal??0)+1,parentPointer:old?.pointerRef??null,preparedAt,context:owned.context,correctionInput:owned.correctionInput};
  validateTransition(old?.record??null,revision);
  if(old&&JSON.stringify(old.record.context)===JSON.stringify(owned.context)&&owned.correctionInput===null)return{status:'existing_current_context',seriesId:data.seriesId,pointerRef:old.pointerRef,revisionRef:old.revisionRef,ordinal:old.record.ordinal,...flags};
  const revisionRef=await commitArtifact(SERIES_ROUTE_REVISION_KIND,revision);check();
  const pointer={contract:POINTER,seriesId:data.seriesId,ordinal:revision.ordinal,revisionRef,previousPointer:old?.pointerRef??null},pointerUtf8=JSON.stringify(pointer),expectedPointer=freeze({kind:SERIES_ROUTE_POINTER_KIND,sha256:sha(pointerUtf8),bytes:Buffer.byteLength(pointerUtf8)});
  // The pointer commit may succeed even if its callback fails. Preserve its
  // expected immutable identity and block retries/resolution until owned repair.
  const slot={record:old?.record??null,pointerRef:old?.pointerRef??null,revisionRef:old?.revisionRef??null,uncertainPointer:expectedPointer};slots.set(data.seriesId,slot);
  const pointerRef=await commitArtifact(SERIES_ROUTE_POINTER_KIND,pointer);check();
  slots.set(data.seriesId,{record:freeze(revision),revisionRef,pointerRef,uncertainPointer:null});
  return{status:'committed_current_context',seriesId:data.seriesId,ordinal:revision.ordinal,revisionRef,pointerRef,...flags};
 }
 async function restore(ref){
  const budget={bytes:0},chain=[],seen=new Set();let next=ref,seriesId=null;
  while(next!==null){
   if(chain.length>=config.maxRestoreDepth||seen.has(next.sha256))fail('pointer_chain_bound_or_cycle');seen.add(next.sha256);
   const pointer=await readArtifact(next,budget);shape(pointer,['contract','seriesId','ordinal','revisionRef','previousPointer']);
   if(pointer.contract!==POINTER||typeof pointer.seriesId!=='string'||!SID.test(pointer.seriesId)||!Number.isSafeInteger(pointer.ordinal)||pointer.ordinal<1||seriesId!==null&&seriesId!==pointer.seriesId)fail('pointer_contract');seriesId=pointer.seriesId;
   reference(pointer.revisionRef,SERIES_ROUTE_REVISION_KIND);if(pointer.previousPointer!==null)reference(pointer.previousPointer,SERIES_ROUTE_POINTER_KIND);
   const record=await readArtifact(pointer.revisionRef,budget);shape(record,['contract','seriesId','ordinal','parentPointer','preparedAt','context','correctionInput']);
   if(record.contract!==REVISION||record.seriesId!==seriesId||record.ordinal!==pointer.ordinal||!equalRef(record.parentPointer,pointer.previousPointer))fail('revision_pointer_binding');
   const prepared=prepare({...record.context,correctionInput:record.correctionInput});if(JSON.stringify(prepared.context)!==JSON.stringify(record.context)||JSON.stringify(prepared.correctionInput)!==JSON.stringify(record.correctionInput))fail('noncanonical_context');
   validateReceipt(record.context.seriesInput,record.preparedAt,record.context.currentMap,record.context.phase);
   chain.push({pointerRef:next,revisionRef:pointer.revisionRef,record});next=pointer.previousPointer;
  }
  if(!chain.length)fail('empty_pointer_chain');let previous=null;
  for(const entry of [...chain].reverse()){if(entry.record.ordinal!==(previous?.ordinal??0)+1)fail('revision_ordinal_gap');validateTransition(previous,entry.record);previous=entry.record;}
  const old=slots.get(seriesId),head=chain[0],required=old?.uncertainPointer??old?.pointerRef??null;
  if(required&&!chain.some(entry=>equalRef(entry.pointerRef,required)))fail('restore_rollback_or_fork');
  if(!old&&slots.size>=config.maxSeries)fail('series_bound');check();
  const restoreAt=instantNs(now());if(restoreAt===null||instantNs(head.record.preparedAt)>restoreAt)fail('restore_future_context');
  slots.set(seriesId,{record:freeze(head.record),revisionRef:freeze(head.revisionRef),pointerRef:freeze(head.pointerRef),uncertainPointer:null});
  return{status:'restored_current_context',seriesId,ordinal:head.record.ordinal,pointerRef:head.pointerRef,revisionRef:head.revisionRef,verifiedRevisions:chain.length,verifiedBytes:budget.bytes,...flags};
 }
 return Object.freeze({
  contract:SERIES_ROUTE_STORE_CONTRACT,
  commitContext(input){try{check();if(pending>=config.maxPending)fail('pending_bound');const owned=prepare(input);return enqueue(()=>update(owned));}catch(error){return Promise.reject(error);}},
  restorePointer(ref){try{const owned=freeze(reference(ref,SERIES_ROUTE_POINTER_KIND));return enqueue(()=>restore(owned));}catch(error){return Promise.reject(error);}},
  resolve(input={}){
   check();shape(input,['seriesId','selection'],['seriesId']);const {seriesId,selection={kind:'entry'}}=input;if(typeof seriesId!=='string'||!SID.test(seriesId))fail('series_id');const slot=slots.get(seriesId);if(!slot)return null;if(slot.uncertainPointer)fail('pointer_outcome_unknown_requires_recovery');
   shape(selection,['kind','mapId'],['kind']);if(!['entry','manual'].includes(selection.kind)||selection.kind==='entry'&&Object.hasOwn(selection,'mapId')||selection.kind==='manual'&&(typeof selection.mapId!=='string'||!ID.test(selection.mapId)))fail('selection');
   const c=slot.record.context,at=now();if(instantNs(at)===null||instantNs(at)<instantNs(slot.record.preparedAt))fail('resolve_clock_regression');const {data}=validateReceipt(c.seriesInput,at,c.currentMap,c.phase);
   if(selection.kind==='manual'&&selection.mapId!==c.currentMap?.mapId&&!data.previousMaps.some(map=>map.mapId===selection.mapId))fail('selected_map_not_in_series');
   const resolved=freeze({...structuredClone(c),selection:structuredClone(selection)});resolvedContexts.set(resolved,{seriesId,pointerRef:slot.pointerRef});return resolved;
  },
  // The host retains this exact object across awaited journal/router IO and
  // checks it synchronously at its response boundary. A clone is not a token.
  isCurrentContext(resolved){
   if(!continuing()||!resolved||typeof resolved!=='object')return false;
   const owned=resolvedContexts.get(resolved);if(!owned)return false;
   try{const slot=slots.get(owned.seriesId),at=instantNs(now());return !!slot&&!slot.uncertainPointer&&equalRef(slot.pointerRef,owned.pointerRef)&&at!==null&&at>=instantNs(slot.record.preparedAt);}catch{return false;}
  },
  status(){return{contract:SERIES_ROUTE_STORE_CONTRACT,pending,series:slots.size,limits:{...config},tracked:[...slots].map(([seriesId,slot])=>({seriesId,ordinal:slot.record?.ordinal??null,pointerRef:slot.pointerRef,uncertainPointer:slot.uncertainPointer})),...flags};}
 });
}
