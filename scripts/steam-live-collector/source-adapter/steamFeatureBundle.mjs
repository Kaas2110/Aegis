/** One coherent Steam observation -> one versioned diagnostic feature vector.
 * Archive replay and DB readers call this exact function. No model or network IO.
 */
import {createHash} from 'node:crypto';
import {advanceRoshanFeatures,FEATURE_CONTRACT} from './roshanFeatures.mjs';
import {projectPlayerHeroEconomy,featureNames,CONTRACT as ECONOMY_CONTRACT} from './playerHeroEconomyFeatures.mjs';
export const BUNDLE_CONTRACT='aegis.steam-coherent-feature-bundle.v3';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const clock=o=>o?.providerGameClockSeconds?.missing===false?o.providerGameClockSeconds.value:null;
const EXPECTED_ECONOMY_ERRORS=new Set(['complete_coherent_economy_snapshot_required','hero_dictionary_revision_required']);
/** The history state is private to one map/profile. It contains only preceding
 * source observations, never labels. Static history uses the explicit frozen v2
 * context; unproven history is missing, not an invented player-strength value.
 */
export function advanceSteamFeatureBundle(previous,observation,{patch=null,rules=null,events=[],historicalContext=null}={}){
 if(previous!==null&&previous!==undefined&&(previous.contract!==BUNDLE_CONTRACT||!Array.isArray(previous.history)||previous.history.length>2048))throw Error('steam_feature_bundle_state');
 const roshan=advanceRoshanFeatures(previous?.roshanState??null,observation,{patch,rules,events,historicalContext});
 const reset=roshan.resetReasons.length>0;
 const history=reset?[]:(previous?.history??[]);
 let economy=null,economyReason=null;
 try{economy=projectPlayerHeroEconomy(observation,{staticContext:historicalContext,history});}
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
 const state={contract:BUNDLE_CONTRACT,roshanState:roshan.state,history:nextHistory};
 return {contract:BUNDLE_CONTRACT,matchId:observation.matchId,observationId:observation.observationId,
  sourceProfile:roshan.sourceProfile,knownAt:roshan.knownAt,eventClockSeconds:roshan.gameClockSeconds,
  sourceInputHash:roshan.sourceInputHash,rawSha256:roshan.rawSha256,
  componentContracts:{roshan:FEATURE_CONTRACT,economy:ECONOMY_CONTRACT},
  vector:{names,values,schemaHash:digest(names),featureCount:names.length},
  roshan:{state:roshan.roshan.state,rulesAccepted:roshan.rulesAccepted,timerSemanticsAccepted:roshan.timerSemanticsAccepted,historyContext:roshan.historyContext},
  economy:economy?{status:'coherent_diagnostic_features',staticContextStatus:economy.staticContextStatus,verifiedRoleCount:economy.verifiedRoleCount,knownActiveValueColumns:economy.knownActiveValueColumns,activeValueColumns:economy.activeValueColumns}:{status:'unavailable',reason:economyReason},
  resetReasons:roshan.resetReasons,state,
  jointTimelyCoverageProven:false,eligibleForServing:false,eligibleForTraining:false,publicPromotion:false};
}
