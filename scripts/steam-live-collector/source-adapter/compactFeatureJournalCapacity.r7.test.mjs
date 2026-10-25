/** Capacity routing regressions use actual compiler/codec/journal; memory CAS
 * isolates these contracts, not Windows disk durability or source availability. */
import test from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {syntheticRegistry} from '../../feature-registry/registry-contract.fixtures.mjs';
import {digest,validateRegistry} from '../../feature-registry/registry-contract.mjs';
import {createFeatureProjectionCompiler} from './featureProjectionCompiler.mjs';
import {createDiagnosticResourceArena} from './diagnosticResourceArena.mjs';
import {createCompactFeatureJournal} from './compactFeatureJournal.mjs';
import {createDiagnosticFeatureReadApi} from './diagnosticFeatureReadApi.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
function fixture(profile='R7_FULL300K',{maxBytes=512*1024**2}={}){
 const arena=createDiagnosticResourceArena({maxBytes}),[index,families,targets]=syntheticRegistry();
 const compiler=createFeatureProjectionCompiler({capacityProfile:profile,resourceArena:arena,registry:validateRegistry(index,families,targets),registryHash:digest({index,families,targets}),sourceInventory:{history:{primarySha256:'a'.repeat(64),files:[{path:'synthetic.mjs',sha256:'a'.repeat(64)}]}},sourceProfiles:{history:'synthetic.prior'}});
 const names=['synthetic.zero','synthetic.negative_zero','synthetic.missing'],block=compiler.normalize({names,values:[0,-0,null],masks:[false,false,true],schemaHash:digest(names),definitions:names.map(name=>({name,familyId:'H01',formula:'synthetic fixture only',formulaVersion:'synthetic.v1',units:'fraction',inputScopes:['prior_maps']}))},'history');
 const route=compiler.project([block],'PRE_MAP_WIN','PRE');block.release();
 const bundle={contract:'aegis.unified-diagnostic-feature-producer.v2',mode:'PRE',matchId:'90001',seriesId:null,decisionAt:'2026-10-24T12:00:00Z',historyCutoffAt:'2026-10-24T11:00:00Z',components:{},routes:[route],eligibleForTraining:false,eligibleForServing:false,recordedPrediction:false};
 const objects=new Map(),writer={contract:'aegis.persistent-artifact-writer.v1',async commit(c){assert.equal(sha(c.utf8),c.expectedSha256);const ref={kind:c.kind,sha256:c.expectedSha256,bytes:Buffer.byteLength(c.utf8)};objects.set(ref.sha256,c.utf8);return ref;},async read(ref){const text=objects.get(ref.sha256);if(text===undefined)throw Error('missing_synthetic_object');return text;}};
 const make=(options={})=>createCompactFeatureJournal({allowLegacyByteOnlyStaticHistory:true,writer,resourceArena:arena,assetWorkingBytes:32*1024**2,operationWorkingBytes:8*1024**2,maxWireBytes:1024**2,...options});
 return{arena,compiler,route,bundle,writer,objects,make};
}
for(const profile of ['LEGACY_150K','R7_FULL300K'])test('actual '+profile+' journal rereads matching typed schema and exact row after cold reader restart',async()=>{
 const f=fixture(profile);let journal=f.make(),held=null;
 try{const saved=await journal.appendBundle(f.bundle);assert.equal(saved.routes[0].schemaRef.capacityProfile,profile==='R7_FULL300K'?profile:undefined);await journal.close();journal=f.make();held=await journal.loadTrace(saved.reference);const schema=held.readSchemaPage({targetId:'PRE_MAP_WIN'}),vector=held.readVectorPage({targetId:'PRE_MAP_WIN'});
 try{assert.equal(schema.header.contract,profile==='R7_FULL300K'?'aegis.unified-feature-projection-schema.v2':'aegis.unified-feature-projection-schema.v1');assert.deepEqual(vector.values,[0,-0,null]);assert.deepEqual(vector.missing,[false,false,true]);}finally{schema.release();vector.release();}
 }finally{held?.release();await journal.close();f.route.release();f.compiler.close();}assert.equal(f.arena.status().chargedBytes,0);
});
test('rehashing or caching cannot upgrade legacy artifacts into the full capacity profile',async()=>{
 const f=fixture('LEGACY_150K'),journal=f.make();
 try{const saved=await journal.appendBundle(f.bundle),body=JSON.parse(await f.writer.read(saved.reference));body.routes[0].schemaRef.capacityProfile='R7_FULL300K';const utf8=JSON.stringify(body),ref=await f.writer.commit({kind:saved.reference.kind,utf8,expectedSha256:sha(utf8)});await assert.rejects(journal.loadTrace(ref),/schema_route_binding|capacity_profile|wire_contract/);journal.clearCache();await assert.rejects(journal.loadTrace(ref),/schema_route_binding|capacity_profile|wire_contract/);
 }finally{await journal.close();f.route.release();f.compiler.close();}assert.equal(f.arena.status().chargedBytes,0);
});
test('append rejects forged or omitted route capacity before persistence and without leaking owners',async()=>{
 for(const profile of ['LEGACY_150K','R7_FULL300K']){const f=fixture(profile),journal=f.make();try{const route={...f.route,schemaRef:{...f.route.schemaRef}};if(profile==='LEGACY_150K')route.schemaRef.capacityProfile='R7_FULL300K';else delete route.schemaRef.capacityProfile;await assert.rejects(journal.appendBundle({...f.bundle,routes:[route]}),/schema_route_binding/);const unknown={...f.route,schemaRef:{...f.route.schemaRef,capacityProfile:'unknown'}};await assert.rejects(journal.appendBundle({...f.bundle,routes:[unknown]}),/feature_capacity_profile:unknown_profile/);assert.equal(f.objects.size,0);}finally{await journal.close();f.route.release();f.compiler.close();}assert.equal(f.arena.status().chargedBytes,0);}
});
test('journal default256MiB supports both profiles and rejects a larger configuration',async()=>{
 for(const profile of ['LEGACY_150K','R7_FULL300K']){const f=fixture(profile);let journal;
  try{journal=f.make({maxWireBytes:undefined});const saved=await journal.appendBundle(f.bundle),held=await journal.loadTrace(saved.reference);held.release();assert.throws(()=>f.make({maxWireBytes:256*1024**2+1}),/compact_feature_journal:wire_bound/);}
  finally{await journal?.close();f.route.release();f.compiler.close();}assert.equal(f.arena.status().chargedBytes,0);
 }
});

