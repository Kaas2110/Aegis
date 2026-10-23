"""Pure feature-admission audit; no provider/DB calls, fitting, masking or activation.

Inputs are predeclared supported strata and *all* sampled opportunities, including
missing/error packets. Do not generate this denominator from successful forecasts.
One opportunity = map + phase + checkpoint, sampled every5min;80+ uses one tail
stratum while the actual clock continues85/90/.... This is a measurement grid,
not a requirement to train one model per minute.
"""
from __future__ import annotations
import argparse
from collections import Counter,defaultdict
from datetime import datetime
import hashlib,json,math
from pathlib import Path
import numpy as np

VERSION='feature-admission-v1'
THRESHOLD=.95
Z95=1.959963984540054

def finite(x):return type(x) in (int,float) and math.isfinite(x)
def stamp(x):
    if finite(x):return float(x) if x>0 else None
    if isinstance(x,str):
        try:x=datetime.fromisoformat(x.replace('Z','+00:00'))
        except ValueError:return None
    if isinstance(x,datetime) and x.tzinfo is not None:return x.timestamp()
    return None
def digest(x):return hashlib.sha256(json.dumps(x,sort_keys=True,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode()).hexdigest()

def value_valid(value,kind):
    if kind=='number':return finite(value)
    if kind=='nonnegative':return finite(value) and value>=0
    if kind=='probability':return finite(value) and 0<=value<=1
    if kind=='pair_ids':return isinstance(value,list) and len(value)==2 and all(type(x) is int and x>0 for x in value) and len(set(value))==2
    if kind=='draft':return (isinstance(value,list) and len(value)==10 and all(isinstance(p,dict) and type(p.get('hero_id')) is int and p['hero_id']>0 and type(p.get('team')) is int and p['team'] in (0,1) for p in value) and sum(p['team']==0 for p in value)==5 and len({p['hero_id'] for p in value})==10)
    if kind=='roster':return value_valid(value,'draft') and all(type(p.get('account_id')) is int and p['account_id']>0 for p in value) and len({p['account_id'] for p in value})==10
    if kind=='ten_nonnegative':return isinstance(value,list) and len(value)==10 and all(finite(v) and v>=0 for v in value)
    if kind=='role_probs':return (isinstance(value,list) and len(value)==10 and all(isinstance(p,list) and len(p)==5 and all(finite(v) and 0<=v<=1 for v in p) and abs(sum(p)-1)<1e-6 for p in value))
    if kind=='object':return isinstance(value,dict) and bool(value)
    if kind=='events':return isinstance(value,list) # [] is an observed empty set, not missing
    if kind=='string':return isinstance(value,str) and bool(value)
    raise ValueError('unknown_value_kind:'+kind)

def validate_catalog(catalog):
    fields=catalog['fields'];families=catalog['families'];seen=set()
    def visit(name,stack):
        if name not in fields:raise ValueError('unknown_dependency:'+name)
        if name in stack:raise ValueError('cyclic_dependency:'+name)
        if name in seen:return
        for dep in fields[name]['dependencies']:visit(dep,stack|{name})
        seen.add(name)
    for name in fields:visit(name,set())
    for family in families.values():
        for name in family['required_fields']:
            if name not in fields:raise ValueError('unknown_family_field:'+name)

def assess_field(case,name,catalog,memo=None):
    """Return diagnostics while retaining values in caller; never zero/mask the row."""
    memo={} if memo is None else memo
    if name in memo:return memo[name]
    contract=catalog['fields'][name];ev=case.get('fields',{}).get(name)
    dependencies={n:assess_field(case,n,catalog,memo) for n in contract['dependencies']}
    out={'present_valid':False,'causal_available':False,'receipt_fresh':False,'progression_fresh':False,'event_fresh':None,'timely_available':False,
         'computable_dependencies_timely':bool(dependencies) and all(d['timely_available'] for d in dependencies.values()),'reasons':[]}
    memo[name]=out
    if case.get('phase') not in contract['phases']:out['reasons'].append('phase_not_allowed');return out
    if not isinstance(ev,dict) or ev.get('value') is None:out['reasons'].append('missing');return out
    if ev.get('unit')!=contract['unit']:out['reasons'].append('unit_mismatch');return out
    if ev.get('source') not in contract['sources']:out['reasons'].append('source_or_semantic_substitution');return out
    if not value_valid(ev['value'],contract['value_kind']):out['reasons'].append('invalid_value');return out
    out['present_valid']=True
    decision=stamp(case.get('decision_at'));available=stamp(ev.get('available_at'))
    if decision is None or available is None or available>decision:out['reasons'].append('unknown_or_future_availability');return out
    if ev.get('availability_mode')!='observed':out['reasons'].append('retrospective_availability_only');return out
    if contract['temporal_kind']=='historical':
        completed=stamp(ev.get('source_max_completed_at'));received=stamp(ev.get('source_max_available_at'))
        if completed is None or received is None or completed>=decision or completed>received or received>available:
            out['reasons'].append('historical_asof_not_proven');return out
        if ev.get('excludes_target_match') is not True or ev.get('target_match_id')!=case.get('map_id'):
            out['reasons'].append('historical_current_map_exclusion_not_proven');return out
    if contract['temporal_kind']=='derived' and ev.get('definition_version')!=contract['definition_version']:
        out['reasons'].append('derived_definition_mismatch');return out
    if any(not d['causal_available'] for d in dependencies.values()):out['reasons'].append('dependency_not_causally_available');return out
    # A derived result cannot claim to exist earlier than its raw prerequisites.
    if any(stamp(case.get('fields',{}).get(dep,{}).get('available_at'))>available for dep in dependencies):
        out['reasons'].append('derived_timestamp_before_dependency');return out
    out['causal_available']=True
    max_receipt=contract.get('max_receipt_age_sec')
    out['receipt_fresh']=(max_receipt is None or decision-available<=max_receipt) and all(d['receipt_fresh'] for d in dependencies.values())
    out['progression_fresh']=all(d['progression_fresh'] for d in dependencies.values())
    if not out['receipt_fresh']:out['reasons'].append('receipt_or_computation_stale')
    if contract['temporal_kind']=='dynamic':
        received=stamp(ev.get('received_at'));progressed=stamp(ev.get('progressed_at'))
        out['receipt_fresh']=received is not None and received<=available and decision-received<=contract.get('max_receipt_age_sec',180) and all(d['receipt_fresh'] for d in dependencies.values())
        out['progression_fresh']=progressed is not None and received is not None and progressed<=received and decision-progressed<=contract.get('max_progression_age_sec',180) and all(d['progression_fresh'] for d in dependencies.values())
        if not out['receipt_fresh']:out['reasons'].append('actual_receipt_unknown_future_or_stale')
        if not out['progression_fresh']:out['reasons'].append('local_observed_progression_unknown_or_stale')
        event=stamp(ev.get('event_at'))
        if ev.get('event_time_verified') is not True or event is None or received is None:
            out['reasons'].append('source_event_freshness_unknown')
        elif event>received or received>available or event>decision:
            out['event_fresh']=False;out['causal_available']=False;out['reasons'].append('future_or_inconsistent_event_time')
        else:
            out['event_fresh']=received-event<=contract.get('max_source_delivery_sec',300)
            if not out['event_fresh']:out['reasons'].append('measured_event_to_receipt_exceeds_policy')
        declared=ev.get('providerDelayRaw')
        if finite(declared) and declared>contract.get('max_source_delivery_sec',300):
            out['event_fresh']=False;out['reasons'].append('declared_broadcast_delay_exceeds_policy')
    elif contract['temporal_kind']=='derived':
        fresh=[d['event_fresh'] for d in dependencies.values()]
        out['event_fresh']=False if False in fresh else None if None in fresh else True
    else:
        out['event_fresh']=True # old *completed* matches are legitimate prior evidence
    out['timely_available']=bool(out['causal_available'] and out['receipt_fresh'] and out['progression_fresh'] and out['event_fresh'] is True)
    return out

def wilson(successes,n):
    if not n:return None
    phat=successes/n;den=1+Z95**2/n;mid=(phat+Z95**2/(2*n))/den
    half=Z95*math.sqrt(phat*(1-phat)/n+Z95**2/(4*n*n))/den
    return [max(0.,mid-half),min(1.,mid+half)]

def coverage(values,cases,minimum_maps=100,minimum_series=30,repeats=1000):
    """Opportunity rate, plus map-balanced diagnostic and whole-series uncertainty."""
    n=len(cases)
    if not n:return {'n_cases':0,'n_maps':0,'n_series':0,'rate':None,'status':'no_samples','pass':False,'ci95':None}
    v=np.asarray(values,dtype=float);groups=defaultdict(list);maps=defaultdict(list)
    known=True
    for i,c in enumerate(cases):
        sid=c.get('series_id');valid=type(sid) is int and sid>0;known=known and valid
        groups['series:'+str(sid) if valid else 'unverified-map:'+str(c['map_id'])].append(i);maps[c['map_id']].append(i)
    rate=float(v.mean());wc=wilson(int(v.sum()),n)
    totals=np.array([v[ix].sum() for ix in groups.values()]);sizes=np.array([len(ix) for ix in groups.values()]);ci=None
    if len(groups)>=2:
        rng=np.random.default_rng(42);sample=[]
        for _ in range(repeats):
            ix=rng.integers(0,len(groups),size=len(groups));sample.append(float(totals[ix].sum()/sizes[ix].sum()))
        ci=np.quantile(sample,[.025,.975]).tolist()
    lower=min(wc[0],ci[0]) if ci is not None else wc[0]
    sufficient=len(maps)>=minimum_maps and len(groups)>=minimum_series and known
    status=('insufficient_independent_sample' if not sufficient else 'coverage_below_95' if rate<THRESHOLD else 'lower_confidence_bound_below_95' if lower<THRESHOLD else 'pass')
    return {'n_cases':n,'n_maps':len(maps),'n_series':len(groups),'successes':int(v.sum()),'rate':rate,'wilson95':wc,'series_bootstrap95':ci,'ci95':[lower,max(wc[1],ci[1]) if ci is not None else wc[1]],
            'all_series_verified':known,'map_balanced_rate':float(np.mean([v[ix].mean() for ix in maps.values()])),
            'maps_all_opportunities_available':sum(bool(v[ix].all()) for ix in maps.values()),'status':status,'pass':status=='pass'}

def evaluate(cases,plan,catalog,repeats=1000):
    validate_catalog(catalog)
    if plan.get('threshold')!=THRESHOLD:raise ValueError('required_threshold_is_0.95')
    if plan.get('denominator_origin')!='predeclared_supported_opportunities':raise ValueError('denominator_must_include_failures')
    if plan.get('minimum_maps',100)<100 or plan.get('minimum_series',30)<30:raise ValueError('minimum_evidence_cannot_be_lowered_below100maps30series')
    strata={s['id']:s for s in plan['strata']}
    if len(strata)!=len(plan['strata']) or not strata:raise ValueError('invalid_strata')
    groups=defaultdict(list);seen=set();unsupported=Counter()
    for c in cases:
        identity=(c.get('map_id'),c.get('phase'),c.get('checkpoint'))
        if identity in seen:raise ValueError('duplicate_sampling_opportunity')
        seen.add(identity)
        spec=strata.get(c.get('stratum'))
        if spec is None:unsupported[str(c.get('stratum'))]+=1;continue
        if c.get('phase')!=spec['phase']:raise ValueError('stratum_phase_mismatch')
        cp=c.get('checkpoint')
        if spec['phase']=='live':
            if not finite(cp) or cp%5!=0 or cp<5:raise ValueError('live_measurement_must_use_5min_grid')
            if spec.get('checkpoint')=='80+':
                if cp<80:raise ValueError('tail_starts_at80')
            elif cp!=spec.get('checkpoint'):raise ValueError('checkpoint_stratum_mismatch')
        elif cp!='before_start':raise ValueError('prematch_or_postdraft_checkpoint_invalid')
        if type(c.get('map_id')) is not int or c['map_id']<=0:raise ValueError('invalid_map_id')
        groups[spec['id']].append(c)
    output={}
    for sid,spec in strata.items():
        rows=groups[sid];families=spec['required_families']
        if not families:raise ValueError('empty_required_set_cannot_pass')
        required=set()
        for family in families:
            f=catalog['families'][family]
            if spec['phase'] not in f['phases']:raise ValueError('family_not_allowed_in_phase')
            required.update(f['required_fields'])
        optional=spec.get('candidate_families',[]);allfields=set(required)
        for f in optional:
            if spec['phase'] not in catalog['families'][f]['phases']:raise ValueError('candidate_phase_mismatch')
            allfields.update(catalog['families'][f]['required_fields'])
        stats=[{name:assess_field(c,name,catalog) for name in allfields} for c in rows]
        kw={'minimum_maps':plan.get('minimum_maps',100),'minimum_series':plan.get('minimum_series',30),'repeats':repeats}
        field_reports={}
        for name in sorted(allfields):
            field_reports[name]={metric:coverage([r[name][metric] is True for r in stats],rows,**kw) for metric in ('present_valid','causal_available','receipt_fresh','progression_fresh','event_fresh','timely_available')}
            field_reports[name]['reasons']=dict(Counter(reason for r in stats for reason in r[name]['reasons']))
            field_reports[name]['computable_dependencies_timely']=sum(r[name]['computable_dependencies_timely'] for r in stats)
        family_reports={}
        for family in families+optional:
            fields=catalog['families'][family]['required_fields']
            family_reports[family]=coverage([all(r[f]['timely_available'] for f in fields) for r in stats],rows,**kw)
        joint={m:coverage([all(r[f][m] is True for f in required) for r in stats],rows,**kw) for m in ('present_valid','causal_available','receipt_fresh','progression_fresh','event_fresh','timely_available')}
        output[sid]={'phase':spec['phase'],'checkpoint':spec.get('checkpoint'),'required_families':families,'required_fields':sorted(required),'fields':field_reports,'families':family_reports,'joint_required':joint,
                     'admitted':joint['timely_available']['pass'],'scope_declared_before_measurement':True}
    return {'version':VERSION,'catalog_hash':digest(catalog),'plan_hash':digest(plan),'strata':output,'unsupported_counts':dict(unsupported),
            'status':'pass' if all(s['admitted'] for s in output.values()) else 'not_admitted','threshold':THRESHOLD,
            'no_values_modified_or_imputed':True,'not_accuracy_evaluation':True,'latency_definition':'event_fresh measures verified event-to-receipt; default300sec. receipt/progression default180sec separately. Declared broadcast delay is not measured E2E. Past-window dependencies have explicit longer retention; this does not relax source delivery.',
            'interpretation':'No samples is not pass. Observed coverage and its95% lower bound must both reach95% in every supported stratum and jointly for all required fields. Source freshness is not receipt age; historical priors have separate as-of lineage.'}

def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--cases',required=True,type=Path);p.add_argument('--plan',required=True,type=Path);p.add_argument('--catalog',type=Path,default=Path(__file__).with_name('feature_catalog_v1.json'));p.add_argument('--out',required=True,type=Path);args=p.parse_args(argv)
    result=evaluate(json.loads(args.cases.read_text(encoding='utf-8')),json.loads(args.plan.read_text(encoding='utf-8')),json.loads(args.catalog.read_text(encoding='utf-8')))
    args.out.parent.mkdir(parents=True,exist_ok=True)
    with args.out.open('x',encoding='utf-8') as out:json.dump(result,out,indent=2,ensure_ascii=False,allow_nan=False)
    print(json.dumps({'status':result['status'],'strata':len(result['strata'])}));return 0

if __name__=='__main__':raise SystemExit(main())
