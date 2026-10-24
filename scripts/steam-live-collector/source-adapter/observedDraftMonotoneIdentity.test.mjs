import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeLocalCapture} from './steamLiveAdapter.mjs';
import {draftArgs,draftEntry,pinned} from './observedDraftHistory.fixtures.mjs';
import {replayPinnedDraftPrefix,produceObservedDraftHistory} from './observedDraftHistory.mjs';
import {collectDraftHistorySourceExport} from './historySourceExport.mjs';

const T0='2026-10-23T11:58:00Z',T1='2026-10-23T12:15:00Z',NOW='2026-10-23T12:30:00Z';
function editEntry(entry,edit){
 const raw=JSON.parse(entry.rawInput.utf8);edit(raw.result.games[0]);
 const rawInput=pinned(raw,'synthetic-disclosure-raw.json');
 const metadata=JSON.parse(entry.metadataInput.utf8);
 const o=normalizeLocalCapture({...metadata.capture,body:Buffer.from(rawInput.utf8),rawSha256:rawInput.pin.sha256,payloadRef:'journal:'+rawInput.pin.sha256}).observations[0];
 return {rawInput,metadataInput:pinned({...metadata,observationId:o.observationId},'synthetic-disclosure-metadata.json')};
}
const replay=a=>replayPinnedDraftPrefix(a);
function priorRows(a){return JSON.parse(a.factsInput.utf8).maps.map(m=>({...m,players:m.players.map((p,i)=>({account_id:Number(p.accountId),hero_id:p.heroId,player_slot:p.side==='radiant'?i%5:128+i%5}))}));}

test('late team disclosure is a new immutable revision at t1 with the same t0',()=>{
 const a=draftArgs({teams:false}),first=replay(a),before=structuredClone(first);
 a.draftPrefixInputs.push(draftEntry({teams:true,time:T1}));
 const next=replay(a);
 assert.equal(next.accepted,true);
 assert.equal(next.state.historyCutoffAt,T0);assert.equal(next.state.revision,1);
 assert.equal(next.state.validFrom,T1);assert.equal(next.state.changeReason,'team_identity_disclosed');
 assert.equal(next.state.firstCompleteObservationId,first.state.firstCompleteObservationId);
 assert.notEqual(next.state.validFromObservationId,first.state.validFromObservationId);
 assert.deepEqual(next.state.identity.sides.map(x=>x.teamId),['100','200']);
 assert.deepEqual(first,before);assert.ok(first.state.identity.sides.every(s=>s.teamId===null));
});

test('partial then full team disclosure preserves known IDs and increments only at disclosure',()=>{
 const a=draftArgs({teams:false}),partial=editEntry(draftEntry({teams:true,time:T1}),g=>delete g.dire_team);
 a.draftPrefixInputs.push(partial);const one=replay(a);
 assert.equal(one.accepted,true);assert.equal(one.state.revision,1);
 assert.deepEqual(one.state.identity.sides.map(x=>x.teamId),['100',null]);
 a.draftPrefixInputs.push(draftEntry({teams:true,time:'2026-10-23T12:16:00Z'}));
 const two=replay(a);assert.equal(two.accepted,true);assert.equal(two.state.revision,2);
 assert.equal(two.state.historyCutoffAt,T0);assert.equal(two.state.validFrom,'2026-10-23T12:16:00Z');
});

test('combined account and team disclosure remains enrichment rather than correction',()=>{
 const a=draftArgs({teams:false});a.draftPrefixInputs.push(draftEntry({teams:true,accounts:true,time:T1}));
 const r=replay(a);assert.equal(r.accepted,true);
 assert.equal(r.state.changeReason,'team_and_account_identity_disclosed');
 assert.equal(r.state.identity.players.filter(p=>p.accountId!==null).length,10);
 assert.equal(r.state.historyCutoffAt,T0);assert.equal(r.state.validFrom,T1);
});

test('known team replacement or redaction and known account redaction still require correction evidence',()=>{
 for(const edit of [g=>{g.radiant_team.team_id=300;},g=>{delete g.radiant_team;},g=>{g.scoreboard.radiant.players[0].account_id=4294967295;}]){
  const a=draftArgs({teams:true,accounts:true});a.draftPrefixInputs.push(editEntry(draftEntry({teams:true,accounts:true,time:T1}),edit));
  const r=replay(a);assert.equal(r.accepted,false);assert.equal(r.reason,'draft_identity_correction_evidence_required');
 }
});

test('late team enrichment cannot qualify an earlier narrower query or leak t1 facts',()=>{
 const a=draftArgs({teams:false}),f=JSON.parse(a.factsInput.utf8);f.scope.targetTeamIds=[];a.factsInput=pinned(f);
 a.draftPrefixInputs.push(draftEntry({teams:true,time:T1}));
 const r=produceObservedDraftHistory(a);assert.equal(r.status,'produced_reconstruction');
 assert.equal(r.context.historyCutoffAt,T0);assert.equal(r.context.validFrom,T1);
 assert.ok(r.context.featurePayload.teams.every(t=>t.values.teamForm===null));
 assert.equal(r.context.featurePayload.heroes.length,10);
 const future=JSON.parse(a.factsInput.utf8);for(const m of future.maps)m.outcomeKnownAt=m.playersKnownAt='2026-10-23T11:58:00.000000001Z';
 assert.equal(produceObservedDraftHistory({...a,factsInput:pinned(future)}).reason,'no_available_prior_maps');
});

test('new team selector export uses original t0 and gets a new source hash without changing old export',async()=>{
 const a=draftArgs({teams:false}),calls=[];
 const db={async query(sql,args){calls.push(structuredClone(args));return {rows:sql.includes('FROM pro_matches')?structuredClone(priorRows(a)):[]};}};
 const first=await collectDraftHistorySourceExport(db,{...a,now:()=>NOW}),copy=structuredClone(first);
 a.draftPrefixInputs.push(draftEntry({teams:true,time:T1}));
 const next=await collectDraftHistorySourceExport(db,{...a,now:()=>NOW});
 assert.deepEqual(next.identity.selectors.targetTeamIds,['100','200']);assert.equal(next.identity.historyCutoffAt,T0);
 assert.equal(next.identity.validFrom,T1);assert.notEqual(next.sourceSnapshotHash,first.sourceSnapshotHash);
 assert.deepEqual(first,copy);assert.deepEqual(first.identity.selectors.targetTeamIds,[]);
 assert.equal(calls[2][0],T0);
});
