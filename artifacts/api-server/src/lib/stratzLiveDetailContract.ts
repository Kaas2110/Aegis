/** Pure research input preparation. Not connected to a collector or active model. */
import {createHash} from 'node:crypto';
export const STRATZ_RICH_CONTRACT='stratz_rich_player_diagnostic_v1';
type Side='radiant'|'dire';
export type ExpectedStratzPlayer={accountId:number;heroId:number;side:Side};
export interface StratzDetailContext {requestedMatchId:number;receivedAt:string;expectedPlayers?:ExpectedStratzPlayer[]}
const scalarFields=['level','numKills','numDeaths','numAssists','numLastHits','numDenies','gold','goldSpent','networth','goldPerMinute','experiencePerMinute','heroDamage','towerDamage','respawnTimer'] as const;
function record(v:unknown):v is Record<string,unknown>{return !!v&&typeof v==='object'&&!Array.isArray(v);}
function integer(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER):number|null{return typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max?v:null;}
function expectedValid(players:ExpectedStratzPlayer[]|undefined):players is ExpectedStratzPlayer[]{
 return Array.isArray(players)&&players.length===10&&players.every(p=>integer(p.accountId,1)!==null&&integer(p.heroId,1)!==null&&(p.side==='radiant'||p.side==='dire'))
  &&new Set(players.map(p=>p.accountId)).size===10&&new Set(players.map(p=>p.heroId)).size===10&&players.filter(p=>p.side==='radiant').length===5;
}
export function normalizeStratzLiveDetail(rawMatch:unknown,context:StratzDetailContext){
 if(integer(context.requestedMatchId,1)===null||!Number.isFinite(Date.parse(context.receivedAt)))throw Error('invalid_stratz_detail_context');
 const reasons=new Set<string>();
 const rawSha256=createHash('sha256').update(JSON.stringify(rawMatch??null)).digest('hex');
 const common={contract:STRATZ_RICH_CONTRACT,requestedMatchId:context.requestedMatchId,receivedAt:context.receivedAt,rawSha256,
  providerObservedAt:null,modelEligible:false,verifiedTimely:false,prospectiveValidated:false};
 if(!record(rawMatch))return {...common,status:'unavailable' as const,data:null,reasons:['match_absent_or_invalid']};
 if(integer(rawMatch.matchId,1)!==context.requestedMatchId)return {...common,status:'unavailable' as const,data:null,reasons:['match_id_mismatch']};
 const rawPlayers=Array.isArray(rawMatch.players)?rawMatch.players:[];
 if(rawPlayers.length!==10)reasons.add('requires_10_players');
 const players=rawPlayers.slice(0,10).map((raw,index)=>{
  const p=record(raw)?raw:{};if(!record(raw))reasons.add('invalid_player');
  const accountId=integer(p.steamAccountId,1),heroId=integer(p.heroId,1);
  const side:Side|null=p.isRadiant===true?'radiant':p.isRadiant===false?'dire':null;
  if(accountId===null||heroId===null)reasons.add('missing_player_identity');
  if(side===null)reasons.add('unknown_player_side');
  // Preserve raw slot value, but do not infer side from unverified slot semantics.
  const playerSlot=integer(p.playerSlot,0,255);
  const stats=Object.fromEntries(scalarFields.map(k=>{
   const max=['level','numKills','numDeaths','numAssists'].includes(k)?255:['numLastHits','numDenies','goldPerMinute','experiencePerMinute'].includes(k)?65535:2147483647;
   const value=integer(p[k],0,max);if(p[k]!=null&&value===null)reasons.add(`invalid_${k}`);return[k,value];
  })) as Record<typeof scalarFields[number],number|null>;
  const itemSlots=Array.from({length:6},(_,slot)=>{
   const value=integer(p[`itemId${slot}`],0,32767);if(p[`itemId${slot}`]!=null&&value===null)reasons.add('invalid_item_slot');return value;
  });
  return {sourceIndex:index,accountId,heroId,side,playerSlot,stats,itemSlots};
 });
 const identityComplete=rawPlayers.length===10&&players.length===10&&players.every(p=>p.accountId!==null&&p.heroId!==null&&p.side!==null)
  &&new Set(players.map(p=>p.accountId)).size===10&&new Set(players.map(p=>p.heroId)).size===10&&players.filter(p=>p.side==='radiant').length===5;
 if(!identityComplete)reasons.add('incomplete_or_conflicting_roster');
 const knownSlots=players.map(p=>p.playerSlot).filter((x):x is number=>x!==null);
 if(new Set(knownSlots).size!==knownSlots.length)reasons.add('duplicate_player_slots');
 let rosterVerified=false;
 if(context.expectedPlayers===undefined)reasons.add('expected_roster_not_provided');
 else if(!expectedValid(context.expectedPlayers))reasons.add('invalid_expected_roster');
 else{
  const expected=new Map(context.expectedPlayers.map(p=>[p.accountId,p]));
  rosterVerified=identityComplete&&players.every(p=>{const e=expected.get(p.accountId!);return e?.heroId===p.heroId&&e?.side===p.side;});
  if(!rosterVerified)reasons.add('observed_roster_mismatch');
 }
 const coverage=Object.fromEntries(scalarFields.map(k=>[k,players.filter(p=>p.stats[k]!==null).length])) as Record<typeof scalarFields[number],number>;
 const all10ItemsKnown=identityComplete&&players.every(p=>p.itemSlots.every(v=>v!==null));
 const all10NetworthKnown=identityComplete&&rosterVerified&&coverage.networth===10&&!reasons.has('duplicate_player_slots');
 const networthAdvantage=all10NetworthKnown?players.reduce((s,p)=>s+(p.side==='radiant'?1:-1)*p.stats.networth!,0):null;
 const gameTimeSec=integer(rawMatch.gameTime,-3600),gameMinuteRaw=integer(rawMatch.gameMinute,-60);
 if(gameTimeSec===null)reasons.add('missing_game_clock');
 if(rawMatch.completed===true)reasons.add('provider_completed');
 if(rawMatch.isUpdating!==true)reasons.add('provider_updating_not_confirmed');
 // Preserve metadata raw; no unsupported Unix timestamp/delay unit conversion.
 const meta={gameTimeSec,gameMinuteRaw,completed:typeof rawMatch.completed==='boolean'?rawMatch.completed:null,
  isUpdating:typeof rawMatch.isUpdating==='boolean'?rawMatch.isUpdating:null,
  providerModifiedDateTimeRaw:integer(rawMatch.modifiedDateTime),providerDelayRaw:integer(rawMatch.delay),
  providerObservedAt:null};
 const richCoreComplete=identityComplete&&rosterVerified&&gameTimeSec!==null&&coverage.level===10&&coverage.goldPerMinute===10&&coverage.networth===10&&coverage.respawnTimer===10&&all10ItemsKnown;
 if(!richCoreComplete)reasons.add('rich_core_incomplete');
 return {...common,status:richCoreComplete&&reasons.size===0?'complete' as const:'partial' as const,
  data:{matchId:context.requestedMatchId,meta,players,coverage,identityComplete,rosterVerified,all10ItemsKnown,
   networthAdvantage,xpAdvantage:null,xpAdvantageReason:'not_measured; XPM times gameMinute is not substituted'},reasons:[...reasons].sort()};
}
