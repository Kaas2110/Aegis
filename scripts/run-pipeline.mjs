import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const filename = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(filename), '..');
const configuration = JSON.parse(readFileSync(join(dirname(filename), 'job-schedules.json'), 'utf8'));
export const pipelineNames = Object.keys(configuration.pipelines);

function integerSetting(value, env) {
  if (typeof value === 'number') return value;
  const raw = env[value.env] ?? String(value.default);
  if (!/^\d+$/.test(raw)) throw new Error(`${value.env} must be an integer from ${value.min} to ${value.max}`);
  const result = Number(raw);
  if (!Number.isSafeInteger(result) || result < value.min || result > value.max) {
    throw new Error(`${value.env} must be an integer from ${value.min} to ${value.max}`);
  }
  return result;
}

export function parseArguments(args) {
  let name;
  let dryRun = false;
  let help = false;
  for (const arg of args) {
    if (arg === '--') continue;
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (!arg.startsWith('-') && !name) name = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (name && !pipelineNames.includes(name)) throw new Error(`Unknown pipeline: ${name}`);
  if (!name && !help) throw new Error(`Choose a pipeline: ${pipelineNames.join(', ')}`);
  return { name, dryRun, help };
}

export function buildPlan(name, env = process.env) {
  if (!pipelineNames.includes(name)) throw new Error(`Unknown pipeline: ${name}`);
  const spec = configuration.pipelines[name];
  return {
    name,
    continueOnError: spec.continueOnError,
    steps: spec.steps.map(step => step.waitSeconds !== undefined
      ? { name: step.name, waitMs: integerSetting(step.waitSeconds, env) * 1000 }
      : {
          name: step.script,
          ...(step.optional === true ? { optional: true, skippedExitCodes: step.skippedExitCodes ?? [] } : {}),
          args: ['--filter', '@workspace/scripts', 'run', step.script,
            ...(step.args ?? []).map(arg => typeof arg === 'string' ? arg : String(integerSetting(arg, env)))],
        }),
  };
}

export function pnpmCommand(env = process.env, platform = process.platform, dryRun = false) {
  const cli = env.AEGIS_PNPM_CLI;
  if (cli) {
    if (!isAbsolute(cli) || !['.js', '.cjs', '.mjs'].includes(extname(cli).toLowerCase())) {
      throw new Error('AEGIS_PNPM_CLI must be an absolute path to the pnpm JavaScript CLI, not a .cmd wrapper');
    }
    if (!dryRun && (!existsSync(cli) || !statSync(cli).isFile())) throw new Error('AEGIS_PNPM_CLI does not point to a file');
    return { command: process.execPath, prefix: [cli] };
  }
  if (platform === 'win32') {
    if (dryRun) return { command: process.execPath, prefix: ['<AEGIS_PNPM_CLI>'] };
    throw new Error('Set AEGIS_PNPM_CLI to the absolute pnpm.cjs path before running a pipeline on Windows');
  }
  return { command: 'pnpm', prefix: [] };
}

function interruptionCode(signal) {
  return signal?.reason === 'SIGTERM' ? 143 : 130;
}

// A separate process group on Unix and taskkill /T on Windows terminate pnpm,
// tsx, and the worker together; killing only the pnpm parent leaves workers alive.
export function spawnCommand(command, args, { cwd, env, signal, output = () => {} }) {
  if (signal?.aborted) return Promise.resolve({ exitCode: interruptionCode(signal), interrupted: true });
  return new Promise(resolveResult => {
    let settled = false;
    let termination = Promise.resolve();
    let terminating = false;
    const child = spawn(command, args, {
      cwd, env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const terminate = () => {
      if (!child.pid || settled || terminating) return;
      terminating = true;
      if (process.platform === 'win32') {
        termination = new Promise(done => {
          const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
          const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
            shell: false, windowsHide: true, stdio: 'ignore',
          });
          killer.once('error', error => {
            output(`[pipeline] Could not terminate process tree: ${error.message}\n`);
            child.kill();
            done();
          });
          killer.once('exit', code => { if (code !== 0 && !settled) child.kill(); done(); });
        });
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') child.kill('SIGTERM'); }
        termination = delay(500).then(() => {
          try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') output(`[pipeline] ${error.message}\n`); }
        });
      }
    };
    const finish = async result => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', terminate);
      await termination;
      resolveResult(signal?.aborted ? { ...result, exitCode: interruptionCode(signal), interrupted: true } : result);
    };
    child.stdout.on('data', output);
    child.stderr.on('data', output);
    child.once('error', error => finish({ exitCode: 1, error: error.message }));
    child.once('close', (code, childSignal) => finish({ exitCode: code ?? 1, signal: childSignal }));
    signal?.addEventListener('abort', terminate, { once: true });
    if (signal?.aborted) terminate();
  });
}

