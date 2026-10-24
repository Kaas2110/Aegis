import test from 'node:test';
import assert from 'node:assert/strict';
import {createUnifiedFeatureProducer,encodeDiagnosticFeatureTrace} from './unifiedFeatureProducer.mjs';
import {createDynamicHistoryProof} from './observedDraftFeatureBundle.mjs';
import {draftArgs,draftEntry,pinned} from './observedDraftHistory.fixtures.mjs';
import {syntheticRegistry} from '../../feature-registry/registry-contract.fixtures.mjs';
const AT='2026-10-23T12:33:00Z',args=draftArgs({accounts:true}),h=createDynamicHistoryProof(args);
const factory=()=>{const[index,familyDocument,targetDocument]=syntheticRegistry();return createUnifiedFeatureProducer({index,familyDocument,targetDocument,sourceInventory:Object.fromEntries(['history','live','series','draft','seriesHistory'].map(k=>[k,{primarySha256:'a'.repeat(64),files:[{path:k+'.mjs',sha256:'a'.repeat(64)}]}]))});};
const base={matchId:args.matchId,decisionAt:AT,historyProof:h.proof};
const entry=options=>draftEntry({accounts:true,time:'2026-10-23T12:31:00Z',clock:900,...options});
const series=(reverse=false,wrong=false)=>pinned({contract:'aegis.series-map-receipts.v1',seriesId:'synthetic-series',bestOf:3,team1Id:wrong?'300':reverse?'200':'100',team2Id:wrong?'400':reverse?'100':'200',availableAt:'2026-10-23T11:50:00Z',completeThroughMapNumber:0,previousMaps:[]});

test('terminal, outcome, invalid and roster-mismatched live inputs never yield a fresh POST fallback',()=>{
 const p=factory();for(const options of [{phase:6},{phase:5,outcome:true},{phase:99},{phase:5,missingHero:true},{phase:5,accounts:false}])assert.throws(()=>p.generateFeatureBundle({...base,mode:'AUTO',livePrefixInputs:[entry(options)]}),/current_observation/);
});
test('unclassified static draft retains exact source and late-cohort evidence in durable trace',()=>{
 const p=factory(),e=entry({phase:null}),b=p.generateFeatureBundle({...base,mode:'AUTO',livePrefixInputs:[e]}),t=JSON.parse(encodeDiagnosticFeatureTrace(b).utf8);
 assert.equal(b.mode,'POST');assert.equal(t.sourceAdmission.classification,'unclassified_static_draft_only');assert.equal(t.sourceAdmission.dynamicDiagnosticAllowed,false);assert.equal(t.sourceAdmission.provenance.providerGameClockSeconds,900);assert.equal(t.inputSourceBindings[0].rawSha256,e.rawInput.pin.sha256);assert.equal(t.inputSourceBindings[0].metadataSha256,e.metadataInput.pin.sha256);assert.equal(t.liveRejection,'phase_absent_complete_draft_only');assert.equal(t.draftObservation.firstObservationCohort,'game_clock_unknown');assert.equal(t.draftObservation.firstCompleteObservationId,h.context.draftState.firstCompleteObservationId);assert.equal(t.targetBinding.mapOutcome,'map_radiant_win');
});
test('live state cannot silently downgrade to static history or be forced into POST',()=>{
 const p=factory(),b=p.generateFeatureBundle({...base,mode:'LIVE',livePrefixInputs:[entry({phase:5})]});
 assert.throws(()=>p.generateFeatureBundle({...base,previousLiveState:b.nextLiveState,livePrefixInputs:[entry({phase:null,time:'2026-10-23T12:32:00Z'})]}),/no_static_downgrade/);
 assert.throws(()=>p.generateFeatureBundle({...base,mode:'POST',livePrefixInputs:[entry({phase:5})]}),/explicit_post_on_live/);
 assert.throws(()=>p.generateFeatureBundle({...base,mode:'AUTO',previousLiveState:b.nextLiveState}),/live_prefix_required/);
});
test('series target binds exact teams and supplies current map side to the feature vector',()=>{
 const p=factory();for(const reverse of [false,true]){const b=p.generateFeatureBundle({...base,mode:'POST',seriesInput:series(reverse),currentMapNumber:1}),r=b.routes.find(x=>x.targetId==='SERIES_LIVE'),i=r.diagnosticVector.names.indexOf('series_context.team1_current_side_sign');assert.ok(i>=0);assert.equal(r.diagnosticVector.values[i],reverse?-1:1);assert.equal(b.targetBinding.series.team1CurrentSide,reverse?'dire':'radiant');}
 assert.throws(()=>p.generateFeatureBundle({...base,mode:'POST',seriesInput:series(false,true),currentMapNumber:1}),/series_current_team_orientation/);
});
test('PRE historical teams cannot be attached to an unrelated series',()=>{
 const p=factory(),f=JSON.parse(args.factsInput.utf8);f.scope.targetHeroIds=[];
 const target={contract:'aegis.prematch-history-target.v1',matchId:args.matchId,knownAt:'2026-10-23T11:58:00Z',historyCutoffAt:'2026-10-23T11:58:00Z',teams:{radiant:'100',dire:'200'},players:Array.from({length:10},(_,i)=>({accountId:String(101+i),heroId:null,side:i<5?'radiant':'dire',teamId:i<5?'100':'200'}))};
 const q={mode:'PRE',matchId:args.matchId,decisionAt:AT,prematchInput:{targetInput:pinned(target),factsInput:pinned(f)},currentMapNumber:1};
 assert.throws(()=>p.generateFeatureBundle({...q,seriesInput:series(false,true)}),/series_current_team_orientation/);
 const b=p.generateFeatureBundle({...q,seriesInput:series(true)});assert.equal(b.targetBinding.series.team1CurrentSide,'dire');assert.equal(b.routes.at(-1).targetId,'SERIES_PRE');
});
