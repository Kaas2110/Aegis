"""Portable fake-DB contract checks; no credentials or live DB."""
import json,tempfile,unittest
from pathlib import Path
from datetime import datetime,timezone
from unittest.mock import patch
from src.research.postdraft_full import export_snapshot as module

class Rows:
    def __init__(self,row):self.row=row
    def fetchone(self):return self.row
class Cursor:
    def __init__(self,db):self.db=db
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def execute(self,sql,parameters):self.db.statements.append((sql,parameters))
    def __iter__(self):return iter(self.db.rows)
class Database:
    def __init__(self,rows):self.rows=rows;self.statements=[];self.rolled_back=False
    def execute(self,sql):
        self.statements.append(sql)
        return Rows({'capture':datetime(2026,10,13,tzinfo=timezone.utc),'snapshot':'10:20:','readonly':'on'})
    def cursor(self,name):return Cursor(self)
    def rollback(self):self.rolled_back=True

class SnapshotExportTests(unittest.TestCase):
    def test_lossless_raw_keys_unknown_fields_null_and_one_readonly_transaction(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td);reference=p/'heroes.json';data=b'{"payload":[{"id":1,"name":"npc_dota_hero_antimage"}]}'
            reference.write_bytes(data)
            row={'match_id':1,'payload_schema_version':3,'raw_kill_players':[{'player_slot':0,'kills_log':[{'time':12,'key':'bear','unknown':7}]},{'player_slot':1,'kills_log':None}]}
            db=Database([row])
            with patch.object(module,'REFERENCE_SHA256',module.hashlib.sha256(data).hexdigest()):result=module.export_snapshot(db,p/'out',reference)
            self.assertEqual(json.loads((p/'out/maps.jsonl').read_text()),row)
            self.assertEqual((p/'out/hero-reference.json').read_bytes(),data)
            self.assertEqual(db.statements[0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
            self.assertTrue(db.rolled_back);self.assertEqual(result['counts']['rows'],1)
            self.assertEqual(sum(isinstance(s,str) and s.startswith('BEGIN') for s in db.statements),1)
    def test_limits_reject_before_writing_oversized_line_or_excess_total(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td);reference=p/'heroes.json';data=b'{"payload":[{"id":1,"name":"hero"}]}'
            reference.write_bytes(data)
            with patch.object(module,'REFERENCE_SHA256',module.hashlib.sha256(data).hexdigest()):
                with patch.object(module,'MAX_LINE_BYTES',10):
                    with self.assertRaisesRegex(ValueError,'row too large'):module.export_snapshot(Database([{'match_id':1}]),p/'row',reference)
                self.assertEqual((p/'row/maps.jsonl').stat().st_size,0)
                with patch.object(module,'MAX_SNAPSHOT_BYTES',16):
                    with self.assertRaisesRegex(ValueError,'byte limit'):module.export_snapshot(Database([{'match_id':1},{'match_id':2}]),p/'total',reference)
                self.assertEqual((p/'total/maps.jsonl').stat().st_size,15)

    def test_duplicate_ids_or_existing_output_or_bad_reference_fail(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td);reference=p/'heroes.json';data=b'{"payload":[{"id":1,"name":"hero"}]}'
            reference.write_bytes(data)
            with self.assertRaisesRegex(ValueError,'reference'):module.export_snapshot(Database([]),p/'bad',reference)
            self.assertFalse((p/'bad').exists())
            with patch.object(module,'REFERENCE_SHA256',module.hashlib.sha256(data).hexdigest()):
                with self.assertRaisesRegex(ValueError,'Duplicate map'):module.export_snapshot(Database([{'match_id':1},{'match_id':1}]),p/'dupes',reference)
                with self.assertRaises(FileExistsError):module.export_snapshot(Database([]),p/'dupes',reference)

if __name__=='__main__':unittest.main()
