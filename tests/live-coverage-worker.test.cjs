const test=require('node:test'),assert=require('node:assert/strict');
const {loader,services}=require('./coverage-loader.cjs');
function workerHarness(){
  const state={now:1700000000000,coverage:[],captures:[],planHook:null,finishHook:null,feed:[],settings:{liveWorkerLiveSec:120,liveWorkerIdleSec:600},logs:[],timers:[],cleared:[],heartbeats:[],calls:0};
  const log={};for(const level of ['info','warn','error'])log[level]=(...args)=>state.logs.push({level,args});
  const noop=()=>{},asyncNoop=async()=>{};
  const journal={LiveJournalContext:class{unavailable(){} predicted(){}},flushLivePredictionJournal:asyncNoop};
  const returning=rows=>({returning:async()=>rows.map((r,i)=>({id:i+1,matchId:r.matchId}))});
  const stubs={
    '@workspace/db':{db:{insert:()=>({values:returning}),select:()=>({from:()=>({where:async()=>[]})})},
      liveSnapshotsTable:{},predictionsTable:{},proMatchesTable:{matchId:'match_id'}},
    'drizzle-orm':{and:noop,inArray:noop,sql:noop},'../lib/logger':{logger:log},
    './PredictionModel':{loadActiveModel:asyncNoop,getActiveModel:()=>null,predictMatchWinner:async()=>null},
    './LiveWinnerModel':{loadActiveLiveModel:asyncNoop,getActiveLiveModel:()=>null,predictLiveWinner:()=>null},
    './AsymLiveModel':{loadActiveAsymLiveModel:asyncNoop,getActiveAsymLiveModel:()=>null,predictAsymLiveWinner:()=>null},
    './AsymPrematchModel':{isAsymEligible:()=>false},'./OutcomeTracker':{recordPrematchPrediction:asyncNoop},
    './MarketLgbm':{predictLiveTotalsFor:async()=>({})},'./LiveTotalsDiagnostics':{recordLiveTotalsRefusals:noop},
    './OpenDotaLiveFeed':{refreshOpenDotaLiveFeed:async()=>{state.calls++;if(state.feed instanceof Error)throw state.feed;return {data:state.feed,fetchedAt:new Date(state.now)};}},
    './LiveCoverageJournal':{
      planLiveCoverage:async(delay,mode,cause)=>{const ticket={id:String(state.coverage.length),runId:'a',plannedAt:state.now,dueAt:state.now+delay,delayMs:delay,mode,cause};const c={ticket,attemptedAt:null,receivedAt:null,sourceOutcome:'not_attempted',packets:[]};state.coverage.push({kind:'plan',ticket});state.captures.push(c);if(state.planHook)await state.planHook();return c;},
      captureCoverageFeed:(c,data,date)=>{c.sourceOutcome=data.length?'success':'empty';c.receivedAt=date.getTime();c.packets=data;state.coverage.push({kind:'capture',count:data.length});},
      captureCoverageFailure:(c)=>{c.sourceOutcome='error';},
      finishLiveCoverage:async(c,workerOutcome)=>{if(c.finished)return;c.finished=true;if(state.finishHook)await state.finishHook();state.coverage.push({kind:'poll',sourceOutcome:c.sourceOutcome,workerOutcome,attemptedAt:c.attemptedAt,receivedAt:c.receivedAt});},
    },
    './workerHeartbeats':{recordHeartbeat:(name,value)=>state.heartbeats.push(value)},
    './AppSettings':{getAppSettings:async()=>{if(state.settings instanceof Error)throw state.settings;return state.settings;}},
    './LivePredictionJournal':journal,'./LiveWinnerShadow':{enqueueLiveWinnerShadow:noop},
    '../lib/openDotaLiveIds':{safeOpenDotaId:v=>Number.isSafeInteger(v)&&v>0?v:null},
  };
  class FakeDate extends Date {constructor(...args){super(...(args.length?args:[state.now]));}static now(){return state.now;}}
  const globals={Date:FakeDate,setTimeout:(fn,ms)=>{const timer={fn,ms};state.timers.push(timer);return timer;},
    clearTimeout:t=>{state.cleared.push(t);state.timers=state.timers.filter(x=>x!==t);},process:{once:noop}};
  const worker=loader(stubs,globals)(services+'LiveWorker.ts');
  async function settle(){for(let i=0;i<10;i++)await Promise.resolve();}
  async function tick(){await settle();const timer=state.timers.shift();assert.ok(timer,'missing scheduled timer');state.now+=timer.ms;await timer.fn();await settle();}
  function assertDelay(expected,mode){
    assert.equal(state.timers.length,1);assert.equal(state.timers[0].ms,expected);
    const events=state.logs.filter(l=>l.args[1]==='[LiveWorker] next poll scheduled');
    const last=events.at(-1).args[0];assert.deepEqual(last,{nextDelayMs:expected,mode,dueAt:state.now+expected});
    const falsePromises=state.logs.filter(l=>l.args[1]!=='[LiveWorker] next poll scheduled'&&l.args[0]?.nextDelayMs!==undefined);
    assert.equal(falsePromises.length,0,'only the actual scheduled timer may claim nextDelayMs');
  }
  return {state,worker,tick,settle,assertDelay};
}
const populated=()=>[{match_id:123,team_id_radiant:1,team_id_dire:2,game_time:600,radiant_score:1,dire_score:0,radiant_lead:500}];

