/** Bounded reference index and two-pass local materializer. Version summaries
 * establish declared inclusion scope, not provider authenticity. Every referenced
 * version is replay-verified before any output and again when its map is emitted.
 * No DB/provider/clock access; callers own storage and transactional sink commit. */
import {createHash} from 'node:crypto';
import {instantNs} from './causalTime.mjs';
import {pinRetainedHistoryJson as pin,verifyHistoricalFactVersion,exportHistoricalFactsFromVersions,RETAINED_FACT_MAX_BYTES} from './retainedOpenDotaFacts.mjs';

export const HISTORY_CORPUS_INDEX_CONTRACT='aegis.retained-history-corpus-index.v1';
export const HISTORY_CORPUS_PAGE_CONTRACT='aegis.retained-history-corpus-page.v1';
const FACT_REF='aegis.retained-history-fact-reference.v1',PAGE_REF='aegis.retained-history-corpus-page-reference.v1';
const MAX_VERSIONS=100000,MAX_INDEX_BYTES=16*1024*1024,MAX_PAGE_BYTES=1024*1024,MAX_MANIFEST_BYTES=2*1024*1024,MAX_MAP_BYTES=64*1024*1024;
const flags={eligibleForTraining:false,eligibleForServing:false,recordedPrediction:false};
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x),hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),id=x=>typeof x==='string'&&/^[1-9]\d{0,19}$/.test(x);
const exact=(x,keys)=>obj(x)&&Object.keys(x).sort().join(',')===[...keys].sort().join(',');
const sha=x=>createHash('sha256').update(x).digest('hex');
const fail=reason=>{throw Error('retained_history_index:'+reason);};
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const order=(a,b)=>a.matchId.localeCompare(b.matchId,'en')||(instantNs(a.receivedAt)<instantNs(b.receivedAt)?-1:instantNs(a.receivedAt)>instantNs(b.receivedAt)?1:0)||a.reference.sha256.localeCompare(b.reference.sha256,'en');
const integer=(x,min,max)=>Number.isSafeInteger(x)&&x>=min&&x<=max;
function checkContinue(shouldContinue,signal){let active=false;try{active=shouldContinue()===true;}catch{}if(!active||signal?.aborted)fail('manual_stop');}
function options(o={}){
 const r={maxVersions:o.maxVersions??MAX_VERSIONS,maxIndexBytes:o.maxIndexBytes??MAX_INDEX_BYTES,maxPageBytes:o.maxPageBytes??256*1024,maxPageVersions:o.maxPageVersions??256};
 if(!integer(r.maxVersions,1,MAX_VERSIONS)||!integer(r.maxIndexBytes,1024,MAX_INDEX_BYTES)||!integer(r.maxPageBytes,1024,MAX_PAGE_BYTES)||!integer(r.maxPageVersions,1,2000))fail('limits');return r;
}
function population(x){if(typeof x!=='string'||!/^[a-zA-Z0-9_.-]{1,96}$/.test(x))fail('population');return x;}
function read(input,max){
 if(typeof input?.utf8!=='string'||!hash(input.pin?.sha256)||!integer(input.pin.bytes,1,max)||Buffer.byteLength(input.utf8)!==input.pin.bytes||sha(input.utf8)!==input.pin.sha256)fail('pinned_bytes');
 let x;try{x=JSON.parse(input.utf8);}catch{fail('pinned_json');}if(pin(x).utf8!==input.utf8)fail('noncanonical_bytes');return x;
}
function summary(checked){return{matchId:checked.version.source.matchId,receivedAt:checked.version.source.receivedAt,reference:{contract:FACT_REF,sha256:checked.versionSha256,bytes:checked.versionInput.pin.bytes}};}
function validateRow(x){
 if(!exact(x,['matchId','receivedAt','reference'])||!id(x.matchId)||instantNs(x.receivedAt)===null||instantNs(x.receivedAt)<=0n||!exact(x.reference,['contract','sha256','bytes'])||x.reference.contract!==FACT_REF||!hash(x.reference.sha256)||!integer(x.reference.bytes,1,RETAINED_FACT_MAX_BYTES))fail('row');
}
/** Input may be an async iterable. Only summaries, never all raw versions, are
 * retained. Bounds are enforced during iteration, before canonical page assembly. */
