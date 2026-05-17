/**
 * Admin-роуты. Все защищены cookie-сессией (выдаётся через POST /api/admin/login,
 * см. routes/adminAuth.ts). Использует артефакт admin-web (React+Vite) — старый
 * inline /api/admin-ui удалён.
 *
 * Эндпоинты:
 *   GET  /api/admin/settings         — текущие глобальные настройки + статус Odds API
 *   POST /api/admin/settings         — обновить настройки (toggle бухмекера, prune days, ...)
 *   GET  /api/admin/metrics          — агрегированные метрики качества ML-модели
 *   POST /api/admin/retrain          — ручной триггер переобучения
 *   POST /api/admin/prune-snapshots  — ручной триггер чистки live_snapshots
 *   GET  /api/admin/odds-status      — состояние Odds API (есть ли ключ, последняя выборка)
 *   GET  /api/admin/scheduler/state  — текущее состояние scheduler-воркера
 *   GET  /api/admin/models           — список активных ML-моделей
 *   GET  /api/admin/integrations     — список внешних API-интеграций + статус ключей
 *   PUT  /api/admin/integrations     — задать/очистить override ENV-ключа
 *   POST /api/admin/bookmakers/probe — diagnostic: live-probe букмекерских адаптеров
 *   GET  /api/admin/coverage          — покрытие БД: drafts/parsed/player stats/team features
 *   GET  /api/admin/od-usage          — расход OpenDota API (in-memory, $0.0001/req)
 */

import { Router, type IRouter } from 'express';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getAppSettings, updateAppSettings, invalidateAppSettingsCache } from '../services/AppSettings';
import {
  triggerManualRetrain,
  getSchedulerState,
  runTrainScriptManual,
  TRAIN_SCRIPT_WHITELIST,
  type TrainScriptName,
} from '../services/SchedulerWorker';
import { getModelAccuracyMetrics, pruneLiveSnapshots } from '../services/OutcomeTracker';
import { fetchDota2Odds } from '../services/OddsApiAdapter';
import { listIntegrations, setIntegrationOverride, KNOWN_INTEGRATIONS, getApiKey } from '../services/ApiKeysService';
import { requireAdminSession } from './adminAuth';
import { KNOWN_SOURCE_IDS, probeSource, clearBookmakerCache, getSourceTrackers, ENV_NAME_TO_SOURCE, type SourceProbeResult } from './bookmakers';
import { clearResponseCache } from '../lib/responseCache';
import {
  db,
  appSettingsTable,
  modelVersionsTable,
  matchParseQueueTable,
  matchParsedTable,
  proMatchesTable,
  matchDraftsTable,
  playerHeroStatsTable,
  playerRatingsTable,
  teamRecentFormTable,
  teamExtendedFeaturesTable,
  teamH2HTable,
  liveSnapshotsTable,
  prematchOutcomesTable,
} from '@workspace/db';
import { desc, eq, sql } from 'drizzle-orm';
import { getOdUsageStats } from '../lib/openDotaUrl';

// ── F3: In-memory job store for one-shot admin script runs ──────────────────
interface AdminJob {
  id: string;
  script: string;
  args: string[];
  status: 'running' | 'done' | 'failed';
  startedAt: Date;
  finishedAt?: Date;
  exitCode?: number;
  output: string[];
}
const adminJobs = new Map<string, AdminJob>();
const MAX_JOB_OUTPUT = 300;
const MAX_JOBS_STORED = 20;

const ALLOWED_RUN_SCRIPTS = new Set([
  'ingest:drafts', 'ingest:players-heroes', 'ingest:hero-stats',
  'ingest:hero-matchups', 'ingest:hero-synergy', 'ingest:matches',
  'ingest:teams', 'ingest:leagues', 'ingest:od-scenarios',
  'ingest:od-player-peers', 'ingest:od-distributions',
  'compute:recent-form', 'compute:h2h', 'compute:player-glicko',
  'compute:team-extended', 'compute:bo3-series',
  'parse:request', 'ingest:parsed',
  'backfill:live-snapshots',
]);

const ADMIN_WORKSPACE_ROOT = path.resolve(process.cwd(), '../..');

const router: IRouter = Router();

