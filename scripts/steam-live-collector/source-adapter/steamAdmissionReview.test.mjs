import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {draftEntry,draftArgs,pinned} from './observedDraftHistory.fixtures.mjs';
import {normalizeLocalCapture} from './steamLiveAdapter.mjs';
import {classifySteamObservationPhase} from './steamPhasePolicy.mjs';
import {advanceSteamProgressionAdmission as advance} from './steamProgressionAdmission.mjs';
import {advanceObservedDraftFeatureBundle as rich,createDynamicHistoryProof} from './observedDraftFeatureBundle.mjs';
import {createRetainedReplayFrameProof} from './retainedReplayFrame.mjs';
import {advanceSteamFeatureBundle} from './steamFeatureBundle.mjs';
import {readCurrentSteamInput} from './currentSteamInput.mjs';
const T='2026-10-23T12:30:00Z',U='2026-10-23T12:31:00Z',V='2026-10-23T12:32:00Z';
const hash=s=>createHash('sha256').update(s).digest('hex');
function entry({time=T,clock=600,phase=null,marker=null,body=null}={}){
 const e=draftEntry({time,clock,phase,accounts:true}),raw=JSON.parse(e.rawInput.utf8),m=JSON.parse(e.metadataInput.utf8);
 for(const side of ['radiant','dire'])for(const p of raw.result.games[0].scoreboard[side].players)Object.assign(p,{net_worth:5000+p.hero_id+clock,gold_per_min:400+p.hero_id,xp_per_min:500+p.hero_id,level:10});
 if(marker)raw.result.games[0][marker]=false;
 const utf8=body??JSON.stringify(raw),rawInput={utf8,pin:{path:'synthetic-review-raw.json',bytes:Buffer.byteLength(utf8),sha256:hash(utf8)}};
 const o=normalizeLocalCapture({...m.capture,body:Buffer.from(utf8),rawSha256:rawInput.pin.sha256,payloadRef:'journal:'+rawInput.pin.sha256}).observations[0];
 const receiptInput=pinned({version:'steam-live-diagnostic-collector.v1',source:'steam',endpoint:m.capture.endpoint,httpStatus:200,status:'captured_diagnostic',diagnosticOnly:true,servingEnabled:false,trainingEnabled:false,publicPromotion:false,requestId:'synthetic-review-'+time,requestStartedAt:time,receivedAt:time,rawPersistedAt:time,completedAt:time,rawSha256:rawInput.pin.sha256,rawFile:'raw/'+rawInput.pin.sha256+'.body',payloadRef:'journal:'+rawInput.pin.sha256,bodyBytes:rawInput.pin.bytes});
 return{rawInput,receiptInput,metadataInput:pinned({...m,observationId:o?.observationId??m.observationId}),observation:o};
}
const run=(e,previous=null,at=JSON.parse(e.at(-1).receiptInput.utf8).completedAt)=>advance(previous,{retainedPrefixInputs:e,matchId:'90001',decisionAt:at});
const live=e=>({rawInput:e.rawInput,metadataInput:e.metadataInput});
const history=(time='2026-10-23T12:30:00Z')=>{const x=draftArgs({accounts:true});x.computedAt=time;return createDynamicHistoryProof(x).proof;};

for(const marker of ['finished','match_status'])test('raw completion indicator '+marker+' cannot become explicit LIVE',()=>{
 const e=entry({phase:5,marker}),r=classifySteamObservationPhase(e.observation,{decisionAt:T});
 assert.equal(r.dynamicDiagnosticAllowed,false);assert.equal(r.staticDraftDiagnosticAllowed,false);
});

test('committed malformed response advances receipt watermark before any older pair can qualify',()=>{
 const a=run([entry(),entry({time:U,clock:660})]);
 const malformed=run([entry({time:'2026-10-23T12:34:00Z',body:'<html>failure</html>'})],a.nextPrivateToken);
 const c=run([entry({time:'2026-10-23T12:33:00Z',clock:780})],malformed.nextPrivateToken,'2026-10-23T12:34:00Z');
 const d=run([entry({time:'2026-10-23T12:33:30Z',clock:810})],c.nextPrivateToken,'2026-10-23T12:34:00Z');
 assert.equal(d.status,'blocked');assert.equal(d.reason,'progression_receipt_not_strictly_increasing');
});

test('caller-supplied past source horizon without retained proof cannot bypass lease',()=>{
 const a=entry(),b=entry({time:U,clock:660}),admit=run([a,b]),now='2026-10-23T12:45:00Z';
 const r=rich(null,{matchId:'90001',decisionAt:now,sourceDecisionAt:U,historyProof:history(now),livePrefixInputs:[live(b)],progressionProof:admit.privateProof});
 assert.equal(r.status,'blocked');assert.equal(r.reason,'dynamic_retained_replay_proof_required');
});

