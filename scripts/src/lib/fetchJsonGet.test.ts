import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchJsonGet, OpenDotaGetError } from './fetchJsonGet.js';

const url = 'https://api.opendota.com/api/matches/1?api_key=test-secret-do-not-log';

test('transient failure is bounded to three requests and exports a sanitized retry classification', async () => {
  let calls = 0;
  await assert.rejects(fetchJsonGet(url, { fetchImpl: (async () => { calls++; throw new DOMException(url, 'TimeoutError'); }) as typeof fetch,
    sleep: async () => {} }), (error: unknown) => {
    assert.ok(error instanceof OpenDotaGetError);
    assert.equal(error.retryable, true);
    assert.equal(error.status, null);
    assert.equal(error.message.includes('test-secret'), false);
    return true;
  });
  assert.equal(calls, 3);
});

test('permanent HTTP failure does not retry inside the GET helper', async () => {
  let calls = 0;
  await assert.rejects(fetchJsonGet(url, { fetchImpl: (async () => { calls++; return new Response('', { status: 401 }); }) as typeof fetch }), (error: unknown) => {
    assert.ok(error instanceof OpenDotaGetError);
    assert.equal(error.retryable, false);
    assert.equal(error.status, 401);
    return true;
  });
  assert.equal(calls, 1);
});

test('long server Retry-After is retained for the next job instead of a premature request', async () => {
  let calls = 0;
  await assert.rejects(fetchJsonGet(url, { fetchImpl: (async () => { calls++; return new Response('', { status: 503, headers: { 'Retry-After': '172800' } }); }) as typeof fetch }), (error: unknown) => {
    assert.ok(error instanceof OpenDotaGetError);
    assert.equal(error.retryable, true);
    assert.equal(error.retryAfterMs, 172800000);
    return true;
  });
  assert.equal(calls, 1);
});

test('quota deferral remains the original ledger exception without additional GET attempts', async () => {
  let calls = 0;
  const deferred = Object.assign(new Error('budget cap'), { code: 'OD_DEFERRED' });
  await assert.rejects(fetchJsonGet(url, { fetchImpl: (async () => { calls++; throw deferred; }) as typeof fetch }), error => error === deferred);
  assert.equal(calls, 1);
});

test('successful JSON after a transient status returns the actual payload', async () => {
  let calls = 0;
  const payload = await fetchJsonGet(url, { sleep: async () => {}, fetchImpl: (async () => ++calls === 1
    ? new Response('', { status: 522 }) : Response.json({ match_id: 1, version: null })) as typeof fetch });
  assert.deepEqual(payload, { match_id: 1, version: null });
  assert.equal(calls, 2);
});
