/**
 * Импорт дампа из старого workspace (JSON-файлы из attached_assets).
 * Идемпотентен: использует ON CONFLICT для таблиц с уникальным ключом
 * и skip-if-non-empty для append-only таблиц (live_snapshots, predictions).
 *
 * Запуск: pnpm --filter @workspace/scripts run import:snapshot [dir]
 *   default dir = attached_assets
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pool } from '@workspace/db';

const DIR = resolve(process.argv[2] ?? 'attached_assets');
const BATCH = 200;

function findFile(prefix: string): string | null {
  const files = readdirSync(DIR).filter(f => f.startsWith(prefix + '_') && f.endsWith('.json'));
  if (files.length === 0) return null;
  return join(DIR, files[0]!);
}

function loadRows<T = Record<string, unknown>>(prefix: string): T[] {
  const fp = findFile(prefix);
  if (!fp) {
    console.log(`[import] ${prefix}: file not found, skipping`);
    return [];
  }
  const data = JSON.parse(readFileSync(fp, 'utf8')) as T[];
  console.log(`[import] ${prefix}: ${data.length} rows from ${fp.split('/').pop()}`);
  return data;
}

interface ImportSpec {
  prefix: string;
  table: string;
  cols: string[];                       // db column names in snake_case
  conflict?: { target: string; mode: 'update' | 'nothing' };
  skipIfNonEmpty?: boolean;             // if true, skip table when destination has rows
  jsonbCols?: string[];                 // these need JSON.stringify
  timestampCols?: string[];             // ISO string → keep as-is, pg parses
}

const SPECS: ImportSpec[] = [
  {
    prefix: 'teams',
    table: 'teams',
    cols: ['team_id', 'name', 'tag', 'rating', 'wins', 'losses', 'last_match_time', 'updated_at'],
    conflict: { target: '(team_id)', mode: 'update' },
    timestampCols: ['updated_at'],
  },
  {
    prefix: 'pro_matches',
    table: 'pro_matches',
    cols: ['match_id', 'start_time', 'duration', 'radiant_team_id', 'dire_team_id', 'radiant_name', 'dire_name', 'radiant_score', 'dire_score', 'radiant_win', 'league_id', 'league_name', 'series_id', 'series_type', 'first_blood_time', 'barracks_status_radiant', 'barracks_status_dire', 'tower_status_radiant', 'tower_status_dire', 'ingested_at'],
    conflict: { target: '(match_id)', mode: 'update' },
    timestampCols: ['ingested_at'],
  },
  {
    prefix: 'match_drafts',
    table: 'match_drafts',
    cols: ['match_id', 'radiant_picks', 'dire_picks', 'radiant_bans', 'dire_bans', 'radiant_account_ids', 'dire_account_ids', 'fetched_at'],
    conflict: { target: '(match_id)', mode: 'update' },
    jsonbCols: ['radiant_picks', 'dire_picks', 'radiant_bans', 'dire_bans', 'radiant_account_ids', 'dire_account_ids'],
    timestampCols: ['fetched_at'],
  },
  {
    prefix: 'hero_stats',
    table: 'hero_stats',
    cols: ['hero_id', 'name', 'primary_attr', 'attack_type', 'pro_pick_count', 'pro_ban_count', 'pro_win_count', 'pro_pick_rate', 'pro_ban_rate', 'pro_win_rate', 'patch', 'updated_at'],
    conflict: { target: '(hero_id)', mode: 'update' },
    timestampCols: ['updated_at'],
  },
  {
    prefix: 'hero_matchups',
    table: 'hero_matchups',
    cols: ['hero_id', 'vs_hero_id', 'games', 'wins', 'win_rate', 'updated_at'],
    conflict: { target: '(hero_id, vs_hero_id)', mode: 'update' },
    timestampCols: ['updated_at'],
  },
  {
    prefix: 'players',
    table: 'players',
    cols: ['account_id', 'persona_name', 'pro_name', 'country_code', 'last_seen', 'updated_at'],
    conflict: { target: '(account_id)', mode: 'update' },
    timestampCols: ['updated_at'],
  },
  {
    prefix: 'player_hero_stats',
    table: 'player_hero_stats',
    cols: ['account_id', 'hero_id', 'games', 'wins', 'last_played', 'updated_at'],
    conflict: { target: '(account_id, hero_id)', mode: 'update' },
    timestampCols: ['updated_at'],
  },
  {
    prefix: 'team_recent_form',
    table: 'team_recent_form',
    cols: ['team_id', 'period_days', 'games', 'wins', 'win_rate', 'avg_kills_for', 'avg_kills_against', 'avg_duration_sec', 'computed_at'],
    conflict: { target: '(team_id, period_days)', mode: 'update' },
    timestampCols: ['computed_at'],
  },
  {
    prefix: 'team_h2h',
    table: 'team_h2h',
    cols: ['team_low_id', 'team_high_id', 'period_days', 'games', 'wins_low', 'computed_at'],
    conflict: { target: '(team_low_id, team_high_id, period_days)', mode: 'update' },
    timestampCols: ['computed_at'],
  },
  {
    prefix: 'bo3_series',
    table: 'bo3_series',
    cols: ['series_id', 'team_a_id', 'team_b_id', 'format', 'maps', 'wins_a', 'wins_b', 'finished', 'updated_at'],
    conflict: { target: '(series_id)', mode: 'update' },
    jsonbCols: ['maps'],
    timestampCols: ['updated_at'],
  },
  {
    prefix: 'model_versions',
    // id колонку пропускаем — пусть генерится новый serial; уникальность по version
    table: 'model_versions',
    // is_active НЕ переносим — в новой БД уже есть свои активные; финальная
    // активация делается ниже отдельным UPDATE по самой свежей модели.
    cols: ['version', 'kind', 'algorithm', 'features', 'weights', 'features_version', 'train_accuracy', 'test_accuracy', 'brier_score', 'train_sample_size', 'test_sample_size', 'metadata', 'created_at'],
    conflict: { target: '(version)', mode: 'nothing' },
    jsonbCols: ['features', 'weights', 'metadata'],
    timestampCols: ['created_at'],
  },
  {
    prefix: 'prematch_outcomes',
    table: 'prematch_outcomes',
    cols: ['match_id', 'model_version', 'predicted_at', 'radiant_team_id', 'dire_team_id', 'radiant_name', 'dire_name', 'league_name', 'predicted_radiant_win_prob', 'predicted_confidence', 'actual_radiant_win', 'actual_radiant_score', 'actual_dire_score', 'actual_duration_sec', 'resolved_at', 'features'],
    conflict: { target: '(match_id)', mode: 'nothing' },
    jsonbCols: ['features'],
    timestampCols: ['predicted_at', 'resolved_at'],
  },
  {
    prefix: 'live_snapshots',
    table: 'live_snapshots',
    cols: ['match_id', 'captured_at', 'game_time_sec', 'radiant_team_id', 'dire_team_id', 'radiant_score', 'dire_score', 'radiant_lead', 'building_state', 'raw_payload'],
    skipIfNonEmpty: true,
    jsonbCols: ['raw_payload'],
    timestampCols: ['captured_at'],
  },
  {
    prefix: 'predictions',
    table: 'predictions',
    cols: ['match_id', 'model_version', 'market_type', 'predicted_at', 'model_prob_team1', 'model_prob_team2', 'market_odds1', 'market_odds2', 'edge', 'ev', 'confidence', 'features', 'outcome', 'resolved_at'],
    skipIfNonEmpty: true,
    jsonbCols: ['features'],
    timestampCols: ['predicted_at', 'resolved_at'],
  },
  {
    prefix: 'app_settings',
    table: 'app_settings',
    cols: ['id', 'use_bookmaker_odds', 'live_snapshot_prune_days', 'notes', 'updated_at'],
    conflict: { target: '(id)', mode: 'update' },
    timestampCols: ['updated_at'],
  },
  {
    prefix: 'scheduler_state',
    table: 'scheduler_state',
    cols: ['id', 'last_patch_seen', 'last_patch_detected_at', 'last_ingest_at', 'last_train_at', 'next_train_due_at', 'last_check_at', 'last_error', 'notes', 'updated_at'],
    conflict: { target: '(id)', mode: 'update' },
    jsonbCols: ['notes'],
    timestampCols: ['last_patch_detected_at', 'last_ingest_at', 'last_train_at', 'next_train_due_at', 'last_check_at', 'updated_at'],
  },
];

async function importTable(spec: ImportSpec): Promise<{ inserted: number; skipped: boolean }> {
  const rows = loadRows(spec.prefix);
  if (rows.length === 0) return { inserted: 0, skipped: true };

  if (spec.skipIfNonEmpty) {
    const r = await pool.query(`SELECT count(*)::int AS c FROM ${spec.table}`);
    if ((r.rows[0]?.c ?? 0) > 0) {
      console.log(`[import] ${spec.table}: target non-empty (${r.rows[0].c} rows), skipping append-only import`);
      return { inserted: 0, skipped: true };
    }
  }

  const jsonbSet = new Set(spec.jsonbCols ?? []);
  let inserted = 0;
  for (let off = 0; off < rows.length; off += BATCH) {
    const chunk = rows.slice(off, off + BATCH);
    const params: unknown[] = [];
    const valuesSql: string[] = [];
    for (const row of chunk) {
      const r = row as Record<string, unknown>;
      const placeholders: string[] = [];
      for (const col of spec.cols) {
        const v = r[col];
        if (v === undefined || v === null) {
          placeholders.push('NULL');
        } else if (jsonbSet.has(col)) {
          params.push(JSON.stringify(v));
          placeholders.push(`$${params.length}::jsonb`);
        } else {
          params.push(v);
          placeholders.push(`$${params.length}`);
        }
      }
      valuesSql.push(`(${placeholders.join(',')})`);
    }
    const colsSql = spec.cols.join(',');
    let sql = `INSERT INTO ${spec.table} (${colsSql}) VALUES ${valuesSql.join(',')}`;
    if (spec.conflict) {
      if (spec.conflict.mode === 'nothing') {
        sql += ` ON CONFLICT ${spec.conflict.target} DO NOTHING`;
      } else {
        const updates = spec.cols
          .filter(c => !spec.conflict!.target.includes(c))
          .map(c => `${c} = EXCLUDED.${c}`)
          .join(',');
        sql += ` ON CONFLICT ${spec.conflict.target} DO UPDATE SET ${updates}`;
      }
    }
    await pool.query(sql, params);
    inserted += chunk.length;
    process.stdout.write(`\r[import] ${spec.table}: ${inserted}/${rows.length}`);
  }
  process.stdout.write('\n');
  return { inserted, skipped: false };
}

async function main() {
  console.log(`[import] Source: ${DIR}\n`);
  const summary: Array<{ table: string; inserted: number; skipped: boolean }> = [];
  for (const spec of SPECS) {
    try {
      const r = await importTable(spec);
      summary.push({ table: spec.table, ...r });
    } catch (err) {
      console.error(`[import] ${spec.table} FAILED:`, (err as Error).message);
      summary.push({ table: spec.table, inserted: 0, skipped: true });
    }
  }

  // Активная модель: если в БД нет ни одной активной prematch_winner v1 — активируем самую новую из импортированных
  await pool.query(`
    UPDATE model_versions SET is_active = true
    WHERE id = (
      SELECT id FROM model_versions
      WHERE kind = 'prematch_winner' AND features_version = 1
      ORDER BY created_at DESC NULLS LAST, id DESC LIMIT 1
    )
    AND NOT EXISTS (
      SELECT 1 FROM model_versions
      WHERE kind = 'prematch_winner' AND features_version = 1 AND is_active = true
    )
  `);

  console.log('\n=== SUMMARY ===');
  for (const s of summary) {
    console.log(`  ${s.table.padEnd(22)} ${s.skipped ? 'skipped' : `+${s.inserted} rows`}`);
  }

  // Final counts
  const tables = SPECS.map(s => s.table);
  const seen = new Set<string>();
  console.log('\n=== ROW COUNTS ===');
  for (const t of tables) {
    if (seen.has(t)) continue;
    seen.add(t);
    const r = await pool.query(`SELECT count(*)::int AS c FROM ${t}`);
    console.log(`  ${t.padEnd(22)} ${r.rows[0]?.c ?? '?'}`);
  }

  await pool.end();
  process.exit(0);
}

main().catch(err => {
  console.error('[import] FATAL', err);
  process.exit(1);
});
