import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WINNER_SHADOW, WINNER_SHADOW_FEATURE_NAMES, checkedShadowResponse, runLiveWinnerShadow,
  shadowAssessment, type ShadowRequest, type ShadowBody, type ShadowCompletion,
  shadowRequestBodyHash, WINNER_SHADOW_SOURCE_HASHES,
} from './LiveWinnerShadowContract';
import {ShadowDiagnosticError,httpFailure} from './liveWinnerShadowDiagnostics';

const hash = 'a'.repeat(64);
function fixture() {
  const body: ShadowBody = { expectedMatchId: 123,
    current: { observationId: hash, source: 'opendota', targetScope: 'map', clockUnit: 'seconds', scoreUnit: 'kills',
      receivedAt: '2026-10-13T00:00:00.000Z', recordedAt: '2026-10-13T00:00:01.000Z',
      input: { matchId:123, gameTimeSec:600, radiantScore:5, direScore:3, radiantLead:0 } }, history: [] };
  const request: ShadowRequest = { id: 'b'.repeat(64), body, dispatchedAt:new Date('2026-10-13T00:00:02Z'),
    outcomeKnownAtDispatch:false, evidence:{ outcomeKnownAtCapture:false, sourceAssessment:{ qualityReasons:[] } } };
  const response: Record<string, unknown> = { ...WINNER_SHADOW, executionMode:'runtime_shadow',
    target:'map_radiant_win', targetScope:'map', observationId:hash, matchId:123, currentObservationHash:hash,
    computedAt:'2026-10-13T00:00:03Z', receivedAt:body.current.receivedAt, recordedAt:body.current.recordedAt,
    requestBodySha256:shadowRequestBodyHash(body), sourceHashes:WINNER_SHADOW_SOURCE_HASHES, active:false, eligibleForServing:false,
    eligibleForPromotion:false, prospectiveValidated:false,eventLatencyVerified:false,meetsVerifiedLiveLatencyPolicy:false,
    measuredEndToEndLatencySeconds:null, calibratedProbability:null, status:'shadow_predicted',reason:null,
    rawProbability:0.61, featureDtype:'float32',featureValues:Array(268).fill(0),missingMask:Array(268).fill(false),
    featureNames:[...WINNER_SHADOW_FEATURE_NAMES], inputHash:hash,featureVectorHash:hash,
    historyLineageInReceiptOrder:[],contributingHistory:[] };
  return { body, request, response };
}

test('nullable native-missing vector and observed zero stay distinct',()=>{
  const {body,response}=fixture();
  (response.featureValues as unknown[])[9]=null;
  (response.missingMask as boolean[])[9]=true;
  const result=checkedShadowResponse(response,body,new Date('2026-10-13T00:00:04Z'));
  assert.equal((result.featureValues as unknown[])[9],null);
  assert.equal((result.featureValues as unknown[])[0],0);
});

for (const [name, mutate] of [
  ['different model',(r:any)=>r.modelSha256='b'.repeat(64)],
  ['different manifest',(r:any)=>r.manifestSha256='b'.repeat(64)],
  ['different map',(r:any)=>r.matchId=124],
  ['different observation',(r:any)=>r.observationId='b'.repeat(64)],
  ['serving activation',(r:any)=>r.eligibleForServing=true],
  ['invented latency',(r:any)=>r.eventLatencyVerified=true],
  ['accidental NaN',(r:any)=>r.featureValues[0]=NaN],
  ['missing mask mismatch',(r:any)=>r.featureValues[0]=null],
  ['not float32',(r:any)=>r.featureValues[0]=0.1],
  ['feature permutation',(r:any)=>[r.featureNames[0],r.featureNames[1]]=[r.featureNames[1],r.featureNames[0]]],
  ['foreign history',(r:any)=>r.contributingHistory=[{observationId:'d'.repeat(64),observationHash:hash}]],
  ['unbounded probability',(r:any)=>r.rawProbability=1.01],
  ['different request body',(r:any)=>r.requestBodySha256='b'.repeat(64)],
  ['wrong source pins',(r:any)=>r.sourceHashes={}],
  ['changed receipt',(r:any)=>r.receivedAt='2026-10-13T00:00:01Z'],
  ['future computation',(r:any)=>r.computedAt='2026-10-14T00:00:03Z'],
] as const) test(`reject ${name}`,()=>{
  const {body,response}=fixture(); mutate(response);
  assert.throws(()=>checkedShadowResponse(response,body,new Date('2026-10-13T00:00:04Z')));
});

