import { evidenceHash } from '../lib/predictionEvidence';
import type { ObservationEnvelope } from './LiveWinnerShadowContract';

export const WINNER_HISTORY_POLICY = 'receipt_monotone_priors_v2';
export const WINNER_HISTORY_POLICY_HASH = evidenceHash({
  version:WINNER_HISTORY_POLICY, ordering:'original_receipt_order_never_game_clock_sort',
  prior:'forward_greedy_strict_clock_nondecreasing_scores_receipt_recorded',
  currentRegression:'empty_history_diagnostic_only', maxHistory:256, lookbackGameSeconds:420,
});
type State = { clock:number; radiant:number; dire:number; received:number; recorded:number; r:number; d:number };
const integer=(v:unknown,min:number)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min;
const finite=(v:unknown)=>typeof v==='number'&&Number.isFinite(v);
const timestamp=(v:unknown)=>typeof v==='string'&&v.length<=64?Date.parse(v):NaN;
function state(e:ObservationEnvelope,matchId:number): State|null {
  const p=e?.input;
  if(!p||e.source!=='opendota'||e.targetScope!=='map'||e.clockUnit!=='seconds'||e.scoreUnit!=='kills'
    ||!/^[a-f0-9]{64}$/.test(e.observationId)||p.matchId!==matchId
    ||p.synthetic===true||p.backfill===true||p.source==='synthetic'||p.source==='backfill'
    ||!integer(p.radiantTeamId,1)||!integer(p.direTeamId,1)||p.radiantTeamId===p.direTeamId
    ||!integer(p.gameTimeSec,-Number.MAX_SAFE_INTEGER)||!integer(p.radiantScore,0)||!integer(p.direScore,0)||!finite(p.radiantLead))return null;
  const received=timestamp(e.receivedAt),recorded=timestamp(e.recordedAt);
  if(!Number.isFinite(received)||!Number.isFinite(recorded)||received>recorded)return null;
  return {clock:p.gameTimeSec as number,radiant:p.radiantScore as number,dire:p.direScore as number,
    received,recorded,r:p.radiantTeamId as number,d:p.direTeamId as number};
}
export interface HistorySelection {
  history:ObservationEnvelope[];
  diagnostics:{policy:string;policyHash:string;candidateCount:number;retainedCount:number;
    excluded:{observationId:string|null;reason:string}[];qualityReasons:string[];normalTrainingEligibility:boolean};
}
/** Never edits observations or guesses an ordering. Future input does not become a feature. */
export function selectWinnerHistory(current:ObservationEnvelope,history:ObservationEnvelope[],matchId:number):HistorySelection {
  if(history.length>256)throw new Error('shadow_history_limit_exceeded');
  const selected:ObservationEnvelope[]=[], excluded:HistorySelection['diagnostics']['excluded']=[];
  const reasons=new Set<string>(), seen=new Set<string>(); const c=state(current,matchId);
  let previous:State|undefined;
  const omit=(item:ObservationEnvelope,reason:string)=>{
    excluded.push({observationId:/^[a-f0-9]{64}$/.test(item?.observationId)?item.observationId:null,reason});
    reasons.add('history_context_filtered');
  };
  if(!c){
    // Do not sanitize the current packet into validity; Python will reject it.
    return {history:[],diagnostics:{policy:WINNER_HISTORY_POLICY,policyHash:WINNER_HISTORY_POLICY_HASH,
      candidateCount:history.length,retainedCount:0,excluded:[],qualityReasons:['current_input_invalid'],normalTrainingEligibility:false}};
  }
  for(const item of history){
    const p=state(item,matchId);
    if(!p){omit(item,'invalid_prior_state');continue;}
    if(item.observationId===current.observationId||seen.has(item.observationId)){omit(item,'duplicate_observation');continue;}
    if(p.received>c.received||p.recorded>c.recorded){omit(item,'after_current_receipt_or_recorded_cutoff');continue;}
    if(p.r!==c.r||p.d!==c.d){omit(item,'prior_side_identity_mismatch');continue;}
    if(p.clock<Math.max(0,c.clock-420)){omit(item,'outside_history_clock_window');continue;}
    // A prior with a clock at/after current is retained as a regression signal,
    // then the entire trajectory is reset below. It never enters model history.
    if(previous&&(p.received<previous.received||p.recorded<previous.recorded)){
      omit(item,'prior_receipt_order_regressed');continue;
    }
    if(previous&&(p.clock<=previous.clock||p.radiant<previous.radiant||p.dire<previous.dire)){
      omit(item,'prior_clock_or_score_regressed');continue;
    }
    selected.push(item);seen.add(item.observationId);previous=p;
  }
  const currentClockRegression=!!previous&&c.clock<=previous.clock;
  const currentScoreRegression=!!previous&&(c.radiant<previous.radiant||c.dire<previous.dire);
  if(currentClockRegression||currentScoreRegression){
    if(currentClockRegression)reasons.add('current_clock_regression');
    if(currentScoreRegression)reasons.add('current_score_regression');
    reasons.add('trajectory_reset_diagnostic_only');
    for(const item of selected)excluded.push({observationId:item.observationId,reason:'trajectory_reset_for_current_regression'});
    selected.length=0;
  }
  return {history:selected,diagnostics:{policy:WINNER_HISTORY_POLICY,policyHash:WINNER_HISTORY_POLICY_HASH,
    candidateCount:history.length,retainedCount:selected.length,excluded,qualityReasons:[...reasons],
    normalTrainingEligibility:!currentClockRegression&&!currentScoreRegression}};
}
