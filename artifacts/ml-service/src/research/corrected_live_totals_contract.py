"""Pure feature contract shared by corrected replay research and observed input.

Only observed game clock, observed scores, and current draft enter features.
Archived prefix reconstruction uses exact opponent-hero events; endpoint labels
are a separate retrospective eligibility decision, never an input feature.
An available event prefix is still not independent proof of a full scoreboard.
"""
from __future__ import annotations
import math
from typing import Any, Mapping
import numpy as np
from src.research.temporal_hero_kills import prepare_events, score_at, endpoint_eligibility

VERSION='corrected-live-totals-features-v1'
HERO_CAP=250
STATE_NAMES=('dire_kills','game_minutes','kill_diff','kills_per_minute','radiant_kills','total_kills')
DRAFT_NAMES=tuple(f'{group}_{hero}' for group in ('draft_signed_hero','draft_presence_hero','draft_signed_minutes','draft_signed_total_kills') for hero in range(1,HERO_CAP+1))
FEATURE_NAMES=STATE_NAMES+DRAFT_NAMES

def _integer(value: Any, name: str, minimum: int=0) -> int:
 if type(value) is not int or not minimum<=value<=2**53-1:raise ValueError('invalid_'+name)
 return value

def _draft(players: Any) -> np.ndarray:
 if not isinstance(players,list) or len(players)!=10 or any(not isinstance(p,Mapping) for p in players):raise ValueError('draft_incomplete')
 heroes=[p.get('heroId') for p in players];sides=[p.get('team') for p in players]
 if any(type(h) is not int or not 1<=h<=HERO_CAP for h in heroes) or len(set(heroes))!=10:raise ValueError('draft_hero_identity_invalid')
 if any(type(s) is not int or s not in (0,1) for s in sides) or sides.count(0)!=5:raise ValueError('draft_sides_invalid')
 signed=np.zeros(HERO_CAP,dtype=np.float64)
 for hero,side in zip(heroes,sides):signed[hero-1]=1 if side==0 else -1
 return signed

def features_from_observed(state: Mapping[str,Any], *, variant: str='state_draft') -> np.ndarray:
 """Shared serving formula; ignores all fields except three state values/draft."""
 if variant not in ('state_only','state_draft'):raise ValueError('unknown_variant')
 clock=_integer(state.get('gameTimeSec'),'clock',1)
 radiant=_integer(state.get('radiantScore'),'radiant_score')
 dire=_integer(state.get('direScore'),'dire_score')
 minutes=clock/60;total=radiant+dire
 core=np.asarray([dire,minutes,radiant-dire,total/minutes,radiant,total],dtype=np.float64)
 if variant=='state_only':result=core.astype(np.float32)
 else:
  signed=_draft(state.get('players'))
  result=np.concatenate([core,signed,np.abs(signed),signed*minutes,signed*total]).astype(np.float32)
 if not np.isfinite(result).all():raise ValueError('nonfinite_feature_vector')
 return result

def prefix_from_prepared(prepared: Any, players: list[Mapping[str,Any]], clock: int) -> dict[str,Any]:
 """No duration/final score/label argument; unknown does not become zero."""
 _integer(clock,'clock',1)
 prefix=score_at(prepared,clock)
 if not prefix['available']:return {'available':False,'state':None,'issues':prefix['issues']}
 state={'gameTimeSec':clock,'radiantScore':prefix['score']['radiant'],'direScore':prefix['score']['dire'],
  'players':[{'heroId':p.get('hero_id'),'team':0 if p.get('player_slot',999)<128 else 1} for p in players]}
 # Validate the reconstructed draft through the same live feature contract.
 _draft(state['players'])
 return {'available':True,'state':state,'issues':[],
  'semantics':'exact enemy-hero events observed in archived prefix; scoreboard completeness not independently proven'}

def reconstruct_prefix(players: list[Mapping[str,Any]], hero_names: Mapping[int,str], clock: int) -> dict[str,Any]:
 return prefix_from_prepared(prepare_events(players,hero_names),players,clock)

def retrospective_eligibility(raw: Mapping[str,Any], hero_names: Mapping[int,str]) -> tuple[Any,dict[str,Any]]:
 """Label-dependent corpus selection only; keep separate from prefix inference."""
 prepared=prepare_events(raw.get('players'),hero_names,provenance={
  'parsed_at':raw.get('parsed_at'),'players_payload_md5':raw.get('players_payload_md5'),'source':'saved_local_match_parsed'})
 result=endpoint_eligibility(prepared,raw.get('duration'),{'radiant':raw.get('radiant_score'),'dire':raw.get('dire_score')})
 issues=list(result['issues'])
 if raw.get('payload_schema_version')!=3:issues.append('schema3_required')
 return prepared,{**result,'eligible':not issues,'issues':sorted(set(issues))}

def remaining_targets(state: Mapping[str,Any], *, final_duration_seconds: int, final_radiant_score: int, final_dire_score: int) -> tuple[float,float]:
 """Targets in kills and minutes; called only after features are frozen."""
 clock=_integer(state.get('gameTimeSec'),'clock',1)
 radiant=_integer(state.get('radiantScore'),'radiant_score');dire=_integer(state.get('direScore'),'dire_score')
 duration=_integer(final_duration_seconds,'final_duration',1)
 final_radiant=_integer(final_radiant_score,'final_radiant_score');final_dire=_integer(final_dire_score,'final_dire_score')
 if clock>=duration or radiant>final_radiant or dire>final_dire:raise ValueError('target_outside_final_bounds')
 return float(final_radiant+final_dire-radiant-dire),(duration-clock)/60
