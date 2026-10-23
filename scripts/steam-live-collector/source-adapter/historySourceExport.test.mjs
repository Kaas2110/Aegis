import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,readFile,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {draftArgs,draftEntry,alignedArgs,pinned} from './observedDraftHistory.fixtures.mjs';
import {replayPinnedDraftPrefix,produceObservedDraftHistory} from './observedDraftHistory.mjs';
import {historySnapshotIdentity,buildHistorySnapshot} from './historySnapshotStore.mjs';
import {encodeHistorySourceExport as encode,verifyHistorySourceExport as verify,collectDraftHistorySourceExport as collect,MAX_HISTORY_EXPORT_BYTES} from './historySourceExport.mjs';
import {createHistorySourceExportStore} from './historySourceExportStore.mjs';

const NOW='2026-10-23T12:30:00Z';
const sha=value=>createHash('sha256').update(value).digest('hex');
const fromBody=body=>pinned(body,'synthetic-envelope.json');
function rows(a=draftArgs()){
 return JSON.parse(a.factsInput.utf8).maps.map(m=>({...m,players:m.players.map((p,i)=>({account_id:Number(p.accountId),hero_id:Number(p.heroId),player_slot:p.side==='radiant'?i%5:128+i%5}))}));
}
function dbPort(maps=rows(),native=[]){
 const calls=[];return{calls,async query(sql,args){calls.push({sql,args:structuredClone(args)});return{rows:structuredClone(sql.includes('FROM pro_matches')?maps:native.map(normalized_observation=>({normalized_observation})))}}};
}
const options=a=>({...a,now:()=>NOW});
function rebuild(e,change){
 const b=JSON.parse(e.envelopeInput.utf8);change(b);
 return encode({matchId:b.identity.matchId,computedAt:b.computedAt,exportedAt:b.exportedAt,draftPrefixInputs:b.draftPrefixInputs,factsInput:b.factsInput,nativeInput:b.nativeInput,readReceiptInput:b.readReceiptInput});
}
function mutateFacts(b,change){
 const f=JSON.parse(b.factsInput.utf8);change(f);b.factsInput=pinned(f,'synthetic-prior-facts-mutated.json');
 const r=JSON.parse(b.readReceiptInput.utf8);r.sources.facts.collectionSha256=b.factsInput.pin.sha256;r.sources.facts.rowCount=f.maps.length;b.readReceiptInput=pinned(r,'synthetic-receipt-mutated.json');
}

test('exact facts/native envelope bytes define the history source revision',async()=>{
 const a=draftArgs(),db=dbPort(),e=await collect(db,options(a));
 assert.equal(e.sourceSnapshotHash,sha(e.envelopeInput.utf8));assert.equal(e.reference.bytes,Buffer.byteLength(e.envelopeInput.utf8));
 assert.equal(Object.isFrozen(e),true);assert.equal(Object.isFrozen(e.identity.selectors.targetHeroIds),true);assert.equal(Object.isFrozen(e.envelopeInput.pin),true);
 assert.equal(e.population.facts,'complete_nonempty_within_local_source');assert.equal(e.population.allCollectionsComplete,true);
 const body=JSON.parse(e.envelopeInput.utf8),scope=JSON.parse(body.factsInput.utf8).scope;
 assert.notEqual(e.sourceSnapshotHash,scope.selectionSqlSha256);assert.notEqual(e.sourceSnapshotHash,e.identity.selectorsSha256);
 assert.equal(body.evidencePolicy.mutableDatabaseSnapshot,false);assert.equal(body.evidencePolicy.sourceAuthenticity,'not_independently_attested');
 assert.equal(body.evidencePolicy.priorNativeRawAdmissionPerformed,false);assert.equal(body.eligibleForServing,false);assert.equal(body.eligibleForTraining,false);
 assert.equal(verify(e.envelopeInput,{matchId:a.matchId,decisionAt:NOW,expectedSourceSnapshotHash:e.sourceSnapshotHash}).sourceSnapshotHash,e.sourceSnapshotHash);
});

