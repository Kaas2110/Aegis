import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function sessionSecret(): string {
  const value = process.env['SESSION_SECRET'];
  if (!value || value.length < 16) throw new Error('session_secret_unavailable');
  return value;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}$${scryptSync(password, salt, 64, { N: 16384 }).toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 2 || !/^[a-f0-9]{32}$/i.test(parts[0]!) || !/^[a-f0-9]{128}$/i.test(parts[1]!)) return false;
  try {
    const expected = Buffer.from(parts[1]!, 'hex');
    return timingSafeEqual(scryptSync(password, Buffer.from(parts[0]!, 'hex'), 64, { N: 16384 }), expected);
  } catch { return false; }
}

export interface DecodedUserToken { userId: number; expiresAt: number }

export function issueToken(userId: number): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const payload = `${userId}.${expiresAt}`;
  const signature = createHmac('sha256', sessionSecret()).update(payload).digest('hex');
  return { token: `${payload}.${signature}`, expiresAt };
}

/** Existing three-part tokens remain compatible; account existence is checked separately. */
export function decodeToken(token: string | undefined): DecodedUserToken | null {
  if (!token || token.length > 256) return null;
  const match = /^([1-9][0-9]*)\.([1-9][0-9]*)\.([a-f0-9]{64})$/.exec(token);
  if (!match) return null;
  const userId = Number(match[1]);
  const expiresAt = Number(match[2]);
  if (!Number.isSafeInteger(userId) || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return null;
  const expected = createHmac('sha256', sessionSecret()).update(`${match[1]}.${match[2]}`).digest();
  if (!timingSafeEqual(Buffer.from(match[3]!, 'hex'), expected)) return null;
  return { userId, expiresAt };
}

export function extractBearer(req: { headers: { authorization?: string } }): string | undefined {
  const value = req.headers.authorization;
  return value?.startsWith('Bearer ') ? value.slice(7).trim() : undefined;
}
