/** Disabled diagnostic model INPUT port. This module owns no model, network,
 * fitted state, listener or activation. Private compiler authority proves the
 * actual schema/vector bytes; source publication/causality stay separate gates. */
import {createHash} from 'node:crypto';
import {retainVerifiedProjectionSchema,retainVerifiedProjectionVector} from './featureProjectionCompiler.mjs';
import {createDiagnosticResourceArena,snapshotPlainRecord} from './diagnosticResourceArena.mjs';
import {hashFeatureAsset,freezeFeatureAsset,inspectFeatureAsset} from './featureProjectionOwnership.mjs';
import {LEGACY_FEATURE_CAPACITY_PROFILE as LEGACY,FULL_FEATURE_CAPACITY_PROFILE as FULL,featureCapacityProfileForSchema} from './featureCapacityProfiles.mjs';
export const DIAGNOSTIC_MODEL_INPUT_CONTRACT='aegis.diagnostic-model-input-manifest.v1';
export const DIAGNOSTIC_MODEL_INPUT_FULL_CONTRACT='aegis.diagnostic-model-input-manifest.v2';
const WORK=64*1024**2,MAX_PAGE=200,MAX_PAGES=8,SHA=/^[a-f0-9]{64}$/;
export const DIAGNOSTIC_MODEL_INPUT_LIMITS=Object.freeze({workingBytes:WORK,maxPageRows:MAX_PAGE,maxOwnedPages:MAX_PAGES,maxFeatures:LEGACY.maxFeatures,maxFeaturesByCapacityProfile:Object.freeze({[LEGACY.id]:LEGACY.maxFeatures,[FULL.id]:FULL.maxFeatures})});
const fail=reason=>{throw Error('diagnostic_model_input:'+reason);};
const flags=Object.freeze({diagnosticOnly:true,modelOutput:null,modelActivation:false,eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false,sourceAvailabilityAttested:false});
const unavailable=reason=>({status:'unavailable',reason,...flags});
function stream(){const h=createHash('sha256');let count=0;h.update('[');return{add(value){if(count++)h.update(',');h.update(JSON.stringify(value));},finish(){h.update(']');return h.digest('hex');}};}
function borrow(schema,vector,expectedSchemaHash){
 const s=retainVerifiedProjectionSchema(schema,{expectedSchemaHash});if(!s)fail('private_schema_required');let v;
 try{v=retainVerifiedProjectionVector(vector,{expectedNamesHash:s.descriptor.namesSha256,featureCount:s.descriptor.featureCount});if(!v)fail('private_vector_order_required');return{s,v,release(){v.release();s.release();}};}catch(error){v?.release();s.release();throw error;}
}
function column(d){const x={id:d.id,name:d.name,units:d.units,dtype:d.dtype,missingPolicy:d.missingPolicy};if(Object.values(x).some(v=>typeof v!=='string'||!v.length||v.length>16384))fail('column_contract_bound');return x;}
function describe(held){
 const schema=held.s.schema,vector=held.v.vector,descriptor=held.s.descriptor,count=descriptor.featureCount,capacity=featureCapacityProfileForSchema(schema),full=capacity===FULL;
 if(count<1||count>capacity.maxFeatures||schema.definitions.length!==count||vector.values.length!==count||vector.missing.length!==count||vector.names.length!==count)fail('projection_shape');
 const columns=stream(),values=stream(),missing=stream();
 for(let i=0;i<count;i++){const d=schema.definitions[i],v=vector.values[i],m=vector.missing[i];if(d.name!==vector.names[i]||typeof m!=='boolean'||m!==(v===null)||v!==null&&(typeof v!=='number'||!Number.isFinite(v)))fail('projection_column');columns.add(column(d));values.add([v,Object.is(v,-0)]);missing.add(m);}
 const body={contract:full?DIAGNOSTIC_MODEL_INPUT_FULL_CONTRACT:DIAGNOSTIC_MODEL_INPUT_CONTRACT,...(full?{capacityProfile:capacity.id,schemaContract:schema.contract}:{}),targetId:schema.targetId,stateMode:schema.stateMode,schemaSha256:descriptor.sha256,namesSha256:descriptor.namesSha256,featureCount:count,sourceInventorySha256:hashFeatureAsset(schema.sourceInventory),columnContractSha256:columns.finish(),valuesSha256:values.finish(),missingSha256:missing.finish(),valueEncoding:'ordered [numeric_or_null,is_negative_zero] tuples',unitsPolicy:'exact ordered per-definition units/dtype/missingPolicy bound by columnContractSha256 and original full schemaSha256',missingnessPolicy:'one boolean per original position; true iff value===null; no zero imputation',authority:'private_compiler_schema_and_vector; source CODE inventory only',...flags};
 return freezeFeatureAsset({...body,sha256:hashFeatureAsset(body)});
}
export function createDiagnosticModelInputManifest({schema,vector,expectedSchemaHash,resourceArena=null}={}){
 const arena=resourceArena??createDiagnosticResourceArena(),work=arena.reserve(WORK);if(!work)fail('working_admission');let held;
 try{held=borrow(schema,vector,expectedSchemaHash);return describe(held);}finally{held?.release();work.release();}
}
/** The injected trusted port can record inputs, never return a model output.
 * It must consume/release bounded pages before returning. No copied JSON schema,
 * arbitrary caller array or a declared SHA can mint private compiler authority. */
