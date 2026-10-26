/** OPT-IN actual canonical POST producers. Synthetic raw bytes are normalized
 * and admitted through the real private draft/native/history factories; no fake
 * definitions, vectors, providers, model fits or source95 evidence. Root runs
 * serially inside its owned9GiB/fourCPU/headroom/STOP guard only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {digest} from '../../feature-registry/registry-contract.mjs';
import {alignedArgs,draftEntry,pinned} from './observedDraftHistory.fixtures.mjs';
import {normalizeLocalCapture} from './steamLiveAdapter.mjs';
import {createDynamicHistoryProof,readDynamicHistoryProof} from './observedDraftFeatureBundle.mjs';
import {createUnifiedFeatureProducer} from './unifiedFeatureProducer.mjs';
import {loadLocalUnifiedProducerConfig} from './unifiedProducerConfig.mjs';
import {retainVerifiedProjectedRow} from './featureProjectionCompiler.mjs';
import {createDiagnosticResourceArena} from './diagnosticResourceArena.mjs';
import {createDiagnosticResourceConfiguration,RICH_DIAGNOSTIC_RESOURCE_PROFILE} from './diagnosticResourceConfiguration.mjs';

const OPT_IN=process.env.AEGIS_R8_ACTUAL_POST_FUNCTION_IDENTITY==='1';
const AT='2026-10-23T12:30:00Z',EXPECTED=['POST_MAP_WIN','POST_KILLS','POST_DURATION','SERIES_LIVE'];
const nominal=(value,offset)=>value===null||value===undefined?value:String(Number(value)+offset);

/** Relabel only nominal IDs. Hero coordinates, receipt times, native metrics,
 * outcomes, windows, support, rules, source profiles and producer code are fixed.
 * Every remapped observation is regenerated from its remapped RAW Steam bytes. */
function inputs(offset){
 const base=alignedArgs({explicit:true}),mapOffset=offset*100000,teamOffset=offset*1000,accountOffset=offset*1000,matchId=nominal('90001',mapOffset);
 const mapFact=map=>({...map,matchId:nominal(map.matchId,mapOffset),radiantTeamId:nominal(map.radiantTeamId,teamOffset),direTeamId:nominal(map.direTeamId,teamOffset),players:map.players.map(p=>({...p,accountId:nominal(p.accountId,accountOffset),teamId:nominal(p.teamId,teamOffset)}))});
 const rawSteam=input=>{
  const raw=JSON.parse(input.utf8);
  for(const game of raw.result.games){
   game.match_id=Number(nominal(game.match_id,mapOffset));
   for(const side of ['radiant','dire']){
    if(game[side+'_team'])game[side+'_team'].team_id=Number(nominal(game[side+'_team'].team_id,teamOffset));
    for(const p of game.scoreboard[side].players)if(p.account_id!==4294967295)p.account_id=Number(nominal(p.account_id,accountOffset));
   }
  }
  return pinned(raw,'synthetic-function-identity-steam-raw.json');
 };
 const replay=(rawInput,capture)=>{
  const result=normalizeLocalCapture({...capture,body:Buffer.from(rawInput.utf8),rawSha256:rawInput.pin.sha256,payloadRef:'journal:'+rawInput.pin.sha256});
  assert.equal(result.observations.length,1);return result.observations[0];
 };
 const facts=JSON.parse(base.factsInput.utf8);facts.maps=facts.maps.map(mapFact);
 facts.scope={...facts.scope,asOf:AT,targetTeamIds:facts.scope.targetTeamIds.map(id=>nominal(id,teamOffset)),targetAccountIds:facts.scope.targetAccountIds.map(id=>nominal(id,accountOffset))};
 const current=draftEntry({accounts:true,time:AT,clock:0,phase:2}),currentMetadata=JSON.parse(current.metadataInput.utf8),currentRaw=rawSteam(current.rawInput),currentObservation=replay(currentRaw,currentMetadata.capture);
 const currentInput={rawInput:currentRaw,metadataInput:pinned({...currentMetadata,matchId,observationId:currentObservation.observationId},'synthetic-function-identity-draft-metadata.json')};
 const observations=[],nativeEvidenceInputs=[];
 for(const evidence of base.nativeEvidenceInputs){
  const previous=JSON.parse(evidence.observationInput.utf8),rawCaptureInput=rawSteam(evidence.rawCaptureInput),observation=replay(rawCaptureInput,previous.source.capture),prior=mapFact(JSON.parse(evidence.priorMapInput.utf8));
  observations.push(observation);nativeEvidenceInputs.push({rawCaptureInput,observationInput:pinned(observation,'synthetic-function-identity-prior-observation.json'),priorMapInput:pinned(prior,'synthetic-function-identity-prior-map.json')});
 }
 const native=JSON.parse(base.nativeInput.utf8);native.observations=observations;
 const seriesId=offset?'synthetic-function-context-b':'synthetic-function-context-a';
 const historyInputs={matchId,computedAt:AT,minimumSupport:5,draftPrefixInputs:[currentInput],factsInput:pinned(facts,'synthetic-function-identity-prior-facts.json'),nativeInput:pinned(native,'synthetic-function-identity-native-input.json'),nativeEvidenceInputs};
 const seriesInput=pinned({contract:'aegis.series-map-receipts.v1',seriesId,bestOf:3,team1Id:nominal('100',teamOffset),team2Id:nominal('200',teamOffset),availableAt:AT,completeThroughMapNumber:0,previousMaps:[]},'synthetic-function-identity-series.json');
 return{matchId,seriesId,historyInputs,seriesInput};
}
function projection(route){return{schema:route.diagnosticSchema,vector:route.diagnosticVector,expectedSchemaHash:route.schemaRef.sha256,projectedRowAuthority:route.projectedRowAuthority};}

