import test from 'node:test';import assert from 'node:assert/strict';
import {draftArgs,draftEntry,pinned} from './observedDraftHistory.fixtures.mjs';
import {createRetainedHistorySourceExport as source,verifyRetainedHistorySourceExport as verifySource} from './retainedHistorySourceExport.mjs';
import {createDynamicHistoryProof,readDynamicHistoryProof} from './observedDraftFeatureBundle.mjs';
import {produceObservedDraftHistory,validateObservedDraftHistory} from './observedDraftHistory.mjs';
import {createUnifiedFeatureProducer} from './unifiedFeatureProducer.mjs';
import {syntheticRegistry} from '../../feature-registry/registry-contract.fixtures.mjs';
import {normalizeLocalCapture} from './steamLiveAdapter.mjs';
import {evidenceHash} from './playerHeroEconomyFeatures.mjs';
function input(){const args=draftArgs({accounts:true}),exported=source({...args,exportedAt:args.computedAt,versionInputs:[]}),body=JSON.parse(exported.envelopeInput.utf8);return{args,exported,proofArgs:{...args,factsInput:body.factsInput,nativeInput:body.nativeInput,availabilityBasis:'retained_receipt_reconstruction'}};}
function factory(){const[index,familyDocument,targetDocument]=syntheticRegistry(),sourceInventory=Object.fromEntries(['history','live','series','draft','seriesHistory'].map(k=>[k,{primarySha256:'a'.repeat(64),files:[{path:k+'.synthetic.mjs',sha256:'a'.repeat(64)}]}]));return createUnifiedFeatureProducer({index,familyDocument,targetDocument,sourceInventory});}
test('qualified empty retained corpus supplies missing history and still permits source-bound post-draft diagnostics',()=>{
 const {args,exported,proofArgs}=input();assert.equal(exported.population.factsUsable,true);
 const h=createDynamicHistoryProof(proofArgs);assert.equal(readDynamicHistoryProof(h.proof,{matchId:args.matchId,decisionAt:args.computedAt}).accepted,true);
 assert.deepEqual(h.context.dependencies,[]);assert.deepEqual(h.context.sourceMatches,[]);assert.equal(h.context.producer.emptyRetainedCorpus,true);
 for(const collection of ['players','heroes','teams'])for(const p of h.context.featurePayload[collection]){assert.ok(Object.values(p.values).every(v=>v===null));assert.ok(Object.values(p.statistics).every(s=>s.supportMaps===0&&s.value===null));}
 const produced=factory().generateFeatureBundle({mode:'POST',matchId:args.matchId,decisionAt:args.computedAt,historyProof:h.proof,sourceExportInput:exported.envelopeInput,expectedSourceSnapshotHash:exported.sourceSnapshotHash});
 assert.deepEqual(produced.routes.map(r=>r.targetId),['POST_MAP_WIN','POST_KILLS','POST_DURATION']);assert.ok(produced.routes.every(r=>r.inferenceVector===null));
 const v=produced.routes[0].diagnosticVector;assert.ok(v.names.some(n=>n.startsWith('draft_identity.')));
 assert.equal(produced.eligibleForServing,false);
 const frame=draftEntry({accounts:true,time:'2026-10-23T12:31:00Z',clock:900,phase:5}),raw=JSON.parse(frame.rawInput.utf8),metadata=JSON.parse(frame.metadataInput.utf8);
 for(const side of ['radiant','dire'])for(const p of raw.result.games[0].scoreboard[side].players)Object.assign(p,{net_worth:5000+p.hero_id*100,gold_per_min:400+p.hero_id,xp_per_min:500+p.hero_id,level:10,gold:100});
 const rawInput=pinned(raw),observation=normalizeLocalCapture({...metadata.capture,body:Buffer.from(rawInput.utf8),rawSha256:rawInput.pin.sha256,payloadRef:'journal:'+rawInput.pin.sha256}).observations[0];
 const entry={rawInput,metadataInput:pinned({...metadata,observationId:observation.observationId})};
 const current=factory().generateFeatureBundle({mode:'LIVE',matchId:args.matchId,decisionAt:'2026-10-23T12:31:00Z',historyProof:h.proof,sourceExportInput:exported.envelopeInput,expectedSourceSnapshotHash:exported.sourceSnapshotHash,livePrefixInputs:[entry]});
 assert.deepEqual(current.routes.map(r=>r.targetId),['LIVE_MAP_WIN','LIVE_KILLS','LIVE_DURATION']);
 const cv=current.routes[0].diagnosticVector;const n=cv.names.indexOf('draft_live.hero.1.native_gpm.observed_value');assert.ok(n>=0);assert.equal(cv.values[n],401);
 assert.equal(current.eligibleForServing,false);assert.ok(current.routes.every(r=>r.inferenceVector===null));
});
test('unknown empty source, corrupt retained envelope and fake empty context statistics remain blocked',()=>{
 const {args,exported,proofArgs}=input(),unknown={...args,factsInput:pinned({contract:'aegis.prior-map-facts.v1',maps:[]}),nativeInput:pinned({contract:'aegis.pinned-native-economy-observations.v1',observations:[]})};
 assert.equal(produceObservedDraftHistory(unknown).reason,'no_available_prior_maps');
 assert.throws(()=>verifySource({...exported.envelopeInput,utf8:exported.envelopeInput.utf8+' '}),/envelope_bytes_or_bound/);
 const badFacts=JSON.parse(proofArgs.factsInput.utf8);badFacts.scope.rowCount=1;assert.throws(()=>createDynamicHistoryProof({...proofArgs,factsInput:pinned(badFacts)}),/retained_source_scope_or_basis/);
 const h=createDynamicHistoryProof(proofArgs),bad=structuredClone(h.context);bad.featurePayload.players[0].values.recentForm=0;const {contentHash,...b}=bad;bad.contentHash=evidenceHash(b);assert.equal(validateObservedDraftHistory(bad,{matchId:args.matchId,decisionAt:args.computedAt}).accepted,false);
 const invalidProfile=structuredClone(h.context);invalidProfile.featurePayload.players[0]=null;const {contentHash:ignored,...invalidBody}=invalidProfile;invalidProfile.contentHash=evidenceHash(invalidBody);assert.equal(validateObservedDraftHistory(invalidProfile,{matchId:args.matchId,decisionAt:args.computedAt}).accepted,false);
});
