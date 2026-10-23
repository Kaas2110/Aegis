/** Bounded public reason codes only: never serialize registry rows, blobs or exceptions. */
export type LiveTotalsRefusal =
  | 'totals_model_registry_not_loaded'
  | 'totals_model_registry_unavailable'
  | 'totals_no_active_lightgbm_model'
  | 'totals_validation_gate_rejected'
  | 'totals_artifact_missing'
  | 'totals_required_input_missing'
  | 'totals_input_invalid'
  | 'totals_outside_model_clock_support'
  | 'totals_draft_context_unavailable'
  | 'totals_inference_unavailable'
  | 'totals_output_contract_mismatch'
  | 'totals_model_changed_during_inference';

export type LiveTotalsSnapshot = {
  gameTimeSec:number|null; radiantScore:number|null; direScore:number|null;
  radiantLead:number|null; buildingState:number|null;
};
export function liveTotalsInputRefusal(s:LiveTotalsSnapshot):LiveTotalsRefusal|null {
  if(s.gameTimeSec==null) return 'totals_required_input_missing';
  if(typeof s.gameTimeSec!=='number'||!Number.isFinite(s.gameTimeSec)) return 'totals_input_invalid';
  // This is the EXISTING legacy model minimum, not the separate shadow model's 5-minute domain.
  if(s.gameTimeSec<60) return 'totals_outside_model_clock_support';
  const fields=[s.radiantScore,s.direScore,s.radiantLead,s.buildingState];
  if(fields.some(v=>v==null)) return 'totals_required_input_missing';
  if(!fields.every(v=>typeof v==='number'&&Number.isFinite(v))
    || !Number.isInteger(s.radiantScore)||!Number.isInteger(s.direScore)||s.radiantScore!<0||s.direScore!<0)
    return 'totals_input_invalid';
  return null;
}

export function absentLiveTotalsModelReason(reasons:Array<LiveTotalsRefusal|null|undefined>):LiveTotalsRefusal {
  // Prefer an actionable policy failure to the absence of an optional alternative tier.
  for(const reason of ['totals_model_registry_unavailable','totals_validation_gate_rejected','totals_artifact_missing',
    'totals_no_active_lightgbm_model','totals_model_registry_not_loaded'] as const)
    if(reasons.includes(reason)) return reason;
  return 'totals_no_active_lightgbm_model';
}

export function recordLiveTotalsRefusals(
  result:{unavailableReasons:{kills:LiveTotalsRefusal|null;duration:LiveTotalsRefusal|null}},
  journal:{unavailable(producer:'live_total_kills'|'live_total_duration',reason:string):void}|undefined,
):void {
  if(result.unavailableReasons.kills) journal?.unavailable('live_total_kills',result.unavailableReasons.kills);
  if(result.unavailableReasons.duration) journal?.unavailable('live_total_duration',result.unavailableReasons.duration);
}
