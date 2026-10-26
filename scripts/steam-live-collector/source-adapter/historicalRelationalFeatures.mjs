/** Deterministic relational prior-map features. No I/O, fitted state or current-map labels.
 * Identity slots are sorted observed heroes, never farm roles or strength rankings.
 * The caller proves receipt authenticity upstream; a content hash is not authorization.
 */
import {createHash} from 'node:crypto';
import {instantNs} from './causalTime.mjs';
import {pinned, FACTS_CONTRACT,NATIVE_CLOSING_REFERENCE_DEFINITION} from './historyCalculationCore.mjs';
import {defineFeatureSemanticTemplate,bindFeatureSemanticTemplate} from '../../feature-registry/feature-semantic-template.mjs';
import {validateObservedDraftHistory} from './observedDraftHistory.mjs';
import {PERFORMANCE_CONTRACT,PERFORMANCE_FIELDS} from './historicalPerformanceFields.mjs';
import {readRetainedReferenceHistoryMapView,iterateRetainedReferenceHistoryMapView,readRetainedReferenceStaticMapView,iterateRetainedReferenceStaticMapView} from './retainedReferenceCorpus.mjs';
import {createDiagnosticResourceArena,measureBoundedJsonBytes} from './diagnosticResourceArena.mjs';
import {readPrematchHistoryTargetInput,readSeriesHistoryTargetInput} from './staticHistoryTargetContracts.mjs';
import {produceCausalDraftStyleFit} from './causalDraftStyleFit.mjs';
import {bindHistoricalRelationalSemantics} from './historicalSemanticBindings.mjs';
import {collectReviewedDurationTails,produceReviewedHistoricalSummaries} from './reviewedHistoricalSummaries.mjs';
import {produceChronologicalResultRatings} from './chronologicalResultRatings.mjs';
import {createProofScopedMapReader} from './proofScopedMapReader.mjs';
import {readActualPrivateViewWriterEpoch} from './retainedReferenceCorpus.mjs';
import {hashCanonicalEvidence} from './canonicalEvidenceHash.mjs';

export const HISTORICAL_RELATIONAL_CONTRACT='aegis.historical-relational-features.v1';
export const HISTORICAL_RELATIONAL_FORMULA_VERSION='aegis.prior-map-relational-statistics.v3';
const WINDOWS=[7,30,90],DAY=86400n*1000000000n,MAX_MAPS=50000;
const closingTemplate=defineFeatureSemanticTemplate({templateId:NATIVE_CLOSING_REFERENCE_DEFINITION,policies:{supportUnit:'distinct prior completed maps per current team/landmark/native NW risk set',supportPolicy:'count observed qualified maps; statistical values require max(5,context minimumSupport); sample SD requires at least2; no repeated-frame support inflation',populationPolicy:'only provided raw-replayed prior native frames and as-of completed-map facts; not a globally complete population',eventTimePolicy:'prior10/20/30minute landmark; maps ending at or before landmark excluded; last clock<=landmark within30s',availabilityTimePolicy:'raw observation, outcome, known roster and explicit duration receipt <= immutable history cutoff; missing durationKnownAt never aliases outcomeKnownAt',gameClockPolicy:'remaining duration = prior final durationSeconds - landmarkSeconds; actual observed anchor lag reported separately',rolePolicy:'complete five native NW observations on each prior side; no role or carry inference',patchPolicy:'unconditioned across recorded patches; no automatic patch reset or current-patch assumption',phasePolicy:'past-only history selected by current team identity; no current-map outcome or current live requirement',missingReasonPolicy:'missing producer or source/identity/timestamp/support =>null; count0 is only provided qualified cohort support,not no maps worldwide',windowPolicy:'prior90d by endedAt; landmark600/1200/1800 seconds; anchor max30s preceding gap',weightPolicy:'unweighted distinct-map mean/proportion; own-side native NW lead>=1000 or deficit<=-1000 reference risk sets',tiePolicy:'greatest prior game clock then latest receipt then lexicographically smallest observation ID; deterministic numeric map order',variancePolicy:'sample SD divisor(n-1)',quantilePolicy:'linear empirical quantile index(n-1)*q for q25/median/q75',coordinate:'not_applicable: no candidate axis',orientation:'historical own-team lead/outcome selected by current nominal team identity; current Radiant/Dire tag only orients output'}});
const CLOSING_METRICS={supportMaps:'distinct_maps',winFraction:'fraction',meanRemainingDurationSeconds:'seconds',remainingDurationSampleSdSeconds:'seconds',remainingDurationP25Seconds:'seconds',remainingDurationMedianSeconds:'seconds',remainingDurationP75Seconds:'seconds',meanAnchorLagSeconds:'seconds'};
function projectClosingLandmarks(historyContext,roster,minimumSupport,formulaVersion){
 const features=[],refs=historyContext.featurePayload?.closingLandmarkReferences??[],cutoff=instantNs(historyContext.historyCutoffAt),threshold=Math.max(5,minimumSupport);
 for(const side of SIDE){const teamId=roster.find(p=>p.side===side)?.teamId??null;for(const landmarkSeconds of [600,1200,1800])for(const condition of ['lead_at_least_1000','deficit_at_most_minus_1000']){const selected=refs.filter(ref=>ref.side===side&&ref.teamId===teamId&&ref.landmarkSeconds===landmarkSeconds&&ref.condition===condition),ref=selected.length===1?selected[0]:null,sourceValid=ref?.definition===NATIVE_CLOSING_REFERENCE_DEFINITION&&ref.cohortQualified===true&&ref.minimumSupport===threshold&&ref.windowDays===90&&Number.isSafeInteger(ref.supportMaps)&&ref.supportMaps>=0&&Array.isArray(ref.sourceObservations)&&ref.sourceObservations.length===ref.supportMaps&&new Set(ref.sourceObservations.map(o=>o.matchId)).size===ref.supportMaps&&ref.sourceObservations.every(o=>o.matchId!==historyContext.matchId&&instantNs(o.dependencyKnownAt)!==null&&instantNs(o.dependencyKnownAt)<=cutoff);
  for(const [metric,units]of Object.entries(CLOSING_METRICS)){const value=sourceValid&&(metric==='supportMaps'||ref.supportMaps>=threshold)&&finite(ref.values?.[metric])?ref.values[metric]:null,name=`histrel.${side}.closing_landmark.${landmarkSeconds}s.${condition}.${metric}`,inputBindings=[{normalizedField:'historyContext.featurePayload.closingLandmarkReferences[exact_selector].'+metric,rawField:'qualified prior Steam ten-player NW and completed prior map outcome/duration receipt',sourceProfile:'steam.GetLiveLeagueGames.v1.scoreboard + local_prior_completed_map_facts',sourceKind:'prior_native_landmark_history_reference',units,availabilityPolicy:'all exact reference dependency receipts <= immutable historyCutoffAt; no original provider publication inferred',selector:{kind:'current_same_side_team',side,landmarkSeconds,condition}},{normalizedField:'roster.'+side+'.teamId',rawField:'validated enclosing current target team identity',sourceProfile:'historical_relational.current_target_identity',sourceKind:'supplied_normalized_current_identity',units:'nominal_team_id',availabilityPolicy:'current target identity at validFrom; does not expand immutable history cutoff'}],metadata=bindFeatureSemanticTemplate(closingTemplate,{inputBindings,minimumSupport:metric==='supportMaps'?0:threshold,historyWindowDays:90,formulaParameters:{side,landmarkSeconds,condition,thresholdNativeNetWorth:condition==='lead_at_least_1000'?1000:-1000,metric,contextMinimumSupport:minimumSupport,referenceDefinition:NATIVE_CLOSING_REFERENCE_DEFINITION}});
   features.push({name,value,definition:{name,familyId:'S05',formula:'literal '+metric+' from qualified distinct-map prior90d landmark/native-NW risk set; remaining duration is final duration minus landmark, not anchor; actual lag separate',formulaVersion,type:'float64',units,inputScopes:['prior_completed_maps','current_identity'],inputFields:inputBindings.map(port=>port.normalizedField),historyDefinitions:[],knownAt:sourceValid?ref.latestHistoryAvailabilityAt:null,supportRefs:[],missingPolicy:'null_with_missing_mask; explicit count of qualified provided maps only',...metadata,dependencyRefs:[...inputBindings.map(port=>({kind:'input',port})),{kind:'formulaTemplate',templateId:closingTemplate.templateId}],parameterClassification:{contract:'aegis.feature-parameter-classification.v1',functionParameters:metadata.formulaParameters,rowParameters:{currentTeamId:teamId},classifiedKeys:Object.keys(metadata.formulaParameters),unclassifiedKeys:[]}}});
  }
 }}return features;
}
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const id=x=>typeof x==='string'&&/^[1-9]\d{0,19}$/.test(x);
const account=x=>id(x)&&BigInt(x)<4294967295n;
const hero=x=>(typeof x==='number'&&Number.isSafeInteger(x)||typeof x==='string'&&/^[1-9]\d*$/.test(x))&&Number(x)>0&&Number(x)<=250;
const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
export const historicalRelationalHash=hashCanonicalEvidence;
const byId=(a,b)=>a.matchId.length-b.matchId.length||a.matchId.localeCompare(b.matchId,'en');
const mean=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
const variance=xs=>{if(xs.length<2)return null;const center=mean(xs);return xs.reduce((s,x)=>s+(x-center)**2,0)/(xs.length-1);};
const quantile=(xs,p)=>{if(!xs.length)return null;const a=[...xs].sort((x,y)=>x-y),i=(a.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i);return a[lo]+(a[hi]-a[lo])*(i-lo);};
const latest=xs=>xs.reduce((a,b)=>!a?b:b===a?a:instantNs(b)>instantNs(a)?b:a,null);
const choose=(xs,k)=>{if(k===0)return[[]];return xs.flatMap((x,i)=>choose(xs.slice(i+1),k-1).map(t=>[x,...t]));};
const SIDE=['radiant','dire'];
const slotCompare=(a,b)=>a.heroId===null&&b.heroId===null?(a.accountId===null?1:b.accountId===null?-1:a.accountId.length-b.accountId.length||a.accountId.localeCompare(b.accountId,'en')):a.heroId-b.heroId;
export const HISTORICAL_PERFORMANCE_METRICS=Object.freeze({
 totalGold:{units:'gold',formula:'native previous-map total_gold; not final net worth'},totalXp:{units:'experience',formula:'native previous-map total_xp'},observerWardsPlaced:{units:'wards',formula:'native previous-map obs_placed'},sentryWardsPlaced:{units:'wards',formula:'native previous-map sen_placed'},observerWardsKilled:{units:'wards',formula:'native previous-map observer_kills'},sentryWardsKilled:{units:'wards',formula:'native previous-map sentry_kills'},
 gpm:{units:'gold_per_minute',formula:'native gold_per_min from a completed previous map'},
 xpm:{units:'experience_per_minute',formula:'native xp_per_min from a completed previous map'},
 kills:{units:'kills',formula:'native previous-map player kills'},deaths:{units:'deaths',formula:'native previous-map player deaths'},assists:{units:'assists',formula:'native previous-map player assists'},lastHits:{units:'last_hits',formula:'native previous-map last hits'},denies:{units:'denies',formula:'native previous-map denies'},heroDamage:{units:'damage',formula:'native previous-map hero damage'},towerDamage:{units:'damage',formula:'native previous-map tower damage'},heroHealing:{units:'healing',formula:'native previous-map hero healing'},level:{units:'hero_level',formula:'native previous-map final level'},netWorth:{units:'gold',formula:'native previous-map final net_worth; not gpm*time'},goldSpent:{units:'gold',formula:'native previous-map final gold_spent'},
 killsPerMinute:{units:'kills_per_minute',formula:'previous-map native kills/(final durationSeconds/60)'},deathsPerMinute:{units:'deaths_per_minute',formula:'previous-map native deaths/(final durationSeconds/60)'},assistsPerMinute:{units:'assists_per_minute',formula:'previous-map native assists/(final durationSeconds/60)'},lastHitsPerMinute:{units:'last_hits_per_minute',formula:'previous-map native lastHits/(final durationSeconds/60)'},deniesPerMinute:{units:'denies_per_minute',formula:'previous-map native denies/(final durationSeconds/60)'},heroDamagePerMinute:{units:'damage_per_minute',formula:'previous-map native heroDamage/(final durationSeconds/60)'},towerDamagePerMinute:{units:'damage_per_minute',formula:'previous-map native towerDamage/(final durationSeconds/60)'},heroHealingPerMinute:{units:'healing_per_minute',formula:'previous-map native heroHealing/(final durationSeconds/60)'},goldSpentPerMinute:{units:'gold_per_minute',formula:'previous-map native goldSpent/(final durationSeconds/60)'},kda:{units:'ratio',formula:'(native kills+native assists)/max(1,native deaths) from previous map'},heroDamagePerGpm:{units:'damage_per_gold',formula:'previous-map heroDamagePerMinute/native gpm; gpm must be positive'},towerDamagePerGpm:{units:'damage_per_gold',formula:'previous-map towerDamagePerMinute/native gpm; gpm must be positive'},heroHealingPerGpm:{units:'healing_per_gold',formula:'previous-map heroHealingPerMinute/native gpm; gpm must be positive'}
});
for(const definition of Object.values(HISTORICAL_PERFORMANCE_METRICS))Object.freeze(definition);
const PERFORMANCE_KEYS=Object.keys(HISTORICAL_PERFORMANCE_METRICS);

