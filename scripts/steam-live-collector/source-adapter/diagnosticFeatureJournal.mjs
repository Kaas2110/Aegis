/** Explicit private directory, append-only feature evidence, never predictions.
 * No scheduler, provider, DB migration, fitting or serving path is opened here. */
import {mkdir,writeFile,readFile,link,unlink,lstat} from 'node:fs/promises';
import {resolve,join,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {canonical,digest} from '../../feature-registry/registry-contract.mjs';
import {createDiagnosticResourceArena,measureBoundedJsonBytes,snapshotPlainRecord} from './diagnosticResourceArena.mjs';
const SH=/^[a-f0-9]{64}$/,MAX=256*1024*1024,CACHE_MAX=512*1024*1024;
const sha=x=>createHash('sha256').update(x).digest('hex');
const fail=x=>{throw Error('diagnostic_feature_journal:'+x);};
const flags={eligibleForTraining:false,eligibleForServing:false,recordedPrediction:false};
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
export function createDiagnosticFeatureJournal({directory,maxSchemaBytes=MAX,maxTraceBytes=16*1024*1024,maxCachedSchemas=32,maxCachedDefinitions=8,maxCachedDefinitionBytes=MAX,resourceArena=null}={}){
 if(typeof directory!=='string'||!isAbsolute(directory)||!Number.isSafeInteger(maxSchemaBytes)||maxSchemaBytes<1024||maxSchemaBytes>MAX||!Number.isSafeInteger(maxTraceBytes)||maxTraceBytes<1024||maxTraceBytes>64*1024*1024)fail('directory_or_bound');
 if(!Number.isSafeInteger(maxCachedSchemas)||maxCachedSchemas<1||maxCachedSchemas>128||!Number.isSafeInteger(maxCachedDefinitions)||maxCachedDefinitions<1||maxCachedDefinitions>64||!Number.isSafeInteger(maxCachedDefinitionBytes)||maxCachedDefinitionBytes<1024||maxCachedDefinitionBytes>CACHE_MAX)fail('cache_bound');
 const root=resolve(directory),schemas=new Map(),definitions=new Map(),metadata=new WeakMap(),schemaFlights=new Map(),definitionFlights=new Map();let cachedDefinitionBytes=0;
 const arena=resourceArena??createDiagnosticResourceArena();if(typeof arena?.reserve!=='function'||typeof arena?.status!=='function')fail('owned_resource_arena');
 const counters={schemaCacheHits:0,definitionCacheHits:0,definitionParses:0,definitionHashChecks:0,schemaDigests:0,namesDigests:0,schemaSnapshots:0,traceSnapshots:0};
 const touch=(map,key,value)=>{map.delete(key);map.set(key,value);};
 function forgetDefinition(key){const entry=definitions.get(key);if(entry){cachedDefinitionBytes-=entry.bytes;definitions.delete(key);}for(const [k,v]of schemas)if(v.definitionsHash===key)schemas.delete(k);}
 async function fingerprint(kind,key,bound){
  if(!SH.test(key??''))fail('hash');const p=join(root,kind,key+'.json'),s=await lstat(p,{bigint:true});if(!s.isFile()||s.isSymbolicLink()||s.size<1n||s.size>BigInt(bound))fail('stored_file_or_bound');
  return[s.size,s.mtimeNs,s.ctimeNs,s.dev,s.ino].join(':');
 }
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
 async function loadSchemaUnchecked(schemaHash){
  const schemaFingerprint=await fingerprint('schemas',schemaHash,1024*1024),cached=schemas.get(schemaHash);
  if(cached&&cached.schemaFingerprint===schemaFingerprint){
   const current=await fingerprint('definitions',cached.definitionsHash,maxSchemaBytes);
   if(current===cached.definitionFingerprint&&definitions.has(cached.definitionsHash)){counters.schemaCacheHits++;touch(schemas,schemaHash,cached);touch(definitions,cached.definitionsHash,definitions.get(cached.definitionsHash));return cached.schema;}
   forgetDefinition(cached.definitionsHash);
  }else if(cached)schemas.delete(schemaHash);
  const body=JSON.parse(await read('schemas',schemaHash,1024*1024));
  if(body.contract!=='aegis.diagnostic-feature-schema-reference.v1'||body.schemaHash!==schemaHash||!SH.test(body.definitionsRef?.sha256??'')||!Number.isSafeInteger(body.definitionsRef.bytes)||body.definitionsRef.bytes>maxSchemaBytes||!Number.isSafeInteger(body.definitionsRef.count))fail('stored_schema_reference');
  const ref=body.definitionsRef,definitionFingerprint=await fingerprint('definitions',ref.sha256,maxSchemaBytes);let entry=definitions.get(ref.sha256);
  if(entry&&entry.fingerprint!==definitionFingerprint){forgetDefinition(ref.sha256);entry=null;}
  if(entry){counters.definitionCacheHits++;touch(definitions,ref.sha256,entry);}
  else{
   const flightKey=ref.sha256+':'+definitionFingerprint;let flight=definitionFlights.get(flightKey);
   if(!flight){flight=(async()=>{
    const utf8=await read('definitions',ref.sha256,maxSchemaBytes);counters.definitionHashChecks++;
    if(sha(utf8)!==ref.sha256||Buffer.byteLength(utf8)!==ref.bytes)fail('stored_definition_hash');
    const values=JSON.parse(utf8);counters.definitionParses++;
    if(!Array.isArray(values)||values.length!==ref.count||values.length>150000)fail('stored_definition_count');
    const namesHash=digest(values.map(d=>d.name));counters.namesDigests++;
    return{values:freeze(values),bytes:ref.bytes,fingerprint:definitionFingerprint,namesHash};
   })();definitionFlights.set(flightKey,flight);}
   try{entry=await flight;}finally{if(definitionFlights.get(flightKey)===flight)definitionFlights.delete(flightKey);}
  }
  if(entry.values.length!==ref.count||entry.bytes!==ref.bytes)fail('stored_definition_count');
  const schema={...body.header,definitions:entry.values};counters.schemaDigests++;
  if(schema.contract!=='aegis.unified-feature-projection-schema.v1'||digest(schema)!==schemaHash)fail('stored_schema_hash');
  if(await fingerprint('schemas',schemaHash,1024*1024)!==schemaFingerprint||await fingerprint('definitions',ref.sha256,maxSchemaBytes)!==definitionFingerprint)fail('stored_schema_changed_during_read');
  freeze(schema);metadata.set(schema,{namesHash:entry.namesHash});
  if(ref.bytes<=maxCachedDefinitionBytes){
   if(!definitions.has(ref.sha256)){
    while(definitions.size>=maxCachedDefinitions||cachedDefinitionBytes+ref.bytes>maxCachedDefinitionBytes)forgetDefinition(definitions.keys().next().value);
    definitions.set(ref.sha256,entry);cachedDefinitionBytes+=ref.bytes;
   }
   touch(schemas,schemaHash,{schema,schemaFingerprint,definitionFingerprint,definitionsHash:ref.sha256});while(schemas.size>maxCachedSchemas)schemas.delete(schemas.keys().next().value);
  }
  return schema;
 }
 async function loadSchema(schemaHash){
  if(!SH.test(schemaHash??''))fail('hash');let flight=schemaFlights.get(schemaHash);
  if(!flight){flight=loadSchemaUnchecked(schemaHash);schemaFlights.set(schemaHash,flight);}
  try{return await flight;}finally{if(schemaFlights.get(schemaHash)===flight)schemaFlights.delete(schemaHash);}
 }
 async function loadHistoricalInputs(reference){
  if(reference?.contract!=='aegis.static-historical-input-reference.v1'||!SH.test(reference.sha256??'')||!Number.isSafeInteger(reference.bytes)||reference.bytes<1||reference.bytes>16384)fail('historical_input_reference');
  const utf8=await read('historical-input-sets',reference.sha256,16384),header=JSON.parse(utf8);
  if(Buffer.byteLength(utf8)!==reference.bytes||sha(utf8)!==reference.sha256||header.contract!=='aegis.static-historical-feature-inputs.v1'||!['PRE','SERIES_PRE','BETWEEN'].includes(header.mode)||!Number.isSafeInteger(header.calculationOptions?.minimumSupport)||header.calculationOptions.minimumSupport<3||header.calculationOptions.minimumSupport>1000||!header.inputs||Object.keys(header.inputs).some(k=>!['facts','target','series'].includes(k))||!header.inputs.facts||!header.inputs.target)fail('historical_input_header');
  const inputs={};for(const[k,ref]of Object.entries(header.inputs)){
   if(!SH.test(ref.sha256??'')||!Number.isSafeInteger(ref.bytes)||ref.bytes<1||ref.bytes>64*1024*1024)fail('historical_source_input_bound');
   const body=await read('source-inputs',ref.sha256,64*1024*1024);if(Buffer.byteLength(body)!==ref.bytes||sha(body)!==ref.sha256)fail('historical_source_input_hash');JSON.parse(body);
   inputs[k]={utf8:body,pin:{path:'feature-journal/source-inputs/'+ref.sha256+'.json',...ref}};
  }
  return{header,inputs,reference};
 }
 async function validateTraceBody(body){
  if(body.contract!=='aegis.diagnostic-feature-trace.v1'||body.eligibleForServing!==false||body.eligibleForTraining!==false||body.recordedPrediction!==false||!Array.isArray(body.routes)||body.routes.length>12||!body.vectors||typeof body.vectors!=='object'||Array.isArray(body.vectors))fail('trace_contract');
  let historical=null;if(body.historicalInputRef!==null&&body.historicalInputRef!==undefined){historical=await loadHistoricalInputs(body.historicalInputRef);const h=historical;if(h.header.mode!==body.mode||h.header.inputs.facts.sha256!==body.historicalBindings?.factsSha256||h.header.inputs.target.sha256!==body.historicalBindings?.targetSha256||h.header.inputs.series?.sha256!==(body.seriesReceiptPin?.sha256??undefined))fail('trace_historical_input_binding');}
  const used=new Set(),seenTargets=new Set(),checkedVectors=new Map();
  for(const r of body.routes){
   if(seenTargets.has(r.targetId))fail('duplicate_target');seenTargets.add(r.targetId);
   const schema=await loadSchema(r.schemaRef?.sha256),v=body.vectors[r.vectorRef];
   if(historical&&schema.definitions.some(d=>d.minimumSupport!==undefined&&d.minimumSupport!==historical.header.calculationOptions.minimumSupport))fail('trace_historical_support_policy');
   if(!checkedVectors.has(r.vectorRef)){
    if(!v||digest(v)!==r.vectorRef||!Array.isArray(v.values)||!Array.isArray(v.missing)||v.missing.length!==v.values.length||v.values.some((x,i)=>x!==null&&(typeof x!=='number'||!Number.isFinite(x))||typeof v.missing[i]!=='boolean'||v.missing[i]!== (x===null)))fail('trace_schema_vector_binding');checkedVectors.set(r.vectorRef,v);
   }
   if(schema.targetId!==r.targetId||schema.stateMode!==r.stateMode||metadata.get(schema).namesHash!==v.namesHash||v.values.length!==schema.definitions.length||r.featureCount!==v.values.length||r.schemaRef.featureCount!==v.values.length)fail('trace_schema_vector_binding');
   used.add(r.vectorRef);
  }
  if(Object.keys(body.vectors).length!==used.size)fail('orphan_vector');
  return body;
 }
 return Object.freeze({
  async writeHistoricalInputs({mode,factsInput,targetInput,seriesInput=null,minimumSupport=5}={}){
   if(!['PRE','SERIES_PRE','BETWEEN'].includes(mode)||!Number.isSafeInteger(minimumSupport)||minimumSupport<3||minimumSupport>1000)fail('historical_input_mode_or_support');
   const inputs={};for(const[k,p]of Object.entries({facts:factsInput,target:targetInput,...(seriesInput?{series:seriesInput}:{})})){
    if(typeof p?.utf8!=='string'||p.pin?.bytes!==Buffer.byteLength(p.utf8)||p.pin.bytes<1||p.pin.bytes>64*1024*1024||sha(p.utf8)!==p.pin.sha256)fail('actual_historical_input_bytes');JSON.parse(p.utf8);
    await put('source-inputs',p.pin.sha256,p.utf8,64*1024*1024);inputs[k]={sha256:p.pin.sha256,bytes:p.pin.bytes};
   }
   const header={contract:'aegis.static-historical-feature-inputs.v1',mode,inputs,calculationOptions:{minimumSupport}},utf8=canonical(header),reference={contract:'aegis.static-historical-input-reference.v1',sha256:sha(utf8),bytes:Buffer.byteLength(utf8)},status=await put('historical-input-sets',reference.sha256,utf8,16384);
   return{status,reference,...flags};
  },
  loadHistoricalInputs,
  async writeSchema({schemaHash,schema}={}){
   schema=snapshotPlainRecord(schema);
   if(typeof schemaHash!=='string'||!SH.test(schemaHash)||schema.contract!=='aegis.unified-feature-projection-schema.v1'||!Array.isArray(schema.definitions))fail('schema_contract');
   const bytes=measureBoundedJsonBytes(schema,{maxBytes:maxSchemaBytes+1024*1024,maxNodes:16000000});if(schema.definitions.length>150000)fail('schema_contract');
   const reservation=arena.reserve(bytes*6+65536);
   if(!reservation)fail('schema_memory_reservation');
   try{
   counters.schemaSnapshots++;schema=structuredClone(schema);
   if(!SH.test(schemaHash??'')||schema?.contract!=='aegis.unified-feature-projection-schema.v1'||!Array.isArray(schema.definitions)||schema.definitions.length>150000||schema.definitions.some(d=>typeof d?.name!=='string'||!d.name.length)||new Set(schema.definitions.map(d=>d.name)).size!==schema.definitions.length||digest(schema)!==schemaHash)fail('schema_contract');
   const {definitions,...header}=schema,utf8=canonical(definitions),ref={sha256:sha(utf8),bytes:Buffer.byteLength(utf8),count:definitions.length};
   await put('definitions',ref.sha256,utf8,maxSchemaBytes);
   const status=await put('schemas',schemaHash,canonical({contract:'aegis.diagnostic-feature-schema-reference.v1',schemaHash,definitionsRef:ref,header}),1024*1024);
   return{status,schemaHash,definitionsRef:ref,...flags};
   }finally{reservation.release();}
  },
  loadSchema,
  cacheStats(){return{...counters,cachedSchemas:schemas.size,cachedDefinitions:definitions.size,cachedDefinitionBytes,maxCachedSchemas,maxCachedDefinitions,maxCachedDefinitionBytes,resourceArena:arena.status()};},
  clearCache(){schemas.clear();definitions.clear();cachedDefinitionBytes=0;},
  async appendTrace(trace){
   trace=snapshotPlainRecord(trace);
   if(trace?.contract!=='aegis.diagnostic-feature-trace.v1'||typeof trace.utf8!=='string'||Buffer.byteLength(trace.utf8)>maxTraceBytes)fail('trace_pin');
   const reservation=arena.reserve(Buffer.byteLength(trace.utf8)*6+65536);if(!reservation)fail('trace_memory_reservation');
   try{
   counters.traceSnapshots++;trace=structuredClone(trace);
   if(trace?.contract!=='aegis.diagnostic-feature-trace.v1'||typeof trace.utf8!=='string'||trace.bytes!==Buffer.byteLength(trace.utf8)||trace.bytes>maxTraceBytes||sha(trace.utf8)!==trace.sha256)fail('trace_pin');
   await validateTraceBody(JSON.parse(trace.utf8));
   const status=await put('traces',trace.sha256,trace.utf8,maxTraceBytes);return{status,sha256:trace.sha256,...flags};
   }finally{reservation.release();}
  },
  async loadTrace(hash){const utf8=await read('traces',hash,maxTraceBytes);if(sha(utf8)!==hash)fail('stored_trace_hash');return validateTraceBody(JSON.parse(utf8));},
 });
}
