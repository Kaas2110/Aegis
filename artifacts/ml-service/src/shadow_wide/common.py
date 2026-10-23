from __future__ import annotations
import hashlib,json,math,re
from datetime import datetime,timezone
from pathlib import Path

HERE=Path(__file__).resolve().parent
FLAGS={k:False for k in ('active','eligibleForServing','eligibleForPromotion','eligibleForQualityClaims',
 'eligibleForProspectiveEvaluation','prospectiveValidated','eventLatencyVerified','coverage95Validated',
 'meetsVerifiedLiveLatencyPolicy')}
class Refusal(ValueError):pass
def digest(raw):return hashlib.sha256(raw).hexdigest()
def hex64(v):return type(v)is str and re.fullmatch('[a-f0-9]{64}',v)is not None
def canonical(v):return json.dumps(v,sort_keys=True,separators=(',',':'),allow_nan=False,ensure_ascii=False).encode()
def no_constant(value):raise Refusal('nonstandard_json_number')
def unique_pairs(pairs):
 out={}
 for key,value in pairs:
  if key in out:raise Refusal('duplicate_json_key')
  out[key]=value
 return out
def parse(raw):return json.loads(raw,parse_constant=no_constant,object_pairs_hook=unique_pairs)
def bounded(path,limit):
 path=Path(path)
 if path.is_symlink() or path.stat().st_size>limit:raise Refusal('pinned_file_bound')
 with path.open('rb') as stream:raw=stream.read(limit+1)
 if len(raw)>limit:raise Refusal('pinned_file_bound')
 return raw
def now():return datetime.now(timezone.utc)
def seconds(v):
 if type(v)is not str or len(v)>64:raise Refusal('invalid_timestamp')
 try:d=datetime.fromisoformat(v.replace('Z','+00:00'));t=d.timestamp()
 except (ValueError,OverflowError,OSError):raise Refusal('invalid_timestamp')
 if d.tzinfo is None or not math.isfinite(t):raise Refusal('invalid_timestamp')
 return t
def wall(clock):
 d=clock()
 if not isinstance(d,datetime) or d.tzinfo is None:raise Refusal('invalid_wall_clock')
 out=d.astimezone(timezone.utc).isoformat();seconds(out);return out
def safe_reason(error):
 try:
  value=error.args[0] if len(error.args)==1 else None
  if type(value)is str and value in parse(bounded(HERE/'safe-reasons.json',100000)):return value
 except Exception:pass
 return 'wide_internal_refusal'
def refusal(reason):
 return {'contract':'wide36114.shadow.response.v1','status':'unavailable','reason':reason,
  'prediction':None,'diagnostic':None,'executionMode':'runtime_shadow',
  'measuredEndToEndLatencySeconds':None,**FLAGS}