test('complete empty local population is retained as empty with explicit successful query proof',async()=>{
 const db=dbPort([]),e=await collect(db,options(draftArgs())),b=JSON.parse(e.envelopeInput.utf8),r=JSON.parse(b.readReceiptInput.utf8);
 assert.equal(db.calls.length,1);assert.equal(e.population.facts,'verified_complete_empty_within_local_source');
 assert.deepEqual(JSON.parse(b.factsInput.utf8).maps,[]);assert.deepEqual(JSON.parse(b.nativeInput.utf8).observations,[]);
 assert.equal(r.sources.facts.queryCompleted,true);assert.equal(r.sources.facts.rowCount,0);assert.equal(r.sources.facts.state,'complete');
 assert.equal(r.sources.native.state,'skipped_complete_empty_parent');assert.equal(r.sources.native.queryCompleted,false);
 assert.equal(e.population.zeroHistoryStatisticsInvented,false);
 // Existing v3 calculation is deliberately not weakened to fabricate support.
 const a=draftArgs(),produced=produceObservedDraftHistory({...a,factsInput:b.factsInput,nativeInput:b.nativeInput});
 assert.equal(produced.status,'blocked');assert.equal(produced.context,null);assert.equal(produced.reason,'no_available_prior_maps');
});

test('failed local read is unavailable, never an empty successful population',async()=>{
 const e=await collect({query:async()=>{throw Error('do not retain SQL or credential-like error details');}},options(draftArgs()));
 const b=JSON.parse(e.envelopeInput.utf8),r=JSON.parse(b.readReceiptInput.utf8);
 assert.equal(e.population.facts,'unavailable');assert.equal(e.population.allCollectionsComplete,false);assert.equal(b.factsInput,null);assert.equal(b.nativeInput,null);
 assert.equal(r.sources.facts.state,'failed');assert.equal(r.sources.facts.rowCount,null);assert.equal(r.sources.facts.reason,'bounded_loader_failed');
 assert.equal(e.envelopeInput.utf8.includes('credential-like'),false);
});

test('partial/truncated and missing exports cannot pass as complete empty',async()=>{
 const e=await collect(dbPort(),{...options(draftArgs()),maxMaps:4}),b=JSON.parse(e.envelopeInput.utf8),r=JSON.parse(b.readReceiptInput.utf8);
 assert.equal(r.sources.facts.state,'truncated');assert.equal(r.sources.facts.truncated,true);assert.equal(b.factsInput,null);assert.equal(e.population.facts,'unavailable');
 const empty=await collect(dbPort([]),options(draftArgs()));
 for(const state of ['failed','missing'])assert.throws(()=>rebuild(empty,body=>{const receipt=JSON.parse(body.readReceiptInput.utf8);receipt.sources.facts.state=state;receipt.sources.facts.reason='unavailable';receipt.sources.facts.queryCompleted=false;body.readReceiptInput=pinned(receipt);}),/unavailable_must_not_be_empty_collection/);
});

test('native-query failure cannot turn a partially successful pair into a complete export',async()=>{
 const base=dbPort(),db={async query(sql,args){if(!sql.includes('FROM pro_matches'))throw Error('native query failed');return base.query(sql,args);}};
 const e=await collect(db,options(draftArgs())),body=JSON.parse(e.envelopeInput.utf8),receipt=JSON.parse(body.readReceiptInput.utf8);
 assert.equal(e.population.allCollectionsComplete,false);assert.equal(body.factsInput,null);assert.equal(body.nativeInput,null);
 assert.equal(receipt.sources.facts.state,'failed');assert.equal(receipt.sources.native.state,'missing');
 assert.equal(receipt.sources.facts.reason,'bounded_loader_failed');
});

test('late identity changes selector and export revision while first draft cutoff remains t0',async()=>{
 const a=draftArgs(),first=await collect(dbPort(),options(a));a.draftPrefixInputs.push(draftEntry({accounts:true,time:'2026-10-23T12:15:00Z'}));
 const db=dbPort(),late=await collect(db,options(a));assert.equal(late.identity.historyCutoffAt,first.identity.historyCutoffAt);
 assert.equal(late.identity.validFrom,'2026-10-23T12:15:00Z');assert.equal(first.identity.selectors.targetAccountIds.length,0);assert.equal(late.identity.selectors.targetAccountIds.length,10);
 assert.notEqual(late.identity.draftRevisionHash,first.identity.draftRevisionHash);assert.notEqual(late.sourceSnapshotHash,first.sourceSnapshotHash);
 assert.equal(db.calls[0].args[0],first.identity.historyCutoffAt);assert.equal(db.calls[1].args[2],first.identity.historyCutoffAt);
 assert.throws(()=>verify(late.envelopeInput,{decisionAt:'2026-10-23T12:14:59.999999999Z',readMode:'reconstructed'}),/not_available_at_decision/);
});

