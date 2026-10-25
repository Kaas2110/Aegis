import test from'node:test';import assert from'node:assert/strict';import{createHash}from'node:crypto';
import{canonical}from'../../feature-registry/registry-contract.mjs';
import{createDiagnosticResourceArena}from'./diagnosticResourceArena.mjs';
import{createRetainedStaticHistoryTargetStore,readRetainedStaticHistoryTargetProof}from'./retainedStaticHistoryTarget.mjs';
import{createCompactHistoricalInputStore,readCompactHistoricalInputProof}from'./compactHistoricalInputStore.mjs';
const AT='2026-10-25T13:00:00Z',FIRST='2026-10-25T11:00:00Z',LATER='2026-10-25T12:00:00Z',sha=x=>createHash('sha256').update(x).digest('hex');
const pin=data=>{const utf8=JSON.stringify(data);return{utf8,pin:{path:'synthetic-r7-receipt.json',bytes:Buffer.byteLength(utf8),sha256:sha(utf8)}};};
const pre=(knownAt=FIRST,players=[])=>pin({contract:'aegis.prematch-roster-receipt.v1',matchId:'90001',knownAt,teams:{radiant:'100',dire:'200'},players});
const identity=(knownAt=FIRST,players=[])=>pin({contract:'aegis.series-roster-receipt.v1',seriesId:'series:r7',knownAt,team1Id:'100',team2Id:'200',players});
const series=(availableAt=FIRST,count=0)=>pin({contract:'aegis.series-map-receipts.v1',seriesId:'series:r7',bestOf:3,team1Id:'100',team2Id:'200',availableAt,completeThroughMapNumber:count,previousMaps:count?[{mapId:'80001',mapNumber:1,winnerTeamId:'100',availableAt:LATER,finishedAt:'2026-10-25T11:59:00Z',durationSeconds:2400,team1Kills:30,team2Kills:20,team1Heroes:[1,2,3,4,5],team2Heroes:[6,7,8,9,10]}]:[]});
function fixture(t,extra={}){const arena=createDiagnosticResourceArena(),objects=new Map(),state={reads:0},writer={contract:'aegis.persistent-artifact-writer.v1',async commit({kind,utf8,expectedSha256}){assert.equal(sha(utf8),expectedSha256);const r=Object.freeze({kind,sha256:expectedSha256,bytes:Buffer.byteLength(utf8)});objects.set(kind+':'+r.sha256,utf8);return r;},async read(r){state.reads++;return objects.get(r.kind+':'+r.sha256);}},store=createRetainedStaticHistoryTargetStore({writer,resourceArena:arena,now:()=>AT,...extra}),compact=createCompactHistoricalInputStore({writer,resourceArena:arena,clock:()=>AT,targetDerivationStore:store});t.after(()=>{compact.close();store.close();assert.equal(arena.status().chargedBytes,0);});return{arena,objects,state,writer,store,compact};}
async function forged(writer,reference,mutate){const body=JSON.parse(await writer.read(reference));mutate(body);const utf8=canonical(body);return writer.commit({kind:reference.kind,utf8,expectedSha256:sha(utf8)});}

test('PRE replays actual first receipt and monotone roster disclosure without rebasing t0',async t=>{
 const f=fixture(t),first=await f.store.derivePrematchTarget({identityInput:pre(),decisionAt:AT}),next=await f.store.derivePrematchTarget({identityInput:pre(LATER,[{side:'radiant',accountId:'1'}]),previousReference:first.reference,decisionAt:AT});
 assert.equal(next.descriptor.historyCutoffAt,FIRST);assert.equal(next.descriptor.validFrom,LATER);assert.equal(next.descriptor.identityRevision,1);assert.equal(next.descriptor.chainDepth,2);assert.equal(next.descriptor.receiptTrust,'observed_local_host_declaration_not_provider_signature');assert.equal(next.descriptor.originalProviderPublicationTimeKnown,false);
 assert.throws(()=>readRetainedStaticHistoryTargetProof(structuredClone(next.proof),{decisionAt:AT}),/owned_target_proof/);
 const rewritten=await forged(f.writer,next.reference,b=>{const target=JSON.parse(b.targetInput.utf8);target.historyCutoffAt=LATER;b.targetInput=pin(target);});await assert.rejects(f.store.verifyTargetDerivation(rewritten,{decisionAt:AT}),/target_not_rederived/);
 const reordered=await f.store.derivePrematchTarget({identityInput:pre(LATER,[{side:'dire',accountId:'2'},{side:'radiant',accountId:'1'}]),previousReference:next.reference,decisionAt:AT}),same=await f.store.derivePrematchTarget({identityInput:pre(AT,[{side:'radiant',accountId:'1'},{side:'dire',accountId:'2'}]),previousReference:reordered.reference,decisionAt:AT});assert.equal(same.targetInput.utf8,reordered.targetInput.utf8);assert.equal(same.descriptor.identityRevision,reordered.descriptor.identityRevision);assert.equal(same.descriptor.requiredInputAvailableAt,AT);assert.throws(()=>readRetainedStaticHistoryTargetProof(same.proof,{decisionAt:LATER}),/inputs_after_decision/);
 first.release();next.release();reordered.release();same.release();
});

