import type {MatchInput,AnalyticsResult} from './AnalyticsEngine';
import {sameTeamIdentity} from './BookmakerMatcher';
import {totalsLadder,totalsLine,type TotalsDistribution} from './TotalsDistribution';
import type {FeedSnapshot} from '../lib/backgroundFeed';
import type {UnifiedBookmakerEvent} from '../routes/bookmakers';

type Feed = FeedSnapshot<unknown[]>;
interface SeriesIdentity {seriesId:number;team1:string;team2:string;startsAt:string}
export interface LadderIdentity extends SeriesIdentity {input:MatchInput;mapNumber:number;candidateSeries:SeriesIdentity[]|null}
function fresh(feed:Feed|undefined,age:number,now:number){return !!feed&&!feed.error&&!!feed.receivedAt&&Number.isFinite(Date.parse(feed.receivedAt))&&Date.parse(feed.receivedAt)<=now+5000&&now-Date.parse(feed.receivedAt)<age;}
function positive(v:unknown):v is number{return typeof v==='number'&&Number.isSafeInteger(v)&&v>0;}
function names(m:any):[string,string]|null{const o=m.opponents;if(!Array.isArray(o)||o.length!==2)return null;const a=o[0]?.opponent?.name,b=o[1]?.opponent?.name;return typeof a==='string'&&typeof b==='string'&&a&&b&&!sameTeamIdentity(a,b)?[a,b]:null;}
function samePair(a:Pick<SeriesIdentity,'team1'|'team2'>,b:Pick<SeriesIdentity,'team1'|'team2'>){
  const direct=sameTeamIdentity(a.team1,b.team1)&&sameTeamIdentity(a.team2,b.team2);
  const reverse=sameTeamIdentity(a.team1,b.team2)&&sameTeamIdentity(a.team2,b.team1);
  return direct!==reverse;
}
/** Both PS lists must be current: another series can be upcoming while this one is live.
 * Deduplicate the same series crossing feeds, but reject contradictory identity observations. */
