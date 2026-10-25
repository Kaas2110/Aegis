import test from 'node:test';import assert from 'node:assert/strict';
import {createStaticDiagnosticWriter} from './staticDiagnosticWriter.mjs';
import {createUnifiedFeatureProducer} from './unifiedFeatureProducer.mjs';
import {advanceSeriesHistoryTarget} from './seriesHistoryTarget.mjs';
import {draftArgs,pinned,roster} from './observedDraftHistory.fixtures.mjs';
import {UNIFIED_PRODUCER_CONTRACT} from './unifiedFeatureProducer.mjs';
const AT='2026-10-23T12:40:00Z';
function inputs(maps=0){
 const seriesInput=pinned({contract:'aegis.series-map-receipts.v1',seriesId:'synthetic-series',bestOf:3,team1Id:'100',team2Id:'200',availableAt:maps?'2026-10-23T12:00:00Z':'2026-10-23T11:58:00Z',completeThroughMapNumber:maps,previousMaps:maps?[{mapId:'80001',mapNumber:1,winnerTeamId:'100',availableAt:'2026-10-23T12:00:00Z',finishedAt:'2026-10-23T11:59:00Z',durationSeconds:2400,team1Kills:30,team2Kills:20,team1Heroes:[1,2,3,4,5],team2Heroes:[6,7,8,9,10]}]:[]});
 const identityInput=pinned({contract:'aegis.series-roster-receipt.v1',seriesId:'synthetic-series',team1Id:'100',team2Id:'200',knownAt:maps?'2026-10-23T12:00:00Z':'2026-10-23T11:58:00Z',players:roster().map(p=>({team:p.side==='radiant'?'team1':'team2',accountId:p.accountId}))});
 const target=advanceSeriesHistoryTarget(null,{seriesInput,identityInput,decisionAt:AT}),facts=JSON.parse(draftArgs({accounts:true}).factsInput.utf8);facts.scope.targetHeroIds=[];
 return{seriesInput,seriesHistoryInput:{targetInput:target.targetInput,factsInput:pinned(facts)},decisionAt:AT};
}
test('portable registry and owned writer journal independent series PRE and BETWEEN without map IDs',async()=>{
 const producer=createUnifiedFeatureProducer(),saved=[],journal={writeHistoricalInputs:async()=>({status:'created',reference:{contract:'aegis.static-historical-input-reference.v1',sha256:'a'.repeat(64),bytes:100}}),writeSchema:async({schemaHash})=>({status:'created',schemaHash}),appendTrace:async trace=>{saved.push(JSON.parse(trace.utf8));return{status:'created',sha256:trace.sha256};}};
 assert.equal((await createStaticDiagnosticWriter({producer,journal}).consume({mode:'SERIES_PRE',...inputs()})).reason,'diagnostic_writer_disabled');
 const writer=createStaticDiagnosticWriter({producer,journal,enabled:true,now:()=>AT});
 const pre=await writer.consume({mode:'SERIES_PRE',...inputs()});assert.equal(pre.status,'recorded_diagnostic');assert.deepEqual(pre.targetIds,['SERIES_PRE']);assert.equal(pre.matchId,null);assert.equal(producer.resourceStatus().activeBundles,0);
 const between=await writer.consume({mode:'BETWEEN',...inputs(1)});assert.equal(between.status,'recorded_diagnostic');assert.deepEqual(between.targetIds,['SERIES_BETWEEN']);assert.equal(saved[1].targetBinding.mapOutcome,null);assert.equal(producer.resourceStatus().activeBundles,0);
 assert.ok(saved.every(t=>t.recordedPrediction===false&&t.eligibleForServing===false&&t.timings.featuresReadyAt===AT));
 assert.ok(saved.every(t=>t.historicalInputRef.sha256==='a'.repeat(64)&&t.historicalBindings.factsSha256&&t.historicalBindings.targetSha256));
 const bad=inputs();bad.seriesHistoryInput.targetInput=structuredClone(bad.seriesHistoryInput.targetInput);bad.seriesHistoryInput.targetInput.utf8+=' ';assert.equal((await writer.consume({mode:'SERIES_PRE',...bad})).status,'failed');assert.equal(saved.length,2);assert.equal(producer.resourceStatus().activeBundles,0);producer.close();assert.equal(producer.resourceStatus().resources.chargedBytes,0);
});

