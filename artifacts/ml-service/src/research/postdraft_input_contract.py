"""Observed post-draft INPUT gate, deliberately not an inference route.

This v1 input-only diagnostic reproduces draft columns and validates source
availability. It intentionally leaves history columns unresolved. The separate
postdraft_full.builder now implements the full causal history feature path;
partial vectors from THIS module must NEVER be passed to LightGBM as missing.
Its original frozen v1 assets describe only the earlier input-only phase.
No DB, provider, training, active-model or router imports.
"""
from __future__ import annotations
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import TypedDict, Literal
from collections import Counter
from itertools import combinations
import hashlib
import json
import math
import re

CONTRACT = 'observed_postdraft_input_gate_v1'
MANIFEST_SHA256 = '2fbc3926ebd06a2ee090012db1a34750e0da376c7df1357c30ddc9ceac5053f4'
MODEL_SHA256 = '3b6c45e0d25dddeb4fbfbca899858cca21c0994c8b6caddc6f3931951007d968'
ASSETS = Path(__file__).resolve().parent/'assets/postdraft_corrected_c_diagnostic_v1'
MAX_HISTORY = 50_000

class ContractError(ValueError):
    pass

class DraftPlayer(TypedDict):
    team: Literal[0, 1]
    heroId: int
    accountId: int | None

class DraftInput(TypedDict):
    matchId: int
    radiantTeamId: int
    direTeamId: int
    gameTimeSec: int
    players: list[DraftPlayer]

class ObservationEnvelope(TypedDict):
    observationId: str
    source: Literal['opendota']
    targetScope: Literal['map']
    clockUnit: Literal['seconds']
    receivedAt: str
    recordedAt: str
    phase: Literal['post_draft', 'live']
    availability: dict
    input: DraftInput

class HistoryVersion(TypedDict):
    matchId: int
    versionId: str
    basis: Literal['observed_payload_version', 'startup_frozen_snapshot']
    capturedAt: str
    receivedAt: str | None
    payloadSha256: str
    payload: dict

@dataclass(frozen=True)
class ObservedDraft:
    observation_id: str
    match_id: int
    radiant_team_id: int
    dire_team_id: int
    game_time_sec: int
    received_at: float
    recorded_at: float
    players: tuple[tuple[int, int, int | None], ...]
    roster_complete: bool

def canonical_hash(value) -> str:
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode('utf8')).hexdigest()

def timestamp(value) -> float:
    if not isinstance(value,str):raise ContractError('timezone_aware_timestamp_required')
    try:parsed=datetime.fromisoformat(value.replace('Z','+00:00'))
    except ValueError as exc:raise ContractError('invalid_timestamp') from exc
    if parsed.tzinfo is None:raise ContractError('timezone_required')
    return parsed.timestamp()

def integer(value,name,minimum=1,maximum=2**53-1):
    if type(value) is not int or not minimum<=value<=maximum:raise ContractError('invalid_'+name)
    return value

def phase_selection(clock: int, draft_complete: bool) -> dict:
    integer(clock,'game_clock',-3600,10800)
    if type(draft_complete) is not bool:raise ContractError('draft_completeness_required')
    if not draft_complete:return {'phase':'draft_collecting','route':None,'reason':'complete_observed_draft_required'}
    if clock<60:return {'phase':'post_draft' if clock<0 else 'early_live_draft_context','route':'postdraft_input_diagnostic','reason':None}
    if clock<300:return {'phase':'live','route':None,'reason':'60_to_299_live_support_unvalidated'}
    if clock<=4772:return {'phase':'live','route':'existing_observed_live_diagnostic','reason':None}
    return {'phase':'late_live','route':None,'reason':'later_live_candidate_support_unvalidated'}

