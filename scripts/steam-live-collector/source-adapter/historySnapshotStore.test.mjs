import test from 'node:test';
import assert from 'node:assert/strict';
import {DRAFT_CONTRACT,FREEZE_POLICY,draftHash} from './observedDraft.mjs';
import {historySnapshotIdentity,buildHistorySnapshot,verifyHistorySnapshot,createHistorySnapshotStore as createStore,SELECT_SNAPSHOT_SQL,INSERT_SNAPSHOT_SQL} from './historySnapshotStore.mjs';
const at='2026-10-23T12:00:00.000000001Z',sha=x=>draftHash(x);
const createHistorySnapshotStore=(pool,options={})=>createStore(pool,{now:()=>at,...options});
function draft(){
 const identity={players:[],draftHash:sha('draft'),rosterHash:sha('roster'),sideIdentityHash:sha('side')};
 const body={contract:DRAFT_CONTRACT,matchId:'90001',sourceProfile:'steam.GetLiveLeagueGames.v1.scoreboard',cutoffPolicy:FREEZE_POLICY,historyCutoffAt:at,firstCompleteObservationId:sha('first'),revision:0,validFromObservationId:sha('first'),validFrom:at,identity,lastObservationId:sha('first'),lastReceivedAt:at};
 return {...body,stateHash:sha(body)};
}
function identity(extra={}){return historySnapshotIdentity({draftState:draft(),producerVersion:'diagnostic.v1',schemaHash:sha('schema'),sourceSnapshotHash:sha('facts'),patchEvidenceHash:sha('patch'),availabilityBasis:'database_timestamp_reconstruction',...extra});}
function payload(){return {featurePayload:{players:[{heroId:1,form:null,support:0}]},dependencies:[{kind:'outcome',matchId:'100',availableAt:'2026-10-22T12:00:00Z',endedAt:'2026-10-22T11:59:00Z',value:true,sha256:sha('old-outcome'),evidenceRef:'synthetic:prior-map-100'}]};}
function fakePool(){
 const rows=new Map();let transactions=0,releases=0;const queries=[];
 return {rows,queries,get transactions(){return transactions;},get releases(){return releases;},async connect(){return {async query(sql,params=[]){queries.push(sql);
  if(sql==='BEGIN'){transactions++;return {rows:[]};}
  if(sql==='COMMIT'||sql==='ROLLBACK'||sql.startsWith('SELECT pg_advisory')||sql.startsWith('SELECT set_config'))return {rows:[]};
  if(sql===SELECT_SNAPSHOT_SQL)return {rows:rows.has(params[0])?[{snapshot:structuredClone(rows.get(params[0]))}]:[]};
  if(sql===INSERT_SNAPSHOT_SQL){if(rows.has(params[0]))return {rows:[]};const s=JSON.parse(params[5]);rows.set(params[0],s);return {rows:[{snapshot:structuredClone(s)}]};}
  throw Error('unexpected_sql');},release(){releases++;}};}};
}
test('one hundred concurrent local readers cause one export and committed snapshot',async()=>{
 const db=fakePool(),store=createHistorySnapshotStore(db);let builds=0;
 const all=await Promise.all(Array.from({length:100},()=>store.getOrCreate(identity(),{build:async()=>{builds++;await Promise.resolve();return payload();}})));
 assert.equal(builds,1);assert.equal(db.rows.size,1);assert.equal(db.transactions,1);assert.equal(db.releases,1);
 assert.ok(all.every(x=>x.contentHash===all[0].contentHash));
 all[0].payload.featurePayload.players[0].form=999;assert.equal(all[1].payload.featurePayload.players[0].form,null);
});
test('a new store after restart retrieves original immutable context without rebuilding',async()=>{
 const db=fakePool(),i=identity(),s=await createHistorySnapshotStore(db).getOrCreate(i,{build:async()=>payload()});
 const next=await createHistorySnapshotStore(db).getOrCreate(i,{build:async()=>{throw Error('should_not_rebuild');}});
 assert.deepEqual(next,s);
 const ref=await createHistorySnapshotStore(db).loadRef({cacheKey:s.cacheKey,contentHash:s.contentHash},{matchId:'90001',decisionAt:at});assert.deepEqual(ref,s);
});
test('ordinary later packets retain cache key for the same draft identity revision',()=>{
 const first=draft(),next=structuredClone(first);next.lastObservationId=sha('later');next.lastReceivedAt='2026-10-23T12:00:30Z';
 const {stateHash,...body}=next;next.stateHash=sha(body);
 assert.deepEqual(identity({draftState:first}),identity({draftState:next}));
});
test('late account identity version uses original cutoff but a distinct cache key',()=>{
 const d=draft();d.revision=1;d.validFrom='2026-10-23T12:00:30Z';d.validFromObservationId=sha('disclosure');d.identity.rosterHash=sha('revealed');
 const {stateHash,...body}=d;d.stateHash=sha(body);const old=identity(),next=identity({draftState:d});
 assert.equal(next.historyCutoffAt,old.historyCutoffAt);assert.notEqual(sha(next),sha(old));
 const s=buildHistorySnapshot(next,payload(),{generatedAt:d.validFrom});
 assert.throws(()=>verifyHistorySnapshot(s,{decisionAt:at}),/not_yet_valid/);
});
test('one-nanosecond future fact and current-map history are rejected',()=>{
 for(const change of [p=>p.dependencies[0].availableAt='2026-10-23T12:00:00.000000002Z',p=>p.dependencies[0].matchId='90001']){
  const p=payload();change(p);assert.throws(()=>buildHistorySnapshot(identity(),p,{generatedAt:at}),/future_or_unproven|current_map/);
 }
});
test('every prior-map metric needs completed outcome proof',()=>{
 const p=payload();p.dependencies.push({kind:'native_frame',matchId:'101',availableAt:'2026-10-22T12:00:00Z',sha256:sha('frame'),evidenceRef:'synthetic:frame'});
 assert.throws(()=>buildHistorySnapshot(identity(),p,{generatedAt:at}),/prior_completion/);
});
test('learned state/fold/cohort identity is required and changes key',()=>{
 const base={learnedTransformStateSha256:sha('state'),fitPartition:'TRAIN',trainingSplitSha256:sha('split'),foldId:'fold1',cohortId:'strict-equal'};
 assert.notEqual(sha(identity({learnedState:base})),sha(identity({learnedState:{...base,foldId:'fold2'}})));
 assert.throws(()=>identity({learnedState:{...base,fitPartition:'TEST'}}),/learned_state_binding/);
});
test('late materialization requires explicit reconstruction and generation time is hashed',()=>{
 const s=buildHistorySnapshot(identity(),payload(),{generatedAt:'2026-10-24T00:00:00Z'});
 assert.throws(()=>verifyHistorySnapshot(s,{decisionAt:at}),/not_yet_materialized/);
 assert.equal(verifyHistorySnapshot(s,{decisionAt:at,readMode:'reconstructed'}),s);
 const modified=structuredClone(s);modified.generatedAt=at;
 assert.throws(()=>verifyHistorySnapshot(modified),/hash_or_identity_mismatch/);
});
test('payload/hash/reference tampering and wrong-map read are detected',async()=>{
 const db=fakePool(),store=createHistorySnapshotStore(db),s=await store.getOrCreate(identity(),{build:async()=>payload()});
 const changed=structuredClone(s);changed.payload.featurePayload.players[0].form=1;
 assert.throws(()=>verifyHistorySnapshot(changed),/hash_or_identity_mismatch/);
 await assert.rejects(store.loadRef({cacheKey:s.cacheKey,contentHash:s.contentHash},{matchId:'90002',decisionAt:at}),/reader_match/);
 await assert.rejects(store.loadRef({cacheKey:s.cacheKey,contentHash:sha('wrong')},{matchId:'90001',decisionAt:at}),/reference_hash/);
});
test('failed build rolls back, releases connection and does not poison next attempt',async()=>{
 const db=fakePool(),store=createHistorySnapshotStore(db);
 await assert.rejects(store.getOrCreate(identity(),{build:async()=>{throw Error('bounded_failure');}}),/bounded_failure/);
 assert.equal(db.rows.size,0);assert.ok(db.queries.includes('ROLLBACK'));assert.equal(db.releases,1);
 await store.getOrCreate(identity(),{build:async()=>payload()});assert.equal(db.rows.size,1);
});
test('invalid JSON, oversized nesting and explicit current-label payload are rejected',()=>{
 for(const p of [{...payload(),label:true},{...payload(),featurePayload:{form:NaN}},{...payload(),featurePayload:{form:undefined}}])assert.throws(()=>buildHistorySnapshot(identity(),p,{generatedAt:at}),/not_json|current_label/);
});
test('pool acquisition times out and releases a connection which arrives later',async()=>{
 let resolve,released=0;const pending=new Promise(r=>{resolve=r;});
 const store=createHistorySnapshotStore({connect:()=>pending},{acquireTimeoutMs:5});
 await assert.rejects(store.getOrCreate(identity(),{build:async()=>payload()}),/pool_timeout/);
 resolve({release(){released++;}});await Promise.resolve();await Promise.resolve();assert.equal(released,1);
});
test('cooperative build deadline rolls back without caching partial data',async()=>{
 const db=fakePool(),store=createHistorySnapshotStore(db,{buildTimeoutMs:5});
 await assert.rejects(store.getOrCreate(identity(),{build:async({signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))}),/build_timeout/);
 assert.equal(db.rows.size,0);assert.equal(db.releases,1);assert.ok(db.queries.some(s=>s.startsWith('SELECT set_config')));
});
test('caller deadline does not release a still-running noncooperative builder',async()=>{
 const db=fakePool(),store=createHistorySnapshotStore(db,{requestTimeoutMs:5,buildTimeoutMs:10});let finish;
 await assert.rejects(store.getOrCreate(identity(),{build:async()=>new Promise(resolve=>{finish=resolve;})}),/request_timeout/);
 assert.equal(db.releases,0);finish(payload());await new Promise(resolve=>setTimeout(resolve,1));assert.equal(db.releases,1);
});
test('caller identity mutation during pool wait cannot shift cutoff or corrupt cache key',async()=>{
 const db=fakePool();let release;const gate=new Promise(resolve=>{release=resolve;});
 const pool={async connect(){await gate;return db.connect();}},store=createHistorySnapshotStore(pool),i=identity(),original=structuredClone(i);
 const promise=store.getOrCreate(i,{build:async({historyCutoffAt})=>{assert.equal(historyCutoffAt,at);return payload();}});
 i.historyCutoffAt='2026-10-23T13:00:00Z';i.validFrom=i.historyCutoffAt;release();
 const result=await promise;assert.deepEqual(result.identity,original);assert.equal(result.cacheKey,sha(original));
});
test('store owns completion time and rejects caller backdating',async()=>{
 const db=fakePool(),completedAt='2026-10-23T12:01:00Z',store=createHistorySnapshotStore(db,{now:()=>completedAt});
 await assert.rejects(store.getOrCreate(identity(),{generatedAt:at,build:async()=>payload()}),/materialization_clock_owned/);
 const s=await store.getOrCreate(identity(),{build:async()=>payload()});assert.equal(s.generatedAt,completedAt);
 assert.throws(()=>verifyHistorySnapshot(s,{decisionAt:at}),/not_yet_materialized/);
});
