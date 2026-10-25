import test from'node:test';
import assert from'node:assert/strict';
import{createHash}from'node:crypto';
import{createRetainedReferenceCorpus,materializeRetainedReferenceHistoryMapView}from'./retainedReferenceCorpus.mjs';
import{deriveHistoricalFactVersionV2,pinRetainedHistoryJson as pin}from'./retainedOpenDotaFacts.mjs';
import{draftArgs}from'./observedDraftHistory.fixtures.mjs';
import{createDiagnosticResourceArena}from'./diagnosticResourceArena.mjs';
import{createDynamicHistoryProofFromRetainedMapView,readDynamicHistoryProof}from'./observedDraftFeatureBundle.mjs';
const A='2026-10-24T12:00:00Z',B='2026-10-24T12:01:00Z',sha=x=>createHash('sha256').update(x).digest('hex');
async function fixture(){
 const objects=new Map();let hook=null;const writer={contract:'aegis.persistent-artifact-writer.v1',setReadHook(f){hook=f;},async commit({kind,utf8,expectedSha256}){assert.equal(sha(utf8),expectedSha256);const r={kind,sha256:expectedSha256,bytes:Buffer.byteLength(utf8)};objects.set(kind+':'+r.sha256,utf8);return r;},async read(r){await hook?.(r);return objects.get(r.kind+':'+r.sha256);},async inspect(){return{syntheticObjects:objects.size};}};
 const payload={match_id:101,start_time:Math.floor(Date.parse('2026-10-01T00:00:00Z')/1000),duration:1800,radiant_win:true,radiant_team_id:100,dire_team_id:200,radiant_score:25,dire_score:10,players:Array.from({length:10},(_,i)=>({player_slot:i<5?i:128+i-5,hero_id:i+1,account_id:101+i,gold_per_min:300+i}))};
 const selectedInput=pin({schemaVersion:1,source:'opendota',endpoint:'https://api.opendota.com/api/matches/101',matchId:101,receivedAt:'2026-10-20T12:00:00Z',availabilityBasis:'collector_response_receipt',payloadKind:'selected_match_detail_v1',payloadSha256:sha(JSON.stringify(JSON.parse(pin(payload).utf8))),payload}),version=deriveHistoricalFactVersionV2({selectedInput}).versionInput,draft=draftArgs({accounts:true}),arena=createDiagnosticResourceArena(),corpus=await createRetainedReferenceCorpus({artifactStore:writer,versionInputs:[version],clock:()=>A}),view=await materializeRetainedReferenceHistoryMapView({corpusHandle:corpus.handle,matchId:draft.matchId,draftPrefixInputs:draft.draftPrefixInputs,resourceArena:arena});
 let entered,finish;const started=new Promise(r=>{entered=r;}),gate=new Promise(r=>{finish=r;});let once=false;writer.setReadHook(async ref=>{if(!once&&ref.kind==='retained-normalized-map-part-v3'){once=true;entered();await gate;}});return{view,arena,started,finish};
}
test('async history proof readiness follows actual awaited reads and cannot authorize an earlier recorded decision',async()=>{
 const f=await fixture();let at=A;const pending=createDynamicHistoryProofFromRetainedMapView({historyView:f.view.handle,matchId:'90001',computedAt:A},{resourceArena:f.arena,now:()=>at});await f.started;at=B;f.finish();const owner=await pending;
 try{assert.equal(owner.workStartedAt,A);assert.equal(owner.readyAt,B);assert.equal(readDynamicHistoryProof(owner.proof,{matchId:'90001',decisionAt:A}).reason,'dynamic_history_proof_not_ready_at_decision');const current=readDynamicHistoryProof(owner.proof,{matchId:'90001',decisionAt:B});assert.equal(current.accepted,true);assert.equal(current.readyAt,B);assert.equal(current.context.computedAt,A);assert.equal(readDynamicHistoryProof(owner.proof,{matchId:'90001',decisionAt:A,readMode:'reconstructed'}).accepted,true);assert.equal(readDynamicHistoryProof(structuredClone(owner.proof),{matchId:'90001',decisionAt:B}).accepted,false);}finally{owner.release();}assert.equal(f.arena.status().chargedBytes,0);
});
test('STOP during awaited history work mints no proof and releases both context and relational owners',async()=>{
 const f=await fixture();let active=true;const pending=createDynamicHistoryProofFromRetainedMapView({historyView:f.view.handle,matchId:'90001',computedAt:A},{resourceArena:f.arena,now:()=>A,shouldContinue:()=>active});await f.started;active=false;f.finish();await assert.rejects(pending,/dynamic_history_proof_stopped/);assert.equal(f.arena.status().chargedBytes,0);
});
test('a regressed completion clock cannot mint history readiness',async()=>{
 const f=await fixture();let at=A;const pending=createDynamicHistoryProofFromRetainedMapView({historyView:f.view.handle,matchId:'90001',computedAt:A},{resourceArena:f.arena,now:()=>at});await f.started;at='2026-10-24T11:59:59Z';f.finish();await assert.rejects(pending,/dynamic_history_proof_clock/);assert.equal(f.arena.status().chargedBytes,0);
});
