"""Pure live_observation_journal -> actual observed postdraft contract.

The caller must read an already durable row and check local outcomes in the
dispatch DB snapshot. Source input_hash is the TS stableJson hash, carried as
lineage, NOT silently equated with Python JSON hashing. Existing TS dispatcher
is responsible for exact source/schema pins and request body integrity.
"""
import copy,re
from datetime import datetime,timezone
from ..postdraft_input_contract import ContractError,normalize_observation,phase_selection,timestamp

def stamp(value):
    if isinstance(value,datetime):
        if value.tzinfo is None:raise ContractError('timezone_required')
        return value.astimezone(timezone.utc).isoformat()
    timestamp(value);return value

def journal_envelope(row,*,now,expected_schema_hash,outcome_known_at_dispatch):
    if not isinstance(row,dict):raise ContractError('durable_journal_row_required')
    if type(outcome_known_at_dispatch) is not bool or outcome_known_at_dispatch:raise ContractError('outcome_dispatch_absence_required')
    if not isinstance(expected_schema_hash,str) or not re.fullmatch('[0-9a-f]{64}',expected_schema_hash):raise ContractError('expected_schema_pin_required')
    for key in ('id','input_hash','schema_hash'):
        if not isinstance(row.get(key),str) or not re.fullmatch('[0-9a-f]{64}',row[key]):raise ContractError('journal_hash_missing')
    if row['schema_hash']!=expected_schema_hash:raise ContractError('journal_schema_mismatch')
    payload=row.get('input')
    if not isinstance(payload,dict) or payload.get('matchId')!=row.get('match_id') or payload.get('gameTimeSec')!=row.get('game_time_sec'):
        raise ContractError('journal_denormalized_identity_mismatch')
    available=row.get('availability')
    if not isinstance(available,dict):raise ContractError('journal_availability_required')
    envelope={'observationId':row['id'],'source':'opendota','targetScope':'map','clockUnit':'seconds',
        'receivedAt':stamp(row.get('received_at')),'recordedAt':stamp(row.get('recorded_at')),
        'phase':row.get('phase'),'input':copy.deepcopy(payload),'availability':copy.deepcopy(available)}
    observed=normalize_observation(envelope,now=now)
    route=phase_selection(observed.game_time_sec,True)['route']
    if route!='postdraft_input_diagnostic':raise ContractError('postdraft_phase_only')
    if not observed.roster_complete:raise ContractError('complete_observed_accounts_required')
    # Preserve unverified latency/freshness reasons. They do not become true on mapping.
    envelope['sourceJournal']={'inputHash':row['input_hash'],'schemaHash':row['schema_hash'],
        'inputHashSemantics':'TS stableJson; verify in dispatcher','qualityReasons':copy.deepcopy(row.get('quality_reasons') or []),
        'outcomeKnownAtDispatch':False,'durableRowVisibility':'caller_read_committed_DB_snapshot',
        'sourceEventLatencyVerified':False,'publicEligibility':False}
    return envelope

def checked_completion(output,*,outcome_known_at_finish):
    if type(outcome_known_at_finish) is not bool:raise ContractError('finish_outcome_check_required')
    if outcome_known_at_finish:
        return {'status':'unavailable','reason':'outcome_known_at_finish','probability':None,
            'eligibleForServing':False,'beforeOutcomeAtLocalChecks':False}
    return {'status':'diagnostic_predicted','response':output,'eligibleForServing':False,
        'beforeOutcomeAtLocalChecks':True,'eventLatencyVerified':False,'prospectiveValidated':False}