test('PRE known-account removal, side/team replacement and future receipt fail closed',async t=>{
 const f=fixture(t),first=await f.store.derivePrematchTarget({identityInput:pre(FIRST,[{side:'radiant',accountId:'1'}]),decisionAt:AT});
 for(const receipt of[pre(LATER,[]),pre(LATER,[{side:'dire',accountId:'1'}]),pin({...JSON.parse(pre(LATER,[{side:'radiant',accountId:'1'}]).utf8),teams:{radiant:'300',dire:'200'}})])await assert.rejects(f.store.derivePrematchTarget({identityInput:receipt,previousReference:first.reference,decisionAt:AT}),/known_identity_change/);
 await assert.rejects(f.store.derivePrematchTarget({identityInput:pre('2026-10-25T14:00:00Z'),decisionAt:AT}),/prematch_roster_receipt/);first.release();
});

test('SERIES_PRE roster revision and BETWEEN transition derive from exact previous receipt chain',async t=>{
 const f=fixture(t),first=await f.store.deriveSeriesTarget({mode:'SERIES_PRE',identityInput:identity(),seriesInput:series(),decisionAt:AT}),revision=await f.store.deriveSeriesTarget({mode:'SERIES_PRE',identityInput:identity(LATER,[{team:'team1',accountId:'1'}]),seriesInput:series(LATER),previousReference:first.reference,decisionAt:AT}),between=await f.store.deriveSeriesTarget({mode:'BETWEEN',identityInput:identity(LATER,[{team:'team1',accountId:'1'}]),seriesInput:series(LATER,1),previousReference:revision.reference,decisionAt:AT});
 assert.equal(revision.descriptor.historyCutoffAt,FIRST);assert.equal(revision.descriptor.identityRevision,1);assert.equal(revision.descriptor.validFrom,LATER);assert.equal(between.descriptor.transitionId,'series:r7:after:1');assert.equal(between.descriptor.historyCutoffAt,LATER);assert.equal(between.descriptor.identityRevision,0);
 const altered=JSON.parse(series(AT,1).utf8);altered.previousMaps[0].winnerTeamId='200';await assert.rejects(f.store.deriveSeriesTarget({mode:'BETWEEN',identityInput:identity(),seriesInput:pin(altered),previousReference:between.reference,decisionAt:AT}),/prefix_revision_requires_correction_evidence/);
 await assert.rejects(f.store.deriveSeriesTarget({mode:'SERIES_PRE',identityInput:identity(),seriesInput:series(LATER),previousReference:revision.reference,decisionAt:AT}),/known_roster_change_requires_review/);first.release();revision.release();between.release();
});

test('cold target replay checks every ancestor byte and exact target/series binding',async t=>{
 const f=fixture(t),a=await f.store.deriveSeriesTarget({mode:'SERIES_PRE',identityInput:identity(),seriesInput:series(),decisionAt:AT}),b=await f.store.deriveSeriesTarget({mode:'SERIES_PRE',identityInput:identity(LATER),seriesInput:series(LATER),previousReference:a.reference,decisionAt:AT}),cold=createRetainedStaticHistoryTargetStore({writer:f.writer,resourceArena:f.arena,now:()=>AT});t.after(()=>cold.close());
 const restored=await cold.verifyTargetDerivation(b.reference,{mode:'SERIES_PRE',targetInput:b.targetInput,seriesInput:series(LATER),decisionAt:AT});assert.equal(restored.targetInput.utf8,b.targetInput.utf8);assert.equal(restored.descriptor.chainDepth,2);restored.release();
 await assert.rejects(cold.verifyTargetDerivation(b.reference,{mode:'SERIES_PRE',targetInput:b.targetInput,seriesInput:series(),decisionAt:AT}),/series_binding/);
 f.objects.set(a.reference.kind+':'+a.reference.sha256,'x'.repeat(a.reference.bytes));await assert.rejects(cold.verifyTargetDerivation(b.reference,{decisionAt:AT}),/artifact_bytes/);a.release();b.release();
});

