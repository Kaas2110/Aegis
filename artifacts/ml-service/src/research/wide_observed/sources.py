"""Small pinned-source and JSON/float32 contracts; no model loading."""
from __future__ import annotations
import importlib,json,math
from datetime import datetime,timezone
from pathlib import Path
import numpy as np
from .lineage import Refusal,sha,parse,canonical,objhash,hex64

HERE=Path(__file__).resolve().parent

def bounded(path,limit):
 path=Path(path)
 if path.is_symlink() or path.stat().st_size>limit:raise Refusal('file_bound_or_symlink')
 with path.open('rb') as stream:raw=stream.read(limit+1)
 if len(raw)>limit:raise Refusal('file_bound')
 return raw

def verify_sources():
 from .pins import SOURCE_MANIFEST_SHA256
 raw=bounded(HERE/'SOURCE-MANIFEST.json',100000)
 if sha(raw)!=SOURCE_MANIFEST_SHA256:raise Refusal('source_manifest_pin')
 m=parse(raw)
 for name,pin in m['own'].items():
  if Path(name).name!=name or sha(bounded(HERE/name,2000000))!=pin:raise Refusal('own_source_pin')
 for module,pin in m['dependencies'].items():
  if not module.startswith('src.research.') or sha(bounded(Path(importlib.import_module(module).__file__),2000000))!=pin:raise Refusal('dependency_source_pin')
 return SOURCE_MANIFEST_SHA256

def utcnow():return datetime.now(timezone.utc)
def seconds(value):
 if not isinstance(value,str) or len(value)>64:raise Refusal('timestamp_required')
 try:
  d=datetime.fromisoformat(value.replace('Z','+00:00'));v=d.timestamp()
 except (ValueError,OverflowError,OSError) as error:raise Refusal('timestamp_invalid') from error
 if d.tzinfo is None or not math.isfinite(v):raise Refusal('timestamp_invalid')
 return v
def wall(clock):
 d=clock()
 if not isinstance(d,datetime) or d.tzinfo is None:raise Refusal('aware_wall_clock_required')
 text=d.astimezone(timezone.utc).isoformat();seconds(text);return text

def encoded(vector):
 a=np.asarray(vector,dtype='<f4').copy()
 if a.ndim!=1 or np.isinf(a).any():raise Refusal('vector_contract')
 a[np.isnan(a)]=np.float32(np.nan) # canonical quiet NaN bit pattern
 return {'values':[None if np.isnan(v) else float(v) for v in a],
  'missing':[bool(v) for v in np.isnan(a)],'float32Sha256':sha(a.tobytes())}

def decoded(value,width):
 if not isinstance(value,dict) or set(value)!=set(('values','missing','float32Sha256')):raise Refusal('encoded_vector_contract')
 v=value['values'];mask=value['missing']
 if not isinstance(v,list) or not isinstance(mask,list) or len(v)!=width or len(mask)!=width or not hex64(value['float32Sha256']):raise Refusal('vector_width')
 for x,m in zip(v,mask):
  if type(m) is not bool or (x is None)!=m or (x is not None and type(x) not in (int,float)):raise Refusal('vector_null_mask')
 try:
  with np.errstate(over='ignore'):a=np.array([math.nan if x is None else x for x in v],dtype='<f4')
 except (ValueError,TypeError,OverflowError) as error:raise Refusal('vector_scalar') from error
 # Encoding round-trip forbids hidden precision not represented by the hash.
 if encoded(a)!=value:raise Refusal('vector_hash_or_roundtrip')
 return a
