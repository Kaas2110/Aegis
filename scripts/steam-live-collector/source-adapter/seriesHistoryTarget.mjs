/** Immutable series forecast transition identity, independent of map assignment.
 * Ports supply actual retained receipts; local hashes do not authenticate providers.
 */
import {createHash} from 'node:crypto';
import {instantNs} from './causalTime.mjs';
import {evidenceHash} from './playerHeroEconomyFeatures.mjs';
import {produceSeriesContext} from './seriesContextFeatures.mjs';
export const SERIES_HISTORY_TARGET_CONTRACT='aegis.series-history-target.v1';
const id=x=>typeof x==='string'&&/^[1-9]\d{0,19}$/.test(x);
const read=input=>{if(typeof input?.utf8!=='string'||Buffer.byteLength(input.utf8)>2*1024*1024||Buffer.byteLength(input.utf8)!==input.pin?.bytes||createHash('sha256').update(input.utf8).digest('hex')!==input.pin.sha256)throw Error('series_history_receipt_pin');return JSON.parse(input.utf8);};
const pin=x=>{const utf8=JSON.stringify(x);return{utf8,pin:{path:'series-history/target.json',bytes:Buffer.byteLength(utf8),sha256:createHash('sha256').update(utf8).digest('hex')}};};
export function advanceSeriesHistoryTarget(previousTargetInput,{seriesInput,identityInput,decisionAt}={}){
 const s=read(seriesInput),identity=read(identityInput),old=previousTargetInput?read(previousTargetInput):null,decision=instantNs(decisionAt);
 const verifiedSeries=produceSeriesContext({seriesInput,decisionAt});
 if(verifiedSeries.terminal)return{status:'series_complete',targetInput:null,actualWinnerTeamId:verifiedSeries.actualWinnerTeamId,eligibleForTraining:false,eligibleForServing:false};
 if(s.contract!=='aegis.series-map-receipts.v1'||!id(s.team1Id)||!id(s.team2Id)||s.team1Id===s.team2Id||typeof s.seriesId!=='string'||!s.seriesId.length||!Number.isSafeInteger(s.completeThroughMapNumber)||s.completeThroughMapNumber<0||s.completeThroughMapNumber>4||!Array.isArray(s.previousMaps)||s.previousMaps.length!==s.completeThroughMapNumber||instantNs(s.availableAt)===null||decision===null||instantNs(s.availableAt)>decision)throw Error('series_history_series_receipt');
 if(identity.contract!=='aegis.series-roster-receipt.v1'||identity.seriesId!==s.seriesId||identity.team1Id!==s.team1Id||identity.team2Id!==s.team2Id||instantNs(identity.knownAt)===null||instantNs(identity.knownAt)>decision||!Array.isArray(identity.players)||identity.players.length>10)throw Error('series_history_roster_receipt');
 const players=identity.players.map(p=>{if(!p||Object.keys(p).some(k=>!['team','accountId'].includes(k))||!['team1','team2'].includes(p.team)||p.accountId!==null&&(!id(p.accountId)||BigInt(p.accountId)>=4294967295n))throw Error('series_history_roster_player');return{team:p.team,accountId:p.accountId};}).sort((a,b)=>a.team.localeCompare(b.team)||String(a.accountId).localeCompare(String(b.accountId)));
 if(['team1','team2'].some(t=>players.filter(p=>p.team===t).length>5)||new Set(players.filter(p=>p.accountId!==null).map(p=>p.accountId)).size!==players.filter(p=>p.accountId!==null).length)throw Error('series_history_duplicate_or_team_bound');
 const phase=s.completeThroughMapNumber===0?'SERIES_PRE':'SERIES_BETWEEN',transitionId=s.seriesId+':after:'+s.completeThroughMapNumber;
 const oldMapCount=typeof old?.transitionId==='string'?Number(old.transitionId.split(':after:').at(-1)):null;
 if(old&&(old.contract!==SERIES_HISTORY_TARGET_CONTRACT||old.seriesId!==s.seriesId||old.team1Id!==s.team1Id||old.team2Id!==s.team2Id||!Number.isSafeInteger(oldMapCount)||oldMapCount<0||oldMapCount>4||old.transitionId!==s.seriesId+':after:'+oldMapCount||old.phase!==(oldMapCount===0?'SERIES_PRE':'SERIES_BETWEEN')||!Number.isSafeInteger(old.identityRevision)||old.identityRevision<0||!Array.isArray(old.players)||[old.historyCutoffAt,old.validFrom,old.identityKnownAt,old.lastSeriesReceiptAt].some(t=>instantNs(t)===null)||instantNs(old.historyCutoffAt)>instantNs(old.validFrom)||instantNs(old.identityKnownAt)>instantNs(old.validFrom)||instantNs(old.historyCutoffAt)>instantNs(old.lastSeriesReceiptAt)||instantNs(old.validFrom)>decision||instantNs(old.lastSeriesReceiptAt)>decision))throw Error('series_history_previous_identity');
 const same=old?.transitionId===transitionId;
 if(old&&s.completeThroughMapNumber<oldMapCount)throw Error('series_history_transition_regression');
 const cut=same?old.historyCutoffAt:s.availableAt;
 if(instantNs(cut)>instantNs(s.availableAt)||old&&instantNs(s.availableAt)<instantNs(old.lastSeriesReceiptAt))throw Error('series_history_receipt_regression');
 if(same){const known=old.players.filter(p=>p.accountId!==null);if(known.some(p=>!players.some(q=>q.team===p.team&&q.accountId===p.accountId)))throw Error('series_history_known_roster_change_requires_review');}
 const rosterChanged=old!==null&&evidenceHash(old.players)!==evidenceHash(players);
 if(rosterChanged&&instantNs(identity.knownAt)<instantNs(old.identityKnownAt))throw Error('series_history_identity_receipt_regression');
 const changed=same&&rosterChanged,identityKnownAt=old&&!rosterChanged?old.identityKnownAt:identity.knownAt;
 const validFrom=[cut,identityKnownAt,same?old.validFrom:cut].reduce((a,b)=>instantNs(a)>instantNs(b)?a:b);
 const target={contract:SERIES_HISTORY_TARGET_CONTRACT,seriesId:s.seriesId,phase,transitionId,historyCutoffAt:cut,validFrom,identityKnownAt,lastSeriesReceiptAt:s.availableAt,identityRevision:same?old.identityRevision+Number(changed):0,team1Id:s.team1Id,team2Id:s.team2Id,players};
 return{targetInput:pin(target),target,sourceBindings:{seriesReceipt:structuredClone(seriesInput.pin),rosterReceipt:structuredClone(identityInput.pin)},newTransition:!same,newIdentityRevision:changed,availabilityBasis:'retained_host_receipts_not_provider_signature',eligibleForTraining:false,eligibleForServing:false};
}
