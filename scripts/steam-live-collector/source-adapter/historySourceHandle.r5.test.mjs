import test from 'node:test';
import assert from 'node:assert/strict';
import {draftArgs,pinned,draftEntry} from './observedDraftHistory.fixtures.mjs';
import {createRetainedHistorySourceExport as encode} from './retainedHistorySourceExport.mjs';
import {createVerifiedHistorySourceHandle as mint,readVerifiedHistorySourceHandle as read,MAX_VERIFIED_HISTORY_SOURCE_DESCRIPTOR_BYTES} from './historySourceVerifier.mjs';
import {createDynamicHistoryProof,readDynamicHistoryProof} from './observedDraftFeatureBundle.mjs';
import {createUnifiedFeatureProducer} from './unifiedFeatureProducer.mjs';
import {syntheticRegistry} from '../../feature-registry/registry-contract.fixtures.mjs';

const AT='2026-10-23T12:30:00Z';
function fixture(extra={}){
 const a=draftArgs({accounts:true}),source=encode({...a,versionInputs:[],exportedAt:AT,...extra});
 return{a,source,body:JSON.parse(source.envelopeInput.utf8),options:{matchId:a.matchId,decisionAt:AT,expectedSourceSnapshotHash:source.sourceSnapshotHash}};
}
function producer(){
 const [index,familyDocument,targetDocument]=syntheticRegistry();
 return createUnifiedFeatureProducer({index,familyDocument,targetDocument,sourceInventory:Object.fromEntries(['history','live','series','draft','seriesHistory'].map(k=>[k,{primarySha256:'a'.repeat(64),files:[{path:k+'.mjs',sha256:'a'.repeat(64)}]}]))});
}

test('verified source handle owns bounded immutable descriptor and no envelope/raw/facts payload',()=>{
 const f=fixture(),token=mint(f.source.envelopeInput,f.options),d=read(token,f.options);
 assert.equal(d.sourceSnapshotHash,f.source.sourceSnapshotHash);
 assert.equal(d.factsSha256,f.body.factsInput.pin.sha256);
 assert.equal(d.nativeSha256,f.body.nativeInput.pin.sha256);
 assert.equal(d.descriptorBytes,Buffer.byteLength(JSON.stringify(d)));
 assert.ok(d.descriptorBytes<=MAX_VERIFIED_HISTORY_SOURCE_DESCRIPTOR_BYTES);
 assert.equal(Object.isFrozen(d),true);
 assert.equal(Object.isFrozen(d.identity.selectors),true);
 assert.equal(Object.hasOwn(d,'envelopeInput'),false);
 assert.equal(Object.hasOwn(d,'versionInputs'),false);
 assert.equal(Object.hasOwn(d,'factsInput'),false);
 assert.equal(Object.hasOwn(d,'draftPrefixInputs'),false);
 assert.throws(()=>{d.identity.matchId='2';},TypeError);
});

test('forged/copied handle, wrong map/hash and pre-export decision cannot borrow authority',()=>{
 const f=fixture(),token=mint(f.source.envelopeInput,f.options);
 for(const forged of [structuredClone(token),{contract:token.contract},null])assert.throws(()=>read(forged,f.options),/owned_token_required/);
 assert.throws(()=>read(token,{...f.options,matchId:'22'}),/identity_binding/);
 assert.throws(()=>read(token,{...f.options,expectedSourceSnapshotHash:'b'.repeat(64)}),/identity_binding/);
 assert.throws(()=>read(token,{...f.options,decisionAt:'2026-10-23T12:29:59.999999999Z'}),/not_available_at_decision/);
 assert.throws(()=>mint({...f.source.envelopeInput,utf8:f.source.envelopeInput.utf8+' '},f.options),/envelope_bytes|input_pin|input_bytes/);
 const changed=JSON.parse(f.source.envelopeInput.utf8);changed.population.factsUsable=false;
 const corrupt=pinned(changed);
 assert.throws(()=>mint(corrupt,{...f.options,expectedSourceSnapshotHash:corrupt.pin.sha256}),/derived_or_source_tamper/);
});