export async function createRetainedHistoryCorpusIndex({versionInputs,population:scope='provided_retained_responses_only',limits={},shouldContinue=()=>true,signal=null}={}){
 const l=options(limits);population(scope);if(!versionInputs||typeof shouldContinue!=='function'||!(Symbol.iterator in Object(versionInputs)||Symbol.asyncIterator in Object(versionInputs)))fail('builder_contract');
 const rows=new Map();let count=0,summaryBytes=0;
 for await(const input of versionInputs){checkContinue(shouldContinue,signal);if(++count>l.maxVersions*2)fail('input_count_bound');const checked=verifyHistoricalFactVersion(input),row=summary(checked);if(rows.has(row.reference.sha256))continue;
  const bytes=Buffer.byteLength(JSON.stringify(row));if(rows.size>=l.maxVersions||(summaryBytes+=bytes)>l.maxIndexBytes)fail('index_bound');rows.set(row.reference.sha256,row);
 }
 const ordered=[...rows.values()].sort(order),pageInputs=[],pageRefs=[];let chunk=[];
 const emit=()=>{if(!chunk.length)return;const page=pin({contract:HISTORY_CORPUS_PAGE_CONTRACT,rows:chunk},'retained-history/corpus-page.json');if(page.pin.bytes>l.maxPageBytes)fail('page_bytes_bound');pageInputs.push(page);pageRefs.push({contract:PAGE_REF,sha256:page.pin.sha256,bytes:page.pin.bytes,rows:chunk.length});chunk=[];};
 for(const row of ordered){checkContinue(shouldContinue,signal);const next=[...chunk,row];if(chunk.length&&(chunk.length>=l.maxPageVersions||pin({contract:HISTORY_CORPUS_PAGE_CONTRACT,rows:next}).pin.bytes>l.maxPageBytes))emit();chunk.push(row);}emit();
 const manifestInput=pin({contract:HISTORY_CORPUS_INDEX_CONTRACT,sourceUniverse:'locally_retained_opendota_responses',selection:'all_listed_version_references',population:scope,globalPopulationComplete:false,completeWithinDeclaredManifest:true,producerVersion:'retained-index.reference-pages.v1',versionCount:ordered.length,versionBytes:ordered.reduce((n,x)=>n+x.reference.bytes,0),pages:pageRefs,...flags},'retained-history/corpus-index.json');
 checkContinue(shouldContinue,signal);const verified=verifyRetainedHistoryCorpusIndex({manifestInput,pageInputs,limits:l});return freeze({manifestInput,pageInputs,manifestSha256:manifestInput.pin.sha256,summarySourceVerifiedAtBuild:true,audit:{inputVersions:count,uniqueVersions:ordered.length,indexBytes:verified.indexBytes},...flags});
}

/** This validates reference metadata integrity only. The streaming materializer
 * separately resolves and rederives every version, including excluded versions. */
export function verifyRetainedHistoryCorpusIndex({manifestInput,pageInputs,limits={}}={}){
 const l=options(limits),m=read(manifestInput,MAX_MANIFEST_BYTES);
 if(!exact(m,['contract','sourceUniverse','selection','population','globalPopulationComplete','completeWithinDeclaredManifest','producerVersion','versionCount','versionBytes','pages',...Object.keys(flags)])||m.contract!==HISTORY_CORPUS_INDEX_CONTRACT||m.sourceUniverse!=='locally_retained_opendota_responses'||m.selection!=='all_listed_version_references'||m.globalPopulationComplete!==false||m.completeWithinDeclaredManifest!==true||m.producerVersion!=='retained-index.reference-pages.v1'||Object.keys(flags).some(k=>m[k]!==false)||!integer(m.versionCount,0,l.maxVersions)||!Number.isSafeInteger(m.versionBytes)||m.versionBytes<0||!Array.isArray(m.pages)||!Array.isArray(pageInputs)||m.pages.length!==pageInputs.length||m.pages.length>l.maxVersions)fail('manifest');population(m.population);
 const rows=[],seen=new Set();let bytes=manifestInput.pin.bytes,versionBytes=0;
 for(let i=0;i<m.pages.length;i++){
  const r=m.pages[i],input=pageInputs[i];if(!exact(r,['contract','sha256','bytes','rows'])||r.contract!==PAGE_REF||!hash(r.sha256)||!integer(r.bytes,1,l.maxPageBytes)||!integer(r.rows,1,l.maxPageVersions)||r.sha256!==input?.pin?.sha256||r.bytes!==input?.pin?.bytes)fail('page_reference');
  const p=read(input,l.maxPageBytes);if(!exact(p,['contract','rows'])||p.contract!==HISTORY_CORPUS_PAGE_CONTRACT||!Array.isArray(p.rows)||p.rows.length!==r.rows)fail('page_contract');
  if((bytes+=input.pin.bytes)>l.maxIndexBytes)fail('index_bound');
  for(const row of p.rows){validateRow(row);if(seen.has(row.reference.sha256)||rows.length&&order(rows.at(-1),row)>=0)fail('duplicate_or_noncanonical_order');if(rows.length>=l.maxVersions)fail('version_count_bound');seen.add(row.reference.sha256);rows.push(row);versionBytes+=row.reference.bytes;}
 }
 if(rows.length!==m.versionCount||versionBytes!==m.versionBytes)fail('manifest_counts');
 return freeze({manifest:m,rows,manifestSha256:manifestInput.pin.sha256,indexBytes:bytes,summarySourceVerified:false,...flags});
}

/** Resolves one map's complete version history at a time. The existing v1 selector
 * owns field-as-of/null/identity/conflict semantics. Output bytes may exceed the
 * v1 envelope ceiling, but the central producer is NOT automatically opted in.
 * onMap is a provisional sink: commit only after this function returns successfully. */
