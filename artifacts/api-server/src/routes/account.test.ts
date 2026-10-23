import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { createAccountRouter, createUserMiddleware, accountOriginAllowed } from './account';
import { createAccountDataStore } from '../services/accountDataStore';
import { type AccountDataStore, type AccountRecord, exportAccount } from '../services/accountData';
import { decodeToken, hashPassword, issueToken, verifyPassword } from '../services/userCredentials';

process.env.SESSION_SECRET = 'account-fixtures-only-not-a-real-secret';
const PASSWORD = 'fixture-password-123';
const HASH = hashPassword(PASSWORD);
const fixture = (id = 1): AccountRecord => ({ id, email: `fixture-${id}@example.invalid`, passwordHash: HASH, createdAt: '2026-10-03T00:00:00.000Z', lastLoginAt: null, tariff: 'free', refCode: 'fixture-source' });

function memoryStore() {
  const records = new Map([[1, fixture(1)], [2, fixture(2)]]);
  const store: AccountDataStore = {
    async read(id) { return records.get(id) ?? null; },
    async deleteWithPassword(id, password) {
      const record = records.get(id);
      if (!record) return 'already_deleted';
      if (!verifyPassword(password, record.passwordHash)) return 'invalid_password';
      records.delete(id);
      return 'deleted';
    },
  };
  return { store, records };
}

async function serverFor(store: AccountDataStore) {
  const app = express();
  const logs: unknown[] = [];
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { error: (...args: unknown[]) => logs.push(args) } as unknown as typeof req.log; next(); });
  app.use('/api/auth', createAccountRouter(store));
  app.get('/required', createUserMiddleware(store, true), (req, res) => res.json({ userId: (req as unknown as { userId: number }).userId }));
  app.get('/optional', createUserMiddleware(store, false), (req, res) => res.json({ userId: (req as unknown as { userId?: number }).userId ?? null }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, logs, close: () => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())) };
}

const auth = (id = 1) => ({ Authorization: `Bearer ${issueToken(id).token}` });
const deletion = (password = PASSWORD, id = 1): RequestInit => ({ method: 'DELETE', headers: { ...auth(id), 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });

test('credential compatibility, strict signed-token parsing and corrupt password storage', () => {
  const issued = issueToken(1);
  assert.equal(decodeToken(issued.token)?.userId, 1);
  assert.equal(decodeToken(`${issued.token}00`), null);
  assert.equal(decodeToken(issued.token.replace(/^1\./, '2.')), null);
  assert.equal(decodeToken('0.9999999999999.' + 'a'.repeat(64)), null);
  assert.equal(verifyPassword(PASSWORD, HASH), true);
  assert.equal(verifyPassword('incorrect', HASH), false);
  assert.equal(verifyPassword(PASSWORD, '$'), false);
});

test('export allowlist excludes new/internal columns and produces stable content', () => {
  const record = { ...fixture(), session: 'private-session', token: 'private-token', isAdmin: true, internalApiKey: 'private-key' };
  const value = exportAccount(record);
  assert.deepEqual(exportAccount(record), value);
  assert.deepEqual(Object.keys(value.account).sort(), ['id', 'email', 'createdAt', 'lastLoginAt', 'tariff', 'referralCode'].sort());
  assert.doesNotMatch(JSON.stringify(value), /password|private-|isAdmin|internalApiKey/);
});

test('origin policy accepts native and same-origin, denies null/cross-site, supports explicit deployment origin', () => {
  const request = (headers: Record<string, string>) => ({ protocol: 'http', headers: { host: 'localhost:8080', ...headers } });
  assert.equal(accountOriginAllowed(request({})), true);
  assert.equal(accountOriginAllowed(request({ origin: 'http://localhost:8080' })), true);
  assert.equal(accountOriginAllowed(request({ origin: 'null' })), false);
  assert.equal(accountOriginAllowed(request({ origin: 'https://attacker.invalid' })), false);
  assert.equal(accountOriginAllowed(request({ 'sec-fetch-site': 'cross-site' })), false);
  assert.equal(accountOriginAllowed(request({ origin: 'https://attacker.invalid', 'x-forwarded-host': 'attacker.invalid', 'x-forwarded-proto': 'https' })), false);
  const before = process.env.AEGIS_AUTH_ALLOWED_ORIGINS;
  try {
    process.env.AEGIS_AUTH_ALLOWED_ORIGINS = 'https://aegis.example.invalid';
    assert.equal(accountOriginAllowed(request({ origin: 'https://aegis.example.invalid' })), true);
  } finally {
    if (before === undefined) delete process.env.AEGIS_AUTH_ALLOWED_ORIGINS;
    else process.env.AEGIS_AUTH_ALLOWED_ORIGINS = before;
  }
});

test('HTTP export is private, read-only, scoped to Bearer owner and denies cookie-only access', async () => {
  const { store, records } = memoryStore();
  const server = await serverFor(store);
  try {
    const denied = await fetch(`${server.url}/api/auth/me/export`, { headers: { Cookie: 'aegis_admin_session=fixture' } });
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get('cache-control') ?? '', /no-store/);
    const responses = await Promise.all([1, 1].map(() => fetch(`${server.url}/api/auth/me/export?userId=2`, { headers: auth() })));
    const values = await Promise.all(responses.map(r => r.json())) as Array<ReturnType<typeof exportAccount>>;
    assert.deepEqual(values[0], values[1]);
    assert.equal(values[0].account.email, fixture().email);
    assert.equal(records.size, 2);
    assert.equal(responses[0]!.headers.get('content-disposition'), 'attachment; filename="aegis-account.json"');
    assert.doesNotMatch(JSON.stringify(values), /passwordHash|password_hash|fixture-2|private-session/);
  } finally { await server.close(); }
});

