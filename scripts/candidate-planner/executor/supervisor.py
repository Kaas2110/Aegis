"""One reviewed dynamic fit, after actual producer gate and explicit approval."""
from contract import *
import argparse,base64,ctypes,importlib.util,secrets,subprocess,sys,re,stat
from datetime import datetime,timezone
H=Path(__file__).resolve().parent
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
def verify_job_wrapper(resource):
 proof=json.loads(base64.b64decode(os.environ.get('AEGIS_CANDIDATE_OWNED_JOB','')))
 if proof.get('contract')!='aegis-owned-task-job.v1' or proof.get('killOnJobClose')is not True or proof.get('handleInheritable')is not False:raise ValueError('owned_JobObject_wrapper_required')
 expected=int(proof['ownerStartTimeTicks'])-504911232000000000
 if identity(resource,proof['ownerPid'])!={'pid':proof['ownerPid'],'creationTime100ns':expected}:raise ValueError('wrapper_pid_reused')
 if os.getpid()not in resource.descendants(proof['ownerPid']):raise ValueError('supervisor_not_descended_from_wrapper')
 result=ctypes.c_int();k=ctypes.windll.kernel32
 k.GetCurrentProcess.restype=ctypes.c_void_p;k.IsProcessInJob.argtypes=[ctypes.c_void_p,ctypes.c_void_p,ctypes.POINTER(ctypes.c_int)]
 if not k.IsProcessInJob(k.GetCurrentProcess(),None,ctypes.byref(result)) or not result.value:raise ValueError('supervisor_not_in_JobObject')
 return proof
def identity(resource,pid):
 from ctypes import wintypes
 k=ctypes.windll.kernel32;k.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD];k.OpenProcess.restype=wintypes.HANDLE;k.CloseHandle.argtypes=[wintypes.HANDLE]
 h=k.OpenProcess(0x0400,False,pid)
 if not h:raise OSError('owner_handle_unavailable')
 try:
  if not resource._alive(h):raise ValueError('owner_exited')
  return {'pid':pid,'creationTime100ns':resource._created(h)}
 finally:k.CloseHandle(h)

def control_bytes(path,limit):
 """Bounded local evidence only; reject symlink/junction ancestry and partial files."""
 path=Path(path)
 for parent in [path,*path.parents]:
  info=parent.lstat()
  if stat.S_ISLNK(info.st_mode) or getattr(info,'st_file_attributes',0)&0x400:raise ValueError('control_reparse_path')
 info=path.lstat()
 if not stat.S_ISREG(info.st_mode) or not 0<info.st_size<=limit:raise ValueError('control_file_bound')
 with path.open('rb') as stream:raw=stream.read(limit+1)
 if len(raw)!=info.st_size or len(raw)>limit:raise ValueError('control_file_changed_or_bound')
 return raw

def control_inventory(folder):
 names=[]
 for item in folder.iterdir():
  names.append(item.name)
  if len(names)>10001:raise ValueError('control_inventory_bound')
 if 'CONTROL.lock' in names:raise ValueError('control_writer_or_quarantine')
 events=sorted(n for n in names if re.fullmatch(r'\d{6}-[a-f0-9]{64}\.json',n))
 if not 0<len(events)<=10000 or sorted(names)!=sorted([*events,'CURRENT.json']):raise ValueError('control_inventory_partial_or_orphan')
 return events

def control_journal_tip(state,previous_tip=None):
 """Require the whole hash chain and its current tip, including the gate's anchor."""
 folder=Path(state['directory']);events=control_inventory(folder)
 pointer_raw=control_bytes(folder/'CURRENT.json',1024);pointer=json.loads(pointer_raw)
 if type(pointer.get('sequence'))is not int or pointer['sequence']!=len(events)-1:raise ValueError('control_stale_pointer')
 anchor=(state['validatedSequence'],state['validatedSha256'])
 if type(anchor[0])is not int or not 0<=anchor[0]<len(events) or not re.fullmatch('[a-f0-9]{64}',anchor[1]):raise ValueError('control_gate_anchor_invalid')
 anchors=[anchor]+([previous_tip] if previous_tip is not None else [])
 for sequence,digest in anchors:
  if type(sequence)is not int or not 0<=sequence<len(events) or events[sequence]!=f'{sequence:06d}-{digest}.json':raise ValueError('control_rollback_or_fork')
 previous=None
 for sequence,name in enumerate(events):
  raw=control_bytes(folder/name,65536);digest=hashlib.sha256(raw).hexdigest();doc=json.loads(raw)
  if name!=f'{sequence:06d}-{digest}.json' or doc.get('contract')!='aegis.persistent-control-state.v1' or doc.get('policySha256')!=state['policySha256'] or doc.get('revisionId')!=state['revisionId'] or type(doc.get('sequence'))is not int or doc['sequence']!=sequence or doc.get('previousSha256')!=previous or doc.get('invalidated')is not False:raise ValueError('control_chain_invalid_or_stopped')
  previous=digest
 if pointer.get('sha256')!=previous:raise ValueError('control_pointer_invalid')
 # Any concurrent writer, publication, orphan or rollback refuses this check.
 if control_inventory(folder)!=events or control_bytes(folder/'CURRENT.json',1024)!=pointer_raw or (folder/'CONTROL.lock').exists():raise ValueError('control_changed_during_read')
 return (len(events)-1,previous)

