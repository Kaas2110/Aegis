"""Causal current-map mixture; BO1/3/5, side changes and explicit unknowns."""
import math
from datetime import datetime,timezone
FLAGS={'active':False,'eligibleForServing':False,'eligibleForPromotion':False,'eligibleForQualityClaims':False,'prospectiveValidated':False}
class Refusal(ValueError):pass
def fail(code):raise Refusal('seriesdiag_'+code)
def require(ok,code):
 if not ok:fail(code)
def timestamp(value):
 require(type(value)is str,'aware_timestamp_required')
 try:x=datetime.fromisoformat(value.replace('Z','+00:00'))
 except (ValueError,TypeError):fail('aware_timestamp_required')
 require(x.tzinfo is not None and x.utcoffset()is not None,'aware_timestamp_required');return x.timestamp()
def iso(value):return datetime.fromtimestamp(value,timezone.utc).isoformat()
def positive(value):return type(value)is int and 0<value<=2**53-1
def probability(value):
 require(type(value)in(int,float) and math.isfinite(value) and 0<=value<=1,'invalid_probability');return float(value)
def context(c):
 require(type(c)is dict and set(c)=={'seriesId','matchId','teamAId','teamBId','radiantTeamId','direTeamId','bestOf','winsA','winsB','currentMapNumber','status','sourceConfirmed'},'confirmed_context_schema')
 require(c['sourceConfirmed']is True and all(positive(c[k])for k in ('seriesId','matchId','teamAId','teamBId','radiantTeamId','direTeamId')),'confirmed_series_identity')
 require(c['teamAId']!=c['teamBId'] and {c['teamAId'],c['teamBId']}=={c['radiantTeamId'],c['direTeamId']},'team_pair_orientation')
 bo=c['bestOf'];require(type(bo)is int and bo in(1,3,5),'confirmed_BO1_BO3_BO5_required');target=bo//2+1
 a,b=c['winsA'],c['winsB'];require(all(type(x)is int and 0<=x<=target for x in(a,b)) and not(a==b==target),'invalid_series_score')
 terminal=a==target or b==target
 require(c['status']in('live','finished') and (c['status']=='finished')==terminal,'score_status_conflict')
 require(c['currentMapNumber']is None if terminal else type(c['currentMapNumber'])is int and c['currentMapNumber']==a+b+1 and c['currentMapNumber']<=bo,'score_map_number_mismatch')
 return {'target':target,'terminal':terminal,'deciding':not terminal and a==b==target-1,'aIsRadiant':c['teamAId']==c['radiantTeamId'],'winClinchesA':a==target-1,'lossEliminatesA':b==target-1}
def live_estimate(c,live,now):
 require(type(live)is dict and set(live)=={'contract','matchId','seriesId','radiantTeamId','direTeamId','probabilityRadiant','modelVersion','sourceStateHash','observedAt','predictedAt','lastStateChangeReceivedAt','guardsPassed'},'live_estimate_schema')
 require(live['contract']=='server.guarded.live-map-estimate.v1' and live['guardsPassed']is True,'guarded_live_estimate_required')
 require(all(live[k]==c[k]for k in('matchId','seriesId','radiantTeamId','direTeamId')),'live_estimate_identity_mismatch')
 require(type(live['modelVersion'])is str and bool(live['modelVersion']) and type(live['sourceStateHash'])is str and len(live['sourceStateHash'])==64,'live_estimate_provenance')
 times=[timestamp(live[k])for k in('observedAt','predictedAt','lastStateChangeReceivedAt')]
 require(all(t<=now+5 and 0<=now-t<180 for t in times),'live_estimate_stale_or_future')
 # Fresh timestamps must also describe a causal computation of this state.
 require(times[2]<=times[0]<=times[1],'live_estimate_noncausal_timestamps')
 p=probability(live['probabilityRadiant']);return (p if c['teamAId']==c['radiantTeamId']else 1-p),min(times)+180
def unavailable(code,c=None,live_map=None):
 return {'contract':'series14255.live-composition.diagnostic.v1','status':'unavailable','reason':code,'context':c,'mainCard':{'seriesProbabilityTeamA':None,'seriesProbabilityTeamB':None},'details':{'currentMapProbabilityTeamA':live_map,'futureMaps':[]},**FLAGS}
def compose(c,live,*,q_won_a=None,q_lost_a=None,binding=None,now):
 s=context(c)
 if s['terminal']:
  return {'contract':'series14255.live-composition.diagnostic.v1','status':'observed_terminal','reason':'observed_result_is_not_a_forecast','context':c,'mainCard':{'seriesProbabilityTeamA':None,'seriesProbabilityTeamB':None},'observedWinnerTeamId':c['teamAId']if c['winsA']==s['target']else c['teamBId'],'details':{'currentMapProbabilityTeamA':None,'futureMaps':[]},**FLAGS}
 p,expires=live_estimate(c,live,now)
 if not(s['winClinchesA']and s['lossEliminatesA']):
  if binding is None:return unavailable('seriesdiag_exact14255_actual_start_producer_unavailable',c,p)
  require(binding.get('scope')=='explicit_cv_fold3_diagnostic_not_final_fit' and binding.get('features')==14255,'rich_conditional_binding_required')
 qw=1. if s['winClinchesA']else probability(q_won_a);ql=0. if s['lossEliminatesA']else probability(q_lost_a);series=p*qw+(1-p)*ql
 future=[{'mapNumber':m,'mayBePlayed':True,'probabilityTeamA':None,'reason':'conditional_series_heads_do_not_identify_individual_future_map_probability'}for m in range(c['currentMapNumber']+1,c['bestOf']+1)]
 return {'contract':'series14255.live-composition.diagnostic.v1','status':'diagnostic_ready','reason':None,'context':c,'mainCard':{'seriesProbabilityTeamA':series,'seriesProbabilityTeamB':1-series,'basis':'deciding_map_identity'if s['deciding']else'rich_start_conditional_series_branches_plus_guarded_live_map','expiresAt':iso(expires)},'details':{'currentMapNumber':c['currentMapNumber'],'currentMapProbabilityTeamA':p,'currentMapProbabilityTeamB':1-p,'currentMapModelVersion':live['modelVersion'],'futureMaps':future,'conditionalSeriesIfCurrentWonTeamA':qw,'conditionalSeriesIfCurrentLostTeamA':ql,'branchOrderViolation':qw<ql},'modelBinding':binding,'liveObservedAt':live['observedAt'],'generatedAt':iso(now),'limitations':['q heads condition on current-map-start state and hypothetical outcome; live-P substitution is unvalidated conditional-transport assumption','q heads are series probabilities, not next-map probabilities','explicit CV fold diagnostic; no final fit, no ensemble or independent quality claim'],**FLAGS}
