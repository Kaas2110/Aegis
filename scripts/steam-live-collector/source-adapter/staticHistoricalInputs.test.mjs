import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';
import {createDiagnosticFeatureJournal} from './diagnosticFeatureJournal.mjs';import {pinned} from './observedDraftHistory.fixtures.mjs';
import {digest} from '../../feature-registry/registry-contract.mjs';
test('static contexts keep exact facts, target and series input bytes across restart; later corruption fails closed',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'aegis-static-inputs-'));try{
  const journal=createDiagnosticFeatureJournal({directory:dir}),factsInput=pinned({maps:[]}),targetInput=pinned({seriesId:'s',cutoff:'2026-10-24T10:00:00Z'}),seriesInput=pinned({seriesId:'s',previousMaps:[]});
  const saved=await journal.writeHistoricalInputs({mode:'SERIES_PRE',factsInput,targetInput,seriesInput,minimumSupport:3}),loaded=await createDiagnosticFeatureJournal({directory:dir}).loadHistoricalInputs(saved.reference);assert.equal(loaded.header.calculationOptions.minimumSupport,3);
  assert.equal(loaded.inputs.facts.utf8,factsInput.utf8);assert.equal(loaded.inputs.target.pin.sha256,targetInput.pin.sha256);
  const body={contract:'aegis.diagnostic-feature-trace.v1',mode:'SERIES_PRE',routes:[],vectors:{},historicalInputRef:saved.reference,historicalBindings:{factsSha256:factsInput.pin.sha256,targetSha256:targetInput.pin.sha256},seriesReceiptPin:seriesInput.pin,eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false},utf8=JSON.stringify(body),trace={contract:body.contract,utf8,bytes:Buffer.byteLength(utf8),sha256:createHash('sha256').update(utf8).digest('hex')};
  assert.equal((await journal.appendTrace(trace)).status,'created');assert.equal((await journal.loadTrace(trace.sha256)).historicalInputRef.sha256,saved.reference.sha256);
  const schema={contract:'aegis.unified-feature-projection-schema.v1',targetId:'SERIES_PRE',stateMode:'SERIES_PRE',definitions:[{name:'test.supported.history',minimumSupport:5}]},schemaHash=digest(schema);await journal.writeSchema({schemaHash,schema});
  const vector={namesHash:digest(['test.supported.history']),values:[.6],missing:[false]},vectorRef=digest(vector),mismatch={...body,routes:[{targetId:'SERIES_PRE',stateMode:'SERIES_PRE',schemaRef:{sha256:schemaHash,featureCount:1},featureCount:1,vectorRef}],vectors:{[vectorRef]:vector}},badUtf8=JSON.stringify(mismatch);
  await assert.rejects(journal.appendTrace({contract:body.contract,utf8:badUtf8,bytes:Buffer.byteLength(badUtf8),sha256:createHash('sha256').update(badUtf8).digest('hex')}),/trace_historical_support_policy/);
  const bad=structuredClone(factsInput);bad.utf8+=' ';await assert.rejects(journal.writeHistoricalInputs({mode:'PRE',factsInput:bad,targetInput}),/actual_historical/);
  await writeFile(join(dir,'source-inputs',factsInput.pin.sha256+'.json'),'{}');await assert.rejects(journal.loadTrace(trace.sha256),/historical_source_input_hash/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
