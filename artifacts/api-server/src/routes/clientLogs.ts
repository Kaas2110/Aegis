/**
 * POST /api/client-logs
 *
 * Принимает батч событий из мобильного `EventLogger` и пересылает каждое
 * событие в pino-логгер сервера. Цель — единая точка сбора логов на проде:
 * пользователь жмёт «Отправить логи» → events летят сюда → попадают в общий
 * server-side stream вместе с request/upstream/cache/predict-логами.
 *
 * Никакой DB-персистенции (для аудита есть `predictionsTable`). Эндпоинт
 * публичный, без auth — мобилки шлют без credentials. Защита: лимит размера
 * через express.json() default + кап 200 событий за батч + дроп невалидных.
 */
import { Router, type IRouter } from 'express';
import { logger } from '../lib/logger';

const router: IRouter = Router();

interface ClientLogEvent {
  type?: string;
  category?: string;
  message?: string;
  eventName?: string;
  screenName?: string;
  timestamp?: string;
  sessionId?: string;
  anonymousId?: string;
  details?: Record<string, unknown>;
  properties?: Record<string, unknown>;
}

router.post('/', (req, res) => {
  const body = (req.body ?? {}) as { events?: unknown; appVersion?: unknown; platform?: unknown };
  if (!Array.isArray(body.events)) {
    res.status(400).json({ error: 'events must be array' });
    return;
  }
  const events = (body.events as unknown[]).slice(0, 200);
  const appVersion = typeof body.appVersion === 'string' ? body.appVersion : 'unknown';
  const platform = typeof body.platform === 'string' ? body.platform : 'unknown';

  let accepted = 0;
  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as ClientLogEvent;
    accepted++;
    logger.info(
      {
        tag: 'mobile',
        type: e.type ?? 'event',
        category: e.category ?? null,
        eventName: e.eventName ?? null,
        screenName: e.screenName ?? null,
        ts: e.timestamp ?? null,
        sessionId: e.sessionId ?? null,
        anonymousId: e.anonymousId ?? null,
        appVersion,
        platform,
        msg: e.message ?? null,
        details: e.details ?? e.properties ?? null,
      },
      '[mobile] event',
    );
  }
  res.json({ ok: true, accepted });
});

export default router;