// Learned ratings, individual final GPM/damage, patch/role and item histories are
// deliberately not fabricated from outcome, total team kills or hero identities.
export const HISTORICAL_RELATIONAL_PENDING_FAMILIES=Object.freeze([
 {familyId:'H07',reason:'Local causal K32 account-lineup result reference is implemented; external personal MMR and uncertainty are not provided or invented.'},
 {familyId:'H03',reason:'Raw directional pair rates are implemented. Canonical pre-map rating residual requires actual prior-map start/decision/identity availability evidence; result-update order is not a pre-map proof.'},
 {familyId:'H08',reason:'Supported only when optional heroPerformances contains native prior-player fields and knownAt evidence; omitted namespace is missing.'},
 {familyId:'H09',reason:'Native prior-performance self/population residuals are implemented; learned opponent/role-adjusted baselines remain pending.'},
 {familyId:'H11',reason:'Native historical ratios are implemented only where both inputs were observed; item/event pressure remains pending.'},
 {familyId:'D01',reason:'Ban identities are not in the selected prior-map fact contract.'},
 {familyId:'D06',reason:'Patch and letter revision proof is not in current prior-map facts; no calendar guess.'},
 {familyId:'D07',reason:'Only explicit local parsed professional population is supported; no Immortal/region/role substitution.'},
 {familyId:'D08',reason:'Hero mechanics require a separate versioned rules input.'},
 {familyId:'S02',reason:'Native ward count aggregates are supported when present; item timing, ward event timing and buyback events remain absent.'},
 {familyId:'S03',reason:'A prior opponents style must be frozen before that prior map; final-opponent pace is not a causal pre-map style.'},
 {familyId:'S04',reason:'Team-conditioned selected-hero total-kill pace/duration/late40 contrasts are implemented; mechanics/archetype variants still require versioned descriptors.'},
 {familyId:'S05',reason:'Historical duration given a win is available; finishing speed conditional on an earlier lead requires raw trajectories.'}
]);
for(const family of HISTORICAL_RELATIONAL_PENDING_FAMILIES)Object.freeze(family);

const METRICS=Object.freeze({
 supportMaps:{units:'distinct_maps',formula:'count(distinct eligible mapId)',supportAlways:true},
 effectiveCount:{units:'effective_distinct_maps',formula:'(sum(w)^2)/sum(w^2), w=2^(-age_endedAt_days/windowDays)',supportAlways:true},
 rawWinFraction:{units:'fraction',formula:'sum(won)/n'},
 smoothedWinFraction:{units:'fraction',formula:'(sum(won)+10)/(n+20); fixed symmetric Beta(10,10), not learned'},
 decayedWinFraction:{units:'fraction',formula:'sum(w*won)/sum(w), w=2^(-age_endedAt_days/windowDays)'},
 smoothedDecayedWinFraction:{units:'fraction',formula:'(sum(w*won)+10)/(sum(w)+20)'},
 winFractionStandardError:{units:'fraction',formula:'sqrt(rawWinFraction*(1-rawWinFraction)/n)'},
 wilsonLower95:{units:'fraction',formula:'Wilson binomial lower bound, z=1.959963984540054'},
 wilsonUpper95:{units:'fraction',formula:'Wilson binomial upper bound, z=1.959963984540054'},
 meanDurationSeconds:{units:'seconds',formula:'mean(final duration of eligible previous maps)'},
 durationSampleSdSeconds:{units:'seconds',formula:'sqrt(sum((duration-mean)^2)/(n-1)); requires two maps'},
 durationP25Seconds:{units:'seconds',formula:'linear empirical quantile q=.25 at index (n-1)*q'},
 durationMedianSeconds:{units:'seconds',formula:'linear empirical quantile q=.5 at index (n-1)*q'},
 durationP75Seconds:{units:'seconds',formula:'linear empirical quantile q=.75 at index (n-1)*q'},
 late40Fraction:{units:'fraction',formula:'count(duration>=2400 seconds)/n'},
 late50Fraction:{units:'fraction',formula:'count(duration>=3000 seconds)/n'},
 winMeanDurationSeconds:{units:'seconds',formula:'mean(previous final duration | selected side won)'},
 lossMeanDurationSeconds:{units:'seconds',formula:'mean(previous final duration | selected side lost)'},
 meanTotalKills:{units:'kills',formula:'mean(radiantKills+direKills), both integer values observed'},
 totalKillsSampleSd:{units:'kills',formula:'sample SD of radiantKills+direKills'},
 totalKillsP25:{units:'kills',formula:'linear empirical quantile of total kills q=.25'},
 totalKillsMedian:{units:'kills',formula:'linear empirical quantile of total kills q=.5'},
 totalKillsP75:{units:'kills',formula:'linear empirical quantile of total kills q=.75'},
 meanOwnKillsPerMinute:{units:'team_kills_per_minute',formula:'mean(selected side final kills/(durationSeconds/60)); not individual kills'},
 meanOpponentKillsPerMinute:{units:'team_kills_per_minute',formula:'mean(opposite side final kills/(durationSeconds/60))'},
 meanTotalKillsPerMinute:{units:'kills_per_minute',formula:'mean((radiantKills+direKills)/(durationSeconds/60))'},
 daysSinceLastObservedMap:{units:'days',formula:'(historyCutoffAt-max(endedAt))/86400 seconds'},
 trailingOutcomeStreak:{units:'signed_distinct_maps',formula:'signed length of most recent identical outcomes ordered by endedAt then mapId; receipt time only gates availability'}
});

function readPerformance(x,heroes,players,cutoff,audit){
 if(x.heroPerformances===undefined)return[];
 if(!Array.isArray(x.heroPerformances)||x.heroPerformances.length>10)throw Error('relational_performance_bound');
 const result=[],seen=new Set();
 for(const p of x.heroPerformances){
  const retained=p?.sourceProfile==='opendota.completed-map.retained-response-player';
  const profileAllowed=p?.sourceProfile==='opendota.completed-map.parsed-player'||retained&&audit.populationBasis==='bounded_provided_retained_corpus_not_global'&&x.availabilityBasis==='retained_collector_response_receipt'&&sha(x.sourceVersionSetSha256)&&p.availabilityBasis==='retained_collector_response_receipt'&&obj(p.metricAvailability)&&obj(p.metricSources);
  if(!obj(p)||p.contract!==PERFORMANCE_CONTRACT||!profileAllowed||!obj(p.sourceFields)||Object.entries(PERFORMANCE_FIELDS).some(([key,field])=>p.sourceFields[key]!==field)||!hero(p.heroId)||!SIDE.includes(p.side)||p.accountId!==null&&!account(p.accountId)||!obj(p.metrics))throw Error('relational_performance_identity_or_source_contract');
  if(seen.has(Number(p.heroId)))throw Error('relational_performance_duplicate_hero');seen.add(Number(p.heroId));
  const at=instantNs(p.knownAt);if(at===null||at<instantNs(x.endedAt))throw Error('relational_performance_availability');
  if(at>cutoff){audit.unavailablePerformanceRows++;continue;}
  if(retained&&Object.entries(p.metrics).some(([key,value])=>value!==null&&value!==undefined&&(!Object.hasOwn(PERFORMANCE_FIELDS,key)||!sha(p.metricSources[key])||instantNs(p.metricAvailability[key])===null||instantNs(p.metricAvailability[key])<instantNs(x.endedAt)||instantNs(p.metricAvailability[key])>at)))throw Error('relational_retained_performance_provenance');
  if(!heroes.some(h=>h.heroId===Number(p.heroId)&&h.side===p.side))throw Error('relational_performance_hero_conflict');
  const known=players.find(q=>q.heroId===Number(p.heroId));if(known&&p.accountId!==null&&(known.accountId!==p.accountId||known.side!==p.side))throw Error('relational_performance_account_conflict');
  const metrics={};for(const key of PERFORMANCE_KEYS)metrics[key]=null;
  for(const key of ['gpm','xpm','kills','deaths','assists','lastHits','denies','heroDamage','towerDamage','heroHealing','level','netWorth','goldSpent','totalGold','totalXp','observerWardsPlaced','sentryWardsPlaced','observerWardsKilled','sentryWardsKilled']){
   const v=p.metrics[key];if(v!==undefined&&v!==null&&(!finite(v)||v<0||v>Number.MAX_SAFE_INTEGER))throw Error('relational_performance_native_metric');
   metrics[key]=v??null;
  }
  const minutes=x.durationSeconds/60;
  for(const [out,key]of [['killsPerMinute','kills'],['deathsPerMinute','deaths'],['assistsPerMinute','assists'],['lastHitsPerMinute','lastHits'],['deniesPerMinute','denies'],['heroDamagePerMinute','heroDamage'],['towerDamagePerMinute','towerDamage'],['heroHealingPerMinute','heroHealing'],['goldSpentPerMinute','goldSpent']])if(metrics[key]!==null)metrics[out]=metrics[key]/minutes;
  if(['kills','assists','deaths'].every(k=>metrics[k]!==null))metrics.kda=(metrics.kills+metrics.assists)/Math.max(1,metrics.deaths);
  if(metrics.gpm>0)for(const [out,key]of [['heroDamagePerGpm','heroDamagePerMinute'],['towerDamagePerGpm','towerDamagePerMinute'],['heroHealingPerGpm','heroHealingPerMinute']])if(metrics[key]!==null)metrics[out]=metrics[key]/metrics.gpm;
  result.push({accountId:p.accountId,heroId:Number(p.heroId),side:p.side,knownAt:p.knownAt,metrics});
 }
 return result;
}

