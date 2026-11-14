import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { settings, firmwareHeader, checkTables, prepareRecord, verifyStoredPoint, api } from '../../device/wifi/testing.js';
import { configFromEnv } from '../src/config.js';
import { createApp } from '../src/server.js';

const interfaces = { en0: [{ address: '192.168.4.20', family: 'IPv4', internal: false }] };
const wifi = { WIFI_SSID: 'test "wifi"', WIFI_PASSWORD: 'back\\slash', ALLOW_LOCAL_HTTP: 'true' };

test('Wi-Fi setup derives ESP/proxy ports and rejects ambiguous, stale or conflicting addresses', () => {
  const config = settings({ PORT: '8123' }, { ...wifi, WEB_PORT: '3040' }, interfaces);
  assert.equal(config.base, 'http://192.168.4.20:8123');
  assert.equal(config.local, 'http://127.0.0.1:8123');
  assert.equal(config.web, 'http://localhost:3040');
  assert.throws(() => settings({ PORT: '3040' }, { ...wifi, WEB_PORT: '3040' }, interfaces));
  assert.throws(() => settings({}, { ...wifi, WIFI_HOST: '127.0.0.1' }, interfaces));
  assert.throws(() => settings({}, { ...wifi, WIFI_HOST: '192.168.4.21' }, interfaces));
  assert.throws(() => settings({}, wifi, { ...interfaces, en1: [{ address: '10.0.0.1', family: 'IPv4', internal: false }] }));
  assert.throws(() => settings({ PORT: '-1' }, wifi, interfaces));
});

test('firmware escapes credentials, carries sensor settings and refuses admin keys', () => {
  const config = settings({}, { ...wifi, SECOND_SENSOR_ENABLED: 'true', USE_UART: 'true' }, interfaces);
  const header = firmwareHeader(config, randomUUID(), 'dk_test-fixture');
  assert.ok(header.includes(JSON.stringify(wifi.WIFI_SSID)));
  assert.ok(header.includes(JSON.stringify(wifi.WIFI_PASSWORD)));
  assert.ok(!header.includes('SECOND_SENSOR_ENABLED'));
  assert.ok(header.includes('constexpr bool USE_UART = true;'));
  assert.ok(!header.includes('SUPABASE_SECRET_KEY'));
  assert.throws(() => firmwareHeader(config, randomUUID(), 'sb_secret_do-not-use'));
  assert.throws(() => firmwareHeader({ ...config, allowHttp: false }, randomUUID(), 'dk_test'));
  assert.throws(() => firmwareHeader({ ...config, ssid: 'line\nfeed' }, randomUUID(), 'dk_test'));
});
test('cloud configuration needs no LAN address, requires TLS verification and preserves an explicit migration source',()=>{
  const config=settings({}, {...wifi,CLOUD_API_URL:'https://test-project.supabase.co/functions/v1/drain-api'}, {});
  assert.equal(config.local,config.base);assert.equal(config.cloud,true);
  assert.throws(()=>firmwareHeader(config,randomUUID(),'dk_test'),/root CA/);
  config.rootCa='-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n';
  config.previousBase='http://192.168.1.20:8000';
  const header=firmwareHeader(config,randomUUID(),'dk_test');
  assert.ok(header.includes('constexpr bool ALLOW_LOCAL_HTTP = false;'));
  assert.ok(header.includes('PREVIOUS_API_BASE_URL[] = "http://192.168.1.20:8000"'));
  assert.throws(()=>settings({}, {...wifi,CLOUD_API_URL:'http://test-project.supabase.co/functions/v1/drain-api'},{}));
});

test('preflight reports the missing access migration without writes or credentials in URLs', async () => {
  const requests = [];
  const config = { supabaseUrl: 'https://test-project.supabase.co', supabaseKey: 'sb_secret_test' };
  await assert.rejects(checkTables(config, async (url, options) => {
    requests.push({ url, options });
    return new Response('{}', { status: url.includes('dm_device_members') ? 404 : 200 });
  }), /202610270002_records_access.sql/);
  assert.equal(requests.length, 3);
  assert.ok(requests.every(r => !r.options.method && !r.url.includes(config.supabaseKey)));
});

