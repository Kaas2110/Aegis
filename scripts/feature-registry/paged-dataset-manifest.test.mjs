import test from 'node:test';import assert from 'node:assert/strict';import{createHash}from'node:crypto';
import{createGlobalSeriesSplitInventory,createPagedTargetDatasetShard,readGlobalSeriesSplitInventoryPage}from'./paged-dataset-manifest.mjs';
import{hashFeatureAsset}from'../steam-live-collector/source-adapter/featureProjectionOwnership.mjs';
import{createDiagnosticResourceArena}from'../steam-live-collector/source-adapter/diagnosticResourceArena.mjs';
const H='a'.repeat(64),J='b'.repeat(64),K='c'.repeat(64),at=(month,day=1)=>`2026-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}T00:00:00Z`;
const source={seriesId:'s1',componentId:'c1',mapIds:['m1'],predictionStartAt:at(1,9),startAt:at(1,10),endAt:at(1,11),availableAt:at(1,12)},splits=['train','tune','early_stop','holdout'].map((role,i)=>({role,startAt:at(i+1),endAt:at(i+2)}));

test('paged shard refuses elapsed monotonic wall after a delayed pinned read',async()=>{
 const f=setup();try{for(const maxWallMs of [0,-1,NaN,Infinity,1200001])await assert.rejects(createPagedTargetDatasetShard({...f.args,rowPages:[],maxWallMs}),/configuration/);await assert.rejects(createPagedTargetDatasetShard({...f.args,rowPages:[f.page([f.row])],maxWallMs:5,readPinned:async p=>{await new Promise(r=>setTimeout(r,15));return f.args.readPinned(p);}}),/wall_time_bound/);}finally{f.close();}
});
const contract=(variant=0,targetId='LIVE_MAP_WIN',stateMode='LIVE')=>{const h={contract:'aegis.feature-function-contract.v1',definitionEncoding:'fixture',parameterClassificationContract:'aegis.feature-parameter-classification.v1',targetId,stateMode,registrySha256:H,featureCount:150553+variant,orderedDefinitionIdsSha256:H,orderedSemanticsSha256:variant?J:H,projectionPolicy:'fixture',semanticInputs:null};return{...h,sha256:hashFeatureAsset(h),producerCompatibilitySha256:H,rowParameterBindingsSha256:J,generalized:true,unclassifiedDefinitionCount:0};};
function setup(targetId='LIVE_MAP_WIN',stateMode='LIVE'){const arena=createDiagnosticResourceArena({maxBytes:256*1024**2}),inventory=createGlobalSeriesSplitInventory({series:[source],splits,createdAt:at(5),resourceArena:arena}),blobs=new Map();const pin=(body,kind)=>{const utf8=JSON.stringify(body),sha256=createHash('sha256').update(utf8).digest('hex');blobs.set(sha256,utf8);return{kind,sha256,bytes:Buffer.byteLength(utf8)};};const c=contract(0,targetId,stateMode),cp=pin(c,'feature-function-contract-v1');const row={rowId:'r1',seriesId:'s1',mapId:'m1',splitRole:'train',functionContractSha256:c.sha256,featureCount:c.featureCount,producerCompatibilitySha256:H,rawProvenance:'observed_live',featureProvenance:'replayed_derived',historyProvenance:'original_receipts',decisionAt:at(1,10),featureReadyAt:at(4),labelKnownAt:at(1,12),matchStartAt:at(1,10),rawReceivedAt:at(1,10),historyKnownAt:at(1,8),vectorRef:{kind:'feature-row-vector-v1',sha256:H,bytes:1},rowBindingRef:{kind:'feature-row-binding-v1',sha256:J,bytes:1},labelRef:{kind:'separate-target-label-v1',sha256:K,bytes:1},valuesSha256:H,maskSha256:J};const page=rows=>pin({contract:'aegis.feature-dataset-row-page.v1',globalSplitSha256:inventory.handle.sha256,targetId,stateMode,profileId:'fixture',rows},'feature-dataset-row-page-v1');const args={inventoryHandle:inventory.handle,targetId,stateMode,profileId:'fixture',functionContracts:[cp],readPinned:p=>blobs.get(p.sha256),resourceArena:arena};return{arena,inventory,args,pin,page,row,blobs,close(){inventory.close();assert.equal(arena.status().chargedBytes,0);}};}
test('two full function contracts exceed legacy aggregate columns without duplicating definitions',async()=>{const f=setup();try{const second=contract(1),ref=f.pin(second,'feature-function-contract-v1'),r=await createPagedTargetDatasetShard({...f.args,functionContracts:[...f.args.functionContracts,ref],rowPages:[f.page([f.row,{...f.row,rowId:'r2',functionContractSha256:second.sha256,featureCount:second.featureCount}])]});assert.equal(r.functionContracts.reduce((s,c)=>s+c.featureCount,0)>300000,true);assert.equal(r.rows,2);assert.equal(r.pinnedPageBytesVerified,true);assert.equal(r.pinnedRowDependenciesVerified,false);assert.equal(r.trainingAdmitted,false);assert.equal(r.calendar.train.minMatchStartAt,at(1,10));}finally{f.close();}});
test('page bytes, global split and model function cannot be declared into validity',async()=>{const f=setup();try{const ref=f.page([f.row]);f.blobs.set(ref.sha256,'{}');await assert.rejects(createPagedTargetDatasetShard({...f.args,rowPages:[ref]}),/pinned_byte_mismatch/);const ref2=f.page([{...f.row,functionContractSha256:K}]);await assert.rejects(createPagedTargetDatasetShard({...f.args,rowPages:[ref2]}),/row_identity_or_split/);}finally{f.close();}});
test('replayed derived materialization may be later, original issuance and labels cannot cross boundaries',async()=>{const f=setup();try{await createPagedTargetDatasetShard({...f.args,rowPages:[f.page([f.row])]});await assert.rejects(createPagedTargetDatasetShard({...f.args,rowPages:[f.page([{...f.row,featureProvenance:'originally_issued'}])]}),/row_availability/);await assert.rejects(createPagedTargetDatasetShard({...f.args,rowPages:[f.page([{...f.row,labelKnownAt:at(2,3)}])]}),/row_availability/);}finally{f.close();}});
test('same row repeated across pages refuses and all row memory releases',async()=>{const f=setup();try{const ref=f.page([f.row]);await assert.rejects(createPagedTargetDatasetShard({...f.args,rowPages:[ref,ref]}),/row_identity_or_split/);}finally{f.close();}});
test('linked series crossing split purges together and closed global handle is unusable',async()=>{const arena=createDiagnosticResourceArena({maxBytes:256*1024**2}),inv=createGlobalSeriesSplitInventory({series:[source,{...source,seriesId:'s2',mapIds:['m2'],predictionStartAt:at(2,9),startAt:at(2,10),endAt:at(2,11),availableAt:at(2,12)}],splits,createdAt:at(5),resourceArena:arena});assert.deepEqual(inv.readPage().series.map(s=>s.splitRole),['purged','purged']);inv.close();assert.equal(arena.status().chargedBytes,0);assert.throws(()=>inv.readPage(),/inventory_page/);});

