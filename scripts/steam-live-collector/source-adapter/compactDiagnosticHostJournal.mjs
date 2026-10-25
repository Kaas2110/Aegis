/** Optional owned compact host port. No listener, provider or automatic lease
 * acquisition. The supplied writer remains owned by its explicit host. */
import {createCompactFeatureJournal,COMPACT_FEATURE_JOURNAL_CONTRACT} from './compactFeatureJournal.mjs';
import {snapshotPlainRecord} from './diagnosticResourceArena.mjs';
const KIND='compact-feature-trace-v2',SHA=/^[a-f0-9]{64}$/;
const fail=x=>{throw Error('compact_diagnostic_host:'+x);};
export function createCompactDiagnosticHostJournal({writer,resourceArena,historicalInputStore=null,legacyJournal=null,onTraceIntent=async()=>{},shouldContinue=()=>true,signal=null,journalOptions={}}={}){
 if(writer?.contract!=='aegis.persistent-artifact-writer.v1'||typeof writer.commit!=='function'||typeof writer.listCommitted!=='function'||typeof writer.read!=='function'||typeof resourceArena?.reserve!=='function'||typeof onTraceIntent!=='function'||typeof shouldContinue!=='function')fail('owned_ports');
 const continuing=()=>signal?.aborted!==true&&shouldContinue()===true;
 const sink={...writer,async commit(input){
  if(input.kind===KIND){const body=JSON.parse(input.utf8);if(!continuing())fail('manual_stop_before_trace_intent');await onTraceIntent({matchId:body.matchId,traceSha256:input.expectedSha256});if(!continuing())fail('manual_stop_before_trace_commit');}
  return writer.commit(input);
 },...(typeof writer.commitMany==='function'?{async commitMany(inputs){
  if(!Array.isArray(inputs)||inputs.length<1||inputs.length>64)fail('batch_bound');
  const owned=inputs.map(value=>snapshotPlainRecord(value,{maxKeys:3}));
  if(owned.some(value=>value.kind===KIND))fail('trace_requires_intent_single_commit');
  return writer.commitMany(owned);
 }}:{})};
 const journal=createCompactFeatureJournal({...journalOptions,writer:sink,resourceArena,historicalInputStore,shouldContinue:continuing,resolveTraceReference:find});
 async function find(hash){
  if(!SHA.test(hash??''))fail('trace_hash');const lease=resourceArena.reserve(8*1024*1024);if(!lease)fail('discovery_memory_reservation');
  try{const exact=typeof writer.findCommitted==='function'?await writer.findCommitted({kind:KIND,sha256:hash}):undefined;const rows=exact===undefined?await writer.listCommitted({kind:KIND}):exact===null?[]:[exact];if(!Array.isArray(rows)||rows.length>10000)fail('trace_discovery_bound');const found=[];
   for(const raw of rows){const row=snapshotPlainRecord(raw,{maxKeys:4}),ref=snapshotPlainRecord(row.reference,{maxKeys:3});if(ref.kind!==KIND||!SHA.test(ref.sha256??'')||!Number.isSafeInteger(ref.bytes)||ref.bytes<1||ref.bytes>1024*1024)fail('trace_discovery_reference');if(ref.sha256===hash)found.push(Object.freeze(ref));}
   if(found.length===0)fail('trace_not_found');if(found.length!==1)fail('ambiguous_trace_reference');return found[0];
  }finally{lease.release();}
 }
 return Object.freeze({contract:COMPACT_FEATURE_JOURNAL_CONTRACT,appendBundle:journal.appendBundle,
  writeHistoricalInputs:historicalInputStore===null?undefined:input=>historicalInputStore.writeHistoricalInputs(input),
  async loadTrace(hash,selection={},controls={}){try{return await journal.loadTrace(hash,selection,controls);}catch(error){if(error.message==='compact_diagnostic_host:trace_not_found'&&legacyJournal!==null)return legacyJournal.loadTrace(hash);throw error;}},
  loadSchema:legacyJournal===null?undefined:hash=>legacyJournal.loadSchema(hash),
  async hasCommittedTrace(hash){let held;try{held=await journal.loadTrace(hash);}catch(error){if(error.message==='compact_diagnostic_host:trace_not_found')return legacyJournal===null?false:legacyJournal.hasCommittedTrace(hash);throw error;}try{return true;}finally{held.release();}},
  cacheStats:journal.cacheStats,close:journal.close,clearCache:journal.clearCache});
}
