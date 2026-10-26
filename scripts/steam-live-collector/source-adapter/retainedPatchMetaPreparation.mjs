/** Bounded retained-data preparation of separate population/patch meta. Reuses
 * the existing relational raw outcome aggregate; never a second live generator.
 * No provider, fit, learned prior, default decay, source or model activation. */
import {createHash} from 'node:crypto';
import {readPinnedHistoricalJson} from './historicalAlignment.mjs';
import {qualifyRetainedHistoryCorpus} from './historyCalculationCore.mjs';
import {collectRetainedRawMetaOutcome} from './historicalRelationalFeatures.mjs';
import {instantNs} from './causalTime.mjs';
import {canonical} from '../../feature-registry/registry-contract.mjs';
import {snapshotPlainRecord} from './diagnosticResourceArena.mjs';
export const RETAINED_PATCH_META_PREPARATION_CONTRACT='aegis.retained-patch-population-meta-preparation.v1';
const DAY=86400n*1000000000n,HASH=/^[a-f0-9]{64}$/,REV=/^\d{1,2}\.\d{2}[a-z]?$/,ID=/^[1-9]\d{0,19}$/,POP=['professional','historical_high_rank'],flags={eligibleForTraining:false,eligibleForServing:false,recordedPrediction:false,providerCalls:0,trainingRuns:0};
const fail=s=>{throw Error('retained_patch_meta:'+s);},sha=x=>createHash('sha256').update(x).digest('hex'),finite=x=>typeof x==='number'&&Number.isFinite(x),obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const validAt=(x,cutoff)=>instantNs(x)!==null&&instantNs(x)<=cutoff;
function selectorsOf(raw){
 if(!Array.isArray(raw)||raw.length<1||raw.length>128)fail('selector_bound');const ids=new Set();return raw.map(value=>{const q=snapshotPlainRecord(value,{maxKeys:9});if(Object.keys(q).some(k=>!['id','kind','heroIds','opponentHeroId','accountId','side','position','gameMode','region'].includes(k)))fail('selector_keys');
  if(!obj(q)||typeof q.id!=='string'||!/^[-a-zA-Z0-9_.]{1,96}$/.test(q.id)||ids.has(q.id)||!['hero','hero_pair','hero_matchup','player_hero'].includes(q.kind))fail('selector_identity');ids.add(q.id);
  if(!Array.isArray(q.heroIds)||q.heroIds.length!==(q.kind==='hero_pair'?2:1)||q.heroIds.some(h=>!Number.isSafeInteger(h)||h<1||h>250)||new Set(q.heroIds).size!==q.heroIds.length)fail('selector_heroes');
  if(q.kind==='hero_matchup'&&(!Number.isSafeInteger(q.opponentHeroId)||q.opponentHeroId<1||q.opponentHeroId>250||q.heroIds.includes(q.opponentHeroId)))fail('selector_matchup');
  if(q.kind==='player_hero'&&(!ID.test(q.accountId??'')||BigInt(q.accountId)>=4294967295n))fail('selector_account');
  const side=q.side??null,position=q.position??null,gameMode=q.gameMode??null,region=q.region??null;if(side!==null&&!['radiant','dire'].includes(side)||position!==null&&(!Number.isInteger(position)||position<1||position>5)||gameMode!==null&&(!Number.isSafeInteger(gameMode)||gameMode<1||gameMode>100)||region!==null&&(!Number.isSafeInteger(region)||region<1||region>1000))fail('selector_context');
  if(position!==null&&q.kind==='hero_pair')fail('pair_position_ambiguous');return{...q,heroIds:[...q.heroIds].sort((a,b)=>a-b),side,position,gameMode,region};
 });
}
function patchOf(p,cutoff){
 if(!obj(p)||!['observed','calendar_inferred'].includes(p.status)||!REV.test(p.revision??'')||!validAt(p.knownAt,cutoff)||instantNs(p.releasedAt)===null||instantNs(p.releasedAt)>cutoff||typeof p.evidenceRef!=='string'||!p.evidenceRef.length||p.boundaryUncertain!==false)return null;
 return{revision:p.revision,status:p.status,releasedAt:p.releasedAt,knownAt:p.knownAt,evidenceRef:p.evidenceRef};
}
function populationOf(e,map,cutoff){
 const p=e?.population;if(!obj(p)||!POP.includes(p.kind)||!validAt(p.knownAt,cutoff)||typeof p.evidenceRef!=='string'||!p.evidenceRef.length||p.sourceKind!==(p.kind==='professional'?'retained_professional_match_membership':'retained_contemporaneous_match_rank'))return null;
 if(p.kind==='historical_high_rank'){
  const started=map.ended-BigInt(Math.round(map.durationSeconds*1e9));
  if(p.rankAtMatchClass!=='immortal'||p.rankBasis!=='match_rank_snapshot'||instantNs(p.rankEffectiveAt)!==started)return null;
 }
 return p;
}
function completeDraft(map){return map.heroes.length===10&&['radiant','dire'].every(s=>map.heroes.filter(h=>h.side===s).length===5);}
function rowsFor(query,cohort,cutoff){
 const rows=[],drafts=[],bans=[];let unknownRoles=0,unknownBanReceipts=0,unknownPlayerRosters=0;
 for(const m of cohort){const e=m.meta;if(query.side!==null&&query.kind==='player_hero'&&!m.players.some(p=>p.accountId===query.accountId&&p.side===query.side))continue;
  if((query.gameMode!==null||query.region!==null)&&!validAt(e.gameContextKnownAt,cutoff))continue;if(query.gameMode!==null&&e.gameMode!==query.gameMode||query.region!==null&&e.region!==query.region)continue;
  if(!completeDraft(m))continue;
  let memberSide=null;if(query.kind==='player_hero'){if(m.players.length!==10){unknownPlayerRosters++;continue;}const p=m.players.find(p=>p.accountId===query.accountId);if(!p)continue;memberSide=p.side;}
  const roles=Array.isArray(e.positions)&&e.positions.length<=10?e.positions:[],roleFor=h=>roles.find(r=>r.heroId===h.heroId&&r.side===h.side&&r.kind==='explicit_player_position'&&Number.isInteger(r.position)&&r.position>=1&&r.position<=5&&validAt(r.knownAt,cutoff));
  if(query.position!==null&&m.heroes.some(h=>!roleFor(h))){unknownRoles++;continue;}
  drafts.push(m);
  const ban=e.bans;if(query.side===null&&query.position===null&&query.kind==='hero'&&obj(ban)&&ban.complete===true&&ban.sourceKind==='retained_complete_ban_event_list'&&validAt(ban.knownAt,cutoff)&&Array.isArray(ban.heroIds)&&ban.heroIds.length<=64&&ban.heroIds.every(h=>Number.isSafeInteger(h)&&h>=1&&h<=250)&&new Set(ban.heroIds).size===ban.heroIds.length&&!ban.heroIds.some(h=>m.heroes.some(p=>p.heroId===h)))bans.push({map:m,present:ban.heroIds.includes(query.heroIds[0]),knownAt:ban.knownAt});else unknownBanReceipts++;
  const matched=['radiant','dire'].filter(s=>(query.side===null||query.side===s)&&(memberSide===null||memberSide===s)&&query.heroIds.every(h=>m.heroes.some(p=>p.side===s&&p.heroId===h))&&(query.kind!=='hero_matchup'||m.heroes.some(p=>p.side!==s&&p.heroId===query.opponentHeroId))&&(query.kind!=='player_hero'||m.players.some(p=>p.side===s&&p.accountId===query.accountId&&p.heroId===query.heroIds[0]))&&(query.position===null||roleFor(m.heroes.find(h=>h.side===s&&h.heroId===query.heroIds[0]))?.position===query.position));
  if(matched.length>1)fail('multiple_query_orientations');if(matched.length){const side=matched[0],times=[m.outcomeKnownAt,m.heroesKnownAt,e.population.knownAt,...(m.patch?[m.patch.knownAt]:[]),...(query.kind==='player_hero'?[m.playersKnownAt]:[]),...((query.gameMode!==null||query.region!==null)?[e.gameContextKnownAt]:[]),...(query.position!==null?roles.map(r=>r.knownAt):[])],availableAt=times.reduce((a,b)=>instantNs(a)>instantNs(b)?a:b);rows.push({map:m,side,won:m.radiantWon===(side==='radiant'),availableAt});}
 }
 return{rows,drafts,bans,unknownRoles,unknownBanReceipts,unknownPlayerRosters};
}
/** factsInput must be produced by existing retained version/asof selection.
 * auxiliaryInput is an independently host-pinned receipt-index contract; its
 * claims remain local evidence, not independent provider authentication. */