// These probes use real compiler routes and committed memory-CAS metadata, but
// intentionally no giant payload. A chunk-read sentinel proves exactly which
// typed wire claims pass pre-coalescing admission; it is not a large roundtrip.
for(const probe of [
 {name:'legacy route admits above128MiB under the owner-selected256MiB ceiling',profile:'LEGACY_150K',host:256,wire:128*1024**2+1,reachesChunk:true},
 {name:'omitted FULL marker cannot bypass a smaller caller64MiB ceiling',omitMarker:true,host:64,wire:64*1024**2+1},
 {name:'default host admits FULL above128MiB',wire:128*1024**2+1,reachesChunk:true},
 {name:'smaller explicit32MiB host still caps FULL',host:32,wire:32*1024**2+1},
 {name:'smaller caller128MiB still caps legacy',profile:'LEGACY_150K',host:128,wire:128*1024**2+1},
 {name:'legacy manifest admits above128MiB under the new256MiB ceiling',legacyManifest:true,host:256,wire:128*1024**2+1,reachesChunk:true},
 {name:'FULL route cannot exceed256MiB',host:256,wire:256*1024**2+1},
 {name:'legacy route cannot exceed256MiB',profile:'LEGACY_150K',host:256,wire:256*1024**2+1},
 {name:'legacy manifest keeps a finite256MiB-derived chunk-count bound',legacyManifest:true,host:256,wire:1,chunkCount:Math.ceil(256*1024**2/Math.floor(1024**2/3))+2}
])test('journal preparse profile boundary: '+probe.name,async()=>{
 const f=fixture(probe.profile??'R7_FULL300K',{maxBytes:2*1024**3}),journal=f.make({maxWireBytes:probe.host===undefined?undefined:probe.host*1024**2});let chunkReads=0;
 try{const saved=await journal.appendBundle(f.bundle),body=JSON.parse(await f.writer.read(saved.reference)),chunk={kind:'compact-feature-wire-chunk-v2',sha256:'f'.repeat(64),bytes:1},manifest={contract:'aegis.compact-feature-wire-manifest.v'+(probe.legacyManifest?'2':'3'),kind:'compact-feature-schema-v2',wireSha256:'e'.repeat(64),wireBytes:probe.wire,chunks:Array(probe.chunkCount??1).fill(chunk)},manifestText=JSON.stringify(manifest);
  body.routes[0].schemaArtifact=await f.writer.commit({kind:manifest.kind,utf8:manifestText,expectedSha256:sha(manifestText)});if(probe.omitMarker)delete body.routes[0].schemaRef.capacityProfile;const text=JSON.stringify(body),ref=await f.writer.commit({kind:saved.reference.kind,utf8:text,expectedSha256:sha(text)}),originalRead=f.writer.read;
  f.writer.read=async reference=>{if(reference.kind===chunk.kind){chunkReads++;throw Error('synthetic_chunk_read_probe');}return originalRead(reference);};
  await assert.rejects(journal.loadTrace(ref),probe.reachesChunk?/synthetic_chunk_read_probe/:/compact_feature_journal:asset_manifest/);assert.equal(chunkReads,probe.reachesChunk?1:0);
 }finally{await journal.close();f.route.release();f.compiler.close();}assert.equal(f.arena.status().chargedBytes,0);assert.equal(f.arena.status().leases,0);
});
test('admin request offset admits only the typed full route above the legacy ceiling (synthetic reader port)',async()=>{
 for(const profile of ['LEGACY_150K','R7_FULL300K']){let pageReads=0;const ref={sha256:'a'.repeat(64),namesSha256:'b'.repeat(64),featureCount:150002,...(profile==='R7_FULL300K'?{capacityProfile:profile}:{})},route={targetId:'PRE_MAP_WIN',stateMode:'PRE',schemaRef:ref,featureCount:150002};
 const journal={contract:'aegis.compact-diagnostic-feature-journal.v2',async loadTrace(){return{contract:journal.contract,body:{mode:'PRE',routes:[route]},readSchemaPage(){pageReads++;return{header:{targetId:route.targetId,stateMode:route.stateMode},expandedSchemaHash:ref.sha256,total:150002,definitions:[{name:'synthetic.last'}],release(){}};},readVectorPage(){return{expandedSchemaHash:ref.sha256,total:150002,names:['synthetic.last'],values:[7],missing:[false],nextOffset:null,release(){}};},release(){}};}};
 const api=createDiagnosticFeatureReadApi({journal,enabled:true}),response=await api.handle({url:'/admin/feature-diagnostics/traces/'+ref.sha256+'/features/PRE_MAP_WIN?offset=150001&limit=1'});assert.equal(response.status,profile==='R7_FULL300K'?200:400);assert.equal(pageReads,profile==='R7_FULL300K'?1:0);if(response.status===200)assert.deepEqual(response.body.features,[{index:150001,name:'synthetic.last',value:7,missing:false}]);}
});
