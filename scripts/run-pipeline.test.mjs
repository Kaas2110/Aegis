import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { buildPlan, parseArguments, pnpmCommand, runPipeline, spawnCommand } from './run-pipeline.mjs';

const runnerPath = join(dirname(fileURLToPath(import.meta.url)), 'run-pipeline.mjs');
function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'aegis-pipeline-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, stateDir: join(root, 'state'), logDir: join(root, 'logs'), quiet: true };
}

test('CLI validates pipeline names, extra arguments and integer settings', () => {
  assert.deepEqual(parseArguments(['parse-cycle', '--', '--dry-run']), { name: 'parse-cycle', dryRun: true, help: false });
  assert.throws(() => parseArguments(['unknown']), /Unknown pipeline/);
  assert.throws(() => parseArguments(['daily', 'hourly']), /Unexpected argument/);
  assert.throws(() => parseArguments(['daily', '--whatever']), /Unexpected argument/);
  assert.throws(() => buildPlan('replay-once', { AEGIS_REPLAY_REQUEST_LIMIT: '10;echo injected' }), /must be an integer/);
  assert.throws(() => buildPlan('replay-once', { AEGIS_REPLAY_REQUEST_LIMIT: '501' }), /must be an integer/);
  assert.throws(() => pnpmCommand({ AEGIS_PNPM_CLI: 'pnpm.cmd' }, 'win32'), /absolute path/);
  assert.throws(() => pnpmCommand({}, 'win32'), /Set AEGIS_PNPM_CLI/);
});