/** One full bundle/caches at a time. Only ONE actual A map-head row lease may
 * overlap B construction, inside the SAME explicit8GiB arena. No full inspection
 * copies or uncharged serialized schema snapshots escape a case. */
function capture(offset,{config,arena,resourceConfiguration,priorWitness=null}){
 const data=inputs(offset),history=createDynamicHistoryProof(data.historyInputs,{includeInspectionCopies:false}),checked=readDynamicHistoryProof(history.proof,{matchId:data.matchId,decisionAt:AT});
 assert.equal(checked.accepted,true);assert.ok(checked.context.featurePayload.heroMinuteReferences.length>0,'actual raw-replayed prior native references must exist');assert.equal(checked.context.historyCutoffAt,AT);
 let producer=null,bundle=null,witness=null;
 try{
  producer=createUnifiedFeatureProducer({...config,resourceArena:arena,resourceConfiguration});
  bundle=producer.generateFeatureBundle({mode:'POST',matchId:data.matchId,decisionAt:AT,historyProof:history.proof,seriesInput:data.seriesInput,currentMapNumber:1});
  assert.equal(bundle.mode,'POST');assert.deepEqual(bundle.routes.map(r=>r.targetId),EXPECTED);assert.equal(bundle.eligibleForTraining,false);assert.equal(bundle.eligibleForServing,false);
  const receipts=[];let crossPairsRefused=0;
  for(const route of bundle.routes){
   const held=retainVerifiedProjectedRow(projection(route));assert.ok(held,'actual producer projection must retain genuine private authority');
   try{
    assert.equal(held.provenance.matchId,data.matchId);assert.equal(held.provenance.seriesId,data.seriesId);assert.equal(held.provenance.contract,'aegis.unified-producer-row.v1');assert.equal(route.featureFunctionContract.generalized,true);assert.equal(route.featureFunctionContract.unclassifiedDefinitionCount,0);
    const identities=held.provenance.identities.players;assert.deepEqual(identities.map(p=>Number(p.heroId)).sort((a,b)=>a-b),[1,2,3,4,5,6,7,8,9,10]);assert.deepEqual(identities.map(p=>Number(p.accountId)).sort((a,b)=>a-b),Array.from({length:10},(_,i)=>offset*1000+i+1));
    receipts.push({targetId:route.targetId,stateMode:route.stateMode,functionSha256:route.featureFunctionContract.sha256,producerCompatibilitySha256:route.featureFunctionContract.producerCompatibilitySha256,generalized:route.featureFunctionContract.generalized,unclassifiedDefinitionCount:route.featureFunctionContract.unclassifiedDefinitionCount,schemaSha256:route.schemaRef.sha256,namesSha256:route.schemaRef.namesSha256,featureCount:route.schemaRef.featureCount,rowParameterBindingsSha256:held.descriptor.rowParameterBindingsSha256,contextSha256:held.descriptor.contextSha256,valuesAndMasksSha256:held.descriptor.valuesAndMasksSha256});
    if(route.targetId==='POST_MAP_WIN'){
     if(priorWitness!==null){
      const first={schema:priorWitness.schema,vector:priorWitness.vector,expectedSchemaHash:priorWitness.descriptor.schemaSha256,projectedRowAuthority:priorWitness.projectedRowAuthority},stillOwned=retainVerifiedProjectedRow(first);assert.ok(stillOwned);stillOwned.release();
      assert.notEqual(priorWitness.schema,held.schema);assert.notEqual(priorWitness.vector,held.vector);
      assert.equal(retainVerifiedProjectedRow({...first,vector:held.vector}),null);
      assert.equal(retainVerifiedProjectedRow({...projection(route),vector:priorWitness.vector}),null);crossPairsRefused+=2;
     }else witness=retainVerifiedProjectedRow(projection(route));
    }
   }finally{held.release();}
  }
  return{receipt:{offset,matchId:data.matchId,seriesId:data.seriesId,historyContextHash:bundle.historyContextHash,sourceInventoryHash:digest(config.sourceInventory),nativeReferenceCount:checked.context.featurePayload.heroMinuteReferences.length,receipts,crossPairsRefused},witness};
 }catch(error){witness?.release();throw error;}finally{bundle?.release();producer?.close();}
}

