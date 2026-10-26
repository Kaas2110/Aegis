/** Versioned bounded preparation alongside the unchanged v1/v2 forensic reader.
 * Reuses chronological series assignment. Contracts are pinned once, not repeated
 * 150K-column schemas per row. Byte verification is distinct from source proof. */
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {isProxy} from 'node:util/types';
import {assignChronologicalSeriesSplits,FEATURE_PREPARATION_MODES} from './pinned-dataset-manifest.mjs';
import {instantNs} from '../steam-live-collector/source-adapter/causalTime.mjs';
import {createDiagnosticResourceArena,snapshotPlainRecord,measureBoundedJsonBytes} from '../steam-live-collector/source-adapter/diagnosticResourceArena.mjs';
import {inspectBoundedJsonSource} from '../steam-live-collector/source-adapter/boundedJsonSource.mjs';
import {hashFeatureAsset} from '../steam-live-collector/source-adapter/featureProjectionOwnership.mjs';
export const GLOBAL_SPLIT_INVENTORY_CONTRACT='aegis.global-series-split-inventory.v1';
export const PAGED_TARGET_DATASET_CONTRACT='aegis.paged-target-dataset.v1';
const H=/^[a-f0-9]{64}$/,text=x=>typeof x==='string'&&x.length>0&&x.length<=256;
const fail=x=>{throw Error('paged_dataset:'+x);},hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const inventories=new WeakMap(),roles=['train','tune','early_stop','holdout'];
const flags=Object.freeze({trainingAdmitted:false,qualityEvaluationPerformed:false,privateSourceProofVerified:false,originalAvailabilityAttested:false});
function pin(raw,kind){const r=snapshotPlainRecord(raw,{maxKeys:3});if(Object.keys(r).sort().join(',')!=='bytes,kind,sha256'||r.kind!==kind||!H.test(r.sha256??'')||!Number.isSafeInteger(r.bytes)||r.bytes<1||r.bytes>16*1024**2)fail('pin');return Object.freeze({...r});}
function time(value){const t=instantNs(value);if(t===null)fail('time');return t;}
/** Admit the compact inventory envelope before the legacy allocator clones it.
 * The old public assignment API is unchanged; this new bounded path accepts
 * only its explicitly consumed scalar fields and the <=5 literal map IDs. */
function admitSplitInputs(series,splits,createdAt){
 const bytes=measureBoundedJsonBytes({series,splits,createdAt},{maxBytes:128*1024**2,maxNodes:2000000,maxDepth:4});
 if(!text(createdAt)||!Array.isArray(splits)||splits.length!==4)fail('inventory_input_contract');
 const required=['seriesId','componentId','mapIds','predictionStartAt','startAt','endAt','availableAt'],allowed=new Set([...required,'splitRole','purgeReason','holdoutInspected']);
 for(const raw of series){
  const s=snapshotPlainRecord(raw,{maxKeys:10});
  if(required.some(k=>!Object.hasOwn(s,k))||Object.keys(s).some(k=>!allowed.has(k))||required.filter(k=>k!=='mapIds').some(k=>!text(s[k]))||!Array.isArray(s.mapIds)||s.mapIds.length<1||s.mapIds.length>5||s.mapIds.some(id=>!text(id)))fail('inventory_series_contract');
  if(Object.hasOwn(s,'splitRole')&&![...roles,'purged'].includes(s.splitRole)||Object.hasOwn(s,'purgeReason')&&!text(s.purgeReason)||Object.hasOwn(s,'holdoutInspected')&&typeof s.holdoutInspected!=='boolean')fail('inventory_series_contract');
 }
 for(const raw of splits){const s=snapshotPlainRecord(raw,{maxKeys:3});if(Object.keys(s).sort().join(',')!=='endAt,role,startAt'||!roles.includes(s.role)||!text(s.startAt)||!text(s.endAt))fail('inventory_split_contract');}
 return bytes;
}
export function createGlobalSeriesSplitInventory({series,splits,createdAt,resourceArena=null}={}){
 if(!Array.isArray(series)||isProxy(series)||series.length<1||series.length>100000)fail('series_bound');
 const inputBytes=admitSplitInputs(series,splits,createdAt);
 const arena=resourceArena??createDiagnosticResourceArena(),lease=arena.reserve(series.length*2048+inputBytes*4+65536);if(!lease)fail('memory_admission');
 try{
  const assigned=assignChronologicalSeriesSplits({series,splits,createdAt}),byId=new Map(assigned.map(s=>[s.seriesId,s])),root=createHash('sha256');root.update(JSON.stringify({contract:GLOBAL_SPLIT_INVENTORY_CONTRACT,createdAt,splits}));
  for(const s of assigned)root.update(hash(s));
  const handle=Object.freeze({contract:GLOBAL_SPLIT_INVENTORY_CONTRACT,sha256:root.digest('hex'),seriesCount:assigned.length,createdAt,...flags});
  const entry={assigned,byId,lease,active:true};inventories.set(handle,entry);
  return Object.freeze({handle,readPage:options=>inventoryPage(entry,options),close(){if(!entry.active)return false;entry.active=false;inventories.delete(handle);lease.release();return true;}});
 }catch(e){lease.release();throw e;}
}
function retained(handle){const e=inventories.get(handle);if(!e?.active)fail('owned_global_inventory_required');return e;}
function inventoryPage(entry,{offset=0,limit=100}={}){const{assigned}=entry;if(!entry.active||!Number.isInteger(offset)||offset<0||offset>assigned.length||!Number.isInteger(limit)||limit<1||limit>100)fail('inventory_page');const end=Math.min(offset+limit,assigned.length);return{offset,nextOffset:end<assigned.length?end:null,series:assigned.slice(offset,end)};}
/** Bounded access to actual owned component membership, for sample preparation.
 * A structurally identical/copied handle cannot recover inventory authority. */