test('compact global inventory rejects unknown series and split payloads before legacy cloning or arena ownership',()=>{
 const arena=createDiagnosticResourceArena({maxBytes:16*1024**2});
 for(const args of [{series:[{...source,payload:'x'.repeat(8192)}],splits},{series:[source],splits:splits.map((s,i)=>i?s:{...s,payload:{hidden:'x'}})},{series:[{...source,mapIds:[{id:'m1'}]}],splits}]){
  assert.throws(()=>createGlobalSeriesSplitInventory({...args,createdAt:at(5),resourceArena:arena}),/inventory_(series|split)_contract|diagnostic_size:/);assert.equal(arena.status().chargedBytes,0);
 }
 const inv=createGlobalSeriesSplitInventory({series:[source],splits,createdAt:at(5),resourceArena:arena});
 try{assert.equal(inv.readPage().series[0].seriesId,source.seriesId);assert.equal(Object.isFrozen(inv.readPage().series[0].mapIds),true);}finally{inv.close();assert.equal(arena.status().chargedBytes,0);}
});

test('component page reader requires a genuine active global inventory and preserves bounded immutable membership',()=>{
 const arena=createDiagnosticResourceArena({maxBytes:16*1024**2}),inventory=createGlobalSeriesSplitInventory({series:[source],splits,createdAt:at(5),resourceArena:arena});
 try{
  assert.deepEqual(readGlobalSeriesSplitInventoryPage(inventory.handle),inventory.readPage());
  assert.equal(Object.isFrozen(readGlobalSeriesSplitInventoryPage(inventory.handle).series[0]),true);
  assert.throws(()=>readGlobalSeriesSplitInventoryPage(structuredClone(inventory.handle)),/owned_global_inventory_required/);
  assert.throws(()=>readGlobalSeriesSplitInventoryPage(inventory.handle,{limit:101}),/inventory_page/);
 }finally{inventory.close();assert.equal(arena.status().chargedBytes,0);}
 assert.throws(()=>readGlobalSeriesSplitInventoryPage(inventory.handle),/owned_global_inventory_required/);
});

