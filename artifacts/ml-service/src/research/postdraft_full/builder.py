"""C80 full causal history reconstruction for FUTURE observed draft diagnostics.

Prior-map features retain the frozen end+300 reconstruction formulas. Source
rows are frozen in one read-only snapshot known before cache.built_at; this
cache may NEVER score earlier observations or historical benchmark rows.
Prediction uses request-owned copies of only the history entries it reads.
No active model, provider, DB, training, or route dependency.
"""
from __future__ import annotations
import copy,heapq,hashlib,json,math
from collections import Counter
from datetime import datetime,timezone
import numpy as np
from .rich import RichHistory,finite
from .performance import PastPerformance,add_historical_profile
from .first_kill import FirstKillHistory
from .roster import final_roster
from .causal import valid_picks
from .temporal import prepare_events,past_player_first_hero_kill_min
from .projection import request_view
from ..postdraft_input_contract import (ContractError,normalize_observation,phase_selection,canonical_hash,timestamp,verified_package,ASSETS,MODEL_SHA256)

CURRENT_KEYS=('match_id','start_time','radiant_team_id','dire_team_id','series_id','series_type','league_id','radiant_picks','dire_picks','radiant_account_ids','dire_account_ids')
def current(m):return {k:m.get(k) for k in CURRENT_KEYS}
def iso():return datetime.now(timezone.utc).isoformat()

def project_prior(row,hero_names):
    """One finished prior map; no current target enters this function."""
    m=copy.deepcopy(row)
    if (type(m.get('start_time')) is not int or m['start_time']<=0 or type(m.get('duration')) is not int or
        not 600<=m['duration']<=10800 or type(m.get('radiant_win')) is not bool or
        type(m.get('radiant_team_id')) is not int or type(m.get('dire_team_id')) is not int or
        min(m['radiant_team_id'],m['dire_team_id'])<=0 or m['radiant_team_id']==m['dire_team_id']):
        raise ContractError('invalid_prior_outcome_or_identity')
    try:roster=final_roster(m)
    except ValueError:
        roster=None;d=m.get('draft') or {}
        a=[d.get(s+'_account_ids') or [] for s in ('radiant','dire')]
        if (valid_picks(d.get('radiant_picks'),d.get('dire_picks')) and all(len(x)==5 for x in a)
            and all(type(x) is int and 0<x<4294967295 for aa in a for x in aa) and len(set(a[0]+a[1]))==10):
            roster={s:[{'hero_id':h,'account_id':p} for h,p in zip(d[s+'_picks'],d[s+'_account_ids'])] for s in ('radiant','dire')}
        m['players']=[]
    for side in ('radiant','dire'):
        m[side+'_picks']=[p['hero_id'] for p in roster[side]] if roster else []
        m[side+'_account_ids']=[p['account_id'] for p in roster[side]] if roster else []
    m['eligible_draft']=roster is not None
    minima={};statuses=Counter()
    if m.get('players'):
        for p in m['players']:
            s=p.get('past_only_final_stats') or {}
            p['past_only_final_stats']={k:v if finite(v) and v>=0 else None for k,v in s.items()}
        add_historical_profile(m,{'players':m['players']})
        raw=row.get('raw_kill_players')
        if raw is None:raise ContractError('lossless_raw_kill_players_required')
        byslot={p.get('player_slot'):p for p in raw}
        for p in m['players']:
            q=byslot.get(p['player_slot'])
            if not q or any(q.get(k)!=p.get(k) for k in ('hero_id','account_id')):raise ContractError('raw_player_identity_mismatch')
            times=[v.get('time') for v in q['kills_log']] if isinstance(q.get('kills_log'),list) else None
            if times!=p.get('kills'):raise ContractError('raw_kill_time_projection_mismatch')
        events=prepare_events(raw,hero_names,provenance={'match_id':m['match_id'],'players_payload_md5':row.get('players_payload_md5')})
        for p in m['players']:
            result=past_player_first_hero_kill_min(events,p['player_slot'],as_of_seconds=m['duration'])
            minima[str(p['hero_id'])]=result['first_hero_kill_min'];statuses[result['status']]+=1
    # Keep only required historical fields in pending heap; raw logs can be freed.
    for key in ('raw_kill_players','draft'):m.pop(key,None)
    return m,minima,statuses

