"""Build 7148 prior state ONLY from one immutable, pinned pre-receipt snapshot.

The full streaming path is implemented; this staging task tests TWO rows only.
Old prior match profiles retain end+300 reconstruction, never original receipts.
"""
from __future__ import annotations
import hashlib,json
from pathlib import Path
from collections import Counter
from .lineage import Refusal,sha,parse,objhash,identity,integer,stamp
from .sources import HERE,bounded,verify_sources,wall,utcnow,seconds
from ..postdraft_full.builder import project_prior,validate_receipt
from ..postdraft_full.wide_history import WideHistoryAccumulator,WideSchema,project_wide_history
from ..postdraft_input_contract import ContractError

_FACTORY=object()
class PriorCache:
 """Private factory-owned state. No caller-supplied vectors or update API."""
 def __init__(self,token,state,proof,raw_ids):
  if token is not _FACTORY:raise Refusal('snapshot_factory_required')
  self.__state=state;self.__proof=json.dumps(proof,sort_keys=True);self.__schema=WideSchema.load(HERE);self.__raw_ids=frozenset(raw_ids)
 @property
 def proof(self):return json.loads(self.__proof)
 def project(self,row):
  p=self.proof;receipt=stamp(row['received_at'])/1000
  if verify_sources()!=p['builderBundleSha256']:raise Refusal('cache_builder_changed')
  if not seconds(p['snapshotCutoff'])<=seconds(p['capturedAt'])<=seconds(p['cacheBuiltAt'])<=receipt:raise Refusal('cache_not_available_before_draft')
  if receipt-seconds(p['snapshotCutoff'])>86400 or receipt-seconds(p['cacheBuiltAt'])>86400:raise Refusal('cache_older_than_24h')
  if row['match_id'] in self.__raw_ids:raise Refusal('target_current_map_in_snapshot')
  ident=identity(row)
  if ident is None:raise Refusal('complete_draft_identity_required')
  m={'match_id':row['match_id'],'start_time':receipt,'radiant_team_id':ident[0],'dire_team_id':ident[1],
     'series_id':None,'series_type':None,'league_id':None}
  for side,index in [('radiant',0),('dire',1)]:
   pp=[(h,a) for s,h,a in ident[2] if s==index]
   m[side+'_picks']=[h for h,a in pp];m[side+'_account_ids']=[a for h,a in pp]
  return project_wide_history(self.__state,m,self.__schema),p

def build_cache(directory,expected_manifest_sha256,*,guard=lambda:None,clock=utcnow):
 """Trusted startup configuration only; never an HTTP request-selected path."""
 bundle=verify_sources();guard();directory=Path(directory)
 if directory.is_symlink() or not directory.is_dir():raise Refusal('snapshot_directory')
 raw=bounded(directory/'MANIFEST.json',1000000)
 if sha(raw)!=expected_manifest_sha256:raise Refusal('snapshot_manifest_pin')
 manifest=parse(raw);now=seconds(wall(clock));cutoff=seconds(manifest.get('snapshotCutoff'));captured=seconds(manifest.get('capturedAt'))
 if manifest.get('contract')!='startup_postdraft_history_snapshot_v1' or manifest.get('readOnly') is not True or manifest.get('originalHistoricalReceiptProven') is not False or manifest.get('mapsFile')!='maps.jsonl':raise Refusal('snapshot_contract')
 if not cutoff<=captured<=now or now-cutoff>86400:raise Refusal('snapshot_future_or_stale')
 n=manifest.get('counts',{}).get('rows');size=manifest.get('mapsBytes')
 if not integer(n,1) or n>50000 or not integer(size,1) or size>512*1024*1024:raise Refusal('snapshot_declared_bound')
 ref=bounded(directory/'hero-reference.json',2000000)
 if sha(ref)!=manifest.get('referenceSha256'):raise Refusal('reference_pin')
 heroes=parse(ref).get('payload');mapping={}
 if not isinstance(heroes,list) or not heroes:raise Refusal('reference_shape')
 for h in heroes:
  if not isinstance(h,dict) or not integer(h.get('id'),1) or not isinstance(h.get('name'),str) or h['id'] in mapping:raise Refusal('reference_identity')
  mapping[h['id']]=h['name']
 path=directory/'maps.jsonl'
 if path.is_symlink() or path.stat().st_size!=size:raise Refusal('snapshot_size_or_path')
 state=WideHistoryAccumulator();hashes=hashlib.sha256();count=0;consumed=0;stats=Counter();latest=0;raw_ids=set()
 with path.open('rb') as stream:
  while True:
   line=stream.readline(2*1024*1024+1)
   if not line:break
   count+=1;consumed+=len(line)
   if count>n or len(line)>2*1024*1024 or consumed>size:raise Refusal('snapshot_stream_bound')
   if count%100==1:guard()
   hashes.update(line);row=parse(line)
   if not isinstance(row,dict) or not integer(row.get('match_id'),1):raise Refusal('prior_row_identity')
   if row['match_id'] in raw_ids:raise Refusal('duplicate_snapshot_map')
   raw_ids.add(row['match_id'])
   validate_receipt(row,cutoff)
   try:m,minima,status=project_prior(row,mapping)
   except ContractError as error:
    if str(error)!='invalid_prior_outcome_or_identity':raise
    stats['excluded_invalid_map']+=1;continue
   state.before(m);state.queue(m,minima);stats['appliedMaps']+=1
   latest=max(latest,m['start_time']+m['duration']+300)
 state.advance(cutoff);guard()
 if count!=n or consumed!=size or hashes.hexdigest()!=manifest.get('mapsSha256') or state.pending:raise Refusal('snapshot_consumed_pin')
 if not state.applied:raise Refusal('empty_usable_snapshot')
 built=wall(clock)
 if not captured<=seconds(built) or seconds(built)-cutoff>86400:raise Refusal('cache_build_clock')
 proof={'contract':'wide7148_immutable_snapshot_cache_v1','builderBundleSha256':bundle,
  'snapshotManifestSha256':sha(raw),'rawSnapshotSha256':hashes.hexdigest(),'referenceSha256':sha(ref),
  'snapshotCutoff':manifest['snapshotCutoff'],'capturedAt':manifest['capturedAt'],'cacheBuiltAt':built,
  'consumedRows':count,'consumedBytes':consumed,'appliedMaps':state.applied,
  'latestPriorReconstructedAvailableAt':latest,'priorProfileTimePolicy':'historical_end_plus_300_reconstruction',
  'originalHistoricalReceiptProven':False,'currentMapExcludedAtAnchor':None}
 return PriorCache(_FACTORY,state,proof,raw_ids)
