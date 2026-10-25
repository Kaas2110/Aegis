import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createOwnedArtifactWriterLeaseProvider} from './artifactWriterLease.mjs';
import {createPersistentArtifactWriter} from './persistentArtifactWriter.mjs';
import {createRetainedReferenceCorpus as create,restoreRetainedReferenceCorpus as restore,readRetainedReferenceCorpusHandle as readHandle,materializeRetainedReferenceHistory as materialize,readRetainedReferenceHistory as readView} from './retainedReferenceCorpus.mjs';
import {deriveHistoricalFactVersionV2,pinRetainedHistoryJson as pin} from './retainedOpenDotaFacts.mjs';
import {createRetainedHistorySourceExport as oldSource} from './retainedHistorySourceExport.mjs';
import {draftArgs,draftEntry} from './observedDraftHistory.fixtures.mjs';
import {createDynamicHistoryProof} from './observedDraftFeatureBundle.mjs';
import {createUnifiedFeatureProducer} from './unifiedFeatureProducer.mjs';
import {syntheticRegistry} from '../../feature-registry/registry-contract.fixtures.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex'),AT='2026-10-24T12:00:00Z',clock=()=>AT;
function version({matchId=101,receivedAt='2026-10-20T12:00:00Z',hero=1,account=900,team=700,series={times:[0,60],gold_t:[600,1200]},padding=''}={}){
 const payload=JSON.parse(pin({match_id:matchId,start_time:1792494000,duration:1800,radiant_win:true,radiant_team_id:team,dire_team_id:800,radiant_score:25,dire_score:10,padding,players:[{player_slot:0,hero_id:hero,account_id:account,gold_per_min:600,kills:10,deaths:2,assists:3,...series}]}).utf8);
 const selectedInput=pin({schemaVersion:1,source:'opendota',endpoint:'https://api.opendota.com/api/matches/'+matchId,matchId,receivedAt,availabilityBasis:'collector_response_receipt',payloadKind:'selected_match_detail_v1',payloadSha256:sha(JSON.stringify(payload)),payload});return deriveHistoricalFactVersionV2({selectedInput}).versionInput;
}
async function fixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'aegis-reference-corpus-r5-'));let held=false;
 const leaseProvider=createOwnedArtifactWriterLeaseProvider({acquireExclusive:async()=>{if(held)throw Error('synthetic_busy');held=true;return{assertHeld:async()=>{if(!held)throw Error('synthetic_lost');},release:async()=>{held=false;}};}});
 const writer=await createPersistentArtifactWriter({directory,leaseProvider});t.after(async()=>{await writer.close();await fs.rm(directory,{recursive:true,force:true});});return{directory,writer};
}
const target=()=>{const a=draftArgs({accounts:true});return {matchId:a.matchId,draftPrefixInputs:a.draftPrefixInputs};};
const body=view=>JSON.parse(view.compatibility.envelopeInput.utf8);

test('generation retains all versions, null retractions and identity epochs; copied token is untrusted',async t=>{
 const {writer}=await fixture(t),versions=[version(),version({receivedAt:'2026-10-21T12:00:00Z',hero:200}),version({receivedAt:'2026-10-22T12:00:00Z',series:{times:null}})];
 const corpus=await create({artifactStore:writer,versionInputs:versions,clock});assert.equal(corpus.descriptor.versionCount,3);assert.equal(corpus.descriptor.clockBlockCount,3);assert.ok(corpus.descriptor.tombstoneOrInvalidCount>=1);
 assert.throws(()=>readHandle(structuredClone(corpus.handle)),/owned_generation_required/);
 const view=await materialize({corpusHandle:corpus.handle,...target()});assert.equal(view.status,'dense_compatibility_ready');assert.equal(view.descriptor.selection.versionCount,3);
 const facts=JSON.parse(body(view).factsInput.utf8);assert.equal(facts.maps[0].fieldAvailability['/players/0/clock_series'].status,'explicit_null');
 const restored=await restore({artifactStore:writer,manifestReference:corpus.manifestReference,clock});assert.equal(restored.descriptor.versionCount,3);const loaded=await readView({corpusHandle:restored.handle,envelopeReference:view.envelopeReference,decisionAt:AT});assert.equal(loaded.compatibility.sourceSnapshotHash,view.compatibility.sourceSnapshotHash);
});

