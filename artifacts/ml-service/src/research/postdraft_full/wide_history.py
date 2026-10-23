"""Additive pure7148 history state; C6668/FutureCache and serving stay unchanged.

This is not a source adapter, cache bootstrap, endpoint or anchor ledger. Caller
must first bind real immutable prior receipts and an observed full draft. The
frozen historical end+300 formula remains explicit and is not original receipt.
"""
from __future__ import annotations
import copy,hashlib,heapq,json,math
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType,SimpleNamespace
import numpy as np
from .builder import Accumulator,current
from .projection import LocalEntries,request_view
from .rich import finite
from .wide_interactions import Interactions
from ..postdraft_input_contract import ContractError

NAMES_SHA256='6cda9871540f2044018c5ba69492e5853199a14d35f1b08e4f3ef4edeac89e1a'
GROUPS_SHA256='b10876f425f7197501c305c48dbbe919bef401bccc4143e5af896a3a22782846'

@dataclass(frozen=True)
class WideSchema:
    names:tuple
    groups:object
    def __post_init__(self):
        names=tuple(self.names);groups=dict(self.groups)
        h=lambda v:hashlib.sha256(json.dumps(v,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()
        if h(names)!='51f9cc2daef9db42acfddeed742d11a316d3b994d3795d47c169969dc8875a0d' or h(groups)!='f2c869d87cca3bb7a42c71cd202e133431229bf09cb41a3846d5c40d5c092b24':raise ContractError('wide_schema_semantic_pin_mismatch')
        object.__setattr__(self,'names',names);object.__setattr__(self,'groups',MappingProxyType(groups))
    @classmethod
    def load(cls,folder):
        values=[]
        for filename,pin in [('feature-names.json',NAMES_SHA256),('feature-groups.json',GROUPS_SHA256)]:
            path=Path(folder)/filename
            if path.is_symlink() or path.stat().st_size>2_000_000:raise ContractError('wide_schema_size_or_path')
            with path.open('rb') as stream:raw=stream.read(2_000_001)
            if len(raw)>2_000_000 or hashlib.sha256(raw).hexdigest()!=pin:raise ContractError('wide_schema_pin_mismatch')
            values.append(json.loads(raw))
        names,groups=values
        if len(names)!=7148 or len(set(names))!=7148 or set(groups)!=set(names):raise ContractError('wide_schema_mismatch')
        extras=[n for n in names if groups[n]=='new_interactions']
        if len(extras)!=480 or sum(n.endswith('__missing') for n in extras)!=240:raise ContractError('wide_interaction_schema_mismatch')
        return cls(tuple(names),MappingProxyType(groups))

def _target(m,state):
    cm=current(m)
    if type(cm.get('match_id')) is not int or cm['match_id']<=0:raise ContractError('wide_target_match_required')
    if cm['match_id'] in state.seen:raise ContractError('wide_target_already_in_history')
    now=cm.get('start_time')
    if type(now) not in (int,float) or not math.isfinite(now) or now<=max(state.perf.latest,state.first.latest,state.interactions.latest):raise ContractError('wide_target_not_after_prior')
    teams=[cm.get(s+'_team_id') for s in ('radiant','dire')]
    if any(type(t) is not int or t<=0 for t in teams) or teams[0]==teams[1]:raise ContractError('wide_team_identity_required')
    picks=[cm.get(s+'_picks') for s in ('radiant','dire')];accounts=[cm.get(s+'_account_ids') for s in ('radiant','dire')]
    if any(not isinstance(x,list) or len(x)!=5 for x in picks+accounts):raise ContractError('wide_full_draft_required')
    heroes=picks[0]+picks[1];players=accounts[0]+accounts[1]
    if any(type(h) is not int or not 1<=h<=250 for h in heroes) or len(set(heroes))!=10:raise ContractError('wide_supported_distinct_heroes_required')
    if any(type(a) is not int or not 0<a<4294967295 for a in players) or len(set(players))!=10:raise ContractError('wide_distinct_accounts_required')
    return cm

def vector_from_state(state,m,schema):
    if not isinstance(schema,WideSchema):raise ContractError('wide_pinned_schema_required')
    cm=_target(m,state)
    features,ctx=state.rich.features(cm);features.update(state.perf.features(cm))
    corrected,_=state.first.features(cm,ctx['prior']);features.update(corrected)
    features.update(state.interactions.features(cm,state.perf,state.rich))
    values={}
    for name in schema.names:
        if name.endswith('__missing'):continue
        if name in features:value=features[name]
        elif schema.groups[name]=='pair_identity':value=0.
        else:raise ContractError('unimplemented_wide_feature:'+name)
        values[name]=float(value) if finite(value) else math.nan
    output=[float(not math.isfinite(values[n.removesuffix('__missing')])) if n.endswith('__missing') else values[n] for n in schema.names]
    with np.errstate(over='ignore'):vector=np.asarray(output,dtype='<f4')
    if np.isinf(vector).any():raise ContractError('wide_float32_overflow')
    return vector

class WideHistoryAccumulator(Accumulator):
    """Same frozen order/update semantics plus one independent hero accumulator."""
    def __init__(self):
        super().__init__();self.interactions=Interactions()
    def advance(self,cutoff):
        while self.pending and self.pending[0][0]<cutoff:
            _,_,m,ctx,firstctx,minima=heapq.heappop(self.pending)
            self.rich.update(m,ctx);self.perf.update(m,{'players':m['players']});self.first.update(m,firstctx,minima)
            self.interactions.update(m,{'players':m['players']});self.applied+=1
    def vector(self,m,schema):return vector_from_state(self,m,schema)

def wide_request_view(state):
    """Private request owners: no update/queue API, copy-on-read hero records."""
    if not isinstance(state,WideHistoryAccumulator):raise ContractError('wide_history_state_required')
    base=request_view(state)
    interactions=copy.copy(state.interactions)
    interactions.heroes=LocalEntries(state.interactions.heroes,{})
    return SimpleNamespace(rich=base.rich,perf=base.perf,first=base.first,
       interactions=interactions,seen=frozenset(state.seen))

def project_wide_history(state,m,schema):
    """Feature computation only; provenance/anchor/latency are not asserted here."""
    return vector_from_state(wide_request_view(state),m,schema)
