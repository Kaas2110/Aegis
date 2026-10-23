"""Explicit receipt-phase candidate hook on one already-owned Steam cache.

No HTTP routes, history bootstrap, alternate formulas, provider or model fit.
Native inference remains lazy inside the original root-bound phase heads.
"""
from __future__ import annotations
import builtins,copy,hashlib,importlib.util,json,sys,threading,time,types
from pathlib import Path
from . import local
from .outcome_guard import KnownOutcomeGuard, Refusal as OutcomeGuardRefusal
from .steam_intake import source_inventory,READER_SHA,ADAPTER_SHA

PHASE_SHA='f659e84fc59167c68d28db65f0e1b42e24a073de8ef6ffa27e95fb38aa771fed'
TOTALS_SHA='7361737b26ff42efca61b0fcbe4d451e5a5407b0f2997d6dd049f72eab31ea6f'
CONTRACT='c2_steam_receipt_phase_hook.v2';RESULT='c2_steam_phase_dispatch_result.v1'
FLAGS={k:False for k in('active','eligibleForServing','eligibleForPromotion','eligibleForQualityClaims',
 'eligibleForProspectiveEvaluation','prospectiveValidated','coverage95Validated','eventLatencyVerified')}
_IMPORT_LOCK=threading.Lock()
class Refusal(ValueError):pass
def need(ok,reason):
 if not ok:raise Refusal('c2_phase_'+reason)
def own_manifest(directory):
 # Installed copy verifies its executed bytes against the separately sealed
 # source bundle. Never assume a MANIFEST exists beside installed APP code.
 root=local.trusted_path(directory,directory=True).resolve();raw=local.read_file(root/'MANIFEST.json',2*1024**2)
 files=local.parse(raw)['files'];relative='staged/shadow_wide_c2/receipt_phase.py'
 need(files.get(relative)=={'bytes':Path(__file__).stat().st_size,'sha256':local.sha(local.read_file(__file__,200000))},'hook_source_pin')
 # The whole successor (including host/intake) is part of this authorization.
 source_inventory(root,local.sha(raw));return local.sha(raw)
def phase_modules(directory):
 """Verified raw modules in private namespaces; copied sys.path only for common.

 The sealed phase common's script-path insertion acts on a private list. Its
 exact bytes execute; imports among seven known modules are mapped locally.
 No generic sys.modules aliases, sys.path changes or baseline globals edits.
 """
 phase=source_inventory(directory,PHASE_SHA);totals=phase.parent/'rich-totals-fitted-diagnostic-20261020'
 source_inventory(totals,TOTALS_SHA)
 names=[('aegis_rich_totals_common',totals),('aegis_rich_totals_dependencies',totals),('aegis_rich_totals_binding',totals),
  ('aegis_phase_common',phase),('aegis_phase_projector',phase),('aegis_phase_fitted',phase),('aegis_phase_runtime',phase)]
 modules={};prefix='_aegis_c2_receipt_phase_f659_'+hashlib.sha256(str(phase).encode()).hexdigest()[:12]
 with _IMPORT_LOCK:
  for key,folder in names:
   private=prefix+'_'+key;path=folder/(key+'.py');raw=local.read_file(path,200000);digest=local.sha(raw)
   existing=sys.modules.get(private)
   if existing is not None:
    need(getattr(existing,'__aegis_sha__',None)==digest and Path(existing.__file__).resolve()==path.resolve(),'private_namespace_collision');modules[key]=existing;continue
   spec=importlib.util.spec_from_file_location(private,path);module=importlib.util.module_from_spec(spec)
   def imports(name,globals=None,locals=None,fromlist=(),level=0,*,_key=key):
    if level==0 and name in modules:return modules[name]
    if _key=='aegis_phase_common'and level==0 and name=='sys':return types.SimpleNamespace(path=list(sys.path),modules=sys.modules)
    return builtins.__import__(name,globals,locals,fromlist,level)
   module.__dict__['__builtins__']={**vars(builtins),'__import__':imports};sys.modules[private]=module
   try:exec(compile(raw,str(path),'exec'),module.__dict__);module.__aegis_sha__=digest
   except BaseException:sys.modules.pop(private,None);raise
   modules[key]=module
 return types.SimpleNamespace(common=modules['aegis_phase_common'],projector=modules['aegis_phase_projector'],runtime=modules['aegis_phase_runtime'])