function seriesUniverse(feeds:{running?:Feed;upcoming?:Feed},now:number):SeriesIdentity[]|null{
  if(!fresh(feeds.running,180_000,now)||!fresh(feeds.upcoming,360_000,now))return null;
  const byId=new Map<number,SeriesIdentity>();
  for(const m of [...(feeds.running!.data??[]),...(feeds.upcoming!.data??[])] as any[]){
    const pair=names(m);
    if(!positive(m.id)||!pair||typeof m.begin_at!=='string'||!Number.isFinite(Date.parse(m.begin_at)))continue;
    const entry={seriesId:m.id,team1:pair[0],team2:pair[1],startsAt:m.begin_at};
    const previous=byId.get(m.id);
    if(previous&&(!samePair(previous,entry)||Date.parse(previous.startsAt)!==Date.parse(entry.startsAt)))return null;
    byId.set(m.id,entry);
  }
  return [...byId.values()];
}
/** Resolve event, actual map and series time from server observations, never client odds/labels/clock. */
export function resolveLadderIdentity(eventId:string, feeds:{od?:Feed;running?:Feed;upcoming?:Feed},now=Date.now()):LadderIdentity|null{
  const parsed=/^(od|up|pslive)_([1-9]\d*)$/.exec(eventId);if(!parsed)return null;
  const id=Number(parsed[2]);if(!positive(id))return null;
  const isUpcoming=parsed[1]==='up';
  const feed=isUpcoming?feeds.upcoming:feeds.running;
  if(!fresh(feed,isUpcoming?360_000:180_000,now))return null;
  let ps:any,od:any;
  if(parsed[1]==='od'){
    if(!fresh(feeds.od,180_000,now))return null;
    const candidates=(feeds.od!.data??[]).filter((m:any)=>Number(m?.match_id)===id);if(candidates.length!==1)return null;od=candidates[0];
    const matches=(feed!.data??[]).filter((m:any)=>{const n=names(m);return n&&((sameTeamIdentity(n[0],od.team_name_radiant??'')&&sameTeamIdentity(n[1],od.team_name_dire??''))||(sameTeamIdentity(n[1],od.team_name_radiant??'')&&sameTeamIdentity(n[0],od.team_name_dire??'')));});
    if(matches.length!==1)return null;ps=matches[0];
  }else{const matches=(feed!.data??[]).filter((m:any)=>Number(m?.id)===id);if(matches.length!==1)return null;ps=matches[0];}
  const pair=names(ps);if(!pair||typeof ps.begin_at!=='string'||!Number.isFinite(Date.parse(ps.begin_at)))return null;
  const running=(ps.games??[]).filter((g:any)=>g.status==='running');
  const mapNumber=isUpcoming?1:running.length===1&&positive(running[0].position)?running[0].position:null;
  if(!mapNumber)return null;
  if(od){
    // A still-listed previous OD map must not inherit the current PS map's markets.
    const mapStart=Date.parse(running[0]?.begin_at??''),activation=Number(od.activate_time)*1000;
    if(!Number.isFinite(mapStart)||!Number.isFinite(activation)||activation<=0||Math.abs(mapStart-activation)>10*60_000)return null;
  }
  const team1=od?.team_name_radiant??pair[0],team2=od?.team_name_dire??pair[1];
  const format=ps.number_of_games===1?'BO1':ps.number_of_games===3?'BO3':ps.number_of_games===5?'BO5':'unknown';
  const countWins=(name:string)=>{const opponent=ps.opponents.find((o:any)=>sameTeamIdentity(o.opponent?.name??'',name));const count=(ps.games??[]).filter((g:any)=>g.status==='finished'&&g.winner?.id===opponent?.opponent?.id).length;return count;};
  return {seriesId:Number(ps.id),candidateSeries:seriesUniverse(feeds,now),team1,team2,startsAt:ps.begin_at,mapNumber,input:{matchId:eventId,matchSource:od?'opendota':'pandascore',status:isUpcoming?'prematch':'live',format,
    team1:{name:team1,teamId:od?Number(od.team_id_radiant):undefined,provider:od?'opendota':'pandascore'},
    team2:{name:team2,teamId:od?Number(od.team_id_dire):undefined,provider:od?'opendota':'pandascore'},
    seriesContext:{seriesScore1:countWins(team1),seriesScore2:countWins(team2),currentMapNumber:mapNumber}}};
}
export function uniqueBookmakerEvent(identity:LadderIdentity,bookmakerId:string,events:UnifiedBookmakerEvent[]):UnifiedBookmakerEvent|null{
  const matches=events.filter(e=>e.source===bookmakerId&&e.scope==='series'&&e.startsAt&&Number.isFinite(Date.parse(e.startsAt))
    &&Math.abs(Date.parse(e.startsAt)-Date.parse(identity.startsAt))<=2*3600_000
    && ((sameTeamIdentity(e.team1,identity.team1)&&sameTeamIdentity(e.team2,identity.team2))||(sameTeamIdentity(e.team1,identity.team2)&&sameTeamIdentity(e.team2,identity.team1))));
  if(matches.length!==1||!identity.candidateSeries)return null;
  const event=matches[0]!;
  const reverseMatches=identity.candidateSeries.filter(series=>samePair(event,series)
    &&Math.abs(Date.parse(event.startsAt!)-Date.parse(series.startsAt))<=2*3600_000);
  return reverseMatches.length===1&&reverseMatches[0]!.seriesId===identity.seriesId?event:null;
}
/** Keep the bookmaker's exact lines/order, even when model probabilities are unavailable. */
export function bookmakerTotalsResponse(type:'kills'|'duration',identity:LadderIdentity,bookmakerId:string,event:UnifiedBookmakerEvent|null,result?:AnalyticsResult){
  const unit=type==='kills'?'kills':'minutes';
  const prediction=result?.predictions.find(p=>p.betType===(type==='kills'?'total_kills':'total_duration')&&!!p.expiresAt&&Date.parse(p.expiresAt)>Date.now());
  const d=prediction?.distribution;
  const base={type,displayUnit:unit,lineSource:'bookmaker',bookmakerId,targetScope:'map',mapNumber:identity.mapNumber,isLive:identity.input.status==='live',
    expectedValue:null,interval:null,projection:null,confidence:null,generatedAt:result?.generatedAt??new Date().toISOString(),modelVersion:prediction?.modelVersion??'unavailable'};
  if(event?.source!==bookmakerId)event=null;
  if(!event)return {...base,lines:[],unavailable:true,unavailableReason:'Нет актуальных данных выбранной БК для этой серии'};
  const raw=type==='kills'?event.markets.totalKills:event.markets.totalDuration;
  const rows=(raw??[]).filter(r=>r.scope==='map'&&r.map===identity.mapNumber&&r.unit===unit&&Number.isFinite(r.line)&&r.line>0);
  const counts=new Map<number,number>();for(const r of rows)counts.set(r.line,(counts.get(r.line)??0)+1);
  const price=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>1?v:null;
  const lines=rows.filter(r=>counts.get(r.line)===1).flatMap(r=>{
    const oddsOver=price(r.over),oddsUnder=price(r.under);if(oddsOver===null&&oddsUnder===null)return [];
    // Unknown settlement rules allow quote display, never manufactured comparable probabilities.
    const settlement=(r as typeof r & {settlement?:string}).settlement;
    const validDistribution=d?.unit===(type==='kills'?'kills':'seconds') ? d : null;
    const boundary=r.line*(type==='duration'?60:1);
    const nativeLine=Math.abs(boundary-Math.round(boundary))<1e-7?Math.round(boundary):boundary;
    const p=validDistribution&&settlement==='integer_push'?totalsLine(validDistribution,nativeLine):null;
    return [{line:r.line,oddsOver,oddsUnder,pOver:p?.pOver??null,pUnder:p?.pUnder??null,pPush:p?.pPush??null,settlement:settlement??'unknown',
      probabilityUnavailableReason:!prediction?'Нет проверенной модели':!p?'Правила расчёта рынка не подтверждены':null}];
  });
  const receipt=event.receivedAt??event.updatedAt;
  const maxAge=event.status==='upcoming'&&Date.parse(event.startsAt??'')>Date.now()?3600_000:195_000;
  const expiry=event.expiresAt ?? new Date(Math.min(Date.parse(receipt)+maxAge,maxAge===3600_000?Date.parse(event.startsAt!):Infinity)).toISOString();
  const summary=d?totalsLadder(d):null;
  return {...base,expectedValue:summary?.expectedValue??null,interval:summary?.interval??null,lines,unavailable:lines.length===0,
    unavailableReason:lines.length?'':`Выбранная БК не предоставляет этот тотал для карты ${identity.mapNumber}`,
    modelUnavailable:lines.some(l=>l.pOver===null),modelUnavailableReason:lines.some(l=>l.probabilityUnavailableReason==='Нет проверенной модели')?'Нет проверенной модели; показаны реальные линии и коэффициенты БК':'Вероятности доступны только при подтверждённых правилах расчёта',
    quoteReceivedAt:receipt,quoteExpiresAt:expiry,
    probabilityExpiresAt:prediction?.expiresAt,expiresAt:expiry,eventId:event.eventId};
}