test('handle reuse does not touch original intake bytes; a new reload revalidates them',()=>{
 const f=fixture(),owned=structuredClone(f.source.envelopeInput),token=mint(owned,f.options);
 Object.defineProperty(owned,'utf8',{get(){throw Error('source input reread');}});
 for(let i=0;i<100;i++)assert.equal(read(token,f.options).sourceSnapshotHash,f.source.sourceSnapshotHash);
 assert.throws(()=>mint(owned,f.options),/source input reread/);
});

test('later identity revision has its own handle while old t0 context stays unchanged',()=>{
 const f=fixture(),first=mint(f.source.envelopeInput,f.options);
 // Start with anonymous players so late identity really advances the revision.
 const a=draftArgs(),oldSource=encode({...a,versionInputs:[],exportedAt:AT}),oldOpts={...f.options,expectedSourceSnapshotHash:oldSource.sourceSnapshotHash};
 const old=mint(oldSource.envelopeInput,oldOpts),newSource=encode({...a,draftPrefixInputs:[...a.draftPrefixInputs,draftEntry({accounts:true,time:'2026-10-23T12:15:00Z'})],versionInputs:[],exportedAt:AT}),newOpts={...oldOpts,expectedSourceSnapshotHash:newSource.sourceSnapshotHash},next=mint(newSource.envelopeInput,newOpts);
 assert.equal(read(old,oldOpts).identity.historyCutoffAt,read(next,newOpts).identity.historyCutoffAt);
 assert.ok(read(next,newOpts).identity.revision>read(old,oldOpts).identity.revision);
 assert.equal(read(first,f.options).sourceSnapshotHash,f.source.sourceSnapshotHash);
 assert.throws(()=>read(old,newOpts),/identity_binding/);
});

test('actual producer retains exact trace/vector bindings on bytes vs compact handle',()=>{
 const f=fixture(),h=createDynamicHistoryProof({...f.a,factsInput:f.body.factsInput,nativeInput:f.body.nativeInput,availabilityBasis:'retained_receipt_reconstruction'},{includeInspectionCopies:false}),p=producer(),token=mint(f.source.envelopeInput,f.options);
 assert.equal(Object.hasOwn(h,'context'),false);assert.equal(Object.hasOwn(h,'relational'),false);
 const history=readDynamicHistoryProof(h.proof,{matchId:f.a.matchId,decisionAt:AT});assert.equal(history.accepted,true);
 const input={mode:'POST',matchId:f.a.matchId,decisionAt:AT,historyProof:h.proof,expectedSourceSnapshotHash:f.source.sourceSnapshotHash};
 const fromBytes=p.generateFeatureBundle({...input,sourceExportInput:f.source.envelopeInput}),fromHandle=p.generateFeatureBundle({...input,sourceExportHandle:token});
 for(const field of ['sourceSnapshotHash','historyContextHash','historyCutoffAt','availableAt'])assert.equal(fromHandle[field],fromBytes[field],field);
 assert.equal(fromHandle.routes.length,fromBytes.routes.length);
 for(let j=0;j<fromBytes.routes.length;j++){
  const a=fromBytes.routes[j],b=fromHandle.routes[j];assert.equal(b.schemaRef.sha256,a.schemaRef.sha256);
  for(const field of ['names','values','missing']){
   const av=a.diagnosticVector[field],bv=b.diagnosticVector[field];assert.equal(bv.length,av.length);
   for(let i=0;i<av.length;i++)assert.equal(bv[i],av[i],field+' index '+i);
  }
 }
 assert.throws(()=>p.generateFeatureBundle({...input,sourceExportHandle:token,sourceExportInput:f.source.envelopeInput}),/mixed_source_export_authorities/);
});

