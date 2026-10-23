/** Causal, source-pinned previous-map context. No inference, IO or learned state.
 * Pins verify retained bytes, not provider authenticity; the collector owns receipts. */
import {createHash} from 'node:crypto';
import {instantNs} from './causalTime.mjs';
export const SERIES_CONTEXT_CONTRACT='aegis.series-map-context.v1';
const HASH=/^[a-f0-9]{64}$/;
const sha=x=>createHash('sha256').update(x).digest('hex');
const id=x=>typeof x==='string'&&/^[1-9]\d{0,19}$/.test(x);
const sid=x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(x);
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const fail=x=>{throw Error('series_context:'+x);};
function pin(input){
 if(typeof input?.utf8!=='string'||Buffer.byteLength(input.utf8)>2*1024*1024||input.pin?.bytes!==Buffer.byteLength(input.utf8)||!HASH.test(input.pin?.sha256??'')||sha(input.utf8)!==input.pin.sha256||typeof input.pin.path!=='string'||!input.pin.path.length||input.pin.path.length>4096)fail('pin_or_bound');
 return JSON.parse(input.utf8);
}
function time(x,name){const t=instantNs(x);if(t===null)fail(name);return t;}
function heroes(x){
 if(x===null)return null;
 if(!Array.isArray(x)||x.length!==5||x.some(h=>!Number.isSafeInteger(h)||h<1||h>250)||new Set(x).size!==5)fail('hero_roster');
 return [...x].sort((a,b)=>a-b);
}
function frozen(x){if(x&&typeof x==='object'){Object.values(x).forEach(frozen);Object.freeze(x);}return x;}
export function produceSeriesContext({seriesInput,decisionAt,currentMapId=null,currentMapNumber=null,currentDraft=null}={}){
 const data=pin(seriesInput),decision=time(decisionAt,'decision_time');
 if(data?.contract!=='aegis.series-map-receipts.v1'||!sid(data.seriesId)||![1,3,5].includes(data.bestOf)||!id(data.team1Id)||!id(data.team2Id)||data.team1Id===data.team2Id||!Array.isArray(data.previousMaps)||data.previousMaps.length>data.bestOf)fail('identity_format');
 const known=time(data.availableAt,'series_availability');if(known>decision)fail('series_future');
 if(!Number.isSafeInteger(data.completeThroughMapNumber)||data.completeThroughMapNumber!==data.previousMaps.length)fail('incomplete_previous_map_prefix');
 if((currentMapId===null)!==(currentMapNumber===null)||currentMapId!==null&&!id(currentMapId)||currentMapNumber!==null&&(!Number.isSafeInteger(currentMapNumber)||currentMapNumber<1||currentMapNumber>data.bestOf))fail('current_map_identity');
 const needed=(data.bestOf+1)/2,seen=new Set(),scores=[0,0],maps=[];let priorEnd=null;
 for(const [i,m] of data.previousMaps.entries()){
  if(!id(m?.mapId)||seen.has(m.mapId)||m.mapId===currentMapId||m.mapNumber!==i+1||currentMapNumber!==null&&m.mapNumber>=currentMapNumber||scores.some(s=>s>=needed))fail('previous_map_identity_or_terminal');
  seen.add(m.mapId);
  const at=time(m.availableAt,'previous_map_availability'),ended=time(m.finishedAt,'previous_map_end');
  if(at>decision||ended>at||at>known)fail('previous_map_future');
  if(![data.team1Id,data.team2Id].includes(m.winnerTeamId))fail('previous_map_winner');
  if(m.durationSeconds!==null&&(!finite(m.durationSeconds)||m.durationSeconds<=0||m.durationSeconds>86400))fail('previous_map_duration');
  if(priorEnd!==null&&(ended<=priorEnd||m.durationSeconds!==null&&ended-BigInt(Math.ceil(m.durationSeconds*1e9))<priorEnd))fail('previous_map_temporal_overlap');
  priorEnd=ended;
  for(const k of ['team1Kills','team2Kills'])if(m[k]!==null&&(!Number.isSafeInteger(m[k])||m[k]<0||m[k]>10000))fail('previous_map_kills');
  const h1=heroes(m.team1Heroes),h2=heroes(m.team2Heroes);
  if(h1&&h2&&h1.some(h=>h2.includes(h)))fail('previous_map_hero_conflict');
  scores[m.winnerTeamId===data.team1Id?0:1]++;
  maps.push({...m,team1Heroes:h1,team2Heroes:h2});
 }
 const ended=scores.some(s=>s>=needed);
 if(!ended&&currentMapNumber!==null&&currentMapNumber!==maps.length+1)fail('current_map_number');
 if(ended&&(currentMapId!==null||currentDraft!==null))fail('current_map_after_series_end');
 let draft=null;
 if(currentDraft!==null){
  if(currentMapId===null||currentDraft.mapId!==currentMapId||currentDraft.seriesId!==data.seriesId||time(currentDraft.availableAt,'draft_time')>decision||priorEnd!==null&&time(currentDraft.availableAt,'draft_time')<priorEnd)fail('current_draft_identity_or_future');
  const h1=heroes(currentDraft.team1Heroes),h2=heroes(currentDraft.team2Heroes);
  if(!h1||!h2||h1.some(h=>h2.includes(h)))fail('current_draft_heroes');
  draft={...currentDraft,team1Heroes:h1,team2Heroes:h2};
 }
 const values={},definitions=[];
 const add=(name,value,familyId,formula,units='count',draftDependent=false)=>{
  if(value!==null&&!finite(value))fail('nonfinite_feature');
  const full='series_context.'+name;values[full]=value;
  definitions.push({name:full,familyId,formula,formulaVersion:'series-causal.v1',units,inputScopes:[...(maps.length?['previous_series_maps']:['series_context']),...(draftDependent?['current_draft']:[])],knownAt:draftDependent?(draft?.availableAt??null):data.availableAt});
 };
 add('best_of',data.bestOf,'Q01','declared series format');
 add('wins_needed',needed,'Q01','(bestOf+1)/2');
 add('maps_played',maps.length,'Q01','count available completed prior maps');
 add('maps_remaining_max',ended?0:data.bestOf-maps.length,'Q01','bestOf - completed maps; zero after terminal score');
 for(const i of [0,1]){
  add('team'+(i+1)+'_wins',scores[i],'Q01','count known prior-map wins for oriented team');
  add('team'+(i+1)+'_wins_needed',Math.max(0,needed-scores[i]),'Q01','max(0,winsNeeded-score)');
  add('team'+(i+1)+'_match_point',!ended&&scores[i]===needed-1?1:0,'Q01','team is one win from series victory','flag');
 }
 add('score_difference',scores[0]-scores[1],'Q01','team1 wins - team2 wins');
 const avg=(xs)=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
 const last=maps.at(-1);
 add('previous_duration_support',maps.filter(m=>m.durationSeconds!==null).length,'Q02','distinct prior maps with available duration');
 add('previous_kills_support',maps.filter(m=>m.team1Kills!==null&&m.team2Kills!==null).length,'Q02','distinct prior maps with both kill totals');
 add('previous_kill_rate_support',maps.filter(m=>m.durationSeconds!==null&&m.team1Kills!==null&&m.team2Kills!==null).length,'Q02','distinct prior maps with complete kills and duration');
 add('previous_duration_mean',avg(maps.map(m=>m.durationSeconds).filter(x=>x!==null)),'Q02','mean available completed-map duration','seconds');
 add('previous_kills_mean',avg(maps.filter(m=>m.team1Kills!==null&&m.team2Kills!==null).map(m=>m.team1Kills+m.team2Kills)),'Q02','mean available completed-map total kills','kills');
 add('previous_kill_margin_mean',avg(maps.filter(m=>m.team1Kills!==null&&m.team2Kills!==null).map(m=>m.team1Kills-m.team2Kills)),'Q02','mean team1-team2 kills','kills');
 add('previous_kills_per_minute',avg(maps.filter(m=>m.durationSeconds!==null&&m.team1Kills!==null&&m.team2Kills!==null).map(m=>(m.team1Kills+m.team2Kills)/(m.durationSeconds/60))),'Q02','mean total kills / completed duration minutes','kills_per_minute');
 add('last_map_team1_win',last?Number(last.winnerTeamId===data.team1Id):null,'Q02','last available map winner orientation','flag');
 add('last_map_duration',last?.durationSeconds??null,'Q02','last available map duration','seconds');
 add('last_map_kill_margin',last&&last.team1Kills!==null&&last.team2Kills!==null?last.team1Kills-last.team2Kills:null,'Q02','last map team1-team2 kills','kills');
 let winnerChanges=0,recoveries=[0,0];
 for(let i=1;i<maps.length;i++)if(maps[i].winnerTeamId!==maps[i-1].winnerTeamId){winnerChanges++;recoveries[maps[i].winnerTeamId===data.team1Id?0:1]++;}
 add('winner_changes',maps.length>1?winnerChanges:null,'Q03','count consecutive-map winner changes; not historical recovery skill');
 for(const i of [0,1])add('team'+(i+1)+'_within_series_recoveries',maps.length>1?recoveries[i]:null,'Q03','count current-series wins immediately after losing a map');
 const shape=maps.map(m=>m.winnerTeamId===data.team1Id?1:0);
 // One universal five-slot schema for BO1/BO3/BO5. Unplayed/out-of-format slots
 // stay missing; format is an explicit feature, not a data-dependent schema width.
 for(let i=0;i<5;i++){
  add('previous_map_'+(i+1)+'_team1_win',shape[i]??null,'Q02','oriented actual previous map '+(i+1)+' result','flag');
  add('previous_map_'+(i+1)+'_duration',maps[i]?.durationSeconds??null,'Q02','actual previous map '+(i+1)+' duration','seconds');
 }
 for(const team of ['team1','team2']){
  const knownHeroMaps=maps.filter(m=>m[team+'Heroes']!==null);
  const prior=new Set(knownHeroMaps.flatMap(m=>m[team+'Heroes']));
  add(team+'_prior_hero_variety',knownHeroMaps.length?prior.size:null,'Q04','number of distinct confirmed prior-map heroes');
  add(team+'_prior_draft_coverage',maps.length?knownHeroMaps.length/maps.length:null,'Q04','completed maps with observed five-hero draft / completed maps','fraction');
  add(team+'_current_hero_repeats',draft&&knownHeroMaps.length?draft[team+'Heroes'].filter(h=>prior.has(h)).length:null,'Q04','current heroes used by this team in an available earlier map','count',true);
  add(team+'_current_hero_novelty',draft&&knownHeroMaps.length?draft[team+'Heroes'].filter(h=>!prior.has(h)).length:null,'Q04','current heroes not in observed earlier drafts; partial draft history remains qualified','count',true);
 }
 const names=definitions.map(d=>d.name),vector={names,values:names.map(n=>values[n]),masks:names.map(n=>values[n]===null)};
 const availableAt=draft&&time(draft.availableAt,'draft_time')>known?draft.availableAt:data.availableAt;
 const out={contract:SERIES_CONTEXT_CONTRACT,seriesId:data.seriesId,currentMapId,currentMapNumber,bestOf:data.bestOf,team1Id:data.team1Id,team2Id:data.team2Id,score:{team1:scores[0],team2:scores[1]},terminal:ended,actualWinnerTeamId:ended?(scores[0]===needed?data.team1Id:data.team2Id):null,availableAt,sourcePin:structuredClone(seriesInput.pin),currentDraftBinding:draft?{sha256:sha(JSON.stringify(draft)),availableAt:draft.availableAt,sourceAuthenticityAttested:false}:null,sourceMapIds:maps.map(m=>m.mapId),definitions,vector,availabilityBasis:'retained_series_receipt',sourceAuthenticityAttested:false,eligibleForTraining:false,eligibleForServing:false,recordedPrediction:false};
 return frozen({...out,contentHash:sha(JSON.stringify(out))});
}