test('unavailable phase stays unavailable, without fabricated vector or probability',()=>{
  const {body,response}=fixture(); Object.assign(response,{status:'unavailable',reason:'tail80_model_unavailable',
    featureValues:null,missingMask:null,rawProbability:null});
  assert.equal(checkedShadowResponse(response,body,new Date('2026-10-13T00:00:04Z')).status,'unavailable');
});

test('durable request precedes inference and a validated result is recorded once',async()=>{
  const {request,response}=fixture(), order:string[]=[]; let saved:ShadowCompletion|undefined;
  await runLiveWinnerShadow({}, {
    prepare:async()=>{order.push('durable_request');return request;},
    infer:async()=>{order.push('infer');return response;},
    finish:async(_,result)=>{order.push('record');saved=result;},
    now:()=>new Date('2026-10-13T00:00:04Z'),
  });
  assert.deepEqual(order,['durable_request','infer','record']);
  assert.equal(saved?.status,'predicted');
  assert.equal(saved?.assessment.eligibleForProspectiveEvaluation,false);
  assert.equal(saved?.assessment.meetsVerifiedLiveLatencyPolicy,false);
});

test('duplicate durable attempt does not call model or overwrite result',async()=>{
  await runLiveWinnerShadow({}, {prepare:async()=>null,
    infer:async()=>{throw Error('must not infer');},finish:async()=>{throw Error('must not finish');}});
});

test('DB prepare failure forbids inference',async()=>{
  await assert.rejects(runLiveWinnerShadow({}, {prepare:async()=>{throw Error('database');},
    infer:async()=>{assert.fail('must not infer');},finish:async()=>{assert.fail('must not finish');}}),/database/);
});

test('timeout retains durable error without arbitrary service error text',async()=>{
  const {request}=fixture(); let saved:ShadowCompletion|undefined;
  await runLiveWinnerShadow({}, {prepare:async()=>request,infer:async()=>{throw Error('shadow_service_timeout');},
    finish:async(_,result)=>{saved=result;}});
  assert.equal(saved?.status,'error'); assert.equal(saved?.reason,'shadow_service_timeout');assert.equal(saved?.response,null);
});

test('unknown service error is redacted',async()=>{
  const {request}=fixture(); let saved:ShadowCompletion|undefined;
  await runLiveWinnerShadow({}, {prepare:async()=>request,infer:async()=>{throw Error('private SQL/token body');},
    finish:async(_,result)=>{saved=result;}});
  assert.equal(saved?.reason,'shadow_inference_failed');
});

test('fresh receipt does not convert unknown event latency into passed coverage',()=>{
  const {request}=fixture();
  const result=shadowAssessment(request,new Date('2026-10-13T00:00:03Z'));
  assert.equal(result.receiptAgeWithinLimit,true);assert.equal(result.meetsVerifiedLiveLatencyPolicy,false);
  assert.equal(result.totalEventLagLimitSeconds,300);assert.equal(result.localStateAgeLimitSeconds,180);
});

test('late and future receipts fail local age independently',()=>{
  const {request}=fixture();
  assert.equal(shadowAssessment(request,new Date('2026-10-13T00:03:01Z')).receiptAgeWithinLimit,false);
  assert.equal(shadowAssessment(request,new Date('2026-10-12T23:59:59Z')).receiptAgeWithinLimit,false);
});

