/**
 * Public client-config endpoints. Mounted at /api/config (no auth).
 *  - GET /monetization — текущий режим монетизации + матрица фичей.
 *    Используется мобилкой для скрытия / разблокировки premium-функций.
 *    Кешируется через Cache-Control: max-age=60.
 */

import { Router, type IRouter } from 'express';
import {
  getAppSettings,
  FEATURE_CATALOG,
  normalizeFeatureFlags,
  canonicalizeFlagsForMode,
  normalizeStoreSettings,
  type MonetizationMode,
} from '../services/AppSettings';

const router: IRouter = Router();

router.get('/monetization', async (_req, res) => {
  const settings = await getAppSettings();
  res.set('Cache-Control', 'public, max-age=60');
  const mode = settings.monetizationMode as MonetizationMode;
  res.json({
    mode,
    flags: canonicalizeFlagsForMode(normalizeFeatureFlags(settings.featureFlags), mode),
    features: FEATURE_CATALOG,
  });
});

// Публичный endpoint — включённые магазины + ссылки для лендинга и мобилки
router.get('/stores', async (_req, res) => {
  const settings = await getAppSettings();
  res.set('Cache-Control', 'public, max-age=30');
  res.json(normalizeStoreSettings(settings.storeSettings));
});

export default router;
