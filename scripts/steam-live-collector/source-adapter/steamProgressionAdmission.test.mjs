import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceSteamProgressionAdmission as advance,readSteamProgressionProof as read,ADMISSION_PROFILE,PROGRESSION_POLICY} from './steamProgressionAdmission.mjs';
import {draftEntry,draftArgs,pinned} from './observedDraftHistory.fixtures.mjs';
import {normalizeLocalCapture} from './steamLiveAdapter.mjs';
import {steamObservationIdentity} from './steamObservationIdentity.mjs';
import {advanceObservedDraftFeatureBundle,createDynamicHistoryProof,PROGRESSING_CONTRACT,readObservedFeatureSchemaPoolStatus} from './observedDraftFeatureBundle.mjs';
import {advanceSteamFeatureBundle} from './steamFeatureBundle.mjs';
import {createRetainedReplayFrameProof} from './retainedReplayFrame.mjs';
const T='2026-10-23T12:30:00Z',U='2026-10-23T12:32:00Z',V='2026-10-23T12:34:00Z';
function entry({time=T,clock=600,phase=null,accounts=true,teams=true,map='90001',missing=false,mutate=null}={}){
 const e=draftEntry({time,clock,phase,accounts,teams,matchId:map}),raw=JSON.parse(e.rawInput.utf8);
 for(const side of ['radiant','dire'])for(const p of raw.result.games[0].scoreboard[side].players)Object.assign(p,{net_worth:5000+p.hero_id,gold_per_min:400+p.hero_id,xp_per_min:500+p.hero_id,level:10,gold:300});
 if(missing)raw.result.games=[];if(mutate)mutate(raw);
 const rawInput=pinned(raw),m=JSON.parse(e.metadataInput.utf8),capture=m.capture;
 const normalized=normalizeLocalCapture({...capture,body:Buffer.from(rawInput.utf8),rawSha256:rawInput.pin.sha256,payloadRef:'journal:'+rawInput.pin.sha256});
 const o=normalized.observations.find(x=>x.matchId===map);
 const receiptInput=pinned({version:'steam-live-diagnostic-collector.v1',source:'steam',endpoint:capture.endpoint,httpStatus:200,status:'captured_diagnostic',diagnosticOnly:true,servingEnabled:false,trainingEnabled:false,publicPromotion:false,requestId:'synthetic-'+time,requestStartedAt:time,receivedAt:time,rawPersistedAt:time,completedAt:time,rawSha256:rawInput.pin.sha256,rawFile:'raw/'+rawInput.pin.sha256+'.body',payloadRef:'journal:'+rawInput.pin.sha256,bodyBytes:rawInput.pin.bytes});
 return{rawInput,receiptInput,metadataInput:pinned({...m,observationId:o?.observationId??m.observationId}),observation:o};
}
const pair=(options={})=>[entry(options),entry({...options,time:U,clock:720})];
const run=(es,previous=null,decisionAt=JSON.parse(es.at(-1).receiptInput.utf8).completedAt,extra={})=>advance(previous,{retainedPrefixInputs:es.map(({rawInput,receiptInput})=>({rawInput,receiptInput})),matchId:'90001',decisionAt,...extra});
const gate=(r,decisionAt=U,extra={})=>read(r.privateProof,{matchId:'90001',observationId:r.provenance?.observationId,rawSha256:r.provenance?.rawSha256,sourceProfile:r.provenance?.sourceProfile,identityHash:r.provenance?.identityHash,decisionAt,...extra});
test('actual two committed raw captures mint a held absent-phase diagnostic proof',()=>{
 const es=pair(),r=run(es);assert.equal(r.status,'admitted_diagnostic');assert.equal(r.provenance.admissionProfile,ADMISSION_PROFILE);assert.equal(gate(r).accepted,true);assert.equal(gate(r).observation.dynamic.phase.status,'absent');assert.equal(gate(r).observation.dynamic.phase.value,null);assert.equal(r.eligibleForTraining,false);assert.equal(r.eligibleForServing,false);assert.equal(gate(r).provenance.journalEnumerationCompletenessProven,false);
 const a=run([es[0]]),b=run([es[1]],a.nextPrivateToken);assert.deepEqual(b.provenance,r.provenance);assert.equal(run(es).privateProof===r.privateProof,false);
});
test('one frame and equal clocks cannot initially prove progress',()=>{assert.equal(run([entry()]).status,'blocked');assert.equal(run([entry(),entry({time:U})]).status,'blocked');});
for(const clock of [0,-1,null])test('clock '+clock+' does not admit',()=>{assert.equal(run([entry({clock}),entry({time:U,clock:720})]).status,'blocked');});
for(const phase of [4,5,6,'5',null])if(phase!==null)test('explicit/invalid phase '+phase+' does not become progressing cohort',()=>{assert.equal(run(pair({phase})).status,'blocked');});
for(const marker of ['radiant_win','finished','match_status'])test('raw completion marker '+marker+' closes source even when false',()=>{
 const a=run(pair()),bad=entry({time:V,clock:840,mutate:x=>{x.result.games[0][marker]=false;}}),b=run([bad],a.nextPrivateToken);assert.equal(b.status,'blocked');assert.equal(run([entry({time:'2026-10-23T12:36:00Z',clock:960})],b.nextPrivateToken).reason,'progression_terminal_source_closed');
});
test('copy, clone, hash, reviewed wrapper and cross-map/profile/identity cannot forge authority',()=>{
 const r=run(pair());for(const p of [structuredClone(r.privateProof),{...r.privateProof},r.privateProof.bindingHash,{reviewed:true,context:r.provenance}])assert.equal(gate({...r,privateProof:p}).accepted,false);
 for(const x of [{matchId:'90002'},{sourceProfile:'steam.GetRealtimeStats.v1'},{identityHash:'0'.repeat(64)},{rawSha256:'0'.repeat(64)}])assert.equal(gate(r,U,x).accepted,false);
 assert.equal(run([entry({time:V,clock:840})],structuredClone(r.nextPrivateToken)).reason,'owned_progression_state_required');
 const o=structuredClone(gate(r).observation);o.sides.radiant.players[0].netWorth.value=999999;assert.equal(gate(r,U,{observation:o}).reason,'progression_normalized_observation_mismatch');
});
test('raw or receipt pin tamper breaks evidence instead of accepting a public summary',()=>{
 const es=pair();es[1].rawInput.utf8+=' ';assert.equal(run(es).reason,'historical_evidence_bytes_mismatch');
 const es2=pair();es2[1].receiptInput.utf8+=' ';assert.equal(run(es2).status,'blocked');
});
test('missing map and intervening invalid committed capture break consecutive proof',()=>{
 const a=run(pair()),missing=entry({time:V,missing:true}),b=run([missing],a.nextPrivateToken),c=run([entry({time:'2026-10-23T12:36:00Z',clock:960})],b.nextPrivateToken);assert.equal(c.status,'blocked');assert.equal(run([entry({time:'2026-10-23T12:38:00Z',clock:1080})],c.nextPrivateToken).status,'admitted_diagnostic');
 const invalid=entry({time:V,clock:840}),r=JSON.parse(invalid.receiptInput.utf8);invalid.receiptInput=pinned({...r,httpStatus:500,status:'http_error'});const d=run([invalid],a.nextPrivateToken);assert.equal(run([entry({time:'2026-10-23T12:36:00Z',clock:960})],d.nextPrivateToken).status,'blocked');
});
test('account disclosure and team identity change are barriers; anonymous pairs remain admissible',()=>{
 assert.equal(run(pair({accounts:false})).status,'admitted_diagnostic');
 assert.equal(run([entry({accounts:false}),entry({time:U,clock:720,accounts:true})]).status,'blocked');
 assert.equal(run([entry(),entry({time:U,clock:720,mutate:x=>{x.result.games[0].radiant_team.team_id=101;}})]).status,'blocked');
});
for(const [time,accepted]of [['2026-10-23T12:32:59.999999999Z',true],['2026-10-23T12:33:00Z',true],['2026-10-23T12:33:00.000000001Z',false]])test('receipt gap nanosecond boundary '+time,()=>{assert.equal(run([entry(),entry({time,clock:720})]).status==='admitted_diagnostic',accepted);});
test('clock plausibility, rewind, receipt reorder and future receipt fail closed',()=>{
 assert.equal(run([entry(),entry({time:U,clock:751})]).reason,'progression_implausible_clock_advance');
 assert.equal(run([entry(),entry({time:U,clock:599})]).reason,'progression_game_clock_regression');
 assert.equal(run([entry({time:U}),entry({clock:720})],null,U).reason,'progression_receipt_not_strictly_increasing');
 assert.equal(run(pair(),null,'2026-10-23T12:31:59.999999999Z').status,'blocked');
});
test('an implausible capture is a barrier and cannot seed the next admitted pair',()=>{
 const a=run([entry(),entry({time:U,clock:751})]),b=run([entry({time:V,clock:800})],a.nextPrivateToken);
 assert.equal(a.reason,'progression_implausible_clock_advance');assert.equal(b.status,'blocked');
 assert.equal(run([entry({time:'2026-10-23T12:36:00Z',clock:920})],b.nextPrivateToken).status,'admitted_diagnostic');
});
test('a different endpoint capture breaks progression and profiles have distinct schemas',()=>{
 const es=pair(),a=run(es),foreign=entry({time:V,clock:840}),r=JSON.parse(foreign.receiptInput.utf8);foreign.receiptInput=pinned({...r,endpoint:'GetRealtimeStats/v1'});
 const b=run([foreign],a.nextPrivateToken);assert.equal(b.status,'blocked');assert.equal(run([entry({time:'2026-10-23T12:36:00Z',clock:960})],b.nextPrivateToken).status,'blocked');
 const qualified=advanceSteamFeatureBundle(null,es[1].observation,{progressionProof:a.privateProof,decisionAt:U}),legacy=advanceSteamFeatureBundle(null,es[1].observation);
 assert.notEqual(qualified.contract,legacy.contract);assert.notEqual(qualified.vector.schemaHash,legacy.vector.schemaHash);assert.equal(advanceSteamFeatureBundle(qualified.state,es[1].observation).resetReasons.includes('admission_profile_changed'),true);
});
test('history materialization does not replace progression or lease evidence',()=>{
 const es=pair(),a=run(es),inputs=draftArgs({accounts:true});inputs.computedAt='2026-10-23T12:31:00Z';const h=createDynamicHistoryProof(inputs);
 const r=advanceObservedDraftFeatureBundle(null,{matchId:'90001',decisionAt:U,historyProof:h.proof,livePrefixInputs:[{rawInput:es[1].rawInput,metadataInput:es[1].metadataInput}],progressionProof:a.privateProof});
 assert.equal(r.status,'diagnostic_produced');assert.equal(r.admissionProvenance.lastProgressAt,a.provenance.lastProgressAt);assert.equal(r.admissionProvenance.expiresAt,a.provenance.expiresAt);assert.equal(gate(a).accepted,true);
});
test('retained source horizon preserves actual history computation time and default live expiry',()=>{
 const es=pair(),a=run(es),inputs=draftArgs({accounts:true});inputs.computedAt='2026-10-23T12:45:00Z';const h=createDynamicHistoryProof(inputs),options={matchId:'90001',decisionAt:'2026-10-23T12:45:00Z',historyProof:h.proof,livePrefixInputs:[{rawInput:es[1].rawInput,metadataInput:es[1].metadataInput}],progressionProof:a.privateProof};
 assert.equal(advanceObservedDraftFeatureBundle(null,options).reason,'progression_proof_outside_lease_or_decision');
 const retainedReplayProof=createRetainedReplayFrameProof({...es[1],reconstructedAt:options.decisionAt});
 const r=advanceObservedDraftFeatureBundle(null,{...options,sourceDecisionAt:U,retainedReplayProof});assert.equal(r.status,'diagnostic_produced');assert.equal(r.historyRefs.computedAt,'2026-10-23T12:45:00Z');assert.equal(r.decisionAt,'2026-10-23T12:45:00Z');assert.equal(r.sourceDecisionAt,U);assert.equal(r.reconstructedSourceHorizon,true);assert.equal(r.recordedPrediction,false);
 assert.equal(advanceObservedDraftFeatureBundle(null,{...options,sourceDecisionAt:'2026-10-23T12:45:00.000000001Z'}).reason,'dynamic_source_decision_horizon');
 assert.equal(advanceObservedDraftFeatureBundle(null,{...options,sourceDecisionAt:'2026-10-23T12:31:59.999999999Z',retainedReplayProof}).reason,'dynamic_retained_replay_horizon_mismatch');
 const c=entry({time:V,clock:840}),abc=run([c],a.nextPrivateToken),lateMetadata=pinned({...JSON.parse(es[1].metadataInput.utf8),decisionAt:options.decisionAt});
 assert.equal(advanceObservedDraftFeatureBundle(null,{...options,sourceDecisionAt:V,retainedReplayProof:createRetainedReplayFrameProof({...c,reconstructedAt:options.decisionAt}),livePrefixInputs:[{rawInput:es[1].rawInput,metadataInput:lateMetadata},{rawInput:c.rawInput,metadataInput:c.metadataInput}],progressionProofs:[a.privateProof,abc.privateProof]}).reason,'dynamic_source_horizon_before_capture');
});
test('equal-clock packets retain original expiry and cannot renew a lease forever',()=>{
 const a=run(pair()),b=run([entry({time:V,clock:720})],a.nextPrivateToken);assert.equal(b.status,'admitted_diagnostic');assert.equal(b.expiresAt,a.expiresAt);
 assert.equal(gate(b,'2026-10-23T12:35:00Z').accepted,true);assert.equal(gate(b,'2026-10-23T12:35:00.000000001Z').accepted,false);
 const c=run([entry({time:'2026-10-23T12:35:00.000000001Z',clock:720})],b.nextPrivateToken);assert.equal(c.status,'blocked');assert.equal(run([entry({time:'2026-10-23T12:36:00Z',clock:780})],c.nextPrivateToken).status,'admitted_diagnostic');
});
test('STOP removes continuity and exact policy cannot be relaxed',()=>{
 const a=run(pair()),b=advance(a.nextPrivateToken,{matchId:'90001',decisionAt:V,stopped:true});assert.equal(b.reason,'manual_stop_or_abort');assert.equal(run([entry({time:V,clock:840})],b.nextPrivateToken).status,'blocked');assert.equal(run(pair(),null,U,{policy:{...PROGRESSION_POLICY,leaseSeconds:181}}).status,'blocked');
});
test('progression proof reaches actual rich and native vectors without rewriting phase',()=>{
 const es=pair(),proof=run(es),h=createDynamicHistoryProof(draftArgs({accounts:true}));
 const r=advanceObservedDraftFeatureBundle(null,{matchId:'90001',decisionAt:U,historyProof:h.proof,livePrefixInputs:[{rawInput:es[1].rawInput,metadataInput:es[1].metadataInput}],progressionProof:proof.privateProof});
 assert.equal(r.status,'diagnostic_produced');assert.equal(r.contract,PROGRESSING_CONTRACT);assert.equal(r.admissionProfile,ADMISSION_PROFILE);assert.equal(r.sourceCoherence.explicitPhase5,false);assert.equal(r.vector.values[r.vector.names.indexOf('draft_live.base.phase_code')],null);assert.equal(r.vector.values[r.vector.names.indexOf('draft_live.hero.1.native_gpm.recentForm.history_product')],401*.6);assert.equal(r.nativeBundle.economy.status,'coherent_diagnostic_features');assert.ok(r.vector.featureCount>24000);
 assert.equal(r.nativeBundle.vector.values[r.nativeBundle.vector.names.indexOf('native_economy.phase_explicit')],null);
 const mutated=structuredClone(es[1].observation);mutated.sides.radiant.players[0].goldPerMinute.value=999;assert.throws(()=>advanceSteamFeatureBundle(null,mutated,{progressionProof:proof.privateProof,decisionAt:U}),/normalized_observation_mismatch/);
});
test('admitted anonymous native economy preserves literals without personal context or roles',()=>{
 const es=pair({accounts:false}),proof=run(es),h=createDynamicHistoryProof(draftArgs({accounts:false}));
 const r=advanceObservedDraftFeatureBundle(null,{matchId:'90001',decisionAt:U,historyProof:h.proof,livePrefixInputs:[{rawInput:es[1].rawInput,metadataInput:es[1].metadataInput}],progressionProof:proof.privateProof});
 assert.equal(r.status,'diagnostic_produced');assert.equal(r.nativeBundle.economy.status,'coherent_diagnostic_features');
 assert.equal(r.vector.values[r.vector.names.indexOf('draft_live.hero.1.native_gpm.recentForm.history_product')],null);
 assert.equal(r.nativeBundle.vector.values[r.nativeBundle.vector.names.indexOf('native_economy.hero.1.native_gpm.value')],401);
 assert.equal(r.nativeBundle.vector.values[r.nativeBundle.vector.names.indexOf('native_economy.roles_verified_count')],0);
});
test('prefix proofs, sequential state and raw-replayed restart yield identical vectors',()=>{
 const a=entry(),b=entry({time:U,clock:720}),c=entry({time:V,clock:840}),ab=run([a,b]),abc=run([c],ab.nextPrivateToken),h=createDynamicHistoryProof(draftArgs({accounts:true}));
 const opts={matchId:'90001',decisionAt:V,historyProof:h.proof},live=e=>({rawInput:e.rawInput,metadataInput:e.metadataInput});
 const first=advanceObservedDraftFeatureBundle(null,{...opts,decisionAt:U,livePrefixInputs:[live(b)],progressionProof:ab.privateProof});
 const online=advanceObservedDraftFeatureBundle(first.state,{...opts,livePrefixInputs:[live(c)],progressionProof:abc.privateProof});
 const offline=advanceObservedDraftFeatureBundle(null,{...opts,livePrefixInputs:[live(b),live(c)],progressionProofs:[ab.privateProof,abc.privateProof]});
 assert.deepEqual(online.vector,offline.vector);assert.deepEqual(online.nativeBundle.vector,offline.nativeBundle.vector);
 const restarted=run([a,b,c]);assert.deepEqual(restarted.provenance,abc.provenance);
});
test('definition pool reuses immutable semantics across values and invalidates rules/support/admission',()=>{
 const produceHistory=(support=5,flip=false,accounts=true)=>{const inputs=draftArgs({accounts});inputs.minimumSupport=support;if(flip){const facts=JSON.parse(inputs.factsInput.utf8);for(const m of facts.maps)m.radiantWon=!m.radiantWon;inputs.factsInput=pinned(facts);}return createDynamicHistoryProof(inputs);};
 const apply=(h,e,previous=null,extra={})=>advanceObservedDraftFeatureBundle(previous,{matchId:'90001',decisionAt:JSON.parse(e.metadataInput.utf8).decisionAt,historyProof:h.proof,livePrefixInputs:[{rawInput:e.rawInput,metadataInput:e.metadataInput}],...extra});
 const h7=produceHistory(7),first=apply(h7,entry({phase:5})),warm=apply(h7,entry({phase:5,time:U,clock:720}),first.state);
 assert.equal(first.status,'diagnostic_produced');assert.equal(first.definitionSchemaPool.reused,false);assert.equal(warm.definitionSchemaPool.reused,true);assert.equal(first.vector.names,warm.vector.names);assert.equal(first.vector.definitions,warm.vector.definitions);assert.equal(first.vector.semanticSchemaHash,warm.vector.semanticSchemaHash);assert.notDeepEqual(first.vector.values,warm.vector.values);assert.notEqual(first.vector.values,warm.vector.values);
 assert.equal(Object.isFrozen(first.vector.definitions),true);assert.equal(Object.isFrozen(first.vector.definitions[0].inputScopes),true);assert.throws(()=>{first.vector.definitions[0].formula='forged';});assert.throws(()=>first.vector.names.push('forged'));
 const h5=produceHistory(),base=apply(h5,entry({phase:5})),changedValues=apply(produceHistory(5,true),entry({phase:5}));assert.notEqual(base.definitionSchemaPool.semanticsKey,first.definitionSchemaPool.semanticsKey);assert.notEqual(base.vector.semanticSchemaHash,first.vector.semanticSchemaHash);assert.equal(changedValues.definitionSchemaPool.reused,true);assert.equal(changedValues.vector.definitions,base.vector.definitions);assert.equal(changedValues.vector.semanticSchemaHash,base.vector.semanticSchemaHash);assert.notDeepEqual(changedValues.vector.values,base.vector.values);
 const rules=pinned({contract:'aegis.roshan-rules.v1',version:'synthetic-pool-v1',evidenceRef:'synthetic:pool-rules',patch:'synthetic',sourceProfile:'steam.GetLiveLeagueGames.v1.scoreboard',knownAt:'2026-10-23T12:00:00Z',respawnMinimumSeconds:480,respawnMaximumSeconds:660,aegisLifetimeSeconds:300});
 const ruleFrame=apply(h5,entry({phase:5}),null,{patch:'synthetic',rulesEvidence:rules,expectedRulesSha256:rules.pin.sha256});assert.equal(ruleFrame.status,'diagnostic_produced');assert.notEqual(ruleFrame.definitionSchemaPool.semanticsKey,base.definitionSchemaPool.semanticsKey);assert.notEqual(ruleFrame.vector.definitions,base.vector.definitions);assert.equal(ruleFrame.vector.semanticSchemaHash,base.vector.semanticSchemaHash);
 const anonymous=apply(produceHistory(5,false,false),entry({phase:5,accounts:false}));assert.equal(anonymous.status,'diagnostic_produced');assert.equal(anonymous.definitionSchemaPool.semanticsKey,base.definitionSchemaPool.semanticsKey);assert.equal(anonymous.vector.definitions,base.vector.definitions);assert.equal(anonymous.vector.semanticSchemaHash,base.vector.semanticSchemaHash);assert.notDeepEqual(anonymous.vector.values,base.vector.values);
 const es=pair(),proof=run(es),progressing=apply(h5,es[1],null,{progressionProof:proof.privateProof});assert.equal(progressing.status,'diagnostic_produced');assert.notEqual(progressing.definitionSchemaPool.semanticsKey,base.definitionSchemaPool.semanticsKey);assert.notEqual(progressing.vector.semanticSchemaHash,base.vector.semanticSchemaHash);assert.equal(progressing.vector.definitions[0].admissionProfile,ADMISSION_PROFILE);
 const status=readObservedFeatureSchemaPoolStatus();assert.equal(status.maximumSemantics,2);assert.equal(status.semanticsCount,2);assert.ok(status.compiledDefinitionSchemas>=4);assert.ok(status.reusedDefinitionSchemas>=2);assert.equal(first.vector.names,warm.vector.names);
});
