/** Explicit heavy technical gate. Root executes serially under the owned 8 GiB
 * runner, separately from small contracts. Synthetic retained bytes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createOwnedArtifactWriterLeaseProvider} from './artifactWriterLease.mjs';
import {createPersistentArtifactWriter} from './persistentArtifactWriter.mjs';
import {createRetainedReferenceCorpus,restoreRetainedReferenceCorpus,materializeRetainedReferenceHistoryV2,readRetainedReferenceHistoryV2} from './retainedReferenceCorpus.mjs';
import {deriveHistoricalFactVersionV2,pinRetainedHistoryJson as pin} from './retainedOpenDotaFacts.mjs';
import {draftArgs} from './observedDraftHistory.fixtures.mjs';
import {createDynamicHistoryProof} from './observedDraftFeatureBundle.mjs';
import {createUnifiedFeatureProducer} from './unifiedFeatureProducer.mjs';
import {syntheticRegistry} from '../../feature-registry/registry-contract.fixtures.mjs';
const AT='2026-10-24T12:00:00Z',clock=()=>AT,sha=x=>createHash('sha256').update(x).digest('hex');
function version(matchId){
 const payload=JSON.parse(pin({match_id:matchId,start_time:1792494000,duration:1800,radiant_win:true,radiant_team_id:700,dire_team_id:800,radiant_score:25,dire_score:10,padding:'x'.repeat(5*1024*1024),players:Array.from({length:10},(_,i)=>({player_slot:i<5?i:128+i-5,hero_id:i+1,account_id:900+i,gold_per_min:400+i*20,xp_per_min:500+i*20,kills:3+i,deaths:2,assists:6,times:[0,60],gold_t:[600,1200]}))}).utf8);
 return deriveHistoricalFactVersionV2({selectedInput:pin({schemaVersion:1,source:'opendota',endpoint:'https://api.opendota.com/api/matches/'+matchId,matchId,receivedAt:'2026-10-20T12:00:00Z',availabilityBasis:'collector_response_receipt',payloadKind:'selected_match_detail_v1',payloadSha256:sha(JSON.stringify(payload)),payload})}).versionInput;
}
function producer(){const [index,familyDocument,targetDocument]=syntheticRegistry();return createUnifiedFeatureProducer({index,familyDocument,targetDocument,sourceInventory:Object.fromEntries(['history','live','series','draft','seriesHistory'].map(k=>[k,{primarySha256:'a'.repeat(64),files:[{path:k+'.mjs',sha256:'a'.repeat(64)}]}]))});}
test('>64MiB original corpus uses the actual producer before/after owned persistence restart',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'aegis-r6-large-history-'));let held=false,writer;
 const leaseProvider=createOwnedArtifactWriterLeaseProvider({acquireExclusive:async()=>{if(held)throw Error('synthetic_busy');held=true;return{assertHeld:async()=>{if(!held)throw Error('synthetic_lost');},release:async()=>{held=false;}};}});
 t.after(async()=>{await writer?.close();await fs.rm(directory,{recursive:true,force:true});});writer=await createPersistentArtifactWriter({directory,leaseProvider});
 async function* inputs(){for(let i=0;i<14;i++)yield version(200+i);}
 const corpus=await createRetainedReferenceCorpus({artifactStore:writer,versionInputs:inputs(),clock}),draft=draftArgs({accounts:true});
 assert.ok(corpus.descriptor.totalVersionBytes>64*1024*1024);assert.equal(corpus.descriptor.versionCount,14);
 const view=await materializeRetainedReferenceHistoryV2({corpusHandle:corpus.handle,matchId:draft.matchId,draftPrefixInputs:draft.draftPrefixInputs});assert.equal(view.status,'bounded_reference_ready');assert.ok(view.factsInput.pin.bytes<64*1024*1024);assert.equal(JSON.parse(view.factsInput.utf8).maps.length,14);
 const p=producer(),history=createDynamicHistoryProof({...draft,computedAt:AT,factsInput:view.factsInput,nativeInput:view.nativeInput,availabilityBasis:'retained_receipt_reconstruction'},{includeInspectionCopies:false}),bundle=p.generateFeatureBundle({mode:'POST',matchId:draft.matchId,decisionAt:AT,historyProof:history.proof,expectedSourceSnapshotHash:view.sourceSnapshotHash,sourceExportHandle:view.sourceExportHandle});
 assert.equal(bundle.eligibleForServing,false);assert.equal(bundle.sourceSnapshotHash,view.sourceSnapshotHash);assert.ok(bundle.routes.length>0);
 const expected=bundle.routes.map(r=>({namesHash:sha(JSON.stringify(r.diagnosticVector.names)),valuesHash:sha(JSON.stringify(r.diagnosticVector.values)),missingHash:sha(JSON.stringify(r.diagnosticVector.missing))}));
 const manifestReference=corpus.manifestReference,envelopeReference=view.envelopeReference;await writer.close();writer=await createPersistentArtifactWriter({directory,leaseProvider});
 const restored=await restoreRetainedReferenceCorpus({artifactStore:writer,manifestReference,clock}),loaded=await readRetainedReferenceHistoryV2({corpusHandle:restored.handle,envelopeReference,decisionAt:AT});
 assert.equal(loaded.factsInput.utf8,view.factsInput.utf8);assert.equal(loaded.sourceSnapshotHash,view.sourceSnapshotHash);
 const h2=createDynamicHistoryProof({...draft,computedAt:AT,factsInput:loaded.factsInput,nativeInput:loaded.nativeInput,availabilityBasis:'retained_receipt_reconstruction'},{includeInspectionCopies:false}),second=p.generateFeatureBundle({mode:'POST',matchId:draft.matchId,decisionAt:AT,historyProof:h2.proof,expectedSourceSnapshotHash:loaded.sourceSnapshotHash,sourceExportHandle:loaded.sourceExportHandle});
 assert.deepEqual(second.routes.map(r=>({namesHash:sha(JSON.stringify(r.diagnosticVector.names)),valuesHash:sha(JSON.stringify(r.diagnosticVector.values)),missingHash:sha(JSON.stringify(r.diagnosticVector.missing))})),expected);assert.ok((await writer.inspect()).effectiveBytes<=256*1024*1024);
 // This proves a padded synthetic original-byte boundary and restart only.
 // It is not a full normalized archive, real-source coverage or latency gate.
});
