/**
 * Admin login/logout endpoints (cookie-based session).
 *
 * Flow:
 *   POST /api/admin/login   { token } → set HttpOnly cookie aegis_admin_session, return { ok }
 *   POST /api/admin/logout                → clear cookie
 *   GET  /api/admin/whoami                → { authenticated: boolean }
 *
 * Sessions are stored in-memory (single-process api-server). In production on
 * restart all sessions invalidate — admin re-logs in. Sufficient for single
 * operator. In development only, sessions are additionally persisted to a
 * /tmp file (mode 0600) so dev-server restarts don't log the admin out.
 *
 * The `requireAdminSession` middleware here is the sole gate for /api/admin/*
 * (and POST /api/analytics/retrain). The legacy `X-Admin-Token` header is no
 * longer accepted now that the inline /api/admin-ui surface has been removed.
 */
import { Router, type IRouter, type RequestHandler } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const SESSION_COOKIE = 'aegis_admin_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

interface SessionEntry {
  createdAt: number;
  expiresAt: number;
}

const sessions = new Map<string, SessionEntry>();

// Dev-only: persist sessions across dev-server restarts (never in production).
const DEV_SESSION_FILE = '/tmp/aegis_admin_sessions.json';
const DEV_PERSIST = process.env['NODE_ENV'] !== 'production';

function persistSessions(): void {
  if (!DEV_PERSIST) return;
  try {
    writeFileSync(DEV_SESSION_FILE, JSON.stringify([...sessions.entries()]), { mode: 0o600 });
  } catch {
    /* best-effort dev convenience */
  }
}

if (DEV_PERSIST) {
  try {
    const raw = JSON.parse(readFileSync(DEV_SESSION_FILE, 'utf8')) as [string, SessionEntry][];
    const now = Date.now();
    for (const [token, entry] of raw) {
      if (typeof token === 'string' && entry && typeof entry.expiresAt === 'number' && entry.expiresAt > now) {
        sessions.set(token, entry);
      }
    }
  } catch {
    /* no file / bad file — start empty */
  }
}

function purgeExpired(): void {
  const now = Date.now();
  for (const [token, entry] of sessions) {
    if (entry.expiresAt < now) sessions.delete(token);
  }
}

function createSession(): { token: string; expiresAt: number } {
  purgeExpired();
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  sessions.set(token, { createdAt: now, expiresAt });
  persistSessions();
  return { token, expiresAt };
}

function isValidSession(token: string | undefined): boolean {
  if (!token) return false;
  purgeExpired();
  const entry = sessions.get(token);
  if (!entry) return false;
  if (entry.expiresAt < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function safeCompare(a: string, b: string): boolean {
  // timingSafeEqual requires equal-length buffers; pad to longer length first.
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) {
    // Still do a constant-time compare with padded buffer to avoid leaking
    // length, but result is always false for length mismatch.
    const max = Math.max(aBuf.length, bBuf.length);
    const aPad = Buffer.alloc(max);
    const bPad = Buffer.alloc(max);
    aBuf.copy(aPad);
    bBuf.copy(bPad);
    timingSafeEqual(aPad, bPad);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Middleware: requires a valid session cookie issued by POST /api/admin/login.
 * Returns 401 otherwise; 503 if ADMIN_TOKEN env not configured.
 */
export const requireAdminSession: RequestHandler = (req, res, next) => {
  const expected = process.env['ADMIN_TOKEN'];
  if (!expected) {
    res.status(503).json({ error: 'ADMIN_TOKEN не настроен на сервере' });
    return;
  }

  const cookieToken = (req as unknown as { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
  if (cookieToken && isValidSession(cookieToken)) {
    next();
    return;
  }

  res.status(401).json({ error: 'unauthorized' });
};

const router: IRouter = Router();

// Brute-force throttle: per-IP, simple in-memory counter.
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

function checkLoginThrottle(ip: string): { allowed: boolean; retryAfterSec?: number } {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return { allowed: true };
  }
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    return { allowed: false, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count += 1;
  return { allowed: true };
}

router.post('/login', (req, res) => {
  const expected = process.env['ADMIN_TOKEN'];
  if (!expected) {
    res.status(503).json({ error: 'ADMIN_TOKEN не настроен на сервере' });
    return;
  }

  const ip = req.ip ?? 'unknown';
  const throttle = checkLoginThrottle(ip);
  if (!throttle.allowed) {
    res.status(429).json({ error: 'too_many_attempts', retryAfterSec: throttle.retryAfterSec });
    return;
  }

  const body = (req.body ?? {}) as { token?: unknown };
  const provided = typeof body.token === 'string' ? body.token : '';
  if (!provided || !safeCompare(provided, expected)) {
    res.status(401).json({ error: 'invalid_token' });
    return;
  }

  const { token, expiresAt } = createSession();
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env['NODE_ENV'] === 'production' && process.env['AEGIS_LOCAL_ONLY'] !== 'true',
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
  res.json({ ok: true, expiresAt });
});

router.post('/logout', (req, res) => {
  const cookieToken = (req as unknown as { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
  if (cookieToken && sessions.delete(cookieToken)) persistSessions();
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

router.get('/whoami', (req, res) => {
  const cookieToken = (req as unknown as { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
  res.json({ authenticated: isValidSession(cookieToken), tokenConfigured: !!process.env['ADMIN_TOKEN'] });
});

export default router;