test('conservative meta union includes unrelated maps, generic hero maps and an older changed identity',async t=>{
 const {writer}=await fixture(t),versions=[version({matchId:111,hero:1,account:900,team:700}),version({matchId:112,hero:200,account:901,team:701}),version({matchId:113,hero:1,account:902,team:702}),version({matchId:113,receivedAt:'2026-10-21T12:00:00Z',hero:200,account:903,team:703})];
 const corpus=await create({artifactStore:writer,versionInputs:versions,clock}),view=await materialize({corpusHandle:corpus.handle,...target()});
 assert.deepEqual(view.descriptor.selection.mapIds,['111','112','113']);assert.deepEqual(view.descriptor.selection.entityMatchedMapIds,['111','113']);assert.equal(view.descriptor.selection.versionCount,4);assert.equal(view.descriptor.selection.genericHeroPopulationRestrictedToTargetTeams,false);assert.equal(view.descriptor.selection.metaPopulation,'all_local_retained_maps_with_any_version_by_original_cutoff');
 const maps=JSON.parse(body(view).factsInput.utf8).maps;assert.equal(maps.find(m=>m.matchId==='113').heroes[0].heroId,200);assert.equal(maps.find(m=>m.matchId==='111').radiantTeamId,'700');
});

test('deferred target IO keeps one owned draft prefix and scope; t1 disclosure never advances t0',async t=>{
 const {writer}=await fixture(t);let deferRead=false,release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 const port={contract:writer.contract,commit:input=>writer.commit(input),inspect:()=>writer.inspect(),async read(ref){if(deferRead){deferRead=false;entered();await gate;}return writer.read(ref);}};
 const corpus=await create({artifactStore:port,versionInputs:[version(),version({matchId:102,receivedAt:'2026-10-23T12:05:00Z'})],clock}),draftPrefixInputs=[draftEntry({time:'2026-10-23T11:58:00Z'}),draftEntry({accounts:true,time:'2026-10-23T12:10:00Z'})],expectedPrefix=structuredClone(draftPrefixInputs),scope={population:'original_local_population'};
 deferRead=true;const pending=materialize({corpusHandle:corpus.handle,matchId:'90001',draftPrefixInputs,scope});await started;
 const replacement=draftEntry({accounts:true,time:'2026-10-23T12:20:00Z'});for(const name of ['rawInput','metadataInput']){draftPrefixInputs[0][name].utf8=replacement[name].utf8;Object.assign(draftPrefixInputs[0][name].pin,replacement[name].pin);}draftPrefixInputs.splice(1);scope.population='mutated_population';release();
 const view=await pending,source=body(view);assert.equal(view.status,'dense_compatibility_ready');assert.equal(view.descriptor.historyCutoffAt,'2026-10-23T11:58:00Z');assert.equal(view.descriptor.validFrom,'2026-10-23T12:10:00Z');assert.deepEqual(view.descriptor.selection.mapIds,['101']);assert.deepEqual(source.draftPrefixInputs,expectedPrefix);assert.deepEqual(source.scope,{population:'original_local_population'});assert.equal(JSON.parse(source.factsInput.utf8).maps.some(map=>map.matchId==='102'),false);
 const restored=await readView({corpusHandle:corpus.handle,envelopeReference:view.envelopeReference,decisionAt:AT});assert.equal(restored.compatibility.sourceSnapshotHash,view.compatibility.sourceSnapshotHash);
});

test('current and future-only maps are excluded from views, but corrupt excluded bytes fail full restore',async t=>{
 const {writer,directory}=await fixture(t),versions=[version(),version({matchId:90001}),version({matchId:102,receivedAt:'2026-10-24T10:00:00Z'})],corpus=await create({artifactStore:writer,versionInputs:versions,clock});
 const view=await materialize({corpusHandle:corpus.handle,...target()});assert.equal(view.descriptor.selection.currentMapVersionsExcluded,1);assert.equal(view.descriptor.selection.futureVersionsNotUsedForSelectorDiscovery,1);assert.deepEqual(view.descriptor.selection.mapIds,['101']);
 const manifest=JSON.parse(await writer.read(corpus.manifestReference)),part=JSON.parse(await writer.read(manifest.parts[0])),future=part.entries.find(e=>e.summary.matchId==='102'),ref=future.blob.chunks[0];
 await fs.writeFile(path.join(directory,'objects',ref.sha256+'.blob'),'x'.repeat(ref.bytes));await assert.rejects(restore({artifactStore:writer,manifestReference:corpus.manifestReference,clock}),/object_integrity|artifact_bytes/);
});

