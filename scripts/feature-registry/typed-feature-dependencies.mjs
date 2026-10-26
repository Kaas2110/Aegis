/** Exact typed dependency closure. No names/formula-template alias guessing. */
import{createHash}from'node:crypto';
import{createDiagnosticResourceArena}from'../steam-live-collector/source-adapter/diagnosticResourceArena.mjs';
const fail=x=>{throw Error('typed_feature_dependencies:'+x);},text=x=>typeof x==='string'&&x.length>0&&x.length<=16384;
export function auditTypedFeatureDependencies({definitions,resourceArena=null,maxEdges=10000000,shouldContinue=()=>true}={}){
 if(!Array.isArray(definitions)||definitions.length>300000||!Number.isInteger(maxEdges)||maxEdges<1||maxEdges>10000000||typeof shouldContinue!=='function')fail('configuration');
 const arena=resourceArena??createDiagnosticResourceArena(),lease=arena.reserve(definitions.length*512+65536);if(!lease)fail('memory_admission');let edgeLease=null;
 try{
  const byId=new Map(),byName=new Map();let declared=0;
  for(let i=0;i<definitions.length;i++){
   if(shouldContinue()!==true)fail('stopped');const d=definitions[i];if(!text(d?.id)||!text(d.name)||byId.has(d.id))fail('definition_identity');byId.set(d.id,i);const ids=byName.get(d.name)??[];ids.push(i);byName.set(d.name,ids);
   if(d.dependencyRefs!==undefined&&!Array.isArray(d.dependencyRefs))fail('reference_list');declared+=d.dependencyRefs?.length??0;if(declared>maxEdges)fail('edge_bound');
  }
  edgeLease=arena.reserve(declared*128+definitions.length*32+65536);if(!edgeLease)fail('edge_memory_admission');
  const edges=new Array(definitions.length),gaps=[],ownIneligible=new Uint8Array(definitions.length),states=new Uint8Array(definitions.length),closureIneligible=new Uint8Array(definitions.length),digest=createHash('sha256'),gapDigest=createHash('sha256');let inputRefs=0,featureRefs=0,templateRefs=0,learnedRefs=0,gapCount=0;
  const gap=(index,reason)=>{const row={index,id:definitions[index].id,reason};gapCount++;gapDigest.update(JSON.stringify(row));if(gaps.length<200)gaps.push(row);};
  for(let i=0;i<definitions.length;i++){
   const d=definitions[i],out=[],refs=d.dependencyRefs;
   ownIneligible[i]=d.modelEligibility==='ineligible'||['opaque_provider','unqualified','unknown'].includes(d.sourceMeaningStatus)||['unverified_native_semantics','unverified_legacy_semantics','parameter_binding_required'].includes(d.semanticVerification)?1:0;
   if(!refs?.length){gap(i,'typed_dependencies_not_declared');ownIneligible[i]=1;}
   const seen=new Set();for(const r of refs??[]){
    if(!r||typeof r!=='object')fail('reference_shape');
    if(r.kind==='input'){
     const p=r.port;if(!p||!['normalizedField','rawField','sourceProfile','sourceKind','units','availabilityPolicy'].every(k=>text(p[k])))fail('input_port');
     const key=JSON.stringify(['input',p]);if(seen.has(key))continue;seen.add(key);inputRefs++;digest.update(key);
    }else if(r.kind==='feature'){
     if(!text(r.component)||!text(r.name))fail('emitted_reference');
     const exact=r.component+':'+r.name,index=byId.get(exact),key='feature:'+exact;if(seen.has(key))continue;seen.add(key);featureRefs++;
     if(index===undefined){gap(i,'missing_exact_emitted_feature:'+exact);ownIneligible[i]=1;}else out.push(index);digest.update(key);
    }else if(r.kind==='formulaTemplate'){
     if(!text(r.templateId))fail('formula_template');templateRefs++;
     // Metadata cannot resolve a missing emitted operand even when its ID matches.
    }else if(r.kind==='learnedState'){
     if(!text(r.stateId)||!text(r.outputMeasurementContract)||!text(r.foldLineagePolicy))fail('learned_state_reference');learnedRefs++;gap(i,'actual_train_only_state_lineage_not_verified');ownIneligible[i]=1;
    }else fail('unknown_reference_kind');
   }
   // A declaration that old history strings exist is not enough. Every such
   // operand must have an exact feature edge or an explicitly typed input port.
   for(const h of d.historyDefinitions??[]){if(typeof h!=='string')fail('history_reference');if(!refs?.some(r=>r.kind==='feature'&&r.name===h||r.kind==='input'&&(r.port?.normalizedField===h||r.port?.statisticKey===h||r.port?.selector?.statisticKey===h||d.historicalStatisticRefs?.some(s=>s.key===h&&r.port?.normalizedField===`${s.component}.${({team:'teams',player:'players',hero:'heroes'})[s.profileKind]}[selector].statistics.${s.key}`))))
    {gap(i,'untyped_legacy_history_operand:'+h);ownIneligible[i]=1;}}
   edges[i]=out;
  }
  for(let root=0;root<definitions.length;root++){
   if(shouldContinue()!==true)fail('stopped');if(states[root]===2)continue;const stack=[[root,0]];states[root]=1;
   while(stack.length){const frame=stack[stack.length-1],i=frame[0],next=edges[i][frame[1]];if(next===undefined){closureIneligible[i]=ownIneligible[i]||edges[i].some(j=>closureIneligible[j])?1:0;states[i]=2;stack.pop();continue;}frame[1]++;if(states[next]===1)fail('cyclic_emitted_dependency');if(states[next]===0){states[next]=1;stack.push([next,0]);}}
  }
  let ineligible=0;for(const v of closureIneligible)ineligible+=v;
  return Object.freeze({contract:'aegis.typed-feature-dependency-audit.v1',definitions:definitions.length,inputRefs,featureRefs,templateRefs,learnedRefs,typedReferenceDigest:digest.digest('hex'),declarationGapCount:gapCount,orderedGapSha256:gapDigest.digest('hex'),declarationGaps:gaps,gapExamplesTruncated:gapCount>gaps.length,transitivelyIneligibleDefinitions:ineligible,completeTypedClosure:gapCount===0,sourceAvailabilityAttested:false,trainingAdmitted:false,qualityEvaluationPerformed:false});
 }finally{edgeLease?.release();lease.release();}
}
