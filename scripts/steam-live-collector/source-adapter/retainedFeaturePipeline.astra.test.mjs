import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRetainedFeaturePipeline} from './retainedFeaturePipeline.mjs';
import {createUnifiedFeatureProducer} from './unifiedFeatureProducer.mjs';
import {normalizeLocalCapture} from './steamLiveAdapter.mjs';
import {draftArgs,draftEntry,pinned} from './observedDraftHistory.fixtures.mjs';
import {syntheticRegistry} from '../../feature-registry/registry-contract.fixtures.mjs';
const NOW='2026-10-23T12:40:00Z';
function fixture(){
 const a=draftArgs({accounts:true}),rows=JSON.parse(a.factsInput.utf8).maps.map(m=>({...m,players:m.players.map((p,i)=>({account_id:Number(p.accountId),hero_id:Number(p.heroId),player_slot:p.side==='radiant'?i%5:128+i%5,historical_performance:{}}))}));
 const objects=new Map(),revisions=new Map();let queries=0,writes=0;
 const [index,familyDocument,targetDocument]=syntheticRegistry();
 const producer=createUnifiedFeatureProducer({index,familyDocument,targetDocument,sourceInventory:Object.fromEntries(['history','live','series','draft','seriesHistory'].map(k=>[k,{primarySha256:'a'.repeat(64),files:[{path:k+'.mjs',sha256:'a'.repeat(64)}]}]))});
 const pipeline=createRetainedFeaturePipeline({producer,now:()=>NOW,historyProfileSha256:'b'.repeat(64),
  db:{async query(sql){queries++;return {rows:structuredClone(sql.includes('FROM pro_matches')?rows:[])};}},
  sourceStore:{async put(e){objects.set(e.sourceSnapshotHash,e);return {reference:e.reference,sourceSnapshotHash:e.sourceSnapshotHash};},async load(r){return objects.get(r.sha256);}},
  historyRevisions:{async getOrCreate(key,fn){if(!revisions.has(key))revisions.set(key,await fn({}));return revisions.get(key);}},
  featureJournal:{async writeSchema({schemaHash}){writes++;return {status:'created',schemaHash};},async appendTrace(e){writes++;return {status:'created',sha256:e.sha256};}}});
 return {pipeline,get queries(){return queries;},get writes(){return writes;}};
}
function capture(options={},edit=null){
 const e=draftEntry({accounts:true,...options});let rawInput=e.rawInput,m=JSON.parse(e.metadataInput.utf8);
 if(edit){const raw=JSON.parse(rawInput.utf8);edit(raw.result.games[0]);rawInput=pinned(raw);const o=normalizeLocalCapture({...m.capture,body:Buffer.from(rawInput.utf8),rawSha256:rawInput.pin.sha256,payloadRef:'journal:'+rawInput.pin.sha256}).observations[0];m={...m,observationId:o.observationId};}
 const requestId=String(Date.parse(m.capture.receivedAt))+'-'+randomUUID();
 return {rawInput,receiptInput:pinned({version:'steam-live-diagnostic-collector.v1',source:'steam',endpoint:'GetLiveLeagueGames/v1',httpStatus:200,status:'captured_diagnostic',diagnosticOnly:true,servingEnabled:false,trainingEnabled:false,publicPromotion:false,requestId,requestStartedAt:m.capture.requestStartedAt,receivedAt:m.capture.receivedAt,rawPersistedAt:m.capture.persistedAt,completedAt:m.capture.persistedAt,rawSha256:rawInput.pin.sha256,rawFile:'raw/'+rawInput.pin.sha256+'.body'})};
}

test('invalid or incomplete later packet is not appended or sticky and valid live capture recovers with the same history',async()=>{
 const f=fixture(),p=f.pipeline,first=await p.consumeCapture(capture({phase:4,clock:0}));assert.equal(first.results[0].status,'recorded_diagnostic');
 const staleTerminal=await p.consumeCapture(capture({phase:6,time:'2026-10-23T11:57:59.999999999Z'}));
 assert.equal(staleTerminal.results[0].reason,'out_of_order_retained_capture');
 for(const options of [{phase:99},{phase:7},{phase:5,clock:null},{phase:4,missingHero:true}]){
  const r=await p.consumeCapture(capture({time:'2026-10-23T12:10:00Z',clock:600,...options}));
  assert.equal(r.results[0].status,'blocked');assert.match(r.results[0].reason,/^current_source_rejected:/);
 }
 const next=await p.consumeCapture(capture({phase:5,clock:660,time:'2026-10-23T12:11:00Z'}));
 assert.equal(next.results[0].status,'recorded_diagnostic');assert.equal(next.results[0].mode,'LIVE');assert.equal(f.queries,2);
});

test('explicit post-game and normalized outcome close source without guessing a winner or automatically reopening',async()=>{
 for(const options of [{phase:6},{phase:5,outcome:true}]){
  const f=fixture(),closed=await f.pipeline.consumeCapture(capture(options));
  assert.equal(closed.results[0].status,'source_closed');assert.equal(closed.results[0].reason,'terminal_source_closed');
  assert.equal(Object.hasOwn(closed.results[0],'actualWinnerTeamId'),false);
  const retainedTerminal=structuredClone(closed.results[0].terminalSource);closed.results[0].terminalSource.classification='caller_edit';
  const later=await f.pipeline.consumeCapture(capture({phase:5,clock:900,time:'2026-10-23T12:15:00Z'}));
  assert.equal(later.results[0].status,'source_closed');assert.deepEqual(later.results[0].terminalSource,retainedTerminal);
  assert.equal(f.queries,0);assert.equal(f.writes,0);
 }
});

test('actual known-account contradiction still quarantines the map until explicit host release',async()=>{
 const f=fixture(),first=await f.pipeline.consumeCapture(capture({phase:4}));assert.equal(first.results[0].status,'recorded_diagnostic');
 const changed=await f.pipeline.consumeCapture(capture({phase:5,clock:600,time:'2026-10-23T12:10:00Z'},g=>{g.scoreboard.radiant.players[0].account_id=777;}));
 assert.equal(changed.results[0].reason,'draft_identity_requires_manual_review');
 const later=await f.pipeline.consumeCapture(capture({phase:5,clock:900,time:'2026-10-23T12:15:00Z'}));
 assert.equal(later.results[0].reason,'draft_identity_requires_manual_review');assert.equal(f.queries,2);
});