test('real worker cold failure schedules240s, not the600s idle timer; log equals timer',async()=>{
  const h=workerHarness();h.worker.startLiveWorker();await h.settle();h.assertDelay(5000,'unknown');
  h.state.feed=new Error('upstream_temporarily_unavailable');await h.tick();h.assertDelay(240000,'unknown');
  assert.equal(h.state.calls,1);assert.equal(h.state.heartbeats[0].ok,false);
  await h.tick();h.assertDelay(480000,'unknown');await h.tick();h.assertDelay(600000,'unknown');
  await h.tick();h.assertDelay(600000,'unknown');
});
test('real worker first populated response selects active and success resets failure backoff',async()=>{
  const h=workerHarness();h.worker.startLiveWorker();h.state.feed=new Error('temporary');await h.tick();
  h.state.feed=populated();await h.tick();h.assertDelay(120000,'live');
  h.state.feed=new Error('temporary');await h.tick();h.assertDelay(240000,'live');
  h.state.feed=populated();await h.tick();h.assertDelay(120000,'live');
});
test('real worker only successful empty response selects idle; populated switches back',async()=>{
  const h=workerHarness();h.worker.startLiveWorker();await h.tick();h.assertDelay(600000,'idle');
  h.state.feed=new Error('temporary');await h.tick();h.assertDelay(600000,'idle');
  h.state.feed=populated();await h.tick();h.assertDelay(120000,'live');
  h.state.feed=[];await h.tick();h.assertDelay(600000,'idle');
});
test('configured/hot-reloaded intervals and DB settings failure preserve floor and exact log',async()=>{
  const h=workerHarness();h.worker.startLiveWorker();h.state.settings={liveWorkerLiveSec:3,liveWorkerIdleSec:700};
  h.state.feed=populated();await h.tick();h.assertDelay(120000,'live');
  h.state.settings={liveWorkerLiveSec:180,liveWorkerIdleSec:700};await h.tick();h.assertDelay(180000,'live');
  h.state.feed=[];await h.tick();h.assertDelay(700000,'idle');
  h.state.settings=new Error('DB unavailable');await h.tick();h.assertDelay(600000,'idle');
});
test('start remains idempotent; stop clears timer; stopped module cannot restart; fresh process is unknown',async()=>{
  const h=workerHarness();h.worker.startLiveWorker();h.worker.startLiveWorker();await h.settle();h.assertDelay(5000,'unknown');
  const queued=h.state.timers[0];h.worker.stopLiveWorker();assert.equal(h.state.timers.length,0);
  h.worker.startLiveWorker();assert.equal(h.state.timers.length,0);
  await queued.fn();assert.equal(h.state.calls,0);assert.equal(h.state.timers.length,0);
  const fresh=workerHarness();fresh.worker.startLiveWorker();await fresh.settle();fresh.assertDelay(5000,'unknown');
});
test('stop during outstanding collector creates no next timer or next-delay log',async()=>{
  const h=workerHarness();h.worker.startLiveWorker();
  // Stop while the asynchronous tick is running, before its finally reschedules.
  await h.settle();const running=h.tick();await h.settle();h.worker.stopLiveWorker();await running;
  assert.equal(h.state.timers.length,0);
  assert.equal(h.state.logs.filter(l=>l.args[1]==='[LiveWorker] next poll scheduled').length,1);
});


test('all successful responses captured before dedup; unchanged maps and successful empty still journalled',async()=>{
 const h=workerHarness();h.worker.startLiveWorker();h.state.feed=populated();await h.tick();await h.tick();h.state.feed=[];await h.tick();
 assert.equal(h.state.coverage.filter(e=>e.kind==='capture').length,3);
 assert.deepEqual(h.state.coverage.filter(e=>e.kind==='poll').map(e=>e.sourceOutcome),['success','success','empty']);
 assert.equal(h.worker.getWorkerStats().skippedUnchanged,1);
});
test('source failure preserves attempted time, no invented receipt and actual retry plan',async()=>{
 const h=workerHarness();h.worker.startLiveWorker();h.state.feed=Error('provider failed');await h.tick();
 const p=h.state.coverage.find(e=>e.kind==='poll');assert.equal(p.sourceOutcome,'error');assert.equal(p.attemptedAt,h.state.now);assert.equal(p.receivedAt,null);
 assert.equal(h.state.coverage.filter(e=>e.kind==='plan').at(-1).ticket.cause,'backoff');h.assertDelay(240000,'unknown');
});
test('stop while durable planning pending journals cancellation and never installs a timer',async()=>{
 const h=workerHarness();let release;h.state.planHook=()=>new Promise(r=>release=r);h.worker.startLiveWorker();h.worker.startLiveWorker();
 assert.equal(h.state.coverage.length,1);h.worker.stopLiveWorker();release();await h.settle();assert.equal(h.state.timers.length,0);
 assert.equal(h.state.coverage.filter(e=>e.kind==='poll').length,1);assert.equal(h.state.coverage.at(-1).workerOutcome,'stopped');assert.equal(h.state.calls,0);
});
test('fsync duration does not shift planned deadline; logged delay equals actual timer',async()=>{
 const h=workerHarness();h.state.planHook=async()=>{h.state.now+=31;};h.worker.startLiveWorker();await h.settle();h.assertDelay(4969,'unknown');
});

test('start remains idempotent while terminal journal fsync is pending',async()=>{
 const h=workerHarness();let release;h.state.finishHook=()=>new Promise(r=>release=r);h.worker.startLiveWorker();await h.settle();
 const running=h.tick();for(let i=0;i<100&&!release;i++)await Promise.resolve();assert.ok(release);const before=h.state.coverage.filter(e=>e.kind==='plan').length;h.worker.startLiveWorker();assert.equal(h.state.coverage.filter(e=>e.kind==='plan').length,before);
 release();await running;assert.equal(h.state.timers.length,1);h.assertDelay(600000,'idle');
});
