import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deriveHistoricalFactVersionV2,pinRetainedHistoryJson as pin,selectHistoricalFactVersions,exportHistoricalFactsFromVersions} from './retainedOpenDotaFacts.mjs';
import {reduceRetainedMapVersions,projectReducedRetainedMap,retainedVersionSetBinding,numericHistoryMapIdCompare} from './boundedRetainedHistory.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex'),T0='2026-10-20T12:00:00Z',T1='2026-10-21T12:00:00Z',T2='2026-10-22T12:00:00Z';
const payload=(match_id=101)=>({match_id,start_time:1792494000,duration:1800,radiant_win:true,radiant_team_id:700,dire_team_id:800,radiant_score:25,dire_score:10,players:[{player_slot:0,hero_id:1,account_id:900,gold_per_min:600,kills:10,deaths:2,assists:3,times:[0,60],gold_t:[600,1200]}]});
function version(p,at=T0){const body=JSON.parse(pin(p).utf8);return deriveHistoricalFactVersionV2({selectedInput:pin({schemaVersion:1,source:'opendota',endpoint:'https://api.opendota.com/api/matches/'+p.match_id,matchId:p.match_id,receivedAt:at,availabilityBasis:'collector_response_receipt',payloadKind:'selected_match_detail_v1',payloadSha256:sha(JSON.stringify(body)),payload:body})}).versionInput;}
async function compare(versions,{targetMapId='999',cutoff=T2}={}){
 const options={versionInputs:versions,targetMapId,historyCutoffAt:cutoff},expected=selectHistoricalFactVersions(options),actual=await reduceRetainedMapVersions({...options,matchId:String(JSON.parse(versions[0].utf8).source.matchId)});
 assert.deepEqual(actual.fields,expected.fields);assert.deepEqual(actual.identityBarriers,expected.identityBarriers);assert.deepEqual(actual.sourceVersions,expected.sourceVersions);assert.deepEqual(actual.audit,expected.audit);
 const binding=retainedVersionSetBinding(actual.sourceVersions),row=projectReducedRetainedMap(actual,binding),old=exportHistoricalFactsFromVersions(options),maps=JSON.parse(old.factsInput.utf8).maps;
 assert.deepEqual(row.map,maps[0]??null);assert.deepEqual(row.omitted,old.audit.omittedMaps[0]??null);return actual;
}
test('streamed map resolution exactly matches v1 fields, provenance and normalized facts',async()=>{const a=payload(),b=payload();b.players[0].gold_per_min=900;await compare([version(a),version(b,T1)]);await compare([version(b,T1),version(a)]);});
test('null and invalid updates retract old performance and whole response clock blocks',async()=>{
 const a=payload(),b=payload();b.players[0].times=null;b.players[0].gold_per_min=null;const r=await compare([version(a),version(b,T1)]);assert.equal(r.fields.find(f=>f.path.endsWith('/clock_series')).status,'explicit_null');
 const c=payload();c.players[0].times=[60,0];c.players[0].gold_per_min=-1;await compare([version(a),version(c,T1)]);
});
test('same-receipt contradictions keep all conflict witnesses, independent of source order',async()=>{const a=payload(),b=payload();b.players[0].gold_per_min=700;b.radiant_win=false;const x=version(a),y=version(b);await compare([x,y]);await compare([y,x]);await compare([x,y,x]);});
test('A to B to A identity epochs cannot resurrect old metrics or clock attribution',async()=>{
 const a=payload(),b=payload(),c=payload();b.players[0]={player_slot:0,hero_id:100,account_id:5000};delete c.players[0].gold_per_min;delete c.players[0].times;delete c.players[0].gold_t;
 const r=await compare([version(a),version(b,T1),version(c,T2)]);assert.equal(r.identityBarriers[0].heroBarrierAt,T1);
 const account=payload();account.players[0].account_id=5000;await compare([version(a),version(account,T1),version(c,T2)]);
});
test('anonymous identity then disclosure preserves original availability limits',async()=>{const a=payload(),b=payload();a.players[0].account_id=null;delete b.players[0].gold_per_min;await compare([version(a),version(b,T1)]);});
test('current and future originals are actually verified while excluded',async()=>{
 await compare([version(payload())],{targetMapId:'101'});await compare([version(payload(),T2)],{cutoff:T1});
 const bad=JSON.parse(version(payload(),T2).utf8);bad.fields[0].value=123;await assert.rejects(reduceRetainedMapVersions({versionInputs:[pin(bad)],matchId:'101',targetMapId:'999',historyCutoffAt:T1}),/version_not_rederived_from_source/);
});
test('missing finals and impossible event chronology preserve exact omission dispositions',async()=>{const a=payload();delete a.radiant_win;await compare([version(a)]);const b=payload();b.start_time=1794000000;await compare([version(b)]);});
test('late team-score fields conservatively gate normalized map availability',async()=>{const a=payload(),b=payload();delete a.radiant_score;delete a.dire_score;delete b.radiant_win;await compare([version(a),version(b,T1)]);});
test('reducer checks STOP and rejects mixed map chains',async()=>{
 await assert.rejects(reduceRetainedMapVersions({versionInputs:[version(payload())],matchId:'101',targetMapId:'999',historyCutoffAt:T2,shouldContinue:()=>false}),/stopped/);
 await assert.rejects(reduceRetainedMapVersions({versionInputs:[version(payload(102))],matchId:'101',targetMapId:'999',historyCutoffAt:T2}),/mixed_map_chain/);
});
test('numeric map-id arithmetic order stays distinct from lexical wire order',()=>{assert.deepEqual(['100','2','10','99999999999999999999'].sort(numericHistoryMapIdCompare),['2','10','100','99999999999999999999']);assert.deepEqual(['100','2','10'].sort((a,b)=>a.localeCompare(b,'en')),['10','100','2']);});