def persistent_policy_stop(gateproof,resource):
 """Local checks only. A refused observation latches for this owned fit; never resume."""
 if gateproof.get('_persistentPolicyStopped'):return True
 try:
  for claim in gateproof.get('persistentServiceIdentities',[]):
   actual=identity(resource,claim['pid'])
   if str(actual['creationTime100ns'])!=str(claim['creationTime100ns']):raise ValueError('persistent_service_identity_changed')
  state=gateproof.get('persistentControlState')
  if state:gateproof['_observedControlTip']=control_journal_tip(state,gateproof.get('_observedControlTip'))
  return False
 except Exception:
  gateproof['_persistentPolicyStopped']=True
  return True
def run(planpath,approvalpath):
 p=read(planpath);policy=validate_plan(p);validate_approval(read(approvalpath),p,planpath)
 if sha(__file__)!=p['supervisorSource']['sha256']:raise ValueError('supervisor_source_changed')
 if os.name!='nt' or str(Path(sys.executable).resolve()).lower()!=str(pinned(p['pythonExecutable']).resolve()).lower():raise ValueError('approved_windows_python_required')
 monitor=load('_candidate_monitor',p['monitorSource']['path']);resource=load('_candidate_resource',p['resourceGuardSource']['path']);wrapper=verify_job_wrapper(resource)
 launchers=[]
 if os.getppid()!=wrapper['ownerPid']:
  if os.getppid()not in resource.descendants(wrapper['ownerPid']):raise ValueError('venv_launcher_ancestry_unverified')
  launchers=[identity(resource,os.getppid())]
 owner={'supervisor':identity(resource,os.getpid()),'launchers':launchers,'nonce':secrets.token_hex(24),'planSha256':value_sha(p),'reservation':True,'identity':p['identity'],'fitId':fit_key(p)}
 output=Path(p['outputDir']);quarantine={'unconfirmed_owned_exit':False};locks=[Path(p['globalLock']),Path(p['localLock'])]
 locks[1].parent.mkdir(parents=True,exist_ok=True)
 gateproof=None
 def stop():
  try:
   if any(Path(x).exists() for x in p.get('stopMarkerPaths',[])) or any(Path(x).exists() for x in p.get('competitorLocks',[])):return True
   if gateproof is not None:
    for spec in (p['plannerConfig'],gateproof['producerConfig'],gateproof['manualControlReceipt'],*gateproof.get('runtimeGuardPins',[])):pinned(spec)
    if persistent_policy_stop(gateproof,resource):return True
    for expiry in [x for x in [gateproof['manualControlExpiresAt'],*gateproof.get('runtimeRoleExpiries',[])] if x is not None]:
     if time.time()>=__import__('datetime').datetime.fromisoformat(expiry.replace('Z','+00:00')).timestamp():return True
   return False
  except BaseException:return True
 with monitor.owned_locks(locks,owner,quarantine):
  if stop():raise InterruptedError('stop_or_competitor_lock')
  # Parent lock directory must exist; current lock bytes are read back by the gate.
  gate=subprocess.run([p['nodeExecutable']['path'],p['gateSource']['path'],str(planpath),str(locks[1])],capture_output=True,text=True,timeout=45,creationflags=subprocess.CREATE_NO_WINDOW)
  if gate.returncode!=0:raise ValueError('fresh_candidate_gate_rejected:'+gate.stderr[-2048:])
  gateproof=json.loads(gate.stdout)
  if gateproof['status']!='READY_FOR_ONE_EXPLICITLY_APPROVED_FIT' or gateproof.get('identity')!=p['identity'] or gateproof.get('fitId')!=fit_key(p):raise ValueError('fresh_gate_required')
  if stop():raise InterruptedError('control_changed_after_gate')
  # Never resume/reuse a partial or completed directory, even with the same approval.
  claim=claim_path(p);started_at=datetime.now(timezone.utc).isoformat()
  validate_approval(read(approvalpath),p,planpath) # Gate latency must not outlive approval.
  output.mkdir(exist_ok=False);save(output/'STARTED.json',{'planSha256':sha(planpath),'approvalSha256':sha(approvalpath),'identity':p['identity'],'fitId':fit_key(p),'startedAt':started_at,'owner':owner,'wrapper':wrapper,'gate':gateproof,'automaticRetry':False})
  Path(p['claimRoot']).mkdir(parents=True,exist_ok=True);save(claim,{'contract':'aegis.rich-fit-claim.v2','fitKey':fit_key(p),'identity':p['identity'],'fitId':fit_key(p),'planSha256':sha(planpath),'approvalSha256':sha(approvalpath),'outputDir':str(output),'automaticRetry':False})
  started=time.monotonic();proc=None;record=None;pending=None
  try:
   job={**owner,'planPath':str(Path(planpath).resolve()),'approvalPath':str(Path(approvalpath).resolve()),'approvalSha256':sha(approvalpath),'locks':[str(x) for x in locks],'token':secrets.token_hex(24)}
   save(output/'job.json',job);env=dict(os.environ,AEGIS_CANDIDATE_FIT_TOKEN=job['token'])
   for key in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS','NUMEXPR_NUM_THREADS'):env[key]='4'
   if stop():raise InterruptedError('control_changed_before_worker')
   with (output/'worker.log').open('x',encoding='utf8') as log:
    proc=subprocess.Popen([sys.executable,'-B',p['workerSource']['path'],'--job',str(output/'job.json')],env=env,stdout=log,stderr=subprocess.STDOUT,creationflags=subprocess.CREATE_NO_WINDOW)
    record,pending=monitor.supervise(proc,policy=policy,own_sample=resource.sample,family_sample=resource.family_sample,terminate=resource.terminate_tree,competitor_busy=stop,elapsed=lambda:time.monotonic()-started,max_seconds=p['maxWallSeconds'],on_running=lambda:None)
   if pending:raise pending
   if record['returncode']!=0 or record['stop_reason'] or not record['monitoring_valid'] or not record['family_cleanup_confirmed']:raise RuntimeError('owned_worker_requires_review')
   result=read(output/'DONE.json');validate_result(result,p,output,planpath,approvalpath)
   save(output/'SUCCESS.json',{'identity':p['identity'],'fitId':fit_key(p),'doneSha256':sha(output/'DONE.json'),'planSha256':sha(planpath),'fits':1,'publicPromotion':False,'automaticNextStage':False})
  finally:
   if proc is not None and record is None:
    # Unexpected outer exception: only held original Popen is passed to existing cleanup.
    try:
     if proc.poll()is None:resource.terminate_tree(proc)
     proc.wait(timeout=30)
    except BaseException:pass
    quarantine['unconfirmed_owned_exit']=True
   if record is not None:
    if not record['exit_code_observed'] or not record['family_cleanup_confirmed']:quarantine['unconfirmed_owned_exit']=True
    save(output/'RESOURCE.json',record)
   save(output/'EXIT.json',{'identity':p['identity'],'fitId':fit_key(p),'startedSha256':sha(output/'STARTED.json'),'exitCode':0 if (output/'SUCCESS.json').exists() else 1,'ownershipLocksRetained':quarantine['unconfirmed_owned_exit'],'automaticRetry':False,'nextStageStarted':False})
 # A worker SUCCESS is not a closed fit. Publish closure only after owned locks release.
 closure=make_closure(p,output,record,locks,quarantine,started_at,datetime.now(timezone.utc).isoformat())
 save(output/'CLOSED-FIT.json',closure)