CDF_SHA='ebc437cee1b05bc9146d963d1ee0254f15ed0e4f5a226c3bad3e3e032c652c61'

def cdf_phase_modules(directory,reference):
 """Original phase source, explicit new totals base; no module/global patching."""
 need(type(reference)is dict and set(reference)=={'directory','sourceManifestSha256'}and
  reference['sourceManifestSha256']==CDF_SHA,'exact_cdf_runtime_ref')
 phase=source_inventory(directory,PHASE_SHA)
 original=source_inventory(phase.parent/'rich-totals-fitted-diagnostic-20261020',TOTALS_SHA)
 cdf=source_inventory(reference['directory'],CDF_SHA)
 # Phase common/winner remain on original contracts. Only the unchanged fitted
 # subclass's RichTotalsBindings base is explicitly resolved to the CDF source.
 plan=[
  ('old_common','aegis_rich_totals_common',original,{'aegis_rich_totals_dependencies':'old_dependencies'}),
  ('old_dependencies','aegis_rich_totals_dependencies',original,{'aegis_rich_totals_common':'old_common'}),
  ('old_binding','aegis_rich_totals_binding',original,{'aegis_rich_totals_common':'old_common','aegis_rich_totals_dependencies':'old_dependencies'}),
  ('cdf_common','aegis_rich_totals_common',cdf,{'aegis_rich_totals_dependencies':'cdf_dependencies'}),
  ('cdf_dependencies','aegis_rich_totals_dependencies',cdf,{'aegis_rich_totals_common':'cdf_common'}),
  ('cdf_transport','aegis_hazard_cdf_transport',cdf,{}),
  ('cdf_binding','aegis_rich_totals_binding',cdf,{'aegis_rich_totals_common':'cdf_common','aegis_rich_totals_dependencies':'cdf_dependencies','aegis_hazard_cdf_transport':'cdf_transport'}),
  ('phase_common','aegis_phase_common',phase,{'aegis_rich_totals_common':'old_common','aegis_rich_totals_dependencies':'old_dependencies'}),
  ('phase_projector','aegis_phase_projector',phase,{'aegis_phase_common':'phase_common'}),
  ('phase_fitted','aegis_phase_fitted',phase,{'aegis_phase_common':'phase_common','aegis_rich_totals_dependencies':'old_dependencies','aegis_rich_totals_binding':'cdf_binding'}),
  ('phase_runtime','aegis_phase_runtime',phase,{'aegis_phase_common':'phase_common','aegis_phase_projector':'phase_projector','aegis_phase_fitted':'phase_fitted'})]
 modules={};prefix='_aegis_receipt_phase_exact_cdf_'+hashlib.sha256((str(phase)+'|'+str(cdf)+'|'+CDF_SHA).encode()).hexdigest()[:20]
 with _IMPORT_LOCK:
  created=[]
  try:
   for key,name,folder,bindings in plan:
    private=prefix+'_'+key;path=folder/(name+'.py');raw=local.read_file(path,200000);digest=local.sha(raw)
    contract=tuple(sorted(bindings.items()));existing=sys.modules.get(private)
    if existing is not None:
     need(getattr(existing,'__aegis_sha__',None)==digest and getattr(existing,'__aegis_imports__',None)==contract and
      Path(existing.__file__).resolve()==path.resolve(),'private_cdf_namespace_collision');modules[key]=existing;continue
    spec=importlib.util.spec_from_file_location(private,path);module=importlib.util.module_from_spec(spec)
    def imports(name,globals=None,locals=None,fromlist=(),level=0,*,_key=key,_bindings=bindings):
     if level==0 and name in _bindings:return modules[_bindings[name]]
     if _key=='phase_common'and level==0 and name=='sys':return types.SimpleNamespace(path=list(sys.path),modules=sys.modules)
     return builtins.__import__(name,globals,locals,fromlist,level)
    module.__dict__['__builtins__']={**vars(builtins),'__import__':imports};sys.modules[private]=module;created.append(private)
    exec(compile(raw,str(path),'exec'),module.__dict__);module.__aegis_sha__=digest;module.__aegis_imports__=contract;modules[key]=module
   phase_common=modules['phase_common'];cdf_common=modules['cdf_common'];fitted=modules['phase_fitted']
   need(phase_common.verify_package()==PHASE_SHA and cdf_common.verify_package()==CDF_SHA,'cdf_phase_kernel_recheck')
   class ReceiptPhaseTotalsCDF(fitted.ReceiptPhaseTotalsBindings):
    """Only typed exception identity crosses private namespaces."""
    def __init__(self,*args,**kwargs):
     try:super().__init__(*args,**kwargs)
     except cdf_common.Refusal as error:raise phase_common.Refusal(*error.args)from None
    def diagnose_phase(self,*args,**kwargs):
     try:return super().diagnose_phase(*args,**kwargs)
     except cdf_common.Refusal as error:raise phase_common.Refusal(*error.args)from None
   return types.SimpleNamespace(common=phase_common,projector=modules['phase_projector'],runtime=modules['phase_runtime'],
    totals_factory=ReceiptPhaseTotalsCDF,cdf_common=cdf_common,cdf_binding=modules['cdf_binding'],fitted=fitted,
    cdf_source_manifest=CDF_SHA)
  except BaseException:
   for private in reversed(created):sys.modules.pop(private,None)
   raise


