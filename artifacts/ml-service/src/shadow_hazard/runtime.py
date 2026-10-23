"""Strict receipt envelope; distribution and feature mathematics remain frozen.

sourceInputHash is the collector's canonical-JS provenance hash, not recomputed
with an incompatible JSON canonicalization. The router binds exact request bytes;
the dispatcher verifies that hash against its durable observation before calling.
The consumed-state hash/vector are computed independently by the pinned adapter.
"""
from __future__ import annotations
from datetime import datetime,timezone
from pathlib import Path
import hashlib,json,threading
from . import pins
from .resource import guard as resource_guard,ResourceLimit

class Refusal(ValueError):pass
def utcnow():return datetime.now(timezone.utc)
def stamp(value):
    try:
        if not isinstance(value,str):raise ValueError()
        t=datetime.fromisoformat(value.replace('Z','+00:00'))
        if t.tzinfo is None:raise ValueError()
        return t.timestamp()
    except (ValueError,TypeError,OverflowError,OSError):raise Refusal('invalid_observation_time')
def sha(value):return hashlib.sha256(value).hexdigest()
def hex64(value):return isinstance(value,str) and len(value)==64 and all(c in '0123456789abcdef' for c in value)
def bounded(path,limit=2*1024*1024):
    if path.is_symlink() or path.stat().st_size>limit:raise ValueError('unsafe_pinned_source')
    raw=path.read_bytes()
    if len(raw)>limit:raise ValueError('oversized_pinned_source')
    return raw
def verify_packages(package_root=None,research_root=None):
    own=Path(package_root) if package_root else Path(__file__).resolve().parent
    raw=bounded(own/'runtime-manifest.json');manifest=json.loads(raw)
    if manifest.get('contract')!=pins.CONTRACT:raise ValueError('runtime_contract_mismatch')
    for name,expected in manifest['files'].items():
        if Path(name).name!=name or sha(bounded(own/name))!=expected:raise ValueError('runtime_source_pin_mismatch')
    research=Path(research_root) if research_root else own.parent/'research'
    for name,expected in pins.RESEARCH_SOURCES.items():
        if sha(bounded(research/name))!=expected:raise ValueError('research_source_pin_mismatch')
    if sha(bounded(research/'assets/hazard_totals_diagnostic_v1/MANIFEST.json'))!=pins.FEATURE_BUNDLE_SHA256:
        raise ValueError('feature_bundle_pin_mismatch')
    return sha(raw)

def checked_observation(body,now):
    c=body['current'];p=c['input'];availability=c['availability']
    dispatch=body.get('outcomeKnownAtDispatch');capture=availability.get('outcomeKnownAtCapture')
    if dispatch is True or capture is True:raise Refusal('outcome_already_known')
    if dispatch is not False or capture is not False:raise Refusal('outcome_availability_unknown')
    if c.get('source')!='opendota' or c.get('targetScope')!='map' or c.get('clockUnit')!='seconds':raise Refusal('observed_source_contract_required')
    if c.get('sourceSchemaHash')!=pins.OBSERVATION_SCHEMA_HASH:raise Refusal('source_schema_mismatch')
    if not hex64(c.get('sourceInputHash')) or not hex64(c.get('observationId')):raise Refusal('source_hash_required')
    for part in (c,p,availability):
        if (part.get('synthetic') is True or part.get('backfill') is True or part.get('reconstructed') is True
                or part.get('source') in ('synthetic','backfill','reconstructed')):raise Refusal('synthetic_or_backfill_observation')
    received=stamp(c.get('receivedAt'));recorded=stamp(c.get('recordedAt'));current=now.timestamp()
    if received>recorded or recorded>current:raise Refusal('future_or_inverted_observation_time')
    if current-received>=180:raise Refusal('observation_stale')
    expected=body.get('expectedMatchId');match=p.get('matchId')
    if type(expected) is not int or not 0<expected<=2**53-1 or type(match) is not int or match!=expected:raise Refusal('map_identity_mismatch')
    if c.get('phase')!='live':raise Refusal('ongoing_live_phase_required')
    clock=p.get('gameTimeSec')
    if type(clock) is not int or not 300<=clock<=4500:raise Refusal('clock_outside_300_4500_seconds')
    for key,reason in [('radiantScore','radiant_score_required'),('direScore','dire_score_required')]:
        if type(p.get(key)) is not int or not 0<=p[key]<=2**53-1:raise Refusal(reason)
    if body.get('lineSource')!='own_diagnostic_grid':raise Refusal('own_diagnostic_grid_required')
    if not isinstance(body.get('lines'),list) or len(body['lines'])>128:raise Refusal('at_most_128_lines_required')
    if availability.get('draftComplete') is not True:raise Refusal('observed_complete_draft_required')
    players=p.get('players')
    if not isinstance(players,list) or len(players)!=10 or any(not isinstance(v,dict) for v in players):raise Refusal('draft_incomplete')
    heroes=[v.get('heroId') for v in players];sides=[v.get('team') for v in players]
    if any(type(v) is not int or not 1<=v<=250 for v in heroes) or len(set(heroes))!=10:raise Refusal('draft_hero_identity_invalid')
    if any(type(v) is not int or v not in (0,1) for v in sides) or sides.count(0)!=5:raise Refusal('draft_sides_invalid')
    # Only observed scores/clock and complete draft reach the frozen rich model.
    # Historical model selection remains state6; expanded is the owner's choice.
    return {'matchId':match,'phase':'live','gameTimeSec':clock,'radiantScore':p['radiantScore'],'direScore':p['direScore'],
            'players':[{'heroId':v['heroId'],'team':v['team']} for v in players]}

