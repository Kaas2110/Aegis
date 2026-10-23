import assert from 'node:assert/strict';
import { test } from 'node:test';
// Capture a stub as the runtime transport's underlying fetch. Even a regression
// in the default path must not contact an external service during this test.
const originalFetch = globalThis.fetch;
let defaultSends = 0;
globalThis.fetch = async () => { defaultSends++; return new Response('{"default":true}'); };
const { fetchJsonGet } = await import('./src/lib/fetchJsonGet.ts');
const { openDotaLedger } = await import('../lib/db/src/opendota.ts');
globalThis.fetch = originalFetch;

test('default transport reserves a background attempt without explicit fetchImpl', async t => {
  const reservations = [];
  t.mock.method(openDotaLedger, 'reserve', async (units, kind) => { reservations.push({ units, kind }); });
  const before = defaultSends;
  assert.deepEqual(await fetchJsonGet('https://api.opendota.com/api/matches/1'), { default: true });
  assert.deepEqual(reservations, [{ units: 1, kind: 'background' }]);
  assert.equal(defaultSends - before, 1);
});

test('default transport stops before sending or retrying when shared budget defers', async t => {
  const deferred = Object.assign(new Error('OpenDota request deferred'), { code: 'OD_DEFERRED' });
  t.mock.method(openDotaLedger, 'reserve', async () => { throw deferred; });
  const before = defaultSends;
  await assert.rejects(fetchJsonGet('https://api.opendota.com/api/proMatches', {
    sleep: async () => assert.fail('must not retry a shared defer'),
  }), error => error === deferred);
  assert.equal(defaultSends, before);
});

const privateUrl = 'https://example.invalid/data?api_key=must-never-appear';
const socketError = () => new TypeError(`terminated ${privateUrl}`, { cause: { code: 'UND_ERR_SOCKET' } });

test('retries a socket failure during body reading, not just before headers', async () => {
  let calls = 0;
  const waits = [];
  const value = await fetchJsonGet(privateUrl, {
    fetchImpl: async (_url, options) => {
      assert.equal(options.method, 'GET');
      calls++;
      if (calls === 1) return { ok: true, json: async () => { throw socketError(); } };
      return new Response('[1,2]');
    },
    sleep: async ms => waits.push(ms),
  });
  assert.deepEqual(value, [1, 2]);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1100]);
});

test('retries 503 and 429 within three attempts and respects Retry-After', async () => {
  const statuses = [503, 429, 200];
  const waits = [];
  assert.deepEqual(await fetchJsonGet(privateUrl, {
    fetchImpl: async () => {
      const status = statuses.shift();
      return new Response('[]', { status, headers: status === 429 ? { 'retry-after': '12' } : {} });
    },
    sleep: async ms => waits.push(ms),
  }), []);
  assert.deepEqual(waits, [1100, 12000]);
});

test('does not retry authentication or other permanent HTTP errors', async () => {
  for (const status of [400, 401, 403, 404]) {
    let calls = 0;
    await assert.rejects(fetchJsonGet(privateUrl, {
      fetchImpl: async () => { calls++; return new Response('', { status }); },
      sleep: async () => assert.fail('must not retry'),
    }), new RegExp(`HTTP ${status}$`));
    assert.equal(calls, 1);
  }
});

test('exhausts transient failures after three attempts without leaking the URL', async () => {
  let calls = 0;
  await assert.rejects(fetchJsonGet(privateUrl, {
    fetchImpl: async () => { calls++; throw socketError(); },
    sleep: async () => {},
  }), error => {
    assert.match(error.message, /after 3 attempt\(s\): UND_ERR_SOCKET$/);
    assert.doesNotMatch(String(error), /api_key|must-never-appear|example\.invalid/);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(calls, 3);
});

test('body timeout aborts each attempt and uses a fresh deadline for retries', async () => {
  const signals = [];
  // AbortSignal.timeout is unref'ed; keep this isolated fake-body test alive.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(fetchJsonGet(privateUrl, {
      timeoutMs: 5,
      fetchImpl: async (_url, { signal }) => {
        signals.push(signal);
        return new Response(new ReadableStream({
          start(controller) {
            signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
          },
        }));
      },
      sleep: async () => {},
    }), /after 3 attempt\(s\): timeout$/);
    assert.equal(signals.length, 3);
    assert.equal(new Set(signals).size, 3);
    assert.ok(signals.every(signal => signal.aborted));
  } finally {
    clearTimeout(keepAlive);
  }
});

test('invalid JSON and long server cooldown do not cause premature retries', async () => {
  for (const response of [new Response('{'), new Response('', { status: 429, headers: { 'retry-after': '120' } })]) {
    let calls = 0;
    await assert.rejects(fetchJsonGet(privateUrl, {
      fetchImpl: async () => { calls++; return response; },
      sleep: async () => assert.fail('must not retry'),
    }), response.status === 429 ? /Retry-After 120s.*deferred to a later job/ : /invalid JSON/);
    assert.equal(calls, 1);
  }
});
