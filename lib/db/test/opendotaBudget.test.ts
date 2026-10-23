import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { emptyOdState, reserveOdState, blockOdState, retryAfterDeadline, createOdFetch, createPgOdLedger, OdQuotaExhaustedError, type OdLedger } from '../src/opendotaBudget';
import { fetchJsonGet } from '../../../scripts/src/lib/fetchJsonGet';

const NOW = Date.parse('2026-10-03T12:00:00Z');
function memoryLedger() {
  const state = emptyOdState();
  let now = NOW;
  const ledger: OdLedger = {
    async reserve(units, kind) { const error = reserveOdState(state, now, units, kind); if (error) throw error; },
    async block(status, header) { return blockOdState(state, now, status, header); },
    async snapshot() { return { state, now }; },
  };
  return { state, ledger, setNow: (value: number) => { now = value; } };
}
const denied = (reason: string) => (error: unknown) => error instanceof OdQuotaExhaustedError && error.reason === reason;

test('3000-unit UTC daily cap survives minute rollover; next day has a new bucket', () => {
  const state = emptyOdState();
  state.days['2026-10-03'] = { calls: 3000, units: 3000 };
  assert.equal(reserveOdState(state, NOW, 1, 'user')?.reason, 'daily_limit');
  assert.equal(reserveOdState(state, Date.parse('2026-10-04T00:00:00Z'), 1, 'user'), null);
  assert.deepEqual(state.days['2026-10-04'], { calls: 1, units: 1 });
  assert.equal(state.days['2026-10-03'].units, 3000);
});

test('UTC midnight does not reset rolling minute or an upstream block', () => {
  const memory = memoryLedger();
  const before = Date.parse('2026-10-03T23:59:59Z');
  for (let n = 0; n < 60; n++) assert.equal(reserveOdState(memory.state, before, 1, 'user'), null);
  assert.equal(reserveOdState(memory.state, before + 1000, 1, 'user')?.reason, 'minute_limit');
  assert.equal(reserveOdState(memory.state, before + 60_000, 1, 'user'), null);
  blockOdState(memory.state, before, 429, '600');
  assert.equal(reserveOdState(memory.state, before + 61_000, 1, 'user')?.retryAt, before + 600_000);
});

test('replay POST consumes ten units while counting one actual attempt', async () => {
  const memory = memoryLedger();
  let sends = 0;
  const guarded = createOdFetch(memory.ledger, 'user', async () => { sends++; return new Response('{}'); });
  for (let n = 0; n < 6; n++) await guarded('https://api.opendota.com/api/request/1', { method: 'POST' });
  await assert.rejects(guarded('https://api.opendota.com/api/request/2', { method: 'POST' }), denied('minute_limit'));
  assert.equal(sends, 6);
  assert.deepEqual(memory.state.days['2026-10-03'], { calls: 6, units: 60 });
});

test('history hourly cap reserves live capacity and leaves explicit diagnostics separately bounded', async () => {
  const memory = memoryLedger();
  for (let n = 0; n < 32; n++) {
    memory.setNow(NOW + n * 1100);
    await memory.ledger.reserve(1, 'background');
  }
  await assert.rejects(memory.ledger.reserve(1, 'background'), denied('background_hour_limit'));
  await memory.ledger.reserve(1, 'live');
  await memory.ledger.reserve(1, 'user');
});

test('transient retry and timeout each reserve a fresh attempt', async () => {
  for (const failure of [Object.assign(new Error('private URL should not escape'), { code: 'UND_ERR_SOCKET' }), Object.assign(new Error('private timeout'), { name: 'TimeoutError' })]) {
    const memory = memoryLedger();
    let sends = 0;
    const guarded = createOdFetch(memory.ledger, 'background', async () => {
      if (++sends === 1) throw failure;
      return new Response('{"ok":true}');
    });
    const result = await fetchJsonGet('https://api.opendota.com/api/proMatches', { fetchImpl: guarded, sleep: async () => {} });
    assert.deepEqual(result, { ok: true });
    assert.equal(memory.state.days['2026-10-03'].calls, 2);
  }
});

