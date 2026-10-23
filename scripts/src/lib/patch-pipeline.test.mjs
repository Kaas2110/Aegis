import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { buildPlan, runPipeline } from '../../run-pipeline.mjs';

for (const [exitCode, expectedStep, expectedRun] of [[10, 'skipped', 'succeeded'], [20, 'degraded', 'degraded'], [1, 'degraded', 'degraded']]) {
  test(`optional catalog exit ${exitCode} does not prevent ingestion, and status is ${expectedRun}`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'aegis-patch-pipeline-'));
    t.after(() => rmSync(root, {recursive: true, force: true}));
    const calls = [];
    const status = await runPipeline({name: 'fixture', continueOnError: false, steps: [
      {name: 'patch:check', args: [], optional: true, skippedExitCodes: [10]},
      {name: 'ingest:matches', args: []},
    ]}, {stateDir: join(root, 'state'), logDir: join(root, 'logs'), quiet: true,
      runner: async step => {calls.push(step.name); return {exitCode: step.name === 'patch:check' ? exitCode : 0};}});
    assert.deepEqual(calls, ['patch:check', 'ingest:matches']);
    assert.equal(status.exitCode, 0); assert.equal(status.state, expectedRun);
    assert.equal(status.steps[0].state, expectedStep);
    assert.equal(status.steps[0].exitCode, exitCode);
    assert.equal(JSON.parse(readFileSync(join(root, 'logs', 'fixture.status.json'), 'utf8')).state, expectedRun);
  });
}
test('degraded optional catalog cannot hide a required ingest failure', async t => {
  const root = mkdtempSync(join(tmpdir(), 'aegis-patch-pipeline-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const status = await runPipeline({name: 'fixture', continueOnError: true, steps: [
    {name: 'patch:check', args: [], optional: true, skippedExitCodes: [10]}, {name: 'ingest:matches', args: []},
  ]}, {stateDir: join(root, 'state'), logDir: join(root, 'logs'), quiet: true,
    runner: async step => ({exitCode: step.name === 'patch:check' ? 20 : 17})});
  assert.equal(status.state, 'failed'); assert.equal(status.exitCode, 17);
});

test('configured hourly plan preserves optional flags and survives a catalog failure', async t => {
  const root = mkdtempSync(join(tmpdir(), 'aegis-configured-patch-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const plan = buildPlan('hourly');
  assert.equal(plan.steps[0].name, 'patch:check');
  assert.equal(plan.steps[0].optional, true);
  assert.deepEqual(plan.steps[0].skippedExitCodes, [10]);
  assert.equal(plan.steps.filter(step => step.name === 'patch:check').length, 1);
  assert.equal(plan.steps.filter(step => step.name === 'patch:assign').length, 1);
  assert.ok(plan.steps.findIndex(step => step.name === 'patch:assign') > plan.steps.findIndex(step => step.name === 'refresh:match-details'));
  assert.equal(plan.steps.find(step => step.name === 'patch:assign').optional, true);
  assert.ok(plan.steps.every(step => !step.name.startsWith('train:')));
  const calls = [];
  const status = await runPipeline(plan, {stateDir: join(root, 'state'), logDir: join(root, 'logs'), quiet: true,
    runner: async step => {calls.push(step.name); return {exitCode: step.name === 'patch:check' ? 20 : 0};}});
  assert.deepEqual(calls, plan.steps.map(step => step.name));
  assert.equal(status.state, 'degraded');
  assert.equal(status.exitCode, 0);
});
