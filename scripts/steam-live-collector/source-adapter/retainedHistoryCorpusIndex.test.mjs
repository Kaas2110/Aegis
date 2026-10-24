import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pinRetainedHistoryJson as pin,deriveHistoricalFactVersion,exportHistoricalFactsFromVersions} from './retainedOpenDotaFacts.mjs';
import {createRetainedHistoryCorpusIndex as build,verifyRetainedHistoryCorpusIndex as verify,streamRetainedHistoryFactsFromIndex as stream} from './retainedHistoryCorpusIndex.mjs';
const T0='2026-10-01T12:00:00Z',T1='2026-10-01T12:10:00Z',T2='2026-10-01T12:20:00Z';
function version(matchId=101,receivedAt=T0,patch={}){
 const payload=JSON.parse(pin({match_id:matchId,start_time:1790850000,duration:1800,radiant_win:true,radiant_score:30,dire_score:15,radiant_team_id:1,dire_team_id:2,players:[{player_slot:0,hero_id:1,account_id:100,gold_per_min:300,kills:5}],...patch}).utf8);
 const selectedInput=pin({schemaVersion:1,source:'opendota',endpoint:'https://api.opendota.com/api/matches/'+matchId,matchId,receivedAt,availabilityBasis:'collector_response_receipt',payloadKind:'selected_match_detail_v1',payloadSha256:createHash('sha256').update(JSON.stringify(payload)).digest('hex'),payload});return deriveHistoricalFactVersion({selectedInput}).versionInput;
}
async function setup(versions,options={}){
 const index=await build({versionInputs:versions,...options}),bySha=new Map(versions.map(v=>[v.pin.sha256,v]));
 return{index,bySha,loadVersion:async ref=>{const v=bySha.get(ref.sha256);if(!v)throw Error('fixture_reference_missing');return v;}};
}
async function materialize(s,opts={}){
 const maps=[];const result=await stream({...s.index,loadVersion:s.loadVersion,targetMapId:'999',historyCutoffAt:T2,onMap:map=>maps.push(map),...opts});
 return{result,maps,factsInput:pin({contract:'aegis.prior-map-facts.v1',scope:result.scope,maps})};
}
test('canonical pages and actual two-pass materializer preserve exact v1 facts and bindings',async()=>{
 const versions=[version(103,T1),version(101),version(102),version(101,T1,{radiant_score:40})],s=await setup(versions,{limits:{maxPageVersions:2}}),a=await materialize(s),old=exportHistoricalFactsFromVersions({versionInputs:versions,targetMapId:'999',historyCutoffAt:T2});
 assert.equal(s.index.pageInputs.length,2);assert.equal(verify(s.index).summarySourceVerified,false);assert.equal(a.factsInput.utf8,old.factsInput.utf8);assert.equal(a.result.factsSha256,old.factsInput.pin.sha256);assert.equal(a.result.factsBytes,old.factsInput.pin.bytes);assert.deepEqual(a.result.bindings,old.bindings);assert.equal(a.result.audit.denseFactsRetained,false);assert.equal(a.result.audit.maxRetainedMapVersions,2);
});
test('source input ordering and duplicate references do not change canonical index',async()=>{
 const a=version(101),b=version(102),first=await build({versionInputs:[a,b,a]}),second=await build({versionInputs:[b,a]});assert.equal(first.manifestInput.utf8,second.manifestInput.utf8);assert.deepEqual(first.pageInputs,second.pageInputs);
});
test('future +1ns and current-map references are verified but cannot alter old facts',async()=>{
 const a=version(),f=version(101,'2026-10-01T12:00:00.000000001Z',{radiant_win:false}),current=version(999,T0),one=await materialize(await setup([a]),{historyCutoffAt:T0}),more=await materialize(await setup([a,f,current]),{historyCutoffAt:T0});
 assert.equal(more.factsInput.utf8,one.factsInput.utf8);assert.equal(more.result.factsSha256,one.result.factsSha256);assert.ok(more.result.audit.verifiedLoads>=3);assert.equal(more.maps.length,1);
});
test('equal-time contradictions and explicit nulls retain old v1 semantics',async()=>{
 const a=version(),conflict=version(101,T0,{radiant_win:false}),n=version(102,T0),nil=version(102,T1,{players:[{player_slot:0,hero_id:1,account_id:100,gold_per_min:null,kills:7}]}),versions=[a,conflict,n,nil],s=await setup(versions),m=await materialize(s),old=exportHistoricalFactsFromVersions({versionInputs:versions,targetMapId:'999',historyCutoffAt:T2});
 assert.equal(m.factsInput.utf8,old.factsInput.utf8);assert.equal(m.maps.length,1);assert.equal(m.maps[0].heroPerformances[0].metrics.gpm,null);assert.equal(m.maps[0].fieldAvailability['/players/0/gold_per_min'].status,'explicit_null');
});
test('A-B-A identity barriers retain every intermediate version and suppress old performance',async()=>{
 const versions=[version(),version(101,T1,{players:[{player_slot:0,hero_id:2,account_id:101}]}),version(101,T2,{players:[{player_slot:0,hero_id:1,account_id:100}]})],s=await setup(versions),m=await materialize(s),old=exportHistoricalFactsFromVersions({versionInputs:versions,targetMapId:'999',historyCutoffAt:T2});
 assert.equal(m.factsInput.utf8,old.factsInput.utf8);assert.equal(verify(s.index).rows.length,3);assert.equal(m.maps[0].heroPerformances.length,0);assert.ok(m.maps[0].identityContinuity[0].heroBarrierAt);
});
test('all summaries are checked against real versions before an excluded row can hide data',async()=>{
 const s=await setup([version()]),p=JSON.parse(s.index.pageInputs[0].utf8);p.rows[0].receivedAt='2027-01-01T00:00:00Z';const alteredPage=pin(p),body=JSON.parse(s.index.manifestInput.utf8);body.pages[0]={...body.pages[0],sha256:alteredPage.pin.sha256,bytes:alteredPage.pin.bytes};const altered={manifestInput:pin(body),pageInputs:[alteredPage]};let emitted=false;
 assert.equal(verify(altered).rows.length,1);await assert.rejects(()=>stream({...altered,loadVersion:s.loadVersion,targetMapId:'999',historyCutoffAt:T2,onMap:()=>{emitted=true;}}),/resolved_version_summary_mismatch/);assert.equal(emitted,false);
});
test('missing pages, changed bytes, duplicate rows and counts fail integrity checks',async()=>{
 const s=await setup([version(101),version(102)],{limits:{maxPageVersions:1}});
 assert.throws(()=>verify({...s.index,pageInputs:[]}),/manifest/);assert.throws(()=>verify({...s.index,pageInputs:[{...s.index.pageInputs[0],utf8:s.index.pageInputs[0].utf8+' '},s.index.pageInputs[1]]}),/pinned_bytes/);
 const b=JSON.parse(s.index.manifestInput.utf8);b.versionCount++;assert.throws(()=>verify({...s.index,manifestInput:pin(b)}),/manifest_counts/);
 const p=JSON.parse(s.index.pageInputs[0].utf8);p.rows.push(p.rows[0]);const pi=pin(p),bm=JSON.parse(s.index.manifestInput.utf8);bm.pages[0]={...bm.pages[0],sha256:pi.pin.sha256,bytes:pi.pin.bytes,rows:2};assert.throws(()=>verify({manifestInput:pin(bm),pageInputs:[pi,s.index.pageInputs[1]]}),/duplicate_or_noncanonical/);
});
test('valid empty declared corpus differs from missing or corrupt source',async()=>{
 const s=await setup([]),m=await materialize(s);assert.equal(m.maps.length,0);assert.equal(m.result.scope.rowCount,0);assert.equal(m.factsInput.utf8,exportHistoricalFactsFromVersions({versionInputs:[],targetMapId:'999',historyCutoffAt:T2}).factsInput.utf8);
 const nonempty=await setup([version()]);await assert.rejects(()=>materialize({...nonempty,loadVersion:async()=>null}),/input_pin/);
});
test('async iteration and per-map limits retain at most one map body group',async()=>{
 const versions=[version(101),version(102),version(103)];async function* inputs(){for(const v of versions)yield v;}
 const index=await build({versionInputs:inputs(),limits:{maxPageVersions:1}}),bySha=new Map(versions.map(x=>[x.pin.sha256,x]));let active=0,maxActive=0,emitted=0;
 const result=await stream({...index,loadVersion:async ref=>{active++;maxActive=Math.max(maxActive,active);await Promise.resolve();active--;return bySha.get(ref.sha256);},targetMapId:'999',historyCutoffAt:T2,onMap:()=>emitted++});
 assert.equal(maxActive,1);assert.equal(result.audit.maxRetainedMapVersions,1);assert.equal(emitted,3);assert.ok(result.audit.maxRetainedMapVersionBytes<=Math.max(...versions.map(v=>v.pin.bytes)));
 const many=await setup([version(),version(101,T1)]);await assert.rejects(()=>materialize(many,{maxMapBytes:versions[0].pin.bytes}),/map_version_bound/);
});
test('bounded index/output and STOP fail closed; sink remains explicitly provisional',async()=>{
 await assert.rejects(()=>build({versionInputs:[version(101),version(102)],limits:{maxVersions:1}}),/index_bound/);
 const s=await setup([version()]);await assert.rejects(()=>materialize(s,{maxOutputBytes:1}),/output_bytes_bound/);
 let active=true,seen=false;await assert.rejects(()=>materialize(s,{shouldContinue:()=>active,onMap:(_map,meta)=>{seen=true;assert.equal(meta.provisional,true);active=false;}}),/manual_stop/);assert.equal(seen,true);
});
test('changing a version between passes cannot produce a committed success',async()=>{
 const v=version(),s=await setup([v]);let calls=0;
 await assert.rejects(()=>materialize({...s,loadVersion:async()=>++calls===1?v:{...v,utf8:v.utf8+' '}}),/input_bytes/);assert.equal(calls,2);
});
test('actual async corpus exceeds the v1 aggregate source ceiling without retaining all raw versions',async t=>{
 const count=1024,padding='x'.repeat(64*1024),ids=new Map();let peakSampledRss=process.memoryUsage().rss;
 const sample=()=>{peakSampledRss=Math.max(peakSampledRss,process.memoryUsage().rss);};
 async function* versions(){for(let i=0;i<count;i++){const v=version(10000+i,T0,{synthetic_padding_ignored_by_fields:padding});ids.set(v.pin.sha256,10000+i);sample();yield v;}}
 const index=await build({versionInputs:versions()}),declared=verify(index);assert.ok(declared.manifest.versionBytes>64*1024*1024);let emitted=0;
 const result=await stream({...index,loadVersion:async ref=>{sample();return version(ids.get(ref.sha256),T0,{synthetic_padding_ignored_by_fields:padding});},targetMapId:'999',historyCutoffAt:T2,onMap:map=>{emitted++;assert.equal(map.heroPerformances[0].metrics.gpm,300);sample();}});
 assert.equal(emitted,count);assert.equal(result.audit.maxRetainedMapVersions,1);assert.ok(result.audit.maxRetainedMapVersionBytes<100*1024);assert.equal(result.audit.verifiedLoads,count*2);assert.equal(result.audit.denseFactsRetained,false);
 t.diagnostic(JSON.stringify({syntheticMaps:count,declaredVersionBytes:declared.manifest.versionBytes,indexBytes:declared.indexBytes,maxRetainedMapVersionBytes:result.audit.maxRetainedMapVersionBytes,peakSampledRssBytes:peakSampledRss,measurement:'sampled process RSS, not a proven upper bound or whole-archive host acceptance'}));
});
