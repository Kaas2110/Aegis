/**
 * Email/password регистрация и вход для мобильного клиента.
 *
 * Эндпоинты mounted под `/api/auth`; account/me/export требуют Bearer:
 *   POST /api/auth/register  { email, password } → { token, user }
 *   POST /api/auth/login     { email, password } → { token, user }
 *   POST /api/auth/logout                       → { ok }            (stateless, для логирования)
 *   GET  /api/auth/me        Authorization: Bearer <token>          → { user } | 401
 *   GET  /api/auth/me/export → private allowlisted profile JSON
 *   DELETE /api/auth/me     { password } + Bearer                  → 204
 *
 * Токен — HMAC-подпись формата `${userId}.${expiresAtMs}.${hexHmac}`,
 * подписан `SESSION_SECRET`. Сервер не хранит сессии в БД (stateless),
 * Logout удаляет токен у клиента. Удаление аккаунта блокирует ВСЕ его токены
 * проверкой существования app_users на каждом защищённом запросе.
 *
 * Throttle: 20 попыток login/register за 15 минут на IP (как у admin login).
 *
 * Пароли хранятся через scrypt из node:crypto (без bcrypt-зависимости),
 * формат "${saltHex}$${hashHex}".
 */
import { Router, type IRouter } from 'express';
import { db, pool, usersTable, refCodesTable } from '@workspace/db';
import { hashPassword, verifyPassword, issueToken, decodeToken, extractBearer } from '../services/userCredentials';
import { createAccountDataStore } from '../services/accountDataStore';
import { createAccountRouter, createUserMiddleware } from './account';
import { eq, sql } from 'drizzle-orm';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ValidCreds { email: string; password: string }
function parseCreds(body: unknown): { ok: true; data: ValidCreds } | { ok: false; reason: string } {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'body_required' };
  const b = body as Record<string, unknown>;
  const email = typeof b['email'] === 'string' ? b['email'].trim() : '';
  const password = typeof b['password'] === 'string' ? b['password'] : '';
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return { ok: false, reason: 'invalid_email' };
  if (password.length < 6 || password.length > 200) return { ok: false, reason: 'invalid_password' };
  return { ok: true, data: { email, password } };
}

const DUMMY_PASSWORD_HASH = hashPassword('__nonexistent_dummy_for_timing__');
const accountStore = createAccountDataStore(pool);

// Validate account existence on every authenticated request: deletion revokes
// all old stateless tokens without retaining personal-data tombstones.
export const attachUserIfPresent = createUserMiddleware(accountStore, false);
export const requireUser = createUserMiddleware(accountStore, true);

// ───────────────────────────────────────────────────────────────
// Throttle (per-IP, in-memory). Сбрасывается при рестарте.
// ───────────────────────────────────────────────────────────────
const attempts = new Map<string, { count: number; resetAt: number }>();
const THROTTLE_WINDOW_MS = 15 * 60 * 1000;
const THROTTLE_MAX = 20;

