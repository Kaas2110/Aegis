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
 */

import { Router, type IRouter } from 'express';
import { getAppSettings, updateAppSettings } from '../services/AppSettings';
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
import { KNOWN_SOURCE_IDS, probeSource, type SourceProbeResult } from './bookmakers';
import { db, modelVersionsTable } from '@workspace/db';
import { desc, eq } from 'drizzle-orm';

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
  res.json({ integrations });
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
      createdAt: modelVersionsTable.createdAt,
    })
    .from(modelVersionsTable)
    .where(eq(modelVersionsTable.isActive, true))
    .orderBy(desc(modelVersionsTable.createdAt));
  res.json({ models: rows });
});

export default router;
