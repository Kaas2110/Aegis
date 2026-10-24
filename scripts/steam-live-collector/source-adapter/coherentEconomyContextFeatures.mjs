/** Pure descriptive resource/draft/objective interactions. Not fighting strength,
 * farm role, feature selection, admission, or a fitted/weighted score. The outer
 * observed-draft producer owns actual-byte admission and private frozen context.
 * This module has no temporal state and reads one coherent native observation.
 */
import {instantNs} from './causalTime.mjs';
export const CONTRACT='aegis.coherent-economy-context-features.v1';
export const FORMULA_VERSION='aegis.coherent-economy-context-algebra.v1';
const SIDES=['radiant','dire'],HERO_IDS=Array.from({length:250},(_,i)=>i+1);
const METRICS={native_nw:['netWorth','gold_value'],native_gpm:['goldPerMinute','gold_per_minute'],native_xpm:['experiencePerMinute','xp_per_minute']};
const CONCENTRATION=['top1_share','top2_share','hhi','shannon_entropy','gini','range'];
const HERO_TERMS=['minus_opponent_mean','minus_opponent_max','ratio_opponent_mean','opponent_midrank','z_vs_opponent','own_share_minus_opponent_top1'];
const HISTORY_KEYS=['recentForm','heroForm','teamForm','heroLateTendency'];
const CLOSING={meanDurationSeconds90d:'seconds',winMeanDurationSeconds90d:'seconds',late40Fraction90d:'fraction',meanOwnKillsPerMinute90d:'kills_per_minute'};
const OBJECTIVES={roshan_elapsed_since_confirmed_death:'seconds',roshan_respawn_lower_seconds:'seconds',roshan_respawn_upper_seconds:'seconds',roshan_confirmed_countdown_seconds:'seconds',roshan_dead:'boolean',roshan_alive:'boolean',aegis_elapsed_since_confirmed_pickup:'seconds',aegis_lifetime_upper_seconds:'seconds',aegis_confirmed_steal:'boolean'};
// This helper's definitions have exactly one compiled formula version. No data,
// dates, identity values, history contents or objective values enter this pool.
let formulaSchema=null;
function freezeSchema(x){if(x&&typeof x==='object'&&!Object.isFrozen(x)){for(const v of Object.values(x))freezeSchema(v);Object.freeze(x);}return x;}
export function readCoherentEconomyDefinitionPoolStatus(){return{contract:CONTRACT,semanticsCount:formulaSchema?1:0,maximumSemantics:1,featureCount:formulaSchema?.length??0,formulaVersion:FORMULA_VERSION};}
const finite=x=>typeof x==='number'&&Number.isFinite(x),field=x=>x?.missing===false&&finite(x.value)&&x.value>=0?x.value:null;
const product=(...xs)=>xs.every(finite)&&finite(xs.reduce((a,b)=>a*b,1))?xs.reduce((a,b)=>a*b,1):null;
const difference=(a,b)=>finite(a)&&finite(b)?a-b:null;
const average=xs=>xs.length===5&&xs.every(finite)?xs.reduce((a,b)=>a+b,0)/5:null;
const statUnits=(stat,units)=>stat==='range'?units:stat==='shannon_entropy'?'nats':'fraction';
const termUnits=(term,units)=>term.startsWith('minus_')?units:'dimensionless';
function orderedRoster(o){
 const players=[];
 for(const side of SIDES){const s=o.sides?.[side];if(!Array.isArray(s?.players)||s.players.length!==5)return null;
  for(const p of s.players){const x=p?.identity;if(x?.side!==side||x.teamId!==s.teamId||x.accountId!==null&&!(typeof x.accountId==='string'&&/^[1-9]\d{0,9}$/.test(x.accountId)&&BigInt(x.accountId)<4294967295n)||!Number.isSafeInteger(Number(x.heroId))||!HERO_IDS.includes(Number(x.heroId)))return null;players.push(p);}}
 const accounts=players.map(p=>p.identity.accountId).filter(x=>x!==null);
 if(new Set(players.map(p=>String(p.identity.heroId))).size!==10||new Set(accounts).size!==accounts.length)return null;
 return players.sort((a,b)=>a.identity.side.localeCompare(b.identity.side)||Number(a.identity.heroId)-Number(b.identity.heroId));
}
/** Six exact statistics, preserving all-zero denominator ambiguity. */
export function coherentFivePlayerDistribution(values){
 if(!Array.isArray(values)||values.length!==5||!values.every(x=>finite(x)&&x>=0))return null;
 const xs=[...values].sort((a,b)=>a-b),sum=xs.reduce((a,b)=>a+b,0),mean=sum/5,variance=xs.reduce((a,b)=>a+(b-mean)**2,0)/5;
 if(![sum,mean,variance].every(finite))return null;
 const shares=sum>0?xs.map(x=>x/sum):null;
 const absoluteDifferences=xs.reduce((a,x)=>a+xs.reduce((b,y)=>b+Math.abs(x-y),0),0);
 return{values:xs,sum,mean,max:xs[4],scale:Math.sqrt(variance),top1_share:shares?shares[4]:null,top2_share:shares?shares[4]+shares[3]:null,hhi:shares?shares.reduce((a,b)=>a+b*b,0):null,shannon_entropy:shares?(-shares.reduce((a,b)=>a+(b===0?0:b*Math.log(b)),0)||0):null,gini:sum>0?absoluteDifferences/(10*sum):null,range:xs[4]-xs[0]};
}
function qualified(profile,key,cutoff){
 const v=profile?.values?.[key],s=profile?.statistics?.[key],latest=s?.latestHistoryAvailabilityAt;
 if(!finite(v)||s?.value!==v||typeof s.definition!=='string'||!s.definition.length||!Number.isSafeInteger(s.supportMaps)||!Number.isSafeInteger(s.minimumSupport)||s.minimumSupport<3||s.supportMaps<s.minimumSupport||s.cohortQualified===false)return null;
 if(latest!==undefined&&(instantNs(latest)===null||instantNs(latest)>cutoff))return null;
 return v;
}
function historyViews(context,relational,o,players,decisionAt){
 const receipt=instantNs(o.source?.capture?.receivedAt),decision=instantNs(decisionAt),cutoff=instantNs(context?.historyCutoffAt),valid=instantNs(context?.validFrom),computed=instantNs(context?.computedAt);
 const accepted=context?.contract==='aegis.frozen-team-style-context.v3'&&context.matchId===o.matchId&&[receipt,decision,cutoff,valid,computed].every(x=>x!==null)&&cutoff<=valid&&valid<=receipt&&computed<=decision&&receipt<=decision;
 const pByHero=new Map(),teams={},closing={};
 for(const p of players){const x=p.identity,hero=context?.featurePayload?.heroes?.find(q=>Number(q.heroId)===Number(x.heroId)&&q.side===x.side&&q.teamId===x.teamId),team=context?.featurePayload?.teams?.find(q=>q.side===x.side&&q.teamId===x.teamId),personal=x.accountId===null?null:context?.featurePayload?.players?.find(q=>q.accountId===x.accountId&&Number(q.heroId)===Number(x.heroId)&&q.side===x.side&&q.teamId===x.teamId);
  pByHero.set(Number(x.heroId),Object.fromEntries(HISTORY_KEYS.map(k=>[k,accepted?qualified(k==='heroLateTendency'?hero:k==='teamForm'?team:personal,k,cutoff):null])));}
 const relationalAccepted=accepted&&relational?.contract==='aegis.historical-relational-features.v1'&&relational.matchId===o.matchId&&relational.originalHistoryContentHash===context.contentHash&&instantNs(relational.historyCutoffAt)===cutoff&&instantNs(relational.decisionAt)!==null&&instantNs(relational.decisionAt)<=decision;
 for(const side of SIDES){const team=context?.featurePayload?.teams?.find(q=>q.side===side&&q.teamId===o.sides[side].teamId),rel=relational?.profiles?.teams?.find(q=>q.side===side&&q.teamId===o.sides[side].teamId);
  teams[side]=Object.fromEntries(['teamForm','aggression','lateTendency'].map(k=>[k,accepted?qualified(team,k,cutoff):null]));
  closing[side]=Object.fromEntries(Object.keys(CLOSING).map(k=>[k,relationalAccepted?qualified(rel,k,cutoff):null]));}
 return{accepted,relationalAccepted,pByHero,teams,closing};
}
/** Every native objective value must come from this exact admitted observation.
 * The producer has already qualified events/rules; raw timer is never an operand.
 * Objective products are descriptive per-side covariates, not holder attribution.
 */
