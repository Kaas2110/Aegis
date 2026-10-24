import test from 'node:test';import assert from 'node:assert/strict';
import {createUnifiedFeatureProducer,encodeDiagnosticFeatureTrace} from './unifiedFeatureProducer.mjs';
import {createDynamicHistoryProof} from './observedDraftFeatureBundle.mjs';
import {draftArgs,draftEntry,pinned} from './observedDraftHistory.fixtures.mjs';
import {normalizeLocalCapture} from './steamLiveAdapter.mjs';
import {collectDraftHistorySourceExport} from './historySourceExport.mjs';
import {syntheticRegistry} from '../../feature-registry/registry-contract.fixtures.mjs';
const AT='2026-10-23T12:33:00Z';
const sources=()=>Object.fromEntries(['history','live','series','draft','seriesHistory'].map(k=>[k,{primarySha256:'a'.repeat(64),files:[{path:k+'.synthetic.mjs',sha256:'a'.repeat(64)}]}]));
function factory(){const[index,familyDocument,targetDocument]=syntheticRegistry();return createUnifiedFeatureProducer({index,familyDocument,targetDocument,sourceInventory:sources()});}
function live({phase=5}={}){const e=draftEntry({time:'2026-10-23T12:31:00Z',clock:900,accounts:true,phase}),raw=JSON.parse(e.rawInput.utf8),m=JSON.parse(e.metadataInput.utf8);for(const s of ['radiant','dire'])for(const p of raw.result.games[0].scoreboard[s].players)Object.assign(p,{net_worth:5000+p.hero_id*100,gold_per_min:400+p.hero_id,xp_per_min:500+p.hero_id,level:10,gold:100});const rawInput=pinned(raw);const o=normalizeLocalCapture({...m.capture,body:Buffer.from(rawInput.utf8),rawSha256:rawInput.pin.sha256,payloadRef:'journal:'+rawInput.pin.sha256}).observations[0];return{rawInput,metadataInput:pinned({...m,observationId:o.observationId})};}
function series({maps=0}={}){return pinned({contract:'aegis.series-map-receipts.v1',seriesId:'synthetic-series',bestOf:3,team1Id:'100',team2Id:'200',availableAt:'2026-10-23T11:50:00Z',completeThroughMapNumber:maps,previousMaps:Array.from({length:maps},(_,i)=>({mapId:String(8000+i),mapNumber:i+1,winnerTeamId:'100',availableAt:'2026-10-23T11:00:00Z',finishedAt:'2026-10-23T10:58:00Z',durationSeconds:2400,team1Kills:30,team2Kills:20,team1Heroes:[1,2,3,4,5],team2Heroes:[6,7,8,9,10]}))});}
test('actual static/live generation shares one verified history and routes targets separately',()=>{
 const p=factory(),h=createDynamicHistoryProof(draftArgs({accounts:true})),base={matchId:'90001',decisionAt:AT,historyProof:h.proof,seriesInput:series(),currentMapNumber:1};
 const post=p.generateFeatureBundle({...base,mode:'POST'});assert.equal(post.mode,'POST');assert.deepEqual(post.routes.map(r=>r.targetId),['POST_MAP_WIN','POST_KILLS','POST_DURATION','SERIES_LIVE']);assert.ok(post.routes.every(r=>r.inferenceVector===null));assert.equal(post.components.liveInteractions,null);
 const frame=live(),out=p.generateFeatureBundle({...base,mode:'AUTO',livePrefixInputs:[frame]});assert.equal(out.mode,'LIVE');assert.equal(out.historyContextHash,post.historyContextHash);assert.ok(out.routes.find(r=>r.targetId==='LIVE_MAP_WIN').diagnosticVector.names.some(n=>n.startsWith('draft_live.')));assert.equal(out.routes.at(-1).targetId,'SERIES_LIVE');assert.equal(out.routes.at(-1).stateMode,'observed_live');assert.equal(out.eligibleForServing,false);
 const trace=encodeDiagnosticFeatureTrace(out),body=JSON.parse(trace.utf8);assert.ok(trace.vectorPoolSize<out.routes.length);assert.equal(body.nativeRawSha256,frame.rawInput.pin.sha256);assert.ok(!trace.utf8.includes('definitions'));assert.equal(body.historyContextHash,post.historyContextHash);assert.throws(()=>encodeDiagnosticFeatureTrace(out,{maxBytes:1024}),/trace_byte_bound/);assert.ok(p.getSchema(out.routes[0].schemaRef.sha256));
 const replay=p.generateFeatureBundle({...base,mode:'AUTO',livePrefixInputs:[frame]});assert.deepEqual(replay.routes[0].diagnosticVector,out.routes[0].diagnosticVector);assert.equal(replay.routes[0].schemaRef.sha256,out.routes[0].schemaRef.sha256);
});
test('missing live phase never becomes LIVE merely from positive clock',()=>{const p=factory(),h=createDynamicHistoryProof(draftArgs({accounts:true}));const a={matchId:'90001',decisionAt:AT,historyProof:h.proof,livePrefixInputs:[live({phase:null})]};const r=p.generateFeatureBundle({...a,mode:'AUTO'});assert.equal(r.mode,'POST');assert.equal(r.components.liveInteractions,null);assert.match(r.liveRejection,/phase/);assert.throws(()=>p.generateFeatureBundle({...a,mode:'LIVE'}),/phase/);});
test('PRE target rejects current heroes and only projects phase-available history',()=>{
 const p=factory(),a=draftArgs({accounts:true}),facts=JSON.parse(a.factsInput.utf8);facts.scope.targetHeroIds=[];a.factsInput=pinned(facts);
 const target={contract:'aegis.prematch-history-target.v1',matchId:'90001',knownAt:'2026-10-23T11:58:00Z',historyCutoffAt:'2026-10-23T11:58:00Z',teams:{radiant:'100',dire:'200'},players:Array.from({length:10},(_,i)=>({accountId:String(101+i),heroId:null,side:i<5?'radiant':'dire',teamId:i<5?'100':'200'}))};
 const q={mode:'PRE',matchId:'90001',decisionAt:AT,prematchInput:{targetInput:pinned(target),factsInput:a.factsInput},seriesInput:series(),currentMapNumber:1};const r=p.generateFeatureBundle(q);assert.equal(r.mode,'PRE');assert.equal(r.routes.at(-1).targetId,'SERIES_PRE');assert.ok(r.routes.every(h=>!h.diagnosticVector.names.some(n=>n.startsWith('draft_live.'))));assert.ok(r.routes[0].excludedDefinitions.some(d=>d.reason==='current_draft_unavailable_in_phase'));target.players[0].heroId=1;assert.throws(()=>p.generateFeatureBundle({...q,prematchInput:{...q.prematchInput,targetInput:pinned(target)}}),/prematch/);
});
test('between maps consumes prior-map context without stale current-map history',()=>{const p=factory(),r=p.generateFeatureBundle({mode:'BETWEEN',decisionAt:AT,seriesInput:series({maps:1})});assert.equal(r.matchId,null);assert.equal(r.routes.length,1);assert.equal(r.routes[0].targetId,'SERIES_BETWEEN');assert.ok(r.routes[0].diagnosticVector.names.includes('series_context.team1_wins'));assert.ok(!r.routes[0].diagnosticVector.names.includes('series_context.team1_current_hero_repeats'));assert.throws(()=>p.generateFeatureBundle({mode:'BETWEEN',matchId:'90001',decisionAt:AT,seriesInput:series({maps:1})}),/stale_current_map/);});
test('upcoming map PRE after a completed map never substitutes a SERIES_PRE projection for independent BETWEEN history',()=>{
 const p=factory(),facts=JSON.parse(draftArgs({accounts:true}).factsInput.utf8);facts.scope.targetHeroIds=[];
 const target={contract:'aegis.prematch-history-target.v1',matchId:'90001',knownAt:'2026-10-23T11:58:00Z',historyCutoffAt:'2026-10-23T11:58:00Z',teams:{radiant:'100',dire:'200'},players:Array.from({length:10},(_,i)=>({accountId:String(101+i),heroId:null,side:i<5?'radiant':'dire',teamId:i<5?'100':'200'}))};
 const out=p.generateFeatureBundle({mode:'PRE',matchId:'90001',decisionAt:AT,prematchInput:{targetInput:pinned(target),factsInput:pinned(facts)},seriesInput:series({maps:1}),currentMapNumber:2});
 assert.deepEqual(out.routes.map(r=>r.targetId),['PRE_MAP_WIN','PRE_KILLS','PRE_DURATION']);
});
test('serialized proof and future availability do not pass common producer',()=>{const p=factory(),h=createDynamicHistoryProof(draftArgs({accounts:true}));assert.throws(()=>p.generateFeatureBundle({mode:'POST',matchId:'90001',decisionAt:AT,historyProof:structuredClone(h.proof)}),/token_required/);assert.throws(()=>p.generateFeatureBundle({mode:'POST',matchId:'90001',decisionAt:'2026-10-23T12:29:59.999999999Z',historyProof:h.proof}),/times/);});
test('support-policy changes alter common schema even with the same sources and names',()=>{
 const p=factory(),a=draftArgs({accounts:true}),lo=createDynamicHistoryProof({...a,minimumSupport:3}),hi=createDynamicHistoryProof({...a,minimumSupport:5});
 const r=proof=>p.generateFeatureBundle({mode:'POST',matchId:'90001',decisionAt:AT,historyProof:proof});
 const x=r(lo.proof),y=r(hi.proof);assert.deepEqual(x.routes[0].diagnosticVector.names,y.routes[0].diagnosticVector.names);assert.notEqual(x.routes[0].schemaRef.sha256,y.routes[0].schemaRef.sha256);
 assert.ok(p.getSchema(x.routes[0].schemaRef.sha256).definitions.some(d=>d.minimumSupport===3));
 assert.equal(x.availableAt,a.computedAt);
});
test('source revision binds actual facts, native collection and exact draft revision',async()=>{
 const a=draftArgs({accounts:true}),rows=JSON.parse(a.factsInput.utf8).maps.map(m=>({...m,players:m.players.map((p,i)=>({account_id:Number(p.accountId),hero_id:Number(p.heroId),player_slot:p.side==='radiant'?i%5:128+i%5}))}));
 const e=await collectDraftHistorySourceExport({query:async sql=>({rows:sql.includes('FROM pro_matches')?rows:[]})},{...a,now:()=>a.computedAt});
 const b=JSON.parse(e.envelopeInput.utf8),proofArgs={...a,factsInput:b.factsInput,nativeInput:b.nativeInput},h=createDynamicHistoryProof(proofArgs),p=factory();
 const base={mode:'POST',matchId:a.matchId,decisionAt:AT,historyProof:h.proof,sourceExportInput:e.envelopeInput,expectedSourceSnapshotHash:e.sourceSnapshotHash};
 assert.equal(p.generateFeatureBundle(base).sourceSnapshotHash,e.sourceSnapshotHash);
 const f=JSON.parse(b.factsInput.utf8);f.maps[0].radiantWon=!f.maps[0].radiantWon;
 const wrongFacts=createDynamicHistoryProof({...proofArgs,factsInput:pinned(f)});
 assert.throws(()=>p.generateFeatureBundle({...base,historyProof:wrongFacts.proof}),/history_export_facts_binding/);
 const extended=createDynamicHistoryProof({...proofArgs,draftPrefixInputs:[...a.draftPrefixInputs,draftEntry({accounts:true,time:'2026-10-23T12:01:00Z'})]});
 assert.throws(()=>p.generateFeatureBundle({...base,historyProof:extended.proof}),/history_export_context_binding/);
});
test('deployment primary source must be represented in its scoped source inventory',()=>{
 const[index,familyDocument,targetDocument]=syntheticRegistry(),s= sources();s.history.primarySha256='b'.repeat(64);
 assert.throws(()=>createUnifiedFeatureProducer({index,familyDocument,targetDocument,sourceInventory:s}),/source_inventory/);
});
