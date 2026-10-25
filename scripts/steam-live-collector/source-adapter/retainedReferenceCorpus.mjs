/** Reference-backed retained corpus. All original versions survive generation;
 * target cutoffs are separate views. Private handles prove full declared-input
 * replay on intake/restore, not worldwide availability or provider signatures.
 * This source-only adapter uses the trusted host's owned artifact-writer port.
 */
import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {instantNs} from './causalTime.mjs';
import {draftHash} from './observedDraft.mjs';
import {replayPinnedDraftPrefix} from './observedDraftHistory.mjs';
import {verifyHistoricalFactVersion,pinRetainedHistoryJson,RETAINED_FACT_MAX_BYTES} from './retainedOpenDotaFacts.mjs';
import {createRetainedHistorySourceExport} from './retainedHistorySourceExport.mjs';
import {createVerifiedHistorySourceHandle} from './historySourceVerifier.mjs';
import {snapshotPlainRecord} from './diagnosticResourceArena.mjs';
import {reduceRetainedMapVersions,projectReducedRetainedMap,retainedReducedFactsScope,retainedVersionSetBinding} from './boundedRetainedHistory.mjs';

export const RETAINED_REFERENCE_CORPUS_CONTRACT='aegis.retained-reference-corpus.v2';
export const RETAINED_REFERENCE_ENVELOPE_CONTRACT='aegis.retained-reference-history-envelope.v2';
export const RETAINED_REFERENCE_LIMITS=Object.freeze({maxVersions:20000,maxTotalVersionBytes:128*1024*1024,maxVersionBytes:RETAINED_FACT_MAX_BYTES,maxChunkBytes:1024*1024,maxPartEntries:128,maxParts:512,maxPartBytes:1024*1024,maxManifestBytes:256*1024,maxDenseBytes:64*1024*1024});
const PART='aegis.retained-reference-corpus-part.v2',BLOB='aegis.utf8-chunk-reference.v2',VIEW_KIND='retained-history-view-v2';
const handles=new WeakMap(),sha=x=>createHash('sha256').update(x).digest('hex'),byteLength=x=>Buffer.byteLength(x,'utf8');
const sourceHandlesV2=new WeakMap();
export const VERIFIED_RETAINED_REFERENCE_SOURCE_HANDLE_CONTRACT='aegis.verified-retained-reference-source-handle.v2';
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x),hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),id=x=>typeof x==='string'&&/^[1-9]\d{0,19}$/.test(x);
const fail=x=>{throw Error('retained_reference_corpus:'+x);};
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),sorted=xs=>[...new Set(xs)].sort((a,b)=>String(a).localeCompare(String(b),'en'));
const flags={eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false};
function boundedLimits(value={}){if(!obj(value)||Object.keys(value).some(k=>!Object.hasOwn(RETAINED_REFERENCE_LIMITS,k)))fail('limits');const out={...RETAINED_REFERENCE_LIMITS,...value};for(const[k,v]of Object.entries(out))if(!Number.isSafeInteger(v)||v<1||v>RETAINED_REFERENCE_LIMITS[k])fail('limit_'+k);return Object.freeze(out);}
function checkRef(r,maximum,kind=null){if(!obj(r)||Object.keys(r).sort().join(',')!=='bytes,kind,sha256'||!hash(r.sha256)||!Number.isSafeInteger(r.bytes)||r.bytes<0||r.bytes>maximum||typeof r.kind!=='string'||kind!==null&&r.kind!==kind)fail('artifact_reference');}
function port(store){if(!store||store.contract!=='aegis.persistent-artifact-writer.v1'||typeof store.commit!=='function'||typeof store.read!=='function'||typeof store.inspect!=='function')fail('owned_writer_port_required');return store;}
async function proceed(shouldContinue){if(typeof shouldContinue!=='function'||await shouldContinue()!==true)fail('stopped');}
function timestamp(clock){const at=clock();if(instantNs(at)===null||instantNs(at)<=0n)fail('clock');return at;}
function parse(text,label){try{return JSON.parse(text);}catch{fail(label+'_json');}}
function plainExact(value,keys,label){const out=snapshotPlainRecord(value,{maxKeys:keys.length});if(Object.getOwnPropertySymbols(value).length||Object.keys(out).sort().join(',')!==[...keys].sort().join(','))fail(label);return out;}
function snapshotTargetInputs(draftPrefixInputs,scope){
 if(!Array.isArray(draftPrefixInputs)||types.isProxy(draftPrefixInputs)||draftPrefixInputs.length<1||draftPrefixInputs.length>2048||Object.getOwnPropertySymbols(draftPrefixInputs).length||Object.keys(draftPrefixInputs).length!==draftPrefixInputs.length)fail('draft_prefix_bound');
 let total=0;const prefix=[];
 for(let i=0;i<draftPrefixInputs.length;i++){
  const descriptor=Object.getOwnPropertyDescriptor(draftPrefixInputs,String(i));if(!descriptor||!Object.hasOwn(descriptor,'value'))fail('draft_prefix_plain_entries');
  const entry=plainExact(descriptor.value,['rawInput','metadataInput'],'draft_prefix_entry'),copy={};
  for(const [name,maximum]of [['rawInput',6*1024*1024],['metadataInput',256*1024]]){
   const input=plainExact(entry[name],['utf8','pin'],'draft_prefix_input'),pin=plainExact(input.pin,['path','bytes','sha256'],'draft_prefix_pin');
   if(typeof input.utf8!=='string'||input.utf8.length>maximum||typeof pin.path!=='string'||pin.path.length<1||pin.path.length>4096||!hash(pin.sha256)||!Number.isSafeInteger(pin.bytes)||pin.bytes<1||pin.bytes>maximum)fail('draft_prefix_input_bound');
   const n=byteLength(input.utf8);if(n!==pin.bytes||n>maximum||(total+=n)>64*1024*1024)fail('draft_prefix_bytes_bound');
   copy[name]={utf8:input.utf8,pin:{...pin}};
  }
  prefix.push(copy);
 }
 let ownedScope=null;if(scope!==null){const value=plainExact(scope,['population'],'scope_contract');if(typeof value.population!=='string'||!/^[a-zA-Z0-9_.-]{1,96}$/.test(value.population))fail('scope_contract');ownedScope={population:value.population};}
 return freeze({draftPrefixInputs:prefix,scope:ownedScope});
}
async function readArtifact(store,ref,maximum,kind=null){checkRef(ref,maximum,kind);const text=await store.read(ref);if(typeof text!=='string'||byteLength(text)!==ref.bytes||sha(text)!==ref.sha256)fail('artifact_bytes');return text;}
async function commitArtifact(store,kind,utf8,maximum){if(byteLength(utf8)>maximum)fail('artifact_bound');const expected={kind,sha256:sha(utf8),bytes:byteLength(utf8)},actual=await store.commit({kind,utf8,expectedSha256:expected.sha256});if(!same(actual,expected))fail('writer_reference_mismatch');return freeze({...actual});}
async function writeBlob(store,utf8,limits,shouldContinue,kind='retained-version-chunk-v2',maximum=limits.maxVersionBytes){
 const n=byteLength(utf8);if(n>maximum)fail('blob_bound');const buffer=Buffer.from(utf8,'utf8'),refs=[];
 for(let offset=0;offset<buffer.length;){await proceed(shouldContinue);let end=Math.min(offset+limits.maxChunkBytes,buffer.length);while(end<buffer.length&&(buffer[end]&0xc0)===0x80)end--;if(end===offset)fail('chunk_smaller_than_codepoint');const text=buffer.subarray(offset,end).toString('utf8');refs.push(await commitArtifact(store,kind,text,limits.maxChunkBytes));offset=end;}
 return freeze({contract:BLOB,bytes:n,sha256:sha(utf8),chunks:refs});
}
async function readBlob(store,blob,limits,shouldContinue,{maximum=limits.maxVersionBytes,kind='retained-version-chunk-v2'}={}){
 if(!obj(blob)||blob.contract!==BLOB||!hash(blob.sha256)||!Number.isSafeInteger(blob.bytes)||blob.bytes<1||blob.bytes>maximum||!Array.isArray(blob.chunks)||blob.chunks.length>Math.ceil(maximum/Math.max(1,limits.maxChunkBytes-3)))fail('blob_reference');
 const chunks=[];let total=0;for(const ref of blob.chunks){await proceed(shouldContinue);const text=await readArtifact(store,ref,limits.maxChunkBytes,kind);total+=byteLength(text);if(total>blob.bytes)fail('blob_size');chunks.push(text);}
 const text=chunks.join('');if(total!==blob.bytes||sha(text)!==blob.sha256)fail('blob_integrity');return text;
}
function summary(checked){
 const v=checked.version,teams=[],accounts=[],heroes=[];
 for(const f of v.fields){if(f.status==='observed'){
  if(['/radiant_team_id','/dire_team_id'].includes(f.path))teams.push(String(f.value));
  if(f.path.endsWith('/account_id'))accounts.push(String(f.value));
  if(f.path.endsWith('/hero_id'))heroes.push(Number(f.value));
 }if(f.playerIdentity){if(f.playerIdentity.accountId)accounts.push(String(f.playerIdentity.accountId));if(f.playerIdentity.heroId)heroes.push(Number(f.playerIdentity.heroId));}}
 return {versionSha256:checked.versionSha256,versionBytes:checked.versionInput.pin.bytes,versionContract:v.contract,matchId:v.source.matchId,receivedAt:v.source.receivedAt,payloadPersistedAt:v.source.payloadPersistedAt,teamIds:sorted(teams),accountIds:sorted(accounts),heroIds:[...new Set(heroes)].sort((a,b)=>a-b),fieldCount:v.fields.length,clockBlockCount:v.fields.filter(f=>f.path.endsWith('/clock_series')).length,tombstoneOrInvalidCount:v.fields.filter(f=>f.status!=='observed').length};
}
const populationPolicy=()=>({sourceUniverse:'locally_retained_opendota_response_versions',selection:'all_declared_original_versions_without_global_latest_row_collapse',allDeclaredVersionsRetained:true,fieldAndClockBlockVersionsRetained:true,nullConflictRetractionAndIdentityEvidenceRetained:true,globalPopulationComplete:false,originalHistoricalAvailabilityProven:false,sourceAuthenticity:'local_collector_receipt_assertion_not_provider_signature'});