test('R8 actual canonical POST function identity is stable across nominal context IDs while private rows stay isolated',{skip:!OPT_IN,timeout:1100000},t=>{
 const arena=createDiagnosticResourceArena({maxBytes:8*1024**3}),resourceConfiguration=createDiagnosticResourceConfiguration({profile:RICH_DIAGNOSTIC_RESOURCE_PROFILE,resourceArena:arena}),config=loadLocalUnifiedProducerConfig(),started=performance.now();let first=null,second=null;
 try{
  first=capture(0,{config,arena,resourceConfiguration});assert.ok(first.witness);assert.ok(arena.status().chargedBytes>0,'only the deliberately retained actual row witness survives first owner close');
  second=capture(1,{config,arena,resourceConfiguration,priorWitness:first.witness});assert.equal(second.witness,null);assert.equal(second.receipt.crossPairsRefused,2);
  assert.notEqual(first.receipt.matchId,second.receipt.matchId);assert.notEqual(first.receipt.seriesId,second.receipt.seriesId);assert.notEqual(first.receipt.historyContextHash,second.receipt.historyContextHash);assert.equal(first.receipt.sourceInventoryHash,second.receipt.sourceInventoryHash);
  for(let i=0;i<EXPECTED.length;i++){
   const a=first.receipt.receipts[i],b=second.receipt.receipts[i];
   assert.equal(a.targetId,b.targetId);assert.equal(a.stateMode,b.stateMode);assert.equal(a.featureCount,b.featureCount);assert.equal(a.namesSha256,b.namesSha256);assert.equal(a.producerCompatibilitySha256,b.producerCompatibilitySha256);
   assert.equal(a.functionSha256,b.functionSha256,'same fixed formula/config/hero basis must not fragment estimator identity: '+a.targetId);
   assert.notEqual(a.schemaSha256,b.schemaSha256);assert.notEqual(a.rowParameterBindingsSha256,b.rowParameterBindingsSha256);assert.notEqual(a.contextSha256,b.contextSha256);
  }
 }finally{first?.witness?.release();const status=arena.status();assert.equal(status.chargedBytes,0);assert.equal(status.leases,0);assert.equal(status.heldAssets,0);}
 const body={contract:'aegis.actual-post-function-identity-technical-receipt.v1',sourceInventoryHash:digest(config.sourceInventory),resourceProfile:RICH_DIAGNOSTIC_RESOURCE_PROFILE,sharedArenaGiB:8,ownership:'one complete producer bundle/cache at a time; one explicitly leased first map-head witness overlaps second construction',contexts:[first.receipt,second.receipt],elapsedMs:performance.now()-started,finalArena:arena.status(),actualCanonicalProducer:true,genuineRawBackedSyntheticInputs:true,mockedDefinitions:false,mockedVectors:false,sourceAvailabilityAttested:false,training:false,serving:false,modelQualityEvaluated:false};
 t.diagnostic(JSON.stringify({...body,contentHash:digest(body)}));
});