export function produceCoherentEconomyContextFeatures({observation:o,historyContext=null,relationalContext=null,nativeBundle=null,decisionAt=o?.source?.capture?.receivedAt}={}){
 const players=orderedRoster(o??{}),features=[],compiled=formulaSchema;
 if(!players)return{contract:CONTRACT,status:'blocked',reason:'complete_coherent_ten_hero_roster_required',features,eligibleForServing:false,eligibleForTraining:false};
 const minute=field(o.providerGameClockSeconds)===null?null:field(o.providerGameClockSeconds)/60,h=historyViews(historyContext,relationalContext,o,players,decisionAt),distributions={},ranked={};
 const emit=(name,value,definitionFactory)=>{
  const fullName='draft_live.coherent_economy.'+name,index=features.length;
  let column=compiled?.[index];
  if(column){if(column.name!==fullName)throw Error('coherent_economy_schema_sequence');}
  else if(compiled)throw Error('coherent_economy_schema_overflow');
  else{const {familyId='L05',formula,units='dimensionless',inputScopes=['current_live','current_draft'],inputFields=[],historyDefinitions=[]}=typeof definitionFactory==='function'?definitionFactory():definitionFactory;column={name:fullName,definition:{familyId,formula,formulaVersion:FORMULA_VERSION,units,inputScopes,inputFields,historyDefinitions}};}
  features.push({name:column.name,value:finite(value)?value:null,definition:column.definition});
 };
 for(const[metric,[fieldName]]of Object.entries(METRICS))for(const side of SIDES){const ps=players.filter(p=>p.identity.side===side);distributions[side+'|'+metric]=coherentFivePlayerDistribution(ps.map(p=>field(p[fieldName])));ranked[side+'|'+metric]=distributions[side+'|'+metric]?[...ps].sort((a,b)=>field(b[fieldName])-field(a[fieldName])||Number(a.identity.heroId)-Number(b.identity.heroId)):null;}
 for(const[metric,[fieldName,units]]of Object.entries(METRICS))for(const stat of CONCENTRATION)for(const side of [...SIDES,'diff']){
  const baseUnits=statUnits(stat,units),sides=side==='diff'?SIDES:[side],calc=(s,variant)=>{const v=distributions[s+'|'+metric]?.[stat]??null;return variant==='base'?v:variant==='minute_product'?product(v,minute):product(v,h.teams[s][variant]);};
  for(const variant of ['base','minute_product','teamForm','aggression','lateTendency']){const v=side==='diff'?difference(calc('radiant',variant),calc('dire',variant)):calc(side,variant);emit(`team.${side}.${metric}.${stat}.${variant}`,v,()=>({formula:`${stat} over exactly five observed nonnegative same-frame ${fieldName} values; ${stat==='top1_share'?'max(x)/sum(x)':stat==='top2_share'?'(largest(x)+second_largest(x))/sum(x)':stat==='hhi'?'sum((x_i/sum(x))^2)':stat==='shannon_entropy'?'-sum(p_i*ln(p_i)); 0*ln(0)=0':stat==='gini'?'sum_i sum_j abs(x_i-x_j)/(2*5*sum(x))':'max(x)-min(x)'}; nonpositive share denominator missing; ${variant==='base'?'literal statistic':variant==='minute_product'?'statistic*(clock_seconds/60)':'statistic*qualified frozen '+variant}; ${side==='diff'?'difference of side products Radiant-Dire':'observed '+side+' roster'}; no farm-role inference`,units:baseUnits+(variant==='minute_product'?' * minute':variant==='aggression'?' * kills_per_minute':variant==='base'?'':' * fraction'),inputScopes:variant==='base'||variant==='minute_product'?['current_live','current_draft']:['current_live','current_draft','prior_maps'],inputFields:sides.map(s=>'sides.'+s+'.players.'+fieldName).concat(variant==='minute_product'?['providerGameClockSeconds']:[]),historyDefinitions:['base','minute_product'].includes(variant)?[]:['qualified_frozen_context.'+variant]}));}
 }
 // Economic ranks sort observed resources/rates; they never name positions 1-5.
 for(const[metric,[fieldName,units]]of Object.entries(METRICS))for(let rank=1;rank<=5;rank++)for(const side of [...SIDES,'diff'])for(const term of ['native_value','team_share','minus_opponent_same_rank','ratio_opponent_same_rank']){
  const at=(s,variant)=>{const p=ranked[s+'|'+metric]?.[rank-1],opp=s==='radiant'?'dire':'radiant',q=ranked[opp+'|'+metric]?.[rank-1],v=p?field(p[fieldName]):null,w=q?field(q[fieldName]):null,total=distributions[s+'|'+metric]?.sum;let x=term==='native_value'?v:term==='team_share'?finite(v)&&total>0?v/total:null:term==='minus_opponent_same_rank'?difference(v,w):finite(v)&&w>0?v/w:null;if(variant==='minute_product')x=product(x,minute);else if(variant!=='base')x=product(x,p?h.pByHero.get(Number(p.identity.heroId))[variant]:null);return x;};
  for(const variant of ['base','minute_product','recentForm','teamForm','heroLateTendency'])emit(`economic_rank.${metric}.${rank}.${side}.${term}.${variant}`,side==='diff'?difference(at('radiant',variant),at('dire',variant)):at(side,variant),()=>({familyId:'L05',formula:`${term} for descending observed ${fieldName} rank ${rank}, ties by hero ID; requires complete five-player basis; ${term==='native_value'?'x_rank':term==='team_share'?'x_rank/team_sum':term==='minus_opponent_same_rank'?'x_rank-opponent_x_rank':'x_rank/opponent_x_rank with positive denominator'}; ${variant==='base'?'literal comparison':variant==='minute_product'?'multiply by clock_seconds/60':'multiply by qualified frozen '+variant+' of this observed ranked hero'}; diff=Radiant-Dire; economic rank is not farm role`,units:(term==='native_value'||term==='minus_opponent_same_rank'?units:'dimensionless')+(variant==='minute_product'?' * minute':variant==='base'?'':' * fraction'),inputScopes:['base','minute_product'].includes(variant)?['current_live','current_draft']:['current_live','current_draft','prior_maps'],inputFields:['sides.players.'+fieldName,'sides.players.identity.heroId'],historyDefinitions:['base','minute_product'].includes(variant)?[]:['qualified_frozen_context.'+variant]}));
 }
 for(const hero of HERO_IDS){const p=players.find(p=>Number(p.identity.heroId)===hero),side=p?.identity.side,opposite=side==='radiant'?'dire':'radiant',sign=side==='radiant'?1:-1;
  for(const[metric,[fieldName,units]]of Object.entries(METRICS)){const own=p?distributions[side+'|'+metric]:null,opp=p?distributions[opposite+'|'+metric]:null,v=p?field(p[fieldName]):null,opponentHeroLateMean=p?average(players.filter(q=>q.identity.side===opposite).map(q=>h.pByHero.get(Number(q.identity.heroId)).heroLateTendency)):null;
   for(const term of HERO_TERMS){let base=null;
    if(p&&opp&&finite(v))base=term==='minus_opponent_mean'?v-opp.mean:term==='minus_opponent_max'?v-opp.max:term==='ratio_opponent_mean'?opp.mean>0?v/opp.mean:null:term==='opponent_midrank'?(opp.values.filter(x=>x<v).length+0.5*opp.values.filter(x=>x===v).length)/5:term==='z_vs_opponent'?opp.scale>0?(v-opp.mean)/opp.scale:null:own?.sum>0&&opp.top1_share!==null?v/own.sum-opp.top1_share:null;
    for(const variant of ['base','minute_product',...HISTORY_KEYS,'opponentHeroLateMean']){const factor=variant==='base'?1:variant==='minute_product'?minute:variant==='opponentHeroLateMean'?opponentHeroLateMean:p?h.pByHero.get(hero)[variant]:null;emit(`hero.${hero}.${metric}.${term}.${variant}`,p?product(sign,base,factor):0,()=>({familyId:variant==='base'?'L05':'L14',formula:`side_sign*${term} of current hero ${hero} ${fieldName} against exactly five observed opposing draft heroes (${term==='minus_opponent_mean'?'v-opponent_mean':term==='minus_opponent_max'?'v-opponent_max':term==='ratio_opponent_mean'?'v/opponent_mean, positive denominator':term==='opponent_midrank'?'(count(opponent<v)+0.5*count(opponent=v))/5':term==='z_vs_opponent'?'(v-opponent_mean)/opponent_population_sd, positive sd':'v/own_team_sum-opponent_top1_share'}); multiply by ${variant==='base'?'1':variant==='minute_product'?'clock_seconds/60':variant==='opponentHeroLateMean'?'mean of five qualified frozen opposing observed heroes heroLateTendency':'qualified frozen '+variant}; structurally absent hero=0; no fight-strength or role inference`,units:termUnits(term,units)+(variant==='minute_product'?' * minute':variant==='base'?'':' * fraction'),inputScopes:['base','minute_product'].includes(variant)?['current_live','current_draft']:['current_live','current_draft','prior_maps'],inputFields:['sides.players.'+fieldName,'sides.players.identity.heroId',...(variant==='minute_product'?['providerGameClockSeconds']:[])],historyDefinitions:['base','minute_product'].includes(variant)?[]:['qualified_frozen_context.'+variant]}));}
   }
  }
 }
 const sameNative=nativeBundle?.matchId===o.matchId&&nativeBundle?.observationId===o.observationId&&nativeBundle?.rawSha256===o.source?.capture?.rawSha256&&nativeBundle?.knownAt===o.source?.capture?.receivedAt&&nativeBundle?.sourceProfile===o.dynamic?.sourceProfile;
 const native=sameNative?new Map(nativeBundle.vector.names.map((n,i)=>[n,nativeBundle.vector.values[i]])):new Map();
 for(const[objective,objectiveUnits]of Object.entries(OBJECTIVES)){const objectiveValue=native.get('roshan.'+objective)??null;
  for(const side of SIDES)for(const[metric,[fieldName,units]]of Object.entries(METRICS))for(const stat of CONCENTRATION)for(const style of ['base',...Object.keys(CLOSING)])emit(`objective.${objective}.${side}.${metric}.${stat}.${style}`,product(objectiveValue,distributions[side+'|'+metric]?.[stat]??null,style==='base'?1:h.closing[side][style]),()=>({familyId:'R06',formula:`qualified existing native ${objective} * same-frame five-player ${stat}(${fieldName})${style==='base'?'':' * qualified frozen '+style}; exact observation/raw/profile/receipt binding required; no raw timer, holder-side attribution or new Roshan/Aegis interpretation`,units:objectiveUnits+' * '+statUnits(stat,units)+(style==='base'?'':' * '+CLOSING[style]),inputScopes:style==='base'?['current_live','current_draft']:['current_live','current_draft','prior_maps'],inputFields:['native.roshan.'+objective,'sides.'+side+'.players.'+fieldName],historyDefinitions:style==='base'?[]:['qualified_relational_context.'+style]}));
  for(const hero of HERO_IDS){const p=players.find(p=>Number(p.identity.heroId)===hero),sign=p?.identity.side==='radiant'?1:-1;for(const style of ['base','winMeanDurationSeconds90d'])emit(`objective.${objective}.hero.${hero}.current_native_nw.${style}`,p?product(sign,objectiveValue,field(p.netWorth),style==='base'?1:h.closing[p.identity.side][style]):0,()=>({familyId:'R06',formula:`side_sign * qualified native ${objective} * literal current netWorth of observed hero ${hero}${style==='base'?'':' * qualified frozen same-side winMeanDurationSeconds90d'}; structurally absent hero=0; descriptive resource operand, not hero fighting strength; no current-holder attribution`,units:objectiveUnits+' * gold_value'+(style==='base'?'':' * seconds'),inputScopes:style==='base'?['current_live','current_draft']:['current_live','current_draft','prior_maps'],inputFields:['native.roshan.'+objective,'players.netWorth','players.identity.heroId'],historyDefinitions:style==='base'?[]:['qualified_relational_context.'+style]}));}
 }
 if(compiled&&features.length!==compiled.length)throw Error('coherent_economy_schema_underflow');
 if(!compiled)formulaSchema=freezeSchema(features.map(({name,definition})=>({name,definition})));
 return{contract:CONTRACT,status:'diagnostic_produced',formulaVersion:FORMULA_VERSION,features,audit:{featureCount:features.length,activeObservedHeroes:10,structuralAbsentHeroPolicy:'zero_is_not_missing_operand',historyContextAccepted:h.accepted,relationalContextAccepted:h.relationalAccepted,objectiveObservationBindingAccepted:sameNative,temporalStateRows:0,sourceFieldSubstitution:false,roleInference:false,weightedStrengthScore:false},eligibleForServing:false,eligibleForTraining:false};
}
