import test from 'node:test';import assert from 'node:assert/strict';
import {boundedResponseText,httpFailure,safeResponseMetadata} from './liveWinnerShadowDiagnostics';
test('422 input refusal remains distinct from service unavailability with safe exact reason',()=>{
 const e=httpFailure(422,JSON.stringify({detail:{reason:'history_not_monotone_in_receipt_order'}}));
 assert.equal(e.code,'shadow_input_contract_rejected');assert.equal(e.diagnostics.httpStatus,422);
 assert.equal(e.diagnostics.upstreamReason,'history_not_monotone_in_receipt_order');
 assert.equal(httpFailure(503,JSON.stringify({detail:{reason:'shadow_busy'}})).code,'shadow_service_unavailable');
});
test('arbitrary HTML, secret reason and nested values cannot enter durable diagnostics',()=>{
 const e=httpFailure(422,JSON.stringify({detail:{reason:'secret-token',nested:'secret-token'}}));
 assert.equal(e.diagnostics.upstreamReason,'unrecognized_or_missing_reason');
 assert.ok(!JSON.stringify(e.diagnostics).includes('secret-token'));
 assert.equal(httpFailure(401,'secret-token').code,'shadow_service_unauthorized');
});
test('HTTP body is bounded before persistence, oversize stream is cancelled',async()=>{
 let cancelled=false;
 const response=new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('x'.repeat(9000)));},cancel(){cancelled=true;}}));
 const body=await boundedResponseText(response,8192);assert.equal(body.text.length,8192);assert.equal(body.truncated,true);assert.equal(cancelled,true);
});
test('rejected response metadata excludes probability, vector, arbitrary fields and strings',()=>{
 const data=safeResponseMetadata({status:'shadow_predicted',rawProbability:.6,featureValues:[1,2],missingMask:[false,false],
 observationId:'a'.repeat(64),computedAt:'2026-10-13T00:00:01Z',reason:'secret-token',unknown:{token:'secret-token'}});
 assert.equal(data.featureValuesLength,2);assert.equal(data.observationId,'a'.repeat(64));
 assert.ok(!('rawProbability' in data));assert.ok(!('featureValues' in data));assert.ok(!JSON.stringify(data).includes('secret-token'));
});
