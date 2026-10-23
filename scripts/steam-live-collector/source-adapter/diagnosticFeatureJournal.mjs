/** Explicit private directory, append-only feature evidence, never predictions.
 * No scheduler, provider, DB migration, fitting or serving path is opened here. */
import {mkdir,writeFile,readFile,link,unlink,lstat} from 'node:fs/promises';
import {resolve,join,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {canonical,digest} from '../../feature-registry/registry-contract.mjs';
const SH=/^[a-f0-9]{64}$/,MAX=128*1024*1024;
const sha=x=>createHash('sha256').update(x).digest('hex');
const fail=x=>{throw Error('diagnostic_feature_journal:'+x);};
const flags={eligibleForTraining:false,eligibleForServing:false,recordedPrediction:false};
export function createDiagnosticFeatureJournal({directory,maxSchemaBytes=MAX,maxTraceBytes=16*1024*1024}={}){
 if(typeof directory!=='string'||!isAbsolute(directory)||!Number.isSafeInteger(maxSchemaBytes)||maxSchemaBytes<1024||maxSchemaBytes>MAX||!Number.isSafeInteger(maxTraceBytes)||maxTraceBytes<1024||maxTraceBytes>64*1024*1024)fail('directory_or_bound');
 const root=resolve(directory);
 async function folder(kind){const p=join(root,kind);await mkdir(p,{recursive:true});const stat=await lstat(p);if(!stat.isDirectory()||stat.isSymbolicLink())fail('unsafe_directory');return p;}
 async function read(kind,hash,bound){
  if(!SH.test(hash))fail('hash');const p=join(root,kind,hash+'.json'),s=await lstat(p);
  if(!s.isFile()||s.isSymbolicLink()||s.size>bound)fail('stored_file_or_bound');
  const b=await readFile(p);if(b.length>bound)fail('stored_byte_bound');return b.toString('utf8');
 }
 async function put(kind,hash,utf8,bound){
  if(!SH.test(hash)||typeof utf8!=='string'||Buffer.byteLength(utf8)>bound)fail('write_contract_or_bound');
  const dir=await folder(kind),target=join(dir,hash+'.json'),temporary=join(dir,'.'+randomUUID()+'.tmp');
  await writeFile(temporary,utf8,{flag:'wx'});
  try{try{await link(temporary,target);return 'created';}catch(e){if(e.code!=='EEXIST')throw e;if(await read(kind,hash,bound)!==utf8)fail('immutable_content_conflict');return 'existing_verified';}}
  finally{await unlink(temporary);}
 }
 async function loadSchema(schemaHash,definitionCache=new Map()){
  const body=JSON.parse(await read('schemas',schemaHash,1024*1024));
  if(body.contract!=='aegis.diagnostic-feature-schema-reference.v1'||body.schemaHash!==schemaHash||!SH.test(body.definitionsRef?.sha256??'')||!Number.isSafeInteger(body.definitionsRef.bytes)||body.definitionsRef.bytes>maxSchemaBytes||!Number.isSafeInteger(body.definitionsRef.count))fail('stored_schema_reference');
  const ref=body.definitionsRef;let definitions=definitionCache.get(ref.sha256);
  if(!definitions){const utf8=await read('definitions',ref.sha256,maxSchemaBytes);if(sha(utf8)!==ref.sha256||Buffer.byteLength(utf8)!==ref.bytes)fail('stored_definition_hash');definitions=JSON.parse(utf8);definitionCache.set(ref.sha256,definitions);}
  if(!Array.isArray(definitions)||definitions.length!==ref.count||definitions.length>150000)fail('stored_definition_count');
  const schema={...body.header,definitions};if(schema.contract!=='aegis.unified-feature-projection-schema.v1'||digest(schema)!==schemaHash)fail('stored_schema_hash');return schema;
 }
 async function validateTraceBody(body){
  if(body.contract!=='aegis.diagnostic-feature-trace.v1'||body.eligibleForServing!==false||body.eligibleForTraining!==false||body.recordedPrediction!==false||!Array.isArray(body.routes)||body.routes.length>12||!body.vectors||typeof body.vectors!=='object'||Array.isArray(body.vectors))fail('trace_contract');
  const used=new Set(),seenTargets=new Set(),definitionCache=new Map();
  for(const r of body.routes){
   if(seenTargets.has(r.targetId))fail('duplicate_target');seenTargets.add(r.targetId);
   const schema=await loadSchema(r.schemaRef?.sha256,definitionCache),v=body.vectors[r.vectorRef];
   if(schema.targetId!==r.targetId||schema.stateMode!==r.stateMode||!v||digest(v)!==r.vectorRef||digest(schema.definitions.map(d=>d.name))!==v.namesHash||!Array.isArray(v.values)||!Array.isArray(v.missing)||v.values.length!==schema.definitions.length||v.missing.length!==v.values.length||r.featureCount!==v.values.length||r.schemaRef.featureCount!==v.values.length||v.values.some((x,i)=>x!==null&&(typeof x!=='number'||!Number.isFinite(x))||typeof v.missing[i]!=='boolean'||v.missing[i]!== (x===null)))fail('trace_schema_vector_binding');
   used.add(r.vectorRef);
  }
  if(Object.keys(body.vectors).length!==used.size)fail('orphan_vector');
  return body;
 }
 return Object.freeze({
  async writeSchema({schemaHash,schema}={}){
   schema=structuredClone(schema);
   if(!SH.test(schemaHash??'')||schema?.contract!=='aegis.unified-feature-projection-schema.v1'||!Array.isArray(schema.definitions)||schema.definitions.length>150000||schema.definitions.some(d=>typeof d?.name!=='string'||!d.name.length)||new Set(schema.definitions.map(d=>d.name)).size!==schema.definitions.length||digest(schema)!==schemaHash)fail('schema_contract');
   const {definitions,...header}=schema,utf8=canonical(definitions),ref={sha256:sha(utf8),bytes:Buffer.byteLength(utf8),count:definitions.length};
   await put('definitions',ref.sha256,utf8,maxSchemaBytes);
   const status=await put('schemas',schemaHash,canonical({contract:'aegis.diagnostic-feature-schema-reference.v1',schemaHash,definitionsRef:ref,header}),1024*1024);
   return{status,schemaHash,definitionsRef:ref,...flags};
  },
  loadSchema,
  async appendTrace(trace){
   trace=structuredClone(trace);
   if(trace?.contract!=='aegis.diagnostic-feature-trace.v1'||typeof trace.utf8!=='string'||trace.bytes!==Buffer.byteLength(trace.utf8)||trace.bytes>maxTraceBytes||sha(trace.utf8)!==trace.sha256)fail('trace_pin');
   await validateTraceBody(JSON.parse(trace.utf8));
   const status=await put('traces',trace.sha256,trace.utf8,maxTraceBytes);return{status,sha256:trace.sha256,...flags};
  },
  async loadTrace(hash){const utf8=await read('traces',hash,maxTraceBytes);if(sha(utf8)!==hash)fail('stored_trace_hash');return validateTraceBody(JSON.parse(utf8));},
 });
}
