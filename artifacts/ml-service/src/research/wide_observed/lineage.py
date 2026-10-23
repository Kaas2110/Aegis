"""Verify bounded source bytes and independently reproduce reviewed600s selection."""
from __future__ import annotations
import hashlib,json,math,re
from datetime import datetime,timezone

SCHEMA='56df1c043c1ecb2ea8930c3211c7f754935cdc5079a6e97f520edad34023197b'
POLICY='wide.observed-history.600s.v1'
class Refusal(ValueError):pass
def sha(raw):return hashlib.sha256(raw).hexdigest()
def canonical(v):return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()
def objhash(v):return sha(canonical(v))
def _pairs(items):
 d={}
 for k,v in items:
  if k in d:raise Refusal('duplicate_json_key')
  d[k]=v
 return d
def parse(raw):
 try:return json.loads(raw,object_pairs_hook=_pairs,parse_constant=lambda x:(_ for _ in ()).throw(Refusal('nonfinite_json')))
 except (ValueError,UnicodeError,RecursionError) as e:raise Refusal('invalid_bounded_json') from e
def type_equal(a,b):
 if type(a) is not type(b):return False
 if isinstance(a,dict):return a.keys()==b.keys() and all(type_equal(v,b[k]) for k,v in a.items())
 if isinstance(a,list):return len(a)==len(b) and all(type_equal(x,y) for x,y in zip(a,b))
 return a==b
def integer(v,lo=0):return type(v) is int and lo<=v<=2**53-1
def stamp(v):
 if not isinstance(v,str) or len(v)>64 or not re.search(r'(Z|[+-]\d\d:\d\d)$',v):raise Refusal('timestamp_invalid')
 fraction=re.search(r'\.(\d+)(?:Z|[+-]\d\d:\d\d)$',v)
 if fraction and any(c!='0' for c in fraction[1][3:]):raise Refusal('submillisecond_unsupported')
 try:d=datetime.fromisoformat(v.replace('Z','+00:00'));ms=d.timestamp()*1000
 except (ValueError,OverflowError,OSError) as e:raise Refusal('timestamp_invalid') from e
 if d.tzinfo is None or not math.isfinite(ms):raise Refusal('timestamp_invalid')
 return round(ms)
