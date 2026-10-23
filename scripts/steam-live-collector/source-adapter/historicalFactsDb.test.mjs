import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadHistoricalContextInputs} from './historicalFactsDb.mjs';
const target={matchId:'999',knownAt:'2026-10-23T00:00:00Z',frozenBeforeMapAt:'2026-10-23T00:01:00Z',receivedAt:'2026-10-23T00:10:00Z',players:Array.from({length:10},(_,i)=>({accountId:String(i+1),heroId:i+1,side:i<5?'radiant':'dire',teamId:i<5?'100':'200'}))};
const fact=()=>({matchId:'800',radiantTeamId:'100',direTeamId:'300',durationSeconds:2400,radiantKills:30,direKills:20,radiantWon:true,endedAt:'2026-10-22T20:00:00.000000Z',outcomeKnownAt:'2026-10-22T20:05:00.123456Z',playersKnownAt:'2026-10-22T20:05:00.123456Z',players:[{account_id:1,hero_id:1,player_slot:0},{account_id:6,hero_id:6,player_slot:128}]});
const port=rows=>({query:async sql=>({rows:sql.includes('FROM pro_matches')?rows:[]})});
test('DB facts use explicit slots and exact pinned bytes, never array position',async()=>{
 const a=fact();a.players.reverse();const r=await loadHistoricalContextInputs(port([a]),{target});
 const data=JSON.parse(r.factsInput.utf8),p=data.maps[0].players.find(p=>p.accountId==='6');assert.equal(p.side,'dire');
 assert.equal(data.maps[0].outcomeKnownAt,'2026-10-22T20:05:00.123456Z');
 assert.equal(data.maps[0].heroesKnownAt,data.maps[0].playersKnownAt);
 assert.equal(r.factsInput.pin.sha256,createHash('sha256').update(r.factsInput.utf8).digest('hex'));assert.equal(r.factsInput.pin.bytes,Buffer.byteLength(r.factsInput.utf8));
 assert.equal(r.audit.availabilityBasis,'database_timestamp_reconstruction');assert.equal(r.eligibleForTraining,false);
 assert.equal(JSON.parse(r.nativeInput.utf8).observations.length,0);
});
test('future or duplicate current-map facts are rejected',async()=>{
 const a=fact();a.outcomeKnownAt='2026-10-23T00:00:00.000000001Z';a.playersKnownAt=a.outcomeKnownAt;
 await assert.rejects(loadHistoricalContextInputs(port([a]),{target}),/identity_or_future/);
 const b=fact();b.matchId=target.matchId;await assert.rejects(loadHistoricalContextInputs(port([b]),{target}),/identity_or_future/);
 await assert.rejects(loadHistoricalContextInputs(port([fact(),fact()]),{target}),/identity_or_future/);
});
test('row cap never silently truncates a statistical support cohort',async()=>{
 const b=fact();b.matchId='801';await assert.rejects(loadHistoricalContextInputs(port([fact(),b]),{target,maxMaps:1}),/map_bound/);
});
test('SQL selects team or account relevance as of label and player availability',async()=>{
 let calls=0;const db={query:async(sql,args)=>{calls++;if(calls===1){assert.ok(sql.includes('mp.parsed_at<=$1'));assert.ok(sql.includes('greatest('));assert.ok(sql.includes('interval \'90 days\''));assert.deepEqual(args.slice(0,3),[target.knownAt,target.matchId,['100','200']]);return{rows:[fact()]};}assert.ok(sql.includes('phase_code=5'));return{rows:[]};}};
 await loadHistoricalContextInputs(db,{target});assert.equal(calls,2);
});
test('an empty history yields pinned empty data and no native fanout',async()=>{
 let calls=0;const r=await loadHistoricalContextInputs({query:async()=>{calls++;return{rows:[]};}},{target});
 assert.equal(calls,1);assert.equal(r.audit.maps,0);assert.equal(JSON.parse(r.factsInput.utf8).maps.length,0);
});
test('hero history is selected across teams with an explicit complete local-source scope',async()=>{
 const db={query:async(sql,args)=>{if(sql.includes('FROM pro_matches')){assert.ok(sql.includes("j.player->>'hero_id'=ANY($5::text[])"));assert.deepEqual(args[4],Array.from({length:10},(_,i)=>String(i+1)));assert.equal(args[5],20001);return{rows:[fact()]};}return{rows:[]};}};
 const r=await loadHistoricalContextInputs(db,{target}),s=JSON.parse(r.factsInput.utf8).scope;
 assert.equal(s.selection,'target_teams_or_accounts_or_heroes');assert.equal(s.completeWithinSource,true);assert.equal(s.truncated,false);assert.equal(s.rowCount,1);assert.equal(s.sourceUniverse,'local_pro_matches_join_match_parsed');assert.equal(s.selectionSqlSha256.length,64);
});
test('unknown or duplicate hero identity cannot claim complete hero selection',async()=>{
 const p=structuredClone(target);p.players[0].heroId=null;await assert.rejects(loadHistoricalContextInputs(port([]),{target:p}),/hero_identity/);
 const q=structuredClone(target);q.players[0].heroId=2;await assert.rejects(loadHistoricalContextInputs(port([]),{target:q}),/hero_identity/);
});
test('unknown slots or anonymous IDs do not turn into a player identity',async()=>{
 const a=fact();a.players.push({account_id:10,hero_id:10,player_slot:64},{account_id:4294967295,hero_id:11,player_slot:1});
 const r=await loadHistoricalContextInputs(port([a]),{target});assert.equal(JSON.parse(r.factsInput.utf8).maps[0].players.length,2);
 const m=JSON.parse(r.factsInput.utf8).maps[0];assert.equal(m.heroes.length,3);assert.ok(m.heroes.some(h=>h.heroId==='11'));
});
