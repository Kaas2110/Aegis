"""Future root-configured local metadata presence check; never return labels."""
from pathlib import Path
import json,os,subprocess
from . import local
class Refusal(ValueError):pass
def need(ok):
 if not ok:raise Refusal('c2_phase_known_outcome_check_unavailable')
class KnownOutcomeGuard:
 def __init__(self,ref,*,directory,source_manifest,clock,guard,runner=subprocess.run):
  need(type(ref)is dict and set(ref)=={'path','sha256','bytes'}and type(ref['bytes'])is int and 0<ref['bytes']<=100000)
  raw=local.read_file(ref['path'],100000);need(len(raw)==ref['bytes']and local.sha(raw)==ref['sha256']);c=local.parse(raw)
  need(c.get('contract')=='c2_local_outcome_guard.v1'and c.get('enabled')is True and c.get('rootReviewed')is True and c.get('approvedBy')=='root'and c.get('sourceManifestSha256')==source_manifest)
  self.node=local.trusted_path(c['nodeExecutable']);need(self.node.is_file());self.script=local.trusted_path(Path(directory)/'outcome_check.mjs');need(self.script.is_file())
  manifest=local.parse(local.read_file(Path(directory)/'MANIFEST.json',2*1024**2));pin=manifest['files']['outcome_check.mjs'];need(self.script.stat().st_size==pin['bytes']and local.sha(local.read_file(self.script,100000))==pin['sha256'])
  self.ref=ref;self.clock=clock;self.guard=guard;self.runner=runner
 def check(self,match_id):
  self.guard();need(type(match_id)is int and 0<match_id<=2**53-1)
  env=dict(os.environ);env.pop('STEAM_WEB_API_KEY',None)
  try:r=self.runner([str(self.node),str(self.script),'--config',self.ref['path'],'--sha256',self.ref['sha256'],'--match-id',str(match_id)],
   capture_output=True,timeout=6,env=env,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0)if os.name=='nt'else 0)
  except Exception:raise Refusal('c2_phase_known_outcome_check_unavailable')from None
  need(r.returncode==0 and len(r.stdout)<=10000 and len(r.stderr)<=10000);v=local.parse(r.stdout)
  need(type(v)is dict and v.get('contract')=='local_known_outcome_presence.v1'and v.get('matchId')==match_id and type(v.get('known'))is bool and
   v.get('readOnly')is True and v.get('outcomeValueRead')is False and v.get('databaseIdentityMatched')is True and v.get('source')=='local_pro_matches_and_live_journal_outcomes')
  age=local.wall(self.clock).timestamp()-local.stamp(v.get('checkedAt'));need(0<=age<=10);self.guard();return v