// Cookie session required (see adminAuth.ts).
router.use(requireAdminSession);

router.get('/settings', async (_req, res) => {
  const settings = await getAppSettings(true);
  res.json({
    settings,
    oddsApiKeyConfigured: !!getApiKey('ODDS_API_KEY'),
  });
});

router.post('/settings', async (req, res) => {
  const body = req.body as {
    useBookmakerOdds?: boolean;
    liveSnapshotPruneDays?: number;
    trainWindowDays?: number;
    trainMaxPatches?: number;
    trainMinSamples?: number;
    notes?: string | null;
  };
  const patch: Parameters<typeof updateAppSettings>[0] = {};
  if (typeof body.useBookmakerOdds === 'boolean') patch.useBookmakerOdds = body.useBookmakerOdds;
  if (typeof body.liveSnapshotPruneDays === 'number' && body.liveSnapshotPruneDays >= 1 && body.liveSnapshotPruneDays <= 365) {
    patch.liveSnapshotPruneDays = body.liveSnapshotPruneDays;
  }
  if (typeof body.trainWindowDays === 'number' && body.trainWindowDays >= 30 && body.trainWindowDays <= 730) {
    patch.trainWindowDays = body.trainWindowDays;
  }
  if (typeof body.trainMaxPatches === 'number' && body.trainMaxPatches >= 1 && body.trainMaxPatches <= 20) {
    patch.trainMaxPatches = body.trainMaxPatches;
  }
  if (typeof body.trainMinSamples === 'number' && body.trainMinSamples >= 50 && body.trainMinSamples <= 100000) {
    patch.trainMinSamples = body.trainMinSamples;
  }
  if (typeof body.notes === 'string' || body.notes === null) patch.notes = body.notes;

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: 'no valid fields in body' });
    return;
  }
  const settings = await updateAppSettings(patch);
  res.json({ settings });
});

router.get('/metrics', async (req, res) => {
  try {
    const metrics = await getModelAccuracyMetrics();
    res.json(metrics);
  } catch (err) {
    req.log.error({ err }, 'admin/metrics failed');
    res.status(500).json({ error: 'internal', details: String(err) });
  }
});

router.post('/retrain', async (_req, res) => {
  const result = await triggerManualRetrain();
  res.json(result);
});

/**
 * POST /api/admin/refresh-all
 *
 * Workaround для dev/Replit-окружения: на проде клиенты опрашивают /matches/live
 * каждые 60s и получают свежие данные автоматически. На Replit нет live-нагрузки,
 * и кэш upstream-ответов (PandaScore upcoming 60с, OpenDota live 30с,
 * букмекеры 60с) может «застрять». Эта кнопка инвалидирует все
 * in-process кэши, чтобы при следующем запросе из мобилки данные подтянулись
 * с upstream без ожидания TTL.
 */
router.post('/refresh-all', (req, res) => {
  clearResponseCache();
  clearBookmakerCache();
  req.log.info({ tag: 'admin', action: 'refresh-all' }, '[admin] all caches cleared');
  res.json({
    ok: true,
    cleared: ['responseCache (matches:*)', 'bookmakerCache (all sources)'],
    hint: 'Следующий запрос из мобилки подтянет свежие данные с upstream.',
    at: new Date().toISOString(),
  });
});

/**
 * POST /api/admin/models/retrain
 * Per-model ручной триггер. Body: { script, label?, market? }.
 *  - script ∈ TRAIN_SCRIPT_WHITELIST (train:model | train:lightgbm |
 *    train:market-models | train:live-model)
 *  - label?  — для train:lightgbm (например "v3/t1" или "v2/fallback")
 *  - market? — для train:market-models (first_blood|total_kills|total_duration|all)
 *
 * Любой неизвестный script/flag возвращает 400. При успешном старте —
 * 200 + { started, reason }. Mutex с full-pipeline retrain'ом.
 */
