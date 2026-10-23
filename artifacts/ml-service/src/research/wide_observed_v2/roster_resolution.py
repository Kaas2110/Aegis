"""Pure stdlib v2 identity side channel and 600s state projection; no inference.

pinned_lineage_v1.py is an exact frozen dependency copy. No raw rows, players,
hashes, anchor prior vectors, or feature definitions are rewritten here.
"""
import math
from src.research.wide_observed.lineage import Refusal, verify, integer, stamp, source_row, state, dto_equal

POLICY='wide.observed-history.600s.immutable-roster.v2'

def triples(p, full):
 if not integer(p.get('radiantTeamId'),1) or not integer(p.get('direTeamId'),1) or p['radiantTeamId']==p['direTeamId']:
  raise Refusal('team_identity_missing_or_conflicting')
 players=p.get('players')
 if not isinstance(players,list) or not 1<=len(players)<=10 or (full and len(players)!=10):raise Refusal('roster_count_invalid')
 out=[]
 for x in players:
  if not isinstance(x,dict) or not integer(x.get('team')) or x['team']>1 or not integer(x.get('heroId'),1) or x['heroId']>250 or not integer(x.get('accountId'),1) or x['accountId']>=4294967295:
   raise Refusal('player_identity_missing_or_unsupported')
  out.append([x['team'],x['heroId'],x['accountId']])
 n=sum(x[0]==0 for x in out)
 if n>5 or len(out)-n>5 or (full and n!=5) or len({x[1] for x in out})!=len(out) or len({x[2] for x in out})!=len(out):
  raise Refusal('roster_duplicate_or_side_count')
 return sorted(out)

def verify_anchor(anchor):
 times=verify(anchor);p=anchor['input'];ids=triples(p,True);clock=anchor['game_time_sec']
 if not integer(clock,-3600) or clock>=60:raise Refusal('anchor_creation_clock_unsupported')
 if anchor.get('phase')!=('post_draft' if clock<0 else 'live'):raise Refusal('anchor_phase_invalid')
 if not isinstance(anchor.get('availability'),dict) or anchor['availability'].get('outcomeKnownAtCapture') is not False:
  raise Refusal('anchor_capture_outcome_not_false')
 return times,ids,[p['radiantTeamId'],p['direTeamId'],ids]

def resolve_roster(row,anchor):
 t=verify(row);at,ids,ident=verify_anchor(anchor)
 if row['match_id']!=anchor['match_id']:raise Refusal('anchor_map_mismatch')
 if at[0]>t[0] or at[1]>t[1]:raise Refusal('identity_anchor_after_observation')
 p=row['input'];present=triples(p,False)
 if p['radiantTeamId']!=anchor['input']['radiantTeamId'] or p['direTeamId']!=anchor['input']['direTeamId']:raise Refusal('anchor_team_or_side_changed')
 keys={tuple(x) for x in ids}
 if any(tuple(x) not in keys for x in present):raise Refusal('anchor_player_identity_contradiction')
 have={tuple(x) for x in present}
 return dict(policy=POLICY,identity=ident,anchorSource=source_row(anchor),observationSource=source_row(row),
  observedPlayerCount=len(present),observedSideCounts=[sum(x[0]==0 for x in present),sum(x[0]==1 for x in present)],
  identityResolution='complete_current_packet' if len(present)==10 else 'verified_subset_of_observed_anchor',
  missingIdentityTriples=[x for x in ids if tuple(x) not in have],currentPlayerStatisticsReconstructed=False,
  rawInputPreserved=True,sourceDatabaseOriginVerified=False,servingEligibilityAssessed=False,coverage95Validated=False)

