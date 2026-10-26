/** Archive-only compatibility. Original objects and bytes remain immutable.
 * A separately identified current projection is reconstruction, not an old issued
 * feature or proof that the original collector stored current dynamic fields. */
import {normalizeLocalCapture,canonical} from './steamLiveAdapter.mjs';
import {normalizeLocalCapture as normalizeOriginal20261020} from './retainedSteamNormalization20261020.mjs';
import {verifyRecordedNormalizedObservation} from './recordedNormalization.mjs';

export const RETAINED_ORIGINAL_20261020_SCHEMA='110344ffc353ba43695daac429b09153a64a15083f26963b55f218a628b77cef';
export const RETAINED_ORIGINAL_20261020_IMPLEMENTATION='17fe74424b98b9e74a09cff499dc490813eba7f2ed2405f6a4b3d70fe1520680';
const fail=reason=>{throw Error('retained_steam_archive_intake:'+reason);};
export function verifyRetainedSteamArchiveNormalization(input,recorded){
 if(!Array.isArray(recorded?.observations)||recorded.observations.length>512||!Array.isArray(recorded.rejections))fail('recorded_normalized_shape');
 const historical=recorded.observations.some(o=>!Object.hasOwn(o,'normalizationContract')&&o.sourceSchemaHash===RETAINED_ORIGINAL_20261020_SCHEMA);
 const replay=normalizeLocalCapture(input);
 if(!['normalized_capture_diagnostic','empty_games_diagnostic'].includes(replay.status))fail('current_raw_projection_rejected');
 if(historical){
  const old=normalizeOriginal20261020(input);
  if(!['normalized_capture_diagnostic','empty_games_diagnostic'].includes(old.status)||canonical(recorded)!==canonical(old))fail('original_20261020_normalization_content_mismatch');
  const checked=recorded.observations.map(original=>{
   const matches=replay.observations.filter(o=>o.matchId===original.matchId);
   if(matches.length!==1)fail('original_20261020_current_projection_identity');
   return {original,observationForNativeInput:matches[0],verification:{
    contract:'aegis.retained-steam-normalization-compatibility.v1',accepted:true,
    legacyCompatibilityApplied:true,recordedNormalizationContract:'reviewed-unversioned-pre-dynamic-steam-normalization.20261020.v1',
    recordedImplementationSha256:RETAINED_ORIGINAL_20261020_IMPLEMENTATION,
    recordedSourceSchemaHash:original.sourceSchemaHash,recordedObservationId:original.observationId,
    replaySourceSchemaHash:matches[0].sourceSchemaHash,replayObservationId:matches[0].observationId,
    comparisonScope:'full_untouched_recorded_capture_against_frozen_original_implementation',
    recordedObjectRewritten:false,originalDynamicFieldsRecorded:false,
    replayDynamicFieldsReconstructed:true,nativeInputEvidence:'reconstructed_from_original_raw_capture',
    originalReceiptTimesPreserved:true,originalIssuedFeaturesProven:false,
    replayedObservation:matches[0],eligibleForTraining:false,eligibleForServing:false}};
  });
  return {replay,checked};
 }
 if(recorded.observations.length!==replay.observations.length||new Set(recorded.observations.map(o=>o.observationId)).size!==recorded.observations.length)fail('recorded_normalized_population');
 return {replay,checked:recorded.observations.map(original=>({original,observationForNativeInput:original,
  verification:{...verifyRecordedNormalizedObservation(input,original),originalDynamicFieldsRecorded:true,
   replayDynamicFieldsReconstructed:false,nativeInputEvidence:'original_recorded_normalization',originalIssuedFeaturesProven:false}}))};
}