def reviewed_engine(intake,common,engine):
 need(engine is intake.engine and type(engine)is intake._engine_class,'exact_intake_owned_engine')
 contract=common.read(common.H/'SOURCE-CONTRACT.json');pin=contract['sources']['installed_engine'];matches=[]
 for cls in type(engine).__mro__:
  module=sys.modules.get(cls.__module__);path=getattr(module,'__file__',None)
  if path and Path(path).resolve()==Path(pin['path']).resolve():matches.append((cls,path))
 need(len(matches)==1 and common.file_sha(matches[0][1])==pin['sha256'],'exact_original_engine_base_source')
 need(engine.cache is engine.bridge.cache and engine.cache.proof.get('sourceBundleSha256')==contract['bridgeSourceBundleSha256']and
  getattr(engine.bridge,'_steam_source_adapter',False)is True,'corrected_same_steam_cache')
 proof=engine.cache.proof.get('localOptimization',{})
 need(intake.config['readerManifestSha256']==READER_SHA and intake.config['adapterManifestSha256']==ADAPTER_SHA and
  proof.get('runnerManifestSha256')==ADAPTER_SHA and proof.get('executedBinderModuleSha256')=='4e95f9af81d36f46b41d3d30dd24034a1020910b2011bf45f32a4841721b8c66'and
  proof.get('noGlobalMonkeyPatch')is True,'reviewed_private_r3_dependency')

