"""Immutable once-per-map draft anchor. Atomic no-overwrite local persistence.

This stores a prior computed from the verified snapshot factory, not a supplied
vector. File integrity is not proof of DB origin: only a trusted committed-row
reader may call this module. No endpoint, model, DB or provider dependency.
"""
from __future__ import annotations
import os,tempfile
from pathlib import Path
from .lineage import Refusal,verify,identity,integer,stamp,canonical,objhash,SCHEMA
from .sources import HERE,bounded,verify_sources,seconds,wall,utcnow,encoded,decoded,parse
from .cache import PriorCache
from ..postdraft_full.wide_history import WideSchema
from .provenance import validate as validate_provenance

CONTRACT='observed_draft7148_immutable_anchor_v1'

def check_current(row,*,capture_outcome_known,outcome_known_at_read,now,early=False):
 received,recorded=verify(row);now_sec=seconds(now)
 if capture_outcome_known is not False or outcome_known_at_read is not False:raise Refusal('outcome_unknown_or_known')
 if not isinstance(row.get('availability'),dict) or row['availability'].get('outcomeKnownAtCapture') is not False:raise Refusal('capture_outcome_binding')
 if recorded/1000>now_sec or not 0<=now_sec-received/1000<=180:raise Refusal('current_receipt_future_or_stale')
 clock=row['game_time_sec']
 if not integer(clock,-3600) or (early and clock>=60) or (not early and clock<300):raise Refusal('unsupported_projection_phase')
 if row.get('phase')!=('post_draft' if clock<0 else 'live'):raise Refusal('phase_mismatch')
 ident=identity(row)
 if ident is None or any(h>250 or a>=4294967295 for _,h,a in ident[2]):raise Refusal('full_supported_draft_required')
 return ident

def observation(row):
 return {k:row[k] for k in ('id','match_id','game_time_sec','input_hash','schema_hash','input','canonicalInputJson','received_at','recorded_at','phase','availability')}

def _unsafe(path):
 return path.is_symlink() or (hasattr(path,'is_junction') and path.is_junction())

