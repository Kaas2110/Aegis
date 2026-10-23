import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  emptyOdState,
  configureOdPaidState,
  reserveOdState,
  effectiveOdProfile,
  createOdFetch,
  createPgOdLedger,
  blockOdState,
  OdQuotaExhaustedError,
  type OdLedger
} from '../src/opendotaBudget';
const NOW = Date.parse('2026-10-04T12:00:00Z');
const CFG = { enabled: true, minute: 100, monthlyLimitUnits: 200_000, archiveLimitUnits: 200_000 };
function memory() {
  const state = emptyOdState();
  let now = NOW;
  configureOdPaidState(state, now, CFG);
  const ledger: OdLedger = {
    async reserve(units, kind, key) {
      const profile = effectiveOdProfile(state, now, units, kind);
      const err = reserveOdState(state, now, units, kind, key);
      if (err) throw err;
      return { profile };
    },
    async block(status, header) {
      return blockOdState(state, now, status, header);
    },
    async snapshot() {
      return { state, now };
    }
  };
  return { state, ledger, time: (v: number) => (now = v) };
}
test('paid key is injected only after authorization and only to the exact provider host', async () => {
  const m = memory();
  let calls = 0;
  const f = createOdFetch(
    m.ledger,
    'background',
    async (input) => {
      calls++;
      const url = new URL(String(input));
      assert.equal(url.searchParams.get('api_key'), 'example-test-key');
      assert.equal(m.state.paid!.months['2026-10'].units, 1);
      return new Response('{}');
    },
    () => 'example-test-key'
  );
  await f('https://api.opendota.com/api/heroes');
  assert.equal(calls, 1);
  assert.deepEqual(m.state.days, {});
  const other = createOdFetch(
    m.ledger,
    'background',
    async (input) => {
      assert.equal(String(input), 'https://example.com/');
      return new Response('{}');
    },
    () => {
      assert.fail('Do not resolve key for another host');
    }
  );
  await other('https://example.com/');
});
test('paid spend exhaustion automatically uses unkeyed free with separate counters', async () => {
  const m = memory();
  m.state.paid!.months['2026-10'] = { units: 200_000, archiveUnits: 180_000 };
  const f = createOdFetch(
    m.ledger,
    'background',
    async (input) => {
      assert.equal(new URL(String(input)).searchParams.has('api_key'), false);
      return new Response('{}');
    },
    () => 'example-test-key'
  );
  await f('https://api.opendota.com/api/heroes');
  assert.equal(m.state.paid!.months['2026-10'].units, 200_000);
  assert.equal(m.state.days['2026-10-04'].units, 1);
});
test('last allowed paid attempt remains keyed; next attempt switches to free', async () => {
  const m = memory();
  m.state.paid!.months['2026-10'] = { units: 199_999, archiveUnits: 0 };
  const keys: boolean[] = [];
  const f = createOdFetch(
    m.ledger,
    'background',
    async (input) => {
      keys.push(new URL(String(input)).searchParams.has('api_key'));
      return new Response('{}');
    },
    () => 'example-test-key'
  );
  await f('https://api.opendota.com/api/heroes');
  await f('https://api.opendota.com/api/heroes');
  assert.deepEqual(keys, [true, false]);
  assert.equal(m.state.paid!.months['2026-10'].units, 200_000);
});
test('spend and archive lifetime do not reset across disable/reconfigure or a new month', () => {
  const m = memory();
  m.state.paid!.archiveUnits = 200_000;
  m.state.paid!.months['2026-10'] = { units: 200_000, archiveUnits: 200_000 };
  configureOdPaidState(m.state, NOW + 1, { ...CFG, enabled: false });
  configureOdPaidState(m.state, NOW + 2, CFG);
  assert.equal(m.state.paid!.archiveUnits, 200_000);
  assert.equal(
    effectiveOdProfile(m.state, Date.parse('2026-11-01T00:00:00Z'), 1, 'background'),
    'paid'
  );
  assert.equal(
    effectiveOdProfile(m.state, Date.parse('2026-11-01T00:00:00Z'), 1, 'archive'),
    'free'
  );
});
test('no fallback after provider403/429; Retry-After blocks paid and free', async () => {
  for (const status of [403, 429] as const) {
    const m = memory();
    let sends = 0;
    const f = createOdFetch(
      m.ledger,
      'background',
      async () => {
        sends++;
        return new Response('blocked', { status, headers: { 'retry-after': '120' } });
      },
      () => 'example-test-key'
    );
    await assert.rejects(f('https://api.opendota.com/api/heroes'));
    m.state.paid!.months['2026-10'] = { units: 200_000, archiveUnits: 0 };
    await assert.rejects(f('https://api.opendota.com/api/heroes'));
    assert.equal(sends, 1);
  }
});
test('archive cadence is shared; 98 nonlive slots leave two for live', () => {
  const m = memory();
  assert.equal(reserveOdState(m.state, NOW, 1, 'archive', true), null);
  assert.equal(reserveOdState(m.state, NOW, 1, 'archive', true)?.reason, 'archive_pacing');
  for (let i = 1; i < 98; i++)
    assert.equal(reserveOdState(m.state, NOW, 1, 'background', true), null);
  assert.equal(reserveOdState(m.state, NOW, 1, 'background', true)?.reason, 'minute_limit');
  assert.equal(reserveOdState(m.state, NOW, 1, 'live', true), null);
  assert.equal(reserveOdState(m.state, NOW, 1, 'live', true), null);
  assert.equal(reserveOdState(m.state, NOW, 1, 'live', true)?.reason, 'minute_limit');
});
test('missing paid key fails closed; caller cannot smuggle a key or Authorization', async () => {
  const m = memory();
  const f = createOdFetch(m.ledger, 'background', async () => assert.fail('must not send'));
  await assert.rejects(
    f('https://api.opendota.com/api/heroes'),
    (e) => e instanceof OdQuotaExhaustedError && e.reason === 'paid_key_missing'
  );
  await assert.rejects(f('https://api.opendota.com/api/heroes?api_key=manual'));
  await assert.rejects(
    f('https://api.opendota.com/api/heroes', { headers: { authorization: 'test' } })
  );
  assert.deepEqual(m.state.paid!.months, {});
});
test('each retry and expensive replay attempt is charged conservatively; errors redact keyed URLs', async () => {
  const m = memory();
  const f = createOdFetch(
    m.ledger,
    'background',
    async (input) => {
      throw new Error(String(input));
    },
    () => 'example-test-key'
  );
  for (let i = 0; i < 2; i++)
    await assert.rejects(
      f('https://api.opendota.com/api/request/1', { method: 'POST' }),
      (e) => !String(e).includes('example-test-key')
    );
  assert.equal(m.state.paid!.months['2026-10'].units, 20);
});
test('free daily quota is independent from paid traffic and UTC month rollover preserves provider block', () => {
  const m = memory();
  m.state.paid!.months['2026-10'] = { units: 200_000, archiveUnits: 0 };
  m.state.days['2026-10-04'] = { calls: 3000, units: 3000 };
  assert.equal(reserveOdState(m.state, NOW, 1, 'live', true)?.reason, 'daily_limit');
  blockOdState(m.state, Date.parse('2026-10-31T23:59:30Z'), 429, '120');
  assert.equal(
    reserveOdState(m.state, Date.parse('2026-11-01T00:00:00Z'), 1, 'live', true)?.reason,
    'upstream_429'
  );
});
test(
  'PostgreSQL concurrent paid spend cap, restart, and separate free fallback',
  { skip: !process.env.OD_TEST_DATABASE_URL },
  async () => {
    const pool = new pg.Pool({ connectionString: process.env.OD_TEST_DATABASE_URL, max: 10 });
    const schema = `od_paid_test_${Date.now()}`;
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      const a = createPgOdLedger(pool, schema),
        b = createPgOdLedger(pool, schema);
      await a.configurePaid!(CFG);
      const { state, now } = await a.snapshot();
      const month = new Date(now).toISOString().slice(0, 7);
      state.paid!.months[month] = { units: 199_998, archiveUnits: 0 };
      await pool.query(
        `UPDATE "${schema}".opendota_request_budget SET state=$1::jsonb WHERE id=1`,
        [JSON.stringify(state)]
      );
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).reserve(1, 'background', true))
      );
      assert.equal(results.filter((r) => r?.profile === 'paid').length, 2);
      assert.equal(results.filter((r) => r?.profile === 'free').length, 8);
      const restarted = createPgOdLedger(pool, schema);
      await restarted.configurePaid!(CFG);
      const saved = await restarted.snapshot();
      assert.equal(saved.state.paid!.months[month].units, 200_000);
      assert.equal(
        Object.values(saved.state.days).reduce((sum, d) => sum + d.units, 0),
        8
      );
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  }
);

test('malformed array money buckets fail closed instead of losing keyed entries',()=>{
 for(const field of ['months','days'] as const){const m=memory();(m.state.paid as any)[field]=[];assert.throws(()=>reserveOdState(m.state,NOW,1,'background',true),/Invalid paid state/);}
});
