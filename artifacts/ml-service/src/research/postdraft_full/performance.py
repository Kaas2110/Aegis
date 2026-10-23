"""Exact frozen past-player performance subset; no replay runner imports."""
from collections import defaultdict,deque
import numpy as np
from .rich import STYLE,finite
PERF=['gpm', 'xpm', 'hero_dpm', 'tower_dpm', 'death_pm', 'kda', 'last_hits_pm', 'obs_pm']
def avg(x):
 x=[v for v in x if finite(v)];return float(np.mean(x)) if x else float('nan')

def performance(p,duration):
 s=p.get('past_only_final_stats') or {};minutes=duration/60
 rate=lambda key:s[key]/minutes if finite(s.get(key)) else float('nan')
 return {'gpm':s.get('gold_per_min'),'xpm':s.get('xp_per_min'),'hero_dpm':rate('hero_damage'),
  'tower_dpm':rate('tower_damage'),'death_pm':rate('deaths'),
  'kda':(s['kills']+s['assists'])/max(1,s['deaths']) if all(finite(s.get(k)) for k in ('kills','deaths','assists')) else None,
  'last_hits_pm':rate('last_hits'),'obs_pm':len(p['obs'])/minutes if isinstance(p.get('obs'),list) else None}

class PastPerformance:
 def __init__(self):self.player=defaultdict(lambda:deque(maxlen=100));self.hero=defaultdict(lambda:deque(maxlen=60));self.latest=0
 def update(self,m,event):
  if not event:return
  at=m['start_time']+m['duration']+300
  for p in event['players']:
   account=p.get('account_id');hero=p.get('hero_id')
   if type(account) is not int or not 0<account<4294967295:continue
   v=performance(p,m['duration']);self.player[account].append((at,v));self.hero[(account,hero)].append((at,v))
  self.latest=max(self.latest,at)
 def features(self,m):
  now=m['start_time'];assert self.latest<now
  sides=[list(zip(m.get(k+'_account_ids') or [],m.get(k+'_picks') or [])) for k in ('radiant','dire')]
  out={}
  for scope,table in [('player',self.player),('playerhero',self.hero)]:
   for window in (30,90):
    histories=[[[v for at,v in table[(a,h) if scope=='playerhero' else a] if now-window*86400<=at<now] for a,h in side] for side in sides]
    for feature in PERF:
     arrays=[[avg(v.get(feature) for v in hist) for hist in side] for side in histories]
     valid=[[x for x in side if finite(x)] for side in arrays]
     prefix=f'pastscalar_{scope}_{window}d_{feature}'
     for stat,func in [('mean',np.mean),('min',np.min),('max',np.max),('std',np.std)]:
      out[prefix+'_'+stat+'_diff']=float(func(valid[0])-func(valid[1])) if all(valid) else float('nan')
     out[prefix+'_min_coverage']=min(map(len,valid))
    sizes=[[len(h) for h in side] for side in histories]
    out[f'pastscalar_{scope}_{window}d_min_history']=min((min(v) if v else 0 for v in sizes))
  return out

def add_historical_profile(m,event):
 if not event:return
 players={};teams=[[],[]]
 for p in event['players']:
  minute=m['duration']/60;s=p.get('past_only_final_stats') or {}
  style={'role':s.get('lane_role'),'duration_min':minute,'kills_pm':s['kills']/minute if finite(s.get('kills')) else len(p.get('kills') or [])/minute,
   'deaths_pm':s['deaths']/minute if finite(s.get('deaths')) else None,
   'obs_placed_pm':len(p['obs'])/minute if isinstance(p.get('obs'),list) else None,
   'sen_placed_pm':len(p['sen'])/minute if isinstance(p.get('sen'),list) else None,
   'buybacks_pm':len(p['buybacks'])/minute if isinstance(p.get('buybacks'),list) else None,
   'first_kill_min':min(p['kills'])/60 if p.get('kills') else None,
   'first_obs_min':min(p['obs'])/60 if p.get('obs') else None}
  purchases=p.get('purchases')
  for short,key in [('blink','blink'),('bkb','black_king_bar'),('mek','mekansm'),('midas','hand_of_midas'),('battlefury','bfury'),('radiance','radiance')]:
   times=[e['time'] for e in purchases or [] if e.get('key')==key and finite(e.get('time'))]
   style[short+'_min']=min(times)/60 if times else None
  # Projected purchases contain selected items only: do not fabricate all-purchase counts or boots timing.
  old=(m.get('historical_players') or {}).get(str(p['hero_id']),{})
  if old.get('account_id')==p.get('account_id'):style={**old.get('style',{}),**style}
  players[str(p['hero_id'])]={'account_id':p.get('account_id'),'style':style};teams[int(p['player_slot']>=128)].append(style)
 m['historical_players']=players;m['historical_style']=[{k:avg(v.get(k) for v in side) for k in STYLE} for side in teams]
