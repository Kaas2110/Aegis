/** Legacy v2 wrapper: gates and resulting payload remain unchanged. */
import {instantNs} from './causalTime.mjs';
import {validateFrozenHistory} from './causalContext.mjs';
import {evidenceHash} from './playerHeroEconomyFeatures.mjs';
import {pinned,normalizedPlayer,calculateHistoryCore,FACTS_CONTRACT,NATIVE_CONTRACT} from './historyCalculationCore.mjs';
export {FACTS_CONTRACT,NATIVE_CONTRACT};
export const PRODUCER_CONTRACT='aegis.frozen-player-context-producer.v2';
const MAX_MAPS=100000,MAX_FRAMES=20000;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const positiveId=x=>typeof x==='string'&&/^[1-9]\d{0,19}$/.test(x);
const proof=x=>typeof x==='string'&&x.length>0&&x.length<256;
function blocked(reason,audit,bindings){return{contract:PRODUCER_CONTRACT,status:'blocked',reason,context:null,audit,bindings,APIcalls:0,nativeFits:0,publicPromotion:false};}
export function produceFrozenPlayerContext({target,factsInput,nativeInput,roleProofs=[],minimumSupport=5}={}){
 if(!Number.isSafeInteger(minimumSupport)||minimumSupport<3||minimumSupport>1000)throw Error('minimum_support_3_to_1000');
 const facts=pinned(factsInput,FACTS_CONTRACT,MAX_MAPS),native=pinned(nativeInput,NATIVE_CONTRACT,MAX_FRAMES);
 const bindings={facts:facts.pin,nativeObservations:native.pin};const audit={factRows:facts.rows.length,nativeRows:native.rows.length};
 const known=instantNs(target?.knownAt),freeze=instantNs(target?.frozenBeforeMapAt),receipt=instantNs(target?.receivedAt),start=target?.mapStartEvidence;
 if(!positiveId(target?.matchId)||known===null||freeze===null||receipt===null||known>freeze)return blocked('target_identity_or_cutoff',audit,bindings);
 // Fail early on missing target proof; the complete emitted context is checked again by
 // the installed shared validator below. No synthetic source history is constructed.
 const started=instantNs(start?.startedAt),startKnown=instantNs(start?.knownAt);
 if(!object(start)||start.matchId!==target.matchId||start.confirmed!==true||!proof(start.evidenceRef)||started===null||startKnown===null||freeze>=started||started>startKnown||startKnown>receipt)return blocked('confirmed_map_start_required',audit,bindings);
 if(!Array.isArray(target.players)||target.players.length!==10)return blocked('complete_target_roster_required',audit,bindings);
 const roster=target.players.map(normalizedPlayer);if(roster.some(p=>!p)||new Set(roster.map(p=>p.accountId)).size!==10||new Set(roster.map(p=>p.heroId)).size!==10||['radiant','dire'].some(side=>roster.filter(p=>p.side===side).length!==5))return blocked('complete_target_roster_required',audit,bindings);
 const teams=['radiant','dire'].map(side=>new Set(roster.filter(p=>p.side===side).map(p=>p.teamId)));
 if(teams.some(s=>s.size!==1)||[...teams[0]][0]!==null&&[...teams[0]][0]===[...teams[1]][0])return blocked('target_team_identity_inconsistent',audit,bindings);
 if(!Array.isArray(roleProofs)||roleProofs.length>10)throw Error('roles_bound');
 const calculated=calculateHistoryCore({target,known,roster,facts,native,roleProofs,minimumSupport,audit,bindings});
 if(calculated.status==='blocked')return blocked(calculated.reason,audit,bindings);
 const {players,roles,references,sourceMatches,heroCohort}=calculated;
 const context={contract:'aegis.frozen-team-style-context.v2',mode:'prematch_frozen',matchId:target.matchId,knownAt:target.knownAt,frozenBeforeMapAt:target.frozenBeforeMapAt,mapStartEvidence:{...start},sourceMatches,availabilityBasis:'historical_reconstruction',evidenceRef:`${PRODUCER_CONTRACT}:${facts.pin.sha256.slice(0,32)}:${native.pin.sha256.slice(0,32)}`,featurePayload:{players,roles,heroMinuteReferences:references},producer:{contract:PRODUCER_CONTRACT,minimumSupport,newLateMinimumSupport:Math.max(5,minimumSupport),bindings,heroCohort,aggressionIsKillPaceProxy:true,lateThresholdMinutes:40,nativeMinuteSelection:'last_clock_at_or_before_minute_within_30_seconds',recordsPerMapHeroMinuteMaximum:1,noNetWorthToGpmSubstitution:true,asOfReconstructionIsNotOriginalRecordedPrediction:true}};
 context.contentHash=evidenceHash(context);const accepted=validateFrozenHistory(context,{matchId:target.matchId,receivedAt:target.receivedAt});if(!accepted.accepted)throw Error('generated_context_failed_shared_validator:'+accepted.reason);

 return{contract:PRODUCER_CONTRACT,status:'produced_reconstruction',context,audit,bindings,APIcalls:0,nativeFits:0,publicPromotion:false};
}
