/** Verify an untouched saved normalization against immutable raw replay.
 * Compatibility changes the generated expectation, never the recorded object.
 * This is a separate derived projection, not an in-place data migration.
 */
import {normalizeLocalCapture,canonical,NORMALIZATION_CONTRACT} from './steamLiveAdapter.mjs';
export const RECORDED_NORMALIZATION_CONTRACT='aegis.recorded-steam-normalization-verifier.v1';
export const REVIEWED_LEGACY_SOURCE_SCHEMA_HASH='0ab381539eb52f665aea3a897010f34e1ccdefb1c9523805867fce21493eceeb';
export const REVIEWED_LEGACY_ADAPTER_SHA256='08de18890e9fbc388d4c0a63a473c16d26d4af0f98b79c39535b10c5c11c569d';
const LEGACY_NORMALIZATION='reviewed-unversioned-steam-normalization.v1';
const ADDED_NATIVE_KEYS=['fieldEvidenceContract','sourceFieldPath','sourceProfile','knownAt','rawSha256','units',
 'availabilityBasis','providerEventTimeProven','substitution'];
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
function legacyExpectation(replayed){
 const expected=structuredClone(replayed);
 const removeEvidence=metric=>{for(const key of ADDED_NATIVE_KEYS)delete metric[key];};
 delete expected.normalizationContract;
 expected.sourceSchemaHash=REVIEWED_LEGACY_SOURCE_SCHEMA_HASH;
 removeEvidence(expected.providerGameClockSeconds);removeEvidence(expected.declaredBroadcastDelaySeconds);
 for(const side of ['radiant','dire']){
  const data=expected.sides[side];
  for(const key of ['score','towerMaskRaw','barracksMaskRaw'])removeEvidence(data[key]);
  for(const player of data.players){
   for(const key of ['level','goldPerMinute','experiencePerMinute','netWorth','gold','netGoldRaw'])removeEvidence(player[key]);
   for(const item of player.observedItemFields)removeEvidence(item);
  }
 }
 return expected;
}
/** Returns latest replayedObservation only after full recorded-object equality.
 * input is the original byte capture plus its original receipt metadata.
 * Unsupported/ambiguous versions and any recorded corruption fail closed.
 */
export function verifyRecordedNormalizedObservation(input,recordedObservation){
 if(!recordedObservation||typeof recordedObservation!=='object'||Array.isArray(recordedObservation))throw Error('recorded_normalization_shape');
 let legacy=false;
 if(!own(recordedObservation,'normalizationContract')&&recordedObservation.sourceSchemaHash===REVIEWED_LEGACY_SOURCE_SCHEMA_HASH)legacy=true;
 else if(recordedObservation.normalizationContract!==NORMALIZATION_CONTRACT)throw Error('recorded_normalization_version_unsupported');
 const replay=normalizeLocalCapture(input);
 const matches=replay.observations.filter(o=>o.observationId===recordedObservation.observationId);
 if(matches.length!==1)throw Error('recorded_normalization_raw_identity_mismatch');
 const replayedObservation=matches[0];
 if(replayedObservation.normalizationContract!=='steam-live-scoreboard-normalization.v2')throw Error('recorded_normalization_replay_version_unreviewed');
 if(!legacy&&recordedObservation.sourceSchemaHash!==replayedObservation.sourceSchemaHash)throw Error('recorded_normalization_schema_unsupported');
 const expected=legacy?legacyExpectation(replayedObservation):replayedObservation;
 if(canonical(recordedObservation)!==canonical(expected))throw Error('recorded_normalization_content_mismatch');
 return {contract:RECORDED_NORMALIZATION_CONTRACT,accepted:true,legacyCompatibilityApplied:legacy,
  recordedNormalizationContract:legacy?LEGACY_NORMALIZATION:NORMALIZATION_CONTRACT,
  replayNormalizationContract:NORMALIZATION_CONTRACT,recordedSourceSchemaHash:recordedObservation.sourceSchemaHash,
  replaySourceSchemaHash:replayedObservation.sourceSchemaHash,recordedObservationId:recordedObservation.observationId,
  comparisonScope:'full_untouched_recorded_observation_against_raw_replay',recordedObjectRewritten:false,
  replayedObservation,eligibleForTraining:false,eligibleForServing:false};
}