/** Stream intake one original version at a time. Partial failed generations may
 * leave owned committed chunks, but no generation handle or committed manifest.
 * They remain charged by the artifact writer; no hidden garbage collection. */
export async function createRetainedReferenceCorpus({artifactStore,versionInputs,clock=()=>new Date().toISOString(),shouldContinue=()=>true,limits={}}={}){
 const store=port(artifactStore),cfg=boundedLimits(limits);if(!versionInputs||typeof versionInputs[Symbol.iterator]!=='function'&&typeof versionInputs[Symbol.asyncIterator]!=='function'||typeof clock!=='function')fail('intake');
 await proceed(shouldContinue);const startedAt=timestamp(clock),parts=[],seen=new Set();let entries=[],providedVersions=0,versionCount=0,totalVersionBytes=0,fieldCount=0,clockBlockCount=0,tombstoneOrInvalidCount=0,latestSourceAt=0n;
 async function flush(){if(!entries.length)return;if(parts.length>=cfg.maxParts)fail('part_count');const body={contract:PART,index:parts.length,entries};parts.push(await commitArtifact(store,'retained-corpus-part-v2',JSON.stringify(body),cfg.maxPartBytes));entries=[];}
 for await(const input of versionInputs){await proceed(shouldContinue);if(++providedVersions>cfg.maxVersions)fail('provided_version_count');if(typeof input?.utf8!=='string'||byteLength(input.utf8)>cfg.maxVersionBytes)fail('version_bound');
  const checked=verifyHistoricalFactVersion(input),s=summary(checked);if(seen.has(s.versionSha256))continue;
  if(totalVersionBytes+s.versionBytes>cfg.maxTotalVersionBytes)fail('corpus_byte_limit');seen.add(s.versionSha256);totalVersionBytes+=s.versionBytes;versionCount++;fieldCount+=s.fieldCount;clockBlockCount+=s.clockBlockCount;tombstoneOrInvalidCount+=s.tombstoneOrInvalidCount;for(const at of [s.receivedAt,s.payloadPersistedAt].filter(x=>x!==null))if(instantNs(at)>latestSourceAt)latestSourceAt=instantNs(at);
  const blob=await writeBlob(store,checked.versionInput.utf8,cfg,shouldContinue),entry={summary:s,blob};
  if(entries.length&&(entries.length>=cfg.maxPartEntries||byteLength(JSON.stringify({contract:PART,index:parts.length,entries:[...entries,entry]}))>cfg.maxPartBytes))await flush();
  entries.push(entry);if(byteLength(JSON.stringify({contract:PART,index:parts.length,entries}))>cfg.maxPartBytes)fail('entry_bound');
 }
 await flush();await proceed(shouldContinue);const materializedAt=timestamp(clock);if(instantNs(materializedAt)<instantNs(startedAt))fail('clock_regressed');if(latestSourceAt>instantNs(materializedAt))fail('source_after_generation_or_bound');
 const manifest={contract:RETAINED_REFERENCE_CORPUS_CONTRACT,startedAt,materializedAt,providedVersions,versionCount,totalVersionBytes,fieldCount,clockBlockCount,tombstoneOrInvalidCount,parts,population:populationPolicy(),limits:cfg,...flags};
 const manifestReference=await commitArtifact(store,'retained-corpus-generation-v2',JSON.stringify(manifest),cfg.maxManifestBytes);
 // Mint by reading all committed original evidence, not by trusting the just
 // constructed JSON summary or a caller's claimed verification status.
 return restoreRetainedReferenceCorpus({artifactStore:store,manifestReference,clock,shouldContinue,limits:cfg});
}

