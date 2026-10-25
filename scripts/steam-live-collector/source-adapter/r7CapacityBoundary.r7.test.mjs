/** OPT-IN current full rich feature capacity refusal regressions. SYNTHETIC
 * retained inputs, actual canonical formulas/metadata/compiler/codec. No vector
 * pruning, synthetic replacement columns, limit changes or accepted13 claim.
 * Root alone runs under its serial owned6GiB job; each case has one4GiB arena. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {digest} from '../../feature-registry/registry-contract.mjs';
import {createDiagnosticResourceArena} from './diagnosticResourceArena.mjs';
import {loadLocalUnifiedProducerConfig} from './unifiedProducerConfig.mjs';
import {syntheticRichProducerFixture} from './r5RichProducer.fixtures.mjs';
import {retainVerifiedProjectionSchema,retainVerifiedProjectionVector} from './featureProjectionCompiler.mjs';
import {createCompactFeatureSchema,releaseCompactFeatureAsset} from './compactFeatureAssets.mjs';

const OPT_IN=process.env.AEGIS_R7_CAPACITY_BOUNDARY==='1';
const ARENA_BYTES=4*1024**3;
// SAME unchanged default as createCompactFeatureJournal, not a larger allowance.
const CODEC_WORKING_BYTES=512*1024*1024;
const ownKeys=(value,keys)=>assert.deepEqual(Object.keys(value).sort(),[...keys].sort());

/** Observe the SAME arena admission; never inspect caller assets or substitute
 * an allocation. Retain only the last8 bounded failures for root diagnostics. */
function allocationArena(){
 const actual=createDiagnosticResourceArena({maxBytes:ARENA_BYTES}),denials=[];
 const record=(port,requestedBytes)=>{if(denials.length===8)denials.shift();denials.push(Object.freeze({port,requestedBytes,arena:actual.status(),stack:String(new Error('capacity_arena_denial').stack??'').slice(0,8192)}));};
 const arena=Object.freeze({...actual,
  reserve(bytes){const held=actual.reserve(bytes);if(held===null)record('reserve',bytes);return held;},
  retainAsset(asset,bytes){const held=actual.retainAsset(asset,bytes);if(held===null)record('retainAsset',bytes);return held;}
 });
 return {arena,denials:()=>denials.slice()};
}
function refusalDiagnostic(t,phase,error,tracked){
 if(!error)return;
 // Preserve the original failure evidence before the expected-reason assertion
 // can replace it. Root errors expose bounded primitive diagnostic fields.
 const details={},raw=Object.getOwnPropertyDescriptor(error,'diagnostics')?.value;
 if(raw&&typeof raw==='object'){let count=0;for(const key in raw)if(Object.hasOwn(raw,key)){if(count++===32)break;const d=Object.getOwnPropertyDescriptor(raw,key),value=d?.value;if(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))details[key.slice(0,128)]=value;else if(typeof value==='string')details[key.slice(0,128)]=value.slice(0,4096);else if(key==='arena'&&value&&typeof value==='object'){const state={};let fields=0;for(const field in value)if(Object.hasOwn(value,field)){if(fields++===24)break;const item=Object.getOwnPropertyDescriptor(value,field)?.value;if(item===null||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item))state[field.slice(0,128)]=item;else if(typeof item==='string')state[field.slice(0,128)]=item.slice(0,256);}details.arena=state;}}}
 diagnostic(t,{contract:'aegis.r7-capacity-allocation-diagnostic.v1',phase,originalError:{name:String(error.name??'Error').slice(0,128),message:String(error.message??'').slice(0,4096),stack:String(error.stack??'').slice(0,8192),diagnostics:details},arena:tracked.arena.status(),lastArenaDenials:tracked.denials(),maximumRetainedDenials:8,limitsUnchanged:true});
}

