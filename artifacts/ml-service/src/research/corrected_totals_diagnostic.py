"""Pinned historical-candidate diagnostics; no network, DB, fitting, or promotion.

Observed state only. The caller owns receipt/provenance and supplies computed_at.
Scores mean hero kills, while the historical corpus was endpoint-filtered. Neither
that filter nor model calibration proves current latency, completeness or quality.
"""
from __future__ import annotations
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import math
from typing import Any, Mapping
import lightgbm as lgb
import numpy as np
from src.research import corrected_live_totals_contract as features
from src.research import temporal_hero_kills as shared_kills

MANIFEST_SHA256='3005d07fc1eb6f86639d49aade2f60f5b8248f657bffde62af355ea3c9177d86'
ASSETS=Path(__file__).resolve().parent/'assets/corrected_live_totals_diagnostic_v1'
CONTRACT='corrected-totals-diagnostic-v1'
MAX_LINES=128
QUANTILES=(.05,.1,.25,.5,.75,.9,.95)
GATES=('eligibleForServing','eligibleForPromotion','eligibleForProspectiveEvaluation',
       'eligibleForQualityClaims','latencyValidated','calibrationQualityValidated',
       'exactPushValidated','interpolatedClockQualityValidated','jointDistributionValidated')


class ContractError(ValueError):
    pass


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def canonical_hash(value: Any) -> str:
    return sha(json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode())


def checked_asset(name: str, expected: str) -> bytes:
    if not isinstance(name,str) or Path(name).name!=name:
        raise ContractError('asset_name_not_allowed')
    path=(ASSETS/name).resolve()
    if path.parent!=ASSETS.resolve():raise ContractError('asset_path_not_allowed')
    raw=path.read_bytes()
    if sha(raw)!=expected:raise ContractError('asset_hash_mismatch:'+name)
    return raw


def _integer(value: Any, name: str, minimum=0) -> int:
    if type(value) is not int or not minimum<=value<=2**53-1:
        raise ContractError('invalid_'+name)
    return value


def _timestamp(value: Any) -> str:
    if not isinstance(value,str):raise ContractError('computed_at_required')
    try:stamp=datetime.fromisoformat(value.replace('Z','+00:00'))
    except ValueError as exc:raise ContractError('invalid_computed_at') from exc
    if stamp.tzinfo is None:raise ContractError('computed_at_timezone_required')
    return stamp.astimezone(timezone.utc).isoformat()


def observed_input(packet: Mapping[str,Any], expected_match_id: int) -> tuple[dict,np.ndarray]:
    if not isinstance(packet,Mapping):raise ContractError('observed_packet_required')
    match_id=_integer(packet.get('matchId'),'match_id',1)
    if match_id!=_integer(expected_match_id,'expected_match_id',1):raise ContractError('map_identity_mismatch')
    clock=_integer(packet.get('gameTimeSec'),'clock',1)
    if not 300<=clock<=4500:raise ContractError('clock_outside_300_4500_seconds')
    try:vector=features.features_from_observed(packet,variant='state_draft')
    except (ValueError,TypeError) as exc:raise ContractError(str(exc)) from exc
    players=sorted([{'heroId':p['heroId'],'team':p['team']} for p in packet['players']],key=lambda p:(p['team'],p['heroId']))
    state={'matchId':match_id,'gameTimeSec':clock,'radiantScore':packet['radiantScore'],
           'direScore':packet['direScore'],'players':players}
    return state,vector