export function readGlobalSeriesSplitInventoryPage(handle,options){return inventoryPage(retained(handle),options);}
/** Reads actual pinned page bytes. Source/private row verification and any learned
 * child-state proof must still pass separate gates before a model can consume it. */
export async function createPagedTargetDatasetShard({inventoryHandle,targetId,stateMode,profileId,functionContracts,rowPages,readPinned,resourceArena=null,shouldContinue=()=>true,maxRows=1000000,maxPages=4096,maxWallMs=1200000}={}){
 if(!Number.isFinite(maxWallMs)||maxWallMs<=0||maxWallMs>1200000)fail('configuration');const started=performance.now();
 const inv=retained(inventoryHandle);if(!FEATURE_PREPARATION_MODES.some(m=>m.targetId===targetId&&m.stateMode===stateMode)||!text(profileId)||typeof readPinned!=='function'||typeof shouldContinue!=='function'||!Array.isArray(functionContracts)||!functionContracts.length||functionContracts.length>64||!rowPages||typeof rowPages[Symbol.iterator]!=='function'&&typeof rowPages[Symbol.asyncIterator]!=='function'||!Number.isInteger(maxRows)||maxRows<1||maxRows>1000000||!Number.isInteger(maxPages)||maxPages<1||maxPages>4096)fail('configuration');
 const arena=resourceArena??createDiagnosticResourceArena(),work=arena.reserve(96*1024**2);if(!work)fail('memory_admission');
 const contractByHash=new Map(),pages=[],counts=Object.fromEntries(roles.map(r=>[r,0])),provenanceCounts={},sourceProofGates=new Set(),seenIds=new Set(),vectorPins=new Set(),bindingPins=new Set(),labelPins=new Set(),identityLeases=[],calendar=Object.fromEntries(roles.map(r=>[r,{minMatchStartAt:null,maxMatchStartAt:null,minDecisionAt:null,maxDecisionAt:null,maxLabelKnownAt:null}]));let rows=0;
 const proceed=()=>{retained(inventoryHandle);if(shouldContinue()!==true)fail('stopped');if(performance.now()-started>maxWallMs)fail('wall_time_bound');};
 async function read(ref,kind){proceed();const p=pin(ref,kind),utf8=await readPinned(p);proceed();if(typeof utf8!=='string'||Buffer.byteLength(utf8)!==p.bytes||hash(utf8)!==p.sha256)fail('pinned_byte_mismatch');inspectBoundedJsonSource(utf8,{maxBytes:16*1024**2,maxNodes:1000000});return{pin:p,body:JSON.parse(utf8)};}
 function range(role,field,value,maximum=false){const c=calendar[role],old=c[field];if(old===null||(maximum?time(value)>time(old):time(value)<time(old)))c[field]=value;}
 try{
  for(const reference of functionContracts){const{pin:p,body:c}=await read(reference,'feature-function-contract-v1');const header=Object.fromEntries(['contract','definitionEncoding','parameterClassificationContract','targetId','stateMode','registrySha256','featureCount','orderedDefinitionIdsSha256','orderedSemanticsSha256','projectionPolicy','semanticInputs'].map(k=>[k,c[k]]));if(c.contract!=='aegis.feature-function-contract.v1'||!H.test(c.sha256??'')||hashFeatureAsset(header)!==c.sha256||c.targetId!==targetId||c.stateMode!==stateMode||!Number.isInteger(c.featureCount)||c.featureCount<1||c.featureCount>300000||c.generalized!==true||c.unclassifiedDefinitionCount!==0||!H.test(c.producerCompatibilitySha256??'')||contractByHash.has(c.sha256))fail('function_contract');contractByHash.set(c.sha256,{reference:p,featureCount:c.featureCount,producerCompatibilitySha256:c.producerCompatibilitySha256});}
  for await(const reference of rowPages){
   if(pages.length>=maxPages)fail('page_count');const{pin:p,body:page}=await read(reference,'feature-dataset-row-page-v1');
   if(page.contract!=='aegis.feature-dataset-row-page.v1'||page.globalSplitSha256!==inventoryHandle.sha256||page.targetId!==targetId||page.stateMode!==stateMode||page.profileId!==profileId||!Array.isArray(page.rows)||page.rows.length>2000)fail('row_page');
   for(const raw of page.rows){
    proceed();if(++rows>maxRows)fail('row_count');const r=snapshotPlainRecord(raw,{maxKeys:24}),s=inv.byId.get(r.seriesId),fc=contractByHash.get(r.functionContractSha256);
    if(!text(r.rowId)||seenIds.has(r.rowId)||!s||s.splitRole==='purged'||r.splitRole!==s.splitRole||!fc||!s.mapIds.includes(r.mapId)&&!targetId.startsWith('SERIES_')||targetId.startsWith('SERIES_')&&r.mapId!==null&&!s.mapIds.includes(r.mapId)||r.featureCount!==fc.featureCount||r.producerCompatibilitySha256!==fc.producerCompatibilitySha256)fail('row_identity_or_split');
    if(!['observed_live','retrospective_reconstruction','synthetic'].includes(r.rawProvenance)||!['originally_issued','replayed_derived'].includes(r.featureProvenance)||!['original_receipts','reconstructed_asof'].includes(r.historyProvenance))fail('row_provenance_axes');
    const decision=time(r.decisionAt),ready=time(r.featureReadyAt),label=time(r.labelKnownAt),matchStart=time(r.matchStartAt),seriesStart=time(s.startAt),seriesEnd=time(s.endAt);
    // PRE may precede series start. A delayed result receipt cannot extend a
    // prediction horizon beyond the terminal series event; no per-map end is
    // guessed from the enclosing series bounds.
    if(decision<time(s.predictionStartAt)||decision>seriesEnd||matchStart<seriesStart||matchStart>seriesEnd||r.featureProvenance==='originally_issued'&&ready>decision||label<seriesEnd||label>time(s.availableAt)||label>time(inventoryHandle.createdAt)||r.rawProvenance==='observed_live'&&time(r.rawReceivedAt)>decision||r.historyProvenance==='original_receipts'&&time(r.historyKnownAt)>decision)fail('row_availability');
    const vector=pin(r.vectorRef,'feature-row-vector-v1'),binding=pin(r.rowBindingRef,'feature-row-binding-v1'),targetLabel=pin(r.labelRef,'separate-target-label-v1');
    // Isolate feature/binding pins from labels across the ENTIRE shard, in both
    // arrival orders and across page/function boundaries, not just within a row.
    if(vector.sha256===targetLabel.sha256||binding.sha256===targetLabel.sha256||labelPins.has(vector.sha256)||labelPins.has(binding.sha256)||vectorPins.has(targetLabel.sha256)||bindingPins.has(targetLabel.sha256))fail('label_feature_colocation');
    if(!H.test(r.valuesSha256??'')||!H.test(r.maskSha256??''))fail('row_value_binding');
    // Bounded row ID plus THREE digest-membership sets. Reserve the worst-case
    // four persisted entries per row before mutating any set (1024-row blocks).
    if(seenIds.size%1024===0){const lease=arena.reserve(2048*1024);if(!lease)fail('identity_memory_admission');identityLeases.push(lease);}seenIds.add(r.rowId);vectorPins.add(vector.sha256);bindingPins.add(binding.sha256);labelPins.add(targetLabel.sha256);counts[s.splitRole]++;provenanceCounts[r.rawProvenance]=(provenanceCounts[r.rawProvenance]??0)+1;sourceProofGates.add(r.rawProvenance+':'+r.historyProvenance+':'+r.featureProvenance);
    range(s.splitRole,'minMatchStartAt',r.matchStartAt);range(s.splitRole,'maxMatchStartAt',r.matchStartAt,true);range(s.splitRole,'minDecisionAt',r.decisionAt);range(s.splitRole,'maxDecisionAt',r.decisionAt,true);range(s.splitRole,'maxLabelKnownAt',r.labelKnownAt,true);
   }
   pages.push(p);
  }
  proceed();const body={contract:PAGED_TARGET_DATASET_CONTRACT,globalSplitSha256:inventoryHandle.sha256,targetId,stateMode,profileId,functionContracts:[...contractByHash].map(([sha256,c])=>({sha256,...c})),rowPages:pages,counts,rows,provenanceCounts,calendar,maximumWallMs:maxWallMs,asyncCallbackHardCancellation:'requires_host_owned_process_or_abort_contract',sourceProofProfiles:[...sourceProofGates].sort(),columnBoundPolicy:'300000 per qualified function contract; no aggregate descriptor repetition across row instances',requiredBeforeTraining:['feature_data_coverage','actual_source_and_private_row_proof','label_bytes_and_fold_lineage','architecture_review','explicit_training_authorization'],pinnedPageBytesVerified:true,pinnedRowDependenciesVerified:false,...flags};
  return Object.freeze({...body,sha256:hash(body)});
 }finally{for(const lease of identityLeases)lease.release();work.release();}
}
