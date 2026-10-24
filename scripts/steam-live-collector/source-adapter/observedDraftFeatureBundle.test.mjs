import test from 'node:test';
import assert from 'node:assert/strict';
import {createDynamicHistoryProof,readDynamicHistoryProof,advanceObservedDraftFeatureBundle,legacyCounterpartForDynamicFeature,CONTRACT} from './observedDraftFeatureBundle.mjs';
import {draftArgs,draftEntry,pinned} from './observedDraftHistory.fixtures.mjs';
import {normalizeLocalCapture} from './steamLiveAdapter.mjs';
import {PERFORMANCE_CONTRACT,PERFORMANCE_FIELDS} from './historicalPerformanceFields.mjs';

function liveEntry({time='2026-10-23T12:31:00Z',clock=900,accounts=true,offset=0,radiantNwShift=0,phase=5,zeroTimer=0,reverse=false,missingGpm=false,outcome=false}={}){
 const e=draftEntry({time,clock,accounts,phase,reverse,outcome}),raw=JSON.parse(e.rawInput.utf8),m=JSON.parse(e.metadataInput.utf8),g=raw.result.games[0];
 g.scoreboard.roshan_respawn_timer=zeroTimer;
 for(const side of ['radiant','dire'])for(const p of g.scoreboard[side].players){const hero=p.hero_id;Object.assign(p,{net_worth:5000+hero*100+offset+(side==='radiant'?radiantNwShift:0),gold_per_min:400+hero+offset/10,xp_per_min:500+hero+offset/10,level:10+hero,gold:100+hero,item0:100+hero,item1:0,item2:1,kills:hero,death:1,assists:2,last_hits:hero*10,denies:hero,ultimate_state:0,ultimate_cooldown:0,respawn_timer:0,has_buyback:false,buyback_cooldown:0});if(missingGpm&&hero===1)delete p.gold_per_min;}
 g.scoreboard.radiant.score=20;g.scoreboard.dire.score=10;
 const rawInput=pinned(raw,'synthetic-dynamic-live-raw.json'),o=normalizeLocalCapture({...m.capture,body:Buffer.from(rawInput.utf8),rawSha256:rawInput.pin.sha256,payloadRef:'journal:'+rawInput.pin.sha256}).observations[0];
 return{rawInput,metadataInput:pinned({...m,observationId:o.observationId},'synthetic-dynamic-live-metadata.json')};
}
function history({accounts=true,computedAt='2026-10-23T12:30:00Z',time='2026-10-23T11:58:00Z'}={}){const a=draftArgs({accounts,time});a.computedAt=computedAt;return createDynamicHistoryProof(a);}
// Formula tests use a current receipt. Stale-source rejection is exercised
// separately; a nine-minute-old frame is no longer a valid live fixture.
function run(h,e,prev=null,extra={}){return advanceObservedDraftFeatureBundle(prev,{livePrefixInputs:Array.isArray(e)?e:[e],matchId:'90001',decisionAt:'2026-10-23T12:33:00Z',historyProof:h.proof,...extra});}
const value=(r,name)=>r.vector.values[r.vector.names.indexOf(name)];

