import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trainingSinceUnix } from '../artifacts/api-server/src/services/TrainingWindow';

const now=Date.parse('2026-10-03T12:00:00Z');
test('365-day selection preserves the calendar cutoff independently of archive age',()=>{
  assert.equal(trainingSinceUnix(365,now),Math.floor(now/1000)-365*86400);
  assert.equal(trainingSinceUnix(730,now),Math.floor(now/1000)-730*86400);
});
test('patch limit narrows the training selection; an older patch never expands it',()=>{
  const recent=Math.floor(now/1000)-30*86400, old=Math.floor(now/1000)-800*86400;
  assert.equal(trainingSinceUnix(365,now,recent),recent);
  assert.equal(trainingSinceUnix(365,now,old),trainingSinceUnix(365,now));
  assert.equal(trainingSinceUnix(365,now,NaN),trainingSinceUnix(365,now));
});
test('invalid windows cannot silently become an unbounded selection',()=>{
  for(const days of [0,-1,NaN,Infinity]) assert.throws(()=>trainingSinceUnix(days,now),/Invalid training window/);
});
test('scheduler has no destructive retention calls before or after its training gate',()=>{
  // Architectural safety guard: executing a scheduled check must never erase
  // the only corpus, including when auto-training is disabled. Importing the
  // full scheduler would start database-dependent modules; inspect its boundary.
  const source=readFileSync(new URL('../artifacts/api-server/src/services/SchedulerWorker.ts',import.meta.url),'utf8');
  assert.doesNotMatch(source,/\.delete\s*\(|\bpruneLiveSnapshots\s*\(/);
  assert.doesNotMatch(source,/\b(?:DELETE\s+FROM|TRUNCATE)\s+(?:pro_matches|live_snapshots)\b/i);
  assert.match(source,/trainingSinceUnix\(windowDays, windowNowMs, patchCutoff\)/);
  assert.match(source,/trainArgs = \['--since-unix'/);
});
