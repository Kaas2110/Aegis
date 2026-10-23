import test from 'node:test';
import assert from 'node:assert/strict';
import {loadDraftHistoricalContextInputs as load} from './draftHistoricalFactsDb.mjs';
import {loadHistoricalContextInputs as legacy} from './historicalFactsDb.mjs';
import {draftArgs,draftEntry,alignedArgs,pinned} from './observedDraftHistory.fixtures.mjs';
import {produceObservedDraftHistory,replayPinnedDraftPrefix,PRODUCER_CONTRACT} from './observedDraftHistory.mjs';
import {historySnapshotIdentity,createHistorySnapshotStore,SELECT_SNAPSHOT_SQL,INSERT_SNAPSHOT_SQL,verifyHistorySnapshot} from './historySnapshotStore.mjs';
import {evidenceHash} from './playerHeroEconomyFeatures.mjs';
function rows(a=draftArgs()){
 return JSON.parse(a.factsInput.utf8).maps.map(m=>({...m,players:m.players.map((p,i)=>({account_id:Number(p.accountId),hero_id:Number(p.heroId),player_slot:p.side==='radiant'?i%5:128+i%5}))}));
}
function port(maps=rows(),native=[]){const calls=[];return{calls,async query(sql,args){calls.push({sql,args:structuredClone(args)});return{rows:structuredClone(sql.includes('FROM pro_matches')?maps:native.map(normalized_observation=>({normalized_observation})))}}};}
function resultContext(a,r){return produceObservedDraftHistory({...a,factsInput:r.factsInput,nativeInput:r.nativeInput});}