router.post('/models/retrain', async (req, res) => {
  const body = (req.body ?? {}) as { script?: unknown; label?: unknown; market?: unknown };
  const script = body.script;
  if (typeof script !== 'string' || !(script in TRAIN_SCRIPT_WHITELIST)) {
    res.status(400).json({
      error: 'invalid script',
      allowed: Object.keys(TRAIN_SCRIPT_WHITELIST),
    });
    return;
  }
  const args: Array<{ flag: string; value: string }> = [];
  if (typeof body.label === 'string' && body.label.length > 0) {
    args.push({ flag: '--label', value: body.label });
  }
  if (typeof body.market === 'string' && body.market.length > 0) {
    args.push({ flag: '--market', value: body.market });
  }
  const result = await runTrainScriptManual(script as TrainScriptName, args);
  res.status(result.started ? 200 : 409).json(result);
});

router.post('/prune-snapshots', async (req, res) => {
  const settings = await getAppSettings();
  const raw = (req.body as { days?: unknown })?.days;
  let days = settings.liveSnapshotPruneDays;
  if (raw !== undefined) {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 365) {
      res.status(400).json({ error: 'days must be integer between 1 and 365' });
      return;
    }
    days = raw;
  }
  const deleted = await pruneLiveSnapshots(days);
  res.json({ days, deleted });
});

router.get('/odds-status', async (_req, res) => {
  const result = await fetchDota2Odds();
  res.json(result);
});

/**
 * Snapshot of background scheduler state (last tick, retrain status, step results).
 * Mirrors what /api/analytics/scheduler-status exposes but lives under /admin
 * so admin-web has a single auth domain.
 */
router.get('/scheduler/state', async (_req, res) => {
  const state = await getSchedulerState();
  res.json(state);
});

/**
 * List active model versions (kind, fv, engine, accuracy, brier, sample sizes).
 * Used by admin-web to show what's currently deployed in inference.
 */
/**
 * GET /api/admin/integrations
 * Список всех известных внешних интеграций (data sources / odds feeds / network)
 * с указанием статуса ключа: настроен ли, источник (env/override), маскированный
 * preview, и метаданные (label/description/docUrl/category).
 */
router.get('/integrations', async (_req, res) => {
  const integrations = await listIntegrations();
  const trackers = getSourceTrackers();
  const enriched = integrations.map((integration) => {
    const sourceId = ENV_NAME_TO_SOURCE[integration.envName];
    const tracker = sourceId ? trackers[sourceId] : null;
    if (!tracker) return integration;
    return {
      ...integration,
      requestsTotal: tracker.requestsTotal,
      responsesOk: tracker.responsesOk,
      lastTickStatus: tracker.lastStatus ?? null,
    };
  });
  res.json({ integrations: enriched });
});

/**
 * PUT /api/admin/integrations
 * Установить override для известного env_name. Пустая строка / null → удалить
 * override и вернуться к значению из ENV. Возвращает обновлённый статус.
 */
router.put('/integrations', async (req, res) => {
  const body = req.body as { envName?: unknown; value?: unknown };
  if (typeof body.envName !== 'string') {
    res.status(400).json({ error: 'envName (string) required' });
    return;
  }
  const meta = KNOWN_INTEGRATIONS.find((m) => m.envName === body.envName);
  if (!meta) {
    res.status(400).json({ error: `unknown integration: ${body.envName}` });
    return;
  }
  const value =
    body.value === null || body.value === undefined
      ? null
      : typeof body.value === 'string'
        ? body.value
        : null;
  if (body.value !== null && body.value !== undefined && typeof body.value !== 'string') {
    res.status(400).json({ error: 'value must be string or null' });
    return;
  }
  try {
    const integration = await setIntegrationOverride(body.envName, value);
    res.json({ integration });
  } catch (err) {
    req.log.error({ err, envName: body.envName }, 'failed to update integration override');
    res.status(500).json({ error: String(err) });
  }
});

/**
 * POST /api/admin/bookmakers/probe
 * Diagnostic: 1 raw запрос к каждому букмекеру (либо к указанному `source`).
 * Возвращает HTTP-код, content-type, размер, latency, первые байты, флаг
 * proxyUsed. Per-source rate-limit 30s, чтобы пользователь не залупил
 * заблокированный источник в десятки запросов подряд.
 */