class CorrectedTotalsDiagnostic:
    """Load pinned artifacts once, then calculate immutable per-observation results."""
    def __init__(self):
        manifest_raw=checked_asset('MANIFEST.json',MANIFEST_SHA256)
        self.manifest=json.loads(manifest_raw)
        m=self.manifest
        if m.get('contract')!=CONTRACT or m.get('scope')!='map' or any(m.get(k) is not False for k in GATES):
            raise ContractError('diagnostic_only_manifest_required')
        if m['quantiles']!=list(QUANTILES) or m['clockDomainSeconds']!=[300,4500]:
            raise ContractError('manifest_scope_mismatch')
        if sha(Path(features.__file__).read_bytes())!=m['featureSourceSha256']:
            raise ContractError('feature_source_hash_mismatch')
        if sha(Path(shared_kills.__file__).read_bytes())!=m['sharedHeroKillSha256']:
            raise ContractError('shared_source_hash_mismatch')
        self.names=json.loads(checked_asset(m['features']['file'],m['features']['sha256']))
        if self.names['draft1006']!=list(features.FEATURE_NAMES) or self.names['state6']!=list(features.STATE_NAMES):
            raise ContractError('feature_names_mismatch')
        self.calibration=json.loads(checked_asset(m['calibration']['file'],m['calibration']['sha256']))
        self.models={t:[] for t in ('kills','duration')};self.cdf_models={};self.domains={};self.model_hashes={}
        expected=[]
        for target in ('kills','duration'):
            expected.extend([(target,'quantile',q) for q in QUANTILES]);expected.append((target,'cdf',None))
        if [(a['target'],a['kind'],a.get('quantile')) for a in m['models']]!=expected:
            raise ContractError('artifact_count_or_order_mismatch')
        for a in m['models']:
            expected_name=f'q-{a["target"]}-draft1006-{a["quantile"]:.2f}.txt' if a['kind']=='quantile' else f'cdf-{a["target"]}-state6.txt'
            if a['file']!=expected_name:raise ContractError('artifact_filename_mismatch')
            model=lgb.Booster(model_str=checked_asset(a['file'],a['sha256']).decode('utf8'))
            names=self.names['draft1006'] if a['kind']=='quantile' else self.names['state6']+['remaining_line_threshold']
            if model.feature_name()!=names:raise ContractError('model_feature_order_mismatch')
            self.model_hashes[a['file']]=a['sha256']
            if a['kind']=='quantile':self.models[a['target']].append(model)
            else:self.cdf_models[a['target']]=model;self.domains[a['target']]=a['domain']
        for target in ('kills','duration'):
            c=self.calibration[target]
            if c['kind']!='isotonic':raise ContractError('expected_frozen_isotonic')
            x=np.asarray(c['x']);y=np.asarray(c['y'])
            if len(x)<2 or len(x)!=len(y) or not np.isfinite(x).all() or not np.isfinite(y).all() or np.any(np.diff(x)<=0) or np.any(np.diff(y)<0) or x.min()<0 or x.max()>1 or y.min()<0 or y.max()>1:
                raise ContractError('invalid_isotonic_map')

    def _cdf(self, target: str, vector: np.ndarray, thresholds: list[int]) -> tuple[np.ndarray,np.ndarray]:
        lower,upper=self.domains[target]
        if any(type(t) is not int for t in thresholds):raise ContractError('integer_residual_threshold_required')
        if any(t>upper for t in thresholds):raise ContractError('cdf_residual_support_exceeded')
        raw=np.zeros(len(thresholds),np.float64);calibrated=np.zeros(len(thresholds),np.float64)
        valid=np.asarray(thresholds)>=lower
        if valid.any():
            x=np.column_stack([np.repeat(vector[:6][None,:],int(valid.sum()),axis=0),np.asarray(thresholds)[valid]]).astype(np.float32)
            p=self.cdf_models[target].predict(x,num_threads=4)
            if not np.isfinite(p).all() or np.any(p<0) or np.any(p>1):raise ContractError('invalid_raw_cdf')
            raw[valid]=p;c=self.calibration[target];calibrated[valid]=np.interp(p,c['x'],c['y'])
        return raw,calibrated

    @staticmethod
    def _probabilities(at: float, before: float) -> dict:
        if not math.isfinite(at) or not math.isfinite(before) or not 0<=before<=at+1e-12<=1+1e-12:
            raise ContractError('invalid_cdf_probability_order')
        return {'pUnder':before,'pPush':max(0.,at-before),'pOver':1.-at}

    def line_diagnostic(self, specification: Any, state: dict, vector: np.ndarray) -> dict:
        """Final-total supplied lines; unsupported lines keep null probabilities."""
        base={'available':False,'raw':None,'calibrated':None,'diagnosticOnly':True,'exactPushValidated':False,'eligibleForServing':False}
        if not isinstance(specification,Mapping):return {**base,'reason':'line_object_required'}
        target=specification.get('target');line=specification.get('line')
        safe_line=line if type(line) in (int,float) and -2**53+1<=line<=2**53-1 and math.isfinite(line) else None
        base.update({'target':target if isinstance(target,str) else None,'line':safe_line})
        if target not in ('kills','duration'):return {**base,'reason':'unknown_line_target'}
        if safe_line is None or line<0 or line>2**53-1:return {**base,'reason':'nonnegative_finite_line_required'}
        if target=='kills':
            if specification.get('unit')!='kills':return {**base,'reason':'kills_unit_required'}
            if line*2!=math.floor(line*2):return {**base,'reason':'asian_quarter_or_nonhalf_kill_line_unsupported'}
            current=state['radiantScore']+state['direScore'];residual=line-current
            if residual<0:return {**base,'reason':'line_already_below_observed_total','unit':'kills'}
        else:
            if specification.get('unit')!='seconds' or specification.get('settlement')!='exact_seconds':
                return {**base,'reason':'explicit_exact_integer_second_settlement_required'}
            if line!=math.floor(line):return {**base,'reason':'integer_second_line_required'}
            current=state['gameTimeSec'];residual=line-current
            if residual<1:return {**base,'reason':'line_already_reached_while_ongoing','unit':'seconds'}
        at=math.floor(residual);before=math.ceil(residual)-1
        if max(at,before)>self.domains[target][1]:return {**base,'reason':'cdf_residual_support_exceeded','residualLine':residual}
        raw,calibrated=self._cdf(target,vector,[int(at),int(before)])
        return {**base,'available':True,'reason':None,'unit':'kills' if target=='kills' else 'seconds',
                'residualLine':residual,'residualThresholdAt':at,'residualThresholdBelow':before,
                'raw':self._probabilities(float(raw[0]),float(raw[1])),
                'calibrated':self._probabilities(float(calibrated[0]),float(calibrated[1])),
                'calibrationQualityValidated':False,'probabilitiesArePublic':False,
                'head':'state6_threshold_cdf','jointDistributionValidated':False,
                'thresholdFeatureNames':self.names['state6']+['remaining_line_threshold'],
                'thresholdFeatureVectors':[(vector[:6].tolist()+[int(t)]) for t in (at,before)],
                'thresholdModelEvaluated':[t>=self.domains[target][0] for t in (at,before)]}

    def predict(self, packet: Mapping[str,Any], *, expected_match_id: int, computed_at: str,
                lines: list[Mapping[str,Any]] | None=None) -> dict:
        stamp=_timestamp(computed_at);state,vector=observed_input(packet,expected_match_id)
        if lines is not None and not isinstance(lines,list):raise ContractError('lines_array_required')
        if lines is not None and len(lines)>MAX_LINES:raise ContractError('at_most_128_lines_required')
        current_kills=state['radiantScore']+state['direScore'];clock=state['gameTimeSec']
        quantities={}
        for target in ('kills','duration'):
            raw=np.array([m.predict(vector[None,:],num_threads=4)[0] for m in self.models[target]],float)
            if not np.isfinite(raw).all():raise ContractError('nonfinite_quantile_prediction')
            floor=0 if target=='kills' else 1/60
            ordered=np.sort(np.maximum(raw,floor))
            item={'quantileLevels':list(QUANTILES),'modelOutputUnit':'kills' if target=='kills' else 'minutes',
                  'rawRemaining':raw.tolist(),'orderedBoundedRemaining':ordered.tolist(),
                  'rawCrossing':bool(np.any(np.diff(raw)<0)),'rawBelowSupport':bool(np.any(raw<floor)),
                  'coverageCalibrated':False,'head':'draft1006_remaining_quantiles','jointDistributionValidated':False}
            if target=='kills':item['finalKills']=(current_kills+ordered).tolist()
            else:item.update({'remainingSeconds':(ordered*60).tolist(),'finalSeconds':(clock+ordered*60).tolist(),'finalMinutes':(clock/60+ordered).tolist()})
            quantities[target]=item
        out={'contract':CONTRACT,'available':True,'scope':'map','matchId':state['matchId'],'computedAt':stamp,
             'diagnosticOnly':True,'active':False,**{key:False for key in GATES},
             'observedInput':state,'observedInputSha256':canonical_hash(state),
             'featureContract':features.VERSION,'featureNames':self.names['draft1006'],
             'featureVector':vector.tolist(),'featureVectorDtype':'little-endian-float32',
             'featureVectorSha256':sha(np.asarray(vector,dtype='<f4').tobytes()),
             'stateFeatureNames':self.names['state6'],'stateFeatureVector':vector[:6].tolist(),
             'stateFeatureVectorSha256':sha(np.asarray(vector[:6],dtype='<f4').tobytes()),
             'independentHeads':dict(self.manifest['independentHeads']),
             'manifestSha256':MANIFEST_SHA256,'modelSha256':dict(self.model_hashes),
             'calibrationSha256':self.manifest['calibration']['sha256'],
             'clockOnTrainingCheckpoint':clock%300==0,'intermediateScoreCompletenessVerified':False,
             'originalLiveReceiptVerified':False,'quantiles':quantities,
             'lineDiagnostics':[self.line_diagnostic(spec,state,vector) for spec in (lines or [])],
             'publicProbabilities':None,'limitations':list(self.manifest['limitations'])}
        out['responseSha256']=canonical_hash(out)
        return out