def make_model():
    from src.research.hazard_totals_diagnostic import HazardTotalsDiagnostic
    return HazardTotalsDiagnostic()

class HazardRuntime:
    def __init__(self,*,loader=make_model,verifier=verify_packages,guard=resource_guard,now=utcnow,declared_manifest_hash=None):
        self._loader=loader;self._verifier=verifier;self._guard=guard;self._now=now
        self._gate=threading.BoundedSemaphore(1);self._model=None;self._state='cold'
        if declared_manifest_hash is None:
            try:declared_manifest_hash=sha(bounded(Path(__file__).with_name('runtime-manifest.json')))
            except Exception:declared_manifest_hash=None
        self._package_hash=declared_manifest_hash
    def status(self):
        return {'state':self._state,'contract':pins.CONTRACT,'candidateId':pins.CANDIDATE_ID,
                'packageManifestSha256':self._package_hash,'active':False,'eligibleForServing':False}
    def _base(self,body):
        c=body['current']
        return {'contract':pins.CONTRACT,'candidateId':pins.CANDIDATE_ID,'packageManifestSha256':self._package_hash,
            'featureBundleSha256':pins.FEATURE_BUNDLE_SHA256,'calibrationSha256':pins.CALIBRATION_SHA256,
            'featureSchemaHash':pins.FEATURE_SCHEMA_HASH,
            'modelHashes':dict(pins.MODEL_HASHES),'featureNames':list(pins.FEATURE_NAMES),
            'executionMode':'runtime_shadow','target':'map_live_totals','targetScope':'map','phase':'live',
            'candidateOrigin':'user_requested_expanded','selectedByValidation':False,
            'observationId':c['observationId'],'matchId':body['expectedMatchId'],'receivedAt':c['receivedAt'],
            'recordedAt':c['recordedAt'],'computedAt':self._now().astimezone(timezone.utc).isoformat(),
            'sourceInputHash':c['sourceInputHash'],'sourceSchemaHash':c['sourceSchemaHash'],
            'lineSource':'own_diagnostic_grid','status':'unavailable','reason':None,'diagnostic':None,
            'active':False,'eligibleForServing':False,'eligibleForPromotion':False,'eligibleForQualityClaims':False,
            'eligibleForProspectiveEvaluation':False,'prospectiveValidated':False,'eventLatencyVerified':False,
            'meetsVerifiedLiveLatencyPolicy':False,'coverage95Validated':False,'measuredEndToEndLatencySeconds':None}
    def predict(self,body):
        try:packet=checked_observation(body,self._now())
        except Refusal as error:return {**self._base(body),'reason':str(error)}
        if not self._gate.acquire(blocking=False):return {**self._base(body),'reason':'hazard_busy'}
        try:
            self._guard()
            try:
                if self._verifier()!=self._package_hash:raise ValueError()
                if self._model is None:
                    model=self._loader()
                    if model.manifest['selectedVariants']!={'kills':'state6','duration':'state6'}:raise ValueError()
                    if any(model.meta[f'{target}-draft1006']['sha256']!=digest for target,digest in pins.MODEL_HASHES.items()):raise ValueError()
                    self._model=model
                self._state='ready'
            except Exception:
                self._state='failed';return {**self._base(body),'reason':'hazard_package_unavailable'}
            # Explicit expanded selection; never fall back to the state6 comparator.
            diagnostic=self._model.predict(packet,expected_match_id=body['expectedMatchId'],computed_at=self._now().isoformat(),variant='draft1006',lines=body['lines'])
            self._guard()
            if self._now().timestamp()-stamp(body['current']['receivedAt'])>=180:
                return {**self._base(body),'reason':'observation_stale_at_completion'}
            return {**self._base(body),'status':'shadow_predicted','diagnostic':diagnostic}
        except ResourceLimit:return {**self._base(body),'reason':'hazard_resource_unavailable'}
        except Exception:return {**self._base(body),'reason':'hazard_inference_unavailable'}
        finally:self._gate.release()
