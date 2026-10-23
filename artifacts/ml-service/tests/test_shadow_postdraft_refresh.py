"""Refresh regression tests. All state is synthetic and in a temporary owned store."""
import asyncio,json,threading,tempfile,unittest
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch
from fastapi import FastAPI
from test_shadow_postdraft_runtime import actor,ready,metadata,FakeCache,NOW,guard,SnapshotConfig,body
from src.shadow_postdraft.refresh import SnapshotStore,RefreshLoop,atomic_json,digest,RETRY_SECONDS,MAX_SNAPSHOT_BYTES
from src.shadow_postdraft.router import create_postdraft_router

class RefreshTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.store=SnapshotStore(self.root/'store',self.root/'reference.json')
        self.seq=0
    def generation(self,age=0):
        self.seq+=1;directory=self.store.root/f'generation-20261013T080000Z-{self.seq:012x}';directory.mkdir()
        atomic_json(directory/'OWNER.json',{'owner':self.store.marker['owner'],'generation':directory.name})
        atomic_json(directory/'MANIFEST.json',{'contract':'startup_postdraft_history_snapshot_v1','readOnly':True,'snapshotCutoff':(NOW-timedelta(hours=age)).isoformat()})
        (directory/'maps.jsonl').write_bytes(b'fake derived bytes');(directory/'hero-reference.json').write_bytes(b'{}')
        return SnapshotConfig(directory,digest(directory/'MANIFEST.json'))
    def old_actor(self):
        meta=metadata();meta['snapshotCutoff']=(NOW-timedelta(hours=8)).isoformat()
        a=actor(lambda *x,**k:(FakeCache(),meta));ready(a);return a
    def test_publish_failure_preserves_old_generation_and_cleans_derived_data(self):
        a=self.old_actor();old=a._cache;cfg=self.generation();a._loader=lambda *x,**k:(FakeCache(),metadata())
        loop=RefreshLoop(a,self.store,exporter=lambda guard:cfg,now=lambda:NOW)
        with patch.object(self.store,'publish',side_effect=OSError('private path')):
            self.assertEqual(loop.step(),'failed')
        self.assertIs(a._cache,old);self.assertFalse((cfg.directory/'maps.jsonl').exists())
        self.assertTrue((cfg.directory/'MANIFEST.json').exists());self.assertEqual(loop.retry_at,NOW.timestamp()+RETRY_SECONDS)
        self.assertNotIn('private',json.dumps(loop.status()));self.assertEqual(loop.step(),'deferred')
    def test_success_updates_current_and_uses_old_generation_only_for_earlier_receipts(self):
        a=self.old_actor();old=a._cache;cfg=self.generation();new=FakeCache();meta=metadata();meta['builtAt']=NOW.isoformat()
        a._loader=lambda *x,**k:(new,meta)
        loop=RefreshLoop(a,self.store,exporter=lambda guard:cfg,now=lambda:NOW)
        self.assertEqual(loop.step(),'replaced');self.assertEqual(self.store.current(),cfg)
        self.assertIs(a._select_generation((NOW-timedelta(seconds=1)).timestamp())[0],old)
        self.assertIs(a._select_generation(NOW.timestamp())[0],new)
        self.assertEqual(loop.step(),'not_due')
    def test_interrupt_recovery_preserves_active_and_small_audit_records(self):
        cfg=self.generation();atomic_json(self.store.root/'PENDING.json',{'owner':self.store.marker['owner'],'generation':cfg.directory.name})
        self.store.recover_pending();self.assertFalse((cfg.directory/'maps.jsonl').exists());self.assertTrue((cfg.directory/'MANIFEST.json').exists())
        active=self.generation();self.store.publish(active)
        atomic_json(self.store.root/'PENDING.json',{'owner':self.store.marker['owner'],'generation':active.directory.name})
        self.store.recover_pending();self.assertTrue((active.directory/'maps.jsonl').exists());self.assertEqual(self.store.current(),active)
    def test_retention_keeps_four_derived_raw_generations_and_all_manifests(self):
        configs=[self.generation(age=i) for i in range(7)];self.store.publish(configs[0]);self.store.prune(configs[0].directory)
        self.assertEqual(sum((c.directory/'maps.jsonl').exists() for c in configs),4)
        self.assertTrue(all((c.directory/'MANIFEST.json').exists() for c in configs))
    def test_foreign_unknown_and_symlink_targets_are_not_deleted(self):
        cfg=self.generation();(cfg.directory/'unrecognized.txt').write_text('keep')
        with self.assertRaises(ValueError):self.store.discard(cfg.directory)
        self.assertTrue((cfg.directory/'maps.jsonl').exists())
        foreign=self.root/'foreign';foreign.mkdir();(foreign/'maps.jsonl').write_text('keep')
        with self.assertRaises(ValueError):self.store.discard(foreign)
        self.assertTrue((foreign/'maps.jsonl').exists())
        atomic_json(self.store.root/'CURRENT.json',{'owner':self.store.marker['owner'],'generation':'../foreign','manifestSha256':'0'*64})
        with self.assertRaises(ValueError):self.store.current()
    def test_cleanup_failure_prevents_unbounded_repeat_export(self):
        a=self.old_actor();cfg=self.generation();(cfg.directory/'unrecognized.txt').write_text('keep')
        a._loader=lambda *x,**k:(_ for _ in ()).throw(ValueError('failed'));calls=[]
        loop=RefreshLoop(a,self.store,exporter=lambda guard:(calls.append(1) or cfg),now=lambda:NOW)
        self.assertEqual(loop.step(),'failed');self.assertEqual(loop.status()['reason'],'snapshot_cleanup_required')
        loop.now=lambda:NOW+timedelta(days=1);self.assertEqual(loop.step(),'deferred');self.assertEqual(len(calls),1)
    def test_cold_replace_does_not_race_initial_bootstrap(self):
        entered=threading.Event();release=threading.Event();calls=[]
        def load(*x,**k):calls.append(1);entered.set();release.wait(2);return FakeCache(),metadata()
        a=actor(load);cfg=self.generation();t=threading.Thread(target=lambda:a.replace_snapshot(cfg));t.start();self.assertTrue(entered.wait(1))
        self.assertEqual(a.start()['state'],'building');self.assertIsNone(a._thread)
        self.assertFalse(a.replace_snapshot(cfg));release.set();t.join(2);self.assertEqual(len(calls),1)
    def test_missing_generation_is_contract_refusal_not_name_error(self):
        a=actor();ready(a);b=body();b['current']['receivedAt']=(NOW-timedelta(seconds=90)).isoformat()
        self.assertEqual(a.predict(b)['reason'],'postdraft_cache_observation_ineligible')
    def test_restart_reuses_saved_snapshot_without_export_or_duplicate_bootstrap(self):
        from src.shadow_postdraft.refresh import configured_refresh
        cfg=self.generation();self.store.publish(cfg);a=actor();a._config=None
        with patch.dict('os.environ',{'AEGIS_POSTDRAFT_AUTO_REFRESH':'1','AEGIS_POSTDRAFT_SNAPSHOT_STORE':str(self.store.root),'AEGIS_POSTDRAFT_REFERENCE_FILE':str(self.store.reference)}),patch('src.shadow_postdraft.refresh.now_utc',return_value=NOW):
            manager=configured_refresh(a)
        self.assertEqual(a._config,cfg);self.assertEqual(a.status()['state'],'cold')
        self.assertFalse(a.configure_saved_snapshot(SnapshotConfig(self.root,'f'*64)))
        calls=[];a._loader=lambda c,**k:(calls.append(c) or (FakeCache(),metadata()))
        ready(a);self.assertEqual(calls,[cfg]);self.assertFalse(a.configure_saved_snapshot(cfg))
        self.assertIsNone(manager.thread)

    def test_invalid_refresh_configuration_does_not_break_app_lifespan(self):
        a=actor();app=FastAPI();router=create_postdraft_router(lambda:None,actor=a);app.include_router(router)
        async def run():
            with patch('src.shadow_postdraft.refresh.configured_refresh',side_effect=ValueError('private config')):
                async with app.router.lifespan_context(app):
                    status=next(route.endpoint for route in router.routes if route.path.endswith('/status'))
                    result=await status();self.assertEqual(result['refresh']['state'],'configuration_error')
                    self.assertNotIn('private',json.dumps(result));self.assertEqual(a.status()['state'],'cold')
        asyncio.run(run());self.assertTrue(a._stop.is_set())

if __name__=='__main__':unittest.main()