router.post('/bookmakers/probe', async (req, res) => {
  const body = req.body as { source?: unknown };
  const requested =
    typeof body.source === 'string' && body.source.length > 0
      ? [body.source]
      : KNOWN_SOURCE_IDS;
  for (const id of requested) {
    if (!KNOWN_SOURCE_IDS.includes(id)) {
      res.status(400).json({ error: `unknown source: ${id}`, knownSources: KNOWN_SOURCE_IDS });
      return;
    }
  }
  const results: SourceProbeResult[] = await Promise.all(requested.map((id) => probeSource(id)));
  res.json({
    probedAt: new Date().toISOString(),
    proxyConfigured: !!getApiKey('PROXY_URL'),
    results,
  });
});

router.get('/models', async (_req, res) => {
  const rows = await db
    .select({
      id: modelVersionsTable.id,
      kind: modelVersionsTable.kind,
      version: modelVersionsTable.version,
      algorithm: modelVersionsTable.algorithm,
      engine: modelVersionsTable.engine,
      featuresVersion: modelVersionsTable.featuresVersion,
      trainAccuracy: modelVersionsTable.trainAccuracy,
      testAccuracy: modelVersionsTable.testAccuracy,
      brierScore: modelVersionsTable.brierScore,
      trainSampleSize: modelVersionsTable.trainSampleSize,
      testSampleSize: modelVersionsTable.testSampleSize,
      hardMatchAccuracy: modelVersionsTable.hardMatchAccuracy,
      hardMatchBrier: modelVersionsTable.hardMatchBrier,
      hardMatchCount: modelVersionsTable.hardMatchCount,
      createdAt: modelVersionsTable.createdAt,
    })
    .from(modelVersionsTable)
    .where(eq(modelVersionsTable.isActive, true))
    .orderBy(desc(modelVersionsTable.createdAt));
  res.json({ models: rows });
});

/**
 * GET /api/admin/od-usage
 * Расход OpenDota API-ключа (in-memory счётчик, сбрасывается при рестарте).
 * Точный счёт — на api.opendota.com/dashboard.
 */
router.get('/od-usage', (_req, res) => {
  res.json(getOdUsageStats());
});

/**
 * GET /api/admin/coverage
 * Покрытие БД: drafts %, parsed %, player stats, team features, live snapshots.
 * Используется для принятия решений о переходе к крейсерскому режиму и тренировке моделей.
 */
