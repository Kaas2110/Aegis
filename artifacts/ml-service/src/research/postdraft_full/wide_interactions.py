"""Exact historical 240-value interaction formulas; no fit/inference/IO.

Port of the frozen research class. Its end+300 clock is preserved, not relabeled
as provider arrival. The caller owns prior-data capture and target exclusion.
Use wide_history for the full7148 schema and request-local reads.
"""
from collections import defaultdict, deque
import math
from .rich import finite, avg, stats
from .performance import PERF, performance
DAY=86400
FROZEN_RESEARCH_SOURCE_SHA256='ce6e77a93e430ef73c529c0cb5bd725cab9c93b15216975c96c61c05e2e8dca3'

class Interactions:
 """New bounded historical profiles; never any current-game final statistic."""
 def __init__(self):self.heroes=defaultdict(lambda:deque(maxlen=600));self.latest=0
 def update(self,m,event):
  at=m['start_time']+m['duration']+300
  for p in event.get('players') or []:
   self.heroes[p['hero_id']].append((at,performance(p,m['duration'])))
  self.latest=max(self.latest,at)
 def features(self,m,perf,hist):
  now=m['start_time'];assert self.latest<now
  sides=[list(zip(m.get(s+'_account_ids') or [],m.get(s+'_picks') or [])) for s in ('radiant','dire')]
  values=[defaultdict(list),defaultdict(list)]
  for side,pairs in enumerate(sides):
   for aid,hero in pairs:
    hp=[(at,v) for at,v in perf.hero.get((aid,hero),()) if now-90*DAY<=at<now]
    pp=[(at,v) for at,v in perf.player.get(aid,()) if now-90*DAY<=at<now]
    gh=[v for at,v in self.heroes.get(hero,()) if now-90*DAY<=at<now]
    for f in PERF:
     hm=avg(v.get(f) for _,v in hp);pm=avg(v.get(f) for _,v in pp);baseline=stats(v.get(f) for v in gh)
     scale=baseline['std']
     values[side]['hero_norm_'+f].append((hm-baseline['mean'])/scale if finite(scale) and scale>1e-6 else None)
     values[side]['hero_vs_player_'+f].append(hm-pm)
     p7=avg(v.get(f) for at,v in pp if at>=now-7*DAY)
     p30=avg(v.get(f) for at,v in pp if at>=now-30*DAY)
     values[side]['trend7_90_'+f].append(p7-pm)
     values[side]['trend30_90_'+f].append(p30-pm)
     values[side]['onhero_'+f].append(hm)
    role_events=[e for e in hist.individual.events.get(aid,()) if now-90*DAY<=e.available_at<now and e.role is not None]
    for role in (1,2,3,4):
     values[side]['prior_lane_role_'+str(role)].append(sum(e.role==role for e in role_events)/len(role_events) if role_events else None)
    values[side]['hero_scalar_log_history'].append(math.log1p(len(hp)))
    values[side]['hero_norm_log_baseline'].append(math.log1p(len(gh)))
  out={}
  names=sorted(set(values[0])|set(values[1]))
  for name in names:
   a,b=stats(values[0][name]),stats(values[1][name])
   for stat in ('mean','min','max','std'):
    out['interaction_'+name+'_'+stat+'_diff']=a[stat]-b[stat]
   out['interaction_'+name+'_coverage']=min(sum(finite(v) for v in values[s][name]) for s in (0,1))
  # Historical efficiency/pressure combinations. Hero-normalized GPM is prior
  # performance, not the live GPM of the selected hero in the target map.
  for f,g in [('gpm','tower_dpm'),('gpm','hero_dpm'),('gpm','death_pm'),('xpm','hero_dpm'),('last_hits_pm','obs_pm')]:
   a=[avg(values[s]['onhero_'+f]) for s in (0,1)];b=[avg(values[s]['onhero_'+g]) for s in (0,1)]
   out['interaction_efficiency_'+f+'_'+g]=b[0]/max(a[0],1e-3)-b[1]/max(a[1],1e-3) if all(finite(x) for x in a+b) else float('nan')
   out['interaction_opponent_pressure_'+f+'_'+g]=a[0]*b[1]-a[1]*b[0]
  return out