function readMaps(facts,cutoff,current,audit,{allProvidedHistory=false}={}){
 const seen=new Set(),maps=[];
 for(const x of facts.rows){
  if(!obj(x)||!id(x.matchId))throw Error('relational_fact_identity');
  if(seen.has(x.matchId))throw Error('relational_duplicate_map');seen.add(x.matchId);
  if(x.matchId===current)throw Error('relational_current_map_forbidden');
  const ended=instantNs(x.endedAt),known=instantNs(x.outcomeKnownAt);
  if(ended===null||known===null||ended>known||typeof x.radiantWon!=='boolean'||!finite(x.durationSeconds)||x.durationSeconds<=0||x.durationSeconds>86400||typeof x.evidenceRef!=='string'||!x.evidenceRef.length)throw Error('relational_fact_chronology_or_outcome');
  if(known>cutoff){audit.futureOutcomeExcluded++;continue;}
  if(!allProvidedHistory&&ended<cutoff-90n*DAY){audit.olderThan90DaysExcluded++;continue;}
  if([x.radiantTeamId,x.direTeamId].some(t=>t!==null&&!id(t))||x.radiantTeamId!==null&&x.radiantTeamId===x.direTeamId)throw Error('relational_prior_team_identity');
  const playersAt=instantNs(x.playersKnownAt),heroesAt=instantNs(x.heroesKnownAt??x.playersKnownAt);
  let players=[],heroes=[];
  const suppliedHeroes=Object.hasOwn(x,'heroes')?x.heroes:x.players;
  if(Array.isArray(suppliedHeroes)&&suppliedHeroes.length<=10&&heroesAt!==null&&heroesAt<=cutoff){
   heroes=suppliedHeroes.filter(h=>obj(h)&&hero(h.heroId)&&SIDE.includes(h.side)).map(h=>({heroId:Number(h.heroId),side:h.side}));
   if(new Set(heroes.map(h=>h.heroId)).size!==heroes.length||SIDE.some(s=>heroes.filter(h=>h.side===s).length>5))throw Error('relational_prior_hero_roster_conflict');
  }else if(suppliedHeroes?.length)audit.unavailableHeroRosters++;
  if(Array.isArray(x.players)&&x.players.length<=10&&playersAt!==null&&playersAt>=known&&playersAt<=cutoff){
   players=x.players.filter(p=>obj(p)&&account(p.accountId)&&hero(p.heroId)&&SIDE.includes(p.side)).map(p=>({accountId:p.accountId,heroId:Number(p.heroId),side:p.side}));
   if(new Set(players.map(p=>p.accountId)).size!==players.length||new Set(players.map(p=>p.heroId)).size!==players.length||SIDE.some(s=>players.filter(p=>p.side===s).length>5)||players.some(p=>!heroes.some(h=>h.heroId===p.heroId&&h.side===p.side)))throw Error('relational_prior_player_roster_conflict');
  }else if(x.players?.length)audit.unavailablePlayerRosters++;
  const kills={};for(const s of SIDE)kills[s]=Number.isSafeInteger(x[s+'Kills'])&&x[s+'Kills']>=0?x[s+'Kills']:null;
  const performance=readPerformance(x,heroes,players,cutoff,audit);
  maps.push({matchId:x.matchId,endedAt:x.endedAt,outcomeKnownAt:x.outcomeKnownAt,playersKnownAt:x.playersKnownAt,heroesKnownAt:x.heroesKnownAt??x.playersKnownAt,performance,
   radiantTeamId:x.radiantTeamId,direTeamId:x.direTeamId,radiantWon:x.radiantWon,durationSeconds:x.durationSeconds,players,heroes,kills,ended,known,evidenceRef:x.evidenceRef});
 }
 return maps.sort(byId);
}

function qualifiedScope(facts,cutoff){
 const s=facts.data.scope,validIds=a=>Array.isArray(a)&&a.every(id)&&new Set(a).size===a.length;
 if(obj(s)&&s.contract==='aegis.retained-history-selection-scope.v1'&&s.sourceUniverse==='locally_retained_opendota_responses'&&s.selection==='provided_version_inputs_only'&&instantNs(s.asOf)===cutoff&&s.completeWithinProvidedInputs===true&&s.globalPopulationComplete===false&&s.truncated===false&&s.rowCount===facts.rows.length){
  // Qualify only the explicitly supplied local corpus. Never relabel it as the
  // SQL universe or global/pro/Immortal coverage. Selector discovery also obeys
  // availability, so future-only identities cannot change an older vector.
  const known=facts.rows.filter(m=>instantNs(m.outcomeKnownAt)!==null&&instantNs(m.outcomeKnownAt)<=cutoff);
  const accounts=new Set(known.flatMap(m=>instantNs(m.playersKnownAt)!==null&&instantNs(m.playersKnownAt)<=cutoff?(m.players??[]).map(p=>p.accountId).filter(account):[]));
  const teams=new Set(known.flatMap(m=>[m.radiantTeamId,m.direTeamId].filter(id)));
  const heroes=new Set(known.flatMap(m=>instantNs(m.heroesKnownAt??m.playersKnownAt)!==null&&instantNs(m.heroesKnownAt??m.playersKnownAt)<=cutoff?(m.heroes??m.players??[]).map(p=>Number(p.heroId)).filter(hero):[]));
  return{base:true,accounts,teams,heroes,evidence:s,populationBasis:'bounded_provided_retained_corpus_not_global',globalPopulationComplete:false};
 }
 const base=obj(s)&&s.contract==='aegis.prior-map-selection-scope.v1'&&s.sourceUniverse==='local_pro_matches_join_match_parsed'&&s.selection==='target_teams_or_accounts_or_heroes'&&s.windowDays===90&&instantNs(s.asOf)===cutoff&&s.completeWithinSource===true&&s.truncated===false&&s.rowCount===facts.rows.length&&sha(s.selectionSqlSha256)&&typeof s.queryEvidenceRef==='string'&&s.queryEvidenceRef.length>0;
 return {base:!!base,accounts:new Set(base&&validIds(s.targetAccountIds)?s.targetAccountIds:[]),teams:new Set(base&&validIds(s.targetTeamIds)?s.targetTeamIds:[]),heroes:new Set(base&&Array.isArray(s.targetHeroIds)&&s.targetHeroIds.every(h=>Number.isInteger(h)&&h>0&&h<=250)&&new Set(s.targetHeroIds).size===s.targetHeroIds.length?s.targetHeroIds:[]),evidence:s??null};
}

function selectorMatch(selector,map,side){
 const members=map.players.filter(p=>p.side===side),heroes=map.heroes.filter(h=>h.side===side).map(h=>h.heroId),opposite=side==='radiant'?'dire':'radiant';
 if(selector.teamId!==undefined&&map[side+'TeamId']!==selector.teamId)return false;
 if(selector.opponentTeamId!==undefined&&map[opposite+'TeamId']!==selector.opponentTeamId)return false;
 if(selector.players?.some(q=>!members.some(p=>p.accountId===q.accountId&&(q.heroId===undefined||p.heroId===q.heroId))))return false;
 if(selector.heroes?.some(h=>!heroes.includes(h)))return false;
 if(selector.opponents?.some(q=>!map.players.some(p=>p.side===opposite&&p.accountId===q.accountId&&(q.heroId===undefined||p.heroId===q.heroId))))return false;
 if(selector.opponentHeroes?.some(h=>!map.heroes.some(p=>p.side===opposite&&p.heroId===h)))return false;
 return true;
}

function selectorsFor(roster,scope){
 const out=[],add=(key,familyId,kind,selector,qualified,reason='source_selection_or_identity_unproven')=>out.push({key,familyId,kind,selector,qualified,reason});
 const has=(p,kind)=>kind==='account'?p.accountId!==null&&scope.accounts.has(p.accountId):kind==='team'?p.teamId!==null&&scope.teams.has(p.teamId):scope.heroes.has(p.heroId);
 for(const side of SIDE){
  const group=roster.filter(p=>p.side===side).sort(slotCompare),other=roster.filter(p=>p.side!==side).sort(slotCompare),team=group[0].teamId;
  add(side+'.team','H02','team',{teamId:team},has(group[0],'team'));
  add(side+'.head_to_head','H03','team',{teamId:team,opponentTeamId:other[0].teamId},has(group[0],'team')&&other[0].teamId!==null);
  for(const [i,p]of group.entries()){
   const prefix=side+'.slot_'+i;
   add(prefix+'.player','H05','player',{players:[{accountId:p.accountId}]},has(p,'account'));
   add(prefix+'.player_hero','H06','player_hero',{players:[{accountId:p.accountId,heroId:p.heroId}]},has(p,'account')&&p.heroId!==null);
   add(prefix+'.player_team','H10','player_team',{players:[{accountId:p.accountId}],teamId:team},has(p,'account')&&team!==null);
   add(prefix+'.player_team_hero','H10','player_team_hero',{players:[{accountId:p.accountId,heroId:p.heroId}],teamId:team},has(p,'account')&&team!==null&&p.heroId!==null);
   add(prefix+'.hero','D02','hero',{heroes:[p.heroId]},has(p,'hero'));
   add(prefix+'.team_hero','D05','team_hero',{teamId:team,heroes:[p.heroId]},has(p,'team')&&p.heroId!==null);
  }
  for(const [i,j]of choose([0,1,2,3,4],2)){
   const a=group[i],b=group[j],prefix=side+'.pair_'+i+'_'+j;
   add(prefix+'.ally_players','P01','pair',{players:[{accountId:a.accountId},{accountId:b.accountId}]},has(a,'account')&&b.accountId!==null);
   add(prefix+'.exact_player_hero_pair','P04','pair',{players:[{accountId:a.accountId,heroId:a.heroId},{accountId:b.accountId,heroId:b.heroId}]},has(a,'account')&&b.accountId!==null&&a.heroId!==null&&b.heroId!==null);
   add(prefix+'.hero_pair','D03','hero_pair',{heroes:[a.heroId,b.heroId]},has(a,'hero'));
   for(const [p,q,n]of [[a,b,'a'],[b,a,'b']]){
    add(prefix+'.'+n+'.player_hero_ally_player','P02','pair',{players:[{accountId:p.accountId,heroId:p.heroId},{accountId:q.accountId}]},has(p,'account')&&q.accountId!==null&&p.heroId!==null);
    add(prefix+'.'+n+'.player_hero_ally_hero','P03','pair',{players:[{accountId:p.accountId,heroId:p.heroId}],heroes:[q.heroId]},has(p,'account')&&p.heroId!==null&&q.heroId!==null);
   }
  }
  for(const triple of choose([0,1,2,3,4],3)){
   const p=triple.map(i=>group[i]),prefix=side+'.triple_'+triple.join('_');
   add(prefix+'.hero_triple','P05','hero_triple',{heroes:p.map(x=>x.heroId)},has(p[0],'hero'));
   add(prefix+'.exact_player_hero_triple','P05','triple',{players:p.map(x=>({accountId:x.accountId,heroId:x.heroId}))},has(p[0],'account')&&p.every(x=>x.accountId!==null&&x.heroId!==null));
  }
 }
 // A single oriented counter cohort avoids duplicating complementary outcomes.
 const radiant=roster.filter(p=>p.side==='radiant').sort(slotCompare),dire=roster.filter(p=>p.side==='dire').sort(slotCompare);
 for(let i=0;i<5;i++)for(let j=0;j<5;j++){
  const a=radiant[i],b=dire[j],prefix='counter_'+i+'_'+j;
  add(prefix+'.heroes','D04','counter',{heroes:[a.heroId],opponentHeroes:[b.heroId]},has(a,'hero'));
  add(prefix+'.players','P05','counter',{players:[{accountId:a.accountId}],opponents:[{accountId:b.accountId}]},has(a,'account')&&b.accountId!==null);
  add(prefix+'.player_hero','P05','counter',{players:[{accountId:a.accountId,heroId:a.heroId}],opponents:[{accountId:b.accountId,heroId:b.heroId}]},has(a,'account')&&b.accountId!==null&&a.heroId!==null&&b.heroId!==null);
 }
 return out.map(s=>({...s,requiresCurrentDraft:!!(s.selector.heroes?.length||s.selector.opponentHeroes?.length||s.selector.players?.some(p=>p.heroId!==undefined)||s.selector.opponents?.some(p=>p.heroId!==undefined))}));
}

