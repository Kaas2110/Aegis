/** Versioned logical capacity, not a memory reservation or semantic authority.
 * The owner authorized R7_FULL300K on2026-10-25 and the finite256MiB encoded
 * ceiling for all supported formats on2026-10-26. Legacy logical/count bounds
 * remain unchanged; full schemas must name their profile explicitly.
 * All consumers still admit actual work in the shared arena/owned process cap. */
import {types} from 'node:util';

export const LEGACY_FEATURE_CAPACITY_PROFILE=Object.freeze({
 id:'LEGACY_150K',
 schemaContract:'aegis.unified-feature-projection-schema.v1',
 maxFeatures:150000,
 maxExpandedSchemaBytes:256*1024*1024,
 maxExpandedNodes:16000000,
 maxEncodedBytes:256*1024*1024
});
export const FULL_FEATURE_CAPACITY_PROFILE=Object.freeze({
 id:'R7_FULL300K',
 schemaContract:'aegis.unified-feature-projection-schema.v2',
 maxFeatures:300000,
 maxExpandedSchemaBytes:4*1024**3,
 maxExpandedNodes:128000000,
 maxEncodedBytes:256*1024*1024
});
export const FEATURE_CAPACITY_PROFILES=Object.freeze({
 LEGACY_150K:LEGACY_FEATURE_CAPACITY_PROFILE,
 R7_FULL300K:FULL_FEATURE_CAPACITY_PROFILE
});
const fail=reason=>{throw Error('feature_capacity_profile:'+reason);};

/** No unknown/default profile can silently receive a larger bound. */
export function resolveFeatureCapacityProfile(id){
 if(typeof id!=='string'||!Object.hasOwn(FEATURE_CAPACITY_PROFILES,id))fail('unknown_profile');
 return FEATURE_CAPACITY_PROFILES[id];
}

/** Select only from own plain data descriptors; never execute input getters.
 * Callers remain responsible for validating the rest of the schema contract.
 * A copied schema may be classified here but gains NO private ownership. */
export function featureCapacityProfileForSchema(schema){
 if(!schema||typeof schema!=='object'||types.isProxy(schema)||Array.isArray(schema)||![Object.prototype,null].includes(Object.getPrototypeOf(schema)))fail('schema_record');
 const contract=Object.getOwnPropertyDescriptor(schema,'contract'),profile=Object.getOwnPropertyDescriptor(schema,'capacityProfile');
 if(!contract||!('value'in contract)||profile&&!('value'in profile))fail('schema_data_property');
 if(contract.value===LEGACY_FEATURE_CAPACITY_PROFILE.schemaContract){
  if(profile)fail('legacy_profile_must_be_absent');
  return LEGACY_FEATURE_CAPACITY_PROFILE;
 }
 if(contract.value!==FULL_FEATURE_CAPACITY_PROFILE.schemaContract||!profile||profile.value!==FULL_FEATURE_CAPACITY_PROFILE.id)fail('schema_profile_binding');
 return FULL_FEATURE_CAPACITY_PROFILE;
}
