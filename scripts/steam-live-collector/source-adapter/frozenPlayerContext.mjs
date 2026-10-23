/** Pure, bounded historical reconstruction from caller-supplied pinned JSON bytes.
 * No database/filesystem/network/process/clock access, fit or inference. */
import {createHash} from 'node:crypto';
import {instantNs} from './causalTime.mjs';
import {validateFrozenHistory} from './causalContext.mjs';
import {evidenceHash} from './playerHeroEconomyFeatures.mjs';

export const PRODUCER_CONTRACT='aegis.frozen-player-context-producer.v1';
export const FACTS_CONTRACT='aegis.prior-map-facts.v1';
export const NATIVE_CONTRACT='aegis.pinned-native-economy-observations.v1';
const DAY=86400n*1000000000n,MAX_BYTES=64*1024*1024,MAX_MAPS=100000,MAX_FRAMES=20000;
const PROFILE='steam.GetLiveLeagueGames.v1.scoreboard';
const METRICS={native_nw:'netWorth',native_gpm:'goldPerMinute',native_xpm:'experiencePerMinute'};
const SOURCE_FIELDS={native_nw:'net_worth',native_gpm:'gold_per_min',native_xpm:'xp_per_min'};
const UNITS={native_nw:'gold',native_gpm:'gold_per_minute',native_xpm:'experience_per_minute'};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const positiveId=x=>typeof x==='string'&&/^[1-9]\d{0,19}$/.test(x);
const account=x=>positiveId(x)&&BigInt(x)<4294967295n;
const hero=x=>(typeof x==='number'&&Number.isSafeInteger(x)||typeof x==='string'&&/^[1-9]\d*$/.test(x))&&Number(x)>=1&&Number(x)<=250;
const sha=b=>createHash('sha256').update(b).digest('hex');
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const proof=x=>typeof x==='string'&&x.length>0&&x.length<256;
const count=(audit,key)=>{audit[key]=(audit[key]??0)+1;};
const byId=(a,b)=>a.matchId.length-b.matchId.length||a.matchId.localeCompare(b.matchId,'en');
const identity=(p,q)=>p.accountId===q.accountId&&String(p.heroId)===String(q.heroId)&&p.side===q.side&&p.teamId===q.teamId;

