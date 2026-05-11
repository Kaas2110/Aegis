/**
 * Admin-роуты. Все защищены заголовком X-Admin-Token (значение из ENV ADMIN_TOKEN).
 *
 * Эндпоинты:
 *   GET  /api/admin/settings         — текущие глобальные настройки + статус Odds API
 *   POST /api/admin/settings         — обновить настройки (toggle бухмекера, prune days, ...)
 *   GET  /api/admin/metrics          — агрегированные метрики качества ML-модели
 *   POST /api/admin/retrain          — ручной триггер переобучения
 *   POST /api/admin/prune-snapshots  — ручной триггер чистки live_snapshots
 *   GET  /api/admin/odds-status      — состояние Odds API (есть ли ключ, последняя выборка)
 */

import { Router, type IRouter } from 'express';
import { getAppSettings, updateAppSettings } from '../services/AppSettings';
import { triggerManualRetrain } from '../services/SchedulerWorker';
import { getModelAccuracyMetrics, pruneLiveSnapshots } from '../services/OutcomeTracker';
import { fetchDota2Odds } from '../services/OddsApiAdapter';

const router: IRouter = Router();

router.use((req, res, next) => {
  const expected = process.env['ADMIN_TOKEN'];
  if (!expected) {
    res.status(503).json({ error: 'ADMIN_TOKEN не настроен на сервере' });
    return;
  }
  const provided = req.header('x-admin-token');
  if (provided !== expected) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
});

router.get('/settings', async (_req, res) => {
  const settings = await getAppSettings(true);
  res.json({
    settings,
    oddsApiKeyConfigured: !!process.env['ODDS_API_KEY'],
  });
});

router.post('/settings', async (req, res) => {
  const body = req.body as {
    useBookmakerOdds?: boolean;
    liveSnapshotPruneDays?: number;
    notes?: string | null;
  };
  const patch: Parameters<typeof updateAppSettings>[0] = {};
  if (typeof body.useBookmakerOdds === 'boolean') patch.useBookmakerOdds = body.useBookmakerOdds;
  if (typeof body.liveSnapshotPruneDays === 'number' && body.liveSnapshotPruneDays >= 1 && body.liveSnapshotPruneDays <= 365) {
    patch.liveSnapshotPruneDays = body.liveSnapshotPruneDays;
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

export default router;