test('dry run prints original commands and creates no state or log directories', t => {
  const dirs = temporary(t);
  const env = { ...process.env, AEGIS_STATE_DIR: dirs.stateDir, AEGIS_LOG_DIR: dirs.logDir };
  delete env.AEGIS_PNPM_CLI;
  const child = spawnSync(process.execPath, [runnerPath, 'daily', '--dry-run'], { env, encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  const plan = JSON.parse(child.stdout);
  assert.equal(plan.steps.length, 12);
  assert.deepEqual(plan.steps.map(step => step.name), [
    'ingest:teams', 'ingest:missing-teams', 'ingest:matches', 'ingest:leagues',
    'ingest:hero-stats', 'ingest:hero-matchups', 'ingest:hero-synergy',
    'compute:recent-form', 'compute:h2h', 'compute:player-glicko',
    'compute:team-extended', 'compute:bo3-series',
  ]);
  assert.deepEqual(plan.steps[2].args.slice(-5), ['--filter', '@workspace/scripts', 'run', 'ingest:matches', '5']);
  assert.equal(existsSync(dirs.stateDir), false);
  assert.equal(existsSync(dirs.logDir), false);
  const replay = buildPlan('replay-once', { AEGIS_REPLAY_REQUEST_LIMIT: '12', AEGIS_REPLAY_INGEST_LIMIT: '24' });
  assert.deepEqual(replay.steps[0].args.slice(-5), ['--', '--limit', '12', '--since-days', '180']);
  assert.deepEqual(replay.steps[1].args.slice(-3), ['--', '--limit', '24']);
});

test('a failed hourly step keeps original continuation but returns nonzero and releases lock', async t => {
  const dirs = temporary(t);
  const called = [];
  const status = await runPipeline(buildPlan('hourly'), { ...dirs, runner: async step => {
    called.push(step.name);
    return { exitCode: step.name === 'ingest:matches' ? 17 : 0 };
  } });
  assert.equal(status.exitCode, 17);
  assert.equal(status.state, 'failed');
  assert.equal(called.length, 5);
  const saved = JSON.parse(readFileSync(join(dirs.logDir, 'hourly.status.json'), 'utf8'));
  assert.deepEqual(saved.steps.map(step => step.state), ['succeeded', 'failed', 'succeeded', 'succeeded', 'succeeded']);
  assert.equal(existsSync(join(dirs.stateDir, 'pipeline.lock')), false);
});

test('parse-cycle stops immediately on request failure instead of waiting or ingesting', async t => {
  const dirs = temporary(t);
  let calls = 0;
  const status = await runPipeline(buildPlan('parse-cycle'), { ...dirs, runner: async () => {
    calls++;
    throw new Error('Injected command failure');
  } });
  assert.equal(calls, 1);
  assert.equal(status.exitCode, 1);
  assert.equal(status.steps[0].error, 'Injected command failure');
  assert.equal(existsSync(join(dirs.stateDir, 'pipeline.lock')), false);
});

test('global lock prevents a different pipeline from starting at the same time', async t => {
  const dirs = temporary(t);
  let resume;
  let entered;
  const running = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  const first = runPipeline(buildPlan('drafts-backfill'), { ...dirs, runner: async () => {
    entered();
    await gate;
    return { exitCode: 0 };
  } });
  await running;
  try {
    const second = await runPipeline(buildPlan('daily'), { ...dirs, runner: async () => assert.fail('Conflicting job ran') });
    assert.equal(second.exitCode, 75);
    assert.equal(second.state, 'blocked');
    assert.equal(second.lockOwner.pipeline, 'drafts-backfill');
    assert.equal(existsSync(join(dirs.stateDir, 'pipeline.lock')), true);
  } finally {
    resume();
    await first;
  }
  assert.equal(existsSync(join(dirs.stateDir, 'pipeline.lock')), false);
});

test('interruption stops the sequence, reports its signal and releases the lock', async t => {
  const dirs = temporary(t);
  const controller = new AbortController();
  let calls = 0;
  const status = await runPipeline(buildPlan('hourly'), { ...dirs, signal: controller.signal, runner: async () => {
    calls++;
    controller.abort('SIGTERM');
    return { exitCode: 0 };
  } });
  assert.equal(calls, 1);
  assert.equal(status.state, 'interrupted');
  assert.equal(status.exitCode, 143);
  assert.equal(status.steps[0].exitCode, 143);
  assert.equal(existsSync(join(dirs.stateDir, 'pipeline.lock')), false);
});

test('aborting a real local child stops its process tree without invoking ingestion', { timeout: 10000 }, async () => {
  const controller = new AbortController();
  let pids;
  let received = '';
  const code = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(() => {}, 1000)'],{windowsHide:true,stdio:'ignore'}); console.log(JSON.stringify([process.pid,child.pid])); setInterval(() => {}, 1000);`;
  const result = await spawnCommand(process.execPath, ['-e', code], {
    cwd: dirname(runnerPath), env: process.env, signal: controller.signal,
    output: chunk => {
      received += chunk.toString();
      if (received.includes('\n') && !pids) {
        pids = JSON.parse(received.trim());
        controller.abort('SIGINT');
      }
    },
  });
  assert.equal(result.exitCode, 130);
  assert.equal(result.interrupted, true);
  assert.equal(pids.length, 2);
  for (const pid of pids) {
    assert.ok(pid > 0);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
});

function abandonedLock(dirs, owner) {
  const path = join(dirs.stateDir, 'pipeline.lock');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'owner.json'), typeof owner === 'string' ? owner : JSON.stringify(owner));
}

test('Windows recovery handles a dead PID, a reused PID, and an incomplete owner', { skip: process.platform !== 'win32' }, async t => {
  for (const owner of [
    { pid: 2147483647, runId: 'dead-process', startedAt: '2000-01-01T00:00:00.000Z' },
    { pid: process.pid, runId: 'reused-process', processStartTicks: '0', startedAt: '2000-01-01T00:00:00.000Z' },
    { pid: process.pid, runId: 'legacy-before-reboot', startedAt: '2000-01-01T00:00:00.000Z' },
    '{incomplete',
  ]) {
    const dirs = temporary(t);
    abandonedLock(dirs, owner);
    const result = await runPipeline(buildPlan('drafts-backfill'), { ...dirs, runner: async () => ({ exitCode: 0 }) });
    assert.equal(result.exitCode, 0, result.error);
    assert.match(readFileSync(join(dirs.logDir, 'drafts-backfill.log'), 'utf8'), /lock-recovered/);
    assert.equal(existsSync(join(dirs.stateDir, 'pipeline.lock')), false);
  }
});

test('two Windows recovery contenders cannot both enter an abandoned lock', { skip: process.platform !== 'win32' }, async t => {
  const dirs = temporary(t);
  abandonedLock(dirs, { pid: 2147483647, runId: 'abandoned', startedAt: '2000-01-01T00:00:00.000Z' });
  let entered;
  let resume;
  let entries = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  const jobs = ['hourly', 'daily'].map(name => runPipeline({ name, continueOnError: false, steps: [{ name: 'test', args: [] }] }, {
    ...dirs, runner: async () => {entries++; entered(); await gate; return { exitCode: 0 };},
  }));
  try {
    await started;
    const blocked = await Promise.race(jobs);
    assert.equal(blocked.exitCode, 75);
    assert.equal(entries, 1);
  } finally {resume();}
  assert.deepEqual((await Promise.all(jobs)).map(result => result.exitCode).sort((a, b) => a - b), [0, 75]);
});

test('forced termination of a Windows runner tree leaves a recoverable lock', { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
  const dirs = temporary(t);
  const moduleUrl = pathToFileURL(runnerPath).href;
  const childCode = `import {runPipeline} from ${JSON.stringify(moduleUrl)}; let finish; const gate=new Promise(resolve=>{finish=resolve}); process.on('message',()=>finish()); await runPipeline({name:'hourly',continueOnError:false,steps:[{name:'test',args:[]}]}, {...${JSON.stringify(dirs)},runner:async()=>{console.log('READY');await gate;return {exitCode:0};}});process.disconnect?.();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  child.stderr.resume();
  try {
    await new Promise((resolveReady, rejectReady) => {
    let output = '';
    child.once('error', rejectReady);
    child.once('close', () => rejectReady(new Error('Test runner exited before acquiring its lock')));
    child.stdout.on('data', chunk => {output += chunk; if (output.includes('READY')) resolveReady();});
    });
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    const killed = spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
    assert.equal(killed.status, 0, killed.stderr);
    await closed;
    assert.equal(existsSync(join(dirs.stateDir, 'pipeline.lock')), true);
    const result = await runPipeline(buildPlan('drafts-backfill'), { ...dirs, runner: async () => ({ exitCode: 0 }) });
    assert.equal(result.exitCode, 0, result.error);
    assert.equal(existsSync(join(dirs.stateDir, 'pipeline.lock')), false);
  } finally {
    // A sandbox can deny taskkill; ask the fake runner to exit cleanly then.
    if (child.connected) child.send('finish');
    await closed;
  }
});
