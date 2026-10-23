"""One consistent PostgreSQL READ ONLY snapshot; no network providers or writes.
Latest mutable DB versions get actual availability at this capture, never retroactively.
Connection is passed by caller; no credentials are stored in exported artifacts.
"""
import hashlib,json,os
from datetime import datetime,timezone
from pathlib import Path
from collections import Counter
SQL="SELECT m.match_id,m.start_time,m.duration,m.radiant_team_id,m.dire_team_id,m.radiant_win,\nm.radiant_score,m.dire_score,m.series_id,m.series_type,m.league_id,\nd.radiant_picks stored_radiant_picks,d.dire_picks stored_dire_picks,\np.payload_schema_version,p.parsed_at,m.ingested_at,\nmd5(p.players::text) players_payload_md5,\nCASE WHEN d.match_id IS NOT NULL THEN jsonb_build_object('radiant_picks',d.radiant_picks,'dire_picks',d.dire_picks,\n'radiant_account_ids',d.radiant_account_ids,'dire_account_ids',d.dire_account_ids,'fetched_at',d.fetched_at) END draft,\n(SELECT jsonb_agg(jsonb_build_object('player_slot',v->'player_slot','hero_id',v->'hero_id','account_id',v->'account_id','kills_log',v->'kills_log'))\n FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.players)='array' THEN p.players ELSE '[]'::jsonb END) v) raw_kill_players,\n\n(SELECT jsonb_agg(jsonb_build_object('player_slot',v->'player_slot','hero_id',v->'hero_id','account_id',v->'account_id',\n'past_only_final_stats',jsonb_build_object('gold_per_min',v->'gold_per_min','xp_per_min',v->'xp_per_min',\n'kills',v->'kills','deaths',v->'deaths','assists',v->'assists','hero_damage',v->'hero_damage',\n'tower_damage',v->'tower_damage','last_hits',v->'last_hits','lane_role',v->'lane_role'),\n'kills',CASE WHEN jsonb_typeof(v->'kills_log')='array' THEN (SELECT coalesce(jsonb_agg(e->'time'),'[]'::jsonb) FROM jsonb_array_elements(v->'kills_log') e) END,\n'obs',CASE WHEN jsonb_typeof(v->'obs_log')='array' THEN (SELECT coalesce(jsonb_agg(e->'time'),'[]'::jsonb) FROM jsonb_array_elements(v->'obs_log') e) END,\n'sen',CASE WHEN jsonb_typeof(v->'sen_log')='array' THEN (SELECT coalesce(jsonb_agg(e->'time'),'[]'::jsonb) FROM jsonb_array_elements(v->'sen_log') e) END,\n'buybacks',CASE WHEN jsonb_typeof(v->'buyback_log')='array' THEN (SELECT coalesce(jsonb_agg(e->'time'),'[]'::jsonb) FROM jsonb_array_elements(v->'buyback_log') e) END,\n'purchases',CASE WHEN jsonb_typeof(v->'purchase_log')='array' THEN\n (SELECT coalesce(jsonb_agg(jsonb_build_object('time',e->'time','key',e->'key')),'[]'::jsonb) FROM jsonb_array_elements(v->'purchase_log') e\n WHERE e->>'key' IN ('blink','black_king_bar','mekansm','hand_of_midas','bfury','radiance')) END\n)) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.players)='array' THEN p.players ELSE '[]'::jsonb END) v) players\nFROM pro_matches m LEFT JOIN match_parsed p ON p.match_id=m.match_id AND p.parsed_at<=%(cutoff)s LEFT JOIN match_drafts d ON d.match_id=m.match_id AND d.fetched_at<=%(cutoff)s\nWHERE m.start_time+m.duration+300<EXTRACT(EPOCH FROM %(cutoff)s::timestamptz) AND m.ingested_at<=%(cutoff)s ORDER BY m.start_time,m.match_id"
MAX_LINE_BYTES=2*1024*1024
MAX_SNAPSHOT_BYTES=512*1024*1024
REFERENCE_SHA256='d2ad795b7cdce3cb4bc75d4df15dd539178026bf11c285aaa19bbd4d8e369113'
def export_snapshot(connection,out,reference,*,guard=lambda:None):
    out=Path(out);reference=Path(reference);guard()
    if out.exists():raise FileExistsError('Refuse to overwrite snapshot')
    raw_reference=reference.read_bytes()
    if hashlib.sha256(raw_reference).hexdigest()!=REFERENCE_SHA256:raise ValueError('Pinned hero reference mismatch')
    heroes=json.loads(raw_reference)['payload']
    if len({h['id'] for h in heroes})!=len(heroes):raise ValueError('Duplicate reference IDs')
    out.mkdir(parents=True);counts=Counter();seen=set();digest=hashlib.sha256();written=0
    # Caller must provide an idle connection. First statement establishes RO transaction.
    connection.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    connection.execute("SET LOCAL statement_timeout='240s'")
    meta=connection.execute("SELECT transaction_timestamp() capture, pg_current_snapshot()::text snapshot, current_setting('transaction_read_only') readonly").fetchone()
    if meta['readonly']!='on':raise RuntimeError('Read-only transaction not established')
    cutoff=meta['capture']
    with connection.cursor(name='aegis_postdraft_future_cache') as cursor,(out/'maps.jsonl').open('xb') as stream:
        cursor.execute(SQL,{'cutoff':cutoff})
        for index,row in enumerate(cursor):
            if index>=50000:raise ValueError('History limit exceeded')
            if index%100==0:guard()
            if row['match_id'] in seen:raise ValueError('Duplicate map IDs')
            seen.add(row['match_id']);line=(json.dumps(row,default=str,separators=(',',':'),ensure_ascii=False,allow_nan=False)+'\n').encode('utf8')
            if len(line)>MAX_LINE_BYTES:raise ValueError('Snapshot row too large')
            if written+len(line)>MAX_SNAPSHOT_BYTES:raise ValueError('Snapshot byte limit exceeded')
            stream.write(line);written+=len(line);digest.update(line);counts['rows']+=1
            counts['schema3']+=type(row.get('payload_schema_version')) is int and row['payload_schema_version']>=3
    connection.rollback()
    (out/'hero-reference.json').write_bytes(raw_reference)
    manifest={'contract':'startup_postdraft_history_snapshot_v1','snapshotCutoff':cutoff.isoformat(),
        'capturedAt':datetime.now(timezone.utc).isoformat(),'postgresSnapshot':meta['snapshot'],
        'sourceTables':['pro_matches','match_parsed','match_drafts'],'knownAtPolicy':'ingested/parsed/fetched <= snapshotCutoff; end+300 < cutoff; predictions only after cache builtAt',
        'counts':dict(counts),'mapsFile':'maps.jsonl','mapsSha256':digest.hexdigest(),'mapsBytes':(out/'maps.jsonl').stat().st_size,
        'referenceSha256':REFERENCE_SHA256,'sqlSha256':hashlib.sha256(SQL.encode()).hexdigest(),
        'readOnly':True,'providerCalls':0,'originalHistoricalReceiptProven':False,'active':False}
    (out/'MANIFEST.json').write_text(json.dumps(manifest,indent=2),encoding='utf8');guard()
    return manifest
