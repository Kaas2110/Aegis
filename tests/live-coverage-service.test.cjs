const test=require('node:test'),assert=require('node:assert/strict');
const {loader,lib,services}=require('./coverage-loader.cjs');
const {randomUUID}=require('node:crypto');
const {emptyCoverageState,applyCoverageOperation}=loader()(lib+'liveCoverageContract.ts');
const T=1700000000000;
function serviceHarness(){const state={queries:[],released:0,existing:false,dbState:emptyCoverageState(),known:[],inserted:null,events:null,updated:null,failInsert:false,queued:[],logs:[],diskFailure:false,summaryFailure:false,dbFailure:false};
 const pool={connect:async()=>({query:async(sql,args)=>{state.queries.push({sql,args});
  if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK')return {rows:[],rowCount:0};
  if(sql.startsWith('SELECT id FROM'))return {rows:state.existing?[{id:'exists'}]:[],rowCount:state.existing?1:0};
  if(sql.startsWith('SELECT state,'))return {rows:[{state:state.dbState,now_ms:String(T+10000)}]};
  if(sql.startsWith('SELECT match_id'))return {rows:state.known.map(match_id=>({match_id}))};
  if(sql.startsWith('INSERT INTO live_coverage_operations')){state.inserted=JSON.parse(args[3]);if(state.failInsert)throw Error('DB private SECRET');}
  if(sql.startsWith('INSERT INTO live_coverage_events'))state.events=JSON.parse(args[1]);
  if(sql.startsWith('UPDATE live_coverage_state'))state.updated=JSON.parse(args[0]);
  return {rows:[],rowCount:0};},release:()=>state.released++})};
 class Queue{constructor(dir){state.dir=dir;}async enqueue(raw){if(state.diskFailure)throw Error('DISK SECRET');state.queued.push(raw);}async drain(){if(state.dbFailure)throw Error('DB SECRET');return 0;}}
 const logs={};for(const level of ['info','warn','error'])logs[level]=(...args)=>state.logs.push(args);
 const stubs={'@workspace/db':{pool},'../lib/logger':{logger:logs},'../lib/coverageOutbox':{CoverageOutbox:Queue},
 '../lib/liveStateFreshness':{liveStateHash:()=> 'a'.repeat(64),liveStateFreshness:()=>{if(state.summaryFailure)throw Error('PAYLOAD SECRET');return {eligibleForObservedStatePrediction:true,reason:null,declaredBroadcastDelaySeconds:900};}},
 '../lib/openDotaLiveIds':{safeOpenDotaId:v=>Number.isSafeInteger(v)&&v>0?v:undefined},
 '../lib/providerFeedError':{classifyProviderFeedError:()=>({category:'unknown'})}};
 class FakeDate extends Date{constructor(...args){super(...(args.length?args:[T]));}static now(){return T;}}
 const service=loader(stubs,{Date:FakeDate,process:{env:{AEGIS_STATE_DIR:'C:/aegis-state'}}})(services+'LiveCoverageJournal.ts');
 const ticket={id:randomUUID(),runId:'run-a',plannedAt:T,dueAt:T+5000,delayMs:5000,mode:'unknown',cause:'startup'};
 const plan={id:randomUUID(),sequence:'1',kind:'plan',at:T,ticket};
 return {state,service,plan,ticket};}

