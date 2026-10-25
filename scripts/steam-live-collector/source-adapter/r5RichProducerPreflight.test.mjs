import test from 'node:test';import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {syntheticRichProducerFixture} from './r5RichProducer.fixtures.mjs';

test('actual canonical rich producer retains broad draft/history/live projections before sustained acceptance',{skip:process.env.AEGIS_R5_RICH_ACCEPTANCE!=='1'},()=>{
 const started=performance.now(),f=syntheticRichProducerFixture(),draft=f.generate(),afterDraft=performance.now(),live=f.generate(30),afterLive=performance.now();
 assert.deepEqual(draft.routes.map(r=>r.targetId),['POST_MAP_WIN','POST_KILLS','POST_DURATION','SERIES_LIVE']);assert.deepEqual(live.routes.map(r=>r.targetId),['LIVE_MAP_WIN','LIVE_KILLS','LIVE_DURATION','SERIES_LIVE']);
 assert.equal(draft.historyCutoffAt,'2026-10-23T12:30:00Z');assert.equal(live.historyCutoffAt,draft.historyCutoffAt);assert.equal(live.historyContextHash,draft.historyContextHash);
 assert.ok(live.routes.every(r=>r.diagnosticVector.names.length>30000));assert.ok(live.routes[0].diagnosticVector.names.some(n=>n.startsWith('draft_live.')));assert.equal(live.eligibleForServing,false);assert.equal(live.eligibleForTraining,false);
 const report={contract:'aegis.r5-rich-producer-preflight.v1',syntheticInputs:true,canonicalProducer:true,draftMs:afterDraft-started,firstLiveMs:afterLive-afterDraft,routes:live.routes.map(r=>({targetId:r.targetId,columns:r.schemaRef.featureCount,schema:r.schemaRef.sha256})),rss:process.memoryUsage().rss,heapUsed:process.memoryUsage().heapUsed,maxRssBytes:process.resourceUsage().maxRSS*1024,trained:false};
 console.log(JSON.stringify(report));assert.ok(report.draftMs<=30000,'R5 cold producer target exceeded; do not silently raise the target');assert.ok(report.firstLiveMs<=30000,'R5 first-live producer target exceeded');
});
