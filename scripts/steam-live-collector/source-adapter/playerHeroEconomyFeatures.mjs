/** Pure shared offline/online algebra. No IO, provider, model, role inference or fit. */
import {instantNs} from './causalTime.mjs';
import {validateFrozenHistory} from './causalContext.mjs';
import {steamObservationIdentity} from './steamObservationIdentity.mjs';
import {readSteamProgressionProof} from './steamProgressionAdmission.mjs';
import {steamPlayerInputBinding} from '../../feature-registry/feature-semantic-template.mjs';
import {hashCanonicalEvidence} from './canonicalEvidenceHash.mjs';
export const CONTRACT='aegis.player-hero-native-economy-features.v3';
export const PROGRESSING_ECONOMY_CONTRACT='aegis.player-hero-native-economy-features.v4';
export const HERO_IDS=Object.freeze(Array.from({length:250},(_,i)=>i+1));
const METRICS={native_nw:'netWorth',native_gpm:'goldPerMinute',native_xpm:'experiencePerMinute'};
/** Exact literal operands shared by this algebra and the actual rich emitter.
 * Raw gold/net_gold remain opaque; neither is renamed native NW/GPM. */
export function describeNativeEconomyOperand(path){
 const field=path.split('.').at(-1),known=['netWorth','goldPerMinute','experiencePerMinute','level','heroId','accountId','teamId'];
 if(known.includes(field))return{inputBinding:steamPlayerInputBinding(path,field),semanticVerification:'authoritative_template'};
 if(['gold','netGoldRaw'].includes(field))return{inputBinding:{normalizedField:path,rawField:'result.games[*].scoreboard.{radiant,dire}.players[*].'+(field==='gold'?'gold':'net_gold'),sourceProfile:'steam.GetLiveLeagueGames.v1.scoreboard',sourceKind:'literal_unqualified_native_provider_field',units:field==='gold'?'provider_gold_raw':'provider_net_gold_raw',availabilityPolicy:'same coherent capture receipt <= decision; field mechanical meaning not inferred'},semanticVerification:'unverified_native_semantics'};
 return null;
}
const CONTEXTS=['recentForm','heroForm','teamForm','aggression','lateTendency','playerLateTendency','heroLateTendency','playerHeroLateTendency'];
const LATE_DEFINITIONS={playerLateTendency:'aegis.player_fraction_duration_at_least_40min_90d.v1',heroLateTendency:'aegis.hero_fraction_duration_at_least_40min_90d.v1',playerHeroLateTendency:'aegis.player_hero_fraction_duration_at_least_40min_90d.v1'};
const TERMS=['value','log1p','team_share','team_centered','minute_product','log_minute_product','late_phase_product',...CONTEXTS.map(x=>'context_'+x),'hero_minute_residual','hero_minute_standardized'];
const WINDOWS=[60,180,300,600],SIDES=['radiant','dire'];
const finite=x=>typeof x==='number'&&Number.isFinite(x),value=x=>x?.missing===false&&finite(x.value)&&x.value>=0?x.value:null;
export const evidenceHash=hashCanonicalEvidence;
const proof=x=>typeof x==='string'&&x.length>0&&x.length<=512;
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const key=p=>p.identity.side+'|'+String(p.identity.teamId)+'|'+String(p.identity.accountId)+'|'+String(p.identity.heroId);
function at(s){try{return instantNs(s);}catch{return null;}}
function snapshot(o,{allowAnonymous=false}={}){
 const time=at(o?.source?.capture?.receivedAt),clock=value(o?.providerGameClockSeconds),profile=o?.dynamic?.sourceProfile;
 if(typeof o?.matchId!=='string'||!/^[1-9]\d{0,19}$/.test(o.matchId)||profile!=='steam.GetLiveLeagueGames.v1.scoreboard'||o?.source?.capture?.endpoint!=='GetLiveLeagueGames/v1'||time===null||clock===null||clock<0||!digest(o?.source?.capture?.rawSha256)||!digest(o?.observationId))return null;
 if(o.sourceQualityReasons?.includes('outcome_marker_present'))return null;
 const phase=o.dynamic.phase;
 const absentPhase=phase?.missing===true&&phase.status==='absent'&&phase.value===null&&(phase.rawValue===null||phase.rawValue===undefined);
 if(!absentPhase&&(phase?.missing!==false||phase.status==='invalid'||phase.value!==5))return null;
 if(SIDES.some(side=>!Array.isArray(o.sides?.[side]?.players)||o.sides[side].players.some(p=>p?.identity?.side!==side)))return null;
 const players=SIDES.flatMap(side=>o.sides[side].players);
 const known=players.filter(p=>p.identity.accountId!==null);
 if(players.length!==10||SIDES.some(s=>players.filter(p=>p.identity.side===s).length!==5)||players.some(p=>!(allowAnonymous&&p.identity.accountId===null)&&!(typeof p.identity.accountId==='string'&&/^[1-9]\d{0,9}$/.test(p.identity.accountId)&&BigInt(p.identity.accountId)<4294967295n)||!Number.isSafeInteger(Number(p.identity.heroId))||Number(p.identity.heroId)<1)||new Set(known.map(p=>String(p.identity.accountId))).size!==known.length||new Set(players.map(p=>Number(p.identity.heroId))).size!==10)return null;
 const identity=steamObservationIdentity(o);if(identity.key===null)return null;
 return{o,time,clock,profile,players,allowAnonymous,identityKey:identity.key,byKey:new Map(players.map(p=>[key(p),p]))};
}
function contextFor(c,s){
 if(!c)return{valid:false,reason:'static_context_missing'};
 const body={...c};delete body.contentHash;
 if(!digest(c.contentHash)||evidenceHash(body)!==c.contentHash||!['recorded','historical_reconstruction'].includes(c.availabilityBasis))return{valid:false,reason:'static_context_identity_or_proof'};
 const gate=validateFrozenHistory(c,{matchId:s.o.matchId,receivedAt:s.o.source.capture.receivedAt});if(!gate.accepted)return{valid:false,reason:'static_context_asof_unproven'};
 const payload=gate.featurePayload;if(!payload||!Array.isArray(payload.players)||payload.players.length>10||!Array.isArray(payload.roles)||payload.roles.length>10||!Array.isArray(payload.heroMinuteReferences)||payload.heroMinuteReferences.length>20000)return{valid:false,reason:'static_context_bounds'};
 return{valid:true,reason:null,data:payload,known:at(c.knownAt),start:at(c.mapStartEvidence.startedAt),cutoff:at(c.frozenBeforeMapAt),basis:c.availabilityBasis,sourceMapIds:new Set(c.sourceMatches.map(x=>x.matchId)),heroCohort:c.producer?.heroCohort};
}
function contextValue(c,prof,name){
 const v=prof?.values?.[name];if(!finite(v)||!proof(prof?.definitions?.[name]))return null;
 if(!Object.hasOwn(LATE_DEFINITIONS,name))return v;
 const s=prof.statistics?.[name];
 if(!s||s.value!==v||s.definition!==LATE_DEFINITIONS[name]||prof.definitions[name]!==s.definition||s.units!=='fraction'||s.windowDays!==90||s.cohortQualified!==true||v<0||v>1||!Number.isInteger(s.minimumSupport)||s.minimumSupport<5||!Number.isInteger(s.supportMaps)||s.supportMaps<s.minimumSupport||!Array.isArray(s.sourceMapIds)||new Set(s.sourceMapIds).size!==s.supportMaps||s.sourceMapIds.length!==s.supportMaps||s.sourceMapIds.some(id=>!c.sourceMapIds.has(id))||at(s.latestHistoryAvailabilityAt)===null||at(s.latestHistoryAvailabilityAt)>c.known)return null;
 if(name==='heroLateTendency'&&(s.population!=='local_available_parsed_pro_known_hero_maps_90d'||c.heroCohort?.verified!==true||!digest(c.heroCohort.scopeSha256)))return null;
 return v;
}
function profile(c,p){if(!c.valid)return null;const found=c.data.players.filter(x=>x.accountId===p.identity.accountId&&String(x.heroId)===String(p.identity.heroId)&&x.side===p.identity.side&&x.teamId===p.identity.teamId);if(found.length!==1)return null;const x=found[0];if(!Number.isSafeInteger(x.supportMaps)||x.supportMaps<1||!proof(x.evidenceRef)||at(x.latestHistoryAvailabilityAt)===null||at(x.latestHistoryAvailabilityAt)>c.known)return null;return x;}
function role(c,p){if(!c.valid)return null;const found=c.data.roles.filter(x=>x.accountId===p.identity.accountId&&String(x.heroId)===String(p.identity.heroId)&&x.side===p.identity.side&&x.teamId===p.identity.teamId);if(found.length!==1)return null;const r=found[0];if(!Number.isSafeInteger(r.role)||r.role<1||r.role>5||r.confirmed!==true||!proof(r.evidenceRef)||at(r.knownAt)===null||at(r.knownAt)>c.known)return null;return r.role;}
function reference(c,p,metric,minute){if(!c.valid)return null;const candidates=c.data.heroMinuteReferences.filter(x=>String(x.heroId)===String(p.identity.heroId)&&x.metric===metric&&Number.isSafeInteger(x.minute)&&x.minute>=0&&x.minute<=minute&&minute-x.minute<=5&&Number.isSafeInteger(x.supportMaps)&&x.supportMaps>=1&&finite(x.mean)&&x.mean>=0&&finite(x.scale)&&x.scale>0&&proof(x.evidenceRef)&&at(x.latestHistoryAvailabilityAt)!==null&&at(x.latestHistoryAvailabilityAt)<=c.known);if(!candidates.length)return null;candidates.sort((a,b)=>b.minute-a.minute);return candidates.filter(x=>x.minute===candidates[0].minute).length===1?candidates[0]:null;}
const median=a=>{const b=[...a].sort((x,y)=>x-y);return b[Math.floor(b.length/2)];};
function summaries(players,field){const a=players.map(p=>value(p[field])).sort((x,y)=>(x??-1)-(y??-1));if(a.some(x=>x===null))return null;const sum=a.reduce((x,y)=>x+y,0);return{sum,mean:sum/5,median:median(a),min:Math.min(...a),max:Math.max(...a),top_share:sum>0?Math.max(...a)/sum:null,hhi:sum>0?a.reduce((x,y)=>x+(y/sum)**2,0):null};}
function causalEconomyPrefix(history,s){
 const ordered=history.map(o=>({o,time:at(o?.source?.capture?.receivedAt)})).filter(x=>x.time!==null&&x.time<=s.time&&x.o.observationId!==s.o.observationId)
  .sort((a,b)=>a.time<b.time?-1:a.time>b.time?1:String(a.o.observationId).localeCompare(String(b.o.observationId)));
 let accepted=[],lastClock=null;
 for(const {o}of ordered){
  const x=snapshot(o,{allowAnonymous:s.allowAnonymous});
  // A changed/invalid intervening roster is a barrier, even if identity later
  // returns to an earlier value. Filtering out only the conflicting row leaks a
  // pre-reset trajectory into an offline vector that online replay has cleared.
  if(!x||x.o.matchId!==s.o.matchId||x.profile!==s.profile||x.identityKey!==s.identityKey){accepted=[];lastClock=null;continue;}
  if(lastClock!==null&&x.clock<lastClock)accepted=[];
  lastClock=x.clock;
  if(x.clock>s.clock){accepted=[];continue;}
  if(x.clock<s.clock)accepted.push(x);
 }
 return accepted.sort((a,b)=>b.clock-a.clock||(a.time>b.time?-1:a.time<b.time?1:0)||(a.o.observationId<b.o.observationId?-1:a.o.observationId>b.o.observationId?1:0));
}
export function featureNames(){
 const names=['native_economy.clock_seconds','native_economy.phase_explicit','native_economy.static_context_valid','native_economy.static_context_recorded','native_economy.roles_verified_count'];
 for(const metric of Object.keys(METRICS)){for(const side of SIDES)for(const stat of ['sum','mean','median','min','max','top_share','hhi'])names.push(`native_economy.team.${side}.${metric}.${stat}`);for(const stat of ['sum','mean','median','min','max','top_share','hhi'])names.push(`native_economy.team.diff.${metric}.${stat}`);}
 for(const hero of HERO_IDS){names.push(`native_economy.hero.${hero}.applicable`);for(const metric of Object.keys(METRICS)){for(const term of TERMS)names.push(`native_economy.hero.${hero}.${metric}.${term}`);for(const window of WINDOWS)names.push(`native_economy.hero.${hero}.${metric}.past_${window}s_change_per_minute`);}}
 for(let role=1;role<=5;role++)for(const metric of Object.keys(METRICS))for(const side of [...SIDES,'diff'])for(const term of TERMS)names.push(`native_economy.role.${role}.${side}.${metric}.${term}`);
 for(const basis of ['native_nw','native_gpm'])for(let rank=1;rank<=5;rank++)for(const metric of Object.keys(METRICS))for(const side of [...SIDES,'diff'])for(const term of TERMS)names.push(`native_economy.economic_rank.${basis}.${rank}.${side}.${metric}.${term}`);
 return names.flatMap(name=>[name,name+'__missing']);
}
/** history contains complete earlier observations from this exact endpoint profile.
 * Context scores are independent features, never hand-combined into a strength score.
 * Unknown roles remain unknown; sorted wealth slots are never interpreted as positions.
 */
