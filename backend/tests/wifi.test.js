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
  assert.ok(header.includes('constexpr bool SECOND_SENSOR_ENABLED = true;'));
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
  const point = { reading_id: randomUUID(), timestamp: new Date().toISOString(), sensor_a: { distance_mm: 314, status: 'ok' }, sensor_b: { distance_mm: null, status: 'timeout' } };
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

test('calibration requires both sensors and empty confirmation before any network mutation', async () => {
  const config = settings({}, wifi, interfaces);
  const request = () => { throw Error('Unexpected network request'); };
  await assert.rejects(prepareRecord({ config, fixture: 'sink', type: 'calibration', confirmEmpty: true, request }), /two working sensors/);
  await assert.rejects(prepareRecord({ config: { ...config, second: true }, fixture: 'sink', type: 'calibration', request }), /confirm-empty/);
});

test('watch requires a new sensor point and exact cloud/frontend readback', () => {
  const recordId = randomUUID(), point = { reading_id: randomUUID(), timestamp: new Date().toISOString(), sensor_a: { distance_mm: 314, status: 'ok' }, sensor_b: { distance_mm: null, status: 'timeout' } };
  const record = { record_id: recordId, fixture_id: 'sink', data_source: 'sensor', measurements: [point] };
  const options = { apiRecord: record, dbRecord: structuredClone(record), frontendRecord: structuredClone(record), fixture: 'sink', recordId, previousIds: new Set() };
  assert.deepEqual(verifyStoredPoint(options), point);
  assert.equal(verifyStoredPoint({ ...options, previousIds: new Set([point.reading_id]) }), null);
  assert.throws(() => verifyStoredPoint({ ...options, dbRecord: { ...record, data_source: 'simulation' } }));
  const changed = structuredClone(record); changed.measurements[0].sensor_a.distance_mm = 999;
  assert.throws(() => verifyStoredPoint({ ...options, frontendRecord: changed }), /does not match/);
});