test('manifest assertions cannot mint proof when a version summary is changed and rehashed',async t=>{
 const {writer}=await fixture(t),corpus=await create({artifactStore:writer,versionInputs:[version()],clock}),manifest=JSON.parse(await writer.read(corpus.manifestReference)),part=JSON.parse(await writer.read(manifest.parts[0]));part.entries[0].summary.heroIds=[200];
 const put=async(kind,data)=>{const utf8=JSON.stringify(data);return writer.commit({kind,utf8,expectedSha256:sha(utf8)});};
 manifest.parts[0]=await put('retained-corpus-part-v2',part);const changed=await put('retained-corpus-generation-v2',manifest);
 await assert.rejects(restore({artifactStore:writer,manifestReference:changed,clock}),/summary_or_duplicate/);
});

test('failed/STOP intake never commits a generation manifest or returns a proof handle',async t=>{
 const {writer}=await fixture(t);let running=true;
 async function* inputs(){yield version();running=false;yield version({matchId:102});}
 await assert.rejects(create({artifactStore:writer,versionInputs:inputs(),clock,shouldContinue:()=>running}),/stopped/);
 assert.ok((await writer.inspect()).committedArtifacts>0);const records=await writer.listCommitted({kind:'retained-corpus-generation-v2'});assert.equal(records.length,0);
});

test('small reference view passes the actual producer with exact old dense vectors and bindings',async t=>{
 const {writer}=await fixture(t),versions=Array.from({length:5},(_,i)=>version({matchId:101+i})),corpus=await create({artifactStore:writer,versionInputs:versions,clock}),a={...draftArgs({accounts:true}),computedAt:AT},view=await materialize({corpusHandle:corpus.handle,...target()}),old=oldSource({...a,exportedAt:AT,versionInputs:versions});
 assert.equal(view.compatibility.envelopeInput.utf8,old.envelopeInput.utf8);const b=body(view),history=createDynamicHistoryProof({...a,factsInput:b.factsInput,nativeInput:b.nativeInput,availabilityBasis:'retained_receipt_reconstruction'},{includeInspectionCopies:false});
 const [index,familyDocument,targetDocument]=syntheticRegistry(),producer=createUnifiedFeatureProducer({index,familyDocument,targetDocument,sourceInventory:Object.fromEntries(['history','live','series','draft','seriesHistory'].map(k=>[k,{primarySha256:'a'.repeat(64),files:[{path:k+'.mjs',sha256:'a'.repeat(64)}]}]))});
 const base={mode:'POST',matchId:a.matchId,decisionAt:AT,historyProof:history.proof,expectedSourceSnapshotHash:old.sourceSnapshotHash},left=producer.generateFeatureBundle({...base,sourceExportInput:old.envelopeInput}),right=producer.generateFeatureBundle({...base,sourceExportHandle:view.compatibility.sourceExportHandle});
 for(const k of ['sourceSnapshotHash','historyContextHash','historyCutoffAt','availableAt'])assert.equal(right[k],left[k],k);assert.equal(left.routes.length,right.routes.length);
 for(let j=0;j<left.routes.length;j++)for(const field of ['names','values','missing']){const x=left.routes[j].diagnosticVector[field],y=right.routes[j].diagnosticVector[field];assert.equal(y.length,x.length);for(let i=0;i<x.length;i++)assert.equal(y[i],x[i],field+':'+i);}
});

test('generation above64MiB is stored/replayed in bounded parts; oversized target marks reducer pending',async t=>{
 const {writer}=await fixture(t),padding='x'.repeat(5*1024*1024);
 async function* inputs(){for(let i=0;i<14;i++)yield version({matchId:200+i,padding});}
 const corpus=await create({artifactStore:writer,versionInputs:inputs(),clock});assert.equal(corpus.descriptor.versionCount,14);assert.ok(corpus.descriptor.totalVersionBytes>64*1024*1024);
 const view=await materialize({corpusHandle:corpus.handle,...target()});assert.equal(view.status,'bounded_reducer_pending');assert.equal(view.reason,'target_version_bytes_exceed_unchanged_dense_guard');assert.equal(view.eligibleForTraining,false);assert.equal(Object.hasOwn(view,'compatibility'),false);
 assert.ok((await writer.inspect()).effectiveBytes<=256*1024*1024);
});