async function* entriesOf(entry){for(let i=0;i<entry.manifest.parts.length;i++){
 await proceed(entry.shouldContinue);const text=await readArtifact(entry.store,entry.manifest.parts[i],entry.limits.maxPartBytes,'retained-corpus-part-v2'),part=parse(text,'part');
 if(!obj(part)||part.contract!==PART||part.index!==i||!Array.isArray(part.entries)||part.entries.length<1||part.entries.length>entry.limits.maxPartEntries)fail('part_contract');
 for(const item of part.entries)yield item;
}}
export async function restoreRetainedReferenceCorpus({artifactStore,manifestReference,clock=()=>new Date().toISOString(),shouldContinue=()=>true,limits={}}={}){
 const store=port(artifactStore),cfg=boundedLimits(limits);await proceed(shouldContinue);const text=await readArtifact(store,manifestReference,cfg.maxManifestBytes,'retained-corpus-generation-v2'),manifest=parse(text,'generation');
 if(!obj(manifest)||manifest.contract!==RETAINED_REFERENCE_CORPUS_CONTRACT||!same(manifest.population,populationPolicy())||!same(manifest.limits,cfg)||!same(Object.fromEntries(Object.keys(flags).map(k=>[k,manifest[k]])),flags)||instantNs(manifest.startedAt)===null||instantNs(manifest.materializedAt)===null||instantNs(manifest.startedAt)>instantNs(manifest.materializedAt)||!Array.isArray(manifest.parts)||manifest.parts.length>cfg.maxParts)fail('generation_contract');
 if(!Number.isSafeInteger(manifest.providedVersions)||manifest.providedVersions<0||manifest.providedVersions>cfg.maxVersions||!Number.isSafeInteger(manifest.versionCount)||manifest.versionCount<0||manifest.versionCount>manifest.providedVersions||!Number.isSafeInteger(manifest.totalVersionBytes)||manifest.totalVersionBytes<0||manifest.totalVersionBytes>cfg.maxTotalVersionBytes)fail('generation_counts');
 const entry={store,manifest:freeze(manifest),manifestReference:freeze({...manifestReference}),limits:cfg,shouldContinue,clock};const seen=new Set();let count=0,total=0,fields=0,clocks=0,tombstones=0;
 for await(const item of entriesOf(entry)){
  if(++count>cfg.maxVersions||!obj(item)||!obj(item.summary))fail('version_entry');const utf8=await readBlob(store,item.blob,cfg,shouldContinue);
  const checked=verifyHistoricalFactVersion({utf8,pin:{path:'reference-corpus/version.json',bytes:byteLength(utf8),sha256:sha(utf8)}}),s=summary(checked);
  if(!same(item.summary,s)||seen.has(s.versionSha256))fail('summary_or_duplicate');seen.add(s.versionSha256);total+=s.versionBytes;fields+=s.fieldCount;clocks+=s.clockBlockCount;tombstones+=s.tombstoneOrInvalidCount;
  if(total>cfg.maxTotalVersionBytes||s.payloadPersistedAt!==null&&instantNs(s.payloadPersistedAt)>instantNs(manifest.materializedAt)||instantNs(s.receivedAt)>instantNs(manifest.materializedAt))fail('source_after_generation_or_bound');
 }
 if(count!==manifest.versionCount||total!==manifest.totalVersionBytes||fields!==manifest.fieldCount||clocks!==manifest.clockBlockCount||tombstones!==manifest.tombstoneOrInvalidCount)fail('generation_totals');
 const verifiedAt=timestamp(clock);if(instantNs(verifiedAt)<instantNs(manifest.materializedAt))fail('generation_not_yet_available');
 const descriptor=freeze({contract:'aegis.verified-retained-reference-generation.v2',manifestReference:entry.manifestReference,versionCount:count,totalVersionBytes:total,fieldCount:fields,clockBlockCount:clocks,tombstoneOrInvalidCount:tombstones,materializedAt:manifest.materializedAt,verifiedAt,population:manifest.population,...flags});
 const handle=Object.freeze({contract:'aegis.owned-retained-reference-generation-handle.v2'});handles.set(handle,{...entry,descriptor});return Object.freeze({handle,descriptor,manifestReference:entry.manifestReference});
}
export function readRetainedReferenceCorpusHandle(handle){const entry=handles.get(handle);if(!entry)fail('owned_generation_required');return entry.descriptor;}
function owned(handle){const e=handles.get(handle);if(!e)fail('owned_generation_required');return e;}