function calculateStats(rows,{windowDays,minimumSupport,cutoff,qualified,reason,supportRef,latestKnownAt}){
 // Event chronology defines sporting form. Availability clocks only decide
 // what can be used; a delayed fetch or refresh cannot make an old game recent.
 const n=rows.length,win=rows.reduce((s,r)=>s+Number(r.won),0),p=n?win/n:0,weights=rows.map(r=>2**(-Number(cutoff-r.map.ended)/Number(DAY)/windowDays)),sw=weights.reduce((a,b)=>a+b,0),sw2=weights.reduce((a,b)=>a+b*b,0);
 const winningRows=rows.filter(r=>r.won),losingRows=rows.filter(r=>!r.won),duration=rows.map(r=>r.map.durationSeconds),wins=winningRows.map(r=>r.map.durationSeconds),losses=losingRows.map(r=>r.map.durationSeconds);
 const completeKills=rows.filter(r=>r.map.kills.radiant!==null&&r.map.kills.dire!==null),kills=completeKills.map(r=>r.map.kills.radiant+r.map.kills.dire);
 const own=rows.filter(r=>r.map.kills[r.side]!==null),opp=rows.filter(r=>r.map.kills[r.side==='radiant'?'dire':'radiant']!==null);
 const z=1.959963984540054,center=n?(p+z*z/(2*n))/(1+z*z/n):null,half=n?z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/(1+z*z/n):null;
 const ordered=[...rows].sort((a,b)=>a.map.ended<b.map.ended?1:a.map.ended>b.map.ended?-1:byId(b.map,a.map));let streak=0;
 for(const r of ordered){if(r.won!==ordered[0]?.won)break;streak+=r.won?1:-1;}
 const raw={supportMaps:n,effectiveCount:sw2?sw*sw/sw2:0,rawWinFraction:n?p:null,smoothedWinFraction:(win+10)/(n+20),decayedWinFraction:sw?rows.reduce((s,r,i)=>s+weights[i]*Number(r.won),0)/sw:null,smoothedDecayedWinFraction:(rows.reduce((s,r,i)=>s+weights[i]*Number(r.won),0)+10)/(sw+20),winFractionStandardError:n?Math.sqrt(p*(1-p)/n):null,wilsonLower95:n?center-half:null,wilsonUpper95:n?center+half:null,
  meanDurationSeconds:mean(duration),durationSampleSdSeconds:variance(duration)===null?null:Math.sqrt(variance(duration)),durationP25Seconds:quantile(duration,.25),durationMedianSeconds:quantile(duration,.5),durationP75Seconds:quantile(duration,.75),late40Fraction:n?duration.filter(d=>d>=2400).length/n:null,late50Fraction:n?duration.filter(d=>d>=3000).length/n:null,winMeanDurationSeconds:mean(wins),lossMeanDurationSeconds:mean(losses),meanTotalKills:mean(kills),totalKillsSampleSd:variance(kills)===null?null:Math.sqrt(variance(kills)),totalKillsP25:quantile(kills,.25),totalKillsMedian:quantile(kills,.5),totalKillsP75:quantile(kills,.75),meanOwnKillsPerMinute:mean(own.map(r=>r.map.kills[r.side]/(r.map.durationSeconds/60))),meanOpponentKillsPerMinute:mean(opp.map(r=>r.map.kills[r.side==='radiant'?'dire':'radiant']/(r.map.durationSeconds/60))),meanTotalKillsPerMinute:mean(completeKills.map(r=>(r.map.kills.radiant+r.map.kills.dire)/(r.map.durationSeconds/60))),daysSinceLastObservedMap:n?Number(cutoff-rows.reduce((m,r)=>r.map.ended>m?r.map.ended:m,rows[0].map.ended))/Number(DAY):null,trailingOutcomeStreak:n?streak:null};
 const metricRows=k=>k==='winMeanDurationSeconds'?winningRows:k==='lossMeanDurationSeconds'?losingRows:['meanTotalKills','totalKillsSampleSd','totalKillsP25','totalKillsMedian','totalKillsP75','meanTotalKillsPerMinute'].includes(k)?completeKills:k==='meanOwnKillsPerMinute'?own:k==='meanOpponentKillsPerMinute'?opp:rows;
 const effectiveCounts=new Map([[rows,raw.effectiveCount]]);
 const at=latestKnownAt;
 return Object.fromEntries(Object.entries(METRICS).map(([key,m])=>{
  const used=metricRows(key),count=used.length,ok=qualified&&(m.supportAlways||count>=minimumSupport),value=ok&&finite(raw[key])?raw[key]:null;
  if(!effectiveCounts.has(used)){const w=used.map(r=>2**(-Number(cutoff-r.map.ended)/Number(DAY)/windowDays)),sum=w.reduce((a,b)=>a+b,0),squares=w.reduce((a,b)=>a+b*b,0);effectiveCounts.set(used,squares?sum*sum/squares:0);}
  const metricEffectiveCount=effectiveCounts.get(used);
  return[key,{value,supportMaps:count,effectiveCount:metricEffectiveCount,cohortQualified:qualified,reason:!qualified?reason:count<minimumSupport&&!m.supportAlways?'below_minimum_support':value===null?'metric_missing_or_insufficient_variance':null,definition:HISTORICAL_RELATIONAL_FORMULA_VERSION+'/'+key,formula:m.formula,units:m.units,windowDays,minimumSupport,latestHistoryAvailabilityAt:at,supportRef}];
 }));
}

function familyFor(selector,metric){
 if(metric.includes('Duration')||metric.startsWith('duration')||metric.startsWith('late'))return selector.kind==='team'?'H13':['player','player_hero','hero'].includes(selector.kind)?'H14':selector.familyId;
 if(metric.includes('Kills')&&selector.kind==='team')return 'S01';
 return selector.familyId;
}
function playerProfileFamily(key){
 if(key.startsWith('formWinFraction'))return'H05';
 if(key.includes('DurationSeconds')||key.includes('Late40Fraction'))return'H14';
 if(key.includes('VsSelf')||key.includes('VsPopulation')||key.includes('VsHeroPopulation')||key.includes('PopulationZ'))return'H09';
 if(key.includes('MeanPast_')||key.includes('MeanTotalKills'))return'H08';
 return'H06';
}

export const HISTORICAL_PLAYER_PROFILE_KEYS=Object.freeze(['formWinFraction7d','formWinFraction30d','formWinFraction90d','playerHeroWinFraction90d','playerHeroVsSelfWinFraction90d','playerHeroVsHeroPopulationWinFraction90d','playerMeanDurationSeconds90d','playerHeroMeanDurationSeconds90d','heroMeanDurationSeconds90d','playerMeanTotalKills90d','playerHeroMeanTotalKills90d','heroMeanTotalKills90d','playerLate40Fraction90d','playerHeroLate40Fraction90d','heroLate40Fraction90d','heroPickShare90d',...PERFORMANCE_KEYS.flatMap(m=>['playerMeanPast_'+m+'90d','playerHeroMeanPast_'+m+'90d','heroMeanPast_'+m+'90d','playerHeroVsSelfPast_'+m+'90d','playerHeroVsPopulationPast_'+m+'90d','playerHeroPopulationZPast_'+m+'90d'])]);
export const HISTORICAL_TEAM_PROFILE_KEYS=Object.freeze(['formWinFraction7d','formWinFraction30d','formWinFraction90d','meanDurationSeconds90d','winMeanDurationSeconds90d','lossMeanDurationSeconds90d','meanTotalKills90d','meanOwnKillsPerMinute90d','late40Fraction90d',...PERFORMANCE_KEYS.flatMap(m=>WINDOWS.map(d=>'meanPast_'+m+d+'d'))]);
export const HISTORICAL_HERO_PROFILE_KEYS=Object.freeze(['formWinFraction7d','formWinFraction30d','formWinFraction90d','meanDurationSeconds90d','meanTotalKills90d','late40Fraction90d',...PERFORMANCE_KEYS.map(m=>'meanPast_'+m+'90d')]);

function performanceStatistics(selector,rows,{windowDays,minimumSupport,qualified,supportRef,registerSupportRows,supportLatestAt}){
 const out={},supports={},candidates=[],rowRefCache=new Map();
 // Resolve the same identity roster once per cohort, not once per metric.
 for(const row of rows){
  if(Object.hasOwn(row,'compactPerformance')){if(row.compactPerformance)candidates.push({row,availableAt:row.compactPerformance.availableAt,metricValues:row.compactPerformance.metricValues});continue;}
  let p=row.map.performance.filter(p=>p.side===row.side);
  if(selector.selector.players)p=p.filter(q=>selector.selector.players.some(s=>q.accountId===s.accountId&&(s.heroId===undefined||q.heroId===s.heroId)));
  if(selector.selector.heroes)p=p.filter(q=>selector.selector.heroes.includes(q.heroId));
  if(p.length===(selector.kind==='team'?5:1))candidates.push({row,players:p,availableAt:latest([row.availableAt,...p.map(p=>p.knownAt)])});
 }
 for(const [metric,definition]of Object.entries(HISTORICAL_PERFORMANCE_METRICS)){
  const observed=[],indices=[];
  for(let i=0;i<candidates.length;i++){
   const candidate=candidates[i],value=candidate.metricValues?candidate.metricValues[metric]:performanceCandidateMetric(candidate.players,metric);if(!finite(value))continue;
   observed.push({map:candidate.row.map,value,availableAt:candidate.availableAt});indices.push(i);
  }
  const values=observed.map(r=>r.value),count=observed.length,ref=supportRef+'.performance.'+metric;
  const selection=indices.join(',');if(!rowRefCache.has(selection))rowRefCache.set(selection,registerSupportRows(observed));
  const at=supportLatestAt(rowRefCache.get(selection));
  supports[ref]={cohortRef:supportRef,metric,sourceFieldsDefinition:definition.formula,teamRequiresAllFive:selector.kind==='team',supportMaps:count,sourceRowsRef:rowRefCache.get(selection),rowsAreDistinctMaps:true};
  for(const [stat,value]of Object.entries({mean:mean(values),sampleSd:variance(values)===null?null:Math.sqrt(variance(values)),median:quantile(values,.5)}))out[metric+'.'+stat]={value:qualified&&count>=minimumSupport&&finite(value)?value:null,supportMaps:count,effectiveCount:count,cohortQualified:qualified,reason:!qualified?'source_selection_or_identity_unproven':count<minimumSupport?'native_previous_performance_missing_or_below_support':value===null?'metric_insufficient_variance':null,definition:HISTORICAL_RELATIONAL_FORMULA_VERSION+'/past_performance/'+metric+'/'+stat,formula:stat+' across distinct-map '+(selector.kind==='team'?'arithmetic means of all five observed same-side player values; per-map ratios are calculated per player before this mean; ':'individual observed player values; ')+definition.formula,units:definition.units,windowDays,minimumSupport,latestHistoryAvailabilityAt:at,supportRef:ref};
 }
 return{statistics:out,supports};
}
function performanceCandidateMetric(players,metric){return players.some(p=>!finite(p.metrics[metric]))?null:mean(players.map(p=>p.metrics[metric]));}
function compactPerformanceCandidate(selector,row){
 let p=row.map.performance.filter(p=>p.side===row.side);if(selector.selector.players)p=p.filter(q=>selector.selector.players.some(s=>q.accountId===s.accountId&&(s.heroId===undefined||q.heroId===s.heroId)));if(selector.selector.heroes)p=p.filter(q=>selector.selector.heroes.includes(q.heroId));
 return p.length===(selector.kind==='team'?5:1)?{availableAt:latest([row.availableAt,...p.map(p=>p.knownAt)]),metricValues:Object.fromEntries(PERFORMANCE_KEYS.map(metric=>[metric,performanceCandidateMetric(p,metric)]))}:null;
}

