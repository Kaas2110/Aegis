/** Local startup configuration only; generation remains pure and makes no I/O.
 * Source identity hashes code bytes, not a Git checkout or a provider signature.
 */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {loadCanonicalRegistry} from '../../feature-registry/canonical-registry.mjs';
const groups={
 history:['historicalRelationalFeatures.mjs','historicalPerformanceFields.mjs','staticHistoryTargetContracts.mjs','retainedHistoryViewInputs.mjs','observedDraftHistory.mjs','historyCalculationCore.mjs','historySourceExport.mjs','historySourceVerifier.mjs','retainedOpenDotaFacts.mjs','retainedHistorySourceExport.mjs','retainedReferenceCorpus.mjs','boundedRetainedHistory.mjs','draftHistoricalFactsDb.mjs','historicalFactsDb.mjs'],
 live:['observedDraftFeatureBundle.mjs','steamFeatureBundle.mjs','playerHeroEconomyFeatures.mjs','roshanFeatures.mjs','steamProgressionAdmission.mjs','steamClockProgress.mjs','steamPhasePolicy.mjs','steamLiveAdapter.mjs','currentSteamInput.mjs','coherentEconomyContextFeatures.mjs','retainedReplayFrame.mjs','dynamicFields.mjs','nativeFieldEvidence.mjs','losslessJson.mjs','steamObservationIdentity.mjs'],
 series:['seriesContextFeatures.mjs'],
 draft:['draftIdentityFeatures.mjs','observedDraftHistory.mjs'],
 seriesHistory:['historicalRelationalFeatures.mjs','seriesHistoryTarget.mjs','historicalPerformanceFields.mjs','staticHistoryTargetContracts.mjs','retainedHistoryViewInputs.mjs','historyCalculationCore.mjs','retainedReferenceCorpus.mjs','boundedRetainedHistory.mjs']
};
export function loadLocalUnifiedProducerConfig(){
 const canonical=loadCanonicalRegistry();
 const sourceInventory=Object.fromEntries(Object.entries(groups).map(([id,files])=>{
  const rows=[...new Set([...files,'unifiedFeatureProducer.mjs','unifiedProducerConfig.mjs','featureProjectionCompiler.mjs','featureProjectionOwnership.mjs','causalTime.mjs','causalContext.mjs','observedDraft.mjs','historicalAlignment.mjs','recordedNormalization.mjs'])].map(name=>({path:'scripts/steam-live-collector/source-adapter/'+name,sha256:createHash('sha256').update(readFileSync(new URL(name,import.meta.url))).digest('hex')}));
  for(const name of ['registry-contract.mjs','historical-target-eligibility.mjs','canonical-registry.mjs'])rows.push({path:'scripts/feature-registry/'+name,sha256:createHash('sha256').update(readFileSync(new URL('../../feature-registry/'+name,import.meta.url))).digest('hex')});
  return[id,{primarySha256:rows[0].sha256,files:rows}];
 }));
 return{index:canonical.index,familyDocument:canonical.familyDocument,targetDocument:canonical.targetDocument,sourceInventory,canonicalRegistrySha256:canonical.registrySha256};
}