async function selectTarget(entry,draftPrefixInputs,matchId,computedAt){
 const draft=replayPinnedDraftPrefix({draftPrefixInputs,matchId,computedAt});if(!draft.accepted)fail('draft_not_accepted:'+draft.reason);
 const state=draft.state,cutoff=instantNs(state.historyCutoffAt),players=state.identity.players;
 const selectors={teamIds:sorted(players.map(p=>p.teamId).filter(id)),accountIds:sorted(players.map(p=>p.accountId).filter(id)),heroIds:[...new Set(players.map(p=>Number(p.heroId)))].sort((a,b)=>a-b)};
 const teams=new Set(selectors.teamIds),accounts=new Set(selectors.accountIds),heroes=new Set(selectors.heroIds),mapIds=new Set(),entityMatchedMapIds=new Set();let currentMapVersions=0,futureVersions=0;
 for await(const item of entriesOf(entry)){const s=item.summary;if(s.matchId===matchId){currentMapVersions++;continue;}if(instantNs(s.receivedAt)>cutoff){futureVersions++;continue;}
  // No reviewed descriptor has proven a narrower global/meta population. The
  // safe default includes EVERY local noncurrent map with evidence by t0.
  // Entity union is recorded, but never used to prune unrelated meta evidence.
  mapIds.add(s.matchId);if(s.teamIds.some(x=>teams.has(x))||s.accountIds.some(x=>accounts.has(x))||s.heroIds.some(x=>heroes.has(x)))entityMatchedMapIds.add(s.matchId);
 }
 // Selecting any historical identity selects the ENTIRE map-version chain,
 // including corrections/nulls/conflicts and later epochs. No global latest-row
 // prefilter, and no team-only restriction on generic hero/meta populations.
 const selected=[];let selectedBytes=0;for await(const item of entriesOf(entry))if(mapIds.has(item.summary.matchId)){selectedBytes+=item.summary.versionBytes;selected.push(item);}
 return {state,selectors,selected,selectedBytes,selection:{policy:'all_local_meta_union_target_entities_at_cutoff_then_all_map_versions',metaPopulation:'all_local_retained_maps_with_any_version_by_original_cutoff',entityMatchedMapIds:sorted([...entityMatchedMapIds]),mapIds:sorted([...mapIds]),versionCount:selected.length,versionBytes:selectedBytes,currentMapVersionsExcluded:currentMapVersions,futureVersionsNotUsedForSelectorDiscovery:futureVersions,selectedVersionSetSha256:draftHash(selected.map(x=>x.summary.versionSha256).sort()),allDeclaredVersionsVerifiedAtGeneration:true,genericHeroPopulationRestrictedToTargetTeams:false}};
}
async function denseInputs(entry,selection){
 if(selection.selectedBytes>entry.limits.maxDenseBytes||selection.selected.length>20000)return null;const inputs=[];
 for(const item of selection.selected){const utf8=await readBlob(entry.store,item.blob,entry.limits,entry.shouldContinue);inputs.push({utf8,pin:{path:'reference-corpus/version.json',bytes:byteLength(utf8),sha256:item.summary.versionSha256}});}
 return inputs;
}
function envelopeBody(entry,selection,source,compatibilityBlob,{computedAt,exportedAt}){
 const body=JSON.parse(source.envelopeInput.utf8);
 return {contract:RETAINED_REFERENCE_ENVELOPE_CONTRACT,generationReference:entry.manifestReference,generationVerifiedAt:entry.descriptor.verifiedAt,identity:source.identity,identitySha256:draftHash(source.identity),historyCutoffAt:source.identity.historyCutoffAt,validFrom:source.identity.validFrom,computedAt,exportedAt,selection:selection.selection,population:{...source.population,referenceGenerationCompleteWithinDeclaredInputs:true,targetCohortUnionCompleteWithinGeneration:true,globalPopulationComplete:false},evidencePolicy:{generation:'all_original_versions_replayed_on_intake_or_restore',target:'immutable_selected_part_and_version_refs_reverified',currentMap:'excluded_from_target_features_but_verified_in_generation',futureVersions:'verified_in_generation_retained_in_selected_map_chains',availability:'local_retained_receipts_not_original_historical_proof',compatibility:'unchanged_v1_source_envelope_and_formulas_dense_view_only',fullArchiveReducerImplemented:false},factsSha256:body.factsInput.pin.sha256,nativeSha256:body.nativeInput.pin.sha256,draftPrefixBindingHash:draftHash(body.draftPrefixInputs.map(p=>({raw:p.rawInput.pin.sha256,metadata:p.metadataInput.pin.sha256}))),compatibilitySourceSnapshotHash:source.sourceSnapshotHash,compatibilityEnvelope:compatibilityBlob,...flags};
}

