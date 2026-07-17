/**
 * GET /api/client-config
 *
 * Публичный эндпоинт (без auth). Отдаёт мобильному клиенту динамические
 * интервалы polling'а — клиент раз в N минут пуллит этот эндпоинт и
 * подменяет свой setInterval. Так админ из /admin-web/workers может
 * замедлить мобилок (например на ноуте, чтобы не плодить запросы вне эфира)
 * без пересборки APK.
 *
 * Кешируем in-memory на 60s (withCache) — мобильных клиентов мало, но
 * на пиковом ивенте лучше отдавать из кэша.
 */
import { Router, type IRouter } from 'express';
import { getAppSettings } from '../services/AppSettings';
import { withCache } from '../lib/responseCache';

const router: IRouter = Router();

router.get('/', async (_req, res) => {
  const payload = await withCache('client-config', 60_000, async () => {
    const s = await getAppSettings();
    return {
      pollLiveSec: s.mobilePollLiveSec,
      pollIdleSec: s.mobilePollIdleSec,
      // T005: показывать ли поле промокода на экране регистрации.
      promoFieldEnabled: s.promoFieldEnabled,
      // Reserved для будущего push-обновления конфига мобилы (feature flags etc).
      version: 1,
    };
  });
  res.json(payload);
});

export default router;
