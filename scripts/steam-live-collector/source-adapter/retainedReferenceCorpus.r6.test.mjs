import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createOwnedArtifactWriterLeaseProvider} from './artifactWriterLease.mjs';
import {createPersistentArtifactWriter} from './persistentArtifactWriter.mjs';
import {createRetainedReferenceCorpus as create,restoreRetainedReferenceCorpus as restore,materializeRetainedReferenceHistoryV2 as materialize,readRetainedReferenceHistoryV2 as readView,readVerifiedRetainedReferenceSourceHandle as readSource} from './retainedReferenceCorpus.mjs';
import {deriveHistoricalFactVersionV2,pinRetainedHistoryJson as pin} from './retainedOpenDotaFacts.mjs';
import {createRetainedHistorySourceExport as oldSource} from './retainedHistorySourceExport.mjs';
import {draftArgs,draftEntry} from './observedDraftHistory.fixtures.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex'),AT='2026-10-24T12:00:00Z',clock=()=>AT;
function version({matchId=101,receivedAt='2026-10-20T12:00:00Z',hero=1,account=900,series={times:[0,60],gold_t:[600,1200]}}={}){
 const p=JSON.parse(pin({match_id:matchId,start_time:1792494000,duration:1800,radiant_win:true,radiant_team_id:700,dire_team_id:800,radiant_score:25,dire_score:10,players:[{player_slot:0,hero_id:hero,account_id:account,gold_per_min:600,kills:10,deaths:2,assists:3,...series}]}).utf8);
 return deriveHistoricalFactVersionV2({selectedInput:pin({schemaVersion:1,source:'opendota',endpoint:'https://api.opendota.com/api/matches/'+matchId,matchId,receivedAt,availabilityBasis:'collector_response_receipt',payloadKind:'selected_match_detail_v1',payloadSha256:sha(JSON.stringify(p)),payload:p})}).versionInput;
}
async function fixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'aegis-reference-corpus-r6-'));let held=false;
 const leaseProvider=createOwnedArtifactWriterLeaseProvider({acquireExclusive:async()=>{if(held)throw Error('synthetic_busy');held=true;return{assertHeld:async()=>{if(!held)throw Error('synthetic_lost');},release:async()=>{held=false;}};}});
 const writer=await createPersistentArtifactWriter({directory,leaseProvider});t.after(async()=>{await writer.close();await fs.rm(directory,{recursive:true,force:true});});return{writer,directory};
}
const target=()=>{const a=draftArgs({accounts:true});return {matchId:a.matchId,draftPrefixInputs:a.draftPrefixInputs};};
test('v2 facts/native bytes and identity exactly match the old verified source on a small corpus',async t=>{
 const {writer}=await fixture(t),versions=[version(),version({matchId:2}),version({matchId:10}),version({receivedAt:'2026-10-21T12:00:00Z',hero:200}),version({receivedAt:'2026-10-22T12:00:00Z',series:{times:null}})],corpus=await create({artifactStore:writer,versionInputs:versions,clock}),a={...target(),computedAt:AT,exportedAt:AT},old=oldSource({...a,versionInputs:versions}),view=await materialize({corpusHandle:corpus.handle,...target()}),body=JSON.parse(old.envelopeInput.utf8);
 assert.equal(view.status,'bounded_reference_ready');assert.equal(view.factsInput.utf8,body.factsInput.utf8);assert.equal(view.nativeInput.utf8,body.nativeInput.utf8);assert.deepEqual(view.descriptor.identity,old.identity);assert.deepEqual(view.descriptor.selection.mapIds,['10','101','2']);
 const source=readSource(view.sourceExportHandle,{expectedSourceSnapshotHash:view.sourceSnapshotHash,matchId:a.matchId,decisionAt:AT});assert.equal(source.factsSha256,body.factsInput.pin.sha256);assert.equal(source.reference.sha256,view.envelopeReference.sha256);assert.equal(source.eligibleForServing,false);
 assert.throws(()=>readSource(structuredClone(view.sourceExportHandle),{expectedSourceSnapshotHash:view.sourceSnapshotHash,matchId:a.matchId,decisionAt:AT}),/owned_v2_source_handle_required/);
 assert.throws(()=>readSource(view.sourceExportHandle,{expectedSourceSnapshotHash:'a'.repeat(64),matchId:a.matchId,decisionAt:AT}),/identity_binding/);
 assert.throws(()=>readSource(view.sourceExportHandle,{expectedSourceSnapshotHash:view.sourceSnapshotHash,matchId:a.matchId,decisionAt:'2026-10-23T12:00:00Z'}),/not_available/);
});
test('restart remints source proof from all original refs and every target dependency',async t=>{
 const {writer}=await fixture(t),corpus=await create({artifactStore:writer,versionInputs:[version(),version({matchId:102})],clock}),view=await materialize({corpusHandle:corpus.handle,...target()}),restored=await restore({artifactStore:writer,manifestReference:corpus.manifestReference,clock}),loaded=await readView({corpusHandle:restored.handle,envelopeReference:view.envelopeReference,decisionAt:AT});
 assert.equal(loaded.factsInput.utf8,view.factsInput.utf8);assert.equal(loaded.sourceSnapshotHash,view.sourceSnapshotHash);assert.notEqual(loaded.sourceExportHandle,view.sourceExportHandle);
 const descriptor=readSource(loaded.sourceExportHandle,{expectedSourceSnapshotHash:view.sourceSnapshotHash,matchId:target().matchId,decisionAt:AT});assert.equal(descriptor.sourceVersionSetSha256,view.descriptor.sourceVersionSetSha256);
});
test('rehashed view metadata cannot forge derived facts, target or source binding',async t=>{
 const {writer}=await fixture(t),corpus=await create({artifactStore:writer,versionInputs:[version()],clock}),view=await materialize({corpusHandle:corpus.handle,...target()}),body=JSON.parse(await writer.read(view.envelopeReference));body.factsSha256='a'.repeat(64);
 const utf8=JSON.stringify(body),ref=await writer.commit({kind:view.envelopeReference.kind,utf8,expectedSha256:sha(utf8)});await assert.rejects(readView({corpusHandle:corpus.handle,envelopeReference:ref,decisionAt:AT}),/v2_view_not_rederived/);
});
test('actual target blob corruption fails restart even if original generation is intact',async t=>{
 const {writer,directory}=await fixture(t),corpus=await create({artifactStore:writer,versionInputs:[version()],clock}),view=await materialize({corpusHandle:corpus.handle,...target()}),ref=view.descriptor.facts.chunks[0];
 await fs.writeFile(path.join(directory,'objects',ref.sha256+'.blob'),'x'.repeat(ref.bytes));await assert.rejects(readView({corpusHandle:corpus.handle,envelopeReference:view.envelopeReference,decisionAt:AT}),/object_integrity|artifact_bytes/);
});
test('t1 disclosure does not advance t0 or discover future-only maps; unrelated meta remains',async t=>{
 const {writer}=await fixture(t),corpus=await create({artifactStore:writer,versionInputs:[version({hero:200,account:901}),version({matchId:102,receivedAt:'2026-10-23T12:05:00Z'})],clock}),draftPrefixInputs=[draftEntry({time:'2026-10-23T11:58:00Z'}),draftEntry({accounts:true,time:'2026-10-23T12:10:00Z'})],view=await materialize({corpusHandle:corpus.handle,matchId:'90001',draftPrefixInputs});
 assert.equal(view.descriptor.historyCutoffAt,'2026-10-23T11:58:00Z');assert.equal(view.descriptor.validFrom,'2026-10-23T12:10:00Z');assert.deepEqual(view.descriptor.selection.mapIds,['101']);assert.equal(JSON.parse(view.factsInput.utf8).maps[0].heroes[0].heroId,200);
});
test('v2 STOP retains no target manifest and yields no source authority',async t=>{
 const {writer}=await fixture(t);let active=true;const corpus=await create({artifactStore:writer,versionInputs:[version()],clock,shouldContinue:()=>active});active=false;
 await assert.rejects(materialize({corpusHandle:corpus.handle,...target()}),/stopped/);assert.equal((await writer.listCommitted({kind:'retained-bounded-history-view-v2'})).length,0);
});