/** Dense compatibility remains an explicit bounded bridge. Larger selected
 * views return a pending gate; neither the v1 byte guard nor formulas change. */
export async function materializeRetainedReferenceHistory({corpusHandle,draftPrefixInputs,matchId,scope=null}={}){
 // Retain only bounded primitive strings and pin records before the first await.
 // Selection and source replay must see the same t0/t1 identity prefix even if
 // the caller changes its containers while committed parts are being read.
 const entry=owned(corpusHandle),target=snapshotTargetInputs(draftPrefixInputs,scope);await proceed(entry.shouldContinue);const computedAt=timestamp(entry.clock);if(instantNs(computedAt)<instantNs(entry.descriptor.verifiedAt))fail('clock_regressed');
 const selection=await selectTarget(entry,target.draftPrefixInputs,matchId,computedAt),versions=await denseInputs(entry,selection);
 const pending=reason=>freeze({contract:RETAINED_REFERENCE_ENVELOPE_CONTRACT,status:'bounded_reducer_pending',reason,generationReference:entry.manifestReference,historyCutoffAt:selection.state.historyCutoffAt,validFrom:selection.state.validFrom,selection:selection.selection,fullArchiveReducerImplemented:false,...flags});
 if(versions===null)return pending('target_version_bytes_exceed_unchanged_dense_guard');
 const exportedAt=timestamp(entry.clock);if(instantNs(exportedAt)<instantNs(computedAt))fail('clock_regressed');let source;
 try{source=createRetainedHistorySourceExport({draftPrefixInputs:target.draftPrefixInputs,matchId,computedAt,exportedAt,versionInputs:versions,scope:target.scope});}catch(error){if(error.message==='retained_history_source:envelope_bytes_or_bound')return pending('compatibility_envelope_exceeds_unchanged_dense_guard');throw error;}
 const compatibilityBlob=await writeBlob(entry.store,source.envelopeInput.utf8,entry.limits,entry.shouldContinue,'retained-dense-source-chunk-v1',entry.limits.maxDenseBytes),body=envelopeBody(entry,selection,source,compatibilityBlob,{computedAt,exportedAt});
 const envelopeReference=await commitArtifact(entry.store,VIEW_KIND,JSON.stringify(body),entry.limits.maxManifestBytes),availableAt=timestamp(entry.clock);
 if(instantNs(availableAt)<instantNs(exportedAt))fail('clock_regressed');
 const sourceExportHandle=createVerifiedHistorySourceHandle(source.envelopeInput,{expectedSourceSnapshotHash:source.sourceSnapshotHash,matchId,decisionAt:availableAt});
 return Object.freeze({contract:RETAINED_REFERENCE_ENVELOPE_CONTRACT,status:'dense_compatibility_ready',envelopeReference,availableAt,descriptor:freeze(body),compatibility:Object.freeze({sourceExportHandle,envelopeInput:source.envelopeInput,sourceSnapshotHash:source.sourceSnapshotHash}),...flags});
}

/** Explicit disk restoration never trusts a copied token or a v2 JSON claim.
 * The caller must first restore the entire generation. Rebuild the target using
 * all selected source versions and compare exact old-envelope bytes. */
export async function readRetainedReferenceHistory({corpusHandle,envelopeReference,decisionAt}={}){
 const entry=owned(corpusHandle),text=await readArtifact(entry.store,envelopeReference,entry.limits.maxManifestBytes,VIEW_KIND),body=parse(text,'view'),decision=instantNs(decisionAt);
 if(!obj(body)||body.contract!==RETAINED_REFERENCE_ENVELOPE_CONTRACT||!same(body.generationReference,entry.manifestReference)||decision===null||instantNs(body.exportedAt)===null||decision<instantNs(body.exportedAt)||decision<instantNs(entry.descriptor.verifiedAt))fail('view_generation_or_availability');
 const utf8=await readBlob(entry.store,body.compatibilityEnvelope,entry.limits,entry.shouldContinue,{maximum:entry.limits.maxDenseBytes,kind:'retained-dense-source-chunk-v1'}),old=parse(utf8,'compatibility');
 const selection=await selectTarget(entry,old.draftPrefixInputs,old.identity?.matchId,body.computedAt),versions=await denseInputs(entry,selection);if(versions===null)fail('view_requires_bounded_reducer');
 const source=createRetainedHistorySourceExport({draftPrefixInputs:old.draftPrefixInputs,matchId:old.identity?.matchId,computedAt:body.computedAt,exportedAt:body.exportedAt,versionInputs:versions,scope:old.scope});if(source.envelopeInput.utf8!==utf8)fail('compatibility_not_rederived');
 const expected=envelopeBody(entry,selection,source,body.compatibilityEnvelope,{computedAt:body.computedAt,exportedAt:body.exportedAt});
 // Verification may occur later than the original generation verification;
 // preserve that recorded timestamp only when it was an actually possible one.
 if(instantNs(body.generationVerifiedAt)===null||instantNs(body.generationVerifiedAt)<instantNs(entry.manifest.materializedAt)||instantNs(body.generationVerifiedAt)>instantNs(body.computedAt))fail('generation_verification_time');expected.generationVerifiedAt=body.generationVerifiedAt;
 if(!same(expected,body))fail('view_not_rederived');
 const sourceExportHandle=createVerifiedHistorySourceHandle(source.envelopeInput,{expectedSourceSnapshotHash:source.sourceSnapshotHash,matchId:source.identity.matchId,decisionAt});
 const availableAt=timestamp(entry.clock);if(instantNs(availableAt)<instantNs(entry.descriptor.verifiedAt)||instantNs(availableAt)<instantNs(body.exportedAt))fail('clock_regressed');
 return Object.freeze({contract:RETAINED_REFERENCE_ENVELOPE_CONTRACT,status:'dense_compatibility_ready',envelopeReference:freeze({...envelopeReference}),availableAt,descriptor:freeze(body),compatibility:Object.freeze({sourceExportHandle,envelopeInput:source.envelopeInput,sourceSnapshotHash:source.sourceSnapshotHash}),...flags});
}