def normalize_observation(envelope: ObservationEnvelope, *, now: str) -> ObservedDraft:
    if not isinstance(envelope,dict):raise ContractError('observation_required')
    for key,value in [('source','opendota'),('targetScope','map'),('clockUnit','seconds')]:
        if envelope.get(key)!=value:raise ContractError('source_scope_or_units_mismatch')
    oid=envelope.get('observationId')
    if not isinstance(oid,str) or not re.fullmatch('[0-9a-f]{64}',oid):raise ContractError('durable_observation_id_required')
    received=timestamp(envelope.get('receivedAt'));recorded=timestamp(envelope.get('recordedAt'));current=timestamp(now)
    if received>recorded or recorded>current or current-received>=180:raise ContractError('future_or_stale_observation')
    available=envelope.get('availability') or {}
    if available.get('outcomeKnownAtCapture') is not False:raise ContractError('outcome_absence_must_be_checked')
    if available.get('draftComplete') is not True:raise ContractError('draft_not_observed_complete')
    packet=envelope.get('input')
    if not isinstance(packet,dict):raise ContractError('input_required')
    for part in (envelope,packet):
        if part.get('synthetic') is True or part.get('backfill') is True or part.get('betweenMaps') is True:raise ContractError('noncurrent_observation')
    mid=integer(packet.get('matchId'),'match_id');r=integer(packet.get('radiantTeamId'),'radiant_team');d=integer(packet.get('direTeamId'),'dire_team')
    if r==d:raise ContractError('same_team_on_both_sides')
    clock=integer(packet.get('gameTimeSec'),'game_clock',-3600,10800)
    if envelope.get('phase')!=('post_draft' if clock<0 else 'live'):raise ContractError('observation_phase_mismatch')
    players=packet.get('players')
    if not isinstance(players,list) or len(players)!=10:raise ContractError('ten_observed_players_required')
    normalized=[]
    for player in players:
        if not isinstance(player,dict):raise ContractError('invalid_player')
        side=integer(player.get('team'),'side',0,1);hero=integer(player.get('heroId'),'hero',1,999)
        account=player.get('accountId')
        if account is not None:integer(account,'account',1,4294967294)
        normalized.append((side,hero,account))
    if sum(p[0]==0 for p in normalized)!=5 or len({p[1] for p in normalized})!=10:raise ContractError('invalid_5v5_hero_identity')
    known=[p[2] for p in normalized if p[2] is not None]
    if len(set(known))!=len(known):raise ContractError('duplicate_player_identity')
    normalized.sort(key=lambda p:(p[0],p[1]))
    return ObservedDraft(oid,mid,r,d,clock,received,recorded,tuple(normalized),len(known)==10)

def verified_package(root: Path=ASSETS) -> tuple[dict,dict]:
    raw=(root/'MANIFEST.json').read_bytes()
    if hashlib.sha256(raw).hexdigest()!=MANIFEST_SHA256:raise ContractError('manifest_hash_mismatch')
    manifest=json.loads(raw)
    if manifest['contract']!=CONTRACT or manifest['files']['C_corrected_fixed80.model.txt']!=MODEL_SHA256:raise ContractError('candidate_mismatch')
    for name,expected in manifest['files'].items():
        if name not in ('C_corrected_fixed80.model.txt','FEATURE-SCHEMA.json','TRAIN-GOLDENS.json'):raise ContractError('unlisted_asset')
        if hashlib.sha256((root/name).read_bytes()).hexdigest()!=expected:raise ContractError('asset_hash_mismatch:'+name)
    schema=json.loads((root/'FEATURE-SCHEMA.json').read_text(encoding='utf8'))
    if len(schema['featureNames'])!=6668 or len(set(schema['featureNames']))!=6668:raise ContractError('feature_schema_mismatch')
    return manifest,schema

def draft_columns(observation: ObservedDraft, schema: dict) -> dict[str,float]:
    picks=[[hero for team,hero,_ in observation.players if team==side] for side in (0,1)]
    values={f'hero_presence_{hero}':float((hero in picks[0])-(hero in picks[1])) for hero in range(1,251)}
    values['unknown_hero_count']=float(sum(hero>250 for side in picks for hero in side))
    values['roster_observed']=float(observation.roster_complete)
    present={}
    for side in (0,1):
        for a,b in combinations(sorted(picks[side]),2):present[f'ally_pair_{a}_{b}']=1. if side==0 else -1.
    for a in picks[0]:
        for b in picks[1]:
            lo,hi=sorted((a,b));present[f'counter_pair_{lo}_{hi}']=1. if a==lo else -1.
    for name in schema['directDraftNames']:
        base=name.removesuffix('__missing')
        if schema['featureGroups'][name]=='pair_identity':values[base]=present.get(base,0.)
    return {name:0. if name.endswith('__missing') else values[name] for name in schema['directDraftNames']}