function forbidNetwork(t){
 let attempts=0;
 const deny=()=>{attempts++;throw Error('r7_capacity_network_forbidden');};
 for(const[obj,key]of[[globalThis,'fetch'],[http,'request'],[http,'get'],[https,'request'],[https,'get'],[net,'connect'],[net,'createConnection']])t.mock.method(obj,key,deny);
 return()=>attempts;
}
function sequence(){
 const hash=createHash('sha256');let count=0;hash.update('[');
 return{add(value){if(count++)hash.update(',');hash.update(JSON.stringify(value));},finish(){hash.update(']');return{count,sha256:hash.digest('hex')};}};
}
function emptyArena(arena){
 const state=arena.status();assert.equal(state.chargedBytes,0);assert.equal(state.leases,0);assert.equal(state.heldAssets,0);assert.equal(state.maxBytes,ARENA_BYTES);return state;
}
function sourcePins(config,fixture){
 return{canonicalRegistrySha256:config.canonicalRegistrySha256,sourceInventoryHash:digest(config.sourceInventory),sourceInventory:config.sourceInventory,inputPins:{facts:fixture.args.factsInput.pin,native:fixture.args.nativeInput.pin,draftPrefix:fixture.args.draftPrefixInputs.map(x=>({raw:x.rawInput.pin,metadata:x.metadataInput.pin})),series:fixture.seriesInput.pin}};
}
function diagnostic(t,body){
 t.diagnostic(JSON.stringify({...body,contentHash:digest(body)}));
}
const limits={arenaBytes:ARENA_BYTES,ownedJobBytes:6*1024**3,aggregatePolicyGiB:24,codecWorkingBytes:CODEC_WORKING_BYTES,limitsUnchanged:true,engineeringOwnershipEstimatesNotMeasuredRSS:true};
const nonAcceptance={syntheticInputs:true,actualCurrentProducer:true,mockedVectors:false,prunedFeatures:false,fullActualDeclarationAuditAccepted:false,semanticAuditExecuted:false,semanticAcceptance:false,sourceAvailabilityAttested:false,fullFeatureGateComplete:false,all13Accepted:false,training:false,serving:false,modelActivation:false,modelQualityEvaluated:false};

