import {instantNs} from './causalTime.mjs';
export const FROZEN_HISTORY_CONTRACT='aegis.frozen-team-style-context.v2';
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const proof=x=>typeof x==='string'&&x.length>0&&x.length<256;
const mapId=x=>typeof x==='string'&&/^[1-9]\d{0,19}$/.test(x);
const rejected=reason=>({accepted:false,reason,features:{},featurePayload:null});
/** Only the explicitly frozen prematch mode is implemented. Live-as-of history is
 * possible, but needs a separate contract. Missing history never invalidates live inputs.
 * A start inferred from receipt minus a delayed game clock is not confirmed start proof.
 */
export function validateFrozenHistory(context,{matchId,receivedAt}={}){
 if(!context)return rejected('history_missing');
 if(!object(context)||context.contract!==FROZEN_HISTORY_CONTRACT||context.mode!=='prematch_frozen')return rejected('history_contract_or_mode');
 if(!mapId(matchId)||context.matchId!==matchId||!proof(context.evidenceRef))return rejected('history_identity_or_evidence');
 const at=instantNs(receivedAt),known=instantNs(context.knownAt),freeze=instantNs(context.frozenBeforeMapAt);
 if(at===null||known===null||freeze===null||known>freeze)return rejected('history_availability_or_freeze');
 const start=context.mapStartEvidence,started=instantNs(start?.startedAt),startKnown=instantNs(start?.knownAt);
 if(!object(start)||start.confirmed!==true||start.matchId!==matchId||!proof(start.evidenceRef)||started===null||startKnown===null||freeze>=started||started>startKnown||startKnown>at)return rejected('history_start_unconfirmed_or_late');
 if(!Array.isArray(context.sourceMatches)||!context.sourceMatches.length||context.sourceMatches.length>100000)return rejected('history_source_matches_missing_or_bound');
 const seen=new Set();
 for(const source of context.sourceMatches){
  if(!mapId(source?.matchId)||source.matchId===matchId||seen.has(source.matchId))return rejected('history_source_identity_or_current_map');
  seen.add(source.matchId);
  const ended=instantNs(source.endedAt),outcomeKnown=instantNs(source.outcomeKnownAt);
  if(ended===null||outcomeKnown===null||ended>outcomeKnown||outcomeKnown>known)return rejected('history_source_unavailable_at_freeze');
 }
 if(context.features!==undefined&&!object(context.features))return rejected('history_features_not_object');
 if(context.featurePayload!==undefined&&!object(context.featurePayload))return rejected('history_payload_not_object');
 return {accepted:true,reason:'prematch_frozen_history_valid',features:context.features??{},featurePayload:context.featurePayload??null,context};
}
