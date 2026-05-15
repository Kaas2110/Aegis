/**
 * Email/password регистрация и вход для мобильного клиента.
 *
 * Эндпоинты (все public, mounted под `/api/auth`):
 *   POST /api/auth/register  { email, password } → { token, user }
 *   POST /api/auth/login     { email, password } → { token, user }
 *   POST /api/auth/logout                       → { ok }            (stateless, для логирования)
 *   GET  /api/auth/me        Authorization: Bearer <token>          → { user } | 401
 *
 * Токен — HMAC-подпись формата `${userId}.${expiresAtMs}.${hexHmac}`,
 * подписан `SESSION_SECRET`. Сервер не хранит сессии в БД (stateless),
 * поэтому logout = просто инструкция клиенту удалить токен.
 *
 * Throttle: 10 попыток login/register за 15 минут на IP (как у admin login).
 *
 * Пароли хранятся через scrypt из node:crypto (без bcrypt-зависимости),
 * формат "${saltHex}$${hashHex}".
 */
import { Router, type IRouter, type RequestHandler } from 'express';
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHmac,
} from 'node:crypto';
import { db, usersTable } from '@workspace/db';
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

const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 дней (мобилка хранит локально)
const SCRYPT_KEYLEN = 64;
const SCRYPT_N = 16384; // дефолт scrypt — норм для серверного hash'а

function getSessionSecret(): string {
  const s = process.env['SESSION_SECRET'];
  if (!s || s.length < 16) {
    throw new Error('SESSION_SECRET не настроен или слишком короткий');
  }
  return s;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N });
  return `${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split('$');
  if (!saltHex || !hashHex) return false;
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const candidate = scryptSync(password, salt, expected.length, { N: SCRYPT_N });
    if (candidate.length !== expected.length) return false;
    return timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

// Precomputed dummy hash для login-no-user пути. Гарантирует что мы делаем
// ровно один scrypt-пас независимо от того, существует email или нет —
// иначе у несуществующих юзеров было бы 2 scrypt'а (hash + verify) и
// utc-таймер выдавал бы факт отсутствия аккаунта.
const DUMMY_PASSWORD_HASH = hashPassword('__nonexistent_dummy_for_timing__');

function issueToken(userId: number): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const payload = `${userId}.${expiresAt}`;
  const sig = createHmac('sha256', getSessionSecret()).update(payload).digest('hex');
  return { token: `${payload}.${sig}`, expiresAt };
}

interface DecodedToken {
  userId: number;
  expiresAt: number;
}

function decodeToken(token: string | undefined): DecodedToken | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [uidStr, expStr, sig] = parts;
  if (!uidStr || !expStr || !sig) return null;
  const expected = createHmac('sha256', getSessionSecret())
    .update(`${uidStr}.${expStr}`)
    .digest('hex');
  // constant-time compare
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const userId = Number(uidStr);
  const expiresAt = Number(expStr);
  if (!Number.isFinite(userId) || !Number.isFinite(expiresAt)) return null;
  if (expiresAt < Date.now()) return null;
  return { userId, expiresAt };
}

function extractBearer(req: { headers: { authorization?: string } }): string | undefined {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return undefined;
  return h.slice('Bearer '.length).trim();
}

/**
 * Опциональная middleware — если токен валиден, вешает `req.userId`.
 * Не возвращает 401 — пропускает дальше (для роутов которые опционально знают юзера).
 */
export const attachUserIfPresent: RequestHandler = (req, _res, next) => {
  const decoded = decodeToken(extractBearer(req));
  if (decoded) (req as { userId?: number }).userId = decoded.userId;
  next();
};

/**
 * Жёсткая middleware — требует валидный bearer-токен. 401 иначе.
 */
export const requireUser: RequestHandler = (req, res, next) => {
  const decoded = decodeToken(extractBearer(req));
  if (!decoded) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  (req as { userId?: number }).userId = decoded.userId;
  next();
};

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
    const passwordHash = hashPassword(password);
    const inserted = await db
      .insert(usersTable)
      .values({ email, passwordHash, lastLoginAt: new Date() })
      .returning({ id: usersTable.id, email: usersTable.email, createdAt: usersTable.createdAt });
    const user = inserted[0];
    if (!user) throw new Error('insert_failed');
    const { token, expiresAt } = issueToken(user.id);
    req.log.info({ tag: 'auth', action: 'register', userId: user.id }, 'user registered');
    res.status(201).json({
      token,
      expiresAt,
      user: { id: user.id, email: user.email, createdAt: user.createdAt },
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
      user: { id: user.id, email: user.email, createdAt: user.createdAt },
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

router.get('/me', async (req, res) => {
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
