/** Synthetic resource checks, separated from full-rich cadence acceptance.
 * No provider/DB/model, and no invented private admission or temporal checkpoint. */
import test from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRetainedFeaturePipeline} from './retainedFeaturePipeline.mjs';
import {UNIFIED_PRODUCER_CONTRACT} from './unifiedFeatureProducer.mjs';
import {createDynamicHistoryProof,advanceObservedDraftFeatureBundle} from './observedDraftFeatureBundle.mjs';
import {normalizeLocalCapture} from './steamLiveAdapter.mjs';
import {draftArgs} from './observedDraftHistory.fixtures.mjs';
import {DRAFT_METADATA_CONTRACT} from './observedDraftHistory.mjs';
const start=Date.parse('2026-10-23T12:30:00Z');
const hash=x=>createHash('sha256').update(x).digest('hex');
const pin=(value,name)=>{const utf8=typeof value==='string'?value:JSON.stringify(value);return{utf8,pin:{path:name,bytes:Buffer.byteLength(utf8),sha256:hash(utf8)}};};
function capture(index,{stepSeconds=2,twoMaps=true,accounts=index>=1201,failed=false,missingSecond=false,explicitPhase=false}={}){
 const receivedAt=new Date(start+index*stepSeconds*1000).toISOString(),clock=600+index*stepSeconds;
 const game=map=>({match_id:map===0?90001:90002,...(explicitPhase?{game_state:5}:{}),radiant_team:{team_id:100+map*200},dire_team:{team_id:200+map*200},scoreboard:{duration:clock,roshan_respawn_timer:0,...Object.fromEntries(['radiant','dire'].map((side,s)=>[side,{score:10+s+Math.floor(index/60),players:Array.from({length:5},(_,n)=>({hero_id:1+s*5+n,...(accounts?{account_id:1+s*5+n+map*10}:{}),net_worth:5000+index+n,gold_per_min:400+n,xp_per_min:500+n,level:10,kills:n,death:1,assists:2}))}]))}});
 const games=[game(0),...(twoMaps&&!missingSecond?[game(1)]:[])],rawInput=pin(failed?'<synthetic HTTP failure>':{result:{games}},'synthetic/raw.body');
 const requestId=String(start+index*stepSeconds*1000)+'-00000000-0000-0000-0000-'+String(index).padStart(12,'0');
 const receiptInput=pin({version:'steam-live-diagnostic-collector.v1',source:'steam',endpoint:'GetLiveLeagueGames/v1',httpStatus:failed?500:200,status:failed?'http_error':'captured_diagnostic',diagnosticOnly:true,servingEnabled:false,trainingEnabled:false,publicPromotion:false,requestId,requestStartedAt:receivedAt,receivedAt,rawPersistedAt:receivedAt,completedAt:receivedAt,rawSha256:rawInput.pin.sha256,rawFile:'raw/'+rawInput.pin.sha256+'.body',payloadRef:'journal:'+rawInput.pin.sha256,bodyBytes:rawInput.pin.bytes},'synthetic/receipt.json');
 return{rawInput,receiptInput,receivedAt};
}