test('delete requires a fresh password, rejects alternate IDs/foreign Origin/form posts without deleting', async () => {
  const { store, records } = memoryStore();
  const server = await serverFor(store);
  try {
    const url = `${server.url}/api/auth/me`;
    assert.equal((await fetch(url, deletion('incorrect'))).status, 403);
    assert.equal((await fetch(url, { ...deletion(), body: JSON.stringify({ password: PASSWORD, userId: 2 }) })).status, 400);
    assert.equal((await fetch(url, { method: 'DELETE', headers: auth(), body: `password=${PASSWORD}` })).status, 415);
    assert.equal((await fetch(url, { ...deletion(), headers: { ...auth(), 'Content-Type': 'application/json', Origin: 'https://attacker.invalid' } })).status, 403);
    assert.equal(records.size, 2);
  } finally { await server.close(); }
});

test('delete is idempotent, invalidates all old tokens, preserves other users, and export fails afterwards', async () => {
  const { store, records } = memoryStore();
  const server = await serverFor(store);
  const oldHeaders = auth();
  try {
    assert.equal((await fetch(`${server.url}/required`, { headers: oldHeaders })).status, 200);
    const url = `${server.url}/api/auth/me`;
    const results = await Promise.all([fetch(url, deletion()), fetch(url, deletion())]);
    assert.deepEqual(results.map(r => r.status), [204, 204]);
    assert.equal(records.has(1), false);
    assert.deepEqual(records.get(2), fixture(2));
    assert.equal((await fetch(`${server.url}/required`, { headers: oldHeaders })).status, 401);
    const optional = await (await fetch(`${server.url}/optional`, { headers: oldHeaders })).json() as { userId: number | null };
    assert.equal(optional.userId, null);
    assert.equal((await fetch(`${server.url}/api/auth/me/export`, { headers: oldHeaders })).status, 401);
    assert.equal((await fetch(`${server.url}/required`, { headers: auth(2) })).status, 200);
  } finally { await server.close(); }
});

test('password retry cap is per account and includes Retry-After', async () => {
  const { store, records } = memoryStore();
  const server = await serverFor(store);
  try {
    for (let i = 0; i < 5; i++) assert.equal((await fetch(`${server.url}/api/auth/me`, deletion('incorrect'))).status, 403);
    const limited = await fetch(`${server.url}/api/auth/me`, deletion());
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal(records.size, 2);
    assert.equal((await fetch(`${server.url}/api/auth/me`, deletion(PASSWORD, 2))).status, 204);
  } finally { await server.close(); }
});