router.get('/coverage', async (_req, res) => {
  const now = new Date();
  const epoch30d = Math.floor(now.getTime() / 1000) - 30 * 86400;
  const epoch60d = Math.floor(now.getTime() / 1000) - 60 * 86400;
  const epoch90d = Math.floor(now.getTime() / 1000) - 90 * 86400;
  const epoch180d = Math.floor(now.getTime() / 1000) - 180 * 86400;
  const epoch365d = Math.floor(now.getTime() / 1000) - 365 * 86400;
  const ts24hAgo = new Date(now.getTime() - 86400_000);

  const [
    draftsCoverage,
    parsedCoverage,
    playerStats,
    teamStats,
    liveStats,
    outcomeStats,
  ] = await Promise.all([
    // Drafts coverage за 30/90/365d
    db.select({
      total365d: sql<number>`COUNT(*) FILTER (WHERE ${proMatchesTable.startTime} >= ${epoch365d})::int`,
      drafted365d: sql<number>`COUNT(DISTINCT ${matchDraftsTable.matchId})
        FILTER (WHERE ${proMatchesTable.startTime} >= ${epoch365d})::int`,
      total90d: sql<number>`COUNT(*) FILTER (WHERE ${proMatchesTable.startTime} >= ${epoch90d})::int`,
      drafted90d: sql<number>`COUNT(DISTINCT ${matchDraftsTable.matchId})
        FILTER (WHERE ${proMatchesTable.startTime} >= ${epoch90d})::int`,
      total30d: sql<number>`COUNT(*) FILTER (WHERE ${proMatchesTable.startTime} >= ${epoch30d})::int`,
      drafted30d: sql<number>`COUNT(DISTINCT ${matchDraftsTable.matchId})
        FILTER (WHERE ${proMatchesTable.startTime} >= ${epoch30d})::int`,
    })
      .from(proMatchesTable)
      .leftJoin(matchDraftsTable, eq(proMatchesTable.matchId, matchDraftsTable.matchId)),

    // Parsed coverage за 60/180d
    db.select({
      total60d: sql<number>`COUNT(*) FILTER (WHERE ${proMatchesTable.startTime} >= ${epoch60d})::int`,
      parsed60d: sql<number>`COUNT(*) FILTER (WHERE ${proMatchesTable.startTime} >= ${epoch60d} AND ${proMatchesTable.isParsed} = true)::int`,
      total180d: sql<number>`COUNT(*) FILTER (WHERE ${proMatchesTable.startTime} >= ${epoch180d})::int`,
      parsed180d: sql<number>`COUNT(*) FILTER (WHERE ${proMatchesTable.startTime} >= ${epoch180d} AND ${proMatchesTable.isParsed} = true)::int`,
      parsedTotal: sql<number>`COUNT(*) FILTER (WHERE ${proMatchesTable.isParsed} = true)::int`,
    })
      .from(proMatchesTable),

    // Player stats
    db.select({
      playerHeroRows: sql<number>`(SELECT COUNT(*)::int FROM ${playerHeroStatsTable})`,
      playerRatingRows: sql<number>`(SELECT COUNT(*)::int FROM ${playerRatingsTable})`,
    })
      .from(playerHeroStatsTable)
      .limit(1),

    // Team features
    db.select({
      recentFormRows: sql<number>`(SELECT COUNT(*)::int FROM ${teamRecentFormTable})`,
      recentFormLastAt: sql<Date | null>`(SELECT MAX(computed_at) FROM ${teamRecentFormTable})`,
      extendedRows: sql<number>`(SELECT COUNT(*)::int FROM ${teamExtendedFeaturesTable})`,
      extendedLastAt: sql<Date | null>`(SELECT MAX(computed_at) FROM ${teamExtendedFeaturesTable})`,
      h2hRows: sql<number>`(SELECT COUNT(*)::int FROM ${teamH2HTable})`,
    })
      .from(teamRecentFormTable)
      .limit(1),

    // Live snapshots last 24h
    db.select({
      snapshotsLast24h: sql<number>`COUNT(*)::int`,
      withStratz: sql<number>`COUNT(*) FILTER (WHERE ${liveSnapshotsTable.stratzFetchedAt} IS NOT NULL)::int`,
      lastCapturedAt: sql<Date | null>`MAX(${liveSnapshotsTable.capturedAt})`,
    })
      .from(liveSnapshotsTable)
      .where(sql`${liveSnapshotsTable.capturedAt} >= ${ts24hAgo}`),

    // Prematch outcomes (для разблокировки live-train)
    db.select({
      total: sql<number>`COUNT(*)::int`,
      last30d: sql<number>`COUNT(*) FILTER (WHERE ${prematchOutcomesTable.predictedAt} >= NOW() - INTERVAL '30 days')::int`,
    })
      .from(prematchOutcomesTable),
  ]);

  const dc = draftsCoverage[0] ?? {};
  const pc = parsedCoverage[0] ?? {};
  const ps = playerStats[0] ?? {};
  const ts = teamStats[0] ?? {};
  const ls = liveStats[0] ?? {};
  const os = outcomeStats[0] ?? {};

  const pct = (a: number, b: number) =>
    b > 0 ? Math.round((a / b) * 1000) / 10 : 0;

  res.json({
    drafts: {
      covered30d: dc.drafted30d,
      total30d: dc.total30d,
      pct30d: pct(dc.drafted30d, dc.total30d),
      covered90d: dc.drafted90d,
      total90d: dc.total90d,
      pct90d: pct(dc.drafted90d, dc.total90d),
      covered365d: dc.drafted365d,
      total365d: dc.total365d,
      pct365d: pct(dc.drafted365d, dc.total365d),
    },
    parsed: {
      parsed60d: pc.parsed60d,
      total60d: pc.total60d,
      pct60d: pct(pc.parsed60d, pc.total60d),
      parsed180d: pc.parsed180d,
      total180d: pc.total180d,
      pct180d: pct(pc.parsed180d, pc.total180d),
      parsedTotal: pc.parsedTotal,
      cruiseReadyThreshold: 80,
      cruiseReady60d: pct(pc.parsed60d, pc.total60d) >= 80,
    },
    playerStats: {
      playerHeroRows: ps.playerHeroRows ?? 0,
      playerRatingRows: ps.playerRatingRows ?? 0,
    },
    teamFeatures: {
      recentFormRows: ts.recentFormRows ?? 0,
      recentFormLastAt: ts.recentFormLastAt ?? null,
      extendedRows: ts.extendedRows ?? 0,
      extendedLastAt: ts.extendedLastAt ?? null,
      h2hRows: ts.h2hRows ?? 0,
    },
    liveSnapshots: {
      last24h: ls.snapshotsLast24h ?? 0,
      withStratzEnrichment: ls.withStratz ?? 0,
      stratzPct: pct(ls.withStratz ?? 0, ls.snapshotsLast24h ?? 0),
      lastCapturedAt: ls.lastCapturedAt ?? null,
    },
    prematchOutcomes: {
      total: os.total ?? 0,
      last30d: os.last30d ?? 0,
      liveTrainReadyThreshold: 200,
      liveTrainReady: (os.total ?? 0) >= 200,
    },
    generatedAt: now.toISOString(),
  });
});

