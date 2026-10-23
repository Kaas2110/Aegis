"""Bounded dynamic adapter contract. Import does not load native ML or spawn."""
import hashlib,json,os,time,re,math
from pathlib import Path
FAMILIES=('prematch_map_winner','postdraft_map_winner','live_map_winner','prematch_kills_total','prematch_duration_total','live_kills_total','live_duration_total','series_winner')
SERIES_HEADS=('p_current_map','q_series_if_current_won','q_series_if_current_lost')
BINDING_KEYS=('planSha256','approvalSha256','recipeSha256','datasetManifestSha256','featureContractSha256','splitManifestSha256')
RESULT_KEYS=('contract','status','identity','fitId','bindings','nativeFits','trees','stateFeatures','candidateAxisFeatures','featureCount','fullInventoryRetained','serializedParity','noOuterHoldout','candidateOnly','publicPromotion','artifacts')
def digest(v):return isinstance(v,str) and re.fullmatch('[a-f0-9]{64}',v)is not None
def require(ok,reason):
 if not ok:raise ValueError(reason)
def exact(v,keys,reason):require(type(v)is dict and set(v)==set(keys),reason)
def fit_identity(p):
 x=p.get('identity');exact(x,('contract','policyId','intentId','family','fold','head'),'versioned_identity_required')
 require(x['contract']=='aegis.rich-fit-identity.v2','versioned_identity_required')
 for k in ('policyId','intentId'):require(isinstance(x[k],str) and 0<len(x[k].encode('utf-16-le'))//2<=256 and re.search('[\x00-\x1f]',x[k])is None,'identity_scope_invalid')
 require(x['family']in FAMILIES and type(x['fold'])is int and x['fold']in range(4),'family_fold_identity_invalid')
 require(x['head']in SERIES_HEADS if x['family']=='series_winner' else x['head']=='main','explicit_family_head_required')
 require(all(p.get(k)==x[k] for k in ('policyId','intentId','family','fold','head')) and p.get('fitId')==value_sha(x),'plan_head_identity_mismatch')
 return x
def validate_plan_identity(p):
 require(p.get('contract')=='aegis.rich.single-fit-plan.v2' and p.get('scope')=='new_dynamic_candidate_contract' and p.get('candidateOnly')is True and p.get('publicPromotion')is False and type(p.get('nativeFits'))is int and p['nativeFits']==1 and p.get('automaticRetry')is False,'versioned_single_head_plan_required')
 x=fit_identity(p)
 require(type(p.get('stateFeatures'))is int and 1<=p['stateFeatures']<=1000000 and type(p.get('candidateAxisFeatures'))is int and p['candidateAxisFeatures']==int(x['family'].endswith('_total')),'family_axis_count_required')
 require(all(digest(p.get(k)) for k in ('datasetManifestSha256','featureContractSha256','splitManifestSha256')),'plan_dataset_feature_split_hashes_required')
 return x

def read(path):return json.loads(Path(path).read_text(encoding='utf-8-sig'))
def sha(path):
 h=hashlib.sha256()
 with Path(path).open('rb') as f:
  for b in iter(lambda:f.read(1024**2),b''):h.update(b)
 return h.hexdigest()
def value_sha(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()).hexdigest()
def save(path,value):
 with Path(path).open('x',encoding='utf8') as f:json.dump(value,f,indent=2,allow_nan=False);f.flush();os.fsync(f.fileno())
def pinned(spec):
 p=Path(spec['path'])
 if not p.is_absolute() or p.is_symlink() or not p.is_file() or sha(p)!=spec['sha256']:raise ValueError('pinned_source_changed')
 return p
def validate_plan(p):
 validate_plan_identity(p)
 if p.get('resources')!={'threads':4,'rssLimitBytes':16000000000,'minimumFreeBytes':4294967296,'concurrentFits':1}:raise ValueError('fixed_resource_limits')
 if type(p.get('maxWallSeconds'))is not int or not 1<=p['maxWallSeconds']<=21600:raise ValueError('bounded_wall_required')
 if type(p.get('stateFeatures'))is not int or p['stateFeatures']<1 or type(p.get('fold'))is not int or p['fold']not in range(4):raise ValueError('fixed_feature_fold_required')
 if p.get('candidateAxisFeatures')not in (0,1) or type(p.get('maxPackedSampleRows'))is not int or not 1<=p['maxPackedSampleRows']<=10000:raise ValueError('bounded_packed_sample_contract')
 for key in ('adapterSource','recipe','plannerConfig','nodeExecutable','pythonExecutable','monitorSource','resourceGuardSource','resourcePolicy','jobHelper','gateSource','workerSource','supervisorSource','contractSource','wrapperSource'):
  pinned(p[key])
 for spec in p.get('sourcePins',[]):pinned(spec)
 for key in ('outputDir','globalLock','localLock','claimRoot'):
  if not Path(p[key]).is_absolute():raise ValueError('absolute_output_and_lock_paths_required')
 if Path(p['globalLock'])==Path(p['localLock']) or Path(p['outputDir']).parent not in (Path(p['localLock']).parent,Path(p['localLock']).parent/'runs'):raise ValueError('independent_global_local_locks_required')
 if sha(__file__)!=p['contractSource']['sha256']:raise ValueError('executor_contract_source_changed')
 recipe=read(p['recipe']['path'])
 validate_adapter_dependencies(p,recipe)
 params=recipe.get('parameters',{})
 if recipe.get('backend')!='lightgbm' or recipe.get('rounds')!=256 or params.get('num_threads')!=4 or params.get('feature_fraction')!=1 or params.get('feature_fraction_bynode')!=1 or params.get('feature_pre_filter')is not False or recipe.get('earlyStopping')is not False or recipe.get('featurePruning')is not False:raise ValueError('fixed_rich_lightgbm_recipe_required')
 policy=read(p['resourcePolicy']['path'])
 if (policy['maximum_aggregate_training_rss_bytes'],policy['minimum_system_available_bytes'],policy['training_threads'],policy['concurrent_fit_jobs'])!=(16000000000,4294967296,4,1):raise ValueError('resource_policy_changed')
 return policy

def validate_adapter_dependencies(p,recipe):
 deps=recipe.get('adapterDependencies');require(type(deps)is dict and 0<len(deps)<=32,'explicit_adapter_dependency_inventory')
 root=Path(p['adapterSource']['path']).parent.resolve()
 for name,spec in deps.items():
  require(isinstance(name,str) and re.fullmatch('[A-Za-z0-9][A-Za-z0-9._/-]{0,255}',name)is not None and all(x not in ('','.','..')for x in name.split('/')),'relative_adapter_dependency_required')
  path=pinned(spec);require(path.resolve()==(root/name).resolve() and path.resolve().is_relative_to(root),'adapter_dependency_path_binding')
 return deps
def fit_key(p):return value_sha(fit_identity(p))
def legacy_fit_key(p):return value_sha({k:p[k] for k in ('intentId','family','fold')})
def claim_path(p):
 root=Path(p['claimRoot']);current=root/(fit_key(p)+'.json')
 # A legacy family/fold claim has unknown head ownership. Never silently retry it.
 require(not (root/(legacy_fit_key(p)+'.json')).exists(),'legacy_family_fold_claim_requires_review_no_retry')
 require(not current.exists(),'policy_intent_family_fold_head_already_claimed_no_retry')
 return current
def validate_approval(a,p,planpath,now=None):
 validate_plan_identity(p);exact(a,('contract','approved','approvedBy','identity','fitId','planSha256','nativeFits','automaticRetry','publicPromotion','expiresAtUnix'),'exact_v2_one_fit_approval_required')
 require(a['contract']=='aegis.single-fit-root-approval.v2' and a['approved']is True and a['approvedBy']=='root' and a['planSha256']==sha(planpath) and a['identity']==p['identity'] and a['fitId']==fit_key(p) and type(a['nativeFits'])is int and a['nativeFits']==1 and a['automaticRetry']is False and a['publicPromotion']is False,'explicit_one_head_root_approval_required')
 now=time.time() if now is None else now
 require(type(a['expiresAtUnix'])in (int,float) and math.isfinite(a['expiresAtUnix']) and now<a['expiresAtUnix']<=now+86400,'unexpired_bounded_approval_required')
 return a
def result_expectation(p,planpath,approvalpath):
 validate_plan_identity(p)
 return {'identity':p['identity'],'bindings':{'planSha256':sha(planpath),'approvalSha256':sha(approvalpath),'recipeSha256':p['recipe']['sha256'],**{k:p[k] for k in ('datasetManifestSha256','featureContractSha256','splitManifestSha256')}},'stateFeatures':p['stateFeatures'],'candidateAxisFeatures':p['candidateAxisFeatures']}
def validate_result(r,p,folder,planpath,approvalpath):
 e=result_expectation(p,planpath,approvalpath);exact(r,RESULT_KEYS,'exact_v2_fit_result_required')
 require(r['contract']=='aegis.rich-fit-result.v2' and r['status']=='fit_complete' and r['identity']==e['identity'] and r['fitId']==fit_key(p),'fit_identity_mismatch')
 exact(r['bindings'],BINDING_KEYS,'six_exact_binding_hashes_required');require(r['bindings']==e['bindings'],'fit_source_binding_mismatch')
 require(all(type(r[k])is int for k in ('nativeFits','trees','stateFeatures','candidateAxisFeatures','featureCount')) and r['nativeFits']==1 and r['trees']==256 and r['stateFeatures']==p['stateFeatures'] and r['featureCount']==p['stateFeatures']+p['candidateAxisFeatures'] and r['candidateAxisFeatures']==p['candidateAxisFeatures'],'full_state_and_axis_inventory_mismatch')
 require(all(r[k]is True for k in ('fullInventoryRetained','serializedParity','noOuterHoldout','candidateOnly')) and r['publicPromotion']is False,'candidate_full_inventory_parity_required')
 require(type(r['artifacts'])is dict and 1<=len(r['artifacts'])<=128,'adapter_artifacts_required')
 for name,hashvalue in r['artifacts'].items():
  require(isinstance(name,str) and re.fullmatch('[A-Za-z0-9][A-Za-z0-9._/-]{0,255}',name)is not None and all(x not in ('','.','..') for x in name.split('/')) and digest(hashvalue),'relative_artifact_hashes_required')
  path=Path(folder)/name
  if not path.resolve().is_relative_to(Path(folder).resolve()) or any(x.is_symlink() or getattr(x.lstat(),'st_file_attributes',0)&0x400 for x in [path,*path.parents]) or sha(path)!=hashvalue:raise ValueError('adapter_artifact_changed')
def packed_preflight(worker,parent,features,rows):
 if type(features)is not int or features<1 or type(rows)is not int or not 1<=rows<=10000:raise ValueError('packed_bounds')
 reserve=features*rows*12
 if worker['rss']+parent['rss']+reserve>=16000000000 or worker['available']-reserve<4294967296:raise MemoryError('packed_sample_headroom')
 return {'features':features,'rows':rows,'worstPackedBytes':reserve,'workerRss':worker['rss'],'supervisorRss':parent['rss'],'available':worker['available']}