test('history snapshot identity binds the actual export source hash and leaves learned TRAIN state external',async()=>{
 const a=draftArgs(),e=await collect(dbPort(),options(a)),replay=replayPinnedDraftPrefix(a);
 const args={draftState:replay.state,producerVersion:'synthetic-producer',schemaHash:sha('schema'),sourceSnapshotHash:e.sourceSnapshotHash,patchEvidenceHash:sha('patch'),availabilityBasis:'database_timestamp_reconstruction'};
 const plain=historySnapshotIdentity(args),learned=historySnapshotIdentity({...args,learnedState:{learnedTransformStateSha256:sha('state'),fitPartition:'TRAIN',trainingSplitSha256:sha('split'),foldId:'fold-1',cohortId:'cohort-1'}});
 assert.equal(plain.sourceSnapshotHash,e.sourceSnapshotHash);assert.equal(plain.learnedState,null);assert.notDeepEqual(learned,plain);
 const snapshot=buildHistorySnapshot(plain,{featurePayload:{sourceExportReference:e.reference},dependencies:[]},{generatedAt:NOW});
 assert.equal(snapshot.identity.sourceSnapshotHash,e.sourceSnapshotHash);assert.equal(snapshot.eligibleForServing,false);
 assert.throws(()=>historySnapshotIdentity({...args,learnedState:{...learned.learnedState,fitPartition:'TEST'}}),/learned_state_binding/);
});

test('changing actual source values with unchanged SQL/selectors creates a new immutable export hash',async()=>{
 const a=draftArgs(),e=await collect(dbPort(),options(a)),changed=rows(a);changed[0].radiantWon=!changed[0].radiantWon;
 const newer=await collect(dbPort(changed),options(a));assert.equal(newer.identity.selectorsSha256,e.identity.selectorsSha256);
 const sql=x=>JSON.parse(JSON.parse(x.envelopeInput.utf8).factsInput.utf8).scope.selectionSqlSha256;
 assert.equal(sql(newer),sql(e));assert.notEqual(newer.sourceSnapshotHash,e.sourceSnapshotHash);
 assert.equal(sha(e.envelopeInput.utf8),e.sourceSnapshotHash);assert.notEqual(JSON.parse(newer.envelopeInput.utf8).factsInput.pin.sha256,JSON.parse(e.envelopeInput.utf8).factsInput.pin.sha256);
});

test('opt-in completed-player performance is retained by exact native field without changing legacy default',async()=>{
 const a=draftArgs(),m=rows(a);
 for(const map of m)for(const p of map.players)p.historical_performance={gold_per_min:450,xp_per_min:600,net_worth:19000,total_gold:24000,gold_spent:16000,hero_damage:12345,kills:8,deaths:2,assists:10};
 const db=dbPort(m),e=await collect(db,{...options(a),includePlayerPerformance:true}),body=JSON.parse(e.envelopeInput.utf8),facts=JSON.parse(body.factsInput.utf8);
 assert.equal(db.calls[0].sql.includes('historical_performance'),true);assert.equal(facts.scope.playerPerformanceIncluded,true);
 const p=facts.maps[0].heroPerformances[0];assert.equal(p.metrics.gpm,450);assert.equal(p.metrics.netWorth,19000);assert.equal(p.metrics.totalGold,24000);assert.equal(p.metrics.goldSpent,16000);assert.equal(p.metrics.observerWardsKilled,null);
 assert.equal(p.knownAt,facts.maps[0].playersKnownAt);assert.equal(p.sourceFields.gpm,'gold_per_min');
 const legacy=await collect(dbPort(m),options(a)),legacyFacts=JSON.parse(JSON.parse(legacy.envelopeInput.utf8).factsInput.utf8);
 assert.equal(legacyFacts.scope.playerPerformanceIncluded,undefined);assert.equal(legacyFacts.maps[0].heroPerformances,undefined);assert.notEqual(legacy.sourceSnapshotHash,e.sourceSnapshotHash);
});

test('repinned future performance timestamp or changed player/hero binding fails source export validation',async()=>{
 const a=draftArgs(),m=rows(a);for(const map of m)for(const p of map.players)p.historical_performance={gold_per_min:450};
 const e=await collect(dbPort(m),{...options(a),includePlayerPerformance:true});
 for(const change of [f=>{f.maps[0].heroPerformances[0].knownAt='2026-10-23T11:58:00.000000001Z';},f=>{f.maps[0].heroPerformances[0].accountId='888';},f=>{f.maps[0].heroPerformances[0].side='dire';},f=>{f.maps[0].heroPerformances[0].sourceFields.gpm='net_worth';}])assert.throws(()=>rebuild(e,b=>mutateFacts(b,change)),/performance_identity_availability_or_values/);
});