/** Pure diagnostic component from actual pinned facts and a validated draft snapshot.
 * No claim of serving/training admission; no source receipt authentication by hash alone.
 */
export function produceHistoricalRelationalFeatures({historyContext,factsInput,matchId,decisionAt,minimumSupport=5,resourceArena=null}={}){
 if(!Number.isSafeInteger(minimumSupport)||minimumSupport<3||minimumSupport>1000)throw Error('relational_minimum_support_3_to_1000');
 const checked=validateObservedDraftHistory(historyContext,{matchId,decisionAt});if(!checked.accepted)throw Error('relational_context:'+checked.reason);
 return calculateRelationalComponent({historyContext,factsInput,matchId,decisionAt,minimumSupport,phase:'POST_OR_LIVE',targetBinding:null,resourceArena});
}

/** Separate diagnostic PRE contract: host-declared selector receipt, not a fake
 * observed draft, and not independently authenticated provider evidence. */
export function producePrematchHistoricalRelationalFeatures({targetInput,factsInput,decisionAt,minimumSupport=5,resourceArena=null}={}){
 if(!Number.isSafeInteger(minimumSupport)||minimumSupport<3||minimumSupport>1000)throw Error('relational_minimum_support_3_to_1000');
 const parsed=readPrematchHistoryTargetInput({targetInput,decisionAt}),target=parsed.target,players=parsed.players;
 const context={historyCutoffAt:target.historyCutoffAt,validFrom:target.knownAt,computedAt:decisionAt,availabilityBasis:'host_declared_prematch_receipt_not_authenticated',identityPlayers:players,producer:{bindings:{facts:factsInput?.pin}}};
 return calculateRelationalComponent({historyContext:context,factsInput,matchId:target.matchId,decisionAt,minimumSupport,phase:'PRE',targetBinding:parsed.targetBinding,resourceArena});
}

/** Series history has its own nominal team axes and no current map or heroes.
 * The receipt is a host-held identity declaration, not provider authentication.
 * Actual fact availability is still checked by the same historical algebra.
 */
export function produceSeriesHistoricalRelationalFeatures({targetInput,factsInput,decisionAt,minimumSupport=5,resourceArena=null}={}){
 if(!Number.isSafeInteger(minimumSupport)||minimumSupport<3||minimumSupport>1000)throw Error('series_history_minimum_support');
 const parsed=readSeriesHistoryTargetInput({targetInput,decisionAt}),t=parsed.target,players=parsed.players,p=targetInput.pin;
 const context={historyCutoffAt:t.historyCutoffAt,validFrom:t.validFrom,computedAt:decisionAt,availabilityBasis:'host_declared_series_identity_receipt_not_authenticated',identityPlayers:players,producer:{bindings:{facts:factsInput?.pin}}};
 const b=calculateRelationalComponent({historyContext:context,factsInput,matchId:null,decisionAt,minimumSupport,phase:'PRE',targetBinding:parsed.targetBinding,resourceArena});
 return orientSeriesRelationalComponent(b,parsed,targetInput);
}
function orientSeriesRelationalComponent(b,parsed,targetInput){
 const t=parsed.target,p=targetInput.pin;
 const indices=b.definitions.flatMap((d,i)=>d.inputScopes.includes('current_draft')?[]:[i]);
 const baseNames=new Set(b.names),definitions=indices.map(i=>orientSeriesRelationalDefinition(b.definitions[i],{baseNames,phase:t.phase}));
 const names=definitions.map(d=>d.name),values=indices.map(i=>b.values[i]),masks=indices.map(i=>b.masks[i]);
 const schemaHash=historicalRelationalHash({contract:'aegis.series-historical-relational-features.v1',baseSchemaHash:b.schemaHash,phase:t.phase,definitions:definitions.map(({knownAt,supportRef,supportRefs,selectorRef,...d})=>d)});
 const out={...b,contract:'aegis.series-historical-relational-features.v1',phase:t.phase,seriesId:t.seriesId,transitionId:t.transitionId,identityRevision:t.identityRevision,team1Id:t.team1Id,team2Id:t.team2Id,matchId:null,names,values,masks,definitions,schemaHash,targetInputPin:structuredClone(p),baseRelationalContentHash:b.contentHash,audit:{...b.audit,featureCount:names.length,currentMapExcluded:'no_current_map_in_series_target',nominalSideAliasesInternalOnly:true,currentHeroFeaturesExcluded:true},profiles:undefined,contentHash:undefined};
 delete out.profiles;delete out.contentHash;
 return{...out,contentHash:historicalRelationalHash(out)};
}

/** Pure namespace bridge used by the actual series wrapper. Only EXACT known
 * same-generator column references are rewritten. Generic formula IDs/unknown
 * operands are retained and cannot be repaired by a spelling resemblance. */
export function orientSeriesRelationalDefinition(d,{baseNames,phase}){
 const rename=s=>s.replace(/^histrel\./,'series_history.').replace(/\.radiant\./g,'.team1.').replace(/\.dire\./g,'.team2.').replace(/radiant_minus_dire/g,'team1_minus_team2'),reference=s=>baseNames.has(s)?rename(s):s;
 const port=p=>baseNames.has(p.normalizedField)?{...p,normalizedField:reference(p.normalizedField)}:p;
 const parameters=p=>p?.sourceStatistics?{...p,sourceStatistics:p.sourceStatistics.map(s=>({...s,...(s.emittedReferences?{emittedReferences:s.emittedReferences.map(reference)}:{}),...(s.emittedOperandUnits?{emittedOperandUnits:Object.fromEntries(Object.entries(s.emittedOperandUnits).map(([key,units])=>[reference(key),units]))}:{})}))}:p;
 return{...d,name:rename(d.name),...(d.historyDefinitions?{historyDefinitions:d.historyDefinitions.map(reference)}:{}),...(d.inputFields?{inputFields:d.inputFields.map(reference)}:{}),...(d.inputBindings?{inputBindings:d.inputBindings.map(port)}:{}),...(d.dependencyRefs?{dependencyRefs:d.dependencyRefs.map(r=>r.kind==='feature'&&r.component==='history'&&baseNames.has(r.name)?{...r,component:'seriesHistory',name:reference(r.name)}:r.kind==='input'?{...r,port:port(r.port)}:r)}:{}),...(d.formulaParameters?{formulaParameters:parameters(d.formulaParameters)}:{}),...(d.parameterClassification?{parameterClassification:{...d.parameterClassification,functionParameters:parameters(d.parameterClassification.functionParameters)}}:{}),orientation:'team1/team2 nominal axes; never assumed Radiant/Dire',allowedTargets:[phase,'SERIES_LIVE']};
}

function compactChronologicalEvent(map){return{matchId:map.matchId,endedAt:map.endedAt,outcomeKnownAt:map.outcomeKnownAt,playersKnownAt:map.playersKnownAt,radiantTeamId:map.radiantTeamId,direTeamId:map.direTeamId,radiantWon:map.radiantWon,players:map.players.map(p=>({accountId:p.accountId,side:p.side}))};}
function chronologyAudit(scope){return{populationBasis:scope.populationBasis,futureOutcomeExcluded:0,olderThan90DaysExcluded:0,unavailableHeroRosters:0,unavailablePlayerRosters:0,unavailablePerformanceRows:0};}
function calculateRelationalComponent({historyContext,factsInput,matchId,decisionAt,minimumSupport,phase,targetBinding,resourceArena=null}){
 const facts=pinned(factsInput,FACTS_CONTRACT,MAX_MAPS),binding=historyContext.producer?.bindings?.facts;
 if(!binding||binding.sha256!==facts.pin.sha256||binding.bytes!==facts.pin.bytes)throw Error('relational_facts_context_binding');
 const cutoff=instantNs(historyContext.historyCutoffAt),scope=qualifiedScope(facts,cutoff),roster=(historyContext.draftState?.identity.players??historyContext.identityPlayers).map(p=>({...p,heroId:p.heroId===null?null:Number(p.heroId)})).sort((a,b)=>SIDE.indexOf(a.side)-SIDE.indexOf(b.side)||slotCompare(a,b));
 if(roster.length!==10||phase!=='PRE'&&new Set(roster.map(p=>p.heroId)).size!==10||SIDE.some(s=>roster.filter(p=>p.side===s).length!==5)||roster.some(p=>phase==='PRE'?p.heroId!==null:!hero(p.heroId)||p.accountId!==null&&!account(p.accountId)))throw Error('relational_draft_roster');
 const audit={inputMaps:facts.rows.length,futureOutcomeExcluded:0,olderThan90DaysExcluded:0,unavailableHeroRosters:0,unavailablePlayerRosters:0,unavailablePerformanceRows:0,minimumSupport,scopeQualified:scope.base,populationBasis:scope.populationBasis??'local_sql_selected_corpus_not_global',globalPopulationComplete:false};
 const maps=readMaps(facts,cutoff,matchId,audit),steps=relationalCalculationSteps({historyContext,facts,matchId,decisionAt,minimumSupport,phase,targetBinding,cutoff,scope,roster,audit,eligibleMapCount:maps.length});let step=steps.next();while(!step.done){if(step.value.kind==='r7_all_provided_events'){const lease=(resourceArena??createDiagnosticResourceArena()).reserve(64*1024*1024*6+65536);if(!lease)throw Error('relational_chronology_memory_reservation');try{const events=[];let n=0;for(const raw of facts.rows)for(const map of readMaps({rows:[raw]},cutoff,matchId,chronologyAudit(scope),{allProvidedHistory:true})){const e=compactChronologicalEvent(map);n+=measureBoundedJsonBytes(e,{maxBytes:64*1024*1024});if(n>64*1024*1024)throw Error('relational_chronology_scalar_bound');events.push(e);}step=steps.next(events);}finally{lease.release();}}else step=steps.next(rowsForSelector(step.value,maps));}return step.value;
}
function rowsForSelector(selector,maps){
 const rows=[];if(selector.qualified)for(const map of maps){const matched=SIDE.filter(side=>selectorMatch(selector.selector,map,side));if(matched.length>1)throw Error('relational_selector_ambiguous_side');if(matched.length){const side=matched[0],needsPlayers=selector.selector.players?.length||selector.selector.opponents?.length,needsHeroes=selector.selector.heroes?.length||selector.selector.opponentHeroes?.length;rows.push({map,side,won:map.radiantWon===(side==='radiant'),availableAt:latest([map.outcomeKnownAt,...needsPlayers?[map.playersKnownAt]:[],...needsHeroes?[map.heroesKnownAt]:[]])});}}return rows;
}
/** One executable selector/statistics/metadata plan. Dense and bounded readers
 * provide only ordered cohort rows; ALL formulas and output templates stay here. */