test('two-map >80-minute2s retained replay bounds identity anchors without invoking rich generation',async t=>{
 let materializations=0,generations=0,writes=0,currentAt=new Date(start).toISOString();
 const unreachable=()=>{materializations++;throw Error('source work forbidden in replay-only source test');};
 const producer={contract:UNIFIED_PRODUCER_CONTRACT,generateFeatureBundle(){generations++;throw Error('rich generation forbidden in source-only replay');},getSchema(){throw Error('schema generation forbidden');}};
 const pipeline=createRetainedFeaturePipeline({producer,sourceStore:{put:unreachable,load:unreachable},historyRevisions:{getOrCreate:unreachable},historySourceFactory:unreachable,historyProfileSha256:'a'.repeat(64),featureJournal:{writeSchema(){writes++;throw Error('no schema write');},appendTrace(){writes++;throw Error('no trace write');},loadTrace(){throw Error('no trace restoration');}},now:()=>currentAt,limits:{maxMaps:2,maxFramesPerMap:4,maxPrefixBytesPerMap:1024*1024}});
 const wall=performance.now(),cpu=process.cpuUsage(),rssBefore=process.memoryUsage().rss;let sampledPeakRss=rssBefore,blockedCaptures=0,sourceOnlyMapRows=0;
 const captures=2403;
 for(let i=0;i<captures;i++){
  const input=capture(i,{failed:i===600,missingSecond:i===1200});currentAt=input.receivedAt;
  const output=await pipeline.consumeCapture({rawInput:input.rawInput,receiptInput:input.receiptInput},{replayOnly:true});
  if(i===600){assert.equal(output.status,'blocked');blockedCaptures++;}
  else{assert.equal(output.status,'processed_diagnostic');assert.ok(output.results.every(r=>r.status==='replayed_source_only'),JSON.stringify(output.results));sourceOnlyMapRows+=output.results.length;}
  if(i%100===0){const s=pipeline.status();assert.ok(s.tracked.every(m=>m.retainedDraftFrames<=3&&m.identityAnchors<=2));sampledPeakRss=Math.max(sampledPeakRss,process.memoryUsage().rss);}
 }
 const status=pipeline.status(),elapsedMs=performance.now()-wall,used=process.cpuUsage(cpu);sampledPeakRss=Math.max(sampledPeakRss,process.memoryUsage().rss);
 assert.equal(status.maps,2);assert.ok(status.tracked.every(m=>m.captureCount>2400&&m.retainedDraftFrames===3&&m.identityAnchors===2));
 assert.equal(materializations,0);assert.equal(generations,0);assert.equal(writes,0);assert.equal(blockedCaptures,1);assert.equal(sourceOnlyMapRows,4803);
 t.diagnostic(JSON.stringify({scope:'source_prefix_and_capture_barriers_only_not_full_rich_service',captures,mapRows:sourceOnlyMapRows,elapsedSourceSeconds:(captures-1)*2,elapsedMs,cpuUserMs:used.user/1000,cpuSystemMs:used.system/1000,rssBeforeBytes:rssBefore,sampledPeakRssBytes:sampledPeakRss,processLifetimeMaxRssBytes:process.resourceUsage().maxRSS*1024,tracked:status.tracked,sourceFactoryCalls:materializations,generationCalls:generations,journalWrites:writes,realRows:0,providerCalls:0,fullRichTwoSecondAcceptance:false}));
});

test('actual rich private-state replay retains a bounded630s native history supporting600s trajectories',t=>{
 const history=createDynamicHistoryProof(draftArgs({accounts:true}));let previous=null,last=null,maxNativeFrames=0;
 const wall=performance.now(),rssBefore=process.memoryUsage().rss;let sampledPeakRss=rssBefore;
 for(let i=0;i<26;i++){
  const original=capture(i,{stepSeconds:30,twoMaps:false,accounts:true,explicitPhase:true}),r=JSON.parse(original.receiptInput.utf8);
  const current={endpoint:r.endpoint,httpStatus:r.httpStatus,requestStartedAt:r.requestStartedAt,receivedAt:r.receivedAt,persistedAt:r.rawPersistedAt,authenticatedAttempt:true};
  const observation=normalizeLocalCapture({...current,body:Buffer.from(original.rawInput.utf8),rawSha256:r.rawSha256,payloadRef:r.payloadRef}).observations[0];
  const metadataInput=pin({contract:DRAFT_METADATA_CONTRACT,matchId:'90001',observationId:observation.observationId,decisionAt:r.completedAt,capture:current},'synthetic/draft-metadata.json');
  last=advanceObservedDraftFeatureBundle(previous,{matchId:'90001',decisionAt:r.completedAt,historyProof:history.proof,livePrefixInputs:[{rawInput:original.rawInput,metadataInput}]});
  assert.equal(last.status,'diagnostic_produced',last.reason);previous=last.state;
  const retained=last.nativeBundle.state.history;maxNativeFrames=Math.max(maxNativeFrames,retained.length);assert.ok(retained.length<=22);assert.ok(retained.every(o=>o.providerGameClockSeconds.value>=600+i*30-630));
  sampledPeakRss=Math.max(sampledPeakRss,process.memoryUsage().rss);
 }
 const name='draft_live.trajectory.score_diff.past_600s.observations',index=last.vector.names.indexOf(name);assert.notEqual(index,-1);assert.ok(last.vector.values[index]>=20&&last.vector.values[index]<=22);
 assert.equal(maxNativeFrames,22);assert.equal(last.eligibleForTraining,false);assert.equal(last.eligibleForServing,false);
 t.diagnostic(JSON.stringify({scope:'26_synthetic_rich_frames_at30s_not_two_second_service',frames:26,elapsedSourceSeconds:750,elapsedMs:performance.now()-wall,maxNativeFrames,nativeRetentionSeconds:630,trajectoryWindowSeconds:600,trajectoryObservationCount:last.vector.values[index],featureCount:last.vector.featureCount,rssBeforeBytes:rssBefore,sampledPeakRssBytes:sampledPeakRss,processLifetimeMaxRssBytes:process.resourceUsage().maxRSS*1024,opaqueStateOnly:true,realRows:0,providerCalls:0,fullRichTwoSecondAcceptance:false}));
});
