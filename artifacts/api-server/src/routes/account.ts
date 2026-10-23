import { Router, type IRouter, type Request, type RequestHandler } from 'express';
import { exportAccount, type AccountDataStore } from '../services/accountData';
import { decodeToken, extractBearer } from '../services/userCredentials';

/** Browser requests need a trusted Origin. Native Bearer clients have no Origin. */
export function accountOriginAllowed(req: Pick<Request, 'headers' | 'protocol'>): boolean {
  const origin = req.headers.origin;
  if (!origin) return req.headers['sec-fetch-site'] !== 'cross-site';
  if (origin === 'null') return false;
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return false; }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== origin) return false;
  // Do not trust forwarded host/proto headers. A reverse proxy can specify its
  // public origin explicitly with AEGIS_AUTH_ALLOWED_ORIGINS.
  const sameOrigin = `${req.protocol}://${req.headers.host ?? ''}`;
  const configured = (process.env['AEGIS_AUTH_ALLOWED_ORIGINS'] ?? '').split(',').map(v => v.trim()).filter(Boolean);
  return origin === sameOrigin || configured.includes(origin);
}

export function createUserMiddleware(store: AccountDataStore, required: boolean): RequestHandler {
  return async (req, res, next) => {
    res.set({ 'Cache-Control': 'no-store, private', 'Pragma': 'no-cache' });
    try {
      const decoded = decodeToken(extractBearer(req));
      const account = decoded ? await store.read(decoded.userId) : null;
      if (!account && required) { res.status(401).json({ error: 'unauthorized' }); return; }
      if (account) (req as Request & { userId?: number }).userId = account.id;
      else delete (req as Request & { userId?: number }).userId;
      next();
    } catch {
      res.status(503).json({ error: 'authentication_unavailable' });
    }
  };
}

export function createAccountRouter(store: AccountDataStore): IRouter {
  const router = Router();
  const attempts = new Map<number, { count: number; resetAt: number }>();

  const privateRequest: RequestHandler = (req, res, next) => {
    res.set({ 'Cache-Control': 'no-store, private', 'Pragma': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    if (!accountOriginAllowed(req)) { res.status(403).json({ error: 'origin_not_allowed' }); return; }
    try {
      const decoded = decodeToken(extractBearer(req));
      if (!decoded) { res.status(401).json({ error: 'unauthorized' }); return; }
      (req as Request & { userId: number }).userId = decoded.userId;
      next();
    } catch { res.status(503).json({ error: 'authentication_unavailable' }); }
  };

  router.get('/me/export', privateRequest, async (req, res) => {
    try {
      const account = await store.read((req as Request & { userId: number }).userId);
      if (!account) { res.status(401).json({ error: 'unauthorized' }); return; }
      res.set('Content-Disposition', 'attachment; filename="aegis-account.json"');
      res.json(exportAccount(account));
    } catch {
      req.log?.error({ tag: 'account', action: 'export', error: 'storage_failure' }, 'account export failed');
      res.status(503).json({ error: 'account_storage_unavailable' });
    }
  });

  router.delete('/me', privateRequest, async (req, res) => {
    if (!req.is('application/json')) { res.status(415).json({ error: 'json_required' }); return; }
    const body: unknown = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => key !== 'password')
      || typeof (body as Record<string, unknown>).password !== 'string') {
      res.status(400).json({ error: 'invalid_input' }); return;
    }
    const password = (body as { password: string }).password;
    if (password.length < 6 || password.length > 200) { res.status(400).json({ error: 'invalid_input' }); return; }
    const userId = (req as Request & { userId: number }).userId;
    const now = Date.now();
    for (const [id, entry] of attempts) if (entry.resetAt <= now) attempts.delete(id);
    const entry = attempts.get(userId) ?? { count: 0, resetAt: now + 15 * 60_000 };
    if (entry.count >= 5) {
      const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfterSec)).status(429).json({ error: 'too_many_attempts', retryAfterSec }); return;
    }
    entry.count++;
    attempts.set(userId, entry);
    try {
      const result = await store.deleteWithPassword(userId, password);
      if (result === 'invalid_password') { res.status(403).json({ error: 'invalid_password' }); return; }
      attempts.delete(userId);
      // A deleted user's still-signed token can only repeat this empty result;
      // account reads and all authentication middleware reject that token.
      res.status(204).end();
    } catch {
      req.log?.error({ tag: 'account', action: 'delete', error: 'storage_failure' }, 'account deletion failed');
      res.status(503).json({ error: 'account_storage_unavailable' });
    }
  });

  return router;
}