function* relationalCalculationSteps({historyContext,facts,matchId,decisionAt,minimumSupport,phase,targetBinding,cutoff,scope,roster,audit,eligibleMapCount}){
 const selectors=selectorsFor(roster,scope),support={},supportRows={},supportCache=new Map(),statistics={},performanceStats={},selectorBindings={},tailCohorts=[];
 const registerSupportRows=rows=>{
  const text=rows.map(r=>r.map.matchId+'@'+r.availableAt).join('|');if(supportCache.has(text))return supportCache.get(text);
  const ref='cohort:'+createHash('sha256').update(text).digest('hex');supportCache.set(text,ref);supportRows[ref]={mapIds:rows.map(r=>r.map.matchId),availability:rows.map(r=>({matchId:r.map.matchId,availableAt:r.availableAt})),supportMaps:rows.length,latestHistoryAvailabilityAt:latest(rows.map(r=>r.availableAt))};return ref;
 };
 const names=[],values=[],masks=[],definitions=[],statisticColumns=new WeakMap(),derivedOperands=new WeakMap(),statisticUnits=new Map();
 const statisticReferences=s=>{const direct=statisticColumns.get(s);if(direct)return[direct];return[...new Set((derivedOperands.get(s)??[]).flatMap(statisticReferences))];};
 for(const selector of selectors){
  const rows=yield selector;
  selectorBindings[selector.key]={kind:selector.kind,...selector.selector};
  for(const windowDays of WINDOWS){
   const selected=rows.filter(r=>r.map.ended>=cutoff-BigInt(windowDays)*DAY),ref=selector.key+'.'+windowDays+'d';
   support[ref]={population:scope.populationBasis==='bounded_provided_retained_corpus_not_global'?'provided_retained_response_known_identity_maps':'local_available_parsed_pro_known_identity_maps',scopeEvidenceSha256:historicalRelationalHash(scope.evidence),cohortQualified:selector.qualified,sourceFactsSha256:facts.pin.sha256,selectorRef:selector.key,windowDays,supportMaps:selected.length,sourceRowsRef:registerSupportRows(selected),selectionBasis:'endedAt_within_window_and_all_used_facts_available_at_original_draft_cutoff',rowsAreDistinctMaps:true};
   if(['team','player','hero','player_hero'].includes(selector.kind))tailCohorts.push(collectReviewedDurationTails(selected,{selector,windowDays,cutoff,minimumSupport,supportRef:ref}));
   const stats=calculateStats(selected,{windowDays,minimumSupport,cutoff,qualified:selector.qualified,reason:selector.reason,supportRef:ref,latestKnownAt:supportRows[support[ref].sourceRowsRef].latestHistoryAvailabilityAt});statistics[ref]=stats;
   for(const [metric,s]of Object.entries(stats)){
    const name='histrel.'+ref+'.'+metric;names.push(name);values.push(s.value);masks.push(s.value===null?1:0);statisticColumns.set(s,name);statisticUnits.set(name,s.units);
    definitions.push({name,familyId:familyFor(selector,metric),formulaParameters:{inputClass:'outcome',operator:metric,selector:selector.selector,selectorKind:selector.kind},formula:s.formula,formulaVersion:HISTORICAL_RELATIONAL_FORMULA_VERSION,type:'float64',units:s.units,inputScopes:['prior_completed_maps',...(selector.requiresCurrentDraft?['current_draft']:['current_identity'])],historyWindowDays:windowDays,minimumSupport,supportRef:ref,knownAt:s.latestHistoryAvailabilityAt,selectorRef:selector.key,missingPolicy:'null_and_mask_1; support_zero_is_observed_cohort_not_proof_of_no_games',orientation:'selected_entity_side_then_radiant_minus_dire_for_derived_summaries'});
   }
   if(['team','player','player_hero','player_team','player_team_hero','hero','team_hero'].includes(selector.kind)){
    const computed=performanceStatistics(selector,selected,{windowDays,minimumSupport,qualified:selector.qualified,supportRef:ref,registerSupportRows,supportLatestAt:ref=>supportRows[ref].latestHistoryAvailabilityAt});performanceStats[ref]=computed.statistics;Object.assign(support,computed.supports);
    for(const [metric,s]of Object.entries(computed.statistics)){
     const name='histrel.'+ref+'.past_performance.'+metric;names.push(name);values.push(s.value);masks.push(s.value===null?1:0);statisticColumns.set(s,name);statisticUnits.set(name,s.units);
     definitions.push({name,familyId:/PerGpm/.test(metric)?'H11':'H08',formulaParameters:{inputClass:'performance',operator:metric,selector:selector.selector,selectorKind:selector.kind},formula:s.formula,formulaVersion:HISTORICAL_RELATIONAL_FORMULA_VERSION,type:'float64',units:s.units,inputScopes:['prior_completed_maps',...(selector.requiresCurrentDraft?['current_draft']:['current_identity'])],historyWindowDays:windowDays,minimumSupport,supportRef:s.supportRef,knownAt:s.latestHistoryAvailabilityAt,selectorRef:selector.key,missingPolicy:'native prior-performance missing; never replace with current-game or team-kill proxy'});
    }
   }
  }
 }
 const get=(key,metric,days=90)=>statistics[key+'.'+days+'d'][metric];
 const getPerf=(key,metric,stat='mean',days=90)=>performanceStats[key+'.'+days+'d'][metric+'.'+stat];
 const profiles={players:[],teams:[],heroes:[]};
 const derive=(a,b,operation,definition,units)=>{
  const ok=a.cohortQualified&&b.cohortQualified,value=a.value===null||b.value===null?null:operation(a.value,b.value);
  const result={value:finite(value)&&ok?value:null,supportMaps:Math.min(a.supportMaps,b.supportMaps),effectiveCount:Math.min(a.effectiveCount,b.effectiveCount),cohortQualified:ok,reason:!ok?'component_cohort_unproven':value===null?'component_missing':null,definition,units,windowDays:90,minimumSupport,latestHistoryAvailabilityAt:latest([a.latestHistoryAvailabilityAt,b.latestHistoryAvailabilityAt].filter(Boolean)),supportRef:[a.supportRef,b.supportRef]};derivedOperands.set(result,[a,b]);return result;
 };
 for(const side of SIDE){
  const group=roster.filter(p=>p.side===side),teamStats={};for(const days of WINDOWS)teamStats['formWinFraction'+days+'d']=get(side+'.team','rawWinFraction',days);
  for(const metric of ['meanDurationSeconds','winMeanDurationSeconds','lossMeanDurationSeconds','meanTotalKills','meanOwnKillsPerMinute','late40Fraction'])teamStats[metric+'90d']=get(side+'.team',metric);
  for(const metric of PERFORMANCE_KEYS)for(const days of WINDOWS)teamStats['meanPast_'+metric+days+'d']=getPerf(side+'.team',metric,'mean',days);
  profiles.teams.push({side,teamId:group[0].teamId,values:Object.fromEntries(Object.entries(teamStats).map(([k,s])=>[k,s.value])),statistics:teamStats});
  for(const [i,p]of group.entries()){
   const key=side+'.slot_'+i,ps={},hs={};for(const days of WINDOWS){ps['formWinFraction'+days+'d']=get(key+'.player','rawWinFraction',days);hs['formWinFraction'+days+'d']=get(key+'.hero','rawWinFraction',days);}
   ps.playerHeroWinFraction90d=get(key+'.player_hero','rawWinFraction');
   ps.playerHeroVsSelfWinFraction90d=derive(ps.playerHeroWinFraction90d,ps.formWinFraction90d,(a,b)=>a-b,'aegis.relational.player_hero_minus_player_raw_wr_90d.v1','fraction');
   ps.playerHeroVsHeroPopulationWinFraction90d=derive(ps.playerHeroWinFraction90d,hs.formWinFraction90d,(a,b)=>a-b,'aegis.relational.player_hero_minus_hero_population_raw_wr_90d.v1','fraction');
   for(const [metric,suffix]of [['meanDurationSeconds','MeanDurationSeconds'],['meanTotalKills','MeanTotalKills'],['late40Fraction','Late40Fraction']]){
    for(const [scopeName,entity]of [['player','player'],['playerHero','player_hero'],['hero','hero']])ps[scopeName+suffix+'90d']=get(key+'.'+entity,metric);
    hs[metric+'90d']=get(key+'.hero',metric);
   }
   const a=get(key+'.player_hero','supportMaps'),b=get(key+'.player','supportMaps');
   ps.heroPickShare90d=derive(a,b,(x,y)=>y>=minimumSupport?x/y:null,'aegis.relational.player_hero_count_div_player_count_90d.v1','fraction');
   for(const metric of PERFORMANCE_KEYS){
    const unit=HISTORICAL_PERFORMANCE_METRICS[metric].units,player=getPerf(key+'.player',metric),ph=getPerf(key+'.player_hero',metric),pop=getPerf(key+'.hero',metric),sd=getPerf(key+'.hero',metric,'sampleSd');
    ps['playerMeanPast_'+metric+'90d']=player;ps['playerHeroMeanPast_'+metric+'90d']=ph;ps['heroMeanPast_'+metric+'90d']=pop;hs['meanPast_'+metric+'90d']=pop;
    ps['playerHeroVsSelfPast_'+metric+'90d']=derive(ph,player,(a,b)=>a-b,'aegis.relational.player_hero_minus_player_'+metric+'_90d.v1',unit);
    const delta=derive(ph,pop,(a,b)=>a-b,'aegis.relational.player_hero_minus_hero_population_'+metric+'_90d.v1',unit);ps['playerHeroVsPopulationPast_'+metric+'90d']=delta;
    ps['playerHeroPopulationZPast_'+metric+'90d']=derive(delta,sd,(a,b)=>b>0?a/b:null,'aegis.relational.player_hero_population_z_'+metric+'_90d.v1','standard_deviations');
   }
   profiles.players.push({...p,values:Object.fromEntries(Object.entries(ps).map(([k,s])=>[k,s.value])),statistics:ps});
   profiles.heroes.push({heroId:p.heroId,side,teamId:p.teamId,values:Object.fromEntries(Object.entries(hs).map(([k,s])=>[k,s.value])),statistics:hs});
  }
 }
 // Explicit derived player form/lift and side summaries retain all original axes.
 for(const side of SIDE)for(const [i,p]of profiles.players.filter(p=>p.side===side).entries())for(const key of HISTORICAL_PLAYER_PROFILE_KEYS){
  const s=p.statistics[key],name='histrel.'+side+'.slot_'+i+'.profile.'+key,requiresDraft=key.startsWith('hero')||key.startsWith('playerHero');names.push(name);values.push(s.value);masks.push(s.value===null?1:0);
  definitions.push({name,familyId:playerProfileFamily(key),formulaParameters:{inputClass:'profile',profileOperation:key,sourceStatistics:[{definition:s.definition,units:s.units,emittedReferences:statisticReferences(s),emittedOperandUnits:Object.fromEntries(statisticReferences(s).map(name=>[name,statisticUnits.get(name)]))}]},formula:s.formula??s.definition,formulaVersion:HISTORICAL_RELATIONAL_FORMULA_VERSION,type:'float64',units:s.units,inputScopes:['prior_completed_maps',requiresDraft?'current_draft':'current_identity'],supportRefs:Array.isArray(s.supportRef)?s.supportRef:[s.supportRef],knownAt:s.latestHistoryAvailabilityAt,minimumSupport,historyWindowDays:s.windowDays,missingPolicy:'null and mask for absent or insufficient qualified component'});
 }
 for(const side of SIDE){
  const pp=profiles.players.filter(p=>p.side===side);
  for(const key of HISTORICAL_PLAYER_PROFILE_KEYS){
   const valid=pp.map(p=>p.values[key]).filter(finite),s=pp.map(p=>p.statistics[key]),sourceRefs=[...new Set(s.flatMap(v=>Array.isArray(v.supportRef)?v.supportRef:[v.supportRef]))],knownAt=latest(s.map(v=>v.latestHistoryAvailabilityAt).filter(Boolean));
   for(const [metric,computed]of Object.entries({coverage:valid.length/5,mean:mean(valid),min:valid.length?Math.min(...valid):null,max:valid.length?Math.max(...valid):null,standardDeviation:valid.length?Math.sqrt(valid.reduce((n,x)=>n+(x-mean(valid))**2,0)/valid.length):null})){
    const requiresDraft=key.startsWith('hero')||key.startsWith('playerHero'),value=phase==='PRE'&&requiresDraft?null:computed;
    const name='histrel.'+side+'.player_profile.'+key+'.'+metric;names.push(name);values.push(value);masks.push(value===null?1:0);definitions.push({name,familyId:'H12',formulaParameters:{inputClass:'profile_aggregation',profileOperation:key,aggregation:metric,sourceStatistics:s.map(v=>({definition:v.definition,units:v.units,emittedReferences:statisticReferences(v),emittedOperandUnits:Object.fromEntries(statisticReferences(v).map(name=>[name,statisticUnits.get(name)]))}))},formula:metric==='coverage'?'count(available player profile values)/5':metric+' across known observed-player profiles; not role or latent strength',formulaVersion:HISTORICAL_RELATIONAL_FORMULA_VERSION,type:'float64',units:metric==='coverage'?'fraction':s[0].units,inputScopes:['prior_completed_maps',requiresDraft?'current_draft':'current_identity'],supportRefs:sourceRefs,knownAt,minimumSupport,historyWindowDays:s[0].windowDays,missingPolicy:'null if no qualified values or draft-only scope before draft; missing players reduce coverage'});
   }
  }
 }
 // Definitions carry availability/support per row. The schema hash excludes
 // row-specific references/times; semantic rules and ordered formulas are hashed.
 // Additive versioned S04 block, after the entire pre-existing column prefix.
 // Dense and retained views reach this SAME generator and cohort statistics.
 const draftStyleFits=[];
 for(const side of SIDE){const group=roster.filter(p=>p.side===side).sort(slotCompare),fit=produceCausalDraftStyleFit({side,teamId:group[0]?.teamId??null,heroIds:phase==='PRE'?[]:group.map(p=>p.heroId),teamStatistics:statistics[side+'.team.90d'],heroStatistics:phase==='PRE'?[]:group.map((p,i)=>({heroId:p.heroId,statistics:statistics[side+'.slot_'+i+'.team_hero.90d']})),historyCutoffAt:historyContext.historyCutoffAt,minimumSupport,sourceFormulaVersion:HISTORICAL_RELATIONAL_FORMULA_VERSION,definitionFormulaVersion:HISTORICAL_RELATIONAL_FORMULA_VERSION});
  names.push(...fit.names);values.push(...fit.values);masks.push(...fit.masks);definitions.push(...fit.definitions);draftStyleFits.push({side,operands:fit.operands,reasons:fit.reasons,sourceAvailabilityAttested:false});
 }
 profiles.draftStyleFits=draftStyleFits;
 for(let i=0;i<definitions.length;i++)definitions[i]=bindHistoricalRelationalSemantics(definitions[i],{minimumSupport,selectorBindings,support,performanceDefinitions:HISTORICAL_PERFORMANCE_METRICS,formulaVersion:HISTORICAL_RELATIONAL_FORMULA_VERSION});
 // New reviewed variants append AFTER the entire old/S04 prefix and its exact
 // descriptor binding. No old value,name,formula or ordering is replaced.
 const additions=produceReviewedHistoricalSummaries({phase,profiles,statistics,tailCohorts,profileKeys:HISTORICAL_PLAYER_PROFILE_KEYS,minimumSupport,formulaVersion:HISTORICAL_RELATIONAL_FORMULA_VERSION,historyDefinitionNamespace:names});names.push(...additions.names);values.push(...additions.values);masks.push(...additions.masks);definitions.push(...additions.definitions);
 const events=yield{kind:'r7_all_provided_events'};const chronology=produceChronologicalResultRatings({events,roster,historyCutoffAt:historyContext.historyCutoffAt,minimumSupport,factsPin:facts.pin,populationBasis:scope.populationBasis??'local_sql_selected_corpus_not_global',populationQualified:scope.base,formulaVersion:HISTORICAL_RELATIONAL_FORMULA_VERSION});names.push(...chronology.names);values.push(...chronology.values);masks.push(...chronology.masks);definitions.push(...chronology.definitions);
 const closing=projectClosingLandmarks(historyContext,roster,minimumSupport,HISTORICAL_RELATIONAL_FORMULA_VERSION);for(const feature of closing){names.push(feature.name);values.push(feature.value);masks.push(Number(feature.value===null));definitions.push(feature.definition);}
 const schema=definitions.map(({knownAt,supportRef,supportRefs,selectorRef,...s})=>s),schemaHash=historicalRelationalHash({contract:HISTORICAL_RELATIONAL_CONTRACT,formulaVersion:HISTORICAL_RELATIONAL_FORMULA_VERSION,phase,minimumSupport,windows:WINDOWS,betaPrior:[10,10],performanceContract:PERFORMANCE_CONTRACT,nativeSourceFields:PERFORMANCE_FIELDS,definitions:schema});
 const implemented=[...new Set(definitions.map(d=>d.familyId))].sort(),familyCoverage=implemented.map(familyId=>({familyId,status:'implemented_partial_diagnostic',notWholeFamily:true}));
 const body={contract:HISTORICAL_RELATIONAL_CONTRACT,status:'diagnostic_produced',formulaVersion:HISTORICAL_RELATIONAL_FORMULA_VERSION,phase,matchId,decisionAt,historyCutoffAt:historyContext.historyCutoffAt,validFrom:historyContext.validFrom,availabilityBasis:historyContext.availabilityBasis,originalHistoryContentHash:historyContext.contentHash??null,prematchTargetBinding:targetBinding,factsSha256:facts.pin.sha256,draftIdentityRevision:historyContext.draftState?.revision??null,names,values,masks,definitions,schemaHash,support,supportRows,selectorBindings,profiles,familyCoverage,pendingFamilies:HISTORICAL_RELATIONAL_PENDING_FAMILIES,audit:{...audit,eligiblePriorMaps:eligibleMapCount,selectors:selectors.length,featureCount:names.length,knownValues:values.filter(finite).length,supportCohortCount:Object.keys(supportRows).length,chronologicalResultReference:chronology.audit,rawSourceReceiptAuthenticatedByThisModule:false,currentMapExcluded:true,roleInference:false,learnedState:null,zeroProviderCalls:true},eligibleForTraining:false,eligibleForServing:false,recordedPrediction:false};
 return{...body,contentHash:historicalRelationalHash(body)};
}

