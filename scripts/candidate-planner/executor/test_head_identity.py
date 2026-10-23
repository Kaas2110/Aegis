"""Offline contract/claim/closure tests: never import ML or launch training."""
import copy,json,tempfile,unittest
from pathlib import Path
from contract import *
from supervisor import make_closure

class HeadIdentityTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='aegis-head-contract-');self.root=Path(self.temp.name)
  self.addCleanup(self.temp.cleanup)
 def pin(self,name,value):
  path=self.root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(value),encoding='utf8');return {'path':str(path),'sha256':sha(path)}
 def plan(self,head='p_current_map',family='series_winner'):
  ident={'contract':'aegis.rich-fit-identity.v2','policyId':'p','intentId':'i','family':family,'fold':0,'head':head}
  p={'contract':'aegis.rich.single-fit-plan.v2','scope':'new_dynamic_candidate_contract',**{k:v for k,v in ident.items() if k!='contract'},'identity':ident,'fitId':value_sha(ident),'nativeFits':1,'automaticRetry':False,'candidateOnly':True,'publicPromotion':False,'stateFeatures':3426,'candidateAxisFeatures':int(family.endswith('_total')),'resources':{'threads':4,'rssLimitBytes':16000000000,'minimumFreeBytes':4294967296,'concurrentFits':1},'maxWallSeconds':60,'maxPackedSampleRows':100,'datasetManifestSha256':'a'*64,'featureContractSha256':'b'*64,'splitManifestSha256':'c'*64,'outputDir':str(self.root/'runs'/value_sha(ident)),'localLock':str(self.root/'local.lock'),'globalLock':str(self.root/'global.lock'),'claimRoot':str(self.root/'claims')}
  for key in ('adapterSource','plannerConfig','nodeExecutable','pythonExecutable','monitorSource','resourceGuardSource','jobHelper','gateSource','workerSource','supervisorSource','wrapperSource'):p[key]=self.pin(key+'.json',{})
  p['recipe']=self.pin('recipe.json',{'backend':'lightgbm','rounds':256,'parameters':{'num_threads':4,'feature_fraction':1,'feature_fraction_bynode':1,'feature_pre_filter':False},'earlyStopping':False,'featurePruning':False,'adapterDependencies':{'dependency.json':self.pin('dependency.json',{})}})
  p['resourcePolicy']=self.pin('resource-policy.json',{'maximum_aggregate_training_rss_bytes':16000000000,'minimum_system_available_bytes':4294967296,'training_threads':4,'concurrent_fit_jobs':1})
  p['contractSource']={'path':str(Path(__file__).parent/'contract.py'),'sha256':sha(Path(__file__).parent/'contract.py')}
  return p
 def approved(self,p):
  path=Path(self.pin('plan.json',p)['path']);a={'contract':'aegis.single-fit-root-approval.v2','approved':True,'approvedBy':'root','identity':copy.deepcopy(p['identity']),'fitId':p['fitId'],'planSha256':sha(path),'nativeFits':1,'automaticRetry':False,'publicPromotion':False,'expiresAtUnix':time.time()+1000};apath=Path(self.pin('approval.json',a)['path']);return path,apath,a
 def result(self,p,path,apath):
  out=Path(p['outputDir']);out.mkdir(parents=True,exist_ok=True);(out/'model.txt').write_text('model',encoding='utf8');e=result_expectation(p,path,apath)
  r={'contract':'aegis.rich-fit-result.v2','status':'fit_complete','identity':copy.deepcopy(p['identity']),'fitId':p['fitId'],'bindings':e['bindings'],'nativeFits':1,'trees':256,'stateFeatures':p['stateFeatures'],'candidateAxisFeatures':p['candidateAxisFeatures'],'featureCount':p['stateFeatures']+p['candidateAxisFeatures'],'fullInventoryRetained':True,'serializedParity':True,'noOuterHoldout':True,'candidateOnly':True,'publicPromotion':False,'artifacts':{'model.txt':sha(out/'model.txt')}}
  return r,out
 def test_full_plan_approval_and_result(self):
  p=self.plan();validate_plan(p);path,apath,a=self.approved(p);validate_approval(a,p,path);r,out=self.result(p,path,apath);validate_result(r,p,out,path,apath)
 def test_three_heads_have_different_claims_and_policy_binding(self):
  plans=[self.plan(h) for h in SERIES_HEADS];self.assertEqual(len({fit_key(p) for p in plans}),3)
  p=plans[0];other=copy.deepcopy(p);other['policyId']=other['identity']['policyId']='other';other['fitId']=value_sha(other['identity']);self.assertNotEqual(fit_key(p),fit_key(other))
 def test_v1_plan_and_approval_refused(self):
  p=self.plan();old=copy.deepcopy(p);old['contract']='aegis.rich.single-fit-plan.v1'
  with self.assertRaises(ValueError):validate_plan(old)
  path,apath,a=self.approved(p);a['contract']='aegis.single-fit-root-approval.v1'
  with self.assertRaises(ValueError):validate_approval(a,p,path)
 def test_approval_cannot_cross_heads_or_expire(self):
  p=self.plan();path,apath,a=self.approved(p);a['identity']['head']='q_series_if_current_won'
  with self.assertRaises(ValueError):validate_approval(a,p,path)
  a=read(apath)
  with self.assertRaises(ValueError):validate_approval(a,p,path,now=a['expiresAtUnix'])
 def test_legacy_claim_blocks_all_series_heads_without_removing_it(self):
  p=self.plan();legacy=Path(p['claimRoot'])/(legacy_fit_key(p)+'.json');legacy.parent.mkdir();legacy.write_text('{}')
  for head in SERIES_HEADS:
   with self.assertRaisesRegex(ValueError,'legacy_family_fold'):claim_path(self.plan(head))
  self.assertTrue(legacy.exists())
 def test_current_claim_blocks_only_exact_head_but_never_retries(self):
  p=self.plan();path=claim_path(p);path.parent.mkdir();path.write_text('{}')
  with self.assertRaisesRegex(ValueError,'already_claimed'):claim_path(p)
  self.assertNotEqual(claim_path(self.plan('q_series_if_current_won')),path)
 def test_wrong_head_split_feature_axis_and_artifact_rejected(self):
  p=self.plan();path,apath,a=self.approved(p);r,out=self.result(p,path,apath)
  bad=[]
  x=copy.deepcopy(r);x['identity']['head']='q_series_if_current_won';bad.append(x)
  x=copy.deepcopy(r);x['bindings']['splitManifestSha256']='d'*64;bad.append(x)
  x=copy.deepcopy(r);x['fullInventoryRetained']=False;bad.append(x)
  x=copy.deepcopy(r);x['nativeFits']=True;bad.append(x)
  x=copy.deepcopy(r);x['artifacts']={'../outside':'a'*64};bad.append(x)
  for x in bad:
   with self.assertRaises(ValueError):validate_result(x,p,out,path,apath)
  (out/'model.txt').write_text('tampered')
  with self.assertRaises(ValueError):validate_result(r,p,out,path,apath)
  p['candidateAxisFeatures']=1
  with self.assertRaises(ValueError):validate_plan_identity(p)
 def test_closure_requires_released_locks_and_actual_clean_resource_record(self):
  p=self.plan();path,apath,a=self.approved(p);r,out=self.result(p,path,apath)
  for name in ('DONE.json','RESOURCE.json','EXIT.json'):(out/name).write_text('{}')
  record={'returncode':0,'exit_code_observed':True,'monitoring_valid':True,'family_cleanup_confirmed':True,'forced_termination_requested':False,'stop_reason':None,'peak_aggregate_rss_bytes':123456,'minimum_available_bytes':8000000000}
  locks=[self.root/'a.lock',self.root/'b.lock'];q={'unconfirmed_owned_exit':False}
  c=make_closure(p,out,record,locks,q,'2026-10-23T08:00:00Z','2026-10-23T08:01:00Z');self.assertEqual(c['fitId'],p['fitId'])
  locks[0].touch()
  with self.assertRaises(ValueError):make_closure(p,out,record,locks,q,'a','b')
  locks[0].unlink()
  for key,value in [('forced_termination_requested',True),('exit_code_observed',False),('minimum_available_bytes',4294967295),('peak_aggregate_rss_bytes',16000000000)]:
   x={**record,key:value}
   with self.assertRaises(ValueError):make_closure(p,out,x,locks,q,'a','b')
 def test_resource_and_native_recipe_limits_still_fail_closed(self):
  p=self.plan();p['resources']['threads']=8
  with self.assertRaises(ValueError):validate_plan(p)
  with self.assertRaises(MemoryError):packed_preflight({'rss':100,'available':4294967296},{'rss':100},3426,100)
 def test_dependency_inventory_is_mandatory_and_pinned(self):
  p=self.plan();recipe=read(p['recipe']['path']);validate_adapter_dependencies(p,recipe)
  missing={**recipe};missing.pop('adapterDependencies')
  with self.assertRaises(ValueError):validate_adapter_dependencies(p,missing)
  Path(recipe['adapterDependencies']['dependency.json']['path']).write_text('changed')
  with self.assertRaises(ValueError):validate_adapter_dependencies(p,recipe)
if __name__=='__main__':unittest.main(verbosity=2)
