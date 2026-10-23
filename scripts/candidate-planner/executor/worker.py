"""Only load one pinned, explicitly reviewed dynamic adapter after owned gates."""
from contract import *
import argparse,importlib.util,sys
def worker(path):
 job=read(path);p=read(job['planPath']);policy=validate_plan(p);validate_approval(read(job['approvalPath']),p,job['planPath'])
 if sha(__file__)!=p['workerSource']['sha256']:raise ValueError('worker_source_changed')
 if not os.environ.get('AEGIS_CANDIDATE_FIT_TOKEN') or job['token']!=os.environ['AEGIS_CANDIDATE_FIT_TOKEN'] or job['planSha256']!=value_sha(p) or job['approvalSha256']!=sha(job['approvalPath']) or job.get('identity')!=p['identity'] or job.get('fitId')!=fit_key(p):raise ValueError('owned_supervisor_required')
 from supervisor import identity,load
 resource=load('_worker_resource',p['resourceGuardSource']['path'])
 if identity(resource,job['supervisor']['pid'])!=job['supervisor']:raise ValueError('supervisor_pid_reused')
 for lock in job['locks']:
  held=read(lock)
  if any(held.get(k)!=job[k] for k in ('supervisor','nonce','planSha256','identity','fitId')):raise ValueError('held_ownership_lock_required')
 started=time.monotonic()
 def guard():
  s=resource.sample();parent=resource.sample(job['supervisor']['pid'])
  if s['rss']+parent['rss']>=16000000000 or s['available']<4294967296:raise MemoryError('native_resource_floor')
  if time.monotonic()-started>=p['maxWallSeconds'] or any(Path(x).exists() for x in p.get('stopMarkerPaths',[])):raise InterruptedError('manual_stop_or_wall_budget')
 guard();preflight=packed_preflight(resource.sample(),resource.sample(job['supervisor']['pid']),p['stateFeatures']+p['candidateAxisFeatures'],p['maxPackedSampleRows']);save(Path(path).parent/'MEMORY-PREFLIGHT.json',preflight)
 source=pinned(p['adapterSource']);spec=importlib.util.spec_from_file_location('_approved_rich_adapter',source);adapter=importlib.util.module_from_spec(spec);spec.loader.exec_module(adapter)
 if getattr(adapter,'CONTRACT',None)!='aegis.rich-fit-adapter.v2' or getattr(adapter,'BACKEND',None)!='lightgbm-lazyColumnSample':raise ValueError('dynamic_adapter_interface_required_no_fallback')
 # The adapter receives pinned expected bindings, never invents approval or head metadata.
 adapter_plan=json.loads(json.dumps({**p,'resultExpectation':result_expectation(p,job['planPath'],job['approvalPath'])}))
 result=adapter.fit_one(plan=adapter_plan,output=Path(path).parent,guard=guard)
 guard();validate_result(result,p,Path(path).parent,job['planPath'],job['approvalPath']);save(Path(path).parent/'DONE.json',result)
if __name__=='__main__':
 ap=argparse.ArgumentParser();ap.add_argument('--job',type=Path,required=True);worker(ap.parse_args().job)