class AnchorStore:
 def __init__(self,directory):
  raw=Path(directory)
  if not raw.is_absolute() or any(_unsafe(p) for p in (raw,*raw.parents)):raise Refusal('anchor_directory_not_trusted')
  raw.mkdir(parents=True,exist_ok=True);self.__directory=raw.resolve(strict=True)
 def _path(self,match_id):
  if not integer(match_id,1):raise Refusal('anchor_map_id')
  return self.__directory/(str(match_id)+'.json')
 def load(self,match_id):
  path=self._path(match_id)
  if not path.exists():raise Refusal('prior_anchor_missing')
  a=parse(bounded(path,1024*1024))
  if not isinstance(a,dict):raise Refusal('anchor_object')
  check=dict(a);digest=check.pop('anchorSha256',None)
  if objhash(check)!=digest or a.get('contract')!=CONTRACT or a.get('matchId')!=match_id:raise Refusal('anchor_integrity')
  if a.get('builderBundleSha256')!=verify_sources() or a.get('sourceSchemaSha256')!=SCHEMA:raise Refusal('anchor_builder_or_schema_changed')
  schema=WideSchema.load(HERE)
  if a.get('priorFeatureNamesSha256')!=objhash(schema.names):raise Refusal('anchor_feature_order')
  decoded(a.get('prior7148'),7148);source=a.get('anchorObservation');verify(source)
  if a.get('identity')!=identity(source) or a.get('identitySha256')!=objhash(a.get('identity')) or source['match_id']!=match_id:raise Refusal('anchor_identity_binding')
  if a.get('featureAsOf')!=source['received_at'] or a.get('actualGameStart') is not None:raise Refusal('anchor_time_semantics')
  if not integer(source['game_time_sec'],-3600) or source['game_time_sec']>=60 or identity(source) is None:raise Refusal('anchor_early_draft_required')
  if source.get('phase')!=('post_draft' if source['game_time_sec']<0 else 'live'):raise Refusal('anchor_phase_binding')
  p=a.get('snapshotProof',{});asof=stamp(a['featureAsOf'])/1000
  if p.get('builderBundleSha256')!=a['builderBundleSha256'] or p.get('currentMapExcludedAtAnchor') is not True or p.get('originalHistoricalReceiptProven') is not False:raise Refusal('anchor_snapshot_proof')
  if not seconds(p['snapshotCutoff'])<=seconds(p['capturedAt'])<=seconds(p['cacheBuiltAt'])<=asof<=seconds(a['priorComputedAt']):raise Refusal('anchor_causal_order')
  if asof-seconds(p['snapshotCutoff'])>86400 or p['latestPriorReconstructedAvailableAt']>=asof:raise Refusal('anchor_prior_cutoff')
  if a.get('captureOutcomeKnown') is not False or a.get('outcomeKnownAtRead') is not False or source.get('availability',{}).get('outcomeKnownAtCapture') is not False:raise Refusal('anchor_outcome_binding')
  validate_provenance(a.get('readerProvenance'),source,a['priorComputedAt'])
  if a.get('eligibleForServing') is not False:raise Refusal('anchor_serving_forbidden')
  return a
 def get_or_create(self,row,cache,*,capture_outcome_known,outcome_known_at_read,reader_provenance,clock=utcnow):
  now=wall(clock);ident=check_current(row,capture_outcome_known=capture_outcome_known,outcome_known_at_read=outcome_known_at_read,now=now,early=True)
  origin=validate_provenance(reader_provenance,row,now)
  # Existing anchors are loaded before inspecting ANY refreshed cache.
  path=self._path(row['match_id'])
  if path.exists():
   a=self.load(row['match_id'])
   if a['identity']!=ident:raise Refusal('anchor_roster_or_side_changed')
   if stamp(row['received_at'])<stamp(a['featureAsOf']):raise Refusal('observation_before_anchor')
   return a
  if type(cache) is not PriorCache:raise Refusal('snapshot_factory_required')
  vector,proof=cache.project(row);computed=wall(clock)
  # Completion after a long calculation cannot silently preserve the old gate.
  check_current(row,capture_outcome_known=capture_outcome_known,outcome_known_at_read=outcome_known_at_read,now=computed,early=True)
  proof['currentMapExcludedAtAnchor']=True
  a={'contract':CONTRACT,'matchId':row['match_id'],'identity':ident,'identitySha256':objhash(ident),
    'sourceSchemaSha256':SCHEMA,'builderBundleSha256':verify_sources(),
    'priorFeatureNamesSha256':objhash(WideSchema.load(HERE).names),'prior7148':encoded(vector),
    'anchorObservation':observation(row),'featureAsOf':row['received_at'],'actualGameStart':None,
    'priorComputedAt':computed,'snapshotProof':proof,'captureOutcomeKnown':False,'outcomeKnownAtRead':False,'readerProvenance':origin,
    'seriesContextStatus':'unobserved_frozen_unknown_defaults','eligibleForServing':False,
    'sourceOrigin':'trusted_reader_required_hashes_do_not_prove_database_origin'}
  a['anchorSha256']=objhash(a);raw=canonical(a)
  if len(raw)>1024*1024:raise Refusal('anchor_file_bound')
  # Exclusive creation via hard link publishes a complete fsynced file. A
  # concurrent writer cannot overwrite it. No fallback to replace()/rename().
  fd,temp=tempfile.mkstemp(prefix='.anchor-',suffix='.tmp',dir=self.__directory)
  try:
   with os.fdopen(fd,'wb') as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
   try:os.link(temp,path)
   except FileExistsError:pass
  finally:
   os.unlink(temp)
  saved=self.load(row['match_id'])
  if saved['identity']!=ident:raise Refusal('concurrent_anchor_identity_conflict')
  if stamp(row['received_at'])<stamp(saved['featureAsOf']):raise Refusal('concurrent_anchor_from_later_observation')
  return saved

def capture_anchor(reader,store,cache,*,clock=utcnow):
 """Entry point for a future genuine early-draft reader result; no trajectory."""
 if not isinstance(reader,dict) or reader.get('queryTruncated') is not False or not isinstance(store,AnchorStore):raise Refusal('anchor_reader_required')
 return store.get_or_create(reader.get('current'),cache,capture_outcome_known=reader.get('captureOutcomeKnown'),
  outcome_known_at_read=reader.get('outcomeKnownAtRead'),reader_provenance=reader.get('provenance'),clock=clock)
