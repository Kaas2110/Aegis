import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveTeamFromRows,resolveTeamPair,type TeamCatalogueRow} from './TeamIdentity';
import {createTeamIdentityReader,TEAM_IDENTITY_ROW_LIMIT,TEAM_IDENTITY_SQL} from './TeamIdentityStore';

const catalogue:TeamCatalogueRow[]=[{teamId:5017210,name:'Team Resilience',tag:'Resilience',rating:1207.63}];
const history=[{teamId:10300669,name:'Imperial Power',lastSeenAt:1791792060,matches:3},
  {teamId:5017210,name:'Team Resilience',lastSeenAt:1788084589,matches:50}];
const ps=(name:string,teamId=5017210)=>({name,teamId,provider:'pandascore' as const});
test('real missing catalogue entry resolves from exact OD history, without a made-up rating',()=>{
  const team=resolveTeamFromRows({...ps('Imperial Power'),elo:9999},catalogue,history);
  assert.equal(team.teamId,10300669);assert.equal(team.elo,undefined);
  assert.equal(team.identity.method,'history_exact_name');assert.equal(team.identity.ratingAvailable,false);
  assert.equal(team.identity.historyMatches,3);assert.equal(team.identity.crossProviderVerified,false);
  assert.equal(resolveTeamFromRows(ps('Team Resilience'),catalogue,history).teamId,5017210);
});
test('same number in different provider namespaces is never identity evidence',()=>{
  assert.equal(resolveTeamFromRows(ps('Not a real team'),catalogue,history).teamId,undefined);
});
test('history and catalogue conflicting exact names fail closed, not catalogue first',()=>{
  const rows=[...catalogue,{teamId:77,name:'Imperial Power',tag:null,rating:1300}];
  const team=resolveTeamFromRows(ps('Imperial Power'),rows,history);
  assert.equal(team.teamId,undefined);assert.equal(team.identity.reason,'name_ambiguous');
  assert.deepEqual(team.identity.candidateTeamIds,[77,10300669]);
});
test('two historical IDs for same name fail closed even if repeated matches favour one',()=>{
  const team=resolveTeamFromRows(ps('Imperial Power'),catalogue,[...history,{...history[0]!,teamId:78,matches:100}]);
  assert.equal(team.teamId,undefined);assert.equal(team.identity.reason,'name_ambiguous');
});
test('real Resilience catalogue/history collision cannot be settled by case or most games',()=>{
  const rows=[...history,{teamId:10207984,name:'Team resilience',lastSeenAt:1785921088,matches:15}];
  const result=resolveTeamFromRows(ps('Team Resilience',138494),catalogue,rows);
  assert.equal(result.teamId,undefined);assert.equal(result.identity.reason,'name_ambiguous');
  assert.deepEqual(result.identity.candidateTeamIds,[5017210,10207984]);
});
test('punctuation/case normalize deterministically but typo, subset and academy do not match',()=>{
  assert.equal(resolveTeamFromRows(ps('IMPERIAL-POWER'),catalogue,history).teamId,10300669);
  for(const n of ['Imperial','Imperial Powers','Imperial Power Academy','ex Imperial Power'])
    assert.equal(resolveTeamFromRows(ps(n),catalogue,history).teamId,undefined,n);
});
test('known OD identity is not overwritten by a conflicting same-name row or unavailable catalogue',()=>{
  for(const available of [true,false]) {
    const t=resolveTeamFromRows({name:'Team Resilience',teamId:999,provider:'opendota'},catalogue,history,available);
    assert.equal(t.teamId,999);assert.equal(t.identity.method,'provider_id');assert.equal(t.elo,undefined);
  }
});
test('invalid OD IDs fail closed; unknown provider cannot use name-mismatched numeric ID',()=>{
  for(const id of [0,-1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])
    assert.equal(resolveTeamFromRows({name:'Team Resilience',teamId:id,provider:'opendota'},catalogue,history).identity.reason,'invalid_provider_id');
  assert.equal(resolveTeamFromRows({name:'Unknown team',teamId:5017210},catalogue,history).teamId,undefined);
});
test('duplicate historical rows for one ID do not create an identity collision; source inputs unchanged',()=>{
  const input=Object.freeze(ps('Imperial Power')),rows=Object.freeze([...history,history[0]!]);
  assert.equal(resolveTeamFromRows(input,Object.freeze(catalogue),rows).teamId,10300669);
  assert.equal(input.provider,'pandascore');assert.equal(input.teamId,5017210);
});
test('pair collision clears BOTH resolved IDs and exposes a distinct reason',()=>{
  const input={matchId:'up_1',format:'BO3' as const,team1:ps('Team Resilience'),team2:ps('Resilience')};
  const result=resolveTeamPair(input,catalogue,history);
  for(const t of [result.team1,result.team2]) {assert.equal(t.teamId,undefined);assert.equal(t.identity?.reason,'same_team_on_both_sides');}
  assert.equal(input.team1.teamId,5017210);
});
test('missing source / placeholder / absent exact mapping have distinguishable reasons',()=>{
  assert.equal(resolveTeamFromRows(ps('Team Resilience'),catalogue,history,false).identity.reason,'identity_source_unavailable');
  assert.equal(resolveTeamFromRows(ps('TBD'),catalogue,history).identity.reason,'name_missing');
  assert.equal(resolveTeamFromRows(ps('Other'),catalogue,history).identity.reason,'name_not_found');
});