test('R7 actual canonical POST full schema hits the unchanged codec expanded-schema gate',{skip:!OPT_IN},t=>{
 const attempts=forbidNetwork(t),tracked=allocationArena(),arena=tracked.arena,config=loadLocalUnifiedProducerConfig(),started=performance.now();
 let fixture=null,bundle=null,schemaOwner=null,vectorOwner=null,compact=null,receipt=null;
 try{
  fixture=syntheticRichProducerFixture({resourceArena:arena,capacityProfile:'LEGACY_150K'});const pins=sourcePins(config,fixture),generateStarted=performance.now();
  bundle=fixture.generate();const generateMs=performance.now()-generateStarted;
  assert.equal(bundle.mode,'POST');assert.equal(bundle.recordedPrediction,false);assert.equal(bundle.eligibleForTraining,false);assert.equal(bundle.eligibleForServing,false);assert.equal(bundle.semanticStatus.sourceInventoryHash,pins.sourceInventoryHash);
  assert.deepEqual(bundle.routes.map(r=>r.targetId),['POST_MAP_WIN','POST_KILLS','POST_DURATION','SERIES_LIVE']);
  const producedRoutes=bundle.routes.map(r=>({targetId:r.targetId,stateMode:r.stateMode,schemaSha256:r.schemaRef.sha256,namesSha256:r.schemaRef.namesSha256,featureCount:r.schemaRef.featureCount}));
  const route=bundle.routes[0];schemaOwner=retainVerifiedProjectionSchema(route.diagnosticSchema,{expectedSchemaHash:route.schemaRef.sha256});assert.ok(schemaOwner);
  vectorOwner=retainVerifiedProjectionVector(route.diagnosticVector,{expectedNamesHash:route.schemaRef.namesSha256,featureCount:route.schemaRef.featureCount});assert.ok(vectorOwner);
  assert.equal(schemaOwner.schema,route.diagnosticSchema);assert.equal(vectorOwner.vector,route.diagnosticVector);
  const schemaRef={...route.schemaRef},schema=schemaOwner.schema,vector=vectorOwner.vector,names=sequence(),values=sequence(),missing=sequence();
  assert.equal(schema.definitions.length,schemaRef.featureCount);assert.equal(vector.names.length,schemaRef.featureCount);assert.equal(vector.values.length,schemaRef.featureCount);assert.equal(vector.missing.length,schemaRef.featureCount);
  for(let i=0;i<schemaRef.featureCount;i++){
   assert.equal(schema.definitions[i].name,vector.names[i]);assert.equal(typeof vector.missing[i],'boolean');assert.equal(vector.missing[i],vector.values[i]===null);assert.ok(vector.values[i]===null||Number.isFinite(vector.values[i]));
   names.add(vector.names[i]);values.add([vector.values[i],Object.is(vector.values[i],-0)]);missing.add(vector.missing[i]);
  }
  const orderedNames=names.finish(),orderedValues=values.finish(),orderedMissing=missing.finish();assert.equal(orderedNames.count,schemaRef.featureCount);assert.equal(orderedNames.sha256,schemaRef.namesSha256);
  // Keep the exact original private schema/vector while releasing all other
  // heads and producer caches. The codec still receives the WHOLE schema.
  bundle.release();bundle=null;fixture.producer.close();
  const arenaBeforeCodec=arena.status(),codecStarted=performance.now();let refusal=null;
  try{compact=createCompactFeatureSchema(schema,{arena,expectedSchemaHash:schemaRef.sha256,workingBytes:CODEC_WORKING_BYTES});}catch(error){refusal=error;}
  refusalDiagnostic(t,'POST',refusal,tracked);
  assert.ok(refusal,'unchanged codec must give a typed capacity refusal; null/accepted is not this expected boundary');
  assert.equal(refusal.message,'compact_feature_asset:expanded_schema_bound');
  const details=refusal.diagnostics;
  ownKeys(details,['contract','capacityProfile','features','processedDefinitions','saturatedExpandedNodes','maxExpandedNodes','saturatedExpandedBytes','maxExpandedBytes','countsAreSaturatedLowerBounds','limitsUnchanged']);assert.equal(details.capacityProfile,'LEGACY_150K');
  assert.equal(Object.isFrozen(details),true);assert.equal(details.contract,'aegis.compact-schema-capacity-refusal.v1');assert.equal(details.features,schemaRef.featureCount);assert.ok(Number.isSafeInteger(details.processedDefinitions)&&details.processedDefinitions>0&&details.processedDefinitions<=details.features);
  assert.equal(details.maxExpandedNodes,16000000);assert.equal(details.maxExpandedBytes,256*1024*1024);assert.equal(details.countsAreSaturatedLowerBounds,true);assert.equal(details.limitsUnchanged,true);
  for(const key of ['saturatedExpandedNodes','saturatedExpandedBytes'])assert.ok(Number.isSafeInteger(details[key])&&details[key]>0);
  assert.ok(details.saturatedExpandedNodes>details.maxExpandedNodes||details.saturatedExpandedBytes>details.maxExpandedBytes);
  // Saturation is the exact bounded diagnostic, never a fabricated total size.
  assert.ok(details.saturatedExpandedNodes<=details.maxExpandedNodes+1);assert.ok(details.saturatedExpandedBytes<=details.maxExpandedBytes+1);
  const arenaAfterCodec=arena.status();assert.equal(arenaAfterCodec.chargedBytes,arenaBeforeCodec.chargedBytes);assert.equal(arenaAfterCodec.leases,arenaBeforeCodec.leases);assert.equal(arenaAfterCodec.heldAssets,arenaBeforeCodec.heldAssets);assert.equal(arenaAfterCodec.denied,0);
  assert.equal(compact,null);assert.equal(attempts(),0);
  receipt={contract:'aegis.r7-actual-capacity-boundary-receipt.v1',phase:'POST',operation:'encode_full_original_projection_schema',status:'refused_unchanged_expanded_schema_capacity',...pins,...limits,...nonAcceptance,producedRoutes,attemptedTargetId:route.targetId,attemptedStateMode:route.stateMode,originalSchemaRef:schemaRef,originalVector:{featureCount:orderedNames.count,namesSha256:orderedNames.sha256,taggedValuesSha256:orderedValues.sha256,missingSha256:orderedMissing.sha256,allOriginalPositionsChecked:true},diagnostics:details,diagnosticsAreSaturatedLowerBounds:true,codecAccepted:false,generateMs,codecMs:performance.now()-codecStarted,arenaBeforeCodec,arenaAfterCodec,networkAttempts:attempts()};
 }finally{
  if(compact)releaseCompactFeatureAsset(compact);vectorOwner?.release();schemaOwner?.release();bundle?.release();fixture?.producer.close();const finalArena=emptyArena(arena);
  if(receipt)diagnostic(t,{...receipt,elapsedMs:performance.now()-started,finalArena});
 }
});