test('JSON body failures also reserve another attempt', async () => {
  const memory = memoryLedger();
  let sends = 0;
  const guarded = createOdFetch(memory.ledger, 'background', async () => {
    sends++;
    if (sends === 1) {
      const response = new Response('{}');
      response.json = async () => { throw Object.assign(new Error('closed'), { code: 'UND_ERR_SOCKET' }); };
      return response;
    }
    return new Response('[]');
  });
  await fetchJsonGet('https://api.opendota.com/api/proMatches', { fetchImpl: guarded, sleep: async () => {} });
  assert.equal(memory.state.days['2026-10-03'].calls, 2);
});

test('429 defers the caller and other consumers until shared Retry-After', async () => {
  const memory = memoryLedger();
  let sends = 0;
  const upstream = async () => { sends++; return new Response('rate limited', { status: 429, headers: { 'Retry-After': '90' } }); };
  const first = createOdFetch(memory.ledger, 'background', upstream);
  const second = createOdFetch(memory.ledger, 'user', upstream);
  await assert.rejects(fetchJsonGet('https://api.opendota.com/api/proMatches', { fetchImpl: first, sleep: async () => assert.fail('must defer, not retry') }), denied('upstream_429'));
  await assert.rejects(second('https://api.opendota.com/api/live'), denied('upstream_429'));
  assert.equal(sends, 1);
  assert.equal(memory.state.blockedUntil, NOW + 90_000);
  memory.setNow(NOW + 90_000);
  await memory.ledger.reserve(1, 'user');
});

test('403 has no automatic repeat and blocks the shared free path until next UTC day', async () => {
  const memory = memoryLedger();
  let sends = 0;
  const guarded = createOdFetch(memory.ledger, 'user', async () => { sends++; return new Response('denied', { status: 403 }); });
  await assert.rejects(guarded('https://api.opendota.com/api/heroes'), denied('upstream_403'));
  await assert.rejects(guarded('https://api.opendota.com/api/live'), denied('upstream_403'));
  assert.equal(sends, 1);
  assert.equal(memory.state.blockedUntil, Date.parse('2026-10-04T00:00:00Z'));
});

test('Retry-After HTTP dates work; absent/invalid/past headers wait 65 seconds', () => {
  assert.equal(retryAfterDeadline('Sat, 03 Oct 2026 12:05:00 GMT', NOW), NOW + 300_000);
  for (const header of [null, 'garbage', '0', '-1', 'Sat, 03 Oct 2026 11:59:00 GMT']) assert.equal(retryAfterDeadline(header, NOW), NOW + 65_000);
});

test('keys and authorization cannot escape through a paid request', async () => {
  const memory = memoryLedger();
  const guarded = createOdFetch(memory.ledger, 'user', async () => assert.fail('must not send'));
  await assert.rejects(guarded('https://api.opendota.com/api/live?api_key=private-example'), denied('paid_mode_disabled'));
  await assert.rejects(guarded('https://api.opendota.com/api/live', { headers: { Authorization: 'Bearer private-example' } }), denied('paid_mode_disabled'));
  assert.deepEqual(memory.state.days, {});
});

test('manual redirects prevent unreserved follow-up calls; unrelated providers pass through', async () => {
  const memory = memoryLedger();
  const guarded = createOdFetch(memory.ledger, 'user', async (_input, init) => {
    assert.equal(init?.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: 'https://api.opendota.com/api/live' } });
  });
  assert.equal((await guarded('https://api.opendota.com/api/heroes')).status, 302);
  const other = createOdFetch(memory.ledger, 'user', async () => new Response('{}'));
  await other('https://api.pandascore.co/dota2/matches/running');
  assert.equal(memory.state.days['2026-10-03'].calls, 1);
});