const dbRow={source:'history',team_id:'10300669',name:'Imperial Power',tag:null,rating:null,last_seen_at:'1791792060',matches:3};
test('reader uses single flight, caches 60 seconds, then refreshes; identity rows are bounded',async()=>{
  let clock=0,calls=0;let complete!:(rows:typeof dbRow[])=>void;
  const read=createTeamIdentityReader(()=>{calls++;return new Promise(r=>{complete=r;});},()=>clock);
  const a=read(),b=read();await Promise.resolve();assert.equal(calls,1);complete([dbRow]);
  assert.deepEqual(await a,await b);assert.equal((await read()).history[0]!.teamId,10300669);assert.equal(calls,1);
  clock=60000;const c=read();await Promise.resolve();assert.equal(calls,2);complete([dbRow]);await c;
});
test('failed refresh invalidates stale identities and waits 5 seconds before retry',async()=>{
  let clock=0,calls=0;
  const read=createTeamIdentityReader(async()=>{calls++;if(calls===2)throw new Error('safe test error');return [dbRow];},()=>clock);
  assert.equal((await read()).available,true);clock=60000;
  assert.deepEqual(await read(),{catalogue:[],history:[],available:false});
  clock=64000;assert.equal((await read()).available,false);assert.equal(calls,2);
  clock=65000;assert.equal((await read()).available,true);assert.equal(calls,3);
});
test('overflow and malformed IDs never return partial rows that could hide collisions',async()=>{
  const overflow=createTeamIdentityReader(async()=>Array(TEAM_IDENTITY_ROW_LIMIT+1).fill(dbRow));
  assert.equal((await overflow()).available,false);
  for(const bad of [{...dbRow,team_id:'0'},{...dbRow,last_seen_at:'bad'},{...dbRow,matches:0}])
    assert.equal((await createTeamIdentityReader(async()=>[bad])()).available,false);
});
test('a synchronously thrown loader error cannot leave a completed in-flight promise stuck forever',async()=>{
  let clock=0,calls=0;
  const read=createTeamIdentityReader(()=>{calls++;if(calls===1)throw new Error('sync');return Promise.resolve([dbRow]);},()=>clock);
  assert.equal((await read()).available,false);clock=5000;
  assert.equal((await read()).available,true);assert.equal(calls,2);
});
test('real blank historical names are absent evidence and cannot disable other identities',async()=>{
  const rows=await createTeamIdentityReader(async()=>[dbRow,{...dbRow,team_id:'9138062',name:''}])();
  assert.equal(rows.available,true);assert.equal(rows.history.length,1);
  assert.equal(resolveTeamFromRows(ps('Imperial Power'),rows.catalogue,rows.history).teamId,10300669);
});
test('SQL reads completed persisted map identities only and never manufactures a rating',()=>{
  assert.match(TEAM_IDENTITY_SQL,/start_time\+duration<=EXTRACT\(EPOCH FROM now\(\)\)/);
  assert.match(TEAM_IDENTITY_SQL,/ingested_at<=now\(\)/);
  assert.match(TEAM_IDENTITY_SQL,/NULL::real AS rating/);
  assert.match(TEAM_IDENTITY_SQL,/LIMIT 10001$/);
  assert.doesNotMatch(TEAM_IDENTITY_SQL,/\b(INSERT|UPDATE|DELETE)\b/i);
});