// ── F2: Worker flags (stored in app_settings.store_settings) ───────────────

/**
 * GET /api/admin/workers/config
 * Текущие флаги включения/отключения фоновых воркеров из БД + env.
 */
router.get('/workers/config', async (_req, res) => {
  const settings = await getAppSettings();
  const store = (settings.storeSettings ?? {}) as Record<string, unknown>;
  res.json({
    liveWorkerDisabled: store['liveWorkerDisabled'] === true,
    schedulerDisabled: store['schedulerDisabled'] === true,
    autoRetrainDisabled: store['autoRetrainDisabled'] === true,
    envDisableLiveWorker: process.env['DISABLE_LIVE_WORKER'] === 'true',
    envDisableScheduler: process.env['DISABLE_SCHEDULER'] === 'true',
    envDisableAutoRetrain: process.env['DISABLE_AUTO_RETRAIN'] === 'true',
    note: 'liveWorkerDisabled/schedulerDisabled вступают в силу при следующем рестарте api-server. autoRetrainDisabled — на следующем 24h-тике шедулера.',
  });
});

/**
 * POST /api/admin/workers/config
 * Обновить флаги воркеров в БД. Частичное обновление — передавай только нужные поля.
 */
router.post('/workers/config', async (req, res) => {
  const body = req.body as Partial<{
    liveWorkerDisabled: boolean;
    schedulerDisabled: boolean;
    autoRetrainDisabled: boolean;
  }>;

  const current = await getAppSettings();
  const store = (current.storeSettings ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (typeof body.liveWorkerDisabled === 'boolean') patch['liveWorkerDisabled'] = body.liveWorkerDisabled;
  if (typeof body.schedulerDisabled === 'boolean') patch['schedulerDisabled'] = body.schedulerDisabled;
  if (typeof body.autoRetrainDisabled === 'boolean') patch['autoRetrainDisabled'] = body.autoRetrainDisabled;

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: 'no valid fields to update' });
    return;
  }

  const merged = { ...store, ...patch };
  await db.update(appSettingsTable)
    .set({ storeSettings: merged, updatedAt: new Date() })
    .where(eq(appSettingsTable.id, 1));
  invalidateAppSettingsCache();

  res.json({
    ok: true,
    liveWorkerDisabled: merged['liveWorkerDisabled'] === true,
    schedulerDisabled: merged['schedulerDisabled'] === true,
    autoRetrainDisabled: merged['autoRetrainDisabled'] === true,
    envDisableLiveWorker: process.env['DISABLE_LIVE_WORKER'] === 'true',
    envDisableScheduler: process.env['DISABLE_SCHEDULER'] === 'true',
    envDisableAutoRetrain: process.env['DISABLE_AUTO_RETRAIN'] === 'true',
    note: 'liveWorkerDisabled/schedulerDisabled вступают в силу при следующем рестарте api-server. autoRetrainDisabled — на следующем 24h-тике шедулера.',
  });
});

// ── F3: One-shot admin job runner ───────────────────────────────────────────

/**
 * GET /api/admin/jobs
 * Список последних 20 запущенных job'ов + whitelist скриптов.
 */