test('pre-aborted callers do not reserve; DB errors fail closed without secrets', async () => {
  const memory = memoryLedger();
  const guarded = createOdFetch(memory.ledger, 'user', async () => assert.fail('must not send'));
  await assert.rejects(guarded('https://api.opendota.com/api/live', { signal: AbortSignal.abort() }));
  assert.deepEqual(memory.state.days, {});
  const broken = createPgOdLedger({ connect: async () => { throw new Error('postgres://secret-password@host'); } } as unknown as pg.Pool);
  await assert.rejects(broken.reserve(1, 'user'), error => denied('ledger_unavailable')(error) && !String(error).includes('secret-password'));
});

test('PostgreSQL: independent clients race for 60 slots, persist across instances, and share 429 block', { skip: !process.env.OD_TEST_DATABASE_URL }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.OD_TEST_DATABASE_URL, max: 12, connectionTimeoutMillis: 3000 });
  const schema = `od_quota_test_${Date.now()}_${randomBytes(4).toString('hex')}`;
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const first = createPgOdLedger(pool, schema);
    const second = createPgOdLedger(pool, schema);
    const results = await Promise.allSettled(Array.from({ length: 100 }, (_, i) => (i % 2 ? first : second).reserve(1, 'user')));
    assert.equal(results.filter(row => row.status === 'fulfilled').length, 60);
    for (const row of results) if (row.status === 'rejected') assert.ok(denied('minute_limit')(row.reason));
    const restarted = createPgOdLedger(pool, schema);
    const saved = await restarted.snapshot();
    assert.equal(saved.state.days[new Date(saved.now).toISOString().slice(0, 10)].calls, 60);
    await first.block(429, '120');
    await assert.rejects(second.reserve(1, 'background'), denied('upstream_429'));
    assert.equal((await restarted.snapshot()).state.blockedReason, 'upstream_429');
  } finally {
    // The schema name is generated here and is never taken from user/env input.
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});

test('PostgreSQL: history concurrency cannot consume the reserved live slots', {skip:!process.env.OD_TEST_DATABASE_URL},async()=>{
 const pool=new pg.Pool({connectionString:process.env.OD_TEST_DATABASE_URL,max:12,connectionTimeoutMillis:3000});
 const schema='od_priority_test_'+Date.now()+'_'+randomBytes(4).toString('hex');
 try{
  await pool.query('CREATE SCHEMA "'+schema+'"');
  const a=createPgOdLedger(pool,schema),b=createPgOdLedger(pool,schema);
  const history=await Promise.allSettled(Array.from({length:80},(_,i)=>(i%2?a:b).reserve(1,'background')));
  assert.equal(history.filter(r=>r.status==='fulfilled').length,32);
  for(const r of history)if(r.status==='rejected')assert.ok(denied('background_hour_limit')(r.reason));
  const live=await Promise.allSettled(Array.from({length:28},(_,i)=>(i%2?a:b).reserve(1,'live')));
  assert.equal(live.filter(r=>r.status==='fulfilled').length,28);
  // Clear only the isolated fixture's minute window, without touching real provider state.
  await pool.query('UPDATE "'+schema+'".opendota_request_budget SET state=jsonb_set(state,$1,$2::jsonb) WHERE id=1',['{recent}','[]']);
  const tail=await Promise.allSettled(Array.from({length:10},()=>a.reserve(1,'live')));
  assert.equal(tail.filter(r=>r.status==='fulfilled').length,2);
  const restarted=createPgOdLedger(pool,schema);const saved=await restarted.snapshot();
  assert.equal(saved.state.backgroundHour.units,62);assert.equal(saved.state.backgroundHour.liveUnits,30);
  await assert.rejects(restarted.reserve(1,'background'),denied('background_hour_limit'));
 }finally{
  if(!/^od_priority_test_[0-9]+_[a-f0-9]+$/.test(schema))throw new Error('Invalid isolated test schema');
  await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');await pool.end();
 }
});