test('actual pinned history and coherent native capture yield wide diagnostic interactions',()=>{
 const h=history(),r=run(h,liveEntry());assert.equal(r.status,'diagnostic_produced');assert.equal(r.contract,CONTRACT);assert.ok(r.vector.featureCount>24000);assert.equal(new Set(r.vector.names).size,r.vector.featureCount);
 assert.equal(value(r,'draft_live.hero.1.native_gpm.recentForm.history_product'),401*.6);
 assert.equal(value(r,'draft_live.hero.1.native_gpm.recentForm.history_minute_product'),401*.6*15);
 assert.equal(value(r,'draft_live.hero.6.native_gpm.recentForm.history_product'),-406*.4);
 assert.equal(value(r,'draft_live.hero.250.native_gpm.recentForm.history_product'),0);
 assert.equal(r.historyRefs.historyCutoffAt,'2026-10-23T11:58:00Z');assert.equal(r.eligibleForServing,false);assert.equal(r.eligibleForTraining,false);assert.equal(r.publicPromotion,false);
 assert.equal(r.nativeBundle.economy.staticContextStatus,'static_context_missing');assert.equal(r.historyReuse.v3DisguisedAsV2,false);
 assert.ok(r.vector.definitions.every((d,i)=>d.name===r.vector.names[i]&&d.formula&&d.units&&d.familyId&&d.inputScopes.includes('current_live')));
 assert.ok(r.vector.masks.every((m,i)=>m===Number(r.vector.values[i]===null)));
});
test('native GPM is literal, not net worth divided by minute',()=>{
 const r=run(history(),liveEntry());assert.equal(value(r,'draft_live.hero.1.native_gpm.recentForm.history_product'),240.6);assert.notEqual(5100/15,401);assert.equal(r.noNetWorthDividedByMinuteGpm,true);
});
test('prior native player performance joins the current economic rank without replacing native live GPM',()=>{
 const a=draftArgs({accounts:true}),facts=JSON.parse(a.factsInput.utf8);for(const[i,m]of facts.maps.entries())m.heroPerformances=m.players.map(p=>({contract:PERFORMANCE_CONTRACT,sourceProfile:'opendota.completed-map.parsed-player',sourceFields:PERFORMANCE_FIELDS,accountId:p.accountId,heroId:p.heroId,side:p.side,knownAt:m.playersKnownAt,metrics:{gpm:400+i*10+p.heroId,xpm:500+i*10+p.heroId,kills:10,deaths:2,assists:10,lastHits:200,denies:10,heroDamage:20000,towerDamage:4000,heroHealing:1000,level:25,netWorth:15000,goldSpent:null,totalGold:22000,totalXp:30000,observerWardsPlaced:5,sentryWardsPlaced:8,observerWardsKilled:3,sentryWardsKilled:2}}));a.factsInput=pinned(facts);const h=createDynamicHistoryProof(a),r=run(h,liveEntry());assert.equal(value(r,'draft_live.economic_rank.native_nw.1.radiant.native_nw.playerHeroMeanPast_gpm90d.product'),5500*425);assert.equal(value(r,'draft_live.hero.5.native_gpm.observed_value'),405);
});
test('raw zero timer and raw zero respawn/cooldown retain literal zero, not alive',()=>{
 const r=run(history(),liveEntry());assert.equal(value(r,'draft_live.hero.1.respawn_timer_raw'),0);const native=new Map(r.nativeBundle.vector.names.map((n,i)=>[n,r.nativeBundle.vector.values[i]]));assert.equal(native.get('roshan.roshan_timer_raw'),0);assert.equal(native.get('roshan.roshan_alive'),null);
 assert.equal(value(r,'draft_live.roshan.radiant.roshan_confirmed_countdown_seconds.nw_sum_diff.meanDurationSeconds90d'),null);
});
test('Roshan literal timer × coherent lead × qualified finishing style is available without timer reinterpretation',()=>{
 const r=run(history(),liveEntry({zeroTimer:300}));assert.equal(value(r,'draft_live.roshan.radiant.roshan_timer_raw.nw_sum_diff.meanDurationSeconds90d'),300*(-2500)*2520);
});
test('hidden accounts do not prevent native hero/metric historical hero interactions',()=>{
 const r=run(history({accounts:false}),liveEntry({accounts:false}));assert.equal(r.status,'diagnostic_produced');assert.equal(value(r,'draft_live.hero.1.native_gpm.heroLateTendency.history_product'),401);assert.equal(value(r,'draft_live.hero.1.native_gpm.observed_value'),401);assert.equal(value(r,'draft_live.hero.1.native_nw.observed_value'),5100);assert.equal(value(r,'draft_live.hero.1.native_gpm.recentForm.history_product'),null);assert.equal(r.nativeBundle.economy.status,'unavailable');
});
test('missing GPM does not fall back to net worth; masks show the missing interaction',()=>{
 const r=run(history(),liveEntry({missingGpm:true}));assert.equal(value(r,'draft_live.hero.1.native_gpm.recentForm.history_product'),null);assert.equal(value(r,'draft_live.hero.1.native_nw.recentForm.history_product'),5100*.6);
});
test('opaque history/state proofs cannot be forged from serialized public hashes',()=>{
 const h=history(),r=run(h,liveEntry());assert.equal(advanceObservedDraftFeatureBundle(null,{livePrefixInputs:[liveEntry()],matchId:'90001',decisionAt:'2026-10-23T12:40:00Z',historyProof:structuredClone(h.proof)}).reason,'verified_dynamic_history_token_required');assert.equal(run(h,liveEntry({time:'2026-10-23T12:32:00Z',clock:960}),structuredClone(r.state)).reason,'owned_dynamic_state_required');
});
test('mutating public context or relational copy cannot alter privately bound history',()=>{
 const h=history(),a=run(h,liveEntry());h.context.featurePayload.players[0].values.recentForm=999;h.relational.profiles.teams[0].values.meanDurationSeconds90d=999;const b=run(h,liveEntry());assert.deepEqual(a.vector.values,b.vector.values);
});
test('POST/static consumer reads only immutable actual history behind the opaque proof',()=>{
 const h=history();h.context.featurePayload.players[0].values.recentForm=999;const read=readDynamicHistoryProof(h.proof,{matchId:'90001',decisionAt:'2026-10-23T12:40:00Z'});assert.equal(read.accepted,true);assert.notEqual(read.context.featurePayload.players[0].values.recentForm,999);assert.equal(Object.isFrozen(read.context.featurePayload.players[0].values),true);assert.throws(()=>{read.context.featurePayload.players[0].values.recentForm=999;});assert.equal(readDynamicHistoryProof({...h.proof,context:h.context},{matchId:'90001',decisionAt:'2026-10-23T12:40:00Z'}).accepted,false);
 assert.equal(readDynamicHistoryProof(h.proof,{matchId:'90002',decisionAt:'2026-10-23T12:40:00Z'}).accepted,false);assert.equal(readDynamicHistoryProof(h.proof,{matchId:'90001',decisionAt:'2026-10-23T12:29:59.999999999Z'}).accepted,false);
});
test('legacy mathematical counterpart is explicit and never an automatic schema alias',()=>{
 const m=legacyCounterpartForDynamicFeature('draft_live.hero.1.native_gpm.recentForm.history_product');assert.equal(m.name,'native_economy.hero.1.native_gpm.context_recentForm');assert.match(m.relationship,/not unconditional alias/);assert.equal(legacyCounterpartForDynamicFeature('draft_live.hero.1.native_gpm.recentForm.history_minute_product'),null);
});
test('row reordering leaves hero/context vector identical',()=>{
 const h=history(),a=run(h,liveEntry()),b=run(h,liveEntry({reverse:true}));assert.deepEqual(a.vector.names,b.vector.names);assert.deepEqual(a.vector.values,b.vector.values);assert.equal(a.vector.semanticSchemaHash,b.vector.semanticSchemaHash);
});
test('one-prefix offline and sequential online use identical causal native windows',()=>{
 const h=history(),a=liveEntry(),b=liveEntry({time:'2026-10-23T12:32:00Z',clock:960,offset:600}),offline=run(h,[a,b]),first=run(h,a),online=run(h,b,first.state);assert.deepEqual(offline.vector,online.vector);assert.deepEqual(offline.nativeBundle.vector,online.nativeBundle.vector);
 const k='native_economy.hero.1.native_nw.past_60s_change_per_minute';assert.equal(new Map(online.nativeBundle.vector.names.map((n,i)=>[n,online.nativeBundle.vector.values[i]])).get(k),600);
});
test('a future packet cannot alter a previously returned prefix vector',()=>{
 const h=history(),r=run(h,liveEntry()),before=structuredClone(r.vector);run(h,liveEntry({time:'2026-10-23T12:32:00Z',clock:960,offset:8000}),r.state);assert.deepEqual(r.vector,before);
});
test('lead recovery/sign changes describe only a supported observed window, not future comeback outcome',()=>{
 const h=history(),a=liveEntry(),b=liveEntry({time:'2026-10-23T12:32:00Z',clock:960,radiantNwShift:1000}),r=run(h,[a,b]);assert.equal(value(r,'draft_live.trajectory.nw_sum_diff.past_60s.recovery_from_observed_min'),5000);assert.equal(value(r,'draft_live.trajectory.nw_sum_diff.past_60s.observed_sign_changes'),1);assert.equal(value(r,'draft_live.trajectory.nw_sum_diff.past_60s.seconds_since_observed_sign_change'),0);assert.equal(value(r,'draft_live.trajectory.nw_sum_diff.past_300s.min'),null);
});
test('latest equal-clock window anchor excludes older receipts at that clock',()=>{
 const h=history(),a=liveEntry(),b=liveEntry({time:'2026-10-23T12:31:10Z',clock:900,radiantNwShift:1000}),c=liveEntry({time:'2026-10-23T12:32:00Z',clock:960,radiantNwShift:1000}),r=run(h,[a,b,c]);assert.equal(value(r,'draft_live.trajectory.nw_sum_diff.past_60s.recovery_from_observed_min'),0);assert.equal(value(r,'draft_live.trajectory.nw_sum_diff.past_60s.observed_sign_changes'),0);assert.equal(value(r,'draft_live.trajectory.nw_sum_diff.past_60s.observations'),2);assert.equal(value(r,'draft_live.trajectory.nw_sum_diff.past_60s.change_per_played_minute'),0);
});
test('mutating public native state cannot contaminate an owned state token',()=>{
 const h=history(),a=liveEntry(),b=liveEntry({time:'2026-10-23T12:32:00Z',clock:960,offset:600}),first=run(h,a);first.nativeBundle.state.history[0].sides.radiant.players[0].netWorth.value=999999;first.nativeBundle.state.roshanState.lastEconomy.nw_sum_diff=999999;const online=run(h,b,first.state),offline=run(h,[a,b]);assert.deepEqual(online.nativeBundle.vector,offline.nativeBundle.vector);assert.deepEqual(online.vector,offline.vector);
});
test('clock rewind blocks without replacing accepted state, in sequential and offline replay',()=>{
 const h=history(),first=liveEntry(),a=run(h,first),rewind=liveEntry({time:'2026-10-23T12:32:00Z',clock:300,offset:600}),b=run(h,rewind,a.state);
 assert.equal(b.status,'blocked');assert.equal(b.reason,'dynamic_game_clock_regression');assert.equal(b.vector,null);assert.equal(run(h,[first,rewind]).reason,'dynamic_game_clock_regression');
 const next=liveEntry({time:'2026-10-23T12:33:00Z',clock:1020,offset:1000}),continued=run(h,next,a.state),offline=run(h,[first,next]);assert.deepEqual(continued.vector,offline.vector);assert.equal(continued.historyRefs.contentHash,a.historyRefs.contentHash);
});
test('standalone current base values are projected without historical products or trajectory support',()=>{
 const r=run(history(),liveEntry());assert.equal(r.contract,'aegis.observed-draft-steam-feature-bundle.v2');
 assert.equal(value(r,'draft_live.base.clock_seconds'),900);assert.equal(value(r,'draft_live.base.phase_code'),5);assert.equal(value(r,'draft_live.base.radiant_kills'),20);assert.equal(value(r,'draft_live.base.dire_kills'),10);assert.equal(value(r,'draft_live.base.total_kills'),30);assert.equal(value(r,'draft_live.base.kills_diff'),10);
 for(const key of ['nw_sum_diff','gpm_sum_diff','xpm_sum_diff','level_sum_diff'])assert.equal(value(r,'draft_live.base.'+key),r.nativeBundle.vector.values[r.nativeBundle.vector.names.indexOf('roshan.'+key)]);
 assert.equal(value(r,'draft_live.base.roshan_timer_raw'),0);assert.equal(value(r,'draft_live.base.roshan_timer_positive'),0);assert.equal(value(r,'draft_live.base.roshan_alive'),null);assert.equal(value(r,'draft_live.base.roshan_elapsed_since_confirmed_death'),null);assert.equal(value(r,'draft_live.base.aegis_confirmed_steal'),null);
 assert.ok(r.vector.definitions.filter(d=>d.name.startsWith('draft_live.base.')).every(d=>d.inputScopes.length===1&&d.inputScopes[0]==='current_live'));
});
test('missing current base operands remain missing, never imputed from history or other metrics',()=>{
 const r=run(history(),liveEntry({missingGpm:true}));assert.equal(value(r,'draft_live.base.gpm_sum_diff'),null);assert.notEqual(value(r,'draft_live.base.nw_sum_diff'),null);
 const entry=liveEntry(),raw=JSON.parse(entry.rawInput.utf8),m=JSON.parse(entry.metadataInput.utf8);delete raw.result.games[0].scoreboard.radiant.score;
 const rawInput=pinned(raw),o=normalizeLocalCapture({...m.capture,body:Buffer.from(rawInput.utf8),rawSha256:rawInput.pin.sha256,payloadRef:'journal:'+rawInput.pin.sha256}).observations[0],r2=run(history(),{rawInput,metadataInput:pinned({...m,observationId:o.observationId})});
 assert.equal(value(r2,'draft_live.base.radiant_kills'),null);assert.equal(value(r2,'draft_live.base.total_kills'),null);assert.equal(value(r2,'draft_live.base.kills_diff'),null);assert.equal(value(r2,'draft_live.base.dire_kills'),10);
});
test('raw byte pin tamper, future receipt, terminal packet and missing clock are rejected',()=>{
 const h=history(),e=liveEntry();assert.throws(()=>run(h,{...e,rawInput:{...e.rawInput,utf8:e.rawInput.utf8+' '}}));assert.throws(()=>run(h,liveEntry({time:'2026-10-23T12:41:00Z'})));assert.equal(run(h,liveEntry({outcome:true})).status,'blocked');assert.equal(run(h,liveEntry({clock:null})).reason,'dynamic_live_clock_or_phase_unavailable');
});
test('positive clock with absent phase is not silently treated as live phase5',()=>{
 const h=history();assert.equal(run(h,liveEntry({phase:null,clock:1200})).reason,'dynamic_live_clock_or_phase_unavailable');assert.equal(run(h,liveEntry({phase:4,clock:1200})).reason,'dynamic_live_clock_or_phase_unavailable');
});
test('newly disclosed account requires a new bound history revision, never retroactive personal form',()=>{
 const h=history({accounts:false}),r=run(h,liveEntry({accounts:true}));assert.equal(r.reason,'dynamic_history_roster_mismatch');
});
test('history materialized after decision and native capture before identity validFrom are rejected',()=>{
 const h=history({computedAt:'2026-10-23T12:45:00Z'});assert.equal(run(h,liveEntry()).reason,'draft_history_times');const late=history({time:'2026-10-23T12:32:00Z',computedAt:'2026-10-23T12:33:00Z'});assert.equal(run(late,liveEntry()).reason,'dynamic_context_not_known_at_capture');
});
test('unreviewed rules/event payloads cannot reinterpret raw timers',()=>{
 const h=history();assert.throws(()=>run(h,liveEntry(),null,{rulesEvidence:pinned({})}),/host_review_pin/);assert.throws(()=>run(h,liveEntry(),null,{eventsEvidence:pinned({})}),/host_review_pin/);
});