router.get('/jobs', (_req, res) => {
  const jobs = [...adminJobs.values()]
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
    .slice(0, MAX_JOBS_STORED)
    .map((j) => ({
      id: j.id,
      script: j.script,
      args: j.args,
      status: j.status,
      startedAt: j.startedAt.toISOString(),
      finishedAt: j.finishedAt?.toISOString() ?? null,
      exitCode: j.exitCode ?? null,
      durationMs: j.finishedAt
        ? j.finishedAt.getTime() - j.startedAt.getTime()
        : Date.now() - j.startedAt.getTime(),
    }));
  res.json({ jobs, allowedScripts: [...ALLOWED_RUN_SCRIPTS].sort() });
});

/**
 * POST /api/admin/jobs/run
 * Запускает pnpm-скрипт в фоне. Немедленно возвращает jobId, не ждёт завершения.
 */
router.post('/jobs/run', (req, res) => {
  const { script, args = [] } = req.body as { script?: string; args?: unknown[] };
  if (!script || !ALLOWED_RUN_SCRIPTS.has(script)) {
    res.status(400).json({ error: `script '${script ?? ''}' not in whitelist`, allowedScripts: [...ALLOWED_RUN_SCRIPTS].sort() });
    return;
  }
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    res.status(400).json({ error: 'args must be an array of strings' });
    return;
  }
  const safeArgs = args as string[];

  const jobId = randomUUID();
  const job: AdminJob = { id: jobId, script, args: safeArgs, status: 'running', startedAt: new Date(), output: [] };
  adminJobs.set(jobId, job);

  const child = spawn('pnpm', ['--filter', '@workspace/scripts', 'run', script, ...safeArgs], {
    cwd: ADMIN_WORKSPACE_ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const addLine = (chunk: Buffer) => {
    const lines = chunk.toString('utf8').split('\n').filter((l) => l.trim());
    for (const l of lines) {
      job.output.push(l);
      if (job.output.length > MAX_JOB_OUTPUT) job.output.shift();
    }
  };
  child.stdout?.on('data', addLine);
  child.stderr?.on('data', addLine);
  child.on('close', (code) => { job.status = code === 0 ? 'done' : 'failed'; job.exitCode = code ?? -1; job.finishedAt = new Date(); });
  child.on('error', (err) => { job.output.push(`spawn error: ${String(err)}`); job.status = 'failed'; job.exitCode = -1; job.finishedAt = new Date(); });

  // GC: держим не более MAX_JOBS_STORED завершённых job'ов
  if (adminJobs.size > MAX_JOBS_STORED) {
    const sorted = [...adminJobs.entries()].sort((a, b) => a[1].startedAt.getTime() - b[1].startedAt.getTime());
    for (const [id] of sorted.slice(0, sorted.length - MAX_JOBS_STORED)) adminJobs.delete(id);
  }

  res.json({ jobId, script, args: safeArgs, startedAt: job.startedAt.toISOString() });
});

/**
 * GET /api/admin/jobs/:jobId
 * Статус и последние 100 строк вывода job'а.
 */
router.get('/jobs/:jobId', (req, res) => {
  const job = adminJobs.get(req.params['jobId'] ?? '');
  if (!job) { res.status(404).json({ error: 'job not found' }); return; }
  res.json({
    id: job.id, script: job.script, args: job.args, status: job.status,
    startedAt: job.startedAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
    exitCode: job.exitCode ?? null,
    output: job.output.slice(-100),
    durationMs: job.finishedAt ? job.finishedAt.getTime() - job.startedAt.getTime() : Date.now() - job.startedAt.getTime(),
  });
});

// ── F4: Model history + activate ────────────────────────────────────────────

/**
 * GET /api/admin/models/history
 * Все версии моделей (не только активные), последние 50 по дате.
 */
router.get('/models/history', async (_req, res) => {
  const rows = await db
    .select({
      id: modelVersionsTable.id,
      kind: modelVersionsTable.kind,
      version: modelVersionsTable.version,
      algorithm: modelVersionsTable.algorithm,
      engine: modelVersionsTable.engine,
      featuresVersion: modelVersionsTable.featuresVersion,
      trainAccuracy: modelVersionsTable.trainAccuracy,
      testAccuracy: modelVersionsTable.testAccuracy,
      brierScore: modelVersionsTable.brierScore,
      trainSampleSize: modelVersionsTable.trainSampleSize,
      testSampleSize: modelVersionsTable.testSampleSize,
      hardMatchAccuracy: modelVersionsTable.hardMatchAccuracy,
      hardMatchBrier: modelVersionsTable.hardMatchBrier,
      hardMatchCount: modelVersionsTable.hardMatchCount,
      isActive: modelVersionsTable.isActive,
      createdAt: modelVersionsTable.createdAt,
    })
    .from(modelVersionsTable)
    .orderBy(desc(modelVersionsTable.createdAt))
    .limit(50);
  res.json({ models: rows });
});

/**
 * POST /api/admin/models/:id/activate
 * Атомарно продвигает версию модели в активную. Деактивирует конкурентов
 * с тем же (kind, featuresVersion, engine).
 */
router.post('/models/:id/activate', async (req, res) => {
  const id = parseInt(req.params['id'] ?? '', 10);
  if (isNaN(id)) { res.status(400).json({ error: 'invalid id' }); return; }

  const [target] = await db.select().from(modelVersionsTable).where(eq(modelVersionsTable.id, id)).limit(1);
  if (!target) { res.status(404).json({ error: 'model not found' }); return; }
  if (target.isActive) { res.json({ ok: true, alreadyActive: true, activatedId: id, kind: target.kind, engine: target.engine, version: target.version }); return; }

  await db.transaction(async (tx) => {
    await tx.update(modelVersionsTable)
      .set({ isActive: false })
      .where(sql`${modelVersionsTable.kind} = ${target.kind}
        AND ${modelVersionsTable.featuresVersion} = ${target.featuresVersion}
        AND ${modelVersionsTable.engine} = ${target.engine}
        AND ${modelVersionsTable.isActive} = true`);
    await tx.update(modelVersionsTable).set({ isActive: true }).where(eq(modelVersionsTable.id, id));
  });

  res.json({ ok: true, alreadyActive: false, activatedId: id, kind: target.kind, engine: target.engine, version: target.version });
});

// ── T0.7 visibility ─────────────────────────────────────────────────────────

// T0.7 visibility — статус очереди replay-парсинга.
router.get('/parse-queue/stats', async (_req, res) => {
  const byStatus = await db
    .select({
      status: matchParseQueueTable.status,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(matchParseQueueTable)
    .groupBy(matchParseQueueTable.status);

  const totals = await db
    .select({
      proMatchesTotal: sql<number>`COUNT(*)::int`,
      proMatchesParsed: sql<number>`COUNT(*) FILTER (WHERE ${proMatchesTable.isParsed} = true)::int`,
      proMatchesLast180d: sql<number>`COUNT(*) FILTER (WHERE ${proMatchesTable.startTime} >= EXTRACT(EPOCH FROM NOW() - INTERVAL '180 days'))::int`,
      proMatchesLast180dParsed: sql<number>`COUNT(*) FILTER (WHERE ${proMatchesTable.startTime} >= EXTRACT(EPOCH FROM NOW() - INTERVAL '180 days') AND ${proMatchesTable.isParsed} = true)::int`,
    })
    .from(proMatchesTable);

  const parsedStats = await db
    .select({
      total: sql<number>`COUNT(*)::int`,
      latestParsedAt: sql<Date | null>`MAX(${matchParsedTable.parsedAt})`,
    })
    .from(matchParsedTable);

  const parsedBySchemaVer = await db
    .select({
      schemaVer: matchParsedTable.payloadSchemaVersion,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(matchParsedTable)
    .groupBy(matchParsedTable.payloadSchemaVersion);

  const oldestQueued = await db
    .select({
      matchId: matchParseQueueTable.matchId,
      requestedAt: matchParseQueueTable.requestedAt,
      attempts: matchParseQueueTable.attempts,
    })
    .from(matchParseQueueTable)
    .where(eq(matchParseQueueTable.status, 'queued'))
    .orderBy(matchParseQueueTable.requestedAt)
    .limit(5);

  res.json({
    queue: byStatus,
    proMatches: totals[0] ?? {},
    parsed: { ...(parsedStats[0] ?? {}), bySchemaVer: parsedBySchemaVer },
    oldestQueued,
  });
});

export default router;
