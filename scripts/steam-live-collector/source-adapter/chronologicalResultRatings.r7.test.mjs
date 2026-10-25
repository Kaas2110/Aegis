import test from 'node:test';
import assert from 'node:assert/strict';
import {produceChronologicalResultRatings as produce,CHRONOLOGICAL_RESULT_RATINGS_VERSION,COMPLETE_PRIOR_ROSTER_VERSION} from './chronologicalResultRatings.mjs';

const AT='2026-10-25T10:00:00Z',KNOWN='2026-10-24T10:00:00Z',SHA='a'.repeat(64);
const roster=()=>Array.from({length:10},(_,i)=>({accountId:String(i+1),heroId:null,teamId:i<5?'100':'200',side:i<5?'radiant':'dire'}));
function event(matchId,won=true,endedAt=KNOWN){return {matchId,endedAt,outcomeKnownAt:endedAt,playersKnownAt:endedAt,radiantTeamId:'100',direTeamId:'200',radiantWon:won,players:roster().map(({accountId,side})=>({accountId,side}))};}
function args(events){return {events,roster:roster(),historyCutoffAt:AT,minimumSupport:3,factsPin:{sha256:SHA,bytes:123},populationBasis:'bounded_provided_retained_corpus_not_global',formulaVersion:'test.formula.v1'};}
const get=(r,n)=>r.values[r.names.indexOf(n)],def=(r,n)=>r.definitions[r.names.indexOf(n)];
const team='histrel.r7.radiant.team.result_rating_k32.rating';

test('C13 exact K32 two-side pre-state replay, numeric ID ties, mean-five account updates and support floor5',()=>{
 const events=[event('10',false),event('2',true),event('9007199254740993',true),event('9007199254740992',false),event('3',true)],r=produce(args(events));
 let oracle=1500;for(const y of [1,1,0,0,1])oracle+=32*(y-1/(1+10**((3000-2*oracle)/400)));
 assert.ok(Math.abs(get(r,team)-oracle)<1e-12);assert.ok(Math.abs(get(r,'histrel.r7.dire.team.result_rating_k32.rating')-(3000-oracle))<1e-12);
 assert.ok(Math.abs(get(r,'histrel.r7.radiant.slot_0.lineup_result_rating_k32.rating')-get(r,team))<1e-11);assert.ok(Math.abs(get(r,'histrel.r7.radiant.lineup_result_rating_k32.mean')-get(r,team))<1e-11);
 assert.deepEqual(produce(args([...events].reverse())),r);assert.equal(r.audit.historyOriginMapId,'2');assert.equal(r.audit.eventCount,5);assert.equal(r.audit.globalPopulationComplete,false);assert.equal(r.audit.learnedState,false);
 const d=def(r,team);assert.equal(d.familyId,'H01');assert.equal(d.minimumSupport,5);assert.equal(d.formulaParameters.templateId,CHRONOLOGICAL_RESULT_RATINGS_VERSION);assert.equal(d.formulaParameters.contextMinimumSupport,3);assert.equal(d.formulaParameters.minimumSupportPolicy,'max(5,contextMinimumSupport)');
 const small=produce(args(events.slice(0,4)));assert.equal(get(small,team),null);assert.equal(get(small,'histrel.r7.team_result_rating_k32.radiant_expectation'),null);assert.equal(get(small,'histrel.r7.radiant.team.result_rating_k32.supportMaps'),4);
 const m6=produce({...args(events),minimumSupport:6});assert.equal(get(m6,team),null);assert.equal(def(m6,team).minimumSupport,6);
});

test('all provided history includes events older than90d; receipt maximum cannot regress in result order',()=>{
 const old=event('1',true,'2026-01-01T00:00:00Z');old.outcomeKnownAt='2026-10-24T12:00:00Z';old.playersKnownAt='2025-12-31T23:00:00Z';
 const events=[old,...Array.from({length:4},(_,i)=>event(String(i+2),false))],r=produce(args(events));
 assert.equal(r.audit.eventCount,5);assert.equal(r.audit.historyOriginAt,old.endedAt);assert.equal(def(r,team).knownAt,old.outcomeKnownAt);assert.equal(def(r,'histrel.r7.radiant.slot_0.lineup_result_rating_k32.rating').knownAt,old.outcomeKnownAt);assert.equal(r.audit.skippedLineupUpdates,0);
});

