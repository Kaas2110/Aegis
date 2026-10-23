import unittest,json,hashlib,tempfile
from pathlib import Path
from src.research import rich_history_kill_export as e
class Cursor:
 def __init__(self,owner):self.owner=owner
 def __enter__(self):return self
 def __exit__(self,*args):return False
 def execute(self,sql,args):self.owner.calls.append((sql,args))
 def __iter__(self):
  if self.owner.mutate:self.owner.mutate()
  return iter(self.owner.rows)
class DB:
 def __init__(self,rows,mutate=None):self.rows=rows;self.calls=[];self.mutate=mutate
 def execute(self,sql):self.calls.append((sql,None))
 def cursor(self,name):self.calls.append(('CURSOR '+name,None));return Cursor(self)
class Tests(unittest.TestCase):
 def setUp(self):
  parent=Path(tempfile.gettempdir()).resolve()
  self.temp=tempfile.TemporaryDirectory(prefix='aegis-kill-export-test-');self.folder=Path(self.temp.name).resolve()
  assert self.folder.is_relative_to(parent)  # Verify deletion scope before cleanup.
  self.ref=self.folder/'heroes.json';self.blob=json.dumps({'payload':[{'id':1,'name':'npc_dota_hero_antimage'}],'received_at':'2026-10-13T00:00:00Z'}).encode();self.ref.write_bytes(self.blob)
 def tearDown(self):self.temp.cleanup()
 def test_raw_unknown_fields_preserved_null_logs_readonly(self):
  row={'match_id':1,'players':[{'player_slot':0,'kills_log':[{'key':'npc_dota_lone_druid_bear1','time':-1,'unknown_property':{'x':True}}]},{'player_slot':1,'kills_log':None}]}
  db=DB([row]);out=self.folder/'export';manifest=e.export_with_connection(db,[1],self.ref,out)
  self.assertEqual(json.loads((out/'raw-kill-targets.jsonl').read_text()),row)
  self.assertEqual(db.calls[0][0],'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  self.assertEqual(manifest['returned_maps'],1);self.assertEqual(manifest['provider_calls'],0)
 def test_reference_bytes_are_frozen_even_if_original_changes(self):
  db=DB([{'match_id':1,'players':[]}],mutate=lambda:self.ref.write_text('changed during export'))
  out=self.folder/'export';manifest=e.export_with_connection(db,[1],self.ref,out)
  self.assertEqual((out/'reference.json').read_bytes(),self.blob)
  self.assertEqual(manifest['reference']['file_sha256'],hashlib.sha256(self.blob).hexdigest())
 def test_duplicate_database_map_rejected(self):
  with self.assertRaises(ValueError):e.export_with_connection(DB([{'match_id':1},{'match_id':1}]),[1],self.ref,self.folder/'export')
 def test_out_of_scope_database_map_rejected(self):
  with self.assertRaises(ValueError):e.export_with_connection(DB([{'match_id':2}]),[1],self.ref,self.folder/'export')
 def test_existing_artifact_refused_before_db(self):
  out=self.folder/'export';out.mkdir();(out/'manifest.json').write_text('untouched');db=DB([])
  with self.assertRaises(FileExistsError):e.export_with_connection(db,[1],self.ref,out)
  self.assertEqual(db.calls,[]);self.assertEqual((out/'manifest.json').read_text(),'untouched')
 def test_invalid_id_list_and_reference_refused(self):
  for ids in ([True],[0],[-1],[1,1],[],['1']):
   with self.assertRaises(ValueError):e.export_with_connection(DB([]),ids,self.ref,self.folder/'unused')
  self.ref.write_text(json.dumps({'payload':[{'id':1,'name':'Axe'}]}))
  with self.assertRaises(ValueError):e.export_with_connection(DB([]),[1],self.ref,self.folder/'unused')
if __name__=='__main__':unittest.main(verbosity=2)
