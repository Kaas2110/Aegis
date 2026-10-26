/** Persist bounded column-support pages. This exporter verifies bytes, not
 * source authority, model quality, original issuance or training admission. */
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {performance} from 'node:perf_hooks';
import {createDiagnosticResourceArena,measureBoundedJsonBytes,snapshotPlainRecord} from '../steam-live-collector/source-adapter/diagnosticResourceArena.mjs';
import {hashFeatureAsset} from '../steam-live-collector/source-adapter/featureProjectionOwnership.mjs';
import {FEATURE_PREPARATION_MODES} from './pinned-dataset-manifest.mjs';
const MiB=1024**2,HASH=/^[a-f0-9]{64}$/,fail=x=>{throw Error('coverage_export:'+x);},sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const FEATURE_COVERAGE_EXPORT_LIMITS=Object.freeze({maxFeatures:300000,maxPages:1500,maxColumnsPerPage:200,maxExpandedPageBytes:4*MiB,maxObjectBytes:16*MiB,maxIndexBytes:4*MiB,workingBytes:128*MiB,maxWallMs:1200000});
const FLAGS=Object.freeze({trainingAdmitted:false,qualityEvaluationPerformed:false,sourceAvailabilityAttested:false,originalObservationReceiptVerified:false,sourceAuthorityMinted:false,durableStorageAttested:false});
function pin(value,kind){const r=snapshotPlainRecord(value,{maxKeys:3});if(Object.keys(r).sort().join(',')!=='bytes,kind,sha256'||r.kind!==kind||!HASH.test(r.sha256??'')||!Number.isSafeInteger(r.bytes)||r.bytes<1||r.bytes>FEATURE_COVERAGE_EXPORT_LIMITS.maxObjectBytes)fail('pin');return Object.freeze(r);}
export async function exportFeatureDataCoveragePages({audit,rowBinding,provenance='synthetic',featureProvenance='replayed_derived',writePinned,readPinned,resourceArena=null,shouldContinue=()=>true,maxWallMs=1200000}={}){
 if(!audit||typeof audit.readPage!=='function'||typeof writePinned!=='function'||typeof readPinned!=='function'||typeof shouldContinue!=='function'||!Number.isInteger(maxWallMs)||maxWallMs<1||maxWallMs>FEATURE_COVERAGE_EXPORT_LIMITS.maxWallMs||!['synthetic','retrospective_reconstruction'].includes(provenance)||featureProvenance!=='replayed_derived')fail('configuration');
 const arena=resourceArena??createDiagnosticResourceArena(),work=arena.reserve(FEATURE_COVERAGE_EXPORT_LIMITS.workingBytes);if(!work)fail('memory_admission');
 const start=performance.now(),proceed=()=>{if(shouldContinue()!==true)fail('stopped');if(performance.now()-start>maxWallMs)fail('wall_bound');};
 async function save(reference,bytes,fileLabel){proceed();const actual=pin(await writePinned({reference,bytes,fileLabel}),reference.kind);proceed();if(actual.sha256!==reference.sha256||actual.bytes!==reference.bytes)fail('write_pin');const loaded=await readPinned(actual);proceed();if(!Buffer.isBuffer(loaded)||loaded.length!==reference.bytes||sha(loaded)!==reference.sha256)fail('readback_bytes');return loaded;}
 try{
  proceed();const summary=typeof audit.summary==='function'?audit.summary():audit.summary;
  measureBoundedJsonBytes(summary,{maxBytes:256*1024,maxNodes:16000,maxDepth:8});measureBoundedJsonBytes(rowBinding,{maxBytes:16384,maxNodes:512,maxDepth:4});
  const s=snapshotPlainRecord(summary,{maxKeys:32}),binding=snapshotPlainRecord(rowBinding,{maxKeys:32}),count=s.featureCount;
  if(s.contract!=='aegis.feature-data-coverage.v1'||!FEATURE_PREPARATION_MODES.some(m=>m.targetId===s.targetId&&m.stateMode===s.stateMode)||typeof s.profileId!=='string'||s.profileId.length<1||s.profileId.length>1024||!Number.isInteger(count)||count<1||count>300000||!HASH.test(s.functionContractSha256??'')||!HASH.test(s.columnDefinitionSha256??'')||s.trainingAdmitted!==false||s.qualityEvaluationPerformed!==false||s.sourceAvailabilityAttested!==false)fail('summary_contract');
  if(binding.contract!=='aegis.projected-row-binding.v1'||binding.targetId!==s.targetId||binding.stateMode!==s.stateMode||binding.featureFunctionSha256!==s.functionContractSha256||['schemaSha256','featureFunctionSha256','producerCompatibilitySha256','rowParameterBindingsSha256','contextSha256','projectionSha256','valuesAndMasksSha256'].some(k=>!HASH.test(binding[k]??''))||binding.sourceAvailabilityAttested!==false||binding.eligibleForTraining!==false||binding.eligibleForServing!==false)fail('row_binding');
  const rowBindingSha256=hashFeatureAsset(binding),auditDescriptor=audit.descriptor??null;
  if(auditDescriptor===null&&(s.actualPrivateRowVerified===true||s.profileId==='private_projected_replay_v1'))fail('actual_audit_descriptor_required');
  if(auditDescriptor!==null){measureBoundedJsonBytes(auditDescriptor,{maxBytes:16384,maxNodes:512,maxDepth:4});if(hashFeatureAsset(auditDescriptor)!==rowBindingSha256)fail('audit_row_binding_mismatch');}
  const auditDescriptorBinding=auditDescriptor===null?'not_provided_unverified_generic_audit':'matched_supplied_audit_descriptor',fileLabel=[s.targetId,s.stateMode,binding.contextSha256.slice(0,16)].join('--'),pages=[],ordered=createHash('sha256');let offset=0,expandedBytes=0,compressedBytes=0;
  while(offset<count){
   proceed();if(pages.length>=1500)fail('page_count');const page=audit.readPage({offset,limit:200});
   measureBoundedJsonBytes(page,{maxBytes:FEATURE_COVERAGE_EXPORT_LIMITS.maxExpandedPageBytes,maxNodes:200000,maxDepth:12});
   if(page.contract!=='aegis.feature-data-coverage-page.v1'||page.functionContractSha256!==s.functionContractSha256||page.columnDefinitionSha256!==s.columnDefinitionSha256||page.offset!==offset||page.total!==count||!Array.isArray(page.columns)||page.columns.length!==Math.min(200,count-offset)||page.nextOffset!==(offset+page.columns.length<count?offset+page.columns.length:null)||page.trainingAdmitted!==false||page.qualityEvaluationPerformed!==false||page.sourceAvailabilityAttested!==false)fail('page_contract');
   for(let i=0;i<page.columns.length;i++)if(page.columns[i].index!==offset+i||typeof page.columns[i].id!=='string'||!page.columns[i].id.length)fail('column_sequence');
   const auditUtf8=JSON.stringify(page);ordered.update(auditUtf8);
   const body={contract:'aegis.exported-feature-data-coverage-page.v1',targetId:s.targetId,stateMode:s.stateMode,profileId:s.profileId,rowBindingSha256,auditDescriptorBinding,provenance,featureProvenance,page,...FLAGS},utf8=JSON.stringify(body),expanded=Buffer.byteLength(utf8);if(expanded>FEATURE_COVERAGE_EXPORT_LIMITS.maxExpandedPageBytes)fail('expanded_page_bound');
   proceed();const compressed=gzipSync(utf8,{level:6}),reference=pin({kind:'feature-data-coverage-page-gzip-v1',sha256:sha(compressed),bytes:compressed.length},'feature-data-coverage-page-gzip-v1'),loaded=await save(reference,compressed,fileLabel);
   const decoded=gunzipSync(loaded,{maxOutputLength:FEATURE_COVERAGE_EXPORT_LIMITS.maxExpandedPageBytes});if(decoded.length!==expanded||sha(decoded)!==sha(Buffer.from(utf8)))fail('decompression_binding');proceed();
   pages.push(Object.freeze({reference,offset,columns:page.columns.length,expandedBytes:expanded,expandedSha256:sha(decoded)}));expandedBytes+=expanded;compressedBytes+=reference.bytes;offset+=page.columns.length;
  }
  const fullColumnPagesSha256=ordered.digest('hex');if(s.fullColumnPagesSha256!==undefined&&s.fullColumnPagesSha256!==fullColumnPagesSha256)fail('audit_page_digest');
  const body={contract:'aegis.feature-data-coverage-export-index.v1',targetId:s.targetId,stateMode:s.stateMode,profileId:s.profileId,featureCount:count,pageCount:pages.length,rowBinding:binding,rowBindingSha256,auditDescriptorBinding,provenance,featureProvenance,summary:s,pages,fullColumnPagesSha256,expandedPageBytes:expandedBytes,compressedPageBytes:compressedBytes,evidenceMeaning:'Every ordered intended column is present. These are support counts for the supplied audited rows, not proof of source completeness, original live availability or model quality.',...FLAGS};
  measureBoundedJsonBytes(body,{maxBytes:FEATURE_COVERAGE_EXPORT_LIMITS.maxIndexBytes,maxNodes:40000,maxDepth:12});const bytes=Buffer.from(JSON.stringify(body)),reference=pin({kind:'feature-data-coverage-index-v1',sha256:sha(bytes),bytes:bytes.length},'feature-data-coverage-index-v1');await save(reference,bytes,fileLabel);
  return Object.freeze({contract:'aegis.feature-data-coverage-export.v1',targetId:s.targetId,stateMode:s.stateMode,contextSha256:binding.contextSha256,schemaSha256:binding.schemaSha256,featureFunctionSha256:binding.featureFunctionSha256,rowBindingSha256,auditDescriptorBinding,featureCount:count,pageCount:pages.length,indexReference:reference,indexLabel:fileLabel,fullColumnPagesSha256,expandedPageBytes:expandedBytes,compressedPageBytes:compressedBytes,actualBytesReadBack:true,privateProjectionVerifiedByExporter:false,...FLAGS});
 }finally{work.release();}
}
