import test from 'node:test';import assert from 'node:assert/strict';import{createHash}from'node:crypto';
import{createGlobalSeriesSplitInventory}from'./paged-dataset-manifest.mjs';
import{preparePagedEstimatorSamples}from'./paged-sample-preparation.mjs';
import{hashFeatureAsset}from'../steam-live-collector/source-adapter/featureProjectionOwnership.mjs';
import{createDiagnosticResourceArena}from'../steam-live-collector/source-adapter/diagnosticResourceArena.mjs';
const H='a'.repeat(64),J='b'.repeat(64),K='c'.repeat(64),at=(m,d=1)=>`2026-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}T00:00:00Z`;
function fixture(){
 const arena=createDiagnosticResourceArena({maxBytes:256*1024**2}),inventory=createGlobalSeriesSplitInventory({series:[{seriesId:'s1',componentId:'c1',mapIds:['m1','m2'],predictionStartAt:at(1,9),startAt:at(1,10),endAt:at(1,11),availableAt:at(1,12)}],splits:['train','tune','early_stop','holdout'].map((role,i)=>({role,startAt:at(i+1),endAt:at(i+2)})),createdAt:at(5),resourceArena:arena}),blobs=new Map();
 const pin=(body,kind)=>{const utf8=JSON.stringify(body),sha256=createHash('sha256').update(utf8).digest('hex');blobs.set(sha256,utf8);return{kind,sha256,bytes:Buffer.byteLength(utf8)};};
 const contract=tag=>{const h={contract:'aegis.feature-function-contract.v1',definitionEncoding:'fixture',parameterClassificationContract:'aegis.feature-parameter-classification.v1',targetId:'LIVE_MAP_WIN',stateMode:'LIVE',registrySha256:H,featureCount:2,orderedDefinitionIdsSha256:H,orderedSemanticsSha256:tag,projectionPolicy:'fixture',semanticInputs:null};return{...h,sha256:hashFeatureAsset(h),producerCompatibilitySha256:H,rowParameterBindingsSha256:J,generalized:true,unclassifiedDefinitionCount:0};};
 const c=contract(H),row={rowId:'r1',seriesId:'s1',mapId:'m1',splitRole:'train',functionContractSha256:c.sha256,featureCount:2,producerCompatibilitySha256:H,rawProvenance:'observed_live',featureProvenance:'replayed_derived',historyProvenance:'original_receipts',decisionAt:at(1,10),featureReadyAt:at(4),labelKnownAt:at(1,12),matchStartAt:at(1,10),rawReceivedAt:at(1,10),historyKnownAt:at(1,8),vectorRef:{kind:'feature-row-vector-v1',sha256:H,bytes:1},rowBindingRef:{kind:'feature-row-binding-v1',sha256:J,bytes:1},labelRef:{kind:'separate-target-label-v1',sha256:K,bytes:1},valuesSha256:H,maskSha256:J};
 const page=rows=>pin({contract:'aegis.feature-dataset-row-page.v1',globalSplitSha256:inventory.handle.sha256,targetId:'LIVE_MAP_WIN',stateMode:'LIVE',profileId:'fixture',rows},'feature-dataset-row-page-v1');
 const args={inventoryHandle:inventory.handle,targetId:'LIVE_MAP_WIN',stateMode:'LIVE',profileId:'fixture',functionContracts:[pin(c,'feature-function-contract-v1')],readPinned:p=>blobs.get(p.sha256),writePinned:({reference,utf8})=>{blobs.set(reference.sha256,utf8);return reference;},resourceArena:arena};
 return{args,row,page,pin,contract,blobs,close(){inventory.close();assert.equal(arena.status().chargedBytes,0);}};
}
test('same estimator shares weights across diagnostic schemas and child OOF artifacts while retaining row lineage',async()=>{
 const f=fixture();try{const rows=[{...f.row,diagnosticSchemaSha256:H,childStateId:'fold-1'},{...f.row,rowId:'r2',diagnosticSchemaSha256:J,childStateId:'fold-2'}],out=await preparePagedEstimatorSamples({...f.args,rowPages:[f.page(rows)]}),saved=JSON.parse(f.blobs.get(out.samplePages[0].sha256));assert.deepEqual(saved.rows.map(r=>r.weight),[0.5,0.5]);assert.equal(saved.rows[0].estimatorId,saved.rows[1].estimatorId);assert.deepEqual(saved.rows.map(r=>r.childStateId),['fold-1','fold-2']);assert.equal(out.actualOutputPageBytesReadBack,true);assert.equal(out.trainingAdmitted,false);}finally{f.close();}
});
test('different coordinate contracts never silently merge estimators',async()=>{
 const f=fixture();try{const c=f.contract(J),ref=f.pin(c,'feature-function-contract-v1'),out=await preparePagedEstimatorSamples({...f.args,functionContracts:[...f.args.functionContracts,ref],rowPages:[f.page([f.row,{...f.row,rowId:'r2',functionContractSha256:c.sha256}])]}),saved=JSON.parse(f.blobs.get(out.samplePages[0].sha256));assert.deepEqual(saved.rows.map(r=>r.weight),[1,1]);assert.notEqual(saved.rows[0].estimatorId,saved.rows[1].estimatorId);}finally{f.close();}
});
test('STOP or changed persisted output bytes cannot produce a completed preparation',async()=>{
 const f=fixture();try{await assert.rejects(preparePagedEstimatorSamples({...f.args,rowPages:[f.page([f.row])],shouldContinue:()=>false}),/stopped/);await assert.rejects(preparePagedEstimatorSamples({...f.args,rowPages:[f.page([f.row])],writePinned:({reference})=>{f.blobs.set(reference.sha256,'{}');return reference;}}),/pinned_byte_mismatch/);}finally{f.close();}
});
test('one series unit is divided across maps then their repeated samples',async()=>{
 const f=fixture();try{const out=await preparePagedEstimatorSamples({...f.args,rowPages:[f.page([f.row,{...f.row,rowId:'r2',mapId:'m2'},{...f.row,rowId:'r3',mapId:'m2'}])]}),saved=JSON.parse(f.blobs.get(out.samplePages[0].sha256));assert.deepEqual(saved.rows.map(r=>r.weight),[0.5,0.25,0.25]);}finally{f.close();}
});
test('continuation permission changing to null after writing fails closed',async()=>{
 const f=fixture();let permission=true;try{await assert.rejects(preparePagedEstimatorSamples({...f.args,rowPages:[f.page([f.row])],shouldContinue:()=>permission,writePinned:({reference,utf8})=>{f.blobs.set(reference.sha256,utf8);permission=null;return reference;}}),/stopped/);}finally{f.close();}
});

test('finite monotonic wall limit is checked after delayed callbacks and before completion',async()=>{
 const f=fixture();try{
  for(const maxWallMs of [0,-1,NaN,Infinity,1200001])await assert.rejects(preparePagedEstimatorSamples({...f.args,rowPages:[],maxWallMs}),/configuration/);
  await assert.rejects(preparePagedEstimatorSamples({...f.args,rowPages:[f.page([f.row])],maxWallMs:5,readPinned:async p=>{await new Promise(r=>setTimeout(r,15));return f.args.readPinned(p);}}),/wall_time_bound/);
  let didWrite=false;await assert.rejects(preparePagedEstimatorSamples({...f.args,rowPages:[f.page([f.row])],maxWallMs:200,writePinned:async p=>{didWrite=true;await new Promise(r=>setTimeout(r,250));return f.args.writePinned(p);}}),/wall_time_bound/);assert.equal(didWrite,true);
 }finally{f.close();}
});