function checkThrottle(ip: string): { allowed: boolean; retryAfterSec?: number } {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + THROTTLE_WINDOW_MS });
    return { allowed: true };
  }
  if (entry.count >= THROTTLE_MAX) {
    return { allowed: false, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count += 1;
  return { allowed: true };
}

const router: IRouter = Router();
router.use(createAccountRouter(accountStore));

router.post('/register', async (req, res) => {
  const ip = req.ip ?? 'unknown';
  const throttle = checkThrottle(ip);
  if (!throttle.allowed) {
    res.status(429).json({ error: 'too_many_attempts', retryAfterSec: throttle.retryAfterSec });
    return;
  }

  const parsed = parseCreds(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: 'invalid_input', detail: parsed.reason });
    return;
  }
  const email = parsed.data.email.toLowerCase();
  const password = parsed.data.password;

  try {
    const existing = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(sql`lower(${usersTable.email}) = ${email}`)
      .limit(1);
    if (existing.length > 0) {
      res.status(409).json({ error: 'email_already_registered' });
      return;
    }
    // T005: опциональный промокод. Сохраняем ТОЛЬКО если он существует и
    // активен в ref_codes — иначе молча игнорируем (регистрация не ломается).
    let refCode: string | null = null;
    const rawPromo = (req.body as Record<string, unknown>)['promoCode'];
    if (typeof rawPromo === 'string') {
      const promo = rawPromo.trim().toLowerCase();
      if (/^[a-z0-9_-]{1,64}$/.test(promo)) {
        const found = await db
          .select({ id: refCodesTable.id })
          .from(refCodesTable)
          .where(sql`lower(${refCodesTable.code}) = ${promo} AND ${refCodesTable.active} = true`)
          .limit(1);
        if (found.length > 0) refCode = promo;
      }
    }

    const passwordHash = hashPassword(password);
    const inserted = await db
      .insert(usersTable)
      .values({ email, passwordHash, lastLoginAt: new Date(), refCode })
      .returning({
        id: usersTable.id,
        email: usersTable.email,
        createdAt: usersTable.createdAt,
        isAdmin: usersTable.isAdmin,
      });
    const user = inserted[0];
    if (!user) throw new Error('insert_failed');
    const { token, expiresAt } = issueToken(user.id);
    req.log.info({ tag: 'auth', action: 'register', userId: user.id }, 'user registered');
    res.status(201).json({
      token,
      expiresAt,
      user: { id: user.id, email: user.email, createdAt: user.createdAt, isAdmin: user.isAdmin },
    });
  } catch (err) {
    // Race-condition: уникальный индекс БД отверг дубль (PG код 23505).
    const msg = String(err);
    if (msg.includes('23505') || msg.toLowerCase().includes('unique')) {
      res.status(409).json({ error: 'email_already_registered' });
      return;
    }
    req.log.error({ tag: 'auth', action: 'register', err: msg }, 'register failed');
    res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/login', async (req, res) => {
  const ip = req.ip ?? 'unknown';
  const throttle = checkThrottle(ip);
  if (!throttle.allowed) {
    res.status(429).json({ error: 'too_many_attempts', retryAfterSec: throttle.retryAfterSec });
    return;
  }

  const parsed = parseCreds(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: 'invalid_input', detail: parsed.reason });
    return;
  }
  const email = parsed.data.email.toLowerCase();
  const password = parsed.data.password;

  try {
    const rows = await db
      .select()
      .from(usersTable)
      .where(sql`lower(${usersTable.email}) = ${email}`)
      .limit(1);
    const user = rows[0];
    // Всегда тратим время ровно на ОДИН scrypt-verify чтобы не было
    // timing-leak'а о существовании email'а (см. DUMMY_PASSWORD_HASH).
    const ok = user
      ? verifyPassword(password, user.passwordHash)
      : verifyPassword(password, DUMMY_PASSWORD_HASH);
    if (!user || !ok) {
      res.status(401).json({ error: 'invalid_credentials' });
      return;
    }
    await db
      .update(usersTable)
      .set({ lastLoginAt: new Date() })
      .where(eq(usersTable.id, user.id));
    const { token, expiresAt } = issueToken(user.id);
    req.log.info({ tag: 'auth', action: 'login', userId: user.id }, 'user logged in');
    res.json({
      token,
      expiresAt,
      user: { id: user.id, email: user.email, createdAt: user.createdAt, isAdmin: user.isAdmin },
    });
  } catch (err) {
    req.log.error({ tag: 'auth', action: 'login', err: String(err) }, 'login failed');
    res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/logout', (req, res) => {
  // Stateless — клиент сам удаляет токен. Логируем для метрик.
  const decoded = decodeToken(extractBearer(req));
  if (decoded) {
    req.log.info({ tag: 'auth', action: 'logout', userId: decoded.userId }, 'user logged out');
  }
  res.json({ ok: true });
});

router.get('/me', requireUser, async (req, res) => {
  res.set({ 'Cache-Control': 'no-store, private', 'Pragma': 'no-cache' });
  const decoded = decodeToken(extractBearer(req));
  if (!decoded) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const rows = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      createdAt: usersTable.createdAt,
      lastLoginAt: usersTable.lastLoginAt,
      isAdmin: usersTable.isAdmin,
    })
    .from(usersTable)
    .where(eq(usersTable.id, decoded.userId))
    .limit(1);
  const user = rows[0];
  if (!user) {
    res.status(401).json({ error: 'user_not_found' });
    return;
  }
  res.json({ user });
});

export default router;