def project(current,candidates,anchor,*,query_truncated):
 if query_truncated is not False:raise Refusal('source_query_truncated_or_unknown')
 if not isinstance(candidates,list) or len(candidates)>1024:raise Refusal('history_count_bound')
 total=0
 for row in [anchor,current,*candidates]:
  raw=row.get('canonicalInputJson') if isinstance(row,dict) else None
  if not isinstance(raw,str):raise Refusal('canonical_input_bound')
  total+=len(raw.encode('utf8'))
  if total>8*1024*1024:raise Refusal('history_total_source_bytes_bound')
 cutoff=verify(current);at,_,_=verify_anchor(anchor);resolution=resolve_roster(current,anchor);c=state(current)
 if c is None:raise Refusal('clock_score_invalid')
 eligible=[];seen=set();excluded=[];resolutions={}
 for row in candidates:
  t=verify(row);reason=None
  if row['match_id']!=current['match_id']:reason='different_map'
  elif t[0]>cutoff[0] or t[1]>cutoff[1]:reason='after_current_cutoff'
  elif row['id']==current['id'] or row['id'] in seen:reason='duplicate_observation'
  elif t[0]<at[0] or t[1]<at[1]:reason='before_identity_anchor'
  if reason:excluded.append(dict(id=row['id'],reason=reason));continue
  rr=resolve_roster(row,anchor)
  if state(row,True) is None:raise Refusal('clock_score_invalid')
  seen.add(row['id']);eligible.append(row);resolutions[row['id']]=rr
 eligible.sort(key=lambda r:(stamp(r['received_at']),stamp(r['recorded_at']),r['id']))
 lower=max(0,c['clock_seconds']-600);previous=None
 def reg(a,b):return b['clock_seconds']<a['clock_seconds'] or b['radiant_kills']<a['radiant_kills'] or b['dire_kills']<a['dire_kills']
 for row in eligible:
  s=state(row,True)
  if previous and reg(previous,s) and (previous['clock_seconds']<lower or s['clock_seconds']<lower):raise Refusal('history_regression_crosses_clock_window')
  previous=s
 retained=[];segment={};previous=None;resets=0
 for row in eligible:
  if row['game_time_sec']<lower:excluded.append(dict(id=row['id'],reason='outside_clock_window'));continue
  s=state(row)
  if previous and reg(previous,s):retained.extend(segment.values());segment={};resets+=1
  old=segment.get(s['clock_seconds'])
  if old:excluded.append(dict(id=old['id'],reason='superseded_same_clock_within_forward_segment'))
  segment[s['clock_seconds']]=row;previous=s
 retained.extend(segment.values())
 if len(retained)>256 and resets:raise Refusal('history_regression_evidence_exceeds_capacity')
 truncated=len(retained)>256
 if truncated:
  excluded.extend(dict(id=r['id'],reason='history_capacity') for r in retained[:-256]);retained=retained[-256:]
 return dict(status='projected',reason=None,current=c,history=[state(r) for r in retained],sourceRows=[source_row(r) for r in retained],
  rosterResolution=dict(current=resolution,history=[resolutions[r['id']] for r in retained],anchorSource=source_row(anchor)),
  diagnostics=dict(policy=POLICY,candidateCount=len(candidates),retainedCount=len(retained),lookbackGameSeconds=600,
   maxHistory=256,truncated=truncated,sourceIdentityConflict=False,regressionSegments=resets,servingEligibilityAssessed=False,
   coverage95Validated=False,currentPlayerStatisticsReconstructed=False,excluded=excluded))

def verify_projection(claim,current,candidates,anchor,*,query_truncated):
 actual=project(current,candidates,anchor,query_truncated=query_truncated)
 if not dto_equal(claim,actual):raise Refusal('v2_selector_dto_binding')
 return actual

def gate_projection_current(row,anchor,*,now_epoch_seconds,capture_outcome_known,outcome_known_at_read):
 """Same original current freshness/outcome/phase gate, with v2 identity only.

 This does not validate/persist a prior7148 anchor or DB provenance. The caller
 must load its existing AnchorStore first and pass anchor['anchorObservation'].
 """
 received,recorded=verify(row)
 if type(now_epoch_seconds) not in (int,float) or not math.isfinite(now_epoch_seconds):raise Refusal('now_invalid')
 if capture_outcome_known is not False or outcome_known_at_read is not False:raise Refusal('outcome_unknown_or_known')
 if not isinstance(row.get('availability'),dict) or row['availability'].get('outcomeKnownAtCapture') is not False:
  raise Refusal('capture_outcome_binding')
 if recorded/1000>now_epoch_seconds or not 0<=now_epoch_seconds-received/1000<=180:raise Refusal('current_receipt_future_or_stale')
 if not integer(row['game_time_sec'],300):raise Refusal('unsupported_projection_phase')
 if row.get('phase')!='live':raise Refusal('phase_mismatch')
 return resolve_roster(row,anchor)