test('complete prior-roster transition has separate ending/availability ages; missing roster is skipped',()=>{
 const a=event('1',true,'2026-10-20T10:00:00Z'),b=event('2',false,'2026-10-21T10:00:00Z'),c=event('3',true,'2026-10-22T10:00:00Z');b.players[0].accountId='99';b.playersKnownAt='2026-10-23T10:00:00Z';c.players=[];c.playersKnownAt=null;
 const r=produce(args([a,b,c])),p='histrel.r7.radiant.roster.';
 assert.equal(get(r,p+'lastCompleteRosterIntersectionFraction'),4/5);assert.equal(get(r,p+'lastCompleteRosterJaccard'),4/6);assert.equal(get(r,p+'completePriorRosterMaps'),2);assert.equal(get(r,p+'exactFiveSharedMaps.7d'),1);
 assert.equal(get(r,p+'daysSinceMapEndingAtLastObservedCompleteRosterTransition'),4);assert.equal(get(r,p+'daysSinceAvailabilityOfLastObservedCompleteRosterTransition'),2);assert.equal(def(r,p+'lastCompleteRosterJaccard').formulaParameters.templateId,COMPLETE_PRIOR_ROSTER_VERSION);assert.equal(r.audit.skippedLineupUpdates,1);
});

test('team and all ten account pre-state receipts propagate through an opponent update',()=>{
 const late='2026-10-24T12:00:00Z',first=event('1',true,'2026-10-20T00:00:00Z');first.radiantTeamId='200';first.direTeamId='300';first.players=Array.from({length:10},(_,i)=>({accountId:String(i+6),side:i<5?'radiant':'dire'}));first.outcomeKnownAt=late;first.playersKnownAt=late;
 const r=produce(args([first,...Array.from({length:5},(_,i)=>event(String(i+2),true))]));assert.equal(def(r,team).knownAt,late);assert.equal(def(r,'histrel.r7.radiant.slot_0.lineup_result_rating_k32.rating').knownAt,late);assert.notEqual(get(r,team),null);
});

test('resolved correction/removal replays full state, future and duplicate events fail, unknown roster never exposes1500',()=>{
 const events=Array.from({length:6},(_,i)=>event(String(i+1),true)),before=produce(args(events)),corrected=events.map(e=>e.matchId==='1'?{...e,radiantWon:false}:e),after=produce(args(corrected));assert.notEqual(get(before,team),get(after,team));assert.notEqual(before.audit.orderedEventBindingHash,after.audit.orderedEventBindingHash);
 const removed=produce(args(events.filter(e=>e.matchId!=='1')));assert.equal(removed.audit.eventCount,5);assert.equal(removed.audit.historyOriginMapId,'2');assert.equal(get(removed,'histrel.r7.radiant.team.result_rating_k32.supportMaps'),5);
 const future=event('7',true,'2026-10-26T00:00:00Z');assert.throws(()=>produce(args([...events,future])),/event_identity_or_time/);assert.throws(()=>produce(args([...events,events[0]])),/event_identity_or_time/);
 const noPlayers=produce(args(events.map(e=>({...e,players:[],playersKnownAt:null}))));assert.equal(get(noPlayers,'histrel.r7.radiant.slot_0.lineup_result_rating_k32.rating'),null);assert.equal(get(noPlayers,'histrel.r7.lineup_result_rating_k32.radiant_expectation'),null);assert.equal(get(noPlayers,'histrel.r7.radiant.roster.lastCompleteRosterJaccard'),null);
 const unqualified=produce({...args(events),populationQualified:false});assert.ok(unqualified.values.every(x=>x===null));assert.ok(unqualified.masks.every(x=>x===1));
});
