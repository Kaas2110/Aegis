import test from 'node:test';import assert from 'node:assert/strict';
import {createFeatureDataCoverageAudit} from './feature-data-coverage.mjs';
import {createDiagnosticResourceArena} from '../steam-live-collector/source-adapter/diagnosticResourceArena.mjs';
const H='a'.repeat(64),columns=['hero.selected','roshan.age','unknown.gold'].map((name,index)=>({id:name,name,familyId:'fixture',units:'test',producerVersion:'fixture.v1',sourceProfile:'fixture-retained',applicabilityRule:'explicit_per_row',sourceQualified:index!==2,minimumObservedMaps:1}));
const setup=()=>{const resourceArena=createDiagnosticResourceArena({maxBytes:64*1024**2});return{resourceArena,audit:createFeatureDataCoverageAudit({targetId:'LIVE_MAP_WIN',stateMode:'LIVE',profileId:'fixture',functionContractSha256:H,columns,resourceArena})};};
const row=(over={})=>({ordinal:0,mapId:'m1',seriesId:'s1',provenance:'observed_live',featureProvenance:'replayed_derived',functionContractSha256:H,rowValuesSha256:H,values:[0,null,10],missing:[false,true,false],applicable:[false,true,true],structuralZero:[true,false,false],strata:['minute:5','patch:unknown'],...over});
test('structural unselected zero is distinct from selected unknown and opaque observed value',()=>{
 const{audit,resourceArena}=setup();try{audit.ingest(row());const p=audit.readPage().columns;assert.equal(p[0].disposition,'no_applicable_rows');assert.equal(p[0].strata[0].structuralZero,1);assert.equal(p[1].disposition,'no_observed_real_values');assert.equal(p[1].strata[0].missing,1);assert.equal(p[2].disposition,'nonqualified_source');assert.equal(audit.summary().trainingAdmitted,false);}finally{audit.close();}assert.equal(resourceArena.status().chargedBytes,0);
});
test('repeated frames count one map, new map increments support, series stays one',()=>{
 const{audit}=setup();try{audit.ingest(row({values:[1,4,10],missing:[false,false,false],applicable:[true,true,true],structuralZero:[false,false,false]}));audit.ingest(row({ordinal:1,values:[2,3,10],missing:[false,false,false],applicable:[true,true,true],structuralZero:[false,false,false]}));audit.ingest(row({ordinal:2,mapId:'m2',values:[2,3,10],missing:[false,false,false],applicable:[true,true,true],structuralZero:[false,false,false]}));const c=audit.readPage().columns[0].strata[0];assert.equal(c.valid,3);assert.equal(c.validMaps,2);assert.equal(c.validSeries,1);assert.equal(c.constantAmongObserved,false);}finally{audit.close();}
});
test('synthetic values cannot establish observed real training support',()=>{const{audit}=setup();try{audit.ingest(row({provenance:'synthetic',values:[1,0,10],missing:[false,false,false],applicable:[true,true,true],structuralZero:[false,false,false]}));assert.equal(audit.readPage().columns[1].disposition,'synthetic_only');assert.equal(audit.summary().realRows,0);}finally{audit.close();}});
test('nonfinite measured values are counted, not converted to zero or accepted',()=>{const{audit}=setup();try{audit.ingest(row({values:[0,Infinity,10],missing:[false,false,false]}));const c=audit.readPage().columns[1];assert.equal(c.strata[0].nonfinite,1);assert.equal(c.strata[0].zero,0);assert.equal(c.disposition,'no_observed_real_values');}finally{audit.close();}});
test('invalid masks and repeated map after moving forward reject without incrementing rows',()=>{const{audit}=setup();try{assert.throws(()=>audit.ingest(row({values:[0,7,10]})),/value_mask/);assert.equal(audit.status().rows,0);audit.ingest(row());audit.ingest(row({ordinal:1,mapId:'m2'}));assert.throws(()=>audit.ingest(row({ordinal:2})),/noncontiguous/);assert.equal(audit.status().rows,2);}finally{audit.close();}});
test('actual support remains separated by explicit minute/profile strata and finite pages',()=>{const{audit}=setup();try{audit.ingest(row({values:[0,60,10],missing:[false,false,false]}));audit.ingest(row({ordinal:1,strata:['minute:10'],values:[0,null,10]}));const p=audit.readPage({limit:1});assert.equal(p.nextOffset,1);const c=audit.readPage({offset:1,limit:1}).columns[0];assert.equal(c.strata.find(s=>s.key==='minute:5').valid,1);assert.equal(c.strata.find(s=>s.key==='minute:10').missing,1);assert.throws(()=>audit.ingest(row({ordinal:2})),/sealed/);}finally{audit.close();}});
test('resource refusal closes initial construction leases',()=>{const arena=createDiagnosticResourceArena({maxBytes:1024});assert.throws(()=>createFeatureDataCoverageAudit({targetId:'LIVE_MAP_WIN',stateMode:'LIVE',profileId:'fixture',functionContractSha256:H,columns,resourceArena:arena}),/memory_admission/);assert.equal(arena.status().chargedBytes,0);});

test('new group and identity admission rolls back before flushing any prior row',()=>{
 for(const rejectAt of [2,4]){
  const base=createDiagnosticResourceArena({maxBytes:16*1024**2});let attempt=0,armed=false;
  const arena={reserve(n){if(armed&&++attempt===rejectAt)return null;return base.reserve(n);},status:()=>base.status()},audit=createFeatureDataCoverageAudit({targetId:'LIVE_MAP_WIN',stateMode:'LIVE',profileId:'fixture',functionContractSha256:H,columns,resourceArena:arena});
  const first=row({strata:[],values:[1,4,10],missing:[false,false,false],applicable:[true,true,true],structuralZero:[false,false,false]}),second={...first,ordinal:1,mapId:'m2',seriesId:'s2',strata:['new:a','new:b']};
  try{
   audit.ingest(first);const charged=base.status().chargedBytes;armed=true;
   assert.throws(()=>audit.ingest(second),/memory_admission/);assert.equal(base.status().chargedBytes,charged);assert.equal(audit.status().rows,1);
   armed=false;audit.ingest(second);const summary=audit.summary(),all=audit.readPage().columns[0].strata.find(s=>s.key==='ALL');
   assert.equal(summary.rows,2);assert.equal(summary.mapCount,2);assert.equal(summary.seriesCount,2);assert.equal(summary.groupCount,3);assert.equal(all.validMaps,2);assert.equal(all.validSeries,2);
  }finally{audit.close();assert.equal(base.status().chargedBytes,0);}
 }
});

test('extra nested column payload is refused before hashing and releases ownership',()=>{
 const arena=createDiagnosticResourceArena({maxBytes:16*1024**2});
 assert.throws(()=>createFeatureDataCoverageAudit({targetId:'LIVE_MAP_WIN',stateMode:'LIVE',profileId:'fixture',functionContractSha256:H,columns:columns.map((c,i)=>i?c:{...c,payload:{large:'x'.repeat(8192)}}),resourceArena:arena}),/column_contract/);
 assert.equal(arena.status().chargedBytes,0);
});

