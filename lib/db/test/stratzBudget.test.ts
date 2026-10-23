import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { STRATZ_LIMITS, emptyStratzState, reserveStratzState, blockStratzState, createPgStratzGate, createStratzClient, StratzUnavailableError, type StratzGate } from '../src/stratzBudget';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const SECRET = 'test-token-never-print-987654';
const denied = (reason: string) => (error: unknown) => error instanceof StratzUnavailableError && error.reason === reason;
function memoryGate() {
  const state = emptyStratzState();
  let now = NOW;
  const gate: StratzGate = {
    async run(operation) {
      reserveStratzState(state, now);
      return operation({ signal: new AbortController().signal, async block(status, header) { return blockStratzState(state, now, status, header); } });
    },
  };
  return { state, gate, setNow: (value: number) => { now = value; } };
}

test('uses exactly one primary token and required API headers, no browser fingerprint', async () => {
  const memory = memoryGate();
  let sends = 0;
  const request = createStratzClient(memory.gate, async (url, init) => {
    sends++;
    assert.equal(url, 'https://api.stratz.com/graphql');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'manual');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('User-Agent'), 'STRATZ_API');
    assert.equal(headers.get('Authorization'), `Bearer ${SECRET}`);
    assert.equal(headers.get('Content-Type'), 'application/json');
    assert.equal(headers.get('Origin'), null);
    assert.equal(headers.get('Referer'), null);
    assert.deepEqual(JSON.parse(String(init?.body)), { query: 'query Test { constants { heroes { id } } }', variables: { id: 1 } });
    return Response.json({ data: { ok: true } });
  });
  assert.deepEqual(await request(`${SECRET},unused-secondary`, 'query Test { constants { heroes { id } } }', { id: 1 }), { ok: true });
  assert.equal(memory.state.day.calls, 1);
  assert.equal(sends, 1);
  assert.doesNotMatch(JSON.stringify(memory.state), /token|987654|secondary/);
});

test('403 stops all following attempts, including after a UTC day or token change', async () => {
  const memory = memoryGate();
  let sends = 0;
  const request = createStratzClient(memory.gate, async () => { sends++; return new Response(`<html>${SECRET}</html>`, { status: 403 }); });
  await assert.rejects(request(SECRET, '{}'), denied('upstream_403'));
  memory.setNow(NOW + 86_400_000);
  await assert.rejects(request('another-test-token', '{}'), denied('upstream_403'));
  assert.equal(sends, 1);
  assert.equal(memory.state.day.calls, 1);
});

test('429 shares Retry-After and does not rotate tokens or retry early', async () => {
  for (const header of ['90', 'Sat, 03 Oct 2026 12:01:30 GMT']) {
    const memory = memoryGate();
    let sends = 0;
    const request = createStratzClient(memory.gate, async () => {
      sends++;
      return sends === 1 ? new Response('', { status: 429, headers: { 'Retry-After': header } }) : Response.json({ data: { ok: true } });
    });
    await assert.rejects(request(SECRET, '{}'), denied('upstream_429'));
    assert.equal(memory.state.blockedUntil, NOW + 90_000);
    memory.setNow(NOW + 89_999);
    await assert.rejects(request('another-test-token', '{}'), denied('upstream_429'));
    assert.equal(sends, 1);
    memory.setNow(NOW + 90_000);
    await request(SECRET, '{}');
    assert.equal(sends, 2);
  }
});

test('HTTP, GraphQL, body and network errors expose no token, response, query or cause', async () => {
  for (const upstream of [
    async () => { throw new Error(`network Authorization: Bearer ${SECRET}`); },
    async () => new Response(SECRET, { status: 401 }),
    async () => new Response(`<html>${SECRET}</html>`),
    async () => Response.json({ errors: [{ message: SECRET }] }),
    async () => { const response = new Response('{}'); response.json = async () => { throw new Error(SECRET); }; return response; },
  ]) {
    const memory = memoryGate();
    const request = createStratzClient(memory.gate, upstream);
    await assert.rejects(request(SECRET, 'query Sensitive'), error => {
      assert.ok(error instanceof StratzUnavailableError);
      assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)}`, /987654|Bearer|Sensitive|<html>/);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(memory.state.day.calls, 1);
  }
});

test('missing token never reserves or sends; old token pool is not a fallback', async () => {
  const request = createStratzClient({ async run() { assert.fail('must not reserve'); } }, async () => { assert.fail('must not send'); });
  await assert.rejects(request('', '{}'), denied('missing_token'));
  await assert.rejects(request(',secondary', '{}'), denied('missing_token'));
});

test('100/hour, 2000/day and ten second pacing survive client replacement and UTC boundaries', () => {
  const state = emptyStratzState();
  reserveStratzState(state, NOW);
  assert.throws(() => reserveStratzState(state, NOW + 9999), denied('pacing'));
  for (let i = 1; i < 100; i++) reserveStratzState(state, NOW + i * 10_000);
  assert.throws(() => reserveStratzState(state, NOW + 1_000_000), denied('hourly_limit'));
  reserveStratzState(state, NOW + 3_600_000);
  state.day.calls = STRATZ_LIMITS.daily;
  assert.throws(() => reserveStratzState(state, NOW + 7_200_000), denied('daily_limit'));
  reserveStratzState(state, Date.parse('2026-10-04T00:00:00Z'));
  assert.equal(state.day.calls, 1);
  assert.equal(state.hour.calls, 1);
});

test('PostgreSQL failures fail closed without exposing connection details', async () => {
  const gate = createPgStratzGate({ connect: async () => { throw new Error(`postgres://${SECRET}@host`); } } as unknown as pg.Pool);
  await assert.rejects(gate.run(async () => assert.fail('must not send')), error => {
    assert.ok(denied('ledger_unavailable')(error));
    assert.doesNotMatch(String(error), /987654|postgres/);
    return true;
  });
});

test('PostgreSQL: cross-client single flight, persisted reservation before completion and shared 429', { skip: !process.env.OD_TEST_DATABASE_URL }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.OD_TEST_DATABASE_URL, max: 5 });
  const schema = `stratz_test_${randomBytes(6).toString('hex')}`;
  await pool.query(`CREATE SCHEMA "${schema}"`);
  let release: () => void = () => {};
  try {
    const first = createPgStratzGate(pool, schema);
    const second = createPgStratzGate(pool, schema);
    let enter: () => void = () => {};
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const running = first.run(async () => { enter(); await hold; return 1; });
    await entered;
    await assert.rejects(second.run(async () => assert.fail('must not run concurrently')), denied('in_flight'));
    const persisted = await pool.query(`SELECT state FROM "${schema}".stratz_request_budget`);
    assert.equal(persisted.rows[0].state.day.calls, 1);
    release();
    assert.equal(await running, 1);
    // Avoid a real 10-second wait in this isolated test schema only.
    await pool.query(`UPDATE "${schema}".stratz_request_budget SET state = jsonb_set(state, '{nextAllowedAt}', '0'::jsonb)`);
    await assert.rejects(second.run(async context => { throw await context.block(429, '120'); }), denied('upstream_429'));
    const restarted = createPgStratzGate(pool, schema);
    await assert.rejects(restarted.run(async () => assert.fail('must honor persisted block')), denied('upstream_429'));
    const after = await pool.query(`SELECT state FROM "${schema}".stratz_request_budget`);
    assert.equal(after.rows[0].state.day.calls, 2);
  } finally {
    release();
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});
