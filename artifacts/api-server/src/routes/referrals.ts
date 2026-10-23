/**
 * Публичный редирект реферальной ссылки.
 *
 *   GET /api/r/:code  (и /r/:code на ноуте, где api-server стоит без префикс-прокси)
 *
 * Логирует клик в ref_clicks (best-effort) и редиректит на настроенный
 * лендинг (app_settings.ref_redirect_url). Если код неизвестен/выключен —
 * всё равно редиректим (пользователь не должен видеть ошибку), но клик
 * помечаем кодом как есть — админ увидит «мусорные» коды в статистике.
 */
import { Router, type IRouter } from 'express';
import { db, refCodesTable, refClicksTable } from '@workspace/db';
import { sql } from 'drizzle-orm';
import { getAppSettings } from '../services/AppSettings';
import { referralLanding } from '../lib/webDeploymentPolicy';

const CODE_RE = /^[a-zA-Z0-9_-]{1,64}$/;

// ── Анти-спам для публичного write-path ──────────────────────────────────────
// Клики пишутся ТОЛЬКО для известных активных кодов (ограниченная кардинальность),
// плюс per-IP rate limit на запись: не больше RATE_MAX инсертов за RATE_WINDOW_MS.
// Редирект работает всегда — лимит касается только записи в ref_clicks.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;
const ipHits = new Map<string, { count: number; windowStart: number }>();

function allowClickWrite(ip: string): boolean {
  const now = Date.now();
  const rec = ipHits.get(ip);
  if (!rec || now - rec.windowStart > RATE_WINDOW_MS) {
    ipHits.set(ip, { count: 1, windowStart: now });
    // не даём Map расти бесконечно
    if (ipHits.size > 10_000) {
      for (const [k, v] of ipHits) {
        if (now - v.windowStart > RATE_WINDOW_MS) ipHits.delete(k);
      }
    }
    return true;
  }
  rec.count += 1;
  return rec.count <= RATE_MAX;
}

const router: IRouter = Router();

router.get('/:code', async (req, res) => {
  const code = String(req.params['code'] ?? '').trim();
  const settings = await getAppSettings().catch(() => null);
  const target = referralLanding(settings?.refRedirectUrl);

  if (CODE_RE.test(code) && allowClickWrite(req.ip ?? 'unknown')) {
    // best-effort: ошибка записи не должна ломать редирект
    try {
      const known = await db
        .select({ id: refCodesTable.id, active: refCodesTable.active })
        .from(refCodesTable)
        .where(sql`lower(${refCodesTable.code}) = ${code.toLowerCase()}`)
        .limit(1);
      // Пишем клик только для известного активного кода — иначе публичный
      // эндпоинт позволяет раздувать таблицу произвольными кодами (DoS).
      if (known.length > 0 && known[0]!.active) {
        await db.insert(refClicksTable).values({
          code: code.toLowerCase(),
          ip: req.ip ?? null,
          userAgent: (req.headers['user-agent'] ?? '').slice(0, 300) || null,
        });
      }
      req.log.info(
        { tag: 'referral', code: code.toLowerCase(), known: known.length > 0 },
        'ref click',
      );
    } catch (err) {
      req.log.error({ tag: 'referral', err: String(err) }, 'ref click log failed');
    }
  }
  res.redirect(302, target);
});

export default router;
