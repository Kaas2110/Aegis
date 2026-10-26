import test from 'node:test';import assert from 'node:assert/strict';
import {createFeatureProjectionCompiler} from '../steam-live-collector/source-adapter/featureProjectionCompiler.mjs';
import {createDiagnosticResourceArena} from '../steam-live-collector/source-adapter/diagnosticResourceArena.mjs';
import {syntheticRegistry} from './registry-contract.fixtures.mjs';
import {validateRegistry,digest} from './registry-contract.mjs';
import {auditProjectedRowDataCoverage} from './projected-row-data-coverage.mjs';
function fixture(unselectedValue=0){
 const[index,familyDocument,targetDocument]=syntheticRegistry(),arena=createDiagnosticResourceArena({maxBytes:512*1024**2}),compiler=createFeatureProjectionCompiler({registry:validateRegistry(index,familyDocument,targetDocument),registryHash:digest(index),sourceInventory:{history:{primarySha256:'a'.repeat(64),files:[{path:'synthetic.mjs',sha256:'a'.repeat(64)}]}},sourceProfiles:{history:'synthetic.prior'},resourceArena:arena});
 const definitions=[{name:'selected',familyId:'H01',formula:'synthetic count',formulaVersion:'1',units:'count',inputScopes:['prior_maps'],applicabilityPolicy:{kind:'selected_draft_hero',heroId:1,unselectedValuePolicy:'structural_zero'}},{name:'unselected',familyId:'H01',formula:'synthetic count',formulaVersion:'1',units:'count',inputScopes:['prior_maps'],applicabilityPolicy:{kind:'selected_draft_hero',heroId:2,unselectedValuePolicy:'structural_zero'}}],block=compiler.normalize({names:['selected','unselected'],values:[null,unselectedValue],masks:[true,unselectedValue===null],definitions},'history'),context={contract:'aegis.unified-producer-row.v1',matchId:'100',seriesId:'s',identities:{players:[{heroId:1}]}};
 const route=compiler.project([block],'PRE_MAP_WIN','PRE',null,new Map(),context);
 return{arena,projection:{schema:route.diagnosticSchema,vector:route.diagnosticVector,expectedSchemaHash:route.schemaRef.sha256,projectedRowAuthority:route.projectedRowAuthority},close(){route.release();block.release();compiler.close();}};
}
test('private actual row support separates selected missing and absent-hero structural zero',()=>{
 const f=fixture();let audit;
 try{audit=auditProjectedRowDataCoverage({projection:f.projection,resourceArena:f.arena});assert.equal(audit.summary.featureCount,2);assert.equal(audit.summary.realRows,0);const p=audit.readPage({limit:2});assert.equal(p.columns[0].strata[0].missing,1);assert.equal(p.columns[1].strata[0].applicable,0);assert.equal(p.columns[1].strata[0].structuralZero,1);assert.equal(p.columns[0].sourceQualified,false);assert.equal(audit.summary.trainingAdmitted,false);}finally{audit?.close();f.close();assert.equal(f.arena.status().chargedBytes,0);}
});
test('copied authority and unverified originally-issued flags cannot create support evidence',()=>{
 const f=fixture();try{assert.throws(()=>auditProjectedRowDataCoverage({projection:{...f.projection,projectedRowAuthority:structuredClone(f.projection.projectedRowAuthority)},resourceArena:f.arena}),/private_projected_row_required/);assert.throws(()=>auditProjectedRowDataCoverage({projection:f.projection,resourceArena:f.arena,provenance:'observed_live',featureProvenance:'originally_issued'}),/unverified_original_receipt_authority/);}finally{f.close();assert.equal(f.arena.status().chargedBytes,0);}
});

test('genuine projected rows with unselected missing or nonzero hero values refuse structural policy contradictions',()=>{
 for(const value of [null,7]){const f=fixture(value);try{assert.throws(()=>auditProjectedRowDataCoverage({projection:f.projection,resourceArena:f.arena}),/structural_zero_policy_contradiction/);}finally{f.close();assert.equal(f.arena.status().chargedBytes,0);}}
});