export function projectPlayerHeroEconomy(observation,{staticContext=null,history=[],progressionProof=null,decisionAt=observation?.source?.capture?.receivedAt}={}){
 if(!Array.isArray(history)||history.length>2048)throw Error('bounded_history_required');
 let admission=null;
 if(progressionProof!==null){admission=readSteamProgressionProof(progressionProof,{matchId:observation?.matchId,observationId:observation?.observationId,rawSha256:observation?.source?.capture?.rawSha256,sourceProfile:observation?.dynamic?.sourceProfile,identityHash:steamObservationIdentity(observation).key,decisionAt,observation});if(!admission.accepted)throw Error(admission.reason);}
 const s=snapshot(observation,{allowAnonymous:admission?.accepted===true});if(!s)throw Error('complete_coherent_economy_snapshot_required');
 if(s.players.some(p=>!HERO_IDS.includes(Number(p.identity.heroId))))throw Error('hero_dictionary_revision_required');
 const c=contextFor(staticContext,s),minute=s.clock/60,out={},put=(name,v)=>{out[name]=finite(v)?v:null;out[name+'__missing']=finite(v)?0:1;},teams={},terms=new Map(),roles=new Map();
 const past=causalEconomyPrefix(history,s);
 for(const side of SIDES)for(const[metric,field]of Object.entries(METRICS))teams[side+'|'+metric]=summaries(s.players.filter(p=>p.identity.side===side),field);
 put('native_economy.clock_seconds',s.clock);put('native_economy.phase_explicit',value(s.o.dynamic.phase));put('native_economy.static_context_valid',Number(c.valid));put('native_economy.static_context_recorded',c.valid?Number(c.basis==='recorded'):null);
 for(const p of s.players){const r=role(c,p);if(r!==null){const k=p.identity.side+'|'+r;roles.set(k,roles.has(k)?null:p);}const prof=profile(c,p),perMetric={};
  for(const[metric,field]of Object.entries(METRICS)){const v=value(p[field]),side=p.identity.side,summary=teams[side+'|'+metric],sign=side==='radiant'?1:-1,ref=reference(c,p,metric,minute),t={};
   Object.assign(t,{value:v,log1p:v===null?null:Math.log1p(v),team_share:v!==null&&summary?.sum>0?v/summary.sum:null,team_centered:v!==null&&summary?v-summary.median:null,minute_product:v===null?null:v*minute,log_minute_product:v===null?null:v*Math.log1p(minute),late_phase_product:v===null?null:v*minute/(minute+20),hero_minute_residual:v!==null&&ref?v-ref.mean:null,hero_minute_standardized:v!==null&&ref?(v-ref.mean)/ref.scale:null});
   for(const x of CONTEXTS){const q=contextValue(c,prof,x);t['context_'+x]=v!==null&&q!==null?v*q:null;}
   perMetric[metric]=t;
   for(const term of TERMS)put(`native_economy.hero.${p.identity.heroId}.${metric}.${term}`,t[term]===null?null:sign*t[term]);
   for(const window of WINDOWS){const old=past.find(x=>x.clock<=s.clock-window&&s.clock-window-x.clock<=30&&x.byKey.has(key(p))),oldValue=old?value(old.byKey.get(key(p))[field]):null;put(`native_economy.hero.${p.identity.heroId}.${metric}.past_${window}s_change_per_minute`,v!==null&&oldValue!==null?sign*(v-oldValue)/((s.clock-old.clock)/60):null);}
  }terms.set(key(p),perMetric);
 }
 put('native_economy.roles_verified_count',[...roles.values()].filter(Boolean).length);
 for(const metric of Object.keys(METRICS))for(const stat of ['sum','mean','median','min','max','top_share','hhi']){for(const side of SIDES)put(`native_economy.team.${side}.${metric}.${stat}`,teams[side+'|'+metric]?.[stat]);const a=teams['radiant|'+metric]?.[stat],b=teams['dire|'+metric]?.[stat];put(`native_economy.team.diff.${metric}.${stat}`,finite(a)&&finite(b)?a-b:null);}
 for(const hero of HERO_IDS){const p=s.players.find(p=>Number(p.identity.heroId)===hero);put(`native_economy.hero.${hero}.applicable`,Number(Boolean(p)));if(!p)for(const metric of Object.keys(METRICS)){for(const term of TERMS)put(`native_economy.hero.${hero}.${metric}.${term}`,0);for(const window of WINDOWS)put(`native_economy.hero.${hero}.${metric}.past_${window}s_change_per_minute`,0);}}
 for(let r=1;r<=5;r++)for(const metric of Object.keys(METRICS))for(const term of TERMS){const values={};for(const side of SIDES){const p=roles.get(side+'|'+r),v=p?terms.get(key(p))[metric][term]:null;values[side]=v;put(`native_economy.role.${r}.${side}.${metric}.${term}`,v);}put(`native_economy.role.${r}.diff.${metric}.${term}`,finite(values.radiant)&&finite(values.dire)?values.radiant-values.dire:null);}
 const ranking={};for(const basis of ['native_nw','native_gpm'])for(const side of SIDES){const ps=s.players.filter(p=>p.identity.side===side),field=METRICS[basis];ranking[basis+'|'+side]=ps.every(p=>value(p[field])!==null)?ps.sort((a,b)=>value(b[field])-value(a[field])||String(a.identity.accountId).length-String(b.identity.accountId).length||(String(a.identity.accountId)<String(b.identity.accountId)?-1:String(a.identity.accountId)>String(b.identity.accountId)?1:a.identity.heroId-b.identity.heroId)):null;}
 for(const basis of ['native_nw','native_gpm'])for(let rank=1;rank<=5;rank++)for(const metric of Object.keys(METRICS))for(const term of TERMS){const values={};for(const side of SIDES){const p=ranking[basis+'|'+side]?.[rank-1],v=p?terms.get(key(p))[metric][term]:null;values[side]=v;put(`native_economy.economic_rank.${basis}.${rank}.${side}.${metric}.${term}`,v);}put(`native_economy.economic_rank.${basis}.${rank}.diff.${metric}.${term}`,finite(values.radiant)&&finite(values.dire)?values.radiant-values.dire:null);}
 const names=featureNames(),values=names.map(n=>out[n]);if(values.some(v=>v===undefined))throw Error('feature_schema_incomplete');
 const activeValueNames=names.filter(n=>!n.endsWith('__missing')&&!/\.hero\.(\d+)\./.test(n)||!n.endsWith('__missing')&&s.players.some(p=>n.startsWith('native_economy.hero.'+p.identity.heroId+'.')));
 return{contract:admission?PROGRESSING_ECONOMY_CONTRACT:CONTRACT,admissionProfile:admission?.admissionProfile??null,matchId:s.o.matchId,observationId:s.o.observationId,sourceProfile:s.profile,rawSha256:s.o.source.capture.rawSha256,knownAt:s.o.source.capture.receivedAt,eventClockSeconds:s.clock,featureNames:names,values,featureCount:names.length,staticContextStatus:c.reason??'validated_asof_metadata',staticContextBasis:c.valid?c.basis:null,staticContextHash:c.valid?staticContext.contentHash:null,verifiedRoleCount:out['native_economy.roles_verified_count'],validPastSnapshots:past.length,activeValueColumns:activeValueNames.length,knownActiveValueColumns:activeValueNames.filter(n=>out[n]!==null).length,heroStructuralZeroColumnsExcludedFromCoverage:true,networthDividedByMinuteIsNotGpm:true,sourceFieldSubstitution:false,jointTimelyCoverageProven:false,eligibleForServing:false,eligibleForTraining:false,publicPromotion:false};
}
