import test from 'node:test';
import assert from 'node:assert/strict';
import {createUnifiedFeatureProducer} from './unifiedFeatureProducer.mjs';
import {createDynamicHistoryProof} from './observedDraftFeatureBundle.mjs';
import {draftArgs,draftEntry,pinned,roster} from './observedDraftHistory.fixtures.mjs';
import {normalizeLocalCapture} from './steamLiveAdapter.mjs';
import {syntheticRegistry} from '../../feature-registry/registry-contract.fixtures.mjs';
import {TARGET_IDS} from '../../feature-registry/registry-contract.mjs';
const AT='2026-10-23T12:33:00Z',SERIES='synthetic-twelve-targets';
function series(maps=0){return pinned({contract:'aegis.series-map-receipts.v1',seriesId:SERIES,bestOf:3,team1Id:'200',team2Id:'100',availableAt:'2026-10-23T11:50:00Z',completeThroughMapNumber:maps,previousMaps:maps?[{mapId:'80001',mapNumber:1,winnerTeamId:'200',availableAt:'2026-10-23T11:00:00Z',finishedAt:'2026-10-23T10:58:00Z',durationSeconds:2400,team1Kills:30,team2Kills:20,team1Heroes:[6,7,8,9,10],team2Heroes:[1,2,3,4,5]}]:[]});}
function live({outcome=false}={}){
 const entry=draftEntry({accounts:true,time:'2026-10-23T12:31:00Z',clock:900,phase:5,outcome}),raw=JSON.parse(entry.rawInput.utf8),meta=JSON.parse(entry.metadataInput.utf8);
 for(const side of ['radiant','dire']){raw.result.games[0].scoreboard[side].score=side==='radiant'?20:15;for(const p of raw.result.games[0].scoreboard[side].players)Object.assign(p,{net_worth:5000+p.hero_id*100,gold_per_min:400+p.hero_id,xp_per_min:500+p.hero_id,level:10,gold:100});}
 const rawInput=pinned(raw),observation=normalizeLocalCapture({...meta.capture,body:Buffer.from(rawInput.utf8),rawSha256:rawInput.pin.sha256,payloadRef:'journal:'+rawInput.pin.sha256}).observations[0];return{rawInput,metadataInput:pinned({...meta,observationId:observation.observationId})};
}

// Rich-vector comparisons are exact and stop at the first scalar mismatch.
// Never ask the assertion reporter to construct a whole-vector textual diff.
function sameVector(actual,expected,target){
 for(const key of ['names','values','missing']){
  assert.equal(actual[key].length,expected[key].length,target+':'+key+':length');
  for(let i=0;i<expected[key].length;i++)if(!Object.is(actual[key][i],expected[key][i])){
   assert.fail(target+':'+key+':index='+i+':name='+String(expected.names[i]).slice(0,180)+':actual='+String(actual[key][i]).slice(0,60)+':expected='+String(expected[key][i]).slice(0,60));
  }
 }
}

