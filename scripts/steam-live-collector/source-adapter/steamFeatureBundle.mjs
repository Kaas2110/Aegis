/** One coherent Steam observation -> one versioned diagnostic feature vector.
 * Archive replay and DB readers call this exact function. No model or network IO.
 */
import {createHash} from 'node:crypto';
import {advanceRoshanFeatures,FEATURE_CONTRACT} from './roshanFeatures.mjs';
import {projectPlayerHeroEconomy,featureNames,CONTRACT as ECONOMY_CONTRACT} from './playerHeroEconomyFeatures.mjs';
import {readSteamProgressionProof} from './steamProgressionAdmission.mjs';
import {steamObservationIdentity} from './steamObservationIdentity.mjs';
import {readSteamReceiptFreshness} from './steamPhasePolicy.mjs';
export const BUNDLE_CONTRACT='aegis.steam-coherent-feature-bundle.v3';
export const PROGRESSING_BUNDLE_CONTRACT='aegis.steam-coherent-feature-bundle.v4';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const clock=o=>o?.providerGameClockSeconds?.missing===false?o.providerGameClockSeconds.value:null;
const EXPECTED_ECONOMY_ERRORS=new Set(['complete_coherent_economy_snapshot_required','hero_dictionary_revision_required']);
/** The history state is private to one map/profile. It contains only preceding
 * source observations, never labels. Static history uses the explicit frozen v2
 * context; unproven history is missing, not an invented player-strength value.
 */
export function advanceSteamFeatureBundle(previous,observation,{patch=null,rules=null,events=[],historicalContext=null,progressionProof=null,decisionAt=observation?.source?.capture?.receivedAt}={}){
 const freshness=readSteamReceiptFreshness(observation,{decisionAt});if(!freshness.accepted)throw Error(freshness.reason);
 let admission=null;
 if(progressionProof!==null){admission=readSteamProgressionProof(progressionProof,{matchId:observation?.matchId,observationId:observation?.observationId,rawSha256:observation?.source?.capture?.rawSha256,sourceProfile:observation?.dynamic?.sourceProfile,identityHash:steamObservationIdentity(observation).key,decisionAt,observation});if(!admission.accepted)throw Error(admission.reason);}
 const admissionProfile=admission?.admissionProfile??null,continuityId=admission?.provenance?.continuityId??null,bundleContract=admission?PROGRESSING_BUNDLE_CONTRACT:BUNDLE_CONTRACT;
 if(previous!==null&&previous!==undefined&&(![BUNDLE_CONTRACT,PROGRESSING_BUNDLE_CONTRACT].includes(previous.contract)||!Array.isArray(previous.history)||previous.history.length>2048))throw Error('steam_feature_bundle_state');
 const admissionChanged=previous!=null&&(previous.admissionProfile??null)!==admissionProfile;
 const continuityChanged=previous!=null&&(previous.continuityId??null)!==continuityId;
 if(admissionChanged||continuityChanged)previous=null;
 const roshan=advanceRoshanFeatures(previous?.roshanState??null,observation,{patch,rules,events,historicalContext});
 const reset=roshan.resetReasons.length>0;
 const history=reset?[]:(previous?.history??[]);
 let economy=null,economyReason=null;
 try{economy=projectPlayerHeroEconomy(observation,{staticContext:historicalContext,history,progressionProof,decisionAt});}
 catch(error){if(!EXPECTED_ECONOMY_ERRORS.has(error.message))throw error;economyReason=error.message;}
 const names=[],values=[];
 for(const name of Object.keys(roshan.features).sort()){
  names.push('roshan.'+name,'roshan.'+name+'__missing');
  values.push(roshan.features[name],roshan.missing[name]?1:0);
 }
 const economyNames=economy?.featureNames??featureNames();
 names.push(...economyNames);
 values.push(...(economy?.values??economyNames.map(name=>name.endsWith('__missing')?1:null)));
 if(names.length!==new Set(names).size||names.length!==values.length||values.some(v=>v!==null&&(typeof v!=='number'||!Number.isFinite(v))))throw Error('steam_feature_bundle_schema');
 const currentClock=clock(observation);
 let nextHistory=history.filter(o=>clock(o)!==null&&clock(o)>=currentClock-630&&o.observationId!==observation.observationId);
 if(economy)nextHistory.push(observation);
 if(nextHistory.length>2048)throw Error('steam_feature_bundle_history_bound');
 const state={contract:bundleContract,admissionProfile,continuityId,roshanState:roshan.state,history:nextHistory};
 return {contract:bundleContract,admissionProfile,admissionProvenance:admission?.provenance??null,matchId:observation.matchId,observationId:observation.observationId,
  sourceProfile:roshan.sourceProfile,knownAt:roshan.knownAt,eventClockSeconds:roshan.gameClockSeconds,
  sourceInputHash:roshan.sourceInputHash,rawSha256:roshan.rawSha256,
  componentContracts:{roshan:FEATURE_CONTRACT,economy:economy?.contract??ECONOMY_CONTRACT},
  vector:{names,values,schemaHash:admission?digest({contract:bundleContract,admissionProfile,names}):digest(names),featureCount:names.length},
  roshan:{state:roshan.roshan.state,rulesAccepted:roshan.rulesAccepted,timerSemanticsAccepted:roshan.timerSemanticsAccepted,historyContext:roshan.historyContext},
  economy:economy?{status:'coherent_diagnostic_features',staticContextStatus:economy.staticContextStatus,verifiedRoleCount:economy.verifiedRoleCount,knownActiveValueColumns:economy.knownActiveValueColumns,activeValueColumns:economy.activeValueColumns}:{status:'unavailable',reason:economyReason},
  resetReasons:[...(admissionChanged?['admission_profile_changed']:[]),...(continuityChanged?['source_continuity_changed']:[]),...roshan.resetReasons],state,
  jointTimelyCoverageProven:false,eligibleForServing:false,eligibleForTraining:false,publicPromotion:false};
}