test('anonymous draft queries heroes and teams, never fake account ids',async()=>{
 const a=draftArgs(),db=port(),r=await load(db,a),scope=JSON.parse(r.factsInput.utf8).scope;
 assert.deepEqual(scope.targetAccountIds,[]);assert.deepEqual(scope.targetTeamIds,['100','200']);assert.equal(scope.targetHeroIds.length,10);
 assert.deepEqual(db.calls[0].args[3],[]);assert.equal(r.audit.unknownTargetAccounts,10);
 const p=resultContext(a,r);assert.equal(p.status,'produced_reconstruction');assert.equal(p.context.featurePayload.players.length,0);
 assert.equal(p.context.featurePayload.heroes.length,10);assert.equal(p.context.featurePayload.heroes[0].values.heroLateTendency,1);
 assert.equal(r.audit.rawDraftBytesVerified,true);assert.equal(r.audit.priorNativeRawBytesVerified,false);
});
test('late account disclosure changes selectors but both DB queries use original draft cutoff',async()=>{
 const a=draftArgs();a.draftPrefixInputs.push(draftEntry({time:'2026-10-23T12:15:00Z',accounts:true}));
 const db=port(),r=await load(db,a),scope=JSON.parse(r.factsInput.utf8).scope;
 assert.equal(r.audit.historyCutoffAt,'2026-10-23T11:58:00Z');assert.equal(r.audit.selectorsValidFrom,'2026-10-23T12:15:00Z');
 assert.equal(scope.targetAccountIds.length,10);assert.equal(db.calls[0].args[0],r.audit.historyCutoffAt);assert.equal(db.calls[1].args[2],r.audit.historyCutoffAt);
 const produced=resultContext(a,r);assert.equal(produced.context.featurePayload.players.length,10);assert.ok(produced.context.featurePayload.players.every(p=>p.values.recentForm!==null));
});
test('unknown teams and accounts preserve hero namespace without invented team context',async()=>{
 const a=draftArgs({teams:false}),r=await load(port(),a),scope=JSON.parse(r.factsInput.utf8).scope;
 assert.deepEqual(scope.targetTeamIds,[]);assert.deepEqual(scope.targetAccountIds,[]);assert.equal(scope.targetHeroIds.length,10);
 const p=resultContext(a,r).context.featurePayload;assert.equal(p.players.length,0);assert.ok(p.teams.every(t=>t.teamId===null));assert.equal(p.heroes[0].values.heroLateTendency,1);
});
test('raw prefix tamper fails before any DB query',async()=>{
 const a=draftArgs(),db=port();a.draftPrefixInputs[0].rawInput.utf8+=' ';
 await assert.rejects(load(db,a),/historical_evidence_bytes_mismatch/);assert.equal(db.calls.length,0);
});
test('incomplete draft fails before any DB query',async()=>{
 const a=draftArgs({missingHero:true}),db=port();await assert.rejects(load(db,a),/prefix_not_accepted/);assert.equal(db.calls.length,0);
});
test('future outcome availability by one ns is rejected after query',async()=>{
 const a=draftArgs(),m=rows(a);m[0].outcomeKnownAt=m[0].playersKnownAt='2026-10-23T11:58:00.000000001Z';
 await assert.rejects(load(port(m),a),/identity_or_future/);
});
test('current-map facts and duplicate map identities are rejected',async()=>{
 const a=draftArgs(),m=rows(a);m[0].matchId=a.matchId;await assert.rejects(load(port(m),a),/identity_or_future/);
 const d=rows(a);d.push(d[0]);await assert.rejects(load(port(d),a),/identity_or_future/);
});
test('a truncated local-source population cannot become a qualified cohort',async()=>{
 const a=draftArgs(),db=port();await assert.rejects(load(db,{...a,maxMaps:4}),/map_bound/);assert.equal(db.calls.length,1);assert.equal(db.calls[0].args[5],5);
});
test('out-of-window or unrelated prior facts cannot leak through a wrong DB port',async()=>{
 const a=draftArgs(),m=rows(a);m[0].endedAt='2026-01-01T00:00:00Z';await assert.rejects(load(port(m),a),/values_or_window/);
 const unrelated=rows(a);unrelated[0].radiantTeamId='300';unrelated[0].direTeamId='400';unrelated[0].players=unrelated[0].players.map((p,i)=>({...p,account_id:1000+i,hero_id:100+i}));
 await assert.rejects(load(port(unrelated),a),/outside_selection/);
});
test('nullable kills stay missing without discarding valid team/hero outcome history',async()=>{
 const a=draftArgs(),m=rows(a);m[0].radiantKills=null;m[0].direKills=null;
 const r=await load(port(m),a);assert.equal(JSON.parse(r.factsInput.utf8).maps[0].radiantKills,null);assert.equal(resultContext(a,r).status,'produced_reconstruction');
});
test('native phase5 rows are bounded candidates and do not admit raw-free references',async()=>{
 const a=alignedArgs({explicit:true}),native=JSON.parse(a.nativeInput.utf8).observations,r=await load(port(rows(a),native),a);
 assert.equal(r.nativeCandidates.length,5);assert.ok(r.nativeCandidates.every(c=>c.requiresPinnedEligibility&&c.rawCaptureRequired.reference.startsWith('journal:')));
 assert.equal(r.audit.priorNativeRawBytesVerified,false);assert.equal(r.eligibleForTraining,false);
 const withoutRaw={...a};delete withoutRaw.nativeEvidenceInputs;
 assert.equal(resultContext(withoutRaw,r).context.featurePayload.heroMinuteReferences.length,0);
 const withRaw=resultContext(a,r);assert.ok(withRaw.context.featurePayload.heroMinuteReferences.length>0);
});
test('future native receipt by one ns and current-map native row fail',async()=>{
 const a=alignedArgs({explicit:true}),native=JSON.parse(a.nativeInput.utf8).observations;
 native[0].source.capture.receivedAt='2026-10-23T11:58:00.000000001Z';await assert.rejects(load(port(rows(a),native),a),/native_identity_phase_or_future/);
 native[0].source.capture.receivedAt='2026-10-21T00:00:00Z';native[0].matchId=a.matchId;await assert.rejects(load(port(rows(a),native),a),/native_identity_phase_or_future/);
});
test('phase-absent, terminal and duplicate native records are not strict phase5 candidates',async()=>{
 const a=alignedArgs({explicit:true});
 for(const mutate of [n=>{n[0].dynamic.phase={missing:true,status:'absent',value:null,rawValue:null};},n=>{n[0].sourceQualityReasons.push('outcome_marker_present');},n=>{n.push(n[0]);}]){
  const n=JSON.parse(a.nativeInput.utf8).observations;mutate(n);await assert.rejects(load(port(rows(a),n),a),/native_identity_phase_or_future/);
 }
});
test('native and input limits fail closed',async()=>{
 const a=alignedArgs({explicit:true}),n=JSON.parse(a.nativeInput.utf8).observations;
 await assert.rejects(load(port(rows(a),n),{...a,maxFrames:4}),/native_bound/);
 for(const extra of [{maxMaps:0},{maxFrames:20001},{signal:{aborted:false}}])await assert.rejects(load(port(),{...draftArgs(),...extra}),/input_contract/);
});
test('oversized normalized row and historical roster are rejected',async()=>{
 const a=alignedArgs({explicit:true}),n=JSON.parse(a.nativeInput.utf8).observations;n[0].oversized='x'.repeat(262145);
 await assert.rejects(load(port(rows(a),n),a),/normalized_row_bound/);
 const m=rows(a);m[0].players.push(m[0].players[0]);await assert.rejects(load(port(m),a),/prior_roster_bound/);
});
test('empty cohort returns pinned empty collections and avoids native fanout',async()=>{
 const a=draftArgs(),db=port([]),r=await load(db,a);assert.equal(db.calls.length,1);assert.equal(r.audit.maps,0);assert.equal(r.nativeCandidates.length,0);
 assert.equal(JSON.parse(r.factsInput.utf8).scope.completeWithinSource,true);
});
test('an already aborted builder performs no queries',async()=>{
 const c=new AbortController();c.abort();const db=port();await assert.rejects(load(db,{...draftArgs(),signal:c.signal}),/aborted/);assert.equal(db.calls.length,0);
});
test('abort during an owned query waits for its settlement and starts no later query',async()=>{
 const c=new AbortController();let finish,calls=0,settled=false;
 const db={query:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}};
 const p=load(db,{...draftArgs(),signal:c.signal}).finally(()=>{settled=true;});
 await new Promise(resolve=>setImmediate(resolve));c.abort();await Promise.resolve();assert.equal(settled,false);
 finish({rows:rows()});await assert.rejects(p,/aborted/);assert.equal(calls,1);
});
test('caller mutation during query does not alter disclosed selectors or cutoff',async()=>{
 const a=draftArgs(),db=port();const original=db.query.bind(db);let calls=0;
 db.query=async(sql,args)=>{if(++calls===1){a.draftPrefixInputs.push(draftEntry({time:'2026-10-23T12:15:00Z',accounts:true}));a.computedAt='2026-10-24T00:00:00Z';}return original(sql,args);};
 const r=await load(db,a);assert.equal(r.audit.knownTargetAccounts,0);assert.equal(r.audit.computedAt,'2026-10-23T12:30:00Z');assert.equal(r.audit.historyCutoffAt,'2026-10-23T11:58:00Z');
});
test('the old strict loader still rejects anonymous draft targets instead of accepting fabricated ids',async()=>{
 const state=replayPinnedDraftPrefix(draftArgs()).state;
 await assert.rejects(legacy(port(),{target:{matchId:state.matchId,knownAt:state.historyCutoffAt,frozenBeforeMapAt:state.historyCutoffAt,receivedAt:state.validFrom,players:state.identity.players}}),/input_contract/);
});
test('actual snapshot store callback runs draft DB loader and v3 producer before immutable storage',async()=>{
 const a=draftArgs(),d=replayPinnedDraftPrefix(a).state,source=pinned({rows:rows(a)},'synthetic-source-snapshot.json');
 const identity=historySnapshotIdentity({draftState:d,producerVersion:PRODUCER_CONTRACT,schemaHash:evidenceHash('synthetic-draft-db-schema'),sourceSnapshotHash:source.pin.sha256,patchEvidenceHash:evidenceHash('explicit-unknown-patch'),availabilityBasis:'database_timestamp_reconstruction'});
 const stored=new Map(),calls=[];let releases=0,builds=0;
 const pool={async connect(){return{async query(sql,args=[]){calls.push(sql);
  if(['BEGIN','COMMIT','ROLLBACK'].includes(sql)||sql.startsWith('SELECT set_config')||sql.startsWith('SELECT pg_advisory'))return{rows:[]};
  if(sql===SELECT_SNAPSHOT_SQL)return{rows:stored.has(args[0])?[{snapshot:structuredClone(stored.get(args[0]))}]:[]};
  if(sql===INSERT_SNAPSHOT_SQL){const s=JSON.parse(args[5]);stored.set(args[0],s);return{rows:[{snapshot:s}]};}
  return{rows:sql.includes('FROM pro_matches')?rows(a):[]};
 },release(){releases++;}};}};
 const store=createHistorySnapshotStore(pool,{now:()=>a.computedAt});
 const build=async({db,historyCutoffAt,signal})=>{builds++;const r=await load(db,{...a,signal});assert.equal(r.audit.historyCutoffAt,historyCutoffAt);const p=resultContext(a,r);assert.equal(p.status,'produced_reconstruction');return{featurePayload:p.context.featurePayload,dependencies:p.context.dependencies};};
 const snapshot=await store.getOrCreate(identity,{build});assert.equal(snapshot.payload.featurePayload.players.length,0);assert.equal(snapshot.payload.featurePayload.heroes.length,10);
 assert.equal(verifyHistorySnapshot(snapshot,{matchId:a.matchId,decisionAt:a.computedAt}).contentHash,snapshot.contentHash);
 await store.getOrCreate(identity,{build});assert.equal(builds,1);assert.equal(releases,2);assert.equal(calls.filter(x=>x.includes('FROM pro_matches')).length,1);assert.equal(stored.size,1);
});
