"""Exploratory post-draft features; current-map outcomes never enter inputs.

Historical provider availability is reconstructed as end+300 seconds. This is
not proof of the original provider receipt time or a production feature path.
"""
from collections import defaultdict, deque
from itertools import combinations
import heapq
import math
import sys
import numpy as np
from .causal import (History, BASE_NAMES, DRAFT_NAMES,
    ROSTER_NAMES, DAY, group_id, valid_picks)

STYLE = ['kills_pm', 'deaths_pm', 'duration_min', 'obs_placed_pm', 'sen_placed_pm',
         'buybacks_pm', 'purchases_early', 'purchases_mid', 'purchases_late',
         'first_kill_min', 'first_obs_min', 'blink_min', 'bkb_min', 'mek_min',
         'midas_min', 'battlefury_min', 'radiance_min', 'boots_min',
         'blink_purchase_share', 'bkb_purchase_share']
SCALES = dict(zip(STYLE, [0.1, 0.1, 10, 0.15, 0.15, 0.03, 10, 15, 20, 5, 5, 8, 8,
                         8,8,8,8,3,.3,.3]))

def finite(v):
    return type(v) in (int, float) and math.isfinite(v)

def avg(values):
    a = [float(x) for x in values if finite(x)]
    return float(np.mean(a)) if a else float('nan')

def stats(values):
    a = np.array([float(x) for x in values if finite(x)])
    if len(a) == 0:
        return dict(mean=float('nan'), min=float('nan'), max=float('nan'), std=float('nan'))
    return dict(mean=float(a.mean()), min=float(a.min()), max=float(a.max()), std=float(a.std()))

class Decayed:
    def __init__(self, half_life=90):
        self.half = half_life * DAY
        self.data = {}
    def get(self, key, now):
        n,w,t = self.data.get(key, (0.,0.,now))
        decay = 2 ** (-max(0, now-t) / self.half)
        n,w = n*decay,w*decay
        return (w+10)/(n+20), n
    def add(self, key, now, won):
        n,w,t = self.data.get(key, (0.,0.,now))
        decay = 2 ** (-max(0, now-t) / self.half)
        self.data[key] = (n*decay+1, w*decay+won, now)