def iso_ms(ms):return datetime.fromtimestamp(ms/1000,timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
def hex64(v):return isinstance(v,str) and re.fullmatch('[a-f0-9]{64}',v) is not None
def verify(row):
 if not isinstance(row,dict) or not hex64(row.get('id')) or not hex64(row.get('input_hash')) or row.get('schema_hash')!=SCHEMA:raise Refusal('source_hash_or_schema')
 raw=row.get('canonicalInputJson')
 if not isinstance(raw,str) or len(raw)>65536:raise Refusal('canonical_input_bound')
 raw=raw.encode('utf8')
 if len(raw)>65536 or sha(raw)!=row['input_hash'] or not type_equal(parse(raw),row.get('input')):raise Refusal('canonical_input_binding')
 p=row['input']
 if not isinstance(p,dict):raise Refusal('source_input_object_required')
 received=stamp(row.get('received_at'));recorded=stamp(row.get('recorded_at'))
 if received>recorded or objhash({'contract':SCHEMA,'inputHash':row['input_hash'],'receivedAt':iso_ms(received)})!=row['id']:raise Refusal('observation_id_or_time')
 if not integer(row.get('match_id'),1) or type(p.get('matchId')) is not int or p['matchId']!=row['match_id'] or type(p.get('gameTimeSec')) is not type(row.get('game_time_sec')) or p.get('gameTimeSec')!=row.get('game_time_sec'):raise Refusal('denormalized_identity')
 for part in (row,p):
  if part.get('synthetic') is True or part.get('backfill') is True or part.get('betweenMaps') is True or part.get('source') in ('synthetic','backfill'):raise Refusal('nonactual_source')
 return received,recorded
def identity(row):
 p=row['input'];a=p.get('players')
 if not integer(p.get('radiantTeamId'),1) or not integer(p.get('direTeamId'),1) or p['radiantTeamId']==p['direTeamId'] or not isinstance(a,list) or len(a)!=10:return None
 if any(not isinstance(x,dict) or type(x.get('team')) is not int or x['team'] not in (0,1) or not integer(x.get('heroId'),1) or not integer(x.get('accountId'),1) for x in a):return None
 if sum(x['team']==0 for x in a)!=5 or len({x['heroId'] for x in a})!=10 or len({x['accountId'] for x in a})!=10:return None
 return [p['radiantTeamId'],p['direTeamId'],sorted([[x['team'],x['heroId'],x['accountId']] for x in a])]
def state(row,pre=False):
 p=row['input']
 if not integer(p.get('gameTimeSec'),-3600 if pre else 0) or not integer(p.get('radiantScore')) or not integer(p.get('direScore')):return None
 return dict(match_id=row['match_id'],clock_seconds=p['gameTimeSec'],radiant_kills=p['radiantScore'],dire_kills=p['direScore'],available_at=stamp(row['received_at'])/1000)
def source_row(r):return dict(id=r['id'],inputHash=r['input_hash'],schemaHash=r['schema_hash'],receivedAt=r['received_at'],recordedAt=r['recorded_at'])
def project(current,candidates,*,query_truncated):
 if query_truncated is not False:raise Refusal('source_query_truncated_or_unknown')
 if not isinstance(candidates,list) or len(candidates)>1024:raise Refusal('history_count_bound')
 total=0
 for row in [current,*candidates]:
  raw=row.get('canonicalInputJson') if isinstance(row,dict) else None
  if not isinstance(raw,str) or len(raw)>65536:raise Refusal('canonical_input_bound')
  total+=len(raw.encode('utf8'))
  if total>8*1024*1024:raise Refusal('history_total_source_bytes_bound')
 cutoff=verify(current);c=state(current);ident=identity(current)
 if not c or ident is None:raise Refusal('current_state_or_identity_missing')
 eligible=[];seen=set();conflict=False
 for row in candidates:
  t=verify(row)
  if row['match_id']!=current['match_id'] or t[0]>cutoff[0] or t[1]>cutoff[1] or row['id']==current['id'] or row['id'] in seen:continue
  ri=identity(row)
  if ri is None:continue
  if ri!=ident:conflict=True;continue
  if state(row,True) is None:continue
  seen.add(row['id']);eligible.append(row)
 if conflict:raise Refusal('draft_anchor_revalidation_required')
 eligible.sort(key=lambda r:(stamp(r['received_at']),stamp(r['recorded_at']),r['id']))
 lower=max(0,c['clock_seconds']-600);previous=None
 def reg(a,b):return b['clock_seconds']<a['clock_seconds'] or b['radiant_kills']<a['radiant_kills'] or b['dire_kills']<a['dire_kills']
 for row in eligible:
  s=state(row,True)
  if previous and reg(previous,s) and (previous['clock_seconds']<lower or s['clock_seconds']<lower):raise Refusal('history_regression_crosses_clock_window')
  previous=s
 retained=[];segment={};previous=None;resets=0
 for row in eligible:
  if row['game_time_sec']<lower:continue
  s=state(row)
  if previous and reg(previous,s):retained.extend(segment.values());segment={};resets+=1
  segment[s['clock_seconds']]=row;previous=s
 retained.extend(segment.values())
 if len(retained)>256 and resets:raise Refusal('history_regression_evidence_exceeds_capacity')
 truncated=len(retained)>256;retained=retained[-256:]
 return {'status':'projected','reason':None,'current':c,'history':[state(r) for r in retained],
  'sourceRows':[source_row(r) for r in retained],
  'summary':{'policy':POLICY,'candidateCount':len(candidates),'retainedCount':len(retained),'lookbackGameSeconds':600,'maxHistory':256,'truncated':truncated,'sourceIdentityConflict':False,'regressionSegments':resets,'servingEligibilityAssessed':False}}
def verify_projection(claim,current,candidates,*,query_truncated):
 actual=project(current,candidates,query_truncated=query_truncated)
 if not isinstance(claim,dict):raise Refusal('selector_dto_required')
 for key in ('status','reason','current','history','sourceRows'):
  if not dto_equal(claim.get(key),actual[key]):raise Refusal('selector_dto_binding:'+key)
 diag=claim.get('diagnostics')
 if not isinstance(diag,dict) or any(diag.get(k)!=v or type(diag.get(k)) is not type(v) for k,v in actual['summary'].items()):raise Refusal('selector_diagnostics_binding')
 return actual

def dto_equal(a,b):
 # JSON numbers in TS have one type; this does NOT weaken raw-input type equality.
 if type(a) in (int,float) and type(b) in (int,float):
  try:return math.isfinite(a) and math.isfinite(b) and a==b
  except OverflowError:return False
 if type(a) is not type(b):return False
 if isinstance(a,dict):return a.keys()==b.keys() and all(dto_equal(v,b[k]) for k,v in a.items())
 if isinstance(a,list):return len(a)==len(b) and all(dto_equal(x,y) for x,y in zip(a,b))
 return a==b