test('appending eligible prior source rows creates another export without rewriting the first',async()=>{
 const a=draftArgs(),e=await collect(dbPort(),options(a)),m=rows(a);m.push({...structuredClone(m[0]),matchId:'11001'});
 const newer=await collect(dbPort(m),options(a));assert.notEqual(newer.sourceSnapshotHash,e.sourceSnapshotHash);
 assert.equal(JSON.parse(JSON.parse(e.envelopeInput.utf8).factsInput.utf8).maps.length,5);assert.equal(JSON.parse(JSON.parse(newer.envelopeInput.utf8).factsInput.utf8).maps.length,6);
});

test('outer/inner data tampering fails exact pins and recomputing pins cannot admit future/current-map values',async()=>{
 const e=await collect(dbPort(),options(draftArgs()));
 assert.throws(()=>verify({...e.envelopeInput,utf8:e.envelopeInput.utf8+' '}),/pin_or_bound/);
 const b=JSON.parse(e.envelopeInput.utf8);b.factsInput.utf8+=' ';assert.throws(()=>verify(fromBody(b)),/pin_or_bound/);
 for(const mutate of [f=>{f.maps[0].matchId='90001';},f=>{f.maps[0].outcomeKnownAt='2026-10-23T11:58:00.000000001Z';},f=>{f.maps[0].playersKnownAt='2026-10-23T11:58:00.000000001Z';},f=>{f.maps[0].heroesKnownAt='2026-10-23T11:58:00.000000001Z';}]){
  assert.throws(()=>rebuild(e,body=>mutateFacts(body,mutate)),/current_future_or_invalid_fact/);
 }
});

test('receipt, selector, derived status and draft byte tampering fail independently',async()=>{
 const e=await collect(dbPort(),options(draftArgs()));
 assert.throws(()=>rebuild(e,b=>{const r=JSON.parse(b.readReceiptInput.utf8);r.selectorsSha256=sha('wrong');b.readReceiptInput=pinned(r);}),/receipt_identity_or_time/);
 assert.throws(()=>rebuild(e,b=>mutateFacts(b,f=>{f.scope.targetTeamIds=['300','400'];})),/selector_scope_mismatch/);
 const b=JSON.parse(e.envelopeInput.utf8);b.population.facts='verified_complete_empty_within_local_source';assert.throws(()=>verify(fromBody(b)),/derived_tamper/);
 assert.throws(()=>rebuild(e,b=>{b.draftPrefixInputs[0].rawInput.utf8+=' ';}),/historical_evidence_bytes_mismatch/);
});

test('native data is pinned without falsely admitting raw-free historical player metrics',async()=>{
 const a=alignedArgs({explicit:true}),n=JSON.parse(a.nativeInput.utf8).observations,e=await collect(dbPort(rows(a),n),options(a));
 const b=JSON.parse(e.envelopeInput.utf8);assert.equal(JSON.parse(b.nativeInput.utf8).observations.length,5);assert.equal(b.evidencePolicy.priorNativeRawAdmissionPerformed,false);
 const p=produceObservedDraftHistory({...a,factsInput:b.factsInput,nativeInput:b.nativeInput,nativeEvidenceInputs:[]});assert.equal(p.context.featurePayload.heroMinuteReferences.length,0);
});

test('native current-map or future 1ns retained values fail even if envelope pins are regenerated',async()=>{
 const a=alignedArgs({explicit:true}),n=JSON.parse(a.nativeInput.utf8).observations,e=await collect(dbPort(rows(a),n),options(a));
 for(const mutate of [o=>{o.matchId='90001';},o=>{o.source.capture.receivedAt='2026-10-23T11:58:00.000000001Z';}]){
  assert.throws(()=>rebuild(e,b=>{const native=JSON.parse(b.nativeInput.utf8);mutate(native.observations[0]);b.nativeInput=pinned(native);const r=JSON.parse(b.readReceiptInput.utf8);r.sources.native.collectionSha256=b.nativeInput.pin.sha256;b.readReceiptInput=pinned(r);}),/current_future_or_invalid_native/);
 }
});

