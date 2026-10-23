"""Exact projection of the existing RichHistory first_kill_min feature family.
No new formulas, fitting, vocabulary or outcome look-ahead. See golden parity
against all frozen vectors before replacing source minima.
"""
from collections import defaultdict,deque
import math
import numpy as np
DAY=86400
K='first_kill_min'
def finite(v):return type(v) in (float,int) and math.isfinite(v)
def avg(values):
 a=[float(v) for v in values if finite(v)]
 return float(np.mean(a)) if a else float('nan')
def stats(values):
 a=np.array([float(v) for v in values if finite(v)])
 if len(a)==0:return dict(mean=float('nan'),min=float('nan'),max=float('nan'),std=float('nan'))
 return dict(mean=float(a.mean()),min=float(a.min()),max=float(a.max()),std=float(a.std()))
class FirstKillHistory:
 def __init__(self):
  self.team_games=defaultdict(lambda:deque(maxlen=100));self.hero_perf=defaultdict(lambda:deque(maxlen=100));self.playerhero_perf=defaultdict(lambda:deque(maxlen=30));self.latest=0
 def past_team(self,team,now):return [v for v in self.team_games[team] if v['at']>=now-180*DAY]
 def profile(self,team,now):return avg(v['value'] for v in self.past_team(team,now)[-20:])
 def features(self,m,prior):
  now=m['start_time'];assert self.latest<now
  teams=[m['radiant_team_id'],m['dire_team_id']];picks=[m.get(s+'_picks') or [] for s in ('radiant','dire')];accounts=[m.get(s+'_account_ids') or [] for s in ('radiant','dire')]
  valid=(len(accounts[0])==len(accounts[1])==5 and len(set(accounts[0]+accounts[1]))==10 and all(type(p) is int and 0<p<4294967295 for p in accounts[0]+accounts[1]))
  profiles=[self.profile(t,now) for t in teams];a,b=profiles;f={}
  def put(name,value):f[K+'_'+name]=float(value) if finite(value) else float('nan')
  def sides(prefix,arrays):
   aa,bb=stats(arrays[0]),stats(arrays[1])
   for key in aa:put(prefix+'_'+key+'_diff',aa[key]-bb[key])
   put(prefix+'_min_coverage',min(sum(finite(v) for v in arr) for arr in arrays))
  put('team_mean_diff',a-b);put('team_pair_mean',(a+b)/2);put('team_pair_product',a*b/25)
  recent=[];volatility=[];adjustments=[];responses=[];residuals=[];effn=[];draft_values=[];player_values=[]
  for ix in range(2):
   games=self.past_team(teams[ix],now);vv=[v['value'] for v in games[-20:]]
   recent.append(avg(v['value'] for v in games[-5:])-avg(vv));volatility.append(stats(vv)['std'])
   adjustments.append(avg(v['value']-v['opponent'] for v in games[-20:] if finite(v['value']) and finite(v['opponent'])))
   target=profiles[1-ix];usable=[v for v in games if finite(v['opponent']) and finite(target)]
   weights=[math.exp(-.5*((v['opponent']-target)/5)**2)*2**(-(now-v['at'])/(90*DAY)) for v in usable];total=sum(weights)
   responses.append((10+sum(w*v['won'] for w,v in zip(weights,usable)))/(20+total))
   residuals.append(sum(w*(v['won']-v['prior']) for w,v in zip(weights,usable))/(20+total));effn.append(math.log1p(total))
   draft_values.append([avg(self.hero_perf[h]) for h in picks[ix]])
   pairs=list(zip(accounts[ix],picks[ix])) if valid else []
   player_values.append([avg(self.playerhero_perf[(p,h)]) for p,h in pairs])
  put('team_recent_trend_diff',recent[0]-recent[1]);put('team_volatility_diff',volatility[0]-volatility[1]);put('past_vs_opponent_diff',adjustments[0]-adjustments[1])
  put('response_to_opponent_style_diff',responses[0]-responses[1]);put('elo_residual_vs_style_diff',residuals[0]-residuals[1]);put('response_min_log_n',min(effn))
  sides('draft_profile',draft_values);sides('playerhero_profile',player_values)
  dp=[avg(v) for v in draft_values];put('team_draft_fit_diff',abs(a-dp[0])-abs(b-dp[1]));put('draft_vs_opponent_team_diff',(dp[0]-b)-(dp[1]-a))
  return f,{'profiles':profiles,'prior':prior}
 def update(self,m,ctx,player_minima):
  now=m['start_time']+m['duration']+300;assert now>=self.latest;self.latest=now
  for ix,side in enumerate(('radiant','dire')):
   profiles=m.get('historical_players') or {};picks=m.get(side+'_picks') or []
   # Mirrors RichHistory: all valid parsed players (including unknown accounts)
   # contribute to the side style mean; draft-only rows have no player profile.
   values=[player_minima.get(str(p['hero_id']),player_minima.get(p['hero_id'])) for p in (m.get('players') or []) if int(p['player_slot']>=128)==ix]
   self.team_games[m[side+'_team_id']].append({'at':now,'won':int(m['radiant_win']) if ix==0 else 1-int(m['radiant_win']),
    'value':avg(values),'opponent':ctx['profiles'][1-ix],'prior':ctx['prior'] if ix==0 else 1-ctx['prior']})
   for h in picks:
    data=profiles.get(str(h),profiles.get(h))
    if data:
     value=player_minima.get(str(h),player_minima.get(h));self.hero_perf[h].append(value);account=data.get('account_id')
     if type(account) is int and 0<account<4294967295:self.playerhero_perf[(account,h)].append(value)