test('receipt summary preserves observed zeros, missing fields and no raw provider secrets',async()=>{const h=serviceHarness(),c=await h.service.planLiveCoverage(5000,'unknown','startup');
 const raw=[{match_id:42,team_id_radiant:1,team_id_dire:2,game_time:600,radiant_score:0,dire_score:0,secret:'SECRET'},{game_time:0},{game_time:null}];const original=JSON.stringify(raw);
 h.service.captureCoverageFeed(c,raw,new Date(T));assert.equal(c.sourceOutcome,'success');assert.equal(c.packets[0].state6FieldsComplete,true);assert.equal(c.packets[0].radiantScore,0);
 assert.equal(c.packets[1].state6FieldsComplete,false);assert.equal(c.packets[1].matchId,null);assert.equal(c.packets[2].gameTime,null);assert.ok(!JSON.stringify(c).includes('SECRET'));assert.equal(JSON.stringify(raw),original);
});
test('summary failure never throws into source collector; recorded status explicitly loses availability evidence',async()=>{const h=serviceHarness(),c=await h.service.planLiveCoverage(5000,'unknown','startup');h.state.summaryFailure=true;
 assert.doesNotThrow(()=>h.service.captureCoverageFeed(c,[{match_id:42}],new Date(T)));assert.equal(c.sourceOutcome,'success');assert.equal(c.diagnosticStatus,'packet_summary_failed');assert.deepEqual(c.packets,[]);
 await h.service.finishLiveCoverage(c,'ok');assert.equal(h.state.queued[1].diagnosticStatus,'packet_summary_failed');assert.ok(!JSON.stringify(h.state.logs).includes('SECRET'));
});
test('disk or DB diagnostic failure never throws into worker, and messages do not expose raw errors',async()=>{for(const mode of ['diskFailure','dbFailure']){const h=serviceHarness();h.state[mode]=true;const c=await h.service.planLiveCoverage(5000,'unknown','startup');assert.ok(c.ticket.id);await h.service.finishLiveCoverage(c,'stopped');for(let i=0;i<5;i++)await Promise.resolve();assert.ok(h.state.logs.length);assert.ok(!JSON.stringify(h.state.logs).includes('SECRET'));}});
test('terminal journal callback is idempotent for stop/timer races',async()=>{const h=serviceHarness(),c=await h.service.planLiveCoverage(5000,'unknown','startup');await Promise.all([h.service.finishLiveCoverage(c,'stopped'),h.service.finishLiveCoverage(c,'stopped')]);assert.equal(h.state.queued.filter(e=>e.kind==='poll').length,1);});
test('atomic reducer state/events/raw operation share one transaction and parameterized values',async()=>{const h=serviceHarness();await h.service.persistCoverageOperation(h.plan);assert.equal(h.state.queries[0].sql,'BEGIN');assert.equal(h.state.queries.at(-1).sql,'COMMIT');assert.equal(h.state.released,1);assert.deepEqual(h.state.inserted,h.plan);assert.equal(h.state.updated.lastSequence,'1');assert.equal(h.state.events.length,1);assert.equal(h.state.events[0].detail.meetsVerifiedLiveLatencyPolicy,false);assert.ok(h.state.queries[1].sql.includes('pg_advisory_xact_lock'));});
test('replay after DB commit before outbox deletion is idempotent',async()=>{const h=serviceHarness();h.state.existing=true;await h.service.persistCoverageOperation(h.plan);assert.equal(h.state.queries.at(-1).sql,'COMMIT');assert.equal(h.state.inserted,null);assert.equal(h.state.updated,null);assert.equal(h.state.released,1);});
test('failed raw insert rolls back and does not advance cursor or acknowledge commit',async()=>{const h=serviceHarness();h.state.failInsert=true;await assert.rejects(h.service.persistCoverageOperation(h.plan),/DB private/);assert.equal(h.state.queries.at(-1).sql,'ROLLBACK');assert.equal(h.state.updated,null);assert.equal(h.state.events,null);assert.equal(h.state.released,1);});
test('known outcome closure uses DB observation time rather than historic provider time',async()=>{const h=serviceHarness();let r=applyCoverageOperation(emptyCoverageState(),h.plan,{databaseNow:T,knownOutcomeIds:[]});const p={...h.plan,id:randomUUID(),sequence:'2',kind:'poll',at:T+5000,sourceOutcome:'success',workerOutcome:'ok',attemptedAt:T+5000,receivedAt:T+5000,packets:[{matchId:42,radiantTeamId:1,direTeamId:2,gameTime:0,radiantScore:0,direScore:0,packetHash:'a'.repeat(64),state6FieldsComplete:false,passesLocalSourceGuard:false,freshnessReason:'awaiting_observed_state_progress',declaredDelaySeconds:null}]};r=applyCoverageOperation(r.state,p,{databaseNow:T+5000,knownOutcomeIds:[]});h.state.dbState=r.state;h.state.known=['42'];await h.service.persistCoverageOperation({...h.plan,id:randomUUID(),sequence:'3',at:T+5000});assert.equal(h.state.events.find(e=>e.kind==='scope_exit').detail.effectiveAt,T+10000);assert.equal(h.state.updated.scopes['42'].knownOutcomeAt,T+10000);assert.equal(h.state.updated.scopes['42'].closedAt,null);});
