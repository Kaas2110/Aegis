/** Shared target-only validation for actual static producer and persisted proof.
 * Parsed identity/horizon consistency is not authentication of host receipts. */
import{createHash}from'node:crypto';
import{instantNs}from'./causalTime.mjs';
import{snapshotPlainRecord}from'./diagnosticResourceArena.mjs';
const SIDE=['radiant','dire'],obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x),id=x=>typeof x==='string'&&/^[1-9]\d{0,19}$/.test(x),account=x=>id(x)&&BigInt(x)<4294967295n,sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
function read(targetInput,label){
 const input=snapshotPlainRecord(targetInput,{maxKeys:8}),d=snapshotPlainRecord(input.pin,{maxKeys:8}),utf8=input.utf8,bytes=typeof utf8==='string'?Buffer.byteLength(utf8):0;
 if(bytes<1||bytes>262144||bytes!==d.bytes||!sha(d.sha256)||createHash('sha256').update(utf8).digest('hex')!==d.sha256)throw Error(label);
 return{target:JSON.parse(utf8),pin:{sha256:d.sha256,bytes:d.bytes}};
}
export function readPrematchHistoryTargetInput({targetInput,decisionAt}={}){
 const{target,pin}=read(targetInput,'relational_prematch_input_pin'),allowed=['contract','matchId','knownAt','historyCutoffAt','teams','players'];
 if(!obj(target)||target.contract!=='aegis.prematch-history-target.v1'||Object.keys(target).some(k=>!allowed.includes(k))||!id(target.matchId)||!obj(target.teams)||Object.keys(target.teams).some(k=>!SIDE.includes(k))||SIDE.some(s=>target.teams[s]!==null&&!id(target.teams[s]))||target.teams.radiant!==null&&target.teams.radiant===target.teams.dire||!Array.isArray(target.players)||target.players.length>10)throw Error('relational_prematch_target_contract');
 const receipt=instantNs(target.knownAt),cutoff=instantNs(target.historyCutoffAt),decision=instantNs(decisionAt);
 if(receipt===null||cutoff===null||decision===null||cutoff>receipt||receipt>decision)throw Error('relational_prematch_target_times');
 const players=target.players.map(p=>{
  if(!obj(p)||Object.keys(p).some(k=>!['accountId','teamId','side','heroId'].includes(k))||p.heroId!==null||!SIDE.includes(p.side)||p.accountId!==null&&!account(p.accountId)||p.teamId!==target.teams[p.side])throw Error('relational_prematch_player_or_current_hero_forbidden');return{...p};
 });
 if(new Set(players.map(p=>p.accountId).filter(account)).size!==players.filter(p=>account(p.accountId)).length||SIDE.some(s=>players.filter(p=>p.side===s).length>5))throw Error('relational_prematch_duplicate_or_side_bound');
 for(const side of SIDE)while(players.filter(p=>p.side===side).length<5)players.push({accountId:null,heroId:null,side,teamId:target.teams[side]});
 return freeze({target,players,historyCutoffAt:target.historyCutoffAt,validFrom:target.knownAt,targetBinding:{contract:target.contract,...pin,knownAt:target.knownAt},availabilityAuthenticated:false});
}
export function readSeriesHistoryTargetInput({targetInput,decisionAt}={}){
 const{target:t,pin}=read(targetInput,'series_history_target_pin'),keys=['contract','seriesId','phase','transitionId','historyCutoffAt','validFrom','identityKnownAt','lastSeriesReceiptAt','identityRevision','team1Id','team2Id','players'];
 if(!obj(t)||t.contract!=='aegis.series-history-target.v1'||Object.keys(t).some(k=>!keys.includes(k))||typeof t.seriesId!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(t.seriesId)||!['SERIES_PRE','SERIES_BETWEEN'].includes(t.phase)||typeof t.transitionId!=='string'||!t.transitionId.length||t.transitionId.length>136||!id(t.team1Id)||!id(t.team2Id)||t.team1Id===t.team2Id||!Number.isSafeInteger(t.identityRevision)||t.identityRevision<0||!Array.isArray(t.players)||t.players.length>10)throw Error('series_history_target_contract');
 const historyMapCount=[0,1,2,3,4].find(n=>t.transitionId===t.seriesId+':after:'+n);
 if(historyMapCount===undefined||(t.phase==='SERIES_PRE')!==(historyMapCount===0))throw Error('series_history_transition_contract');
 const cutoff=instantNs(t.historyCutoffAt),valid=instantNs(t.validFrom),decision=instantNs(decisionAt),identityKnown=instantNs(t.identityKnownAt),lastSeriesReceipt=instantNs(t.lastSeriesReceiptAt);
 if(cutoff===null||valid===null||decision===null||identityKnown===null||lastSeriesReceipt===null||cutoff>valid||valid>decision||identityKnown>valid||cutoff>lastSeriesReceipt||lastSeriesReceipt>decision)throw Error('series_history_target_times');
 const players=t.players.map(p=>{
  if(!obj(p)||Object.keys(p).some(k=>!['team','accountId'].includes(k))||!['team1','team2'].includes(p.team)||p.accountId!==null&&!account(p.accountId))throw Error('series_history_player_or_current_hero_forbidden');
  return{accountId:p.accountId,teamId:p.team==='team1'?t.team1Id:t.team2Id,side:p.team==='team1'?'radiant':'dire',heroId:null};
 });
 if(new Set(players.filter(p=>p.accountId!==null).map(p=>p.accountId)).size!==players.filter(p=>p.accountId!==null).length||SIDE.some(s=>players.filter(p=>p.side===s).length>5))throw Error('series_history_roster_conflict');
 for(const side of SIDE)while(players.filter(p=>p.side===side).length<5)players.push({accountId:null,heroId:null,side,teamId:side==='radiant'?t.team1Id:t.team2Id});
 return freeze({target:t,players,historyCutoffAt:t.historyCutoffAt,validFrom:t.validFrom,historyMapCount,targetBinding:{contract:t.contract,...pin,knownAt:t.validFrom},availabilityAuthenticated:false});
}
