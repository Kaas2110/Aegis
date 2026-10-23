/** Bind real closed executor results to separately completed evaluations. */
import {aggregateFitResults} from '../executor/aggregate-fit-results.mjs';
import {existsSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {review,need,FAMILIES,digest} from './receipt.mjs';

function exactKeys(value,keys,reason){need(value&&typeof value==='object'&&!Array.isArray(value)&&JSON.stringify(Object.keys(value).sort())===JSON.stringify([...keys].sort()),reason);}

export function assembleConfig(input,now){
 need(input?.contract==='aegis.whole-intent-evaluation-inputs.v1'&&typeof input.policyId==='string'&&input.policyId.length>0&&digest(input.intentId),'whole_intent_evaluation_inputs');
 need(Number.isSafeInteger(input.maximumVerificationBytes)&&input.maximumVerificationBytes>=1024&&input.maximumVerificationBytes<=4*1024**3,'bounded_assembly_verification_budget');
 need(Array.isArray(input.stopMarkerPaths)&&input.stopMarkerPaths.every(p=>typeof p==='string'&&isAbsolute(p)),'explicit_absolute_stop_marker_list');
 need(!input.stopMarkerPaths.some(p=>existsSync(p)),'manual_stop_before_assembly');
 const aggregate=aggregateFitResults({policyId:input.policyId,intentId:input.intentId,entries:input.closedFits,maximumVerificationBytes:input.maximumVerificationBytes});
 exactKeys(input.fitEvaluations,Object.keys(aggregate.fits),'all_forty_independent_fit_evaluations');
 exactKeys(input.datasets,FAMILIES,'all_eight_assembly_datasets');
 const config={contract:'aegis.whole-intent-receipt-config.v1',policyId:input.policyId,intentId:input.intentId,maximumVerificationBytes:input.maximumVerificationBytes,intent:input.intent,datasets:input.datasets,fits:Object.fromEntries(Object.entries(aggregate.fits).map(([id,refs])=>[id,{...refs,evaluation:input.fitEvaluations[id]}])),familyEvaluations:input.familyEvaluations,reviewReceipt:input.reviewReceipt,stopMarkerPaths:input.stopMarkerPaths,outputRoot:input.outputRoot};
 const checked=review(config,now);
 return {config,summary:{contract:'aegis.whole-intent-evaluation-assembly.v1',status:'complete_evidence_verified',policyId:config.policyId,intentId:config.intentId,families:FAMILIES.length,closedFits:checked.summaries.length,completedAt:checked.completedAt,aggregateVerifiedBytes:aggregate.verifiedBytes,receiptVerifiedBytes:config.maximumVerificationBytes-checked.state.remaining,newNativeFits:0,providerCalls:0,modelLoads:0,monthlyAnchorCreated:false,receiptWritten:false,publicPromotion:false}};
}