test('label and input pin sets remain isolated across rows and pages in both arrival directions',async()=>{
 const f=setup();try{
  for(const change of [{vectorRef:{...f.row.vectorRef,sha256:K}},{rowBindingRef:{...f.row.rowBindingRef,sha256:K}},{labelRef:{...f.row.labelRef,sha256:H}},{labelRef:{...f.row.labelRef,sha256:J}}]){
   const second={...f.row,rowId:'r2',vectorRef:{...f.row.vectorRef,sha256:'d'.repeat(64)},rowBindingRef:{...f.row.rowBindingRef,sha256:'e'.repeat(64)},labelRef:{...f.row.labelRef,sha256:'f'.repeat(64)},...change};
   await assert.rejects(createPagedTargetDatasetShard({...f.args,rowPages:[f.page([f.row]),f.page([second])]}),/label_feature_colocation/);
  }
 }finally{f.close();}
});

test('series terminal and actual match-start bounds refuse late rows without rejecting a causal PRE decision',async()=>{
 const f=setup();try{
  for(const change of [{decisionAt:at(1,12)},{matchStartAt:at(1,9)},{matchStartAt:at(1,12)}])await assert.rejects(createPagedTargetDatasetShard({...f.args,rowPages:[f.page([{...f.row,...change}])]}),/row_availability/);
  const allowed=await createPagedTargetDatasetShard({...f.args,rowPages:[f.page([{...f.row,decisionAt:source.endAt}])]});assert.equal(allowed.rows,1);
 }finally{f.close();}
 const pre=setup('PRE_MAP_WIN','PRE');try{
  const result=await createPagedTargetDatasetShard({...pre.args,rowPages:[pre.page([{...pre.row,decisionAt:source.predictionStartAt,rawReceivedAt:source.predictionStartAt}])]});
  assert.equal(result.rows,1);assert.equal(result.trainingAdmitted,false);
 }finally{pre.close();}
});

test('four persisted identity and pin sets receive admission before insertion and release on refusal',async()=>{
 const f=setup();let refused=false;const resourceArena={reserve(bytes){if(bytes===2048*1024){refused=true;return null;}return f.arena.reserve(bytes);}};
 try{await assert.rejects(createPagedTargetDatasetShard({...f.args,resourceArena,rowPages:[f.page([f.row])]}),/identity_memory_admission/);assert.equal(refused,true);}finally{f.close();}
});