class Accumulator:
    """Single-threaded ordered replay. Inference uses a request-local clone."""
    def __init__(self):
        self.rich=RichHistory();self.perf=PastPerformance();self.first=FirstKillHistory()
        self.pending=[];self.seen=set();self.last_start=(-1,-1);self.applied=0
    def advance(self,cutoff):
        while self.pending and self.pending[0][0]<cutoff:
            _,_,m,ctx,firstctx,minima=heapq.heappop(self.pending)
            self.rich.update(m,ctx);self.perf.update(m,{'players':m['players']});self.first.update(m,firstctx,minima);self.applied+=1
    def before(self,m):
        key=(m['start_time'],m['match_id'])
        if key<self.last_start or m['match_id'] in self.seen:raise ContractError('unordered_or_duplicate_history')
        self.last_start=key;self.seen.add(m['match_id']);self.advance(m['start_time'])
    def queue(self,m,minima):
        cm=current(m);base,_,_=self.rich.basic.features(cm)
        ctx={'profiles':[self.rich.profile(m[s+'_team_id'],m['start_time']) for s in ('radiant','dire')],'prior':base[1]}
        fctx={'profiles':[self.first.profile(m[s+'_team_id'],m['start_time']) for s in ('radiant','dire')],'prior':base[1]}
        heapq.heappush(self.pending,(m['start_time']+m['duration']+300,m['match_id'],m,ctx,fctx,minima))
    def vector(self,cm,schema):
        # Explicit whitelist means current final scalars/outcomes are ignored.
        cm=current(cm);features,ctx=self.rich.features(cm);features.update(self.perf.features(cm))
        corrected,_=self.first.features(cm,ctx['prior']);features.update(corrected)
        names=schema['featureNames'];groups=schema['featureGroups'];values={}
        for name in names:
            if name.endswith('__missing'):continue
            if name in features:value=features[name]
            elif groups[name]=='pair_identity':value=0.
            else:raise ContractError('unimplemented_feature:'+name)
            values[name]=float(value) if finite(value) else float('nan')
        output=[float(not math.isfinite(values[n.removesuffix('__missing')])) if n.endswith('__missing') else values[n] for n in names]
        with np.errstate(over='ignore'):
            vector=np.array(output,dtype=np.float32)
        if np.isinf(vector).any():raise ContractError('float32_feature_overflow')
        return vector

def validate_receipt(row,cutoff):
    """Latest table versions become valid ONLY via this frozen startup snapshot."""
    if timestamp(row.get('ingested_at'))>cutoff:raise ContractError('prior_ingested_after_snapshot')
    if row.get('parsed_at') is not None and timestamp(row['parsed_at'])>cutoff:raise ContractError('prior_parsed_after_snapshot')
    if row.get('draft') and timestamp(row['draft'].get('fetched_at'))>cutoff:raise ContractError('draft_fetched_after_snapshot')
    if row['start_time']+row['duration']+300>=cutoff:raise ContractError('prior_not_finished_before_snapshot')
    if row.get('players') and row.get('parsed_at') is None:raise ContractError('parsed_receipt_required')

