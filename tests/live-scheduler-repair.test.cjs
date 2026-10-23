// Focused tests execute the staged real worker/feed modules with in-memory dependencies.
// No provider, database, server or OS timer is used.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const test=require('node:test'),assert=require('node:assert/strict');
const root=fs.existsSync(path.join(__dirname,'artifacts'))?__dirname:path.resolve(__dirname,'..');
const dependencyRoot=process.env.AEGIS_TEST_REPO_ROOT||root;
const ts=require(path.join(dependencyRoot,'node_modules/typescript/lib/typescript.js'));
const lib=root+'/artifacts/api-server/src/lib/',services=root+'/artifacts/api-server/src/services/';
function loader(stubs={},globals={}) {
  const cache=new Map();
  function load(file){
    file=path.resolve(file);if(cache.has(file))return cache.get(file).exports;
    const module={exports:{}};cache.set(file,module);
    const source=fs.existsSync(file)?file:path.join(dependencyRoot,path.relative(root,file));
    const code=ts.transpileModule(fs.readFileSync(source,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
    const req=name=>{
      if(Object.hasOwn(stubs,name))return stubs[name];
      if(name.startsWith('.'))return load(path.resolve(path.dirname(file),name)+'.ts');
      return require(name);
    };
    const names=['require','module','exports',...Object.keys(globals)];
    vm.compileFunction(code,names,{filename:file})(req,module,module.exports,...Object.values(globals));
    return module.exports;
  }
  return load;
}
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


test('safe classifier accepts only bounded typed HTTP statuses and rejects forged/raw messages',()=>{
  const m=loader()(lib+'providerFeedError.ts');
  for(const code of [100,200,403,429,502,599])assert.deepEqual(m.classifyProviderFeedError(new m.ProviderFeedHttpError(code)),{category:'http',httpStatus:code});
  for(const code of [0,99,600,Infinity,NaN,502.5,'502'])assert.deepEqual(m.classifyProviderFeedError(new m.ProviderFeedHttpError(code)),{category:'unknown'});
  for(const error of [new Error('https://bad.example/?token=SECRET HTTP503'),{name:'ProviderFeedHttpError',httpStatus:503},
    {name:'OdQuotaExhaustedError',code:'OD_DEFERRED',message:'SECRET'}])assert.deepEqual(m.classifyProviderFeedError(error),{category:'unknown'});
});
test('safe classifier walks bounded nested fetch causes and timeout/abort without exposing messages',()=>{
  const m=loader()(lib+'providerFeedError.ts');
  for(const code of ['ECONNRESET','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT']){
    const inner=Object.assign(new Error('SECRET'),{code});
    assert.deepEqual(m.classifyProviderFeedError(new Error('fetch failed',{cause:new Error('wrapper',{cause:inner})})),{category:'network',networkCode:code});
  }
  assert.deepEqual(m.classifyProviderFeedError(Object.assign(new Error('SECRET'),{name:'TimeoutError'})),{category:'timeout'});
  assert.deepEqual(m.classifyProviderFeedError({cause:{name:'AbortError',message:'SECRET'}}),{category:'aborted'});
  assert.deepEqual(m.classifyProviderFeedError({code:'EVIL_URL_SECRET'}),{category:'unknown'});
  const cyclic={};cyclic.cause=cyclic;assert.deepEqual(m.classifyProviderFeedError(cyclic),{category:'unknown'});
  assert.deepEqual(m.classifyProviderFeedError({get name(){throw Error('SECRET');}}),{category:'unknown'});
});
test('safe classifier distinguishes positively identified quota and invalid payload',()=>{
  const m=loader()(lib+'providerFeedError.ts');
  assert.deepEqual(m.classifyProviderFeedError(new m.ProviderFeedQuotaError()),{category:'quota_deferred'});
  assert.deepEqual(m.classifyProviderFeedError(new m.ProviderFeedPayloadError()),{category:'invalid_payload'});
  assert.deepEqual(m.classifyProviderFeedError(new SyntaxError('response has SECRET')),{category:'invalid_payload'});
});
test('diagnostic callback gets safe fields only; callback throw leaves retained snapshot and generic error unchanged',async()=>{
  const load=loader(),m=load(lib+'providerFeedError.ts'),b=load(lib+'backgroundFeed.ts');
  const original={data:[42],receivedAt:'2026-10-01T00:00:00Z',attemptedAt:'2026-10-01T00:00:00Z',error:null};
  let saved,calls=0,diagnostic;
  const feed=b.createBackgroundFeed({load:async()=>original,save:async v=>{saved=v;}},async()=>{calls++;throw Object.assign(new m.ProviderFeedHttpError(502),{token:'SECRET',url:'SECRET'});},()=>1000,
    v=>v,info=>{diagnostic=info;throw new Error('diagnostics sink failed SECRET');});
  for(let i=0;i<3;i++)await feed.read();assert.equal(calls,0);
  const result=await feed.refresh();assert.equal(calls,1);assert.deepEqual(result.data,[42]);
  assert.equal(result.receivedAt,original.receivedAt);assert.equal(result.error,'upstream_temporarily_unavailable');
  assert.deepEqual(diagnostic,{category:'http',httpStatus:502});assert.deepEqual(saved,result);
  assert.ok(!JSON.stringify({result,diagnostic}).includes('SECRET'));
});
test('actual ProviderFeeds records safe HTTP/network/known-quota categories, no raw fields',async()=>{
  const logs=[],stores=new Map();let current;
  class KnownQuota extends Error {constructor(reason){super('SECRET raw quota URL');this.reason=reason;}}
  const fakeFetch=async()=>{if(current instanceof Error)throw current;return current;};
  const pool={query:async(sql,args)=>{
    if(sql.startsWith('SELECT'))return {rows:stores.has(args[0])?[stores.get(args[0])]:[]};
    stores.set(args[0],{payload:JSON.parse(args[1]),received_at:args[2]?new Date(args[2]):null,
      attempted_at:args[3]?new Date(args[3]):null,last_error:args[4]});return {rows:[]};
  }};
  const stubs={'@workspace/db':{pool},'@workspace/db/opendota':{openDotaBackgroundFetch:fakeFetch,openDotaLiveFetch:fakeFetch,OdQuotaExhaustedError:KnownQuota},
    '../lib/logger':{logger:{warn:(entry,msg)=>logs.push({entry,msg})}},'./ApiKeysService':{getApiKey:()=>null},
    '../lib/liveStateFreshness':{annotateLiveState:data=>data},'../lib/stratzLiveList':{fetchStratzLiveList:async()=>[]}};
  const p=loader(stubs)(services+'ProviderFeeds.ts');
  for(const [failure,expected] of [[new Response('SECRET',{status:502}),{category:'http',httpStatus:502}],
    [new KnownQuota('upstream_429'),{category:'http',httpStatus:429}],
    [new KnownQuota('upstream_403'),{category:'http',httpStatus:403}],
    [new KnownQuota('daily_limit'),{category:'quota_deferred'}],
    [new Error('SECRET',{cause:{code:'ECONNRESET'}}),{category:'network',networkCode:'ECONNRESET'}],
    [new Response('{"SECRET":"shape"}',{status:200}),{category:'invalid_payload'}]]){
    current=failure;const result=await p.refreshProviderFeed('opendota_live');
    assert.equal(result.error,'upstream_temporarily_unavailable');
    assert.deepEqual(logs.at(-1),{entry:{key:'opendota_live',...expected},msg:'[ProviderFeed] refresh failed'});
    assert.ok(!JSON.stringify(logs).includes('SECRET'));
  }
});

// Retain all pre-existing background-feed invariants, including read-only readers and coalescing.
loader()(root+'/tests/background-feed.test.ts');