def make_closure(p,output,record,locks,quarantine,started_at,ended_at):
 require(not quarantine['unconfirmed_owned_exit'] and not any(x.exists() for x in locks),'ownership_locks_not_released')
 require(record is not None and record.get('returncode')==0 and record.get('exit_code_observed')is True and record.get('monitoring_valid')is True and record.get('family_cleanup_confirmed')is True and record.get('forced_termination_requested')is False and not record.get('stop_reason'),'successful_owned_resource_closure_required')
 peak=record.get('peak_aggregate_rss_bytes');free=record.get('minimum_available_bytes')
 require(type(peak)in (int,float) and math.isfinite(peak) and 0<peak<16000000000 and type(free)in (int,float) and math.isfinite(free) and free>=4294967296,'closed_fit_resource_bounds')
 return {'contract':'aegis.single-native-fit-closure.v1','identity':p['identity'],'fitId':fit_key(p),'resultSha256':sha(output/'DONE.json'),'resourceSha256':sha(output/'RESOURCE.json'),'exitSha256':sha(output/'EXIT.json'),'nativeFits':1,'exitCode':0,'exitObserved':True,'monitoringValid':True,'familyCleanupConfirmed':True,'ownershipLocksRetained':False,'forcedTermination':False,'automaticRetry':False,'threads':4,'peakAggregateRssBytes':peak,'minimumAvailableBytes':free,'startedAt':started_at,'endedAt':ended_at}
if __name__=='__main__':
 ap=argparse.ArgumentParser();ap.add_argument('--plan',type=Path,required=True);ap.add_argument('--approval',type=Path,required=True);a=ap.parse_args();run(a.plan,a.approval)