function writeStatus(path, status) {
  const temporary = `${path}.${status.runId}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(status, null, 2)}\n`);
  renameSync(temporary, path);
}

function lockConflict(path, owner) {
  const conflict = new Error(`Another pipeline owns the lock at ${path}.`);
  conflict.code = 'PIPELINE_LOCKED';
  conflict.owner = owner;
  return conflict;
}

// Serialize both recovery and execution with an OS-owned Windows file handle.
// Unlike a mkdir-only recovery mutex, the guard cannot itself become stale.
export function acquireWindowsLock(stateDir, owner) {
  const lockPath = join(stateDir, 'pipeline.lock');
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const helper = spawn(powershell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(dirname(filename), 'pipeline-lock.ps1'),
    '-StateDirectory', stateDir, '-OwnerJsonBase64', Buffer.from(JSON.stringify(owner)).toString('base64'),
  ], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  helper.stderr.resume();
  helper.stdin.on('error', () => {});
  const closed = new Promise(resolveClosed => helper.once('close', resolveClosed));
  return new Promise((resolveLock, rejectLock) => {
    let response = '';
    let acknowledged = false;
    const deadline = setTimeout(() => {
      helper.kill();
      rejectLock(new Error('Windows pipeline lock helper timed out.'));
    }, 10_000);
    const finish = (error, result) => {
      if (acknowledged) return;
      acknowledged = true;
      clearTimeout(deadline);
      if (error) {helper.stdin.end(); rejectLock(error); return;}
      const release = async () => {
        try {
          const current = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8'));
          if (current.runId === owner.runId) rmSync(lockPath, { recursive: true, force: true });
        } finally {
          helper.stdin.end();
          await closed;
        }
      };
      release.recovered = result.recovered;
      release.previousRunId = result.previousRunId;
      resolveLock(release);
    };
    helper.once('error', () => finish(new Error('Could not start the Windows pipeline lock helper.')));
    helper.once('close', () => finish(new Error('Windows pipeline lock helper exited before acquiring the lock.')));
    helper.stdout.on('data', chunk => {
      if (acknowledged) return;
      response += chunk.toString();
      if (!response.includes('\n')) return;
      try {
        const result = JSON.parse(response.split('\n')[0]);
        if (result.state === 'blocked') finish(lockConflict(lockPath, result.owner));
        else if (result.state === 'acquired') finish(null, result);
        else finish(new Error('Could not acquire the Windows pipeline lock.'));
      } catch {finish(new Error('Windows pipeline lock helper returned an invalid response.'));}
    });
  });
}