export async function serveBookmakerTotals(options:{eventId:string;bookmakerId:string;type:'kills'|'duration'},dependencies:{
  readFeed:(name:'opendota_live'|'pandascore_running'|'pandascore_upcoming')=>Promise<Feed>;
  readEvents:(bookmakerId:string)=>Promise<UnifiedBookmakerEvent[]>;
  predict:(input:MatchInput)=>Promise<AnalyticsResult>;
}){
  const [od,running,upcoming]=await Promise.all(['opendota_live','pandascore_running','pandascore_upcoming'].map(n=>dependencies.readFeed(n as any)));
  const identity=resolveLadderIdentity(options.eventId,{od,running,upcoming});
  if(!identity)return {type:options.type,displayUnit:options.type==='kills'?'kills':'minutes',lineSource:'bookmaker',bookmakerId:options.bookmakerId,lines:[],unavailable:true,unavailableReason:'Серия и текущая карта не сопоставлены по серверным данным',expectedValue:null,interval:null,projection:null};
  const event=uniqueBookmakerEvent(identity,options.bookmakerId,await dependencies.readEvents(options.bookmakerId));
  if(!event)return bookmakerTotalsResponse(options.type,identity,options.bookmakerId,null);
  const result=await dependencies.predict(identity.input).catch(()=>undefined);
  return bookmakerTotalsResponse(options.type,identity,options.bookmakerId,event,result);
}