test('recorded reads require actual materialization time; explicit reconstruction preserves its label',async()=>{
 const e=await collect(dbPort(),options(draftArgs()));
 assert.throws(()=>verify(e.envelopeInput,{decisionAt:'2026-10-23T12:29:59.999999999Z'}),/not_available_at_decision/);
 assert.equal(verify(e.envelopeInput,{decisionAt:'2026-10-23T12:00:00Z',readMode:'reconstructed'}).sourceSnapshotHash,e.sourceSnapshotHash);
 assert.throws(()=>verify(e.envelopeInput,{matchId:'99999'}),/reader_hash_or_match/);assert.throws(()=>verify(e.envelopeInput,{expectedSourceSnapshotHash:sha('different')}),/reader_hash_or_match/);
});

test('aborted collection is not reclassified or silently retried',async()=>{
 const c=new AbortController();c.abort();const db=dbPort();await assert.rejects(collect(db,{...options(draftArgs()),signal:c.signal}),/aborted/);assert.equal(db.calls.length,0);
});

test('successful zero collections need complete scope and matching counts',async()=>{
 const e=await collect(dbPort([]),options(draftArgs()));
 for(const change of [f=>{delete f.scope.truncated;},f=>{f.scope.completeWithinSource=false;},f=>{f.scope.rowCount=1;}])assert.throws(()=>rebuild(e,b=>mutateFacts(b,change)),/facts_scope/);
 assert.throws(()=>rebuild(e,b=>{const r=JSON.parse(b.readReceiptInput.utf8);r.sources.facts.queryCompleted=false;b.readReceiptInput=pinned(r);}),/complete_receipt_mismatch/);
});

test('a collected receipt cannot claim a mutable DB snapshot or independently attested availability',async()=>{
 const e=await collect(dbPort(),options(draftArgs()));
 for(const change of [r=>{r.databaseSnapshotMode='repeatable_read_mvcc';},r=>{r.independentAvailabilityAttested=true;},r=>{r.completedAt='2026-10-23T12:30:00.000000001Z';}])assert.throws(()=>rebuild(e,b=>{const r=JSON.parse(b.readReceiptInput.utf8);change(r);b.readReceiptInput=pinned(r);}),/receipt_identity_or_time/);
});

test('append-only CAS round trip, concurrent same export, and source append preserve both historical versions',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'aegis-history-export-test-'));
 try{
  const store=await createHistorySourceExportStore(directory),a=draftArgs(),e=await collect(dbPort(),options(a));
  const writes=await Promise.all(Array.from({length:8},()=>store.put(e)));assert.ok(writes.every(x=>x.sourceSnapshotHash===e.sourceSnapshotHash&&x.overwroteExisting===false));
  const loaded=await store.load(e.reference,{matchId:a.matchId,decisionAt:NOW});assert.equal(loaded.envelopeInput.utf8,e.envelopeInput.utf8);
  const m=rows(a);m.push({...structuredClone(m[0]),matchId:'11001'});const other=await collect(dbPort(m),options(a));await store.put(other);
  assert.equal((await store.load(e.reference)).sourceSnapshotHash,e.sourceSnapshotHash);assert.equal((await readdir(directory)).filter(x=>x.endsWith('.history-source.json')).length,2);assert.equal((await readdir(directory)).some(x=>x.endsWith('.tmp')),false);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('CAS corrupt collision fails without overwriting old bytes; reference cannot select arbitrary paths',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'aegis-history-export-test-'));
 try{
  const store=await createHistorySourceExportStore(directory),e=await collect(dbPort(),options(draftArgs())),path=join(directory,e.sourceSnapshotHash+'.history-source.json');
  const corrupt='x'.repeat(e.reference.bytes);await writeFile(path,corrupt);
  await assert.rejects(store.put(e),/pin_or_bound/);assert.equal(await readFile(path,'utf8'),corrupt);
  await assert.rejects(store.load({...e.reference,path:'../private'}),/store_reference/);
  await assert.rejects(store.load({...e.reference,sha256:'../'+e.reference.sha256}),/store_reference/);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('envelope size is bounded before hash acceptance',async()=>{
 const e=await collect(dbPort([]),options(draftArgs()));
 assert.throws(()=>verify({...e.envelopeInput,pin:{...e.envelopeInput.pin,bytes:MAX_HISTORY_EXPORT_BYTES+1}}),/pin_or_bound/);
});

test('reader transport must retain canonical envelope bytes rather than repacking the same JSON',async()=>{
 const e=await collect(dbPort([]),options(draftArgs())),utf8=JSON.stringify(JSON.parse(e.envelopeInput.utf8),null,2);
 assert.throws(()=>verify({utf8,pin:{path:'synthetic-pretty-envelope.json',bytes:Buffer.byteLength(utf8),sha256:sha(utf8)}}),/noncanonical_or_derived_tamper/);
});