/** Bounded retained view executes the SAME generator/selector/statistic templates
 * as the v1 oracle. One compact cohort is retained at a time, never the complete
 * normalized source. Quantiles and weighted arithmetic preserve numeric map order.
 * The caller owns the returned component until its nonenumerable release(). */
export async function produceHistoricalRelationalFeaturesFromRetainedMapView({historyContext,historyView,matchId,decisionAt,minimumSupport=5,resourceArena=null,shouldContinue=()=>true}={}){
 if(!Number.isSafeInteger(minimumSupport)||minimumSupport<3||minimumSupport>1000)throw Error('relational_minimum_support_3_to_1000');const checked=validateObservedDraftHistory(historyContext,{matchId,decisionAt});if(!checked.accepted)throw Error('relational_context:'+checked.reason);
 return calculateRelationalFromMapReader({historyContext,historyView,matchId,decisionAt,minimumSupport,resourceArena,shouldContinue});
}
export async function produceStaticHistoricalRelationalFeaturesFromRetainedMapView({mode,targetInput,historyView,decisionAt,minimumSupport=5,resourceArena=null,shouldContinue=()=>true}={}){
 if(!['PRE','SERIES_PRE','BETWEEN'].includes(mode)||!Number.isSafeInteger(minimumSupport)||minimumSupport<3||minimumSupport>1000)throw Error('relational_static_mode_or_support');const parsed=mode==='PRE'?readPrematchHistoryTargetInput({targetInput,decisionAt}):readSeriesHistoryTargetInput({targetInput,decisionAt});if(mode!=='PRE'&&parsed.target.phase!==(mode==='BETWEEN'?'SERIES_BETWEEN':'SERIES_PRE'))throw Error('relational_static_target_phase');
 const view=readRetainedReferenceStaticMapView(historyView,{mode,decisionAt}),d=view.descriptor;if(d.identity.targetSha256!==targetInput.pin.sha256||d.identity.matchId!==(parsed.target.matchId??null)||d.identity.seriesId!==(parsed.target.seriesId??view.descriptor.identity.seriesId)||d.historyCutoffAt!==parsed.historyCutoffAt||d.validFrom!==parsed.validFrom)throw Error('relational_static_view_target_binding');
 const context={historyCutoffAt:parsed.historyCutoffAt,validFrom:parsed.validFrom,computedAt:decisionAt,availabilityBasis:mode==='PRE'?'host_declared_prematch_receipt_not_authenticated':'host_declared_series_identity_receipt_not_authenticated',identityPlayers:parsed.players,producer:{bindings:{facts:d.factsPin}}},b=await calculateRelationalFromMapReader({historyContext:context,historyView,matchId:parsed.target.matchId??null,decisionAt,minimumSupport,resourceArena,shouldContinue,staticTarget:{mode,parsed,targetInput}});
 if(mode==='PRE')return b;try{const out=orientSeriesRelationalComponent(b,parsed,targetInput);Object.defineProperty(out,'release',{enumerable:false,value:()=>b.release()});return out;}catch(error){b.release();throw error;}
}
async function calculateRelationalFromMapReader({historyContext,historyView,matchId,decisionAt,minimumSupport,resourceArena,shouldContinue,staticTarget=null}){
 const iterate=staticTarget?iterateRetainedReferenceStaticMapView:iterateRetainedReferenceHistoryMapView,phase=staticTarget?'PRE':'POST_OR_LIVE',targetBinding=staticTarget?.parsed.targetBinding??null;
 const options={matchId,decisionAt},view=staticTarget?readRetainedReferenceStaticMapView(historyView,options):readRetainedReferenceHistoryMapView(historyView,options),d=view.descriptor,binding=historyContext.producer?.bindings?.facts,state=historyContext.draftState;
 if(binding?.sha256!==d.factsSha256||binding.bytes!==d.factsPin.bytes||historyContext.historyCutoffAt!==d.historyCutoffAt||historyContext.validFrom!==d.validFrom||!staticTarget&&(state.revision!==d.identity.revision||state.identity.draftHash!==d.identity.draftHash||state.identity.rosterHash!==d.identity.rosterHash||state.identity.sideIdentityHash!==d.identity.sideIdentityHash))throw Error('relational_map_view_context_binding');
 const arena=resourceArena??createDiagnosticResourceArena(),outputLease=arena.reserve(512*1024*1024);if(!outputLease)throw Error('relational_map_view_output_memory_reservation');let reader=null;
 try{
  reader=await createProofScopedMapReader({iterate:()=>iterate(historyView,options),readEpoch:()=>readActualPrivateViewWriterEpoch(historyView),resourceArena:arena,shouldContinue});
  const cutoff=instantNs(d.historyCutoffAt),scope={base:true,accounts:new Set(),teams:new Set(),heroes:new Set(),evidence:d.scope,populationBasis:'bounded_provided_retained_corpus_not_global',globalPopulationComplete:false},facts={pin:d.factsPin},roster=(staticTarget?staticTarget.parsed.players:state.identity.players).map(p=>({...p,heroId:p.heroId===null?null:Number(p.heroId)})).sort((a,b)=>SIDE.indexOf(a.side)-SIDE.indexOf(b.side)||slotCompare(a,b));
  const audit={inputMaps:d.rowCount,futureOutcomeExcluded:0,olderThan90DaysExcluded:0,unavailableHeroRosters:0,unavailablePlayerRosters:0,unavailablePerformanceRows:0,minimumSupport,scopeQualified:true,populationBasis:scope.populationBasis,globalPopulationComplete:false};let eligibleMapCount=0;
  for await(const raw of reader.iterate()){
   const outcome=instantNs(raw.outcomeKnownAt);if(outcome!==null&&outcome<=cutoff){for(const t of [raw.radiantTeamId,raw.direTeamId].filter(id))scope.teams.add(t);const playersAt=instantNs(raw.playersKnownAt),heroesAt=instantNs(raw.heroesKnownAt??raw.playersKnownAt);if(playersAt!==null&&playersAt<=cutoff)for(const p of raw.players??[])if(account(p.accountId))scope.accounts.add(p.accountId);if(heroesAt!==null&&heroesAt<=cutoff)for(const p of raw.heroes??raw.players??[])if(hero(Number(p.heroId)))scope.heroes.add(Number(p.heroId));}
   eligibleMapCount+=readMaps({rows:[raw]},cutoff,matchId,audit).length;
  }
  const steps=relationalCalculationSteps({historyContext,facts,matchId,decisionAt,minimumSupport,phase,targetBinding,cutoff,scope,roster,audit,eligibleMapCount});let step=steps.next();
  while(!step.done){const selector=step.value,rows=[],cohortLease=arena.reserve(64*1024*1024*6+65536);if(!cohortLease)throw Error('relational_map_view_cohort_memory_reservation');
   try{let rowBytes=0;if(selector.kind==='r7_all_provided_events'){for await(const raw of reader.iterate())for(const map of readMaps({rows:[raw]},cutoff,matchId,chronologyAudit(scope),{allProvidedHistory:true})){const e=compactChronologicalEvent(map);rowBytes+=measureBoundedJsonBytes(e,{maxBytes:64*1024*1024});if(rowBytes>64*1024*1024)throw Error('relational_chronology_scalar_bound');rows.push(e);}step=steps.next(rows);continue;}if(selector.qualified)for await(const raw of reader.iterate())for(const map of readMaps({rows:[raw]},cutoff,matchId,{populationBasis:scope.populationBasis,futureOutcomeExcluded:0,olderThan90DaysExcluded:0,unavailableHeroRosters:0,unavailablePlayerRosters:0,unavailablePerformanceRows:0}))for(const row of rowsForSelector(selector,[map])){
    const compactPerformance=['team','player','player_hero','player_team','player_team_hero','hero','team_hero'].includes(selector.kind)?compactPerformanceCandidate(selector,row):null,small={map:{matchId:map.matchId,ended:map.ended,durationSeconds:map.durationSeconds,kills:map.kills},side:row.side,won:row.won,availableAt:row.availableAt,compactPerformance};
    rowBytes+=measureBoundedJsonBytes({...small,map:{...small.map,ended:String(map.ended)}},{maxBytes:64*1024*1024});if(rowBytes>64*1024*1024)throw Error('relational_map_view_cohort_scalar_bound');rows.push(small);
   }
   rows.sort((a,b)=>byId(a.map,b.map));step=steps.next(rows);
   }finally{cohortLease.release();}
  }
  await reader.verifyFinal();Object.defineProperty(step.value,'mapReaderAudit',{enumerable:false,value:reader.status()});let active=true;Object.defineProperty(step.value,'release',{enumerable:false,value(){if(!active)return false;active=false;outputLease.release();return true;}});return step.value;
 }catch(error){outputLease.release();throw error;}finally{reader?.release();}
}

