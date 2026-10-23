import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,readdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {createDiagnosticFeatureJournal} from './diagnosticFeatureJournal.mjs';import {digest} from '../../feature-registry/registry-contract.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
function schema(targetId='LIVE_MAP_WIN'){return{contract:'aegis.unified-feature-projection-schema.v1',targetId,stateMode:'LIVE',definitions:[{name:'synthetic.one'},{name:'synthetic.missing'}]};}
function trace(schemas){const v={namesHash:digest(schemas[0].definitions.map(d=>d.name)),values:[0,null],missing:[false,true]},vectorRef=digest(v),body={contract:'aegis.diagnostic-feature-trace.v1',routes:schemas.map(s=>({targetId:s.targetId,stateMode:s.stateMode,schemaRef:{sha256:digest(s),featureCount:2},featureCount:2,vectorRef})),vectors:{[vectorRef]:v},eligibleForTraining:false,eligibleForServing:false,recordedPrediction:false};return repin(body);}
function repin(b){const utf8=JSON.stringify(b);return{contract:b.contract,utf8,bytes:Buffer.byteLength(utf8),sha256:hash(utf8)};}
async function fixture(fn){const directory=await mkdtemp(join(tmpdir(),'aegis-feature-journal-'));try{await fn(createDiagnosticFeatureJournal({directory}),directory);}finally{await rm(directory,{recursive:true,force:true});}}
test('schema and trace are durable, content-addressed and idempotent across restart',()=>fixture(async(s,directory)=>{
 const a=schema(),b=schema('LIVE_KILLS'),t=trace([a,b]);await Promise.all([s.writeSchema({schemaHash:digest(a),schema:a}),s.writeSchema({schemaHash:digest(b),schema:b})]);
 assert.equal((await readdir(join(directory,'definitions'))).length,1);assert.equal((await s.appendTrace(t)).status,'created');
 const restarted=createDiagnosticFeatureJournal({directory});assert.equal((await restarted.appendTrace(t)).status,'existing_verified');assert.deepEqual(await restarted.loadSchema(digest(a)),a);assert.equal((await restarted.loadTrace(t.sha256)).recordedPrediction,false);assert.equal((await restarted.writeSchema({schemaHash:digest(a),schema:a})).status,'existing_verified');
}));
test('trace cannot be committed before its exact schema or with changed values/masks',()=>fixture(async(s)=>{
 const a=schema(),t=trace([a]);await assert.rejects(s.appendTrace(t),/ENOENT/);await s.writeSchema({schemaHash:digest(a),schema:a});
 const b=JSON.parse(t.utf8),v=Object.values(b.vectors)[0];v.values[0]=42;await assert.rejects(s.appendTrace(repin(b)),/schema_vector_binding/);
 const c=JSON.parse(t.utf8),old=Object.keys(c.vectors)[0];c.vectors[old].missing[1]=false;const next=digest(c.vectors[old]);c.vectors[next]=c.vectors[old];delete c.vectors[old];c.routes[0].vectorRef=next;await assert.rejects(s.appendTrace(repin(c)),/schema_vector_binding/);
}));
test('stored corruption is detected and never overwritten',()=>fixture(async(s,directory)=>{
 const a=schema(),r=await s.writeSchema({schemaHash:digest(a),schema:a});const path=join(directory,'definitions',r.definitionsRef.sha256+'.json');await writeFile(path,'[]');
 await assert.rejects(s.loadSchema(digest(a)),/stored_definition_hash/);await assert.rejects(s.writeSchema({schemaHash:digest(a),schema:a}),/immutable_content_conflict/);assert.equal(await readFile(path,'utf8'),'[]');
}));
test('simultaneous exact writes converge; bounds and forecast masquerading fail',()=>fixture(async(s,directory)=>{
 const a=schema();const rs=await Promise.all(Array.from({length:20},()=>s.writeSchema({schemaHash:digest(a),schema:a})));assert.equal(rs.filter(r=>r.status==='created').length,1);
 const t=trace([a]),b=JSON.parse(t.utf8);b.recordedPrediction=true;await assert.rejects(s.appendTrace(repin(b)),/trace_contract/);
 await assert.rejects(s.writeSchema({schemaHash:'../escape',schema:a}),/schema_contract/);assert.throws(()=>createDiagnosticFeatureJournal({directory,maxTraceBytes:1}),/directory_or_bound/);
 assert.ok((await readdir(join(directory,'schemas'))).every(n=>!n.endsWith('.tmp')));
}));
test('duplicate names and damaged schema links cannot be read as valid feature traces',()=>fixture(async(s,directory)=>{
 const a=schema(),bad=structuredClone(a);bad.definitions[1].name=bad.definitions[0].name;
 await assert.rejects(s.writeSchema({schemaHash:digest(bad),schema:bad}),/schema_contract/);
 await s.writeSchema({schemaHash:digest(a),schema:a});const t=trace([a]);await s.appendTrace(t);
 await writeFile(join(directory,'schemas',digest(a)+'.json'),'{}');await assert.rejects(s.loadTrace(t.sha256),/stored_schema_reference/);
}));
test('caller mutation across asynchronous writes cannot change pinned schema or trace',()=>fixture(async(s)=>{
 const a={...schema(),semanticInputs:{patch:'synthetic-original'}},key=digest(a),started=s.writeSchema({schemaHash:key,schema:a});a.semanticInputs.patch='mutated-later';await started;assert.equal((await s.loadSchema(key)).semanticInputs.patch,'synthetic-original');
 const t=trace([{...a,semanticInputs:{patch:'synthetic-original'}}]),expected=t.sha256,writing=s.appendTrace(t);t.utf8='{}';t.sha256=hash('{}');t.bytes=2;assert.equal((await writing).sha256,expected);assert.equal((await s.loadTrace(expected)).contract,'aegis.diagnostic-feature-trace.v1');
}));
