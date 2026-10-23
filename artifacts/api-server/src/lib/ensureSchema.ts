/**
 * Auto-bootstrap БД при первом старте production-сервера.
 *
 * Логика: пробуем простой SELECT по pro_matches. Если таблица отсутствует
 * (Postgres код 42P01) — спавним `pnpm --filter @workspace/db run push`.
 * После пуша тот же SELECT должен пройти. Любые другие ошибки — логируем
 * и пропускаем (сервер всё равно стартует, scheduler позже разберётся).
 *
 * Управление: ENV AUTO_DB_PUSH=false полностью выключает (для прод-окружений
 * где схема обновляется отдельным CI-шагом).
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { db } from '@workspace/db';
import { sql } from 'drizzle-orm';
import { logger } from './logger';
import { pnpmCommand } from './processCommand';

// Критичные таблицы, без которых сервер не сможет работать.
// Если хоть одной нет — запускаем drizzle-kit push (idempotent).
const REQUIRED_TABLES = [
  'pro_matches',
  'scheduler_state',
  'app_settings',
  'model_versions',
  'player_ratings',
  'live_snapshots',
  'prematch_outcomes',
];

const WORKSPACE_ROOT = path.resolve(process.cwd(), '../..');

function runDbPush(timeoutMs = 60_000): Promise<{ code: number; tail: string }> {
  return new Promise((resolve) => {
    const [command, args] = pnpmCommand(['--filter', '@workspace/db', 'run', 'push']);
    const child = spawn(
      command,
      args,
      { cwd: WORKSPACE_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const buf: string[] = [];
    const collect = (c: Buffer) => {
      for (const l of c.toString('utf8').split('\n')) {
        if (l.trim()) { buf.push(l); if (buf.length > 50) buf.shift(); }
      }
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const killer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* ignore */ } }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ code: code ?? -1, tail: buf.slice(-15).join('\n') });
    });
    child.on('error', (err) => {
      clearTimeout(killer);
      resolve({ code: -1, tail: `spawn error: ${String(err)}` });
    });
  });
}

export async function ensureSchema(): Promise<void> {
  if (process.env['AUTO_DB_PUSH'] === 'false') {
    logger.info('[ensureSchema] AUTO_DB_PUSH=false — пропускаю');
    return;
  }
  try {
    // sql.raw безопасен: REQUIRED_TABLES — захардкоженный const, не user-input.
    // Через IN (...) обходим проблему drizzle-биндингов в ANY(text[]).
    const inList = REQUIRED_TABLES.map((t) => `'${t}'`).join(', ');
    const rows = await db.execute<{ table_name: string }>(sql.raw(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN (${inList})
    `));
    const present = new Set(rows.rows.map((r) => r.table_name));
    const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
    if (missing.length === 0) {
      logger.info({ tables: REQUIRED_TABLES.length }, '[ensureSchema] все критичные таблицы на месте');
      return;
    }
    logger.warn({ missing }, '[ensureSchema] отсутствуют таблицы — запускаю drizzle-kit push');
  } catch (err) {
    // Любая ошибка при INFORMATION_SCHEMA-запросе (например, нет прав или
    // битый коннект) — лучше попробовать push, чем молча пропустить.
    logger.warn({ err: String(err) }, '[ensureSchema] не удалось прочитать information_schema, пробую db push');
  }

  try {
    const r = await runDbPush();
    if (r.code === 0) {
      logger.info({ tail: r.tail }, '[ensureSchema] db push успешен');
    } else {
      logger.error({ code: r.code, tail: r.tail }, '[ensureSchema] db push провалился — продолжаю без схемы');
    }
  } catch (err) {
    logger.error({ err: String(err) }, '[ensureSchema] не смог запустить db push');
  }
}
