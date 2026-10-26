/** Actual private projection -> numeric support. Source receipt authority is a
 * separate gate: synthetic/replayed issuance can never claim original live data. */
import {createHash} from 'node:crypto';
import {retainVerifiedProjectedRow} from '../steam-live-collector/source-adapter/featureProjectionCompiler.mjs';
import {createFeatureDataCoverageAudit} from './feature-data-coverage.mjs';
const fail=x=>{throw Error('projected_row_coverage:'+x);};
const sha=x=>createHash('sha256').update(x).digest('hex');
export function auditProjectedRowDataCoverage({projection,resourceArena,minimumObservedMaps=5,provenance='synthetic',featureProvenance='replayed_derived'}={}){
 const held=retainVerifiedProjectedRow(projection);if(!held)fail('private_projected_row_required');
 let audit=null;
 try{
  const {schema,vector,descriptor,provenance:row}=held;
  if(row?.contract!=='aegis.unified-producer-row.v1'||!Number.isInteger(minimumObservedMaps)||minimumObservedMaps<1)fail('producer_context_required');
  // Original issuance is never inferred from a successful replay or from caller
  // strings. A future receipt-verifying original-observation adapter is separate.
  if(provenance!=='synthetic'&&provenance!=='retrospective_reconstruction'||featureProvenance!=='replayed_derived')fail('unverified_original_receipt_authority');
  const heroes=new Set((row.identities?.players??[]).map(p=>Number(p.heroId))),applicable=[],structuralZero=[];
  const columns=schema.definitions.map((d,i)=>{
   const p=d.applicabilityPolicy;
   if(p?.kind==='selected_draft_hero'&&!Number.isSafeInteger(p.heroId))fail('hero_applicability_contract');
   const selected=p?.kind==='selected_draft_hero'?heroes.has(p.heroId):true;
   if(!selected&&p?.unselectedValuePolicy==='structural_zero'&&(vector.missing[i]||vector.values[i]!==0))fail('structural_zero_policy_contradiction');
   applicable.push(selected);structuralZero.push(!selected&&p?.unselectedValuePolicy==='structural_zero'&&!vector.missing[i]&&vector.values[i]===0);
   return{id:String(i)+':'+sha(d.id),name:d.name.slice(0,160),familyId:d.familyId,units:d.units,producerVersion:String(d.version),sourceProfile:d.sourceProfile,applicabilityRule:p?.kind??'not_declared_assessed_as_applicable',fullNameSha256:sha(d.name),minimumObservedMaps,sourceQualified:false};
  });
  audit=createFeatureDataCoverageAudit({targetId:schema.targetId,stateMode:schema.stateMode,profileId:'private_projected_replay_v1',functionContractSha256:descriptor.featureFunctionSha256,columns,resourceArena});
  audit.ingest({ordinal:0,mapId:row.matchId??'series-context:'+row.seriesId,seriesId:row.seriesId??'unassigned:'+row.matchId,provenance,featureProvenance,functionContractSha256:descriptor.featureFunctionSha256,rowValuesSha256:descriptor.valuesAndMasksSha256,values:vector.values,missing:vector.missing,applicable,structuralZero,strata:[]});
  const base=audit.summary(),families=new Map(),orderedPages=createHash('sha256');let offset=0;
  do{
   const page=audit.readPage({offset,limit:200});orderedPages.update(JSON.stringify(page));
   for(const c of page.columns){let f=families.get(c.familyId);if(!f){f={familyId:c.familyId,columns:0,applicableColumns:0,validColumns:0,missingColumns:0,nonfiniteColumns:0,structuralZeroColumns:0,constantColumns:0,dispositions:{}};families.set(c.familyId,f);}const m=c.strata.find(s=>s.key==='ALL');f.columns++;f.applicableColumns+=m.applicable>0;f.validColumns+=m.valid>0;f.missingColumns+=m.missing>0;f.nonfiniteColumns+=m.nonfinite>0;f.structuralZeroColumns+=m.structuralZero>0;f.constantColumns+=m.constantAmongObserved;f.dispositions[c.disposition]=(f.dispositions[c.disposition]??0)+1;}
   offset=page.nextOffset;
  }while(offset!==null);
  const summary=Object.freeze({...base,actualPrivateRowVerified:true,fullColumnPagesSha256:orderedPages.digest('hex'),families:[...families.values()],singleRowAudit:true,originalObservationReceiptVerified:false});
  return Object.freeze({summary,descriptor,readPage:args=>audit.readPage(args),close(){if(!audit)return false;const old=audit;audit=null;return old.close();}});
 }catch(e){audit?.close();throw e;}finally{held.release();}
}
