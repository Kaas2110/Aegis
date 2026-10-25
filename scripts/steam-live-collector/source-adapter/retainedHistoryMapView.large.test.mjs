/** Deliberate heavy gate, root-only under the CURRENT6GiB owned JobObject.
 * This fixture exercises >64MiB NORMALIZED facts, not source padding. Run only
 * after the small map-view parity/negative contracts pass AND explicit opt-in
 * AEGIS_R6B_NORMALIZED_LARGE=1. No fitted model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createOwnedArtifactWriterLeaseProvider} from './artifactWriterLease.mjs';
import {createPersistentArtifactWriter} from './persistentArtifactWriter.mjs';
import {createRetainedReferenceCorpus,restoreRetainedReferenceCorpus,materializeRetainedReferenceHistoryMapView,restoreRetainedReferenceHistoryMapView} from './retainedReferenceCorpus.mjs';
import {deriveHistoricalFactVersionV2,pinRetainedHistoryJson as pin} from './retainedOpenDotaFacts.mjs';
import {PERFORMANCE_FIELDS} from './historicalPerformanceFields.mjs';
import {draftArgs} from './observedDraftHistory.fixtures.mjs';
import {createDynamicHistoryProofFromRetainedMapView,readDynamicHistoryProof} from './observedDraftFeatureBundle.mjs';
import {createUnifiedFeatureProducer} from './unifiedFeatureProducer.mjs';
import {createDiagnosticResourceArena} from './diagnosticResourceArena.mjs';
import {syntheticRegistry} from '../../feature-registry/registry-contract.fixtures.mjs';
const AT='2026-10-24T12:00:00Z',clock=()=>AT,sha=x=>createHash('sha256').update(x).digest('hex');
function version(matchId){
 const payload={match_id:matchId,start_time:Math.floor(Date.parse('2026-10-20T00:00:00Z')/1000),duration:1800+matchId%120,radiant_win:matchId%2===0,radiant_team_id:100,dire_team_id:200,radiant_score:25+matchId%10,dire_score:10+matchId%7,players:Array.from({length:10},(_,i)=>({player_slot:i<5?i:128+i-5,hero_id:i+1,account_id:101+i,...Object.fromEntries(Object.values(PERFORMANCE_FIELDS).map((field,j)=>[field,field==='level'?10:field==='deaths'?i%3:100+i*13+j*7+(matchId%100)/3])),times:[0,60],gold_t:[600,1200]}))},body=JSON.parse(pin(payload).utf8);
 return deriveHistoricalFactVersionV2({selectedInput:pin({schemaVersion:1,source:'opendota',endpoint:'https://api.opendota.com/api/matches/'+matchId,matchId,receivedAt:'2026-10-21T12:00:00Z',availabilityBasis:'collector_response_receipt',payloadKind:'selected_match_detail_v1',payloadSha256:sha(JSON.stringify(body)),payload:body})}).versionInput;
}
test('actual >64MiB normalized map view survives owned persistence/restart and all-family producer binding',{skip:process.env.AEGIS_R6B_NORMALIZED_LARGE==='1'?false:'requires AEGIS_R6B_NORMALIZED_LARGE=1 and root-owned current guard'},async t=>{
 const phaseStarted=performance.now(),phase=(name,details={})=>process.stdout.write(JSON.stringify({contract:'aegis.r6b-normalized-history-large-phase.v1',phase:name,elapsedSeconds:Number(((performance.now()-phaseStarted)/1000).toFixed(3)),...details})+'\n');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'aegis-r6b-normalized-view-'));let held=false,writer;
 const leaseProvider=createOwnedArtifactWriterLeaseProvider({acquireExclusive:async()=>{if(held)throw Error('synthetic_busy');held=true;return{assertHeld:async()=>{if(!held)throw Error('synthetic_lost');},release:async()=>{held=false;}};}});
 t.after(async()=>{await writer?.close();await fs.rm(directory,{recursive:true,force:true});});writer=await createPersistentArtifactWriter({directory,leaseProvider});const arena=createDiagnosticResourceArena(),draft=draftArgs({accounts:true});
 async function* versions(){for(let i=0;i<1600;i++)yield version(2000+i);}
 const corpus=await createRetainedReferenceCorpus({artifactStore:writer,versionInputs:versions(),clock});phase('corpus_created',{versions:corpus.descriptor.versionCount,originalVersionBytes:corpus.descriptor.totalVersionBytes});
 const view=await materializeRetainedReferenceHistoryMapView({corpusHandle:corpus.handle,matchId:draft.matchId,draftPrefixInputs:draft.draftPrefixInputs,resourceArena:arena});phase('view_materialized',{maps:view.descriptor.rowCount,normalizedFactsBytes:view.descriptor.factsPin.bytes,parts:view.descriptor.mapParts.length,effectiveStoredBytes:(await writer.inspect()).effectiveBytes});assert.equal(view.descriptor.rowCount,1600);assert.ok(view.descriptor.factsPin.bytes>64*1024*1024,'fixture must actually cross normalized facts boundary');assert.ok(view.descriptor.factsPin.bytes>corpus.descriptor.totalVersionBytes);
 const manifestReference=corpus.manifestReference,envelopeReference=view.envelopeReference;await writer.close();writer=await createPersistentArtifactWriter({directory,leaseProvider});phase('writer_reopened');
 const restoredCorpus=await restoreRetainedReferenceCorpus({artifactStore:writer,manifestReference,clock}),restoredView=await restoreRetainedReferenceHistoryMapView({corpusHandle:restoredCorpus.handle,envelopeReference,decisionAt:AT,resourceArena:arena});assert.equal(restoredView.descriptor.factsSha256,view.descriptor.factsSha256);assert.equal(restoredView.descriptor.rowCount,1600);phase('source_view_restored');
 const history=await createDynamicHistoryProofFromRetainedMapView({historyView:restoredView.handle,matchId:draft.matchId,computedAt:AT},{resourceArena:arena,now:clock}),read=readDynamicHistoryProof(history.proof,{matchId:draft.matchId,decisionAt:AT});assert.equal(read.accepted,true);assert.equal(read.relational.audit.inputMaps,1600);assert.equal(read.relational.audit.eligiblePriorMaps,1600);phase('proof_computed',{features:read.relational.names.length,eligibleMaps:read.relational.audit.eligiblePriorMaps});
 const [index,familyDocument,targetDocument]=syntheticRegistry(),sourceInventory=Object.fromEntries(['history','live','series','draft','seriesHistory'].map(k=>[k,{primarySha256:'a'.repeat(64),files:[{path:k+'.synthetic.mjs',sha256:'a'.repeat(64)}]}])),producer=createUnifiedFeatureProducer({index,familyDocument,targetDocument,sourceInventory,resourceArena:arena});let bundle;
 try{bundle=producer.generateFeatureBundle({mode:'POST',matchId:draft.matchId,decisionAt:AT,historyProof:history.proof,sourceExportHandle:history.sourceExportHandle,expectedSourceSnapshotHash:history.sourceSnapshotHash});assert.equal(bundle.status,'diagnostic_generated');assert.ok(bundle.routes.length>=3);assert.equal(bundle.eligibleForTraining,false);assert.equal(bundle.historicalBindings.factsSha256,view.descriptor.factsSha256);assert.ok((await writer.inspect()).effectiveBytes<=256*1024*1024);}
 finally{bundle?.release?.();producer.close();history.release();}assert.equal(arena.status().chargedBytes,0);
 // Passing this synthetic gate is not complete archive/source95%/latency proof.
});