test('actual common producer composes all12logical targets with map/series identity, causal inputs and totals contracts',()=>{
 const[index,familyDocument,targetDocument]=syntheticRegistry(),sourceInventory=Object.fromEntries(['history','live','series','draft','seriesHistory'].map(k=>[k,{primarySha256:'a'.repeat(64),files:[{path:k+'.synthetic.mjs',sha256:'a'.repeat(64)}]}])),producer=createUnifiedFeatureProducer({index,familyDocument,targetDocument,sourceInventory}),args=draftArgs({accounts:true}),history=createDynamicHistoryProof(args);
 const facts=JSON.parse(args.factsInput.utf8),preFacts=structuredClone(facts);preFacts.scope.targetHeroIds=[];
 const target={contract:'aegis.prematch-history-target.v1',matchId:args.matchId,knownAt:'2026-10-23T11:58:00Z',historyCutoffAt:'2026-10-23T11:58:00Z',teams:{radiant:'100',dire:'200'},players:roster().map(p=>({...p,heroId:null}))};
 const base={matchId:args.matchId,decisionAt:AT,seriesInput:series(),currentMapNumber:1};
 const pre=producer.generateFeatureBundle({...base,mode:'PRE',prematchInput:{targetInput:pinned(target),factsInput:pinned(preFacts)}});
 const post=producer.generateFeatureBundle({...base,mode:'POST',historyProof:history.proof});
 const running=producer.generateFeatureBundle({...base,mode:'LIVE',historyProof:history.proof,livePrefixInputs:[live()]});
 const between=producer.generateFeatureBundle({mode:'BETWEEN',decisionAt:AT,seriesInput:series(1)});
 assert.deepEqual(pre.routes.map(r=>r.targetId),['PRE_MAP_WIN','PRE_KILLS','PRE_DURATION','SERIES_PRE']);assert.deepEqual(post.routes.map(r=>r.targetId),['POST_MAP_WIN','POST_KILLS','POST_DURATION','SERIES_LIVE']);assert.deepEqual(running.routes.map(r=>r.targetId),['LIVE_MAP_WIN','LIVE_KILLS','LIVE_DURATION','SERIES_LIVE']);assert.deepEqual(between.routes.map(r=>r.targetId),['SERIES_BETWEEN']);
 const all=[pre,post,running,between],uniqueTargets=[...new Set(all.flatMap(b=>b.routes.map(r=>r.targetId)))].sort();assert.deepEqual(uniqueTargets,[...TARGET_IDS].sort());assert.equal(uniqueTargets.length,12);
 for(const b of all){assert.equal(b.eligibleForTraining,false);assert.equal(b.eligibleForServing,false);assert.equal(b.recordedPrediction,false);assert.equal(b.targetBinding.series.seriesId,SERIES);assert.equal(b.targetBinding.series.outcome,'series_team1_win');
  for(const r of b.routes){assert.equal(r.inferenceVector,null);assert.equal(r.eligibleForTraining,false);assert.equal(r.eligibleForServing,false);const schema=producer.getSchema(r.schemaRef.sha256);assert.equal(schema.targetId,r.targetId);assert.equal(schema.stateMode,r.stateMode);assert.ok(schema.definitions.every(d=>!d.inputScopes.includes('current_map_label')));assert.ok(!schema.definitions.some(d=>d.inputScopes.includes('presentation')));
   if(b.mode==='PRE'||b.mode==='BETWEEN')assert.ok(schema.definitions.every(d=>!d.inputScopes.includes('current_draft')&&!d.inputScopes.includes('current_live')));
  }
 }
 for(const b of [pre,post,running]){assert.equal(b.targetBinding.mapId,args.matchId);assert.equal(b.targetBinding.mapOutcome,'map_radiant_win');assert.equal(b.targetBinding.series.team1CurrentSide,'dire');assert.notEqual(b.targetBinding.mapOutcome,b.targetBinding.series.outcome);}
 assert.equal(between.matchId,null);assert.equal(between.targetBinding.mapOutcome,null);assert.equal(between.targetBinding.series.team1CurrentSide,null);
 const targetOf=id=>targetDocument.targets.find(t=>t.id===id).target;
 for(const phase of ['PRE','POST']){assert.equal(targetOf(phase+'_KILLS'),'map_total_kills_distribution');assert.equal(targetOf(phase+'_DURATION'),'map_total_duration_seconds_distribution');}
 assert.equal(targetOf('LIVE_KILLS'),'remaining_kills_distribution');assert.equal(targetOf('LIVE_DURATION'),'remaining_duration_seconds_distribution');
 const liveSchema=producer.getSchema(running.routes[0].schemaRef.sha256),defs=new Map(liveSchema.definitions.map(d=>[d.name,d])),values=new Map(running.routes[0].diagnosticVector.names.map((name,i)=>[name,running.routes[0].diagnosticVector.values[i]]));
 assert.equal(defs.get('draft_live.base.clock_seconds').units,'game_seconds');assert.equal(values.get('draft_live.base.clock_seconds'),900);assert.equal(defs.get('draft_live.base.total_kills').units,'kills');assert.equal(values.get('draft_live.base.total_kills'),35);
 assert.ok(producer.getSchema(post.routes[0].schemaRef.sha256).definitions.some(d=>d.units==='seconds'&&d.inputScopes.includes('prior_maps')));
 // A historical final label observed just after frozen history cutoff cannot alter
 // any POST/series feature. Current-map final results are rejected, never features.
 const futureFacts=structuredClone(facts);futureFacts.maps.push({...structuredClone(facts.maps[0]),matchId:'77777',outcomeKnownAt:'2026-10-23T11:58:00.000000001Z',playersKnownAt:'2026-10-23T11:58:00.000000001Z',radiantWon:!facts.maps[0].radiantWon});
 futureFacts.scope.rowCount=futureFacts.maps.length;assert.equal(futureFacts.scope.rowCount,6);
 const futureHistory=createDynamicHistoryProof({...args,factsInput:pinned(futureFacts)}),unchanged=producer.generateFeatureBundle({...base,mode:'POST',historyProof:futureHistory.proof});
 for(let i=0;i<post.routes.length;i++)sameVector(unchanged.routes[i].diagnosticVector,post.routes[i].diagnosticVector,post.routes[i].targetId);
 const illegal=structuredClone(facts);illegal.maps.push({...structuredClone(facts.maps[0]),matchId:args.matchId});assert.throws(()=>createDynamicHistoryProof({...args,factsInput:pinned(illegal)}),/current_map_facts_not_allowed/);
 assert.throws(()=>producer.generateFeatureBundle({...base,mode:'LIVE',historyProof:history.proof,livePrefixInputs:[live({outcome:true})]}),/current_observation|terminal|outcome/);
});