def select_history_versions(versions: list[HistoryVersion], observation: ObservedDraft) -> dict:
    """Only immutable bytes known BEFORE this observation enter a future builder.

    A startup snapshot can establish availability for FUTURE predictions, never
    retroactively. parsed_at by itself cannot prove an immutable version existed.
    end+300 is retained as a conservative feature event clock, not measured delay.
    """
    if not isinstance(versions,list) or len(versions)>MAX_HISTORY:raise ContractError('bounded_history_list_required')
    cutoff=observation.received_at;selected=[];rejected=Counter();seen=set()
    for version in versions:
        if not isinstance(version,dict):raise ContractError('invalid_history_version')
        mid=integer(version.get('matchId'),'history_match_id')
        if mid==observation.match_id:
            rejected['current_map_excluded']+=1;continue  # No current final field is read.
        if mid in seen:raise ContractError('duplicate_history_match_version')
        seen.add(mid)
        captured=timestamp(version.get('capturedAt'))
        if captured>=cutoff:rejected['captured_at_or_after_cutoff']+=1;continue
        basis=version.get('basis')
        if basis=='observed_payload_version':
            received=timestamp(version.get('receivedAt'))
            if received>captured:raise ContractError('history_receipt_after_capture')
            availability=received
        elif basis=='startup_frozen_snapshot':
            received=None;availability=captured
        else:
            rejected['immutable_receipt_basis_missing']+=1;continue
        if not isinstance(version.get('versionId'),str) or not version['versionId']:raise ContractError('history_version_id_required')
        payload=version.get('payload')
        if not isinstance(payload,dict) or payload.get('match_id')!=mid:raise ContractError('history_payload_identity_mismatch')
        if canonical_hash(payload)!=version.get('payloadSha256'):raise ContractError('history_payload_hash_mismatch')
        start=payload.get('start_time');duration=payload.get('duration')
        if type(start) not in (int,float) or not math.isfinite(start) or start<=0:raise ContractError('invalid_historical_start')
        if type(duration) not in (int,float) or not math.isfinite(duration) or not 600<=duration<=10800:raise ContractError('invalid_historical_duration')
        end=start+duration
        if end+300>=cutoff:rejected['end_plus300_at_or_after_cutoff']+=1;continue
        if availability<end:rejected['available_before_reconstructed_completion']+=1;continue
        if type(payload.get('radiant_win')) is not bool:rejected['completed_outcome_missing']+=1;continue
        r=integer(payload.get('radiant_team_id'),'prior_radiant_team');d=integer(payload.get('dire_team_id'),'prior_dire_team')
        if r==d:raise ContractError('same_prior_team')
        selected.append({'matchId':mid,'versionId':version['versionId'],'payloadSha256':version['payloadSha256'],
            'featureEventAt':end+300,'actualAvailableAt':availability,'capturedAt':captured,'basis':basis,
            'originalReceiptKnown':basis=='observed_payload_version'})
    selected.sort(key=lambda r:(r['featureEventAt'],r['matchId']))
    return {'cutoff':cutoff,'cutoffBasis':'current_observation_received_at','selected':selected,'selectedMaps':len(selected),
        'rejected':dict(rejected),'selectedLineageHash':canonical_hash(selected),
        'historicalContextBasis':'event_time_reconstruction_from_versions_available_before_current_cutoff',
        'sourceAvailability95Proven':False,'originalArrivalOrderReproduced':False}

def inspect_inputs(envelope: ObservationEnvelope, versions: list[HistoryVersion], *, now: str, schema: dict | None=None) -> dict:
    if schema is None:_,schema=verified_package()
    observed=normalize_observation(envelope,now=now)
    phase=phase_selection(observed.game_time_sec,True)
    direct=draft_columns(observed,schema)
    history=select_history_versions(versions,observed)
    names=schema['featureNames'];computed=[name in direct for name in names]
    partial=[direct.get(name) for name in names]
    reasons=['input_gate_requires_separate_full_history_builder']
    if phase['route']!='postdraft_input_diagnostic':reasons.append(phase['reason'] or 'not_postdraft_model_phase')
    if not observed.roster_complete:reasons.append('complete_account_to_hero_pairing_required_for_rich_history')
    if any(hero>250 for _,hero,_ in observed.players):reasons.append('hero_outside_fixed_presence_vocabulary')
    return {'contract':CONTRACT,'candidateModelHash':MODEL_SHA256,'observationId':observed.observation_id,
        'phaseSelection':phase,'targetScope':'map','status':'input_diagnostic_only','probability':None,
        'servingEligible':False,'prospectiveValidated':False,'latencyValidated':False,'coverage95Validated':False,
        'readyForFullHistoryBuild':observed.roster_complete and all(hero<=250 for _,hero,_ in observed.players) and phase['route']=='postdraft_input_diagnostic',
        'normalizedInputHash':canonical_hash({'matchId':observed.match_id,'radiantTeamId':observed.radiant_team_id,
            'direTeamId':observed.dire_team_id,'players':observed.players,'gameTimeSec':observed.game_time_sec,'receivedAt':observed.received_at}),
        'featureClock':'current_observation_received_at','modelFeatureCount':len(names),'computedFeatureCount':sum(computed),
        'unresolvedFeatureCount':len(names)-sum(computed),'orderedPartialVector':partial,'computedMask':computed,
        'partialVectorHash':canonical_hash({'featureNames':names,'values':partial,'computedMask':computed}),
        'partialVectorMayBeUsedForPrediction':False,'historySelection':history,'reasons':reasons}
