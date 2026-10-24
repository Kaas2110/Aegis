/** Small synthetic causal episode regressions. No providers, fits or task access. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeLocalCapture,sha} from './steamLiveAdapter.mjs';
import {advanceRoshanFeatures,featureVector,FEATURE_CONTRACT} from './roshanFeatures.mjs';
import {advanceSteamFeatureBundle} from './steamFeatureBundle.mjs';
const PROFILE='steam.GetLiveLeagueGames.v1.scoreboard',AT='2026-10-23T12:30:00Z',PRIOR='2026-10-23T12:00:00Z';
const rules={contract:'aegis.roshan-rules.v1',version:'synthetic-ledger.v1',evidenceRef:'synthetic:rules',sourceProfile:PROFILE,patch:'synthetic',knownAt:PRIOR,respawnMinimumSeconds:480,respawnMaximumSeconds:660,aegisLifetimeSeconds:300,aegisItemId:42};
function observation(clock=600,receivedAt=AT){
 const player=i=>({account_id:100+i,hero_id:i+1,level:10,net_worth:5000+i,gold_per_min:400+i,xp_per_min:500+i,item0:0,item1:0,item2:0,item3:0,item4:0,item5:0});
 const body=Buffer.from(JSON.stringify({result:{games:[{match_id:999,game_state:5,radiant_team:{team_id:1},dire_team:{team_id:2},scoreboard:{duration:clock,roshan_respawn_timer:0,radiant:{score:10,players:Array.from({length:5},(_,i)=>player(i))},dire:{score:12,players:Array.from({length:5},(_,i)=>player(i+5))}}}]}})),hash=sha(body);
 return normalizeLocalCapture({body,httpStatus:200,endpoint:'GetLiveLeagueGames/v1',requestStartedAt:receivedAt,receivedAt,persistedAt:receivedAt,rawSha256:hash,payloadRef:'journal:'+hash,authenticatedAttempt:true}).observations[0];
}
const event=(id,kind,gameTimeSeconds,extra={})=>({id,kind,gameTimeSeconds,matchId:'999',sourceProfile:PROFILE,confirmed:true,evidenceRef:'synthetic:event:'+id,knownAt:PRIOR,...extra});
const pickup=(id='p',clock=500)=>event(id,'aegis_pickup',clock,{side:'radiant',accountId:'100'});
const terminal=(id,kind='aegis_consumed',clock=550,pickupEventId='p')=>event(id,kind,clock,{pickupEventId});
function run(batches,{clock=600,receivedAt=AT}={}){let result=null;for(const events of batches)result=advanceRoshanFeatures(result?.state??null,observation(clock,receivedAt),{patch:'synthetic',rules,events});return result;}
function eventView(result){return Object.fromEntries(Object.entries(result.features).filter(([name])=>/^(aegis_|roshan_elapsed_since_confirmed_death$|roshan_respawn_|roshan_confirmed_death_count$|roshan_dead$|roshan_alive$)/.test(name)));}

test('terminal arriving before pickup is retained and reduces identically across batch order',()=>{
 const p=pickup(),t=terminal('t'),direct=run([[p,t]]),latePickup=run([[t],[p]]),lateTerminal=run([[p],[t]]);
 for(const result of [latePickup,lateTerminal]){assert.equal(result.aegis.status,'aegis_consumed');assert.deepEqual(eventView(result),eventView(direct));assert.deepEqual(result.state.eventLedger,direct.state.eventLedger);}
 const pending=run([[t]]);assert.deepEqual(pending.eventAudit.unresolvedTerminalEventIds,['t']);assert.equal(pending.features.aegis_confirmed_consumed,null);
});
test('mutually exclusive terminal facts become unknown independently of delivery or lexical ID',()=>{
 const p=pickup(),a=terminal('z-consumed'),b=terminal('a-expired','aegis_expired',560);
 const variants=[run([[p,a,b]]),run([[p,b,a]]),run([[a],[p],[b]]),run([[b],[p],[a]])];
 for(const result of variants){assert.equal(result.aegis.status,'conflicted_terminal_events');assert.equal(result.features.aegis_elapsed_since_confirmed_pickup,null);assert.equal(result.features.aegis_lifetime_upper_seconds,null);for(const name of ['consumed','expired','destroyed']){assert.equal(result.features['aegis_confirmed_'+name],null);assert.equal(result.features['aegis_elapsed_since_confirmed_'+name],null);}assert.equal(result.features.aegis_confirmed_terminal_event_count_for_retained_pickup,null);assert.deepEqual(eventView(result),eventView(variants[0]));}
});
test('contradictory timing of one terminal kind is unknown while matching corroboration stays positive',()=>{
 const p=pickup(),first=terminal('a'),different=terminal('b','aegis_consumed',560),same=terminal('c');
 assert.equal(run([[p,first,different]]).aegis.status,'conflicted_terminal_events');
 const corroborated=run([[p,first,same]]);assert.equal(corroborated.features.aegis_confirmed_consumed,1);assert.equal(corroborated.features.aegis_elapsed_since_confirmed_consumed,50);
});
test('same event ID changed content is retained as a conflict; canonical duplicate is idempotent',()=>{
 const p=pickup(),t=terminal('t'),changed={...t,kind:'aegis_expired'},first=run([[p,t]]),snapshot=JSON.stringify(first.state);
 const conflicted=advanceRoshanFeatures(first.state,observation(),{patch:'synthetic',rules,events:[changed]});
 assert.equal(JSON.stringify(first.state),snapshot);assert.deepEqual(conflicted.eventAudit.conflictingEventIds,['t']);assert.equal(conflicted.aegis.status,'conflicted_terminal_events');assert.equal(conflicted.state.eventLedger.entries.find(row=>row.id==='t').variants.length,2);
 const reordered=Object.fromEntries(Object.entries(t).reverse()),duplicate=advanceRoshanFeatures(first.state,observation(),{patch:'synthetic',rules,events:[reordered]});
 assert.deepEqual(duplicate.acceptedEventIds,[]);assert.equal(duplicate.eventAudit.variants,2);assert.equal(duplicate.features.aegis_confirmed_consumed,1);
});
test('later receipt metadata corroborates the same fact without changing event count or original availability',()=>{
 const p=pickup(),early=terminal('t','aegis_consumed',550),later={...early,knownAt:'2026-10-23T12:20:00Z',evidenceRef:'synthetic:later-response'};
 const first=run([[p,early]]),next=advanceRoshanFeatures(first.state,observation(),{patch:'synthetic',rules,events:[later]});
 assert.deepEqual(next.acceptedEventIds,[]);assert.equal(next.eventAudit.eventIds,2);assert.equal(next.eventAudit.variants,2);assert.deepEqual(next.eventAudit.conflictingEventIds,[]);assert.equal(next.features.aegis_confirmed_consumed,1);
 const held=next.state.eventLedger.entries.find(row=>row.id==='t').variants[0].event;assert.equal(held.knownAt,early.knownAt);assert.equal(held.evidenceRef,early.evidenceRef);
 const reverse=run([[later],[p,early]]);assert.deepEqual(reverse.state.eventLedger,next.state.eventLedger);assert.deepEqual(eventView(reverse),eventView(next));
});
test('old terminal episode cannot overwrite newer pickup irrespective of arrival batch',()=>{
 const old=pickup('old',400),newer=pickup('new',580),done=terminal('old-done','aegis_expired',550,'old');
 for(const batches of [[[old,done,newer]],[[newer],[done],[old]],[[old,newer],[done]]]){const result=run(batches);assert.equal(result.aegis.status,'pickup_confirmed');assert.equal(result.state.aegis.id,'new');assert.equal(result.features.aegis_elapsed_since_confirmed_pickup,20);assert.equal(result.features.aegis_confirmed_expired,null);}
});
test('old conflicting pickup/terminal evidence does not poison a distinct newer episode',()=>{
 const old=pickup('old',400),changed={...old,side:'dire'},newer=pickup('new',580),a=terminal('old-a','aegis_consumed',510,'old'),b=terminal('old-b','aegis_expired',520,'old');
 const result=run([[newer],[old,changed,a,b]]);assert.equal(result.state.aegis.id,'new');assert.equal(result.aegis.status,'pickup_confirmed');assert.equal(result.features.aegis_lifetime_upper_seconds,280);assert.deepEqual(result.eventAudit.conflictingEventIds,['old']);
});
test('same-time distinct pickup assertions remain conflicted instead of lexical winner',()=>{
 for(const events of [[pickup('a'),pickup('z')],[pickup('z'),pickup('a')]]){const result=run([events]);assert.equal(result.aegis.status,'conflicted_pickup');assert.equal(result.features.aegis_elapsed_since_confirmed_pickup,null);assert.equal(result.eventAudit.pickupConflicted,true);}
});
test('steal joins the explicitly linked death rather than most recent unrelated death',()=>{
 const death=event('linked','roshan_death',490,{side:'dire'}),unrelated=event('later','roshan_death',590,{side:'radiant'}),p={...pickup(),roshanDeathEventId:death.id};
 assert.equal(run([[death,p,unrelated]]).features.aegis_confirmed_steal,1);
 const conflict={...death,side:'radiant'};assert.equal(run([[death,p],[unrelated,conflict]]).features.aegis_confirmed_steal,null);
});
test('future conflict cannot rewrite the earlier known event set',()=>{
 const p=pickup(),t=terminal('t'),future={...t,kind:'aegis_expired',knownAt:'2026-10-23T12:30:00.000000001Z'};
 const first=run([[p,t,future]]);assert.equal(first.features.aegis_confirmed_consumed,1);assert.deepEqual(first.rejectedEventIds,['t']);assert.deepEqual(first.eventAudit.conflictingEventIds,[]);
 const later=advanceRoshanFeatures(first.state,observation(600,'2026-10-23T12:30:01Z'),{patch:'synthetic',rules,events:[future]});assert.equal(later.aegis.status,'conflicted_terminal_events');
});
test('source/map/patch/future-clock gates reject variants without altering held ledger',()=>{
 const p=pickup(),first=run([[p]]),bad=[{...p,matchId:'998'},{...p,sourceProfile:'other'},{...p,patch:'other'},{...p,gameTimeSeconds:601}];
 const next=advanceRoshanFeatures(first.state,observation(),{patch:'synthetic',rules,events:bad});assert.deepEqual(next.state.eventLedger,first.state.eventLedger);assert.equal(next.aegis.status,'pickup_confirmed');assert.deepEqual(next.eventAudit.conflictingEventIds,[]);
});
test('impossible terminal-before-pickup game time remains unusable and retained for audit',()=>{
 const p=pickup(),t=terminal('t','aegis_consumed',499),result=run([[t],[p]]);assert.equal(result.aegis.status,'pickup_confirmed');assert.equal(result.features.aegis_confirmed_consumed,null);assert.deepEqual(result.eventAudit.invalidEpisodeChronologyEventIds,['t']);
});
test('equal-time contradictory life events and changed death IDs do not choose a truth',()=>{
 const death=event('d','roshan_death',590),alive=event('a','roshan_alive',590),result=run([[alive],[death]]);assert.equal(result.roshan.state,'unknown');assert.equal(result.features.roshan_dead,null);assert.equal(result.features.roshan_alive,null);
 const changed=run([[death],[{...death,gameTimeSeconds:589}]]);assert.equal(changed.features.roshan_elapsed_since_confirmed_death,null);assert.equal(changed.features.roshan_confirmed_death_count,null);
});
test('v5 persistent state requires explicit reset; feature names and common bundle integration remain present',()=>{
 const old={contract:'aegis.roshan-dynamic-features.v5',key:'old',seenEvents:['old'],aegis:{id:'old',status:'aegis_consumed'}},o=observation();
 const result=advanceRoshanFeatures(old,o,{patch:'synthetic',rules});assert.equal(result.contract,'aegis.roshan-dynamic-features.v6');assert.ok(result.resetReasons.includes('state_contract_changed_reset_required'));assert.equal(result.state.eventLedger.entries.length,0);assert.equal(featureVector(result).names.length,878);
 const bundled=advanceSteamFeatureBundle(null,o,{patch:'synthetic',rules,events:[terminal('t'),pickup()]});assert.equal(bundled.componentContracts.roshan,FEATURE_CONTRACT);const index=bundled.vector.names.indexOf('roshan.aegis_confirmed_consumed');assert.ok(index>=0);assert.equal(bundled.vector.values[index],1);
});
test('ID ledger bounds fail closed without silently evicting old causal evidence',()=>{
 const events=Array.from({length:2048},(_,i)=>event('d'+i,'roshan_death',500)),first=run([events]);assert.equal(first.eventAudit.eventIds,2048);
 assert.throws(()=>advanceRoshanFeatures(first.state,observation(),{patch:'synthetic',rules,events:[event('one-too-many','roshan_death',501)]}),/event_history_bound/);assert.equal(first.state.eventLedger.entries.length,2048);
});
