import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,unlink,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createAppendOnlyHistoryFactStore} from './appendOnlyHistoryFactStore.mjs';
import {pinRetainedHistoryJson as pin} from './retainedOpenDotaFacts.mjs';
const T0='2026-10-01T12:00:00Z',T1='2026-10-01T12:10:00Z';
function source(receivedAt=T0,value=300){const p=JSON.parse(pin({match_id:101,start_time:1790850000,duration:1800,radiant_win:true,players:[{player_slot:0,hero_id:1,account_id:100,gold_per_min:value}]}).utf8);return{selectedInput:pin({schemaVersion:1,source:'opendota',endpoint:'https://api.opendota.com/api/matches/101',matchId:101,receivedAt,availabilityBasis:'collector_response_receipt',payloadKind:'selected_match_detail_v1',payloadSha256:createHash('sha256').update(JSON.stringify(p)).digest('hex'),payload:p})};}
async function temp(t){const root=await mkdtemp(join(tmpdir(),'aegis-history-versions-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test('concurrent independent appenders coalesce identical versions and preserve distinct receipts after restart',async t=>{
 const root=await temp(t),a=await createAppendOnlyHistoryFactStore(root),b=await createAppendOnlyHistoryFactStore(root);
 const writes=await Promise.all(Array.from({length:20},(_,i)=>(i%2?a:b).append(source(i%3===0?T1:T0,i%3===0?700:300))));
 assert.equal(writes.filter(x=>x.created).length,2);assert.equal((await a.references()).length,2);assert.equal((await readdir(root)).length,2);
 const restarted=await createAppendOnlyHistoryFactStore(root),early=await restarted.exportAsOf({targetMapId:'999',historyCutoffAt:T0}),late=await restarted.exportAsOf({targetMapId:'999',historyCutoffAt:T1});
 assert.equal(JSON.parse(early.factsInput.utf8).maps[0].heroPerformances[0].metrics.gpm,300);assert.equal(JSON.parse(late.factsInput.utf8).maps[0].heroPerformances[0].metrics.gpm,700);
});
test('every load re-verifies retained content; corruption and deletion cannot return cached success',async t=>{
 const root=await temp(t),s=await createAppendOnlyHistoryFactStore(root),saved=await s.append(source()),file=join(root,saved.reference.sha256+'.history-fact.json');
 await s.load(saved.reference);await writeFile(file,' '.repeat(saved.reference.bytes));await assert.rejects(()=>s.load(saved.reference),/input_bytes/);await unlink(file);await assert.rejects(()=>s.load(saved.reference),e=>e.code==='ENOENT');
});
test('manual stop is checked before append/read/export, and malformed references cannot choose paths',async t=>{
 const root=await temp(t);let active=true;const s=await createAppendOnlyHistoryFactStore(root,{shouldContinue:()=>active}),saved=await s.append(source());active=false;
 await assert.rejects(()=>s.append(source(T1)),/manual_stop/);await assert.rejects(()=>s.load(saved.reference),/manual_stop/);await assert.rejects(()=>s.exportAsOf({targetMapId:'999',historyCutoffAt:T1}),/manual_stop/);
 active=true;await assert.rejects(()=>s.load({...saved.reference,sha256:'../bad'}),/reference/);assert.equal((await s.references()).length,1);
});
test('restart ignores uncommitted publication debris but fails closed on unknown population files',async t=>{
 const root=await temp(t),s=await createAppendOnlyHistoryFactStore(root);await s.append(source());await writeFile(join(root,'.00000000-0000-0000-0000-000000000000.pending'),'incomplete');assert.equal((await s.references()).length,1);
 await writeFile(join(root,'unreviewed.json'),'{}');await assert.rejects(()=>s.references(),/unexpected_directory_entry/);
});
test('configured population bounds fail instead of exporting a truncated complete cohort',async t=>{
 const root=await temp(t),s=await createAppendOnlyHistoryFactStore(root);await s.append(source());await s.append(source(T1,700));const limited=await createAppendOnlyHistoryFactStore(root,{maxVersions:1});await assert.rejects(()=>limited.exportAsOf({targetMapId:'999',historyCutoffAt:T1}),/version_count_bound/);
});