// V2 never passes an oversized original-version array through the v1 exporter.
// It resolves each map chain exactly, then supplies the SAME v1 normalized facts
// algebra. The remaining 64 MiB normalized-facts limit is explicit and unchanged.
const V2_VIEW_KIND='retained-bounded-history-view-v2';
function referenceIdentity(state){
 const p=state.identity.players,selectors={sourceUniverse:'locally_retained_opendota_responses',selection:'provided_version_inputs_only',targetTeamIds:sorted(p.map(x=>x.teamId).filter(id)),targetAccountIds:sorted(p.map(x=>x.accountId).filter(x=>id(x)&&BigInt(x)<4294967295n)),targetHeroIds:[...new Set(p.map(x=>Number(x.heroId)))].sort((a,b)=>a-b)};
 const revisionBody={contract:state.contract,matchId:state.matchId,historyCutoffAt:state.historyCutoffAt,firstCompleteObservationId:state.firstCompleteObservationId,revision:state.revision,validFromObservationId:state.validFromObservationId,validFrom:state.validFrom,identity:state.identity};
 return {matchId:state.matchId,sourceProfile:state.sourceProfile,cutoffPolicy:state.cutoffPolicy,historyCutoffAt:state.historyCutoffAt,validFrom:state.validFrom,validFromObservationId:state.validFromObservationId,revision:state.revision,draftRevisionHash:draftHash(revisionBody),draftHash:state.identity.draftHash,rosterHash:state.identity.rosterHash,sideIdentityHash:state.identity.sideIdentityHash,selectors,selectorsSha256:draftHash(selectors)};
}
async function reduceReferenceTargetV2(entry,selection,target){
 const groups=new Map();for(const item of selection.selected){const key=item.summary.matchId;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);}
 const projected=[],dependencies=[],omitted=[],audit={providedVersions:0,uniqueVersions:0,currentMapExcluded:0,futureVersionsExcluded:0,conflictingFields:0};let normalizedBytes=0;
 // Lexical serialization follows v1. Numeric floating-point reduction order is
 // left to the existing shared algebra, whose byId comparator is unchanged.
 for(const matchId of [...groups.keys()].sort((a,b)=>a.localeCompare(b,'en'))){
  await proceed(entry.shouldContinue);
  async function* inputs(){for(const item of groups.get(matchId)){const utf8=await readBlob(entry.store,item.blob,entry.limits,entry.shouldContinue);yield {utf8,pin:{path:'reference-corpus/version.json',bytes:byteLength(utf8),sha256:item.summary.versionSha256}};}}
  const reduced=await reduceRetainedMapVersions({versionInputs:inputs(),matchId,targetMapId:selection.state.matchId,historyCutoffAt:selection.state.historyCutoffAt,shouldContinue:entry.shouldContinue});
  dependencies.push(...reduced.sourceVersions);for(const key of Object.keys(audit))audit[key]+=reduced.audit[key];
  const row=projectReducedRetainedMap(reduced,{sourceVersionSetSha256:'0'.repeat(64)});if(row.omitted)omitted.push(row.omitted);
  if(row.map){const n=byteLength(JSON.stringify(row.map));normalizedBytes+=n+1;if(normalizedBytes>entry.limits.maxDenseBytes)return {status:'normalized_facts_reducer_pending',reason:'normalized_facts_exceed_unchanged_64mib_shared_algebra_guard'};projected.push(row.map);}
 }
 const bindings=retainedVersionSetBinding(dependencies),maps=projected.map(map=>({...map,sourceVersionSetSha256:bindings.sourceVersionSetSha256,evidenceRef:'sha256:'+bindings.sourceVersionSetSha256+'#match/'+map.matchId}));
 const scope=retainedReducedFactsScope({historyCutoffAt:selection.state.historyCutoffAt,rowCount:maps.length,population:target.scope?.population});
 const factsInput=pinRetainedHistoryJson({contract:'aegis.prior-map-facts.v1',scope,maps},'retained-history/prior-map-facts.json');
 if(factsInput.pin.bytes>entry.limits.maxDenseBytes)return {status:'normalized_facts_reducer_pending',reason:'normalized_facts_exceed_unchanged_64mib_shared_algebra_guard'};
 const nativeInput=pinRetainedHistoryJson({contract:'aegis.pinned-native-economy-observations.v1',observations:[]},'retained-history/no-native-observations.json');
 const population={facts:maps.length?'complete_nonempty_within_provided_retained_corpus':'complete_empty_within_provided_retained_corpus',native:'not_provided',factsUsable:true,nativeCandidatesPinned:false,allCollectionsComplete:false,zeroHistoryStatisticsInvented:false,globalPopulationComplete:false};
 return {status:'bounded_reference_ready',factsInput,nativeInput,bindings,population,inputAudit:{...audit,exportedMaps:maps.length,omittedMaps:omitted,availabilityBasis:'retained_collector_response_receipt',originalHistoricalAvailabilityProven:false,independentFieldAvailabilityAttested:false,sourceSelectionCompleteOnlyWithinProvidedInputs:true}};
}
function sourceDescriptorV2(body,envelopeReference,availableAt){
 const descriptor={contract:'aegis.verified-history-source-descriptor.v2',sourceContract:body.contract,sourceSnapshotHash:envelopeReference.sha256,reference:{contract:'aegis.history-source-export-reference.v2',sha256:envelopeReference.sha256,bytes:envelopeReference.bytes},identity:body.identity,population:body.population,factsSha256:body.factsSha256,nativeSha256:body.nativeSha256,draftPrefixBindingHash:body.draftPrefixBindingHash,computedAt:body.computedAt,exportedAt:body.exportedAt,availableAt,generationReference:body.generationReference,envelopeReference:freeze({...envelopeReference}),sourceVersionSetSha256:body.sourceVersionSetSha256,...flags};
 let descriptorBytes=0,next=byteLength(JSON.stringify({...descriptor,descriptorBytes}));while(next!==descriptorBytes){descriptorBytes=next;next=byteLength(JSON.stringify({...descriptor,descriptorBytes}));}
 if(descriptorBytes>16*1024)fail('v2_descriptor_bound');return freeze({...descriptor,descriptorBytes});
}
function mintSourceV2(body,envelopeReference,availableAt){const token=Object.freeze({contract:VERIFIED_RETAINED_REFERENCE_SOURCE_HANDLE_CONTRACT});sourceHandlesV2.set(token,sourceDescriptorV2(body,envelopeReference,availableAt));return token;}
/** Opaque authority, available only after actual original-version replay. A
 * copied/serialized descriptor cannot mint this source handle. Root integrates
 * this reader with the producer and persisted historicalInputRef validator.
 */