export function prepareRetainedPatchPopulationMeta({factsInput,auxiliaryInput=null,expectedAuxiliarySha256=null,targetMapId,historyCutoffAt,targetPatchInput=null,expectedTargetPatchSha256=null,historyCoverageStartAt=null,selectors,minimumSupport=5}={}){
 const cutoff=instantNs(historyCutoffAt);if(cutoff===null||!ID.test(targetMapId??'')||!Number.isSafeInteger(minimumSupport)||minimumSupport<3||minimumSupport>1000)fail('configuration');const queries=selectorsOf(selectors),facts=readPinnedHistoricalJson(factsInput,{maxBytes:64*1024**2});if(facts.data.contract!=='aegis.prior-map-facts.v1'||facts.data.maps?.length>20000||!qualifyRetainedHistoryCorpus(facts.data,cutoff).verified)fail('retained_fact_population_required');
 let aux=null;if(auxiliaryInput!==null){const a=readPinnedHistoricalJson(auxiliaryInput,{maxBytes:16*1024**2});if(!HASH.test(expectedAuxiliarySha256??'')||a.pin.sha256!==expectedAuxiliarySha256||a.data.contract!=='aegis.retained-meta-population-evidence.v1'||a.data.factsSha256!==facts.pin.sha256||!Array.isArray(a.data.maps)||a.data.maps.length>20000||!Array.isArray(a.data.populationPorts)||a.data.populationPorts.length>2||new Set(a.data.populationPorts.map(p=>p.kind)).size!==a.data.populationPorts.length||a.data.populationPorts.some(p=>!POP.includes(p.kind)||p.selection!=='provided_retained_maps_only'||p.qualified!==true||!validAt(p.knownAt,cutoff)||typeof p.evidenceRef!=='string'||!p.evidenceRef.length))fail('host_pinned_population_evidence');aux=a;}
 const byId=new Map();for(const m of aux?.data.maps??[]){if(!ID.test(m?.matchId??'')||byId.has(m.matchId))fail('duplicate_population_identity');byId.set(m.matchId,m);}
 let targetPatch=null;if(targetPatchInput!==null){const p=readPinnedHistoricalJson(targetPatchInput,{maxBytes:65536});if(!HASH.test(expectedTargetPatchSha256??'')||p.pin.sha256!==expectedTargetPatchSha256||p.data.contract!=='aegis.retained-target-patch-evidence.v1')fail('host_pinned_target_patch');targetPatch=patchOf(p.data,cutoff);}
 const audit={targetMapsExcluded:0,futureOrInvalidFacts:0,populationUnknown:0,historicalRankUnqualified:0,patchUnknownOrAmbiguous:0,eligibleMaps:0};const maps=[],seen=new Set();
 for(const m of facts.data.maps){if(!ID.test(m?.matchId??'')||seen.has(m.matchId))fail('duplicate_fact_identity');seen.add(m.matchId);if(m.matchId===targetMapId){audit.targetMapsExcluded++;continue;}const ended=instantNs(m.endedAt),known=instantNs(m.outcomeKnownAt);if(ended===null||known===null||ended>=cutoff||known>cutoff||known<ended||typeof m.radiantWon!=='boolean'||!finite(m.durationSeconds)||m.durationSeconds<=0||m.durationSeconds>86400||!validAt(m.heroesKnownAt,cutoff)||!Array.isArray(m.heroes)||m.heroes.length>10||new Set(m.heroes.map(h=>h.heroId)).size!==m.heroes.length||m.heroes.some(h=>!Number.isInteger(h.heroId)||h.heroId<1||h.heroId>250||!['radiant','dire'].includes(h.side))){audit.futureOrInvalidFacts++;continue;}
  const meta=byId.get(m.matchId),map={...m,ended,kills:{radiant:Number.isSafeInteger(m.radiantKills)?m.radiantKills:null,dire:Number.isSafeInteger(m.direKills)?m.direKills:null},players:validAt(m.playersKnownAt,cutoff)&&Array.isArray(m.players)?m.players:[]},population=populationOf(meta,map,cutoff);if(!population){audit.populationUnknown++;if(meta?.population?.kind==='historical_high_rank')audit.historicalRankUnqualified++;continue;}const patch=patchOf(meta.patch,cutoff);if(patch&&instantNs(patch.releasedAt)>ended-BigInt(Math.round(m.durationSeconds*1e9)))fail('patch_release_after_match_start');if(!patch)audit.patchUnknownOrAmbiguous++;maps.push({...map,meta:{...meta,population},population:population.kind,patch});audit.eligibleMaps++;
 }
 const results=[],coverage=instantNs(historyCoverageStartAt);if(historyCoverageStartAt!==null&&(coverage===null||coverage>cutoff))fail('history_coverage_calendar');for(const population of POP)for(const windowDays of [7,14,30])for(const patchMode of ['all_revisions','same_letter_revision']){
  const portQualified=(aux?.data.populationPorts??[]).some(p=>p.kind===population)&&maps.some(m=>m.population===population),populationWindow=maps.filter(m=>m.population===population&&m.ended>=cutoff-BigInt(windowDays)*DAY),unknownPatchMaps=populationWindow.filter(m=>!m.patch).length,patchQualified=patchMode==='all_revisions'||targetPatch!==null&&!(populationWindow.length>0&&unknownPatchMaps===populationWindow.length),cohort=populationWindow.filter(m=>patchMode==='all_revisions'||m.patch?.revision===targetPatch?.revision),warmupComplete=coverage!==null&&coverage<=cutoff-BigInt(windowDays)*DAY;
  for(const query of queries){const selected=rowsFor(query,cohort,cutoff),drafts=selected.drafts.length,roleQualified=!(query.position!==null&&drafts===0&&selected.unknownRoles>0),playerQualified=!(query.kind==='player_hero'&&drafts===0&&selected.unknownPlayerRosters>0),qualified=portQualified&&patchQualified&&roleQualified&&playerQualified,supportRef=sha(canonical({population,windowDays,patchMode,revision:patchMode==='same_letter_revision'?targetPatch?.revision??null:null,query,mapIds:selected.rows.map(r=>r.map.matchId).sort()})),raw=collectRetainedRawMetaOutcome(selected.rows,{windowDays,minimumSupport,cutoff,qualified,supportRef}),banCount=selected.bans.length;
   results.push({selector:query,population,windowDays,patchMode,revision:patchMode==='same_letter_revision'?targetPatch?.revision??null:null,qualified,missingReason:!portQualified?'population_port_unqualified':!patchQualified?'target_or_cohort_letter_revision_unknown_or_ambiguous':!roleQualified?'historical_positions_unqualified':!playerQualified?'historical_player_rosters_unqualified':null,supportMaps:raw.supportMaps,rawWinFraction:raw.rawWinFraction,rawWinFractionReason:raw.reason,pickDenominatorMaps:qualified?drafts:null,pickRate:qualified&&drafts>=minimumSupport?selected.rows.length/drafts:null,banDenominatorMaps:qualified&&query.kind==='hero'&&query.side===null&&query.position===null?banCount:null,banRate:qualified&&query.kind==='hero'&&query.side===null&&query.position===null&&banCount>=minimumSupport?selected.bans.filter(b=>b.present).length/banCount:null,unknownRoleMaps:selected.unknownRoles,unknownPlayerRosterMaps:selected.unknownPlayerRosters,unknownPatchMaps,unknownBanReceiptMaps:selected.unknownBanReceipts,warmupCalendarCompleteWithinDeclaredSource:warmupComplete,fieldCompletenessProven:false,historyCoverageStartAt,supportRef,latestHistoryAvailabilityAt:raw.latestHistoryAvailabilityAt,sourceAggregate:raw.sourceAggregate,weightPolicy:raw.weightPolicy});
  }
 }
 const out={contract:RETAINED_PATCH_META_PREPARATION_CONTRACT,targetMapId,historyCutoffAt,targetPatch,patchAgeDays:targetPatch?Number(cutoff-instantNs(targetPatch.releasedAt))/Number(DAY):null,sourcePins:{facts:facts.pin.sha256,auxiliary:aux?.pin.sha256??null,targetPatch:targetPatchInput?.pin.sha256??null},sourcePopulation:'provided_retained_maps_only',globalPopulationComplete:false,currentAndOlderRevisionSupportKeptSeparate:true,sourceAuthenticationIndependentlyAttested:false,defaultDecayApplied:false,learnedSmoothingApplied:false,pubProBlendApplied:false,rawPublicOutcomesAddedToProTargets:false,provenance:{basis:'retained_receipt_reconstruction',originalHistoricalAvailabilityProven:false,originallyIssuedPrediction:false},audit,results,...flags};if(Buffer.byteLength(canonical(out))>16*1024**2)fail('report_bound');return freeze(out);
}
