import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountRequestError, createAccountDataClient, selectLocalExport } from '../artifacts/mobile/services/AccountDataClient';

test('account export uses the authenticated no-store endpoint and retains scope limitations', async () => {
  const fixture = {formatVersion: 1, scope: 'server_account', account: {id: 7, email: 'fixture@example.invalid'}, limitations: ['device_local_data_not_included', 'operational_logs_and_backups_not_included']};
  const client = createAccountDataClient(async (path, options) => {
    assert.equal(path, '/api/auth/me/export');
    assert.equal(options?.cache, 'no-store');
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer fixture-token');
    return Response.json(fixture);
  });
  assert.deepEqual(await client.exportData('fixture-token'), fixture);
});

test('deletion requires explicit password and exactly a server 204, never a generic success response', async () => {
  let status = 204;
  const client = createAccountDataClient(async (path, options) => {
    assert.equal(path, '/api/auth/me');
    assert.equal(options?.method, 'DELETE');
    assert.deepEqual(JSON.parse(String(options?.body)), {password: 'fixture-password'});
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer fixture-token');
    return new Response(null, {status});
  });
  await client.deleteAccount('fixture-token', 'fixture-password');
  status = 200;
  await assert.rejects(client.deleteAccount('fixture-token', 'fixture-password'), /http_200/);
});

test('wrong password, rate limiting and transport errors remain failures for the caller', async () => {
  const badPassword = createAccountDataClient(async () => Response.json({error: 'invalid_password'}, {status: 403}));
  await assert.rejects(badPassword.deleteAccount('fixture-token', 'wrong-password'), /invalid_password/);
  const limited = createAccountDataClient(async () => Response.json({error: 'too_many_attempts'}, {status: 429, headers: {'Retry-After': '300'}}));
  await assert.rejects(limited.deleteAccount('fixture-token', 'fixture-password'), error => error instanceof AccountRequestError && error.retryAfterSeconds === 300);
  const offline = createAccountDataClient(async () => {throw new Error('offline');});
  await assert.rejects(offline.deleteAccount('fixture-token', 'fixture-password'), /offline/);
});

test('missing authorization and invalid password do not make a request', async () => {
  let calls = 0;
  const client = createAccountDataClient(async () => {calls++;return new Response(null, {status: 204});});
  await assert.rejects(client.exportData(null), /unauthorized/);
  await assert.rejects(client.deleteAccount(null, 'fixture-password'), /unauthorized/);
  await assert.rejects(client.deleteAccount('fixture-token', 'short'), /invalid_password/);
  assert.equal(calls, 0);
});

test('local export contains settings and logs but excludes all credentials and pending uploads', () => {
  const data = selectLocalExport([
    ['@dea_settings', '{"analyticsConsent":false}'], ['@dea_product_events', '[{"eventName":"app_opened"}]'],
    ['@dea_auth_token_v1', 'sensitive'], ['@dea_auth_user_v1', '{"id":7}'], ['admin_token_v1', 'sensitive-admin'],
    ['@dea_log_upload_queue', '[{"pending":true}]'], ['unrelated-origin-key', 'private'], ['@dea_alerts_v2', null],
  ]);
  assert.deepEqual(data, {'@dea_settings': {analyticsConsent: false}, '@dea_product_events': [{eventName: 'app_opened'}]});
});