export function readVerifiedRetainedReferenceSourceHandle(token,{expectedSourceSnapshotHash,matchId,decisionAt}={}){
 const descriptor=sourceHandlesV2.get(token);if(!descriptor)fail('owned_v2_source_handle_required');
 if(!hash(expectedSourceSnapshotHash)||expectedSourceSnapshotHash!==descriptor.sourceSnapshotHash||!id(matchId)||matchId!==descriptor.identity.matchId)fail('v2_source_identity_binding');
 const decision=instantNs(decisionAt);if(decision===null||decision<instantNs(descriptor.identity.validFrom)||decision<instantNs(descriptor.exportedAt)||decision<instantNs(descriptor.availableAt))fail('v2_source_not_available_at_decision');
 return descriptor;
}
function boundedBody(entry,selection,target,result,refs,{computedAt,exportedAt}){
 const identity=referenceIdentity(selection.state);
 return {contract:RETAINED_REFERENCE_ENVELOPE_CONTRACT,view:'bounded_exact_map_resolution.v2',generationReference:entry.manifestReference,generationVerifiedAt:entry.descriptor.verifiedAt,identity,identitySha256:draftHash(identity),historyCutoffAt:identity.historyCutoffAt,validFrom:identity.validFrom,computedAt,exportedAt,selection:selection.selection,population:{...result.population,referenceGenerationCompleteWithinDeclaredInputs:true,targetCohortUnionCompleteWithinGeneration:true,globalPopulationComplete:false},evidencePolicy:{generation:'all_original_versions_replayed_on_intake_or_restore',target:'all_selected_map_version_bytes_rederived_one_chain_at_a_time',currentMap:'excluded_from_target_features_but_verified_in_generation',futureVersions:'verified_in_generation_retained_in_selected_map_chains',availability:'local_retained_receipts_not_original_historical_proof',formulas:'unchanged_v1_normalized_facts_and_shared_feature_algebra',originalVersionDenseGuardBypassed:false,normalizedFactsGuardBytes:entry.limits.maxDenseBytes,fullArchiveFeatureReducerImplemented:false},factsSha256:result.factsInput.pin.sha256,nativeSha256:result.nativeInput.pin.sha256,sourceVersionSetSha256:result.bindings.sourceVersionSetSha256,draftPrefixBindingHash:draftHash(target.draftPrefixInputs.map(p=>({raw:p.rawInput.pin.sha256,metadata:p.metadataInput.pin.sha256}))),draftPrefix:refs.draftPrefix,facts:refs.facts,native:refs.native,sourceBindings:refs.sourceBindings,inputAudit:result.inputAudit,...flags};
}

/** Additive v2 bridge for >64 MiB ORIGINAL version corpora. It preserves every
 * retained version and uses exact normalized facts with the existing producer.
 * Full normalized archives larger than 64 MiB remain an explicit separate gate.
 */