class RichHistory:
    def __init__(self):
        self.basic = History()
        self.rates = {d: {k: Decayed(d) for k in ('hero','synergy','counter','player','playerhero','teamhero')}
                      for d in (30,90)}
        self.team_games = defaultdict(lambda: deque(maxlen=100))
        self.hero_perf = defaultdict(lambda: deque(maxlen=100))
        self.playerhero_perf = defaultdict(lambda: deque(maxlen=30))
        self.player_recent = defaultdict(lambda: deque(maxlen=30))
        self.rosters = defaultdict(lambda: deque(maxlen=20))
        self.feature_groups = {}
        from .player import PlayerHistory
        self.individual = PlayerHistory()

    def past_team(self, team, now):
        return [v for v in self.team_games[team] if v['at'] >= now-180*DAY]

    def profile(self, team, now):
        games = self.past_team(team, now)[-20:]
        return {k:avg(v['style'].get(k) for v in games) for k in STYLE}

    def features(self, m):
        b,d,r = self.basic.features(m)
        values = {}
        def put(name, value, group):
            name=sys.intern(name)
            values[name] = float(value) if finite(value) else float('nan')
            self.feature_groups[name] = group
        for name,value in zip(BASE_NAMES,b):
            put(name,value,'strength' if name in ('elo_diff','elo_prior') else 'context')
        for name,value in zip(DRAFT_NAMES,d if d is not None else [None]*6): put(name,value,'draft_basic')
        for name,value in zip(ROSTER_NAMES,r if r is not None else [None]*5): put(name,value,'roster_basic')
        now = m['start_time']; teams=[m['radiant_team_id'],m['dire_team_id']]
        picks=[m.get('radiant_picks') or [],m.get('dire_picks') or []]
        accounts=[m.get('radiant_account_ids') or [],m.get('dire_account_ids') or []]
        valid_accounts = (len(accounts[0])==len(accounts[1])==5 and len(set(accounts[0]+accounts[1]))==10
                          and all(type(p) is int and 0<p<4294967295 for p in accounts[0]+accounts[1]))
        put('roster_observed',int(valid_accounts),'roster_basic')
        # Fixed vocabulary; IDs are set membership, never interpreted as roles.
        for h in range(1,251): put(f'hero_presence_{h}',int(h in picks[0])-int(h in picks[1]),'hero_identity')
        put('unknown_hero_count',sum(h>250 for p in picks for h in p),'hero_identity')
        # Sparse explicit hero interactions. Vocabulary is selected by TRAIN
        # occurrence only in the runner; unobserved entries mean absent (zero).
        for ix in range(2):
            for pair in combinations(sorted(picks[ix]),2):
                put(f'ally_pair_{pair[0]}_{pair[1]}',1 if ix==0 else -1,'pair_identity')
        for a in picks[0]:
            for bb in picks[1]:
                lo,hi=sorted((a,bb))
                put(f'counter_pair_{lo}_{hi}',1 if a==lo else -1,'pair_identity')
        current_players = [[{'account_id':p,'hero_id':h} for p,h in zip(aa,pp)]
                           if valid_accounts else [] for aa,pp in zip(accounts,picks)]
        individual=self.individual.features(current_players[0],current_players[1],now)
        for name,value in individual.items():put(name,value,self.individual.feature_groups[name])
        profiles=[self.profile(t,now) for t in teams]
        current_context={'profiles':profiles,'prior':b[1]}

        def sides(prefix, arrays, group):
            sa,sb = stats(arrays[0]),stats(arrays[1])
            for key in sa:
                put(prefix+'_'+key+'_diff',sa[key]-sb[key],group)
            put(prefix+'_min_coverage',min(sum(finite(v) for v in a) for a in arrays),group)

        for half,tables in self.rates.items():
            for name in ('hero','teamhero','synergy','player','playerhero'):
                keys=[]
                for ix in range(2):
                    pp=picks[ix];aa=accounts[ix]
                    kk=(pp if name=='hero' else [(teams[ix],h) for h in pp] if name=='teamhero'
                        else [tuple(sorted(pair)) for pair in combinations(pp,2)] if name=='synergy'
                        else aa if name=='player' and valid_accounts
                        else list(zip(aa,pp)) if name=='playerhero' and valid_accounts else [])
                    keys.append([tables[name].get(k,now) for k in kk])
                group='draft_rich' if name in ('hero','synergy') else 'comfort'
                sides(f'{name}_{half}d_wr', [[x[0] for x in a] for a in keys], group)
                sides(f'{name}_{half}d_log_n', [[math.log1p(x[1]) for x in a] for a in keys],group)
            counter=[tables['counter'].get((a,b),now) for a in picks[0] for b in picks[1]]
            for key,val in stats([v[0]-.5 for v in counter]).items(): put(f'counter_{half}d_{key}',val,'draft_rich')
            put(f'counter_{half}d_min_log_n',math.log1p(min([v[1] for v in counter],default=0)),'draft_rich')

        for hgroup,table in [('hero',self.basic.heroes),('earlyhero',self.basic.short),('latehero',self.basic.long)]:
            sides(hgroup+'_lifetime', [[(table[h][1]+10)/(table[h][0]+20) for h in p] for p in picks],'draft_rich')
        # Historical player selection frequency and historical role-free profile.
        comfort=[]; continuity=[]
        for ix in range(2):
            pairs=list(zip(accounts[ix],picks[ix])) if valid_accounts else []
            comfort.append([sum(v[1]==h for v in self.player_recent[p])/max(1,len(self.player_recent[p])) for p,h in pairs])
            past=self.rosters[teams[ix]]
            continuity.append([len(set(accounts[ix]) & old)/5 for old in past] if valid_accounts else [])
        sides('player_hero_recent_pick_share',comfort,'comfort')
        sides('roster_overlap_last20',continuity,'comfort')

        for k in STYLE:
            a,bb=profiles[0][k],profiles[1][k]
            put(k+'_team_mean_diff',a-bb,'team_style')
            put(k+'_team_pair_mean',(a+bb)/2,'team_style')
            put(k+'_team_pair_product',a*bb/(SCALES[k]**2),'style_interaction')
            recent=[]; volatility=[]; adjustments=[]; responses=[]; residuals=[]; effn=[]
            draft_values=[]; player_values=[]
            for ix in range(2):
                games=self.past_team(teams[ix],now)
                vv=[v['style'].get(k) for v in games[-20:]]
                recent.append(avg(v['style'].get(k) for v in games[-5:])-avg(vv))
                volatility.append(stats(vv)['std'])
                adjustments.append(avg(v['style'][k]-v['opponent'][k] for v in games[-20:]
                                       if finite(v['style'].get(k)) and finite(v['opponent'].get(k))))
                target=profiles[1-ix][k]
                usable=[v for v in games if finite(v['opponent'].get(k)) and finite(target)]
                ww=[math.exp(-.5*((v['opponent'][k]-target)/SCALES[k])**2)*2**(-(now-v['at'])/(90*DAY)) for v in usable]
                sw=sum(ww)
                responses.append((10+sum(w*v['won'] for w,v in zip(ww,usable)))/(20+sw))
                residuals.append(sum(w*(v['won']-v['prior']) for w,v in zip(ww,usable))/(20+sw))
                effn.append(math.log1p(sw))
                draft_values.append([avg(v.get(k) for v in self.hero_perf[h]) for h in picks[ix]])
                pairs=list(zip(accounts[ix],picks[ix])) if valid_accounts else []
                player_values.append([avg(v.get(k) for v in self.playerhero_perf[(p,h)]) for p,h in pairs])
            put(k+'_team_recent_trend_diff',recent[0]-recent[1],'team_style')
            put(k+'_team_volatility_diff',volatility[0]-volatility[1],'team_style')
            put(k+'_past_vs_opponent_diff',adjustments[0]-adjustments[1],'style_interaction')
            put(k+'_response_to_opponent_style_diff',responses[0]-responses[1],'style_response')
            put(k+'_elo_residual_vs_style_diff',residuals[0]-residuals[1],'style_response_elo')
            put(k+'_response_min_log_n',min(effn),'style_response')
            sides(k+'_draft_profile',draft_values,'draft_style')
            sides(k+'_playerhero_profile',player_values,'comfort_style')
            dp=[avg(v) for v in draft_values]
            put(k+'_team_draft_fit_diff',abs(a-dp[0])-abs(bb-dp[1]),'style_interaction')
            put(k+'_draft_vs_opponent_team_diff',(dp[0]-bb)-(dp[1]-a),'style_interaction')
        return values,current_context

    def update(self,m,context):
        now=m['start_time']+m['duration']+300; won=int(m['radiant_win'])
        picks=[m.get('radiant_picks') or [],m.get('dire_picks') or []]
        accounts=[m.get('radiant_account_ids') or [],m.get('dire_account_ids') or []]
        teams=[m['radiant_team_id'],m['dire_team_id']]
        styles=m.get('historical_style') or [{},{}]
        player_styles=m.get('historical_players') or {}
        draft_ok=valid_picks(picks[0],picks[1])
        roster_ok=(draft_ok and len(accounts[0])==len(accounts[1])==5
                   and len(set(accounts[0]+accounts[1]))==10
                   and all(type(p) is int and 0<p<4294967295 for p in accounts[0]+accounts[1]))
        for ix,t in enumerate(teams):
            outcome=won if ix==0 else 1-won
            minutes=m['duration']/60
            kills=m.get('radiant_score' if ix==0 else 'dire_score')
            deaths=m.get('dire_score' if ix==0 else 'radiant_score')
            style={**(styles[ix] or {}), 'duration_min':minutes,
                   'kills_pm':kills/minutes/5 if finite(kills) else None,
                   'deaths_pm':deaths/minutes/5 if finite(deaths) else None}
            for item in ('blink','bkb'):
                side_data=[player_styles.get(str(h),player_styles.get(h)) for h in picks[ix]]
                if draft_ok and len(side_data)==5 and all(side_data):
                    style[item+'_purchase_share']=sum(finite(v['style'].get(item+'_min')) for v in side_data)/5
            self.team_games[t].append({'at':now,'won':outcome,'style':style,
                'opponent':context['profiles'][1-ix], 'prior':context['prior'] if ix==0 else 1-context['prior']})
            for half,tables in self.rates.items() if draft_ok else []:
                for h in picks[ix]:
                    tables['hero'].add(h,now,outcome);tables['teamhero'].add((t,h),now,outcome)
                for pair in combinations(picks[ix],2): tables['synergy'].add(tuple(sorted(pair)),now,outcome)
                for p,h in zip(accounts[ix],picks[ix]) if roster_ok else []:
                    if type(p) is int and 0<p<4294967295:
                        tables['player'].add(p,now,outcome);tables['playerhero'].add((p,h),now,outcome)
                for h in picks[ix]:
                    for other in picks[1-ix]: tables['counter'].add((h,other),now,outcome)
            if roster_ok:
                self.rosters[t].append(set(accounts[ix]))
            for p,h in zip(accounts[ix],picks[ix]) if roster_ok else []:
                if type(p) is int and 0<p<4294967295:self.player_recent[p].append((now,h))
            # Projected parsed values are indexed by hero identity, not array order.
            for h in picks[ix] if draft_ok else []:
                data=player_styles.get(str(h),player_styles.get(h))
                if data:
                    individual_style=dict(data['style'])
                    for item in ('blink','bkb'):
                        individual_style[item+'_purchase_share']=float(finite(individual_style.get(item+'_min')))
                    self.hero_perf[h].append(individual_style)
                    p=data.get('account_id')
                    if type(p) is int and 0<p<4294967295:self.playerhero_perf[(p,h)].append(individual_style)
        sanitized=dict(m)
        if not draft_ok:
            sanitized['radiant_picks']=None;sanitized['dire_picks']=None
        if not roster_ok:
            sanitized['radiant_account_ids']=None;sanitized['dire_account_ids']=None
        historical_players=[]
        for ix in range(2):
            side=[]
            for p,h in zip(accounts[ix],picks[ix]) if roster_ok else []:
                data=player_styles.get(str(h),player_styles.get(h,{}))
                role=data.get('style',{}).get('role') if data.get('account_id')==p else None
                side.append({'account_id':p,'hero_id':h,'lane_role':role})
            historical_players.append(side)
        self.individual.update(historical_players[0],historical_players[1],bool(won),now,
                               started_at=m['start_time'],match_id=m['match_id'])
        self.basic.update(sanitized)