test('Wi-Fi preparation scopes sensor keys, preserves active measurements and starts new records after finishing', async t => {
  const app = createApp({ ...configFromEnv({ STORAGE_BACKEND: 'sqlite', SQLITE_PATH: ':memory:' }), apiKey: 'admin-test' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const local = `http://127.0.0.1:${app.server.address().port}`;
  const config = { ...settings({}, wifi, interfaces), local };
  let retainedKey;
  const first = await prepareRecord({ config, token: 'admin-test', fixture: 'friend-test', type: 'monitoring', previous: { saveKey: key => { retainedKey = key; } } });
  assert.equal(retainedKey, first.key);
  const point = { reading_id: randomUUID(), timestamp: new Date().toISOString(), sensor: { distance_mm: 314, status: 'ok' } };
  await api(local, first.key, `/records/${first.record.record_id}/measurements`, point);
  const second = await prepareRecord({ config, token: 'admin-test', fixture: 'friend-test', type: 'monitoring', previous: { key: first.key } });
  assert.equal(second.record.record_id, first.record.record_id);
  assert.equal(second.key, first.key);
  assert.deepEqual((await app.store.get(first.record.record_id)).measurements, [point]);
  await assert.rejects(api(local, first.key, '/records'), /403/);
  await assert.rejects(prepareRecord({ config: { ...config, second: true }, token: 'admin-test', fixture: 'friend-test', type: 'calibration', confirmEmpty: true }), /active monitoring/);
  await api(local, 'admin-test', `/records/${first.record.record_id}/finish`, {});
  const next = await prepareRecord({ config, token: 'admin-test', fixture: 'friend-test', type: 'monitoring', previous: { key: first.key } });
  assert.notEqual(next.record.record_id, first.record.record_id);
});

test('calibration requires the sensor and empty confirmation before any network mutation', async () => {
  const config = settings({}, wifi, interfaces);
  const request = () => { throw Error('Unexpected network request'); };
  await assert.rejects(prepareRecord({ config: { ...config, second: true }, fixture: 'sink', type: 'calibration', request }), /confirm-empty/);
});

test('watch requires a new sensor point and exact cloud/frontend readback', () => {
  const recordId = randomUUID(), point = { reading_id: randomUUID(), timestamp: new Date().toISOString(), sensor: { distance_mm: 314, status: 'ok' } };
  const record = { record_id: recordId, fixture_id: 'sink', data_source: 'sensor', measurements: [point] };
  const options = { apiRecord: record, dbRecord: structuredClone(record), frontendRecord: structuredClone(record), fixture: 'sink', recordId, previousIds: new Set() };
  assert.deepEqual(verifyStoredPoint(options), point);
  assert.equal(verifyStoredPoint({ ...options, previousIds: new Set([point.reading_id]) }), null);
  assert.throws(() => verifyStoredPoint({ ...options, dbRecord: { ...record, data_source: 'simulation' } }));
  const changed = structuredClone(record); changed.measurements[0].sensor.distance_mm = 999;
  assert.throws(() => verifyStoredPoint({ ...options, frontendRecord: changed }), /does not match/);
});

test('a saved recording that no longer exists is not an error, but other failures are', async () => {
  const { findPreviousRecording } = await import('../../device/wifi/testing.js');
  const failing = status => async () => { throw Object.assign(Error(`API ${status}: x`), { status }); };
  assert.equal(await findPreviousRecording(failing(404), 'https://x', 't', randomUUID()), null);
  await assert.rejects(findPreviousRecording(failing(401), 'https://x', 't', randomUUID()), /401/);
  await assert.rejects(findPreviousRecording(failing(503), 'https://x', 't', randomUUID()), /503/);
  const id = randomUUID();
  assert.deepEqual(await findPreviousRecording(async (b, t, path) => ({ record: { record_id: id, path } }), 'https://x', 't', id), { record_id: id, path: `/records/${id}` });
  // The shared API helper now reports the status code so callers can tell not-found from an outage.
  const error = await api('https://x', 't', '/records/none', undefined, async () => new Response(JSON.stringify({ error: { message: 'Record not found' } }), { status: 404 })).catch(e => e);
  assert.equal(error.status, 404);
  assert.match(error.message, /API 404: Record not found/);
});

test('an installer can link a provisioned unit to a customer account by e-mail, once', async () => {
  const { findAuthUser, grantOwner } = await import('../../device/wifi/testing.js');
  const users = Array.from({ length: 230 }, (_, i) => ({ id: randomUUID(), email: `person${i}@example.com` }));
  const seen = [];
  const fetcher = async (url, init) => {
    seen.push({ url, init });
    const page = Number(new URL(url).searchParams.get('page'));
    return new Response(JSON.stringify({ users: users.slice((page - 1) * 200, page * 200) }), { status: 200 });
  };
  const found = await findAuthUser(' PERSON215@Example.com ', { supabaseUrl: 'https://p.supabase.co', key: 'sb_secret_test', fetcher });
  assert.equal(found.id, users[215].id);
  assert.equal(seen.length, 2, 'looks through the second page');
  assert.equal(seen[0].init.headers.apikey, 'sb_secret_test');
  assert.equal('Authorization' in seen[0].init.headers, false, 'new-style secret keys are sent as apikey only');
  assert.equal(await findAuthUser('nobody@example.com', { supabaseUrl: 'https://p.supabase.co', key: 'sb_secret_test', fetcher }), null);
  await assert.rejects(findAuthUser('not-an-email', { supabaseUrl: 'https://p.supabase.co', key: 'k', fetcher }), /name@example.com/);
  await assert.rejects(findAuthUser('a@b.co', { supabaseUrl: 'https://p.supabase.co', key: 'k', fetcher: async () => new Response('{}', { status: 401 }) }), /Cannot look up/);
  const rows = [];
  const store = { list: async (table, filters) => rows.filter(r => r.device_id === filters.device_id), insert: async (table, row) => { assert.equal(table, 'device_members'); rows.push(row); return row; } };
  assert.equal(await grantOwner(store, 'DR-1', found.id, new Date('2026-11-14T00:00:00Z')), true);
  assert.equal(await grantOwner(store, 'DR-1', found.id), false, 'already an owner');
  assert.deepEqual({ ...rows[0], id: 'x' }, { id: 'x', device_id: 'DR-1', user_id: found.id, role: 'owner', created_at: '2026-11-14T00:00:00.000Z' });
});