class FutureCache:
    def __init__(self,state,manifest,built_at):
        if timestamp(manifest.get('snapshotCutoff'))>timestamp(built_at):raise ContractError('cache_build_before_snapshot_cutoff')
        self._state=state;self.manifest=copy.deepcopy(manifest);self.built_at=built_at
        self._model=None
    def predict(self,envelope,*,now,guard=lambda:None):
        observed=normalize_observation(envelope,now=now)
        if observed.received_at<timestamp(self.built_at):raise ContractError('observation_precedes_cache_build')
        if observed.received_at-timestamp(self.built_at)>86400:raise ContractError('startup_cache_older_than_24h_refresh_required')
        if observed.received_at-timestamp(self.manifest['snapshotCutoff'])>86400:raise ContractError('snapshot_older_than_24h_refresh_required')
        if phase_selection(observed.game_time_sec,True)['route']!='postdraft_input_diagnostic':raise ContractError('postdraft_phase_only')
        if not observed.roster_complete or any(h>250 for _,h,_ in observed.players):raise ContractError('complete_supported_roster_required')
        if observed.match_id in self._state.seen:raise ContractError('target_already_in_completed_history')
        _,schema=verified_package();guard()
        state=request_view(self._state);guard()
        cm={'match_id':observed.match_id,'start_time':observed.received_at,
            'radiant_team_id':observed.radiant_team_id,'dire_team_id':observed.dire_team_id,
            'series_id':None,'series_type':None,'league_id':None}
        # Optional series metadata must itself have observed receipt provenance.
        context=envelope.get('seriesContext');context_status='missing_legacy_frozen_zero_defaults'
        if context is not None:
            if (not isinstance(context,dict) or context.get('matchId')!=observed.match_id or
                context.get('radiantTeamId')!=observed.radiant_team_id or context.get('direTeamId')!=observed.dire_team_id or
                timestamp(context.get('receivedAt'))>observed.received_at):raise ContractError('invalid_observed_series_context')
            sid=context.get('seriesId');stype=context.get('seriesType')
            if type(sid) is not int or sid<=0 or type(stype) is not int or stype not in (0,1,2):raise ContractError('invalid_series_identity_or_format')
            cm.update(series_id=sid,series_type=stype);context_status='observed_prior_receipt'
        for side,index in [('radiant',0),('dire',1)]:
            pp=[(h,a) for s,h,a in observed.players if s==index]
            cm[side+'_picks']=[h for h,a in pp];cm[side+'_account_ids']=[a for h,a in pp]
        vector=state.vector(cm,schema);guard()
        # verified_package above still verifies the on-disk model on EVERY call.
        # The actor serializes inference; retain the verified Booster in memory.
        # No fitting, parameter changes, or weakening of the source pins.
        if self._model is None:
            import lightgbm as lgb
            model=lgb.Booster(model_file=str(ASSETS/'C_corrected_fixed80.model.txt'))
            if model.num_feature()!=6668 or model.num_trees()!=80:raise ContractError('pinned_model_shape_mismatch')
            self._model=model
        model=self._model
        probability=float(model.predict(vector.reshape(1,-1),num_threads=4)[0]);guard()
        serial=[float(x) if math.isfinite(x) else None for x in vector]
        return {'contract':'full_postdraft_c80_future_snapshot_diagnostic_v1','observationId':observed.observation_id,
            'matchId':observed.match_id,'phase':'postdraft' if observed.game_time_sec<0 else 'early_live_draft_context',
            'clockSeconds':observed.game_time_sec,'featureAsOf':observed.received_at,'cacheBuiltAt':self.built_at,
            'historyManifestSha256':canonical_hash(self.manifest),'normalizedInputSha256':canonical_hash(cm),
            'featureVector':serial,'featureVectorFloat32Sha256':hashlib.sha256(vector.tobytes()).hexdigest(),
            'featureNamesSha256':canonical_hash(schema['featureNames']),'modelSha256':MODEL_SHA256,
            'diagnosticRadiantWinProbability':probability,'seriesContextStatus':context_status,
            'quality':{'featureBuilderComplete':True,'technicalModelParityVerified':True,'eligibleForServing':False,
                'prospectiveValidated':False,'calibrationValidated':False,'latencyValidated':False,'coverage95Validated':False},
            'limitations':['postdraft historical model, not dynamic live state predictor','cache supplies history only through frozen cutoff',
                'prior profiles reconstruct historical context at end+300; not original source receipt proof',
                'first_kill means first confirmed enemy hero event in observed log; event completeness unproven',
                'current feature clock is observed receipt, while training used historical map start']}

def bootstrap(rows,manifest,hero_names,*,guard=lambda:None,progress=lambda x:None):
    cutoff=timestamp(manifest['snapshotCutoff']);state=Accumulator();counts=Counter();lineage=hashlib.sha256()
    guard()
    for index,row in enumerate(rows):
        if index>=50_000:raise ContractError('history_limit_exceeded')
        if index%100==0:guard()
        validate_receipt(row,cutoff)
        lineage.update(canonical_hash(row).encode('ascii'))
        try:m,minima,status=project_prior(row,hero_names)
        except ContractError as error:
            # Invalid outcome maps may be excluded; raw mismatch invalidates cache.
            if str(error)!='invalid_prior_outcome_or_identity':raise
            counts['excluded_invalid_map']+=1;continue
        state.before(m);state.queue(m,minima);counts['maps']+=1
        counts['schema3_profiles']+=bool(m['players']);counts['complete_drafts']+=m['eligible_draft'];counts.update({'firstkill_'+k:v for k,v in status.items()})
        if index%1000==0:progress({'readRows':index+1,'eligibleMaps':counts['maps']})
    state.advance(cutoff)
    if state.pending:raise ContractError('unfinished_pending_history')
    built=iso();guard();meta={**manifest,'counts':dict(counts),'builtAt':built,'rowLineageSha256':lineage.hexdigest(),
        'eligibleOnlyForReceivedAtOrAfter':built,'statePersistence':'in_process_only; rebuild from pinned immutable snapshot',
        'originalHistoricalReceiptProven':False,'active':False,'fits':0}
    return FutureCache(state,meta,built)
