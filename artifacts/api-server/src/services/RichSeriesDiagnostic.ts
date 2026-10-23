/** Internal diagnostic card adapter. Callers keep existing prediction/auth guards. */
type RuntimeResult = Record<string, any>;
export interface DiagnosticIdentity { matchId:number; seriesId:number; teamAId:number; teamBId:number }
export function richSeriesDiagnosticView(result:RuntimeResult, expected:DiagnosticIdentity, now=Date.now()) {
  const flags=['active','eligibleForServing','eligibleForPromotion','eligibleForQualityClaims','prospectiveValidated'];
  if(result.contract!=='series14255.live-composition.diagnostic.v1' || flags.some(k=>result[k]!==false)) throw new Error('diagnostic_result_flags_required');
  if(result.status==='unavailable' && result.context==null) return {diagnosticOnly:true,mainCard:{state:'unavailable',probabilityTeamA:null,probabilityTeamB:null},details:{maps:[],reason:result.reason},eligibleForServing:false};
  const c=result.context;
  if(!c || Object.entries(expected).some(([key,value])=>c[key]!==value)) throw new Error('diagnostic_result_identity_mismatch');
  if(result.status==='observed_terminal') {
    if(![expected.teamAId,expected.teamBId].includes(result.observedWinnerTeamId))throw new Error('observed_terminal_winner_identity_required');
    return {diagnosticOnly:true,mainCard:{state:'observed_terminal',probabilityTeamA:null,probabilityTeamB:null,observedWinnerTeamId:result.observedWinnerTeamId},details:{maps:[],reason:'observed_result_is_not_a_forecast'},eligibleForServing:false};
  }
  if(result.status!=='diagnostic_ready') return {diagnosticOnly:true,mainCard:{state:'unavailable',probabilityTeamA:null,probabilityTeamB:null},details:{maps:[],reason:result.reason},eligibleForServing:false};
  const p=result.mainCard?.seriesProbabilityTeamA;const expiry=Date.parse(result.mainCard?.expiresAt);
  if(typeof p!=='number'||!Number.isFinite(p)||p<0||p>1||!Number.isFinite(expiry)||expiry<=now)throw new Error('diagnostic_probability_stale_or_invalid');
  if(result.mainCard.basis!=='deciding_map_identity' && (result.modelBinding?.scope!=='explicit_cv_fold3_diagnostic_not_final_fit'||result.modelBinding?.features!==14255))throw new Error('explicit_full_rich_diagnostic_binding_required');
  const current=result.details?.currentMapProbabilityTeamA;
  if(typeof current!=='number'||!Number.isFinite(current)||current<0||current>1)throw new Error('guarded_current_map_probability_required');
  return {diagnosticOnly:true,mainCard:{state:'diagnostic_ready',probabilityTeamA:p,probabilityTeamB:1-p,basis:result.mainCard.basis,expiresAt:result.mainCard.expiresAt},
    details:{maps:[{mapNumber:c.currentMapNumber,state:'current',probabilityTeamA:current,probabilityTeamB:1-current,modelVersion:result.details.currentMapModelVersion},
      ...(result.details.futureMaps??[]).map((m:RuntimeResult)=>({mapNumber:m.mapNumber,state:'potential_future',mayBePlayed:true,probabilityTeamA:null,probabilityTeamB:null,reason:'conditional_series_heads_do_not_identify_individual_future_map_probability'}))],
      branches:{ifCurrentWon:result.details.conditionalSeriesIfCurrentWonTeamA,ifCurrentLost:result.details.conditionalSeriesIfCurrentLostTeamA},branchOrderViolation:result.details.branchOrderViolation,limitations:result.limitations},eligibleForServing:false};
}
export async function readRichSeriesDiagnostic(readerName:string, expected:DiagnosticIdentity, readAuthenticatedRuntime:(readerName:string)=>Promise<RuntimeResult>, now=Date.now()) {
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(readerName))throw new Error('diagnostic_reader_name_required');
  // Existing server-owned callback supplies authentication/timeout. Never send an
  // arbitrary model path, vector, current final result or client probability.
  return richSeriesDiagnosticView(await readAuthenticatedRuntime(readerName),expected,now);
}