test('storage errors fail closed and never disclose SQL, connection secrets or passwords', async () => {
  const fail = async (): Promise<never> => { throw new Error('postgres://private-password@host raw SQL secret'); };
  const server = await serverFor({ read: fail, deleteWithPassword: fail });
  try {
    const responses = await Promise.all([
      fetch(`${server.url}/api/auth/me/export`, { headers: auth() }),
      fetch(`${server.url}/api/auth/me`, deletion()),
      fetch(`${server.url}/required`, { headers: auth() }),
    ]);
    assert.ok(responses.every(r => r.status === 503));
    const bodies = await Promise.all(responses.map(r => r.text()));
    assert.doesNotMatch(JSON.stringify([bodies, server.logs]), /private-password|raw SQL|fixture-password/);
  } finally { await server.close(); }
});

test('PostgreSQL fixture schema: row locks, rollback, double-delete and unrelated data preservation', { skip: !process.env.ACCOUNT_TEST_DATABASE_URL }, async () => {
  // Resolve pg from the existing workspace DB dependency without importing its
  // production singleton or adding a second version of the library.
  const require = createRequire(import.meta.url);
  const pg = createRequire(require.resolve('@workspace/db'))('pg');
  const schema = `account_test_${Date.now()}_${randomBytes(5).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: process.env.ACCOUNT_TEST_DATABASE_URL, max: 1 });
  let pool: any;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    // Search path contains ONLY the generated fixture schema: any accidental
    // unqualified access cannot fall back to production public tables.
    pool = new pg.Pool({ connectionString: process.env.ACCOUNT_TEST_DATABASE_URL, max: 4, options: `-c search_path=${schema}` });
    await pool.query('CREATE TABLE app_users (id integer PRIMARY KEY, email text NOT NULL, password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), last_login_at timestamptz, tariff text NOT NULL DEFAULT \'free\', ref_code text)');
    await pool.query('CREATE TABLE shared_matches (id integer PRIMARY KEY)');
    await pool.query('INSERT INTO shared_matches VALUES (100)');
    await pool.query('INSERT INTO app_users (id,email,password_hash,ref_code) VALUES (1,$1,$2,$3),(2,$4,$2,$3)', [fixture().email, HASH, 'shared-referral', fixture(2).email]);
    const store = createAccountDataStore(pool);
    assert.equal(await store.deleteWithPassword(1, 'incorrect'), 'invalid_password');
    assert.equal((await store.read(1))?.email, fixture().email);
    const results = await Promise.all([store.deleteWithPassword(1, PASSWORD), store.deleteWithPassword(1, PASSWORD)]);
    assert.deepEqual(results.sort(), ['already_deleted', 'deleted']);
    assert.equal(await store.read(1), null);
    assert.equal((await store.read(2))?.email, fixture(2).email);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM shared_matches')).rows[0].count, 1);
    // A failed DELETE rolls the transaction back; it cannot report success.
    await pool.query("CREATE FUNCTION reject_fixture_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END; $$");
    await pool.query('CREATE TRIGGER reject_delete BEFORE DELETE ON app_users FOR EACH ROW EXECUTE FUNCTION reject_fixture_delete()');
    await assert.rejects(store.deleteWithPassword(2, PASSWORD));
    assert.equal((await store.read(2))?.email, fixture(2).email);
    await pool.query('DROP TRIGGER reject_delete ON app_users');
    await pool.query('CREATE FUNCTION skip_fixture_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$');
    await pool.query('CREATE TRIGGER skip_delete BEFORE DELETE ON app_users FOR EACH ROW EXECUTE FUNCTION skip_fixture_delete()');
    await assert.rejects(store.deleteWithPassword(2, PASSWORD), /account_delete_not_applied/);
    assert.equal((await store.read(2))?.email, fixture(2).email);
  } finally {
    if (pool) await pool.end();
    // Fixed prefix + locally generated suffix, never derived from request/env.
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