export function createDiagnosticModelInputDelivery({enabled=false,recordingPort=null,resourceArena=null,shouldContinue=()=>true}={}){
 if(typeof enabled!=='boolean'||recordingPort!==null&&typeof recordingPort?.recordInput!=='function'||typeof shouldContinue!=='function')fail('configuration');
 const arena=resourceArena??createDiagnosticResourceArena();let closed=false,busy=false;
 const continuing=()=>{try{return!closed&&shouldContinue()===true;}catch{return false;}};
 return Object.freeze({async deliverProjection(input={}){
  if(!enabled||recordingPort===null)return unavailable('diagnostic_recording_port_disabled');if(!continuing())return unavailable('stopped_or_closed');if(busy)return unavailable('busy');busy=true;
  let work,held,active=true;const pages=new Set();
  try{
   work=arena.reserve(WORK);if(!work)return unavailable('working_admission');const{manifest,schema,vector,expectedSchemaHash}=snapshotPlainRecord(input,{maxKeys:4});held=borrow(schema,vector,expectedSchemaHash);const actual=describe(held),declared=snapshotPlainRecord(manifest,{maxKeys:32});
   // Manifest fields are flat scalars. Compare to the freshly streamed actual
   // descriptor directly; never stringify/hash arbitrary caller-sized strings.
   if(!SHA.test(declared.sha256??'')||Object.keys(declared).length!==Object.keys(actual).length||Object.keys(actual).some(key=>declared[key]!==actual[key]))return unavailable('exact_manifest_binding');
   const deliveredPositions=new Uint8Array(actual.featureCount);let deliveredCount=0;
   const readPage=({offset=0,limit=MAX_PAGE}={})=>{
    if(!active||!continuing())fail('page_after_stop_or_release');if(!Number.isSafeInteger(offset)||offset<0||offset>actual.featureCount||!Number.isSafeInteger(limit)||limit<1||limit>MAX_PAGE||pages.size>=MAX_PAGES)fail('page_bound');
    const end=Math.min(actual.featureCount,offset+limit),rows=[];for(let i=offset;i<end;i++)rows.push({...column(held.s.schema.definitions[i]),index:i,value:held.v.vector.values[i],missing:held.v.vector.missing[i]});
    const page=freezeFeatureAsset({contract:actual.capacityProfile===FULL.id?'aegis.diagnostic-model-input-page.v2':'aegis.diagnostic-model-input-page.v1',...(actual.capacityProfile===FULL.id?{capacityProfile:FULL.id}:{}),manifestSha256:actual.sha256,offset,total:actual.featureCount,nextOffset:end<actual.featureCount?end:null,columns:rows}),size=inspectFeatureAsset(page,{workingBytes:WORK,maxBytes:4*1024**2,maxNodes:65536}),lease=arena.retainAsset(page,size.bytes+65536);if(!lease)fail('page_admission');let released=false;const out=Object.freeze({page,release(){if(released)return false;released=true;pages.delete(out);lease.release();return true;}});pages.add(out);for(let i=offset;i<end;i++)if(deliveredPositions[i]===0){deliveredPositions[i]=1;deliveredCount++;}return out;
   };
   if(!continuing())return unavailable('stopped_before_delivery');const receipt=await recordingPort.recordInput(Object.freeze({manifest:actual,readPage}));if(!continuing())return unavailable('stopped_after_delivery');
   const r=snapshotPlainRecord(receipt,{maxKeys:8});if(Object.keys(r).sort().join(',')!=='contract,featureCount,manifestSha256,modelOutput,recordedPrediction,status'||r.contract!=='aegis.recorded-diagnostic-model-input.v1'||r.status!=='recorded_input_only'||r.manifestSha256!==actual.sha256||r.featureCount!==actual.featureCount||r.modelOutput!==null||r.recordedPrediction!==false)return unavailable('recording_receipt_contract');
   if(deliveredCount!==actual.featureCount)return unavailable('incomplete_recording_delivery');
   return{status:'recorded_input_only',...(actual.capacityProfile===FULL.id?{capacityProfile:FULL.id}:{}),manifestSha256:actual.sha256,targetId:actual.targetId,stateMode:actual.stateMode,featureCount:actual.featureCount,...flags};
  }catch{return unavailable('owned_projection_or_recording_contract');}finally{active=false;for(const page of [...pages])page.release();held?.release();work?.release();busy=false;}
 },close(){closed=true;},status(){return{enabled,closed,busy,resources:arena.status()};},...flags});
}
