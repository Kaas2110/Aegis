"""Small causal/game-semantic primitives; missing inputs return explicit reasons.

These are proposed feature calculations, not models or claims of causal effects.
Gold rate needs *player cumulative earned gold*, never team lead or net worth.
Roles remain probabilities tagged inferred; lane_role never becomes position1..5.
"""
import math

def finite(x):return type(x) in (int,float) and math.isfinite(x)
def missing(reason):return {'value':None,'reason':reason}

def player_gpm_from_earned(measurement,game_time_sec):
    if measurement.get('metric')!='cumulative_earned_gold_since_start':return missing('requires_player_earned_gold_not_lead_or_networth')
    if any(type(measurement.get(k)) is not int or measurement[k]<=0 for k in ('player_id','hero_id')):return missing('player_hero_identity_missing')
    if not finite(game_time_sec) or game_time_sec<=0:return missing('positive_game_clock_required')
    value,baseline=measurement.get('value'),measurement.get('baseline_at_game_start')
    if not finite(value) or not finite(baseline) or value<baseline:return missing('earned_gold_baseline_or_monotonicity_unknown')
    if measurement.get('game_time_sec')!=game_time_sec:return missing('gold_clock_mismatch')
    return {'value':(value-baseline)/(game_time_sec/60),'unit':'gold_per_minute','meaning':'cumulative player earned-gold rate; not rolling/current GPM','reason':None}

def rolling_player_gpm(earlier,later):
    if any(m.get('metric')!='cumulative_earned_gold_since_start' for m in (earlier,later)):return missing('requires_player_earned_gold')
    if any(type(m.get(k)) is not int or m[k]<=0 for m in (earlier,later) for k in ('player_id','hero_id')) or earlier.get('player_id')!=later.get('player_id') or earlier.get('hero_id')!=later.get('hero_id'):return missing('player_hero_identity_mismatch')
    t0,t1=earlier.get('game_time_sec'),later.get('game_time_sec');v0,v1=earlier.get('value'),later.get('value')
    if not all(finite(v) for v in (t0,t1,v0,v1)) or t1<=t0 or v1<v0:return missing('invalid_or_nonmonotone_earned_timeline')
    return {'value':(v1-v0)/((t1-t0)/60),'unit':'gold_per_minute','window_seconds':t1-t0,'reason':None}

def contextual_gpm_z(gpm,hero_id,role_probabilities,minute,patch,norms,decision_at,target_match_id,minimum_history=30):
    """Mixture moments across inferred roles; require all nonzero-role norms.

    Norms are keyed by role1..5; each row explicitly identifies hero/minute/patch,
    excludes target, and was available before decision. No patch-agnostic fallback.
    A smoothed fallback is allowed only as a separately named validated contract.
    """
    if not finite(gpm) or gpm<0:return missing('invalid_player_gpm')
    if not finite(minute) or minute<0 or not finite(decision_at) or not isinstance(role_probabilities,list) or type(hero_id) is not int or hero_id<=0:return missing('invalid_context')
    if len(role_probabilities)!=5 or any(not finite(p) or p<0 or p>1 for p in role_probabilities) or abs(sum(role_probabilities)-1)>1e-6:return missing('invalid_inferred_role_distribution')
    selected=[]
    for role,prob in enumerate(role_probabilities,1):
        if prob==0:continue
        row=norms.get(str(role)) or norms.get(role)
        if not isinstance(row,dict):return missing('missing_role_conditioned_norm')
        if row.get('hero_id')!=hero_id or row.get('minute')!=minute or row.get('patch')!=patch or row.get('unit')!='gold_per_minute':return missing('norm_context_or_unit_mismatch')
        if row.get('target_match_id')!=target_match_id or row.get('excludes_target_match') is not True:return missing('norm_target_exclusion_unverified')
        if not finite(row.get('available_at')) or row['available_at']>decision_at or not finite(row.get('max_history_completed_at')) or row['max_history_completed_at']>=decision_at:return missing('future_or_unknown_norm_availability')
        if not finite(row.get('effective_n')) or row['effective_n']<minimum_history:return missing('sparse_norm')
        mean,sd=row.get('mean'),row.get('sd')
        if not finite(mean) or not finite(sd) or sd<=0:return missing('invalid_norm_moments')
        selected.append((prob,mean,sd))
    mean=sum(p*m for p,m,s in selected);variance=sum(p*(s*s+m*m) for p,m,s in selected)-mean*mean
    if variance<=0:return missing('zero_norm_variance')
    return {'value':(gpm-mean)/math.sqrt(variance),'unit':'standard_deviations','role_status':'inferred_distribution',
            'reference_mean':mean,'reference_sd':math.sqrt(variance),'minute':minute,'patch':patch,'reason':None}

def first_purchase_timing(item,events,minute,historical_median,events_complete):
    if not isinstance(events,list) or not finite(minute) or minute<0:return missing('purchase_events_missing')
    valid=[e for e in events if e.get('item')==item and finite(e.get('game_time_sec')) and e['game_time_sec']<=minute*60]
    if not finite(historical_median):return missing('historical_item_timing_missing')
    if valid:
        first=min(e['game_time_sec'] for e in valid)/60
        return {'value':historical_median-first,'unit':'minutes_earlier_than_historical_median','purchased':True,
                'current_inventory_or_cooldown_known':False,'reason':None}
    if events_complete is not True:return missing('absence_of_purchase_not_verified')
    return {'value':minute-historical_median,'unit':'minutes_past_historical_median_without_purchase','purchased':False,
            'right_censored':True,'current_inventory_or_cooldown_known':False,'reason':None}

def style_interaction(aggression_z,opponent_farm_dependence_z,draft_early_pressure_z,minutes):
    if not all(finite(v) for v in (aggression_z,opponent_farm_dependence_z,draft_early_pressure_z,minutes)) or minutes<0:return missing('style_or_draft_profile_missing')
    return {'value':aggression_z*opponent_farm_dependence_z*draft_early_pressure_z,
            'unit':'product_of_standardized_asof_profiles','game_minutes':minutes,
            'meaning':'mechanism-motivated interaction; no hand-set win-probability effect','reason':None}

def phase_bucket(game_time_sec):
    if not finite(game_time_sec) or game_time_sec<0:return None
    minute=game_time_sec/60
    return '80+' if minute>=80 else str(int(minute//5)*5)