class ReceiptPhaseHook:
 def __init__(self,intake,ref,*,clock,guard,monotonic=time.monotonic,verifier=own_manifest,module_loader=phase_modules,outcome_factory=KnownOutcomeGuard):
  need(type(ref)is dict and set(ref)=={'path','sha256','bytes'}and local.hex64(ref['sha256'])and type(ref['bytes'])is int and 0<ref['bytes']<=100000,'config_ref')
  raw=local.read_file(ref['path'],100000);need(len(raw)==ref['bytes']and local.sha(raw)==ref['sha256'],'config_pin');cfg=local.parse(raw)
  keys={'contract','enabled','rootReviewed','diagnosticsAuthorized','approvedBy','hookSourceManifestSha256','hookDirectory','runtimeDirectory',
   'runtimeSourceManifestSha256','runtimeConfig','outcomeGuard','maxProjectionSeconds','maxRetainedPostdraftAgeSeconds','maxCachedMaps','maxResponseBytes'}
  need(type(cfg)is dict and set(cfg)in(keys,keys|{'totalsCDF'})and cfg['contract']==CONTRACT and cfg['enabled']is True and cfg['rootReviewed']is True and
   cfg['diagnosticsAuthorized']is True and cfg['approvedBy']=='root','explicit_root_phase_hook_required')
  self.source=verifier(cfg['hookDirectory']);need(cfg['hookSourceManifestSha256']==self.source and cfg['runtimeSourceManifestSha256']==PHASE_SHA,'exact_hook_kernel_sources')
  need(type(cfg['maxProjectionSeconds'])is int and 1<=cfg['maxProjectionSeconds']<=30 and
   type(cfg['maxRetainedPostdraftAgeSeconds'])is int and 1<=cfg['maxRetainedPostdraftAgeSeconds']<=300 and
   type(cfg['maxCachedMaps'])is int and 1<=cfg['maxCachedMaps']<=32 and cfg['maxResponseBytes']==4*1024**2,'finite_phase_limits')
  self.intake=intake;self.clock=clock;self.guard=guard;self.monotonic=monotonic;self.config=cfg;self.config_sha=ref['sha256'];self.saved={}
  self.modules=(cdf_phase_modules(cfg['runtimeDirectory'],cfg['totalsCDF'])if 'totalsCDF'in cfg else module_loader(cfg['runtimeDirectory']));runtime_ref=cfg['runtimeConfig']
  need(type(runtime_ref)is dict and set(runtime_ref)=={'path','sha256','bytes'}and type(runtime_ref['bytes'])is int and 0<runtime_ref['bytes']<=100000,'runtime_config_ref')
  runtime_raw=local.read_file(runtime_ref['path'],100000);need(len(runtime_raw)==runtime_ref['bytes']and local.sha(runtime_raw)==runtime_ref['sha256'],'runtime_config_pin')
  # Injection is the existing explicit PhaseProjector interface, not a rewrite.
  def projector(engine,*,guard):return self.modules.projector.PhaseProjector(engine,guard=guard,
   engine_verifier=lambda current:reviewed_engine(intake,self.modules.common,current))
  runtime_options={'totals_factory':self.modules.totals_factory}if 'totalsCDF'in cfg else {}
  self.runtime=self.modules.runtime.ReceiptPhaseRuntime(intake.engine,runtime_ref['path'],runtime_ref['sha256'],guard=guard,projector_factory=projector,**runtime_options)
  self.outcomes=outcome_factory(cfg['outcomeGuard'],directory=cfg['hookDirectory'],source_manifest=self.source,clock=clock,guard=guard)
 def owns_result(self,value):return type(value)is dict and value.get('contract')==RESULT and value.get('hookConfigSha256')==self.config_sha
 def identity(self,reader):
  row=reader['current'];binding=row['sourceBinding'];i=binding['identity']
  return {'match':row['match_id'],'server':i['serverSteamIdDecimal'],'league':i['leagueIdDecimal'],
   'radiant':i['radiantTeamIdDecimal'],'dire':i['direTeamIdDecimal'],
   'players':self.intake.reader.cap.identity_rows(i['players']),'explicitRawStartField':binding['candidateStartEpochSeconds']}
 def current(self,reader,now):
  steam=self.intake.reader;steam.verify_reader(reader,now=now,lineage=self.intake.engine.bridge._steam_original_lineage,require_live=False)
  row=reader['current'];receipt,recorded=steam.verify_row(row);at=steam.us(now)
  need(recorded<=at and 0<=at-receipt<=180000000,'current_receipt_future_or_stale')
  steam.start_evidence(reader,self.intake.policy_raw,self.intake.policy_sha)
  steam.reviewed_state_policy(reader,self.intake.state_policy_raw,self.intake.state_policy_sha)
  return row,receipt,at
 def wrap(self,reader,now,*,status,phase,diagnostics,retention=None,reason=None):
  row=reader['current'];out={'contract':RESULT,'status':status,'phase':phase,'reason':reason,'matchId':row['match_id'],'computedAt':now,
   'hookSourceManifestSha256':self.source,'hookConfigSha256':self.config_sha,'phaseKernelManifestSha256':PHASE_SHA,'readerContract':self.intake.reader.CONTRACT,
   'gameStatePolicyProof':self.intake.reader.reviewed_state_policy(reader,self.intake.state_policy_raw,self.intake.state_policy_sha),
   'sourceStartFieldPolicySha256':self.intake.policy_sha,'sourceStartUsedAsFeatureCutoff':False,
   'currentObservation':{'id':row['id'],'readerSha256':self.intake.reader.hashobj(reader),'receivedAt':row['received_at'],
    'gameTimeSeconds':row['game_time_sec'],'sourceObservedPhase':row['phase'],'rawSourceSha256':row['sourceBinding']['rawSourceSha256']},
   'phaseDiagnostics':diagnostics,'retention':retention,'physicalScoreAssumed':False,'actualGameStartAssumed':False,
   'prediction':None,'modelHash':None,'c1':None,'c2':None,'automaticProviderPolling':False,**FLAGS}
  need(len(json.dumps(out,separators=(',',':'),allow_nan=True).encode())<=self.config['maxResponseBytes'],'response_bound')
  return out
 def _project(self,reader,*,live_project):
  self.guard();started=self.monotonic();now=local.wall(self.clock).isoformat()
  # V3 preserves the original raw integer clock. No truncation/rounding.
  need(reader.get('contract')=='steam_rt_committed_reader.candidate.v3','distinct_v3_reader_required')
  need(type(reader.get('current',{}).get('game_time_sec'))is int and reader['current']['game_time_sec']>=-3600,'raw_integer_clock_required')
  row,receipt,at=self.current(reader,now);clock=row['game_time_sec']
  if clock>=300:return live_project() # Original live reader/start/model gates.
  key=self.identity(reader);mid=row['match_id']
  if clock<=0:
   need(mid in self.saved or len(self.saved)<self.config['maxCachedMaps'],'phase_map_cache_bound')
   pair={'contract':'confirmed_team_pair_asof_receipt.v1','matchId':mid,'sourceObservationId':row['id'],
    'sourceInputHash':row['input_hash'],'knownAt':row['received_at'],'teamIds':sorted((row['input']['radiantTeamId'],row['input']['direTeamId'])),
    'sidesKnownAt':row['received_at'],'radiantTeamId':row['input']['radiantTeamId'],'direTeamId':row['input']['direTeamId']}
   diagnostics={'prematch':self.runtime.refresh(reader,'prematch',computed_at=now,team_pair_evidence=pair,lines=[])if clock<0 else
    {'status':'unavailable','reason':'c2_phase_prematch_beforeplay_source_missing_at_zero_clock','prediction':None,'modelHash':None,**FLAGS},
    'postdraft':self.runtime.refresh(reader,'postdraft',computed_at=now,team_pair_evidence=None,lines=[])}
   self.guard();need(self.monotonic()-started<=self.config['maxProjectionSeconds'],'projection_wall_bound')
   value=self.wrap(reader,now,status='projected_diagnostic',phase='postdraft',diagnostics=diagnostics)
   self.saved[mid]={'identity':key,'receipt':receipt,'value':copy.deepcopy(value),'lobby':copy.deepcopy(row['sourceBinding']['identity']['lobbyId'])}
   return value
  saved=self.saved.get(mid)
  if saved is None:return self.wrap(reader,now,status='unavailable',phase='early_live_unvalidated',diagnostics=None,reason='c2_phase_no_prior_postdraft_diagnostic')
  need(saved['identity']==key,'retained_map_server_start_teams_roster_changed')
  before=saved['lobby'];after=row['sourceBinding']['identity']['lobbyId']
  need(before['missing']or after['missing']or before['decimal']==after['decimal'],'retained_explicit_lobby_changed')
  age=(at-saved['receipt'])/1e6
  if not 0<=age<=self.config['maxRetainedPostdraftAgeSeconds']:
   return self.wrap(reader,now,status='unavailable',phase='early_live_unvalidated',diagnostics=None,reason='c2_phase_prior_postdraft_expired')
  self.guard();need(self.monotonic()-started<=self.config['maxProjectionSeconds'],'projection_wall_bound')
  return self.wrap(reader,now,status='retained_postdraft_diagnostic',phase='postdraft',diagnostics=copy.deepcopy(saved['value']['phaseDiagnostics']),
   retention={'contract':'c2_retained_beforeplay_forecast_not_live.v1','originalObservation':copy.deepcopy(saved['value']['currentObservation']),
    'originalComputedAt':saved['value']['computedAt'],'ageSeconds':age,'maxAgeSeconds':self.config['maxRetainedPostdraftAgeSeconds'],
    'newModelInference':False,'newFeatureProjection':False,'liveFitDomainSupported':False,'identityRevalidated':True})
 def status(self):return {'configured':True,'sourceManifestSha256':self.source,'kernelManifestSha256':PHASE_SHA,
  'totalsCDFRuntimeManifestSha256':self.modules.cdf_source_manifest if 'totalsCDF'in self.config else None,
  'configSha256':self.config_sha,'cachedBeforeplayMaps':len(self.saved),'maxCachedMaps':self.config['maxCachedMaps'],
  'zeroClockFullDraftDiagnostics':True,'negativeClockSourceSupported':True,'prematchSourceSupported':True,
  'prematchInformationCategory':'team_only_information_at_full_draft_negative_receipt_not_actual_earlier_predraft',
  'earlyLiveNewInference':False,'incompleteDraftSourceSupported':False,
  'cacheInstancesAdded':0,'automaticProviderPolling':False,'prediction':None,'modelHash':None,**FLAGS}

 def _unknown(self,mid):
  try:proof=self.outcomes.check(mid)
  except OutcomeGuardRefusal:raise Refusal('c2_phase_known_outcome_check_unavailable')from None
  need(type(proof)is dict and proof.get('contract')=='local_known_outcome_presence.v1'and proof.get('matchId')==mid and proof.get('readOnly')is True and proof.get('outcomeValueRead')is False and type(proof.get('known'))is bool,'known_outcome_check_unavailable')
  need(proof['known']is False,'map_outcome_already_known');return proof
 def project(self,reader,*,live_project):
  started=self.monotonic();now=local.wall(self.clock).isoformat();row,_,_=self.current(reader,now);mid=row['match_id'];saved=dict(self.saved)
  try:
   before=self._unknown(mid);value=self._project(reader,live_project=live_project);after=self._unknown(mid)
   self.guard();need(self.monotonic()-started<=self.config['maxProjectionSeconds'],'projection_wall_bound')
   return {**value,'knownOutcomeGuard':{'contract':'c2_phase_before_after_outcome_presence.v1','before':before,'after':after,
    'scope':'phase_heads_finished_or_live_projection_only','outcomeValuesInFeatures':False}}
  except BaseException:
   self.saved=saved;raise
 def finalize_live(self,reader,value):
  self.current(reader,local.wall(self.clock).isoformat());after=self._unknown(reader['current']['match_id'])
  need(0<=local.wall(self.clock).timestamp()-local.stamp(value['knownOutcomeGuard']['before']['checkedAt'])<=self.config['maxProjectionSeconds'],'projection_wall_bound')
  return {**value,'knownOutcomeGuard':{**value['knownOutcomeGuard'],'after':after,'scope':'live_heads_finished','outcomeValuesInFeatures':False}}