test('explicit LIVE receipt freshness has exact300s boundary and is not an absolute event-lag claim',()=>{
 const e=entry({phase:5});
 assert.doesNotThrow(()=>advanceSteamFeatureBundle(null,e.observation,{decisionAt:'2026-10-23T12:35:00Z'}));
 assert.throws(()=>advanceSteamFeatureBundle(null,e.observation,{decisionAt:'2026-10-23T12:35:00.000000001Z'}),/steam_receipt_stale/);
});

test('STOP and requalified source epoch clear rich temporal windows but retain current values',()=>{
 const a=entry(),b=entry({time:U,clock:660}),c=entry({time:V,clock:720}),h=history();
 const ab=run([a,b]),abc=run([c],ab.nextPrivateToken);
 const first=rich(null,{matchId:'90001',decisionAt:U,historyProof:h,livePrefixInputs:[live(b)],progressionProof:ab.privateProof});
 const second=rich(first.state,{matchId:'90001',decisionAt:V,historyProof:h,livePrefixInputs:[live(c)],progressionProof:abc.privateProof});
 const stopped=advance(abc.nextPrivateToken,{matchId:'90001',decisionAt:'2026-10-23T12:32:30Z',stopped:true});
 const d=entry({time:'2026-10-23T12:33:00Z',clock:780}),e=entry({time:'2026-10-23T12:34:00Z',clock:840}),de=run([d,e],stopped.nextPrivateToken);
 const after=rich(second.state,{matchId:'90001',decisionAt:'2026-10-23T12:34:00Z',historyProof:h,livePrefixInputs:[live(e)],progressionProof:de.privateProof});
 assert.equal(after.status,'diagnostic_produced');assert.equal(after.nativeBundle.state.history.length,1);
 const index=after.vector.names.indexOf('draft_live.trajectory.nw_sum_diff.past_180s.observations');
 assert.equal(after.vector.values[index],null);
 assert.notEqual(de.provenance.continuityId,abc.provenance.continuityId);
 const nativeBefore=advanceSteamFeatureBundle(null,c.observation,{progressionProof:abc.privateProof,decisionAt:V});
 const nativeAfter=advanceSteamFeatureBundle(nativeBefore.state,e.observation,{progressionProof:de.privateProof,decisionAt:'2026-10-23T12:34:00Z'});
 assert.equal(nativeAfter.state.history.length,1);assert.ok(nativeAfter.resetReasons.includes('source_continuity_changed'));
});

test('current explicit LIVE entry enforces freshness; only bound retained proof supplies its old horizon',()=>{
 const e=entry({phase:5}),now='2026-10-23T12:45:00Z',input=draftArgs({accounts:true});input.computedAt=now;
 const context=createDynamicHistoryProof(input).context,base={prefix:[live(e)],context,matchId:'90001'};
 assert.equal(readCurrentSteamInput({...base,decisionAt:'2026-10-23T12:35:00Z'}).admission.dynamicDiagnosticAllowed,true);
 assert.throws(()=>readCurrentSteamInput({...base,decisionAt:'2026-10-23T12:35:00.000000001Z'}),/steam_receipt_stale/);
 const proof=createRetainedReplayFrameProof({...e,reconstructedAt:now});
 const r=readCurrentSteamInput({...base,decisionAt:now,retainedReplayProof:proof});
 assert.equal(r.sourceDecisionAt,T);assert.equal(r.reconstruction.originalPredictionTimingClaimed,false);
 assert.throws(()=>readCurrentSteamInput({...base,decisionAt:now,retainedReplayProof:{...proof}}),/private_replay_frame_binding/);
});

test('retained proof minting requires complete owned collector binding and chronology',()=>{
 const e=entry(),base=JSON.parse(e.receiptInput.utf8);
 for(const change of [{source:'other'},{bodyBytes:base.bodyBytes+1},{rawFile:'other.body'},{payloadRef:'journal:other'},{requestId:''},{requestStartedAt:U}]){
  assert.throws(()=>createRetainedReplayFrameProof({...e,receiptInput:pinned({...base,...change}),reconstructedAt:V}),/owned_capture_chronology/);
 }
});

test('rich replay accepts exact owned original horizon and rejects cloned or cross-frame proof',()=>{
 const a=entry(),b=entry({time:U,clock:660}),admit=run([a,b]),now='2026-10-23T12:45:00Z',options={matchId:'90001',decisionAt:now,sourceDecisionAt:U,historyProof:history(now),livePrefixInputs:[live(b)],progressionProof:admit.privateProof};
 const proof=createRetainedReplayFrameProof({...b,reconstructedAt:now}),r=rich(null,{...options,retainedReplayProof:proof});
 assert.equal(r.status,'diagnostic_produced');assert.equal(r.decisionAt,now);assert.equal(r.sourceDecisionAt,U);assert.equal(r.recordedPrediction,false);
 assert.equal(rich(null,{...options,retainedReplayProof:{...proof}}).status,'blocked');
 assert.equal(rich(null,{...options,retainedReplayProof:createRetainedReplayFrameProof({...a,reconstructedAt:now})}).status,'blocked');
});