export async function materializeRetainedReferenceHistoryV2({corpusHandle,draftPrefixInputs,matchId,scope=null}={}){
 const entry=owned(corpusHandle),target=snapshotTargetInputs(draftPrefixInputs,scope);await proceed(entry.shouldContinue);const computedAt=timestamp(entry.clock);if(instantNs(computedAt)<instantNs(entry.descriptor.verifiedAt))fail('clock_regressed');
 const selection=await selectTarget(entry,target.draftPrefixInputs,matchId,computedAt),result=await reduceReferenceTargetV2(entry,selection,target);
 if(result.status!=='bounded_reference_ready')return freeze({contract:RETAINED_REFERENCE_ENVELOPE_CONTRACT,...result,generationReference:entry.manifestReference,historyCutoffAt:selection.state.historyCutoffAt,validFrom:selection.state.validFrom,selection:selection.selection,fullArchiveReducerImplemented:false,...flags});
 const refs={};for(const [key,utf8,kind]of [['draftPrefix',JSON.stringify(target),'retained-target-prefix-chunk-v2'],['facts',result.factsInput.utf8,'retained-target-facts-chunk-v2'],['native',result.nativeInput.utf8,'retained-target-native-chunk-v2'],['sourceBindings',JSON.stringify(result.bindings),'retained-target-bindings-chunk-v2']])refs[key]=await writeBlob(entry.store,utf8,entry.limits,entry.shouldContinue,kind,entry.limits.maxDenseBytes);
 const exportedAt=timestamp(entry.clock);if(instantNs(exportedAt)<instantNs(computedAt))fail('clock_regressed');const body=boundedBody(entry,selection,target,result,refs,{computedAt,exportedAt}),envelopeReference=await commitArtifact(entry.store,V2_VIEW_KIND,JSON.stringify(body),entry.limits.maxManifestBytes),availableAt=timestamp(entry.clock);if(instantNs(availableAt)<instantNs(exportedAt))fail('clock_regressed');
 const sourceExportHandle=mintSourceV2(body,envelopeReference,availableAt);
 return Object.freeze({contract:RETAINED_REFERENCE_ENVELOPE_CONTRACT,status:'bounded_reference_ready',envelopeReference,availableAt,descriptor:freeze(body),sourceExportHandle,sourceSnapshotHash:envelopeReference.sha256,factsInput:freeze(result.factsInput),nativeInput:freeze(result.nativeInput),...flags});
}

/** Restart requires a restored whole-generation token, actual committed view
 * dependencies and exact rederivation. A rehashed metadata-only view is rejected.
 * It never commits new artifacts or trusts a previous in-memory source handle.
 */
export async function readRetainedReferenceHistoryV2({corpusHandle,envelopeReference,decisionAt}={}){
 const entry=owned(corpusHandle),text=await readArtifact(entry.store,envelopeReference,entry.limits.maxManifestBytes,V2_VIEW_KIND),body=parse(text,'v2_view'),decision=instantNs(decisionAt);
 if(!obj(body)||body.contract!==RETAINED_REFERENCE_ENVELOPE_CONTRACT||body.view!=='bounded_exact_map_resolution.v2'||!same(body.generationReference,entry.manifestReference)||decision===null||instantNs(body.exportedAt)===null||decision<instantNs(body.exportedAt)||decision<instantNs(entry.descriptor.verifiedAt)||instantNs(body.computedAt)===null||instantNs(body.computedAt)>instantNs(body.exportedAt)||instantNs(body.generationVerifiedAt)===null||instantNs(body.generationVerifiedAt)<instantNs(entry.manifest.materializedAt)||instantNs(body.generationVerifiedAt)>instantNs(body.computedAt))fail('v2_view_generation_or_availability');
 const targetText=await readBlob(entry.store,body.draftPrefix,entry.limits,entry.shouldContinue,{maximum:entry.limits.maxDenseBytes,kind:'retained-target-prefix-chunk-v2'}),rawTarget=parse(targetText,'v2_target'),target=snapshotTargetInputs(rawTarget.draftPrefixInputs,rawTarget.scope);
 if(JSON.stringify(target)!==targetText)fail('v2_target_not_canonical');
 const selection=await selectTarget(entry,target.draftPrefixInputs,body.identity?.matchId,body.computedAt),result=await reduceReferenceTargetV2(entry,selection,target);if(result.status!=='bounded_reference_ready')fail('v2_view_normalized_facts_bound');
 for(const [key,expected,kind]of [['facts',result.factsInput.utf8,'retained-target-facts-chunk-v2'],['native',result.nativeInput.utf8,'retained-target-native-chunk-v2'],['sourceBindings',JSON.stringify(result.bindings),'retained-target-bindings-chunk-v2']]){const actual=await readBlob(entry.store,body[key],entry.limits,entry.shouldContinue,{maximum:entry.limits.maxDenseBytes,kind});if(actual!==expected)fail('v2_'+key+'_not_rederived');}
 const expected=boundedBody(entry,selection,target,result,{draftPrefix:body.draftPrefix,facts:body.facts,native:body.native,sourceBindings:body.sourceBindings},{computedAt:body.computedAt,exportedAt:body.exportedAt});expected.generationVerifiedAt=body.generationVerifiedAt;if(!same(expected,body))fail('v2_view_not_rederived');
 const availableAt=timestamp(entry.clock);if(instantNs(availableAt)<instantNs(entry.descriptor.verifiedAt)||instantNs(availableAt)<instantNs(body.exportedAt))fail('clock_regressed');const sourceExportHandle=mintSourceV2(body,envelopeReference,availableAt);
 return Object.freeze({contract:RETAINED_REFERENCE_ENVELOPE_CONTRACT,status:'bounded_reference_ready',envelopeReference:freeze({...envelopeReference}),availableAt,descriptor:freeze(body),sourceExportHandle,sourceSnapshotHash:envelopeReference.sha256,factsInput:freeze(result.factsInput),nativeInput:freeze(result.nativeInput),...flags});
}