test('compact derived static inputs carry private source-chain proof; legacy parsed admission is explicit',async t=>{
 const f=fixture(t),derived=await f.store.derivePrematchTarget({identityInput:pre(),decisionAt:AT}),factsInput=pin({contract:'aegis.prior-map-facts.v1',maps:[]}),args={mode:'PRE',factsInput,targetInput:derived.targetInput},written=await f.compact.writeHistoricalInputs({...args,targetDerivationReference:derived.reference,decisionAt:AT}),options={mode:'PRE',decisionAt:AT,requireTargetDerivation:true,requireParsedTargetBinding:true,matchId:'90001',seriesId:null,historicalBindings:{factsSha256:factsInput.pin.sha256,targetSha256:derived.targetInput.pin.sha256,historyCutoffAt:FIRST,validFrom:FIRST},seriesReceiptPin:null};
 assert.equal(written.descriptor.targetDerivationVerified,true);assert.equal(readCompactHistoricalInputProof(written.proof,{reference:written.reference,...options}).targetDerivationBinding.reference.sha256,derived.reference.sha256);written.release();
 const legacy=await f.compact.writeHistoricalInputs(args);legacy.release();await assert.rejects(f.compact.verifyHistoricalInputs(legacy.reference,options),/target_derivation_required/);const parsed=await f.compact.verifyHistoricalInputs(legacy.reference,{...options,requireTargetDerivation:false});assert.equal(parsed.descriptor.parsedTargetVerified,true);assert.equal(parsed.descriptor.targetDerivationVerified,false);parsed.release();
 const missingStore=createCompactHistoricalInputStore({writer:f.writer,resourceArena:f.arena,clock:()=>AT});t.after(()=>missingStore.close());await assert.rejects(missingStore.verifyHistoricalInputs(written.reference,{...options,requireTargetDerivation:false}),/target_derivation_store_required/);derived.release();
});

test('later unchanged roster receipt remains a required input on private compact proof reread',async t=>{
 const f=fixture(t),a=await f.store.derivePrematchTarget({identityInput:pre(),decisionAt:AT}),b=await f.store.derivePrematchTarget({identityInput:pre(LATER),previousReference:a.reference,decisionAt:AT}),w=await f.compact.writeHistoricalInputs({mode:'PRE',factsInput:pin({maps:[]}),targetInput:b.targetInput,targetDerivationReference:b.reference,decisionAt:AT});
 assert.equal(w.descriptor.parsedTargetBinding.validFrom,FIRST);assert.equal(w.descriptor.targetDerivationBinding.requiredInputAvailableAt,LATER);for(const strict of[true,false,undefined])assert.throws(()=>readCompactHistoricalInputProof(w.proof,{requireTargetDerivation:strict,decisionAt:'2026-10-25T11:30:00Z'}),/target_derivation_input_after_decision/);w.release();a.release();b.release();
});

test('closing while final target verifier continuation is pending cannot mint authority or leak arena bytes',async t=>{
 let armed=false,finish,enter;const gate=new Promise(r=>{finish=r;}),started=new Promise(r=>{enter=r;});let f;f=fixture(t,{shouldContinue:async()=>{if(armed&&f.state.reads>0){armed=false;enter();await gate;}return true;}});const first=await f.store.derivePrematchTarget({identityInput:pre(),decisionAt:AT}),ref=first.reference;first.release();f.state.reads=0;armed=true;const pending=f.store.verifyTargetDerivation(ref,{decisionAt:AT});await started;f.store.close();finish();await assert.rejects(pending,/closed/);assert.equal(f.store.status().activeProofs,0);assert.equal(f.arena.status().chargedBytes,0);
});

test('advanced wall-clock restart proves retrospective source derivation without backdating private readiness',async t=>{
 const f=fixture(t),first=await f.store.derivePrematchTarget({identityInput:pre(),decisionAt:AT}),reference=first.reference,targetInput=first.targetInput;first.release();const tomorrow='2026-10-26T13:00:00Z',cold=createRetainedStaticHistoryTargetStore({writer:f.writer,resourceArena:f.arena,now:()=>tomorrow});t.after(()=>cold.close());
 const replayed=await cold.verifyTargetDerivation(reference,{mode:'PRE',targetInput,decisionAt:AT,readMode:'retrospective'});assert.equal(replayed.descriptor.historyCutoffAt,FIRST);assert.equal(replayed.descriptor.readyAt,tomorrow);assert.equal(replayed.descriptor.verificationPurpose,'retrospective_source_derivation_not_original_prediction');assert.equal(replayed.descriptor.originalPredictionTimingClaimed,false);
 assert.throws(()=>readRetainedStaticHistoryTargetProof(replayed.proof,{decisionAt:AT,readMode:'recorded'}),/proof_not_ready_at_decision/);assert.equal(readRetainedStaticHistoryTargetProof(replayed.proof,{decisionAt:tomorrow,readMode:'recorded'}).recordedPrediction,false);replayed.release();await assert.rejects(cold.verifyTargetDerivation(reference,{decisionAt:AT,readMode:'recorded'}),/proof_not_ready_at_decision/);assert.equal(cold.status().activeProofs,0);
});