function ownedFixture({terminal=false,releaseFailure=false}={}){
 const state={generated:0,released:0,active:0,historicalWrites:0,schemaWrites:0,traceWrites:0,allowed:true,releaseFailure},schemaHash='b'.repeat(64),producer={contract:UNIFIED_PRODUCER_CONTRACT,getSchema:()=>({contract:'synthetic-owned-static-schema',definitions:[{name:'synthetic.static'}]}),generateFeatureBundle(input){
  state.generated++;state.active++;let released=false;const bundle={contract:UNIFIED_PRODUCER_CONTRACT,status:terminal?'series_complete_actual_result':'diagnostic_generated',mode:input.mode,matchId:null,seriesId:'synthetic-owned-series',decisionAt:input.decisionAt,availableAt:input.decisionAt,components:{legacyNative:null,series:null},routes:terminal?[]:[{targetId:'SERIES_PRE',stateMode:'SERIES_PRE',schemaRef:{sha256:schemaHash,featureCount:1},diagnosticVector:{names:['synthetic.static'],values:[0],missing:[false]},inferenceVector:null}],eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false};
  Object.defineProperty(bundle,'release',{enumerable:false,value(){state.released++;assert.equal(released,false,'bundle must release exactly once');released=true;state.active--;if(state.releaseFailure){state.releaseFailure=false;throw Error('synthetic_release_failure');}return true;}});return bundle;
 }},journal={async writeHistoricalInputs(){assert.equal(state.active,1);state.historicalWrites++;return{status:'created',reference:{contract:'aegis.static-historical-input-reference.v1',sha256:'a'.repeat(64),bytes:100}};},async writeSchema({schemaHash}){assert.equal(state.active,1);state.schemaWrites++;return{status:'created',schemaHash};},async appendTrace(trace){assert.equal(state.active,1);state.traceWrites++;return{status:'created',sha256:trace.sha256};}};
 const input={mode:'SERIES_PRE',decisionAt:AT,seriesHistoryInput:{factsInput:pinned({synthetic:true}),targetInput:pinned({synthetic:true})}},writer=createStaticDiagnosticWriter({producer,journal,enabled:true,now:()=>AT,shouldContinue:()=>state.allowed});return{state,journal,input,writer};
}

test('static ownership holds the bundle through every awaited v1 storage port and releases once after success',async()=>{
 const f=ownedFixture();let entered,finish;const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{finish=resolve;}),append=f.journal.appendTrace;f.journal.appendTrace=async trace=>{entered();await gate;assert.equal(f.state.released,0);return append(trace);};
 const pending=f.writer.consume(f.input);await started;assert.equal(f.state.active,1);assert.equal(f.state.released,0);assert.equal((await f.writer.consume(f.input)).reason,'diagnostic_writer_busy');finish();const receipt=await pending;assert.equal(receipt.status,'recorded_diagnostic');assert.equal(receipt.recordedPrediction,false);assert.equal(receipt.eligibleForServing,false);assert.equal(f.state.released,1);assert.equal(f.state.active,0);assert.equal(f.state.traceWrites,1);
});

test('static ownership releases a terminal bundle before its early return without writing inputs or traces',async()=>{
 const f=ownedFixture({terminal:true}),receipt=await f.writer.consume(f.input);assert.equal(receipt.status,'series_complete_actual_result');assert.equal(f.state.released,1);assert.equal(f.state.active,0);assert.equal(f.state.historicalWrites,0);assert.equal(f.state.schemaWrites,0);assert.equal(f.state.traceWrites,0);
});

test('static ownership releases once after each awaited storage failure and STOP boundary, then admits an explicit retry',async()=>{
 for(const boundary of ['historical_error','schema_error','trace_error','stop_after_historical','stop_after_schema']){
  const f=ownedFixture(),name=boundary.includes('historical')?'writeHistoricalInputs':boundary.includes('schema')?'writeSchema':'appendTrace',original=f.journal[name];f.journal[name]=async arg=>{assert.equal(f.state.active,1);await Promise.resolve();assert.equal(f.state.released,0);if(boundary.includes('_error'))throw Error('synthetic_storage_failure');const value=await original(arg);f.state.allowed=false;return value;};
  const receipt=await f.writer.consume(f.input);assert.equal(receipt.status,boundary.includes('_error')?'failed':'blocked',boundary);assert.equal(f.state.released,1,boundary);assert.equal(f.state.active,0,boundary);assert.equal(receipt.recordedPrediction,false);assert.equal(receipt.eligibleForServing,false);if(boundary!=='trace_error')assert.equal(f.state.traceWrites,0,boundary);
  f.state.allowed=true;f.journal[name]=original;assert.equal((await f.writer.consume(f.input)).status,'recorded_diagnostic',boundary);assert.equal(f.state.generated,2,boundary);assert.equal(f.state.released,2,boundary);assert.equal(f.state.active,0,boundary);
 }
});

test('static ownership resets busy even when release itself throws and never reports cleanup failure as success',async()=>{
 const f=ownedFixture({releaseFailure:true});await assert.rejects(f.writer.consume(f.input),/synthetic_release_failure/);assert.equal(f.state.released,1);assert.equal(f.state.active,0);const retry=await f.writer.consume(f.input);assert.equal(retry.status,'recorded_diagnostic');assert.equal(f.state.generated,2);assert.equal(f.state.released,2);assert.equal(f.state.active,0);
});