test('R7 actual positive-clock LIVE full projection hits the unchanged count gate',{skip:!OPT_IN},t=>{
 const attempts=forbidNetwork(t),tracked=allocationArena(),arena=tracked.arena,config=loadLocalUnifiedProducerConfig(),started=performance.now();
 let fixture=null,bundle=null,receipt=null;
 try{
  fixture=syntheticRichProducerFixture({resourceArena:arena,capacityProfile:'LEGACY_150K'});const pins=sourcePins(config,fixture),frame=fixture.frame(30),raw=JSON.parse(frame.rawInput.utf8),game=raw.result.games[0];
  assert.equal(game.scoreboard.duration,30);assert.equal(game.game_state,5);
  let refusal=null;const generateStarted=performance.now();
  try{bundle=fixture.generate(30);}catch(error){refusal=error;}
  refusalDiagnostic(t,'LIVE',refusal,tracked);
  assert.ok(refusal,'unchanged compiler must refuse the full filtered projection; accepted/null is not this boundary');assert.equal(bundle,null);
  assert.equal(refusal.message,'unified_features:projected_feature_count_bound');const details=refusal.diagnostics;
  ownKeys(details,['contract','capacityProfile','targetId','stateMode','featureCount','maxFeatureCount','limitsUnchanged']);assert.equal(details.capacityProfile,'LEGACY_150K');assert.equal(Object.isFrozen(details),true);assert.equal(details.contract,'aegis.projection-capacity-refusal.v1');assert.equal(details.targetId,'LIVE_MAP_WIN');assert.equal(details.stateMode,'LIVE');assert.equal(details.maxFeatureCount,150000);assert.equal(details.limitsUnchanged,true);assert.ok(Number.isSafeInteger(details.featureCount)&&details.featureCount>details.maxFeatureCount);
  assert.equal(attempts(),0);const arenaAfterRefusal=arena.status();assert.equal(arenaAfterRefusal.denied,0);assert.equal(fixture.producer.resourceStatus().activeBundles,0);
  receipt={contract:'aegis.r7-actual-capacity-boundary-receipt.v1',phase:'LIVE',operation:'compile_full_original_target_projection',status:'refused_unchanged_projected_feature_count',...pins,...limits,...nonAcceptance,positiveLiveClockSeconds:30,liveInputPins:{raw:frame.rawInput.pin,metadata:frame.metadataInput.pin},attemptedTargetId:details.targetId,attemptedStateMode:details.stateMode,diagnostics:details,projectedFeatureCount:details.featureCount,countBasis:'actual_complete_eligible_definition_loop_before_schema_or_vector_minting',schemaSha256:null,namesSha256:null,vectorSha256:null,projectionAccepted:false,fullVectorProduced:false,subsequentLiveTargetModesAttempted:false,unattemptedTargetModes:['LIVE_KILLS:LIVE','LIVE_DURATION:LIVE','SERIES_LIVE:observed_live'],semanticIdentityCounts:null,metadataGapCounts:null,generateMs:performance.now()-generateStarted,arenaAfterRefusal,networkAttempts:attempts()};
 }finally{
  bundle?.release();fixture?.producer.close();const finalArena=emptyArena(arena);
  if(receipt)diagnostic(t,{...receipt,elapsedMs:performance.now()-started,finalArena});
 }
});