test('local clock precision tolerance is bounded and never changes latency budget',()=>{
  const {request,response}=fixture();
  response.computedAt='2026-10-13T00:00:04.100Z';
  assert.doesNotThrow(()=>checkedShadowResponse(response,request.body,new Date('2026-10-13T00:00:04Z')));
  response.computedAt='2026-10-13T00:00:04.101Z';
  assert.throws(()=>checkedShadowResponse(response,request.body,new Date('2026-10-13T00:00:04Z')));
  const assessment=shadowAssessment(request,new Date('2026-10-13T00:03:00.001Z'));
  assert.equal(assessment.receiptAgeWithinLimit,false);
  assert.equal(assessment.localProcessClockToleranceMs,100);
});

for(const capture of [null,undefined,true])test(`capture outcome ${capture} refuses before inference without response`,async()=>{
 const {request}=fixture();request.evidence.outcomeKnownAtCapture=capture;let saved:ShadowCompletion|undefined;
 await runLiveWinnerShadow({}, {prepare:async()=>request,infer:async()=>assert.fail('must not infer'),
 finish:async(_,r)=>{saved=r;}});
 assert.equal(saved?.status,'unavailable');assert.equal(saved?.response,null);assert.equal(saved?.assessment.inferenceCalled,false);
});
for(const dispatch of [null,true])test(`dispatch outcome ${dispatch} refuses before inference`,async()=>{
 const {request}=fixture();request.outcomeKnownAtDispatch=dispatch;let saved:ShadowCompletion|undefined;
 await runLiveWinnerShadow({}, {prepare:async()=>request,infer:async()=>assert.fail('must not infer'),finish:async(_,r)=>{saved=r;}});
 assert.equal(saved?.response,null);assert.equal(saved?.status,'unavailable');
});
test('actual ~2 second cross-process clock inconsistency has explicit reason and no response',async()=>{
 const {request,response}=fixture();request.dispatchedAt=new Date('2026-10-13T00:00:05Z');
 let saved:ShadowCompletion|undefined;let tick=10;
 await runLiveWinnerShadow({}, {prepare:async()=>request,infer:async()=>response,finish:async(_,r)=>{saved=r;},
 now:()=>new Date('2026-10-13T00:00:03.045Z'),monotonicNow:()=>{tick+=25;return tick;}});
 assert.equal(saved?.reason,'shadow_clock_inconsistent');assert.equal(saved?.response,null);
 assert.equal(saved?.assessment.inferenceDurationSeconds,.025);
 const d=saved?.assessment.diagnostics as any;assert.equal(d.predicate,'dispatch_completion_bounds_inconsistent');
 assert.ok(d.responseMetadata.computedAt);assert.equal(d.responseMetadata.rawProbability,undefined);
});
test('input refusal records sanitized status/code and unavailable, without inference payload',async()=>{
 const {request}=fixture();let saved:ShadowCompletion|undefined;
 await runLiveWinnerShadow({}, {prepare:async()=>request,infer:async()=>{throw httpFailure(422,'{"detail":{"reason":"history_not_monotone_in_receipt_order"}}');},finish:async(_,r)=>{saved=r;}});
 assert.equal(saved?.status,'unavailable');assert.equal(saved?.reason,'shadow_input_contract_rejected');assert.equal(saved?.response,null);
 assert.equal((saved?.assessment.diagnostics as any).httpStatus,422);
});
test('invalid process clock keeps explicit clock diagnostic, not RangeError or guessed duration',()=>{
 const {request,response}=fixture();
 for(const [completed,dispatched] of [[new Date(NaN),request.dispatchedAt],[new Date('2026-10-13T00:00:04Z'),new Date(NaN)]]){
  assert.throws(()=>checkedShadowResponse(response,request.body,completed,dispatched),(e:unknown)=>
   e instanceof ShadowDiagnosticError&&e.code==='shadow_clock_inconsistent');
 }
 assert.equal(shadowAssessment(request,new Date(NaN)).receiptToCompletionSeconds,null);
});
