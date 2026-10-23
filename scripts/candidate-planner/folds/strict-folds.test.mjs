import test from'node:test';
import assert from'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync}from'node:fs';
import {join,resolve,relative,isAbsolute,sep,dirname}from'node:path';
import {fileURLToPath}from'node:url';
import {CONTRACT,verifyComponentFolds,instantNs}from'./strict_folds.mjs';
import {MANIFEST_CONTRACT,verifyBoundManifest,sha}from'./bound.mjs';
const H='a'.repeat(64),clone=x=>JSON.parse(JSON.stringify(x));
const iso=s=>new Date(Date.UTC(2025,0,1)+s*1000).toISOString();
export function fixture(){
 const componentMembers=[];
 for(let c=0;c<5;c++)for(let n=0;n<2;n++){
  const t=c*4*86400+n*3600;
  componentMembers.push({mapId:`m${c}${n}`,seriesId:`series${c}${n}`,componentId:`c${c}`,partition:'TRAIN',startTime:iso(t),predictionAt:iso(t-3600),endTime:iso(t+1800),labelAvailability:{at:iso(t+2100),kind:'historical_end_plus_300_reconstruction',sourceRevisionKnownAt:iso(25*86400),basis:'map_end',basisEndTime:iso(t+1800)}});
 }
 const mapRows=componentMembers.map(({mapId,seriesId,componentId,partition,startTime,predictionAt})=>({mapId,seriesId,componentId,partition,startTime,predictionAt,featureKnownAt:predictionAt}));
 return {contract:CONTRACT,family:'prematch_map_winner',scope:{scopeId:'synthetic-reviewed-scope',asOf:iso(30*86400),sourceManifestSha256:H,componentIdentityPolicySha256:H,protectionPolicySha256:H,membershipCompleteness:'complete_within_pinned_scope'},componentMembers,mapRows,folds:Array.from({length:4},(_,i)=>({fold:i,trainMapIds:mapRows.filter(r=>Number(r.componentId.slice(1))<=i).map(r=>r.mapId),validationMapIds:mapRows.filter(r=>r.componentId===`c${i+1}`).map(r=>r.mapId)}))};
}
const rejects=(x,message)=>assert.throws(()=>verifyComponentFolds(x),new RegExp(message));
test('four expanding folds retain distinct series within each complete component',()=>{
 const x=fixture(),before=JSON.stringify(x),r=verifyComponentFolds(x);
 assert.equal(r.folds.length,4);assert.equal(r.folds[0].trainUniverseMembers,2);assert.equal(r.nativeFits,0);
 assert.equal(r.familyReadinessProduced,false);assert.equal(r.dispatchEnabled,false);assert.equal(r.historicalReceiptTruthClaim,false);assert.equal(JSON.stringify(x),before);
});
test('cross-series same-component leakage rejected',()=>{const x=fixture();x.folds[0].trainMapIds=['m00'];x.folds[0].validationMapIds=['m01'];rejects(x,'whole_component_crossed_fold');});
test('all selected maps of represented component assigned together',()=>{const x=fixture();x.folds[0].trainMapIds.pop();rejects(x,'selected_component_partially_assigned');});
test('unselected training component member sets label max',()=>{
 const x=fixture(),r=clone(x.componentMembers[0]);r.mapId='hidden';r.seriesId='hidden-series';r.labelAvailability={...r.labelAvailability,at:iso(4*86400-3600),kind:'recorded_label_receipt',sourceRevisionKnownAt:iso(25*86400)};x.componentMembers.push(r);rejects(x,'whole_component_24h_embargo');
});
test('unselected validation component member sets earliest origin',()=>{
 const x=fixture(),r=clone(x.componentMembers[2]);r.mapId='hidden-val';r.seriesId='hidden-val-series';r.predictionAt=iso(10000);x.componentMembers.push(r);rejects(x,'whole_component_24h_embargo');
});
function exactBoundary(){const x=fixture();for(const r of x.componentMembers.filter(r=>r.componentId==='c0'))r.labelAvailability={...r.labelAvailability,at:iso(3*86400-3600),kind:'recorded_label_receipt',sourceRevisionKnownAt:iso(25*86400)};return x;}
test('exact 86400-second embargo accepted',()=>assert.equal(verifyComponentFolds(exactBoundary()).folds[0].gapNanoseconds,'86400000000000'));
test('one nanosecond below 24h refused',()=>{const x=exactBoundary();x.componentMembers[0].labelAvailability.at=x.componentMembers[0].labelAvailability.at.replace('.000Z','.000000001Z');rejects(x,'whole_component_24h_embargo');});
test('equivalent timezone preserves nanoseconds',()=>assert.equal(instantNs('2025-01-01T03:00:00.123456789+03:00'),instantNs('2025-01-01T00:00:00.123456789Z')));
test('calendar and aware timestamp validation',()=>{
 for(const s of ['2025-02-30T00:00:00Z','2025-01-01T00:00:60Z','2025-01-01T00:00:00','2025-01-01T00:00:00+24:00','2025-01-01T00:00:00.1234567890Z'])assert.throws(()=>instantNs(s));
 assert.equal(instantNs('0001-01-01T00:00:00Z')<0n,true);
});
test('unknown availability in used TRAIN component rejected',()=>{const x=fixture();x.componentMembers[1].labelAvailability=null;rejects(x,'training_component_label_availability_unknown');});
test('unknown availability of unused component remains explicit without blocking',()=>{
 const x=fixture(),r=clone(x.componentMembers[0]);Object.assign(r,{mapId:'unused',seriesId:'unused',componentId:'unused',endTime:null,labelAvailability:null});x.componentMembers.push(r);assert.equal(verifyComponentFolds(x).componentUniverseMaps,11);
});
test('validation component cannot be reused across folds',()=>{const x=fixture();x.folds[1].trainMapIds=['m00','m01'];x.folds[1].validationMapIds=['m10','m11'];rejects(x,'validation_component_reused');});
test('same series cannot carry inconsistent component IDs',()=>{const x=fixture();x.componentMembers[2].seriesId=x.componentMembers[0].seriesId;rejects(x,'series_component_identity_conflict');});
test('unknown/duplicate fold map and duplicate universe map refused',()=>{
 const a=fixture();a.folds[0].trainMapIds.push('unknown');rejects(a,'fold_map_overlap_duplicate_or_unknown');
 const b=fixture();b.folds[0].trainMapIds.push('m00');rejects(b,'fold_map_overlap_duplicate_or_unknown');
 const c=fixture();c.componentMembers.push(clone(c.componentMembers[0]));rejects(c,'duplicate_universe_map');
});
test('future features and borrowed member identity refused',()=>{
 const a=fixture();a.mapRows[0].featureKnownAt=iso(1);rejects(a,'family_feature_or_origin_asof_invalid');
 const b=fixture();b.mapRows[0].componentId='c4';rejects(b,'selected_universe_identity_mismatch');
});
test('reconstruction end+300 cannot be advertised with different timestamp',()=>{const x=fixture();x.componentMembers[0].labelAvailability.at=iso(2101);rejects(x,'reconstruction_end_plus_300_required');});
test('series folds use terminal-series availability shared across all heads',()=>{
 const x=fixture();x.family='series_winner';rejects(x,'family_label_availability_basis_required');
 for(const r of x.componentMembers)r.labelAvailability.basis='terminal_series_end';assert.equal(verifyComponentFolds(x).family,'series_winner');
 const a=x.componentMembers[0].labelAvailability;a.basisEndTime=iso(4*86400-3600);a.at=iso(4*86400-3300);rejects(x,'whole_component_24h_embargo');
});
test('outcome poison property rejected without decoding getter',()=>{
 const x=fixture();let decoded=false;Object.defineProperty(x.componentMembers[0],'winner',{enumerable:true,get(){decoded=true;throw Error('OUTCOME_DECODED');}});
 rejects(x,'metadata_shape');assert.equal(decoded,false);
});
test('scope policies/protected partition and unknown outcome-like keys refused',()=>{
 const a=fixture();a.scope.membershipCompleteness='selected_rows_only';rejects(a,'pinned_scope_policies_required');
 const b=fixture();b.componentMembers[0].partition='holdout';rejects(b,'TRAIN_member_identity_required');
 const c=fixture();c.mapRows[0].finalScore=1;rejects(c,'metadata_shape');
});
test('array getter cannot execute',()=>{const x=fixture();let decoded=false;Object.defineProperty(x.mapRows,'0',{get(){decoded=true;throw Error('getter');}});rejects(x,'bounded_family_map_rows_required');assert.equal(decoded,false);});
test('future scope members and selected prediction times refused',()=>{
 const a=fixture();a.componentMembers[0].startTime=iso(31*86400);rejects(a,'member_after_scope_asof');
 const b=fixture();b.mapRows[0].predictionAt=iso(31*86400);rejects(b,'family_feature_or_origin_asof_invalid');
});
const output=process.env.AEGIS_TEST_OUTPUT_ROOT;
test('bound local manifest pins all metadata; drift/unbound refs refuse',()=>{
 const source=dirname(fileURLToPath(import.meta.url)),rel=typeof output==='string'?relative(source,resolve(output)):'';
 assert.ok(output&&isAbsolute(output)&&(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)),'set external AEGIS_TEST_OUTPUT_ROOT');
 mkdirSync(output,{recursive:true});const dir=mkdtempSync(join(output,'bound-')),x=fixture();
 function pin(name,value){const path=join(dir,name),bytes=Buffer.from(JSON.stringify(value));writeFileSync(path,bytes,{flag:'wx'});return {path,bytes:bytes.length,sha256:sha(bytes)};}
 const m={contract:MANIFEST_CONTRACT,family:x.family,scope:x.scope,componentMembers:pin('members.json',x.componentMembers),mapRows:pin('maps.json',x.mapRows),folds:pin('folds.json',x.folds),candidateOnly:true,fitAuthorized:false,dispatchEnabled:false,publicPromotion:false};
 const spec=pin('manifest.json',m);assert.equal(verifyBoundManifest(spec).status,'metadata_verified');
 const bytes=readFileSync(m.mapRows.path),corrupt=Buffer.from(bytes);corrupt[2]^=1;writeFileSync(m.mapRows.path,corrupt);assert.throws(()=>verifyBoundManifest(spec),/metadata_sha_changed/);
 writeFileSync(m.mapRows.path,Buffer.concat([bytes,Buffer.from(' ')]));assert.throws(()=>verifyBoundManifest(spec),/metadata_size_changed/);
 const other=clone(m);other.mapRows=null;const bad=pin('unbound.json',other);assert.throws(()=>verifyBoundManifest(bad),/pin_shape/);
});
