"""Descriptive map/series balanced metrics. No claimed independent holdout or CI."""
import math
from collections import Counter
def binary_metrics(rows,labels,probabilities,group_key='mapId'):
 if len(rows)!=len(labels) or len(rows)!=len(probabilities):raise ValueError('metric_alignment')
 if not rows:return {'rows':0,'maps':0,'groups':0,'metrics':None,'ci95':None,'reason':'empty_supported_cohort'}
 if any(y not in (0,1)for y in labels) or any(not math.isfinite(p) or not 0<=p<=1 for p in probabilities):raise ValueError('binary_metric_values')
 count=Counter(str(r[group_key])for r in rows);weights=[1/len(count)/count[str(r[group_key])]for r in rows];metrics={'accuracy':0.,'brier':0.,'logLoss':0.};bins=[]
 for y,p,w in zip(labels,probabilities,weights):
  c=min(1-1e-15,max(1e-15,p));metrics['accuracy']+=w*((p>=.5)==bool(y));metrics['brier']+=w*(p-y)**2;metrics['logLoss']+=w*(-y*math.log(c)-(1-y)*math.log1p(-c))
 for b in range(10):
  ix=[i for i,p in enumerate(probabilities)if min(9,int(p*10))==b];weight=sum(weights[i]for i in ix)
  bins.append({'lower':b/10,'upper':(b+1)/10,'rows':len(ix),'weight':weight,'meanProbability':sum(weights[i]*probabilities[i]for i in ix)/weight if weight else None,'observedFrequency':sum(weights[i]*labels[i]for i in ix)/weight if weight else None})
 return {'rows':len(rows),'maps':len({str(r['mapId'])for r in rows}),'groups':len(count),'weighting':'equal_'+group_key+'_then_equal_samples','metrics':metrics,'calibrationBins':bins,'ci95':None,'ciReason':'family_evaluator_must_resample_whole_components','noOuterHoldout':True,'prospectiveValidated':False,'publicPromotion':False}
def evaluate(rows,labels,probabilities,*,series=False,conditional=False):
 key='seriesId'if series else'mapId';out={'all':binary_metrics(rows,labels,probabilities,key)}
 groups={'equal_elo_45_55':[i for i,r in enumerate(rows)if r.get('equalElo4555')is True]}
 clocks=sorted({r.get('observedClockSeconds')for r in rows if type(r.get('observedClockSeconds'))is int and r['observedClockSeconds']>=0})
 for clock in clocks:
  if clock<4800 and clock%300==0:groups['minute_'+str(clock//60)]=[i for i,r in enumerate(rows)if r.get('observedClockSeconds')==clock]
 groups['80plus']=[i for i,r in enumerate(rows)if type(r.get('observedClockSeconds'))is int and r['observedClockSeconds']>=4800]
 for name,ix in groups.items():out[name]=binary_metrics([rows[i]for i in ix],[labels[i]for i in ix],[probabilities[i]for i in ix],key)
 return {'contract':'aegis.dynamic-binary-fold-metrics.v1','panels':out,'scope':'TRAIN_inner_conditional_branch_only'if conditional else'TRAIN_inner_validation','completedSeriesAccuracyMeasured':False,'minutePolicy':'exact_saved_checkpoints_only_no_future_interpolation','independentOuterHoldout':False,'publicPromotion':False}
