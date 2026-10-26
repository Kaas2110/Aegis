/** Streaming feature support audit, not model quality or training admission.
 * Rows must be contiguous by series/map. Values come from a declared projection;
 * this audit does not mint private source/model authority from caller metadata. */
import {createHash} from 'node:crypto';
import {snapshotPlainRecord,createDiagnosticResourceArena} from '../steam-live-collector/source-adapter/diagnosticResourceArena.mjs';
import {FEATURE_PREPARATION_MODES} from './pinned-dataset-manifest.mjs';
export const FEATURE_DATA_COVERAGE_CONTRACT='aegis.feature-data-coverage.v1';
const HASH=/^[a-f0-9]{64}$/,text=x=>typeof x==='string'&&x.length>0&&x.length<=1024;
const fail=x=>{throw Error('feature_data_coverage:'+x);};
const COUNT_FIELDS=['applicable','valid','missing','nonfinite','zero','structuralZero','realValid','validMaps','realValidMaps','validSeries'];
const flags={trainingAdmitted:false,qualityEvaluationPerformed:false,sourceAvailabilityAttested:false};
// Exact JSON array bytes without one concatenated whole-inventory string.
const hash=x=>{const h=createHash('sha256');h.update('[');for(let i=0;i<x.length;i++){if(i)h.update(',');h.update(JSON.stringify(x[i]));}return h.update(']').digest('hex');};
export function createFeatureDataCoverageAudit({targetId,stateMode,profileId,functionContractSha256,columns,resourceArena=null,maxGroups=24,maxRows=1000000,maxIdentities=100000}={}){
 if(!FEATURE_PREPARATION_MODES.some(m=>m.targetId===targetId&&m.stateMode===stateMode)||!text(profileId)||!HASH.test(functionContractSha256??'')||!Array.isArray(columns)||columns.length<1||columns.length>300000||!Number.isInteger(maxGroups)||maxGroups<1||maxGroups>32||!Number.isInteger(maxRows)||maxRows<1||maxRows>1000000||!Number.isInteger(maxIdentities)||maxIdentities<1||maxIdentities>100000)fail('configuration');
 const arena=resourceArena??createDiagnosticResourceArena(),leases=[];
 function reserve(n){const lease=arena.reserve(n);if(!lease)fail('memory_admission');leases.push(lease);return lease;}
 let closed=false,sealed=false,rows=0,realRows=0,lastOrdinal=-1,currentMap=null,currentSeries=null,mapCount=0,seriesCount=0;
 const seenMaps=new Set(),seenSeries=new Set(),groups=new Map();let definitionHash;
 const descriptorCharge=reserve(columns.length*1536+65536),owned=[];
 try{
  const ids=new Set();let chars=0;
  for(let i=0;i<columns.length;i++){
   const c=snapshotPlainRecord(columns[i],{maxKeys:10}),keys=['id','name','familyId','units','producerVersion','sourceProfile','applicabilityRule','sourceQualified','minimumObservedMaps','fullNameSha256'];
   if(Object.keys(c).some(k=>!keys.includes(k))||!keys.slice(0,7).every(k=>text(c[k]))||ids.has(c.id)||typeof c.sourceQualified!=='boolean'||!Number.isInteger(c.minimumObservedMaps)||c.minimumObservedMaps<1||c.minimumObservedMaps>100000||Object.hasOwn(c,'fullNameSha256')&&!HASH.test(c.fullNameSha256??''))fail('column_contract');
   chars+=Object.values(c).filter(v=>typeof v==='string').reduce((s,v)=>s+Buffer.byteLength(v),0);if(chars>columns.length*1024)fail('column_metadata_bound');
   ids.add(c.id);owned.push(Object.freeze({...c,index:i}));
  }
  definitionHash=hash(owned);
 }catch(e){for(const l of leases)l.release();throw e;}
 const count=owned.length;
 function makeGroup(key){
  return{key,rows:0,counts:Object.fromEntries(COUNT_FIELDS.map(k=>[k,new Uint32Array(count)])),mapValid:new Uint8Array(count),mapReal:new Uint8Array(count),seriesValid:new Uint8Array(count),first:new Float64Array(count),firstSeen:new Uint8Array(count),varies:new Uint8Array(count)};
 }
 try{reserve(count*64+65536);groups.set('ALL',makeGroup('ALL'));}catch(e){for(const l of leases)l.release();throw e;}
 function ensure(){if(closed||sealed)fail('closed_or_sealed');}
 function flushMap(){for(const g of groups.values())for(let i=0;i<count;i++){g.counts.validMaps[i]+=g.mapValid[i];g.counts.realValidMaps[i]+=g.mapReal[i];g.mapValid[i]=0;g.mapReal[i]=0;}}
 function flushSeries(){for(const g of groups.values())for(let i=0;i<count;i++){g.counts.validSeries[i]+=g.seriesValid[i];g.seriesValid[i]=0;}}
 function ingest(raw){
  ensure();const r=snapshotPlainRecord(raw,{maxKeys:14});
  if(!Number.isSafeInteger(r.ordinal)||r.ordinal<=lastOrdinal||!text(r.mapId)||!text(r.seriesId)||!['observed_live','retrospective_reconstruction','synthetic'].includes(r.provenance)||!['originally_issued','replayed_derived'].includes(r.featureProvenance)||r.functionContractSha256!==functionContractSha256||!HASH.test(r.rowValuesSha256??''))fail('row_identity_or_contract');
  if(rows>=maxRows||![r.values,r.missing,r.applicable,r.structuralZero].every(a=>(Array.isArray(a)||ArrayBuffer.isView(a))&&a.length===count)||!Array.isArray(r.strata)||r.strata.length>8||r.strata.some(k=>!text(k)||k==='ALL')||new Set(r.strata).size!==r.strata.length)fail('row_shape');
  if(currentMap!==r.mapId&&seenMaps.has(r.mapId)||currentSeries!==r.seriesId&&seenSeries.has(r.seriesId)||currentMap===r.mapId&&currentSeries!==r.seriesId)fail('noncontiguous_or_cross_series_map');
  if(!seenMaps.has(r.mapId)&&seenMaps.size>=maxIdentities||!seenSeries.has(r.seriesId)&&seenSeries.size>=maxIdentities)fail('identity_bound');
  // Validate every value before mutating counters. A mask is explicit evidence,
  // never inferred from a structural zero or a selected hero's missing operand.
  for(let i=0;i<count;i++){
   const m=r.missing[i],a=r.applicable[i],z=r.structuralZero[i],v=r.values[i];
   if(typeof m!=='boolean'||typeof a!=='boolean'||typeof z!=='boolean'||m&&v!==null||!m&&typeof v!=='number'||z&&(m||v!==0))fail('value_mask_or_applicability');
  }
  const newKeys=r.strata.filter(k=>!groups.has(k));if(groups.size+newKeys.length>maxGroups)fail('group_bound');
  // Admit and allocate every new group and both identities as one transaction.
  // A refusal leaves counters, flush state, groups and ordinal unchanged.
  const newMap=currentMap!==r.mapId,newSeries=currentSeries!==r.seriesId,pendingLeases=[],pendingGroups=[];
  function pendingReserve(bytes){const l=arena.reserve(bytes);if(!l)fail('memory_admission');pendingLeases.push(l);}
  try{
   for(const key of newKeys){pendingReserve(count*64+65536);pendingGroups.push([key,makeGroup(key)]);}
   if(newMap)pendingReserve(512+r.mapId.length*4);
   if(newSeries)pendingReserve(512+r.seriesId.length*4);
  }catch(e){for(const l of pendingLeases)l.release();throw e;}
  for(const l of pendingLeases)leases.push(l);for(const [key,g]of pendingGroups)groups.set(key,g);
  const selected=[groups.get('ALL'),...r.strata.map(key=>groups.get(key))];
  if(newMap){if(currentMap!==null)flushMap();seenMaps.add(r.mapId);currentMap=r.mapId;mapCount++;}
  if(newSeries){if(currentSeries!==null)flushSeries();seenSeries.add(r.seriesId);currentSeries=r.seriesId;seriesCount++;}
  const real=r.provenance!=='synthetic';rows++;if(real)realRows++;lastOrdinal=r.ordinal;
  for(const g of selected){g.rows++;for(let i=0;i<count;i++){
   const c=g.counts,v=r.values[i];if(r.structuralZero[i])c.structuralZero[i]++;
   if(!r.applicable[i])continue;c.applicable[i]++;
   if(r.missing[i]){c.missing[i]++;continue;}if(!Number.isFinite(v)){c.nonfinite[i]++;continue;}
   c.valid[i]++;g.mapValid[i]=1;g.seriesValid[i]=1;if(real){c.realValid[i]++;g.mapReal[i]=1;}if(v===0)c.zero[i]++;
   if(!g.firstSeen[i]){g.first[i]=v;g.firstSeen[i]=1;}else if(!Object.is(g.first[i],v))g.varies[i]=1;
  }}
  return{rows,realRows,mapCount,seriesCount};
 }
 function seal(){if(closed)fail('closed');if(!sealed){flushMap();flushSeries();sealed=true;}}
 function metrics(g,i){const out={};for(const k of COUNT_FIELDS)out[k]=g.counts[k][i];return{...out,missingRate:out.applicable?out.missing/out.applicable:null,nonfiniteRate:out.applicable?out.nonfinite/out.applicable:null,constantAmongObserved:out.valid>0&&!g.varies[i]};}
 function disposition(i){const c=owned[i],g=groups.get('ALL').counts;if(!c.sourceQualified)return'nonqualified_source';if(g.applicable[i]===0)return'no_applicable_rows';if(g.realValidMaps[i]===0)return g.valid[i]?'synthetic_only':'no_observed_real_values';if(g.realValidMaps[i]<c.minimumObservedMaps)return'insufficient_observed_map_support';return'observed_support_requires_separate_training_review';}
 function summary(){seal();const dispositions={};for(let i=0;i<count;i++){const k=disposition(i);dispositions[k]=(dispositions[k]??0)+1;}return Object.freeze({contract:FEATURE_DATA_COVERAGE_CONTRACT,targetId,stateMode,profileId,functionContractSha256,columnDefinitionSha256:definitionHash,featureCount:count,rows,realRows,mapCount,seriesCount,groupCount:groups.size,dispositions,meaning:'Observed numeric support only; no causal/source authority, model quality or training admission is inferred. Constant/rare columns are reported, never pruned.',...flags});}
 function readPage({offset=0,limit=200}={}){
  seal();if(!Number.isInteger(offset)||offset<0||offset>count||!Number.isInteger(limit)||limit<1||limit>200)fail('page_bound');
  const end=Math.min(count,offset+limit),items=[];for(let i=offset;i<end;i++)items.push({...owned[i],disposition:disposition(i),strata:[...groups.values()].map(g=>({key:g.key,...metrics(g,i)}))});
  return{contract:'aegis.feature-data-coverage-page.v1',functionContractSha256,columnDefinitionSha256:definitionHash,offset,total:count,nextOffset:end<count?end:null,columns:items,...flags};
 }
 return Object.freeze({ingest,summary,readPage,close(){if(closed)return false;closed=true;groups.clear();seenMaps.clear();seenSeries.clear();owned.length=0;for(const l of leases)l.release();return true;},status(){return{rows,realRows,closed,sealed,resources:arena.status()};}});
}
