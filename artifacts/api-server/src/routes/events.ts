/**
 * POST /api/events — приём анонимных аналитических событий с мобильного клиента.
 * Событие привязано к анонимному session_id, без персональных данных.
 * В MVP батч просто логируется; в будущем можно писать в таблицу product_events.
 */

import { Router, type IRouter } from 'express';

interface ProductEvent {
  eventId: string;
  eventName: string;
  anonymousId: string;
  sessionId: string;
  timestamp: string;
  screenName?: string;
  appVersion?: string;
  platform?: string;
  locale?: string;
  properties?: Record<string, unknown>;
}

function isValidEvent(e: unknown): e is ProductEvent {
  if (!e || typeof e !== 'object') return false;
  const ev = e as Record<string, unknown>;
  return (
    typeof ev['eventId'] === 'string' && ev['eventId'].length <= 64 &&
    typeof ev['eventName'] === 'string' && ev['eventName'].length <= 128 &&
    typeof ev['anonymousId'] === 'string' && ev['anonymousId'].length <= 64 &&
    typeof ev['sessionId'] === 'string' && ev['sessionId'].length <= 64 &&
    typeof ev['timestamp'] === 'string'
  );
}

const router: IRouter = Router();

router.post('/', (req, res) => {
  const body = req.body as Record<string, unknown>;
  if (!body || !Array.isArray(body['events'])) {
    res.status(400).json({ error: 'invalid_payload', details: 'events must be an array' });
    return;
  }
  const raw: unknown[] = body['events'] as unknown[];
  if (raw.length > 500) {
    res.status(400).json({ error: 'invalid_payload', details: 'max 500 events per batch' });
    return;
  }
  const events: ProductEvent[] = [];
  for (const e of raw) {
    if (!isValidEvent(e)) {
      res.status(400).json({ error: 'invalid_payload', details: 'malformed event in batch' });
      return;
    }
    events.push(e);
  }
  req.log.info({ count: events.length, anonymousId: events[0]?.anonymousId }, '[Events] product events received');
  res.json({ ok: true, accepted: events.length });
});

export default router;
