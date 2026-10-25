import test from 'node:test';
import assert from 'node:assert/strict';
import {LEGACY_FEATURE_CAPACITY_PROFILE as LEGACY,FULL_FEATURE_CAPACITY_PROFILE as FULL,FEATURE_CAPACITY_PROFILES,resolveFeatureCapacityProfile,featureCapacityProfileForSchema} from './featureCapacityProfiles.mjs';

test('R7 full capacity is an explicit immutable new profile; legacy bounds remain exact',()=>{
 assert.deepEqual(LEGACY,{id:'LEGACY_150K',schemaContract:'aegis.unified-feature-projection-schema.v1',maxFeatures:150000,maxExpandedSchemaBytes:268435456,maxExpandedNodes:16000000,maxEncodedBytes:268435456});
 assert.deepEqual(FULL,{id:'R7_FULL300K',schemaContract:'aegis.unified-feature-projection-schema.v2',maxFeatures:300000,maxExpandedSchemaBytes:4294967296,maxExpandedNodes:128000000,maxEncodedBytes:268435456});
 for(const profile of [LEGACY,FULL]){assert.equal(Object.isFrozen(profile),true);assert.equal(resolveFeatureCapacityProfile(profile.id),profile);}
 assert.equal(Object.isFrozen(FEATURE_CAPACITY_PROFILES),true);
 for(const value of [undefined,null,'','__proto__','toString','R7_FULL300K ',{},300000])assert.throws(()=>resolveFeatureCapacityProfile(value),/feature_capacity_profile:unknown_profile/);
});

test('schema capacity cannot be enlarged without the exact versioned header/profile binding',()=>{
 assert.equal(featureCapacityProfileForSchema({contract:LEGACY.schemaContract}),LEGACY);
 assert.equal(featureCapacityProfileForSchema({contract:FULL.schemaContract,capacityProfile:FULL.id}),FULL);
 assert.equal(featureCapacityProfileForSchema(Object.assign(Object.create(null),{contract:FULL.schemaContract,capacityProfile:FULL.id})),FULL);
 for(const capacityProfile of [undefined,null,LEGACY.id,FULL.id])assert.throws(()=>featureCapacityProfileForSchema({contract:LEGACY.schemaContract,capacityProfile}),/legacy_profile_must_be_absent/);
 for(const value of [{contract:FULL.schemaContract},{contract:FULL.schemaContract,capacityProfile:LEGACY.id},{contract:FULL.schemaContract,capacityProfile:'unknown'},{contract:'aegis.unified-feature-projection-schema.v9',capacityProfile:FULL.id}])assert.throws(()=>featureCapacityProfileForSchema(value),/schema_profile_binding/);
});

test('schema profile classification refuses proxies/inherited fields/accessors without getter effects',()=>{
 let reads=0;const accessor={contract:FULL.schemaContract};Object.defineProperty(accessor,'capacityProfile',{get(){reads++;return FULL.id;}});
 const accessorContract={capacityProfile:FULL.id};Object.defineProperty(accessorContract,'contract',{get(){reads++;return FULL.schemaContract;}});
 for(const value of [accessor,accessorContract])assert.throws(()=>featureCapacityProfileForSchema(value),/schema_data_property/);
 for(const value of [null,[],new Proxy({contract:FULL.schemaContract,capacityProfile:FULL.id},{get(){reads++;throw Error('proxy_read');}}),Object.create({contract:FULL.schemaContract,capacityProfile:FULL.id})])assert.throws(()=>featureCapacityProfileForSchema(value),/schema_record/);
 assert.equal(reads,0);
});
