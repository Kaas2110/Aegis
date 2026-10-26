/** Bounded extension of the paged dataset factory. No fit, scoring, model import
 * or source authority. Compatible estimator coordinates group diagnostic rows;
 * per-row child-state/OOF lineage remains attached rather than becoming a shard. */
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {createPagedTargetDatasetShard,readGlobalSeriesSplitInventoryPage} from './paged-dataset-manifest.mjs';
import {createDiagnosticResourceArena} from '../steam-live-collector/source-adapter/diagnosticResourceArena.mjs';
import {inspectBoundedJsonSource} from '../steam-live-collector/source-adapter/boundedJsonSource.mjs';
const fail=x=>{throw Error('paged_samples:'+x);},sha=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const MiB=1024**2;
export async function preparePagedEstimatorSamples({writePinned,maxWallMs=1200000,...args}={}){
 if(typeof writePinned!=='function'||!Array.isArray(args.rowPages)||args.rowPages.length>4096||typeof args.readPinned!=='function'||!Number.isFinite(maxWallMs)||maxWallMs<=0||maxWallMs>1200000)fail('configuration');
 const started=performance.now();
 const arena=args.resourceArena??createDiagnosticResourceArena(),work=arena.reserve(96*MiB);if(!work)fail('memory_admission');
 const leases=[],groups=new Map(),outputs=[];let groupCount=0;
 const shouldContinue=args.shouldContinue??(()=>true);if(typeof shouldContinue!=='function'){work.release();fail('continuation_port');}
 const proceed=()=>{readGlobalSeriesSplitInventoryPage(args.inventoryHandle,{offset:0,limit:1});if(shouldContinue()!==true)fail('stopped');if(performance.now()-started>maxWallMs)fail('wall_time_bound');};
 async function read(ref){proceed();const utf8=await args.readPinned(ref);proceed();if(typeof utf8!=='string'||Buffer.byteLength(utf8)!==ref.bytes||sha(utf8)!==ref.sha256)fail('pinned_byte_mismatch');inspectBoundedJsonSource(utf8,{maxBytes:16*MiB,maxNodes:1000000});return JSON.parse(utf8);}
 try{
  const dataset=await createPagedTargetDatasetShard({...args,resourceArena:arena,maxWallMs,shouldContinue:()=>{proceed();return true;}}),functions=new Map(dataset.functionContracts.map(f=>[f.sha256,f]));
  const estimator=r=>{const f=functions.get(r.functionContractSha256);if(!f)fail('function_binding');return sha({contract:'aegis.stable-estimator-coordinate.v1',targetId:dataset.targetId,stateMode:dataset.stateMode,profileId:dataset.profileId,functionContractSha256:r.functionContractSha256,producerCompatibilitySha256:f.producerCompatibilitySha256});};
  const groupKey=r=>JSON.stringify([estimator(r),r.splitRole,r.seriesId]);
  // Pass1 counts actual samples across ALL diagnostic schema/row instances.
  // Every retained group/map is admitted before insertion; no dense matrix.
  for(const ref of dataset.rowPages){const p=await read(ref);for(const r of p.rows){const key=groupKey(r);let g=groups.get(key);const map=JSON.stringify(r.mapId);if(!g||!g.has(map)){if(groupCount%512===0){const l=arena.reserve(512*2048);if(!l)fail('group_memory_admission');leases.push(l);}groupCount++;if(groupCount>dataset.rows)fail('group_bound');if(!g){g=new Map();groups.set(key,g);}g.set(map,0);}g.set(map,g.get(map)+1);}}
  const root=createHash('sha256');let rows=0;
  // Pass2 retains exact immutable lineage fields, adding only stable estimator
  // identity and declared equal-series/map/sample weights. Child OOF IDs do not
  // alter estimator coordinates. Coordinate-changing encoders need another
  // verified function contract, never a guessed alias in this module.
  for(const ref of dataset.rowPages){const p=await read(ref),prepared=p.rows.map(r=>{const g=groups.get(groupKey(r)),count=g?.get(JSON.stringify(r.mapId));if(!count)fail('weight_group');rows++;return{...r,estimatorId:estimator(r),weight:1/(g.size*count)};});
   const body={contract:'aegis.prepared-estimator-sample-page.v1',datasetSha256:dataset.sha256,globalSplitSha256:dataset.globalSplitSha256,targetId:dataset.targetId,stateMode:dataset.stateMode,profileId:dataset.profileId,rows:prepared},utf8=JSON.stringify(body),expected={kind:'prepared-estimator-sample-page-v1',sha256:sha(utf8),bytes:Buffer.byteLength(utf8)};if(expected.bytes>16*MiB)fail('output_page_bound');
   proceed();const written=await writePinned({reference:expected,utf8});proceed();if(!written||written.kind!==expected.kind||written.sha256!==expected.sha256||written.bytes!==expected.bytes)fail('output_pin');await read(expected);outputs.push(expected);root.update(JSON.stringify(expected));
  }
  proceed();if(rows!==dataset.rows)fail('row_count_changed');
  return Object.freeze({contract:'aegis.paged-estimator-preparation.v1',dataset,rows,samplePages:outputs,orderedSamplePagesSha256:root.digest('hex'),maximumWallMs:maxWallMs,asyncCallbackHardCancellation:'requires_host_owned_process_or_abort_contract',weightPolicy:'one_unit_per_series_then_equal_maps_then_selected_samples_within_stable_estimator_profile_role',stableEstimatorGroups:groups.size,stableMapGroups:groupCount,rawAxesAndChildStateLineagePreserved:true,actualOutputPageBytesReadBack:true,durableStorageAttested:false,privateSourceProofVerified:false,trainingAdmitted:false,qualityEvaluationPerformed:false,modelFits:0});
 }finally{for(const l of leases)l.release();groups.clear();work.release();}
}