/** Semantic integrity only. Authenticity must be established by actual upstream replay. */
export function validateHistoricalRelationalFeatures(component,{matchId,decisionAt,historyContext=null}={}){
 const reject=reason=>({accepted:false,reason});
 if(!obj(component)||component.contract!==HISTORICAL_RELATIONAL_CONTRACT||component.matchId!==matchId||component.eligibleForTraining!==false||component.eligibleForServing!==false||component.recordedPrediction!==false)return reject('relational_component_contract');
 const {contentHash,...body}=component;if(!sha(contentHash)||historicalRelationalHash(body)!==contentHash)return reject('relational_component_hash');
 const decision=instantNs(decisionAt),computed=instantNs(component.decisionAt),valid=instantNs(component.validFrom),cutoff=instantNs(component.historyCutoffAt);
 if(decision===null||computed===null||valid===null||cutoff===null||computed>decision||valid>computed||cutoff>valid)return reject('relational_component_times');
 if(historyContext&&(component.originalHistoryContentHash!==historyContext.contentHash||component.factsSha256!==historyContext.producer?.bindings?.facts?.sha256||component.historyCutoffAt!==historyContext.historyCutoffAt))return reject('relational_component_context_binding');
 if(!Array.isArray(component.names)||component.names.length>100000||new Set(component.names).size!==component.names.length||component.values?.length!==component.names.length||component.masks?.length!==component.names.length||component.definitions?.length!==component.names.length||component.names.some((n,i)=>component.definitions[i]?.name!==n||component.values[i]!==null&&!finite(component.values[i])||component.masks[i]!==Number(component.values[i]===null)))return reject('relational_component_vector');
 if(!['PRE','POST_OR_LIVE'].includes(component.phase)||component.formulaVersion!==HISTORICAL_RELATIONAL_FORMULA_VERSION||!Number.isSafeInteger(component.audit?.minimumSupport)||component.audit.minimumSupport<3||component.audit.minimumSupport>1000)return reject('relational_component_semantic_version');
 if(component.definitions.some((d,i)=>!d.familyId||!d.formula||!d.units||d.formulaVersion!==component.formulaVersion||!Array.isArray(d.inputScopes)||d.knownAt!==null&&(instantNs(d.knownAt)===null||instantNs(d.knownAt)>cutoff)||component.phase==='PRE'&&d.inputScopes.includes('current_draft')&&component.values[i]!==null))return reject('relational_component_descriptor_or_future');
 const schema=component.definitions.map(({knownAt,supportRef,supportRefs,selectorRef,...s})=>s),schemaHash=historicalRelationalHash({contract:HISTORICAL_RELATIONAL_CONTRACT,formulaVersion:HISTORICAL_RELATIONAL_FORMULA_VERSION,phase:component.phase,minimumSupport:component.audit.minimumSupport,windows:WINDOWS,betaPrior:[10,10],performanceContract:PERFORMANCE_CONTRACT,nativeSourceFields:PERFORMANCE_FIELDS,definitions:schema});
 if(schemaHash!==component.schemaHash)return reject('relational_component_schema_hash');
 return{accepted:true,reason:'semantic_integrity_not_receipt_authentication',component};
}

/** Preparation-only raw view of the SAME aggregate algebra. The caller owns
 * population/patch/role/identity qualification; this cannot authorize a source.
 * No existing generator schema/formula/window changes. Legacy smoothed/decayed
 * side calculations are not returned, weighted or admitted into this raw port. */
export function collectRetainedRawMetaOutcome(rows,{windowDays,minimumSupport,cutoff,qualified,supportRef}={}){
 if(!Array.isArray(rows)||rows.length>20000||![7,14,30].includes(windowDays)||!Number.isSafeInteger(minimumSupport)||minimumSupport<3||minimumSupport>1000||typeof cutoff!=='bigint'||typeof qualified!=='boolean'||typeof supportRef!=='string'||supportRef.length>256)throw Error('retained_raw_meta:configuration');
 const seen=new Set();for(const row of rows){const m=row?.map;if(!m||typeof m.matchId!=='string'||seen.has(m.matchId)||typeof m.ended!=='bigint'||m.ended>=cutoff||m.ended<cutoff-BigInt(windowDays)*DAY||typeof row.won!=='boolean'||!SIDE.includes(row.side)||!finite(m.durationSeconds)||m.durationSeconds<=0||!m.kills||instantNs(row.availableAt)===null||instantNs(row.availableAt)>cutoff)throw Error('retained_raw_meta:unqualified_row');seen.add(m.matchId);}
 const at=latest(rows.map(r=>r.availableAt)),stats=calculateStats(rows,{windowDays,minimumSupport,cutoff,qualified,reason:'explicit_population_port_unqualified',supportRef,latestKnownAt:at});
 return {contract:'aegis.retained-raw-population-meta-outcome.v1',supportMaps:stats.supportMaps.value,rawWinFraction:stats.rawWinFraction.value,reason:stats.rawWinFraction.reason,latestHistoryAvailabilityAt:stats.rawWinFraction.latestHistoryAvailabilityAt,minimumSupport,windowDays,qualified,sourceAggregate:HISTORICAL_RELATIONAL_FORMULA_VERSION,sourceMetric:'rawWinFraction',weightPolicy:'unweighted_distinct_prior_maps',defaultDecayApplied:false,learnedSmoothingApplied:false,eligibleForTraining:false,eligibleForServing:false,recordedPrediction:false};
}