function pinned(input,contract,limit){
 if(!object(input)||typeof input.utf8!=='string'||!object(input.pin))throw Error('pinned_utf8_required');
 const bytes=Buffer.byteLength(input.utf8),p=input.pin;
 if(bytes>MAX_BYTES||p.bytes!==bytes||!digest(p.sha256)||sha(Buffer.from(input.utf8))!==p.sha256||typeof p.path!=='string'||p.path.length<1||p.path.length>4096)throw Error('input_pin_or_bound');
 const data=JSON.parse(input.utf8);if(!object(data)||data.contract!==contract)throw Error('input_contract');
 const rows=contract===FACTS_CONTRACT?data.maps:data.observations;
 if(!Array.isArray(rows)||rows.length>limit)throw Error('input_rows_bound');
 return{data,rows,pin:{path:p.path,bytes,sha256:p.sha256},ref:`sha256:${p.sha256}`};
}
function blocked(reason,audit,bindings){return{contract:PRODUCER_CONTRACT,status:'blocked',reason,context:null,audit,bindings,APIcalls:0,nativeFits:0,publicPromotion:false};}
function normalizedPlayer(p){
 if(!object(p)||!account(p.accountId)||!hero(p.heroId)||!['radiant','dire'].includes(p.side)||(p.teamId!==null&&!positiveId(p.teamId)))return null;
 return{accountId:p.accountId,heroId:Number(p.heroId),side:p.side,teamId:p.teamId};
}
function mapRecord(x,known,currentMap,audit,index){
 if(!object(x)||!positiveId(x.matchId)){count(audit,'factsInvalidIdentity');return null;}
 if(x.matchId===currentMap){count(audit,'factsCurrentMapExcluded');return null;}
 const ended=instantNs(x.endedAt),available=instantNs(x.outcomeKnownAt);
 if(ended===null||available===null||ended>available){count(audit,'factsInvalidChronology');return null;}
 if(available>known){count(audit,'factsOutcomeNotYetKnown');return null;}
 if(typeof x.radiantWon!=='boolean'||!finite(x.durationSeconds)||x.durationSeconds<=0||x.durationSeconds>86400||!proof(x.evidenceRef)){count(audit,'factsInvalidOutcomeOrDuration');return null;}
 const teamOk=v=>v===null||positiveId(v);
 if(!teamOk(x.radiantTeamId)||!teamOk(x.direTeamId)||(x.radiantTeamId!==null&&x.radiantTeamId===x.direTeamId)){count(audit,'factsInvalidTeamIdentity');return null;}
 let players=[];const playersAt=instantNs(x.playersKnownAt);
 if(Array.isArray(x.players)&&x.players.length<=10&&playersAt!==null&&playersAt>=available&&playersAt<=known){
  const normalized=x.players.map(p=>normalizedPlayer({...p,teamId:p.side==='radiant'?x.radiantTeamId:p.side==='dire'?x.direTeamId:null}));
  const valid=normalized.filter(Boolean);
  if(new Set(valid.map(p=>p.accountId)).size!==valid.length||new Set(valid.map(p=>p.heroId)).size!==valid.length||['radiant','dire'].some(side=>valid.filter(p=>p.side===side).length>5))count(audit,'factsInvalidPlayerRoster');
  else {players=valid;if(valid.length!==x.players.length)count(audit,'factsUnknownPlayerIdentity');}
 }else if(x.players?.length)count(audit,playersAt!==null&&playersAt>known?'factsPlayersNotYetKnown':'factsPlayerAvailabilityUnproven');
 const kills={radiant:x.radiantKills,dire:x.direKills};for(const s of ['radiant','dire'])if(!Number.isSafeInteger(kills[s])||kills[s]<0)kills[s]=null;
 return{...x,players,ended,available,playersAt,index,kills};
}
function nativeFrame(x,map,known,audit){
 const cap=x?.source?.capture,at=instantNs(cap?.receivedAt),clock=x?.providerGameClockSeconds;
 if(!map){count(audit,'nativeNoAvailablePriorMap');return null;}
 if(!object(x)||x.contract!=='steam-live-scoreboard-candidate.v1'||x.dynamic?.sourceProfile!==PROFILE||cap?.endpoint!=='GetLiveLeagueGames/v1'||!digest(cap.rawSha256)||!digest(x.observationId)){count(audit,'nativeProfileUnproven');return null;}
 if(at===null||at>known){count(audit,'nativeNotYetKnown');return null;}
 const phase=x.dynamic.phase;if(phase?.missing!==false||phase.value!==5||phase.status==='invalid'||x.sourceQualityReasons?.includes('outcome_marker_present')){count(audit,'nativeInProgressPhaseUnproven');return null;}
 if(clock?.missing!==false||!finite(clock.value)||clock.value<0||clock.value>map.durationSeconds){count(audit,'nativeClockInvalid');return null;}
 const minute=Math.ceil(clock.value/60);if(minute>180||minute*60-clock.value>30){count(audit,'nativeOutsidePrecedingMinuteWindow');return null;}
 const players=[];for(const side of ['radiant','dire']){
  const raw=x.sides?.[side]?.players;if(!Array.isArray(raw)||raw.length!==5){count(audit,'nativeIncompleteRoster');return null;}
  for(const p of raw){const id=normalizedPlayer(p.identity);if(!id||id.side!==side){count(audit,'nativeIncompleteRoster');return null;}
   const expectedTeam=side==='radiant'?map.radiantTeamId:map.direTeamId,historyPlayer=map.players.find(q=>q.accountId===id.accountId),historyHero=map.players.find(q=>q.heroId===id.heroId);
   const completeKnownRoster=map.players.length===10;
   if(expectedTeam!==null&&id.teamId!==null&&id.teamId!==expectedTeam||completeKnownRoster&&!historyPlayer||historyPlayer&&(historyPlayer.side!==id.side||historyPlayer.heroId!==id.heroId)||historyHero&&(historyHero.accountId!==id.accountId||historyHero.side!==id.side)){count(audit,'nativePriorMapIdentityConflict');return null;}
   players.push({...p,identity:id});}
 }
 if(new Set(players.map(p=>p.identity.accountId)).size!==10||new Set(players.map(p=>p.identity.heroId)).size!==10){count(audit,'nativeDuplicateIdentity');return null;}
 // Native values alone may be old, but admission also consumes final duration/outcome and
 // any known roster. Preserve the latest availability of all these actual dependencies.
 const dependencies=[{at,iso:cap.receivedAt},{at:map.available,iso:map.outcomeKnownAt}];
 if(map.players.length)dependencies.push({at:map.playersAt,iso:map.playersKnownAt});
 return{x,map,at,clock:clock.value,minute,players,dependencies};
}
function statistics(rows,{minimumSupport,definition,windowDays,units,value}){
 const sorted=[...rows].sort((a,b)=>byId(a.map,b.map));
 const result={definition,units,windowDays,minimumSupport,supportMaps:sorted.length,sourceMapIds:sorted.map(x=>x.map.matchId),value:null};
 if(sorted.length>=minimumSupport)result.value=value(sorted);
 return result;
}
function latestInstants(rows){let latest=null,text=null;for(const row of rows){if(latest===null||row.at>latest){latest=row.at;text=row.iso;}}return text;}

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
 const ids=new Set();for(const x of facts.rows){if(positiveId(x?.matchId)){if(ids.has(x.matchId))throw Error('duplicate_map_fact');ids.add(x.matchId);}}
 const all=facts.rows.map((x,i)=>mapRecord(x,known,target.matchId,audit,i)).filter(Boolean);
 const maps=all.filter(x=>x.ended>=known-90n*DAY).sort(byId),byMap=new Map(maps.map(x=>[x.matchId,x]));audit.eligiblePriorMaps=maps.length;audit.factsOlderThan90Days=all.length-maps.length;
 if(!maps.length)return blocked('no_available_prior_maps',audit,bindings);
 const used=new Map(),use=map=>used.set(map.matchId,map),players=[];
 for(const p of roster){
  const playerRows=maps.filter(m=>m.players.some(x=>x.accountId===p.accountId)).map(map=>{const a=map.players.find(x=>x.accountId===p.accountId);return{map,at:map.playersAt,iso:map.playersKnownAt,won:map.radiantWon===(a.side==='radiant'),heroId:a.heroId};});
  const teamRows=p.teamId===null?[]:maps.filter(m=>m.radiantTeamId===p.teamId||m.direTeamId===p.teamId).map(map=>{const side=map.radiantTeamId===p.teamId?'radiant':'dire';return{map,at:map.available,iso:map.outcomeKnownAt,won:map.radiantWon===(side==='radiant'),kills:map.kills[side]};});
  const within=(rows,days)=>rows.filter(r=>r.map.ended>=known-BigInt(days)*DAY),win=rows=>rows.reduce((n,r)=>n+Number(r.won),0)/rows.length;
  const recent=within(playerRows,30),heroRows=within(playerRows,90).filter(r=>r.heroId===p.heroId),team=within(teamRows,30),pace=team.filter(r=>r.kills!==null),late=within(teamRows,90);
  const stat=(rows,definition,windowDays,units,value)=>statistics(rows,{minimumSupport,definition,windowDays,units,value});
  const stats={
   recentForm:stat(recent,'aegis.player_win_fraction_30d.v1',30,'fraction',win),
   heroForm:stat(heroRows,'aegis.player_hero_win_fraction_90d.v1',90,'fraction',win),
   teamForm:stat(team,'aegis.team_win_fraction_30d.v1',30,'fraction',win),
   aggression:stat(pace,'aegis.team_mean_kills_per_minute_30d.proxy.v1',30,'kills_per_played_minute',rows=>rows.reduce((n,r)=>n+r.kills/(r.map.durationSeconds/60),0)/rows.length),
   lateTendency:stat(late,'aegis.team_fraction_duration_at_least_40min_90d.v1',90,'fraction',rows=>rows.reduce((n,r)=>n+Number(r.map.durationSeconds>=2400),0)/rows.length)
  };
  const union=[...recent,...heroRows,...team,...pace,...late];union.forEach(r=>use(r.map));
  players.push({...p,supportMaps:new Set(union.map(r=>r.map.matchId)).size,latestHistoryAvailabilityAt:latestInstants(union),evidenceRef:`${facts.ref}#player/${p.accountId}/hero/${p.heroId}`,values:Object.fromEntries(Object.entries(stats).map(([k,v])=>[k,v.value])),definitions:Object.fromEntries(Object.entries(stats).map(([k,v])=>[k,v.definition])),statistics:stats});
 }
 const observedIds=new Map(),frames=[];
 for(const x of native.rows){if(digest(x?.observationId)){const h=evidenceHash(x),prior=observedIds.get(x.observationId);if(prior&&prior!==h)throw Error('conflicting_observation_identity');if(prior){count(audit,'nativeExactDuplicateFrames');continue;}observedIds.set(x.observationId,h);}const f=nativeFrame(x,byMap.get(x?.matchId),known,audit);if(f)frames.push(f);}
 const targetHeroes=new Set(roster.map(p=>p.heroId)),selected=new Map();
 for(const f of frames)for(const p of f.players){if(!targetHeroes.has(p.identity.heroId))continue;const k=f.map.matchId+'|'+p.identity.heroId+'|'+f.minute,old=selected.get(k);if(!old||f.clock>old.f.clock||f.clock===old.f.clock&&(f.at>old.f.at||f.at===old.f.at&&f.x.observationId<old.f.x.observationId))selected.set(k,{f,p});}
 const groups=new Map();for(const{f,p}of selected.values())for(const[metric,field]of Object.entries(METRICS)){const m=p[field];if(m?.missing!==false||!finite(m.value)||m.value<0||m.sourceField!==SOURCE_FIELDS[metric]){count(audit,'nativeMissingOrNonNativeMetric');continue;}const k=p.identity.heroId+'|'+f.minute+'|'+metric;if(!groups.has(k))groups.set(k,[]);groups.get(k).push({f,p,metric,value:m.value});}
 const references=[];
 for(const rows of groups.values()){
  rows.sort((a,b)=>byId(a.f.map,b.f.map));const n=rows.length;if(n<minimumSupport){count(audit,'referenceGroupsBelowSupport');continue;}
  const mean=rows.reduce((s,r)=>s+r.value,0)/n,scale=Math.sqrt(rows.reduce((s,r)=>s+(r.value-mean)**2,0)/(n-1));
  if(!finite(scale)||scale<=0){count(audit,'referenceGroupsZeroVariance');continue;}
  const first=rows[0],latestNative=latestInstants(rows.map(r=>({at:r.f.at,iso:r.f.x.source.capture.receivedAt}))),latest=latestInstants(rows.flatMap(r=>r.f.dependencies));rows.forEach(r=>use(r.f.map));
  references.push({heroId:first.p.identity.heroId,metric:first.metric,minute:first.f.minute,mean,scale,supportMaps:n,minimumSupport,windowDays:90,units:UNITS[first.metric],sourceProfile:PROFILE,metricSourceField:SOURCE_FIELDS[first.metric],definition:'aegis.native_steam_hero_preceding_minute_mean_sample_sd_90d.v1',latestNativeReceiptAt:latestNative,latestHistoryAvailabilityAt:latest,evidenceRef:`${native.ref}#hero/${first.p.identity.heroId}/minute/${first.f.minute}/${first.metric}`,sourceObservations:rows.map(r=>({matchId:r.f.map.matchId,observationId:r.f.x.observationId,rawSha256:r.f.x.source.capture.rawSha256,knownAt:r.f.x.source.capture.receivedAt,gameClockSeconds:r.f.clock,admissionOutcomeKnownAt:r.f.map.outcomeKnownAt,admissionRosterKnownAt:r.f.map.players.length?r.f.map.playersKnownAt:null}))});
 }
 references.sort((a,b)=>a.heroId-b.heroId||a.minute-b.minute||a.metric.localeCompare(b.metric,'en'));
 const acceptedRoles=[];for(const r of roleProofs){const at=instantNs(r?.knownAt);if(!object(r)||!roster.some(p=>identity(p,r))||!Number.isInteger(r.role)||r.role<1||r.role>5||r.confirmed!==true||!proof(r.evidenceRef)||at===null||at>known){count(audit,'roleProofRejected');continue;}acceptedRoles.push({...r,heroId:Number(r.heroId)});}
 const duplicateRoleKeys=new Set();for(const r of acceptedRoles)if(acceptedRoles.filter(x=>x.side===r.side&&x.role===r.role||x.accountId===r.accountId).length>1)duplicateRoleKeys.add(r.accountId);
 const roles=acceptedRoles.filter(r=>!duplicateRoleKeys.has(r.accountId));audit.rolesRejectedAmbiguous=acceptedRoles.length-roles.length;
 if(!used.size)return blocked('no_history_for_target_roster_or_heroes',audit,bindings);
 const sourceMatches=[...used.values()].sort(byId).map(m=>({matchId:m.matchId,endedAt:m.endedAt,outcomeKnownAt:m.outcomeKnownAt,evidenceRef:m.evidenceRef,sourceFactsSha256:facts.pin.sha256,sourceRowIndex:m.index}));
 const context={contract:'aegis.frozen-team-style-context.v2',mode:'prematch_frozen',matchId:target.matchId,knownAt:target.knownAt,frozenBeforeMapAt:target.frozenBeforeMapAt,mapStartEvidence:{...start},sourceMatches,availabilityBasis:'historical_reconstruction',evidenceRef:`${PRODUCER_CONTRACT}:${facts.pin.sha256.slice(0,32)}:${native.pin.sha256.slice(0,32)}`,featurePayload:{players,roles,heroMinuteReferences:references},producer:{contract:PRODUCER_CONTRACT,minimumSupport,bindings,aggressionIsKillPaceProxy:true,lateThresholdMinutes:40,nativeMinuteSelection:'last_clock_at_or_before_minute_within_30_seconds',recordsPerMapHeroMinuteMaximum:1,noNetWorthToGpmSubstitution:true,asOfReconstructionIsNotOriginalRecordedPrediction:true}};
 context.contentHash=evidenceHash(context);const accepted=validateFrozenHistory(context,{matchId:target.matchId,receivedAt:target.receivedAt});if(!accepted.accepted)throw Error('generated_context_failed_shared_validator:'+accepted.reason);
 audit.sourceMatches=sourceMatches.length;audit.nativeFramesAdmitted=frames.length;audit.nativeMapHeroMinuteSelected=selected.size;audit.heroMinuteReferenceGroups=references.length;audit.profileValuesPresent=players.reduce((n,p)=>n+Object.values(p.values).filter(finite).length,0);audit.profiles=players.length;
 return{contract:PRODUCER_CONTRACT,status:'produced_reconstruction',context,audit,bindings,APIcalls:0,nativeFits:0,publicPromotion:false};
}