export async function streamRetainedHistoryFactsFromIndex({manifestInput,pageInputs,loadVersion,targetMapId,historyCutoffAt,onMap,limits={},maxMapBytes=MAX_MAP_BYTES,maxOutputBytes=128*1024*1024,shouldContinue=()=>true,signal=null}={}){
 const cutoff=instantNs(historyCutoffAt);if(!id(targetMapId)||cutoff===null||typeof loadVersion!=='function'||typeof onMap!=='function'||typeof shouldContinue!=='function'||!integer(maxMapBytes,1,MAX_MAP_BYTES)||!integer(maxOutputBytes,1,256*1024*1024))fail('materializer_contract');
 const index=verifyRetainedHistoryCorpusIndex({manifestInput,pageInputs,limits}),groups=[];let group=[];
 for(const row of index.rows){if(group.length&&group[0].matchId!==row.matchId){groups.push(group);group=[];}group.push(row);}if(group.length)groups.push(group);
 const selectedSources=new Map(),eligibleGroups=[],audit={declaredVersions:index.rows.length,mapsVisited:groups.length,exportedMaps:0,verifiedLoads:0,maxRetainedMapVersionBytes:0,maxRetainedMapVersions:0};
 async function loadGroup(rows){
  const inputs=[];let bytes=0;
  for(const row of rows){checkContinue(shouldContinue,signal);if(inputs.length>=20000||(bytes+=row.reference.bytes)>maxMapBytes)fail('map_version_bound');const input=await loadVersion(structuredClone(row.reference));checkContinue(shouldContinue,signal);const v=verifyHistoricalFactVersion(input);audit.verifiedLoads++;
   if(v.versionSha256!==row.reference.sha256||v.versionInput.pin.bytes!==row.reference.bytes||pin(summary(v)).utf8!==pin(row).utf8)fail('resolved_version_summary_mismatch');inputs.push(v.versionInput);
  }
  audit.maxRetainedMapVersionBytes=Math.max(audit.maxRetainedMapVersionBytes,bytes);audit.maxRetainedMapVersions=Math.max(audit.maxRetainedMapVersions,inputs.length);return inputs;
 }
 // Verify all declared references before emitting. A forged "future" summary
 // cannot hide an actually eligible old version from the declared population.
 for(const rows of groups){
  const versionInputs=await loadGroup(rows),e=exportHistoricalFactsFromVersions({versionInputs,targetMapId,historyCutoffAt,scope:{population:index.manifest.population}});
  for(const v of e.bindings.sourceVersions)selectedSources.set(v.versionSha256,v);
  const maps=JSON.parse(e.factsInput.utf8).maps;if(maps.length){eligibleGroups.push(rows);audit.exportedMaps+=maps.length;}
 }
 const sourceVersions=[...selectedSources.values()].sort((a,b)=>a.versionSha256.localeCompare(b.versionSha256,'en')),sourceVersionSetSha256=pin(sourceVersions).pin.sha256;
 const scope={contract:'aegis.retained-history-selection-scope.v1',sourceUniverse:'locally_retained_opendota_responses',population:index.manifest.population,selection:'provided_version_inputs_only',asOf:historyCutoffAt,completeWithinProvidedInputs:true,globalPopulationComplete:false,truncated:false,rowCount:audit.exportedMaps};
 const h=createHash('sha256');let outputBytes=0,emitted=0;
 const digestPart=text=>{const n=Buffer.byteLength(text);if((outputBytes+=n)>maxOutputBytes)fail('output_bytes_bound');h.update(text);};
 digestPart('{"contract":"aegis.prior-map-facts.v1","maps":[');
 for(const rows of eligibleGroups){
  const versionInputs=await loadGroup(rows),e=exportHistoricalFactsFromVersions({versionInputs,targetMapId,historyCutoffAt,scope:{population:index.manifest.population}}),maps=JSON.parse(e.factsInput.utf8).maps;
  if(maps.length!==1)fail('second_pass_map_changed');
  const map={...maps[0],sourceVersionSetSha256,evidenceRef:'sha256:'+sourceVersionSetSha256+'#match/'+maps[0].matchId},utf8=pin(map).utf8;
  digestPart((emitted?',':'')+utf8);checkContinue(shouldContinue,signal);await onMap(freeze(map),{index:emitted,manifestSha256:index.manifestSha256,provisional:true});checkContinue(shouldContinue,signal);emitted++;
 }
 digestPart('],"scope":'+pin(scope).utf8+'}');if(emitted!==audit.exportedMaps)fail('emitted_count');
 return freeze({contract:'aegis.streamed-retained-history-facts.v1',manifestSha256:index.manifestSha256,targetMapId,historyCutoffAt,scope,sourceVersionSetSha256,bindings:{sourceVersions,sourceVersionSetSha256},factsSha256:h.digest('hex'),factsBytes:outputBytes,audit:{...audit,indexBytes:index.indexBytes,rawVersionRetention:'one_map_at_a_time',denseFactsRetained:false},...flags});
}