function acquireLock(stateDir, owner) {
  if (process.platform === 'win32') return acquireWindowsLock(stateDir, owner);
  const path = join(stateDir, 'pipeline.lock');
  try {
    mkdirSync(path);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let existing;
    try { existing = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')); } catch { /* Another process may still be writing its owner. */ }
    throw lockConflict(path, existing);
  }
  try {
    writeFileSync(join(path, 'owner.json'), JSON.stringify(owner, null, 2));
  } catch (error) {
    rmSync(path, { recursive: true, force: true });
    throw error;
  }
  return () => {
    const current = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
    if (current.runId === owner.runId) rmSync(path, { recursive: true, force: true });
  };
}

export async function runPipeline(plan, options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? repositoryRoot;
  const signal = options.signal;
  const stateDir = resolve(options.stateDir ?? env.AEGIS_STATE_DIR ?? join(repositoryRoot, '.local', 'state'));
  const logDir = resolve(options.logDir ?? env.AEGIS_LOG_DIR ?? join(repositoryRoot, '.local', 'logs'));
  const command = options.runner ? null : pnpmCommand(env);
  const now = () => new Date().toISOString();
  const status = {
    version: 1, runId: randomUUID(), pipeline: plan.name, pid: process.pid,
    startedAt: now(), state: 'starting', exitCode: null, steps: [],
  };
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${plan.name}.log`);
  const statusPath = join(logDir, `${plan.name}.status.json`);
  const runStatusPath = join(logDir, `${plan.name}.${status.runId}.status.json`);
  const output = chunk => {
    appendFileSync(logPath, chunk);
    if (!options.quiet) process.stdout.write(chunk);
  };
  const event = (type, extra = {}) => output(`${JSON.stringify({ at: now(), runId: status.runId, pipeline: plan.name, event: type, ...extra })}\n`);
  let releaseLock;
  const save = () => {
    writeStatus(runStatusPath, status);
    if (releaseLock) writeStatus(statusPath, status);
  };
  const runner = options.runner ?? ((step, context) => spawnCommand(command.command, [...command.prefix, ...step.args], {
    cwd, env: { ...env, AEGIS_STATE_DIR: stateDir, AEGIS_PIPELINE_RUN_ID: status.runId,
      AEGIS_PIPELINE_OWNER_PID: String(process.pid) }, ...context,
  }));
  try {
    releaseLock = await acquireLock(stateDir, { runId: status.runId, pid: process.pid, pipeline: plan.name, startedAt: status.startedAt });
    if (releaseLock.recovered) event('lock-recovered', { previousRunId: releaseLock.previousRunId });
    status.state = 'running';
    event('started', { stepCount: plan.steps.length });
    save();
    for (const [index, step] of plan.steps.entries()) {
      if (signal?.aborted) break;
      const record = { index: index + 1, name: step.name, startedAt: now(), state: 'running', optional: step.optional === true };
      status.steps.push(record);
      save();
      event('step-started', { step: record.index, name: step.name, args: step.args, waitMs: step.waitMs });
      let result;
      try {
        if (step.waitMs !== undefined) {
          await delay(step.waitMs, undefined, { signal });
          result = { exitCode: 0 };
        } else {
          result = await runner(step, { signal, output });
        }
        if (!Number.isInteger(result?.exitCode) || result.exitCode < 0 || result.exitCode > 255) {
          throw new Error('Step runner returned an invalid exit code');
        }
      } catch (error) {
        result = { exitCode: signal?.aborted ? interruptionCode(signal) : 1, error: error.message };
      }
      if (signal?.aborted) result = { ...result, exitCode: interruptionCode(signal), interrupted: true };
      const skipped = step.optional === true && step.skippedExitCodes?.includes(result.exitCode);
      Object.assign(record, result, {
        finishedAt: now(), state: signal?.aborted ? 'interrupted' : result.exitCode === 0 ? 'succeeded'
          : skipped ? 'skipped' : step.optional === true ? 'degraded' : 'failed',
      });
      event('step-finished', { step: record.index, name: step.name, state: record.state, exitCode: record.exitCode });
      save();
      if (signal?.aborted || (result.exitCode !== 0 && step.optional !== true && !plan.continueOnError)) break;
    }
    const failure = status.steps.find(step => step.exitCode !== 0 && !step.optional);
    const degraded = status.steps.some(step => step.state === 'degraded');
    status.exitCode = signal?.aborted ? interruptionCode(signal) : failure?.exitCode ?? 0;
    status.state = signal?.aborted ? 'interrupted' : failure ? 'failed' : degraded ? 'degraded' : 'succeeded';
  } catch (error) {
    status.state = error.code === 'PIPELINE_LOCKED' ? 'blocked' : 'failed';
    status.exitCode = error.code === 'PIPELINE_LOCKED' ? 75 : 1;
    status.error = error.message;
    if (error.owner) status.lockOwner = error.owner;
  } finally {
    status.finishedAt = now();
    try {
      save();
      event('finished', { state: status.state, exitCode: status.exitCode, error: status.error });
    } finally {
      await releaseLock?.();
    }
  }
  return status;
}

export async function main(args = process.argv.slice(2)) {
  let options;
  let plan;
  try {
    options = parseArguments(args);
    if (options.help) {
      console.log(`Usage: node scripts/run-pipeline.mjs <${pipelineNames.join('|')}> [--dry-run]\nAEGIS_PNPM_CLI: absolute pnpm.cjs path (required on Windows)\nAEGIS_STATE_DIR / AEGIS_LOG_DIR: local lock and log directories\nReplay/parse limits: see scripts/job-schedules.json. Timers are disabled by default.`);
      return 0;
    }
    plan = buildPlan(options.name);
    const command = pnpmCommand(process.env, process.platform, options.dryRun);
    if (options.dryRun) {
      console.log(JSON.stringify({ dryRun: true, cwd: repositoryRoot, ...plan,
        steps: plan.steps.map(step => step.waitMs === undefined
          ? { ...step, command: command.command, args: [...command.prefix, ...step.args] }
          : step) }, null, 2));
      return 0;
    }
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  const controller = new AbortController();
  const onInterrupt = () => controller.abort('SIGINT');
  const onTerminate = () => controller.abort('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  try {
    const result = await runPipeline(plan, { signal: controller.signal });
    return result.exitCode;
  } catch (error) {
    console.error(`Pipeline failed: ${error.message}`);
    return 1;
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === filename) process.exitCode = await main();
