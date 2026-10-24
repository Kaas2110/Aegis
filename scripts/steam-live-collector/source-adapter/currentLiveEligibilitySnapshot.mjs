/** Final synchronous host read. Call after evidence IO; do not await any work
 * after this fence before constructing the bounded diagnostic response. */
import {instantNs} from './causalTime.mjs';
export function readCurrentLiveEligibilitySnapshot({readLiveEligibility,now,matchId,minimumDecisionAt=null}){
 let evaluatedAt=null;
 const unavailable=reason=>({evaluatedAt,state:{eligibleForRetainingForecast:false,reason,lastTraceSha256:null,stateView:null,ageSeconds:null}});
 try{
  const startedAt=now(),started=instantNs(startedAt),minimum=minimumDecisionAt===null?null:instantNs(minimumDecisionAt);
  if(started===null||minimumDecisionAt!==null&&(minimum===null||started<minimum))return unavailable('owned_current_read_clock_invalid');
  let state=readLiveEligibility({matchId,decisionAt:startedAt});
  // A promise cannot provide the final in-process STOP/source-epoch fence.
  if(state&&typeof state.then==='function'){Promise.resolve(state).catch(()=>{});return unavailable('synchronous_live_eligibility_port_required');}
  evaluatedAt=now();const final=instantNs(evaluatedAt);
  if(final===null||final<started)return unavailable('owned_current_read_clock_invalid');
  const view=state?.stateView??null,confirmed=instantNs(view?.lastConfirmedAt),expires=instantNs(view?.expiresAt);
  let eligible=state?.eligibleForRetainingForecast===true,reason=state?.reason??'qualified_live_state_port_unavailable';
  if(eligible&&(confirmed===null||confirmed>final||expires===null||expires<confirmed)){eligible=false;reason='qualified_live_state_time_invalid';}
  if(eligible&&final>expires){eligible=false;reason='eligible_state_expired';}
  return{evaluatedAt,state:{eligibleForRetainingForecast:eligible,reason,lastTraceSha256:state?.lastTraceSha256??null,stateView:view===null?null:{observationId:view.observationId??null,lastConfirmedAt:view.lastConfirmedAt??null,expiresAt:view.expiresAt??null,classification:view.classification??'unknown',continuityGeneration:view.continuityGeneration??null},ageSeconds:confirmed===null||final<confirmed?null:Number(final-confirmed)/1e9}};
 }catch{return unavailable('qualified_live_state_port_unavailable');}
}
