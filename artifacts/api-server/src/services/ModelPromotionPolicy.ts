import {eligibleTotalsModel} from './TotalsModelPolicy';

const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export type ModelPromotionDecision={allowed:true;reason:null}|{allowed:false;reason:string};

/** Explicit activation metadata gate. Absence is not approval.
 * This is not a substitute for the future artifact/report verification pipeline.
 * Existing active models/readers are unchanged; only a requested promotion uses it.
 */
export function modelPromotionDecision(kind:string,metadata:unknown):ModelPromotionDecision {
  const deny=(reason:string):ModelPromotionDecision=>({allowed:false,reason});
  if(!record(metadata))return deny('validation_metadata_missing_or_invalid');
  if(metadata.validationStatus!=='validated')return deny('validation_status_not_validated');
  if(metadata.eligibleForPromotion!==true||metadata.eligibleForServing!==true)
    return deny('explicit_promotion_and_serving_approval_required');
  if(metadata.diagnosticOnly===true||metadata.executionMode==='runtime_shadow'
    ||(record(metadata.trainingRun)&&metadata.trainingRun.mode==='candidate_only'))
    return deny('diagnostic_or_candidate_only_model');
  if(typeof metadata.validationReport!=='string'||!metadata.validationReport.trim()
    ||metadata.validationReport.length>4096)return deny('validation_report_reference_required');
  if(!eligibleTotalsModel(kind,metadata))return deny('totals_serving_contract_not_validated');
  return {allowed:true,reason:null};
}
