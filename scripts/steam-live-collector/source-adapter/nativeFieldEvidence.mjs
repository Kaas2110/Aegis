/** Additive field lineage; it never estimates a missing measurement. */
import {PROFILE} from './dynamicFields.mjs';
export const NATIVE_FIELD_EVIDENCE_CONTRACT='aegis.steam-native-field-evidence.v1';
const UNITS=Object.freeze({level:'level',gold_per_min:'gold_per_minute',xp_per_min:'experience_per_minute',
 net_worth:'gold_value',gold:'provider_gold_units_unverified',net_gold:'provider_net_gold_units_unverified',
 score:'provider_score_count',tower_state:'opaque_uint32_bitmask',barracks_state:'opaque_uint32_bitmask',
 duration:'game_seconds',stream_delay_s:'declared_delay_seconds'});
export function nativeFieldEvidence(key,{path,capture}){
 const units=/^item[0-5]$/.test(key)?'item_id':UNITS[key];
 if(!units||typeof path!=='string'||!path||typeof capture?.receivedAt!=='string'||typeof capture.rawSha256!=='string')throw Error('native_field_evidence_contract');
 return{fieldEvidenceContract:NATIVE_FIELD_EVIDENCE_CONTRACT,sourceFieldPath:path+'.'+key,
  sourceProfile:PROFILE,knownAt:capture.receivedAt,rawSha256:capture.rawSha256,units,
  availabilityBasis:'original_capture_receipt',providerEventTimeProven:false,substitution:false};
}
