"""Read-only, provenance-preserving export for causal history research.

Example: python -m src.research.rich_history_kill_export --match-ids ids.json
  --reference cached-heroes.json --output-dir path/to/new/export

No provider calls or fitting. DSN is read from an environment variable and is
never written to output. Keys and event times remain intact for the shared
temporal_hero_kills contract. parsed_at is latest payload receipt, not proof of
original event-time availability. Caller owns inter-map causal cutoffs.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from datetime import datetime,timezone
from pathlib import Path
from typing import Any

SQL="""SELECT m.match_id,m.start_time,m.duration,m.radiant_team_id,m.dire_team_id,
m.radiant_win,m.radiant_score,m.dire_score,p.parsed_at,p.payload_schema_version,
md5(p.players::text) AS players_payload_md5,
(SELECT jsonb_agg(jsonb_build_object('player_slot',v->'player_slot','hero_id',v->'hero_id',
 'account_id',v->'account_id','kills_log',v->'kills_log'))
 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.players)='array' THEN p.players ELSE '[]'::jsonb END) v) AS players
FROM pro_matches m LEFT JOIN match_parsed p USING(match_id)
WHERE m.match_id=ANY(%s) ORDER BY m.start_time,m.match_id"""

def file_sha256(path: str | Path) -> str:
 result=hashlib.sha256()
 with Path(path).open('rb') as stream:
  for block in iter(lambda:stream.read(1024*1024),b''):result.update(block)
 return result.hexdigest()

def validate_match_ids(value: Any) -> list[int]:
 if not isinstance(value,list) or not value or any(type(mid) is not int or mid<=0 for mid in value):
  raise ValueError('match_ids must be a nonempty array of positive integers')
 if len(set(value))!=len(value):raise ValueError('duplicate match_ids are not allowed')
 return sorted(value)

def _reference_blob_evidence(blob: bytes) -> tuple[dict[int,str],dict[str,Any]]:
 raw=json.loads(blob.decode('utf8'))
 payload=raw.get('payload') if isinstance(raw,dict) else raw
 if not isinstance(payload,list) or not payload:raise ValueError('hero reference payload must be a nonempty array')
 mapping={}
 for row in payload:
  if not isinstance(row,dict) or type(row.get('id')) is not int or row['id']<=0 or not isinstance(row.get('name'),str) or not row['name'].startswith('npc_dota_hero_'):
   raise ValueError('hero reference requires exact integer id and internal NPC name')
  if row['id'] in mapping:raise ValueError('duplicate hero reference id')
  mapping[row['id']]=row['name']
 if len(set(mapping.values()))!=len(mapping):raise ValueError('duplicate hero reference NPC name')
 digest=hashlib.sha256(json.dumps(sorted(mapping.items()),ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
 return mapping,{'file_sha256':hashlib.sha256(blob).hexdigest(),'mapping_sha256':digest,'hero_count':len(mapping),
  'received_at':raw.get('received_at') if isinstance(raw,dict) else None,
  'role':'pinned exact NPC identity reference, not match-time feature or observed-live availability'}

def reference_evidence(path: str | Path) -> tuple[dict[int,str],dict[str,Any]]:
 return _reference_blob_evidence(Path(path).read_bytes())

def export_with_connection(connection: Any, match_ids: list[int], reference: str | Path, output_dir: str | Path) -> dict[str,Any]:
 """Requires a new connection; starts a repeatable-read, read-only transaction."""
 match_ids=validate_match_ids(match_ids);reference_bytes=Path(reference).read_bytes();_,evidence=_reference_blob_evidence(reference_bytes)
 output=Path(output_dir);output.mkdir(parents=True,exist_ok=True)
 names=('raw-kill-targets.jsonl','reference.json','manifest.json')
 if any((output/name).exists() for name in names):raise FileExistsError('export artifacts already exist; choose a new directory')
 connection.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
 connection.execute("SET LOCAL statement_timeout='300s'")
 count=0;seen=set();requested=set(match_ids)
 with connection.cursor(name='causal_history_kill_export') as cursor,(output/names[0]).open('x',encoding='utf8') as stream:
  cursor.execute(SQL,(match_ids,))
  for row in cursor:
   if row['match_id'] not in requested or row['match_id'] in seen:raise ValueError('database returned unexpected or duplicate match ID')
   seen.add(row['match_id']);stream.write(json.dumps(row,default=str,separators=(',',':'))+'\n');count+=1
 (output/'reference.json').write_bytes(reference_bytes)
 manifest={'exported_at':datetime.now(timezone.utc).isoformat(),'source':'local_match_parsed','read_only':True,'provider_calls':0,
  'requested_match_ids':match_ids,'returned_maps':count,'missing_match_ids':sorted(set(match_ids)-seen),'reference':evidence,
  'raw_export_sha256':file_sha256(output/'raw-kill-targets.jsonl'),'source_sql_sha256':hashlib.sha256(SQL.encode()).hexdigest(),
  'payload_reference':'per-map players_payload_md5 + parsed_at; MD5 is lineage identifier, not an authenticity proof',
  'receipt_semantics':'parsed_at is latest merged payload receipt; historical reconstruction requires separate as-of rules',
  'preserved':'raw kills_log objects including key,time and unknown fields; missing arrays remain null',
  'active_model_changes':False}
 (output/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf8')
 return manifest

def main() -> None:
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--match-ids',required=True);parser.add_argument('--reference',required=True);parser.add_argument('--output-dir',required=True)
 parser.add_argument('--dsn-env',default='DATABASE_URL');args=parser.parse_args()
 dsn=os.environ.get(args.dsn_env)
 if not dsn:raise SystemExit('Requested database environment variable is missing')
 import psycopg
 from psycopg.rows import dict_row
 ids=json.loads(Path(args.match_ids).read_text(encoding='utf8'))
 with psycopg.connect(dsn,row_factory=dict_row) as connection:
  result=export_with_connection(connection,ids,args.reference,args.output_dir)
 print(json.dumps({'returned_maps':result['returned_maps'],'missing_maps':len(result['missing_match_ids']),'raw_export_sha256':result['raw_export_sha256']}))

if __name__=='__main__':main()
