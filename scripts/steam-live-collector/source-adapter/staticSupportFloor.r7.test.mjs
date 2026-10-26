/** Small strict derived-static support-policy test. The CAS is an actual in-memory
 * byte store, not a Windows-lock, filesystem restart, rich-vector or archive test.
 * Target/input proofs and compiler schema/vector owners are minted by real ports. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {syntheticRegistry} from '../../feature-registry/registry-contract.fixtures.mjs';
import {digest,validateRegistry} from '../../feature-registry/registry-contract.mjs';
import {pinRetainedHistoryJson as pin} from './retainedOpenDotaFacts.mjs';
import {createDiagnosticResourceArena} from './diagnosticResourceArena.mjs';
import {createRetainedStaticHistoryTargetStore} from './retainedStaticHistoryTarget.mjs';
import {createCompactHistoricalInputStore,readCompactHistoricalInputProof} from './compactHistoricalInputStore.mjs';
import {produceChronologicalResultRatings} from './chronologicalResultRatings.mjs';
import {createFeatureProjectionCompiler} from './featureProjectionCompiler.mjs';
import {createCompactFeatureJournal} from './compactFeatureJournal.mjs';

const AT='2026-10-25T12:00:00Z',CUTOFF='2026-10-25T10:00:00Z',PRIOR='2026-10-24T10:00:00Z';
const sha=text=>createHash('sha256').update(text).digest('hex');
function memoryWriter(){
 const objects=new Map(),commits=[];
 return {contract:'aegis.persistent-artifact-writer.v1',commits,
  readBatchLimits:Object.freeze({maxReferences:64,maxBytes:8*1024**2}),
  async commit({kind,utf8,expectedSha256}){
   assert.equal(typeof utf8,'string');assert.equal(sha(utf8),expectedSha256);assert.ok(Buffer.byteLength(utf8)<=16*1024**2);
   const reference=Object.freeze({kind,sha256:expectedSha256,bytes:Buffer.byteLength(utf8)});
   objects.set(kind+':'+expectedSha256,utf8);commits.push(reference);return reference;
  },
  async read(reference){return objects.get(reference.kind+':'+reference.sha256);},
  async readMany(references){assert.ok(references.length<=64);assert.ok(references.reduce((n,r)=>n+r.bytes,0)<=8*1024**2);return references.map(r=>objects.get(r.kind+':'+r.sha256));}
 };
}
const roster=()=>Array.from({length:10},(_,i)=>({accountId:String(i+1),heroId:null,side:i<5?'radiant':'dire',teamId:i<5?'100':'200'}));
function source(minimumSupport=3){
 const events=Array.from({length:5},(_,i)=>({matchId:String(i+1),endedAt:PRIOR,outcomeKnownAt:PRIOR,playersKnownAt:PRIOR,radiantTeamId:'100',direTeamId:'200',radiantWon:i%2===0,durationSeconds:2400,radiantKills:25,direKills:20,evidenceRef:'synthetic:completed:'+String(i+1),players:roster().map(({accountId,side},j)=>({accountId,side,heroId:j+1}))}));
 const factsInput=pin({contract:'aegis.prior-map-facts.v1',maps:events}),result=produceChronologicalResultRatings({events,roster:roster(),historyCutoffAt:CUTOFF,minimumSupport,factsPin:factsInput.pin,populationBasis:'synthetic_complete_provided_facts_only',formulaVersion:'aegis.prior-map-relational-statistics.v3'});
 const index=result.names.indexOf('histrel.r7.radiant.team.result_rating_k32.rating');assert.ok(index>=0);assert.notEqual(result.values[index],null);
 return {factsInput,definition:result.definitions[index],value:result.values[index],eventCount:events.length};
}
const CLOSING_REFERENCE='aegis.prior_native_team_landmark_lead_closing_90d.v1';
function missingClosingPolicyControl(metric,minimumSupport){
 // Policy-only synthetic descriptor with no native observations: the value is
 // deliberately missing, never a fabricated qualified cohort count or estimate.
 const name='synthetic.s05.missing_native_closing.'+metric;
 return {name,familyId:'S05',formula:'synthetic missing-value control for exact reviewed prior native closing support policy',formulaVersion:'aegis.prior-map-relational-statistics.v3',type:'float64',units:metric==='supportMaps'?'distinct_maps':metric==='winFraction'?'fraction':'seconds',inputScopes:['prior_completed_maps','current_identity'],minimumSupport:metric==='supportMaps'?0:Math.max(5,minimumSupport),historyWindowDays:90,missingPolicy:'null_with_missing_mask; no native population supplied by this fixture',formulaParameters:{templateId:CLOSING_REFERENCE,side:'radiant',landmarkSeconds:600,condition:'lead_at_least_1000',thresholdNativeNetWorth:1000,metric,contextMinimumSupport:minimumSupport,referenceDefinition:CLOSING_REFERENCE}};
}
async function runCase({mutate=null,plainM3=false,rejected=false,minimumSupport=3,closingMetric=null}={}){
 const writer=memoryWriter(),arena=createDiagnosticResourceArena({maxBytes:2*1024**3}),data=source(minimumSupport);let targets,inputs,derived,written,compiler,block,route,journal;
 try{
  targets=createRetainedStaticHistoryTargetStore({writer,resourceArena:arena,now:()=>AT});
  derived=await targets.derivePrematchTarget({identityInput:pin({contract:'aegis.prematch-roster-receipt.v1',matchId:'90001',knownAt:CUTOFF,teams:{radiant:'100',dire:'200'},players:roster().map(({accountId,side})=>({accountId,side}))}),decisionAt:AT});
  inputs=createCompactHistoricalInputStore({writer,resourceArena:arena,clock:()=>AT,targetDerivationStore:targets});
  written=await inputs.writeHistoricalInputs({mode:'PRE',factsInput:data.factsInput,targetInput:derived.targetInput,minimumSupport,targetDerivationReference:derived.reference,decisionAt:AT});
  const target=JSON.parse(derived.targetInput.utf8),historicalBindings={kind:'map_prematch',factsSha256:data.factsInput.pin.sha256,targetSha256:derived.targetInput.pin.sha256,historyCutoffAt:target.historyCutoffAt,validFrom:target.knownAt},targetBinding={mapId:'90001',mapSides:target.teams,series:null};
  const proofOptions={reference:written.reference,mode:'PRE',decisionAt:AT,requireParsedTargetBinding:true,requireTargetDerivation:true,matchId:'90001',seriesId:null,historicalBindings,targetBinding,seriesReceiptPin:null};
  const proof=readCompactHistoricalInputProof(written.proof,proofOptions);assert.equal(proof.calculationOptions.minimumSupport,minimumSupport);assert.equal(proof.parsedTargetVerified,true);assert.equal(proof.targetDerivationVerified,true);
  assert.throws(()=>readCompactHistoricalInputProof(structuredClone(written.proof),proofOptions),/owned_active_proof/);
  const reference=written.reference;written.release();written=null;
  let definition=structuredClone(data.definition),value=data.value;
  if(plainM3){
   // Distinct old-style exact-M policy control. This is not a relabelled C13
   // rating: its literal count uses the same five committed synthetic map IDs.
   definition={name:'synthetic.old_plain_m3.distinct_map_count',familyId:'H02',formula:'count distinct eligible provided prior map IDs; exact-M3 policy control',formulaVersion:'synthetic.exact-m3-policy-control.v1',units:'distinct_maps',inputScopes:['prior_completed_maps','current_identity'],minimumSupport:3,missingPolicy:'null_and_mask_for_unqualified_population',formulaParameters:{operator:'count_distinct_prior_map_ids',minimumSupportPolicy:'contextMinimumSupport',contextMinimumSupport:3}};
   value=data.eventCount;
  }
  if(closingMetric!==null){definition=missingClosingPolicyControl(closingMetric,minimumSupport);value=null;}
  mutate?.(definition);
  const expectedMinimumSupport=definition.minimumSupport;
  const [index,families,targetsDocument]=syntheticRegistry();
  compiler=createFeatureProjectionCompiler({registry:validateRegistry(index,families,targetsDocument),registryHash:digest(index),sourceInventory:{history:{primarySha256:'a'.repeat(64),files:[{path:'synthetic-policy-test-only.mjs',sha256:'a'.repeat(64)}]}},sourceProfiles:{history:'synthetic.provided-prior-facts'},resourceArena:arena});
  block=compiler.normalize({names:[definition.name],values:[value],masks:[value===null?1:0],definitions:[definition]},'history');route=compiler.project([block],'PRE_MAP_WIN','PRE');assert.equal(route.schemaRef.featureCount,1);
  const bundle={contract:'aegis.unified-diagnostic-feature-producer.v2',mode:'PRE',matchId:'90001',seriesId:null,decisionAt:AT,availableAt:AT,featureInputCutoffAt:CUTOFF,historyCutoffAt:CUTOFF,components:{},targetBinding,historicalBindings,historicalInputRef:reference,routes:[route],eligibleForTraining:false,eligibleForServing:false,recordedPrediction:false};
  journal=createCompactFeatureJournal({writer,resourceArena:arena,historicalInputStore:inputs});
  if(rejected){await assert.rejects(journal.appendBundle(bundle),error=>{assert.equal(error.message,'compact_feature_journal:historical_support_policy');assert.equal(error.diagnostics?.contract,'aegis.historical-support-policy-refusal.v1');assert.equal(error.diagnostics?.definition,definition.name);assert.equal(error.diagnostics?.contextMinimumSupport,minimumSupport);return true;});assert.equal(writer.commits.filter(r=>r.kind==='compact-feature-trace-v2').length,0);return;}
  const saved=await journal.appendBundle(bundle);assert.equal(saved.routes.length,1);assert.equal(saved.routes[0].featureCount,1);assert.equal(saved.routes[0].schemaRef.sha256,route.schemaRef.sha256);
  journal.clearCache();const loaded=await journal.loadTrace(saved.reference);
  try{
   assert.equal(loaded.assetVerification,'all_targets');assert.equal(loaded.body.historicalInputRef.sha256,reference.sha256);assert.equal(loaded.body.recordedPrediction,false);
   const schema=loaded.readSchemaPage({targetId:'PRE_MAP_WIN',offset:0,limit:1}),vector=loaded.readVectorPage({targetId:'PRE_MAP_WIN',offset:0,limit:1});
   try{assert.equal(schema.definitions.length,1);assert.equal(schema.definitions[0].minimumSupport,expectedMinimumSupport);assert.deepEqual(vector.values,[value]);assert.deepEqual(vector.missing,[value===null]);if(closingMetric!==null){assert.equal(schema.definitions[0].formulaParameters.referenceDefinition,CLOSING_REFERENCE);assert.equal(schema.definitions[0].formulaParameters.contextMinimumSupport,minimumSupport);}else if(!plainM3){assert.equal(schema.definitions[0].formulaParameters.contextMinimumSupport,minimumSupport);assert.equal(schema.definitions[0].formulaParameters.minimumSupportPolicy,'max(5,contextMinimumSupport)');}}
   finally{schema.release();vector.release();}
  }finally{loaded.release();}
 }finally{
  await journal?.close();route?.release();block?.release();compiler?.close();written?.release();inputs?.close();derived?.release();targets?.close();assert.equal(arena.status().chargedBytes,0);assert.equal(arena.status().leases,0);
 }
}

test('strict compact derived PRE accepts one actual C13 output with contextM3 and effective floor5, then rereads actual bytes',()=>runCase());
test('strict compact derived PRE retains old-style exact-M3 policy compatibility as a distinct count control',()=>runCase({plainM3:true}));
for(const [label,mutate] of [
 ['unreviewed template',d=>{d.formulaParameters.templateId='synthetic.unreviewed-floor.v1';}],
 ['wrong family',d=>{d.familyId='H02';}],
 ['wrong contextM',d=>{d.formulaParameters.contextMinimumSupport=4;}],
 ['effective threshold6',d=>{d.minimumSupport=6;}]
])test('strict compact derived PRE rejects '+label+' without publishing a trace',()=>runCase({mutate,rejected:true}));

test('strict compact derived PRE roundtrips missing S05 cohort-count policy with contextM5 and literal minimum0',()=>runCase({minimumSupport:5,closingMetric:'supportMaps'}));
test('strict compact derived PRE roundtrips missing S05 sample-SD policy with contextM3 and effective floor5',()=>runCase({closingMetric:'remainingDurationSampleSdSeconds'}));
test('strict compact derived PRE accepts the exact opposite-side deficit landmark policy without creating a value',()=>runCase({minimumSupport:5,closingMetric:'supportMaps',mutate:d=>{Object.assign(d.formulaParameters,{side:'dire',landmarkSeconds:1800,condition:'deficit_at_most_minus_1000',thresholdNativeNetWorth:-1000});}}));
for(const [label,mutate] of [
 ['unreviewed reference',d=>{d.formulaParameters.referenceDefinition='synthetic.unreviewed.v1';}],
 ['wrong formula version',d=>{d.formulaVersion='aegis.prior-map-relational-statistics.v2';}],
 ['wrong family',d=>{d.familyId='S04';}],
 ['wrong history window',d=>{d.historyWindowDays=30;}],
 ['unknown metric',d=>{d.formulaParameters.metric='unknownCount';}],
 ['wrong units',d=>{d.units='fraction';}],
 ['unreviewed landmark',d=>{d.formulaParameters.landmarkSeconds=900;}],
 ['inconsistent risk threshold',d=>{d.formulaParameters.thresholdNativeNetWorth=-1000;}],
 ['wrong context support',d=>{d.formulaParameters.contextMinimumSupport=3;}],
 ['arbitrary count minimum',d=>{d.minimumSupport=1;}]
])test('strict compact derived PRE rejects S05 '+label+' without publishing a trace',()=>runCase({minimumSupport:5,closingMetric:'supportMaps',mutate,rejected:true}));
test('strict compact derived PRE refuses a statistical S05 zero-support waiver',()=>runCase({closingMetric:'winFraction',mutate:d=>{d.minimumSupport=0;},rejected:true}));
