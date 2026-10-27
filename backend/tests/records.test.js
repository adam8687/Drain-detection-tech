import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server.js';
import { configFromEnv } from '../src/config.js';
import { SQLiteRecordStore } from '../src/records-storage.js';
import { validateMeasurement, learnCalibration, analyzeDrainage, forecast, computedView, appendMeasurement } from '../src/records-domain.js';
import { simulateMeasurements, SIMULATION_CALIBRATION } from '../src/simulation.js';
import { seedPracticeData } from '../scripts/seed-practice.js';
import { convertLegacy, migrateRecords } from '../scripts/migrate-records.js';
import { GET, POST } from '../../web/app/api/backend/[...path]/route.ts';
import { DrainApi } from '../../web/lib/api.ts';

const config = { ...configFromEnv({ STORAGE_BACKEND: 'sqlite', SQLITE_PATH: ':memory:' }), apiKey: 'test-token' };
const point = (time, distance = 300) => ({ reading_id: randomUUID(), timestamp: new Date(time).toISOString(), sensor_a: { distance_mm: distance, status: 'ok' }, sensor_b: { distance_mm: distance + 20, status: 'ok' } });
const calibration = SIMULATION_CALIBRATION;
const record = overrides => ({ record_id: randomUUID(), fixture_id: 'sink-one', record_type: 'drainage', data_source: 'simulation', recording_status: 'recording', calibration, measurements: [], result: null, created_at: new Date().toISOString(), ...overrides });
async function fixture(t) {
  const app = createApp(config); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (path, method = 'GET', body, auth = true) => { const response = await fetch(base + '/api/v1' + path, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer test-token' } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json() }; };
  return { app, base, api };
}
async function calibrate(api, fixture_id = 'sink-one', data_source = 'simulation') {
  const created = await api('/records', 'POST', { fixture_id, data_source, record_type: 'calibration', confirm_empty: true }); assert.equal(created.status, 201);
  for (const p of simulateMeasurements({ scenario: 'empty', start: Date.now() - 60000 })) { const saved = await api(`/records/${created.data.record_id}/measurements`, 'POST', p); assert.equal(saved.status, 201); if (saved.data.recording_status === 'finished') break; }
  return created.data.record_id;
}

test('measurement validation enforces units, failure nulls, UUIDs and synchronized timestamps', () => {
  const valid = point(Date.now()); assert.deepEqual(validateMeasurement(valid), valid);
  for (const mutate of [p => { p.sensor_a.distance_mm = 0; }, p => { p.sensor_b = { status: 'timeout', distance_mm: 0 }; }, p => { p.timestamp = '2026-01-01'; }, p => { p.timestamp = new Date(Date.now() + 600000).toISOString(); }, p => { p.reading_id = 'not-an-id'; }, p => { p.temperature_c = 20; }]) { const p = structuredClone(valid); mutate(p); assert.throws(() => validateMeasurement(p)); }
});
test('calibration requires stable paired samples across eight seconds, rejects noise and echoes', () => {
  const samples = simulateMeasurements({ scenario: 'empty', start: Date.now() - 60000 });
  assert.ok(learnCalibration(samples).calibration);
  assert.equal(learnCalibration(samples.slice(0, 10)).calibration, null);
  const noisy = samples.slice(-20).map(p => structuredClone(p)); noisy[5].sensor_a.distance_mm += 20;
  assert.equal(learnCalibration(noisy).calibration, null);
  const failed = structuredClone(samples.slice(-20)); failed[10].sensor_b = { status: 'timeout', distance_mm: null };
  assert.equal(learnCalibration(failed).calibration, null);
});
test('backend drainage uses elapsed timestamps, handles pooling, missing echoes and sampling gaps', () => {
  const start = Date.now() - 200000;
  for (const scenario of ['normal','slow','pooling','timeout']) assert.equal(analyzeDrainage(simulateMeasurements({ scenario, start }), calibration).result.outcome, 'completed');
  assert.equal(analyzeDrainage(simulateMeasurements({ scenario: 'gap', start }), calibration).result.outcome, 'uncertain');
  assert.equal(analyzeDrainage(simulateMeasurements({ scenario: 'shallow', start }), calibration).result.outcome, 'uncertain');
  const points = [point(start, 300), point(start + 2000, 400), point(start + 3000, 400), point(start + 4000, 400)];
  assert.equal(analyzeDrainage(points.reverse(), calibration).result.drainage_time_seconds, 2);
});
test('server forecasts refuse stale, invalid and rising values; replay never uses future observations', () => {
  const points = Array.from({ length: 20 }, (_, i) => point(Date.now() - 20000 + i * 500, 300 + i * 2));
  assert.equal(forecast(points, calibration).state, 'forecast');
  assert.equal(forecast(points, calibration, true).state, 'unavailable');
  assert.equal(forecast(points, null).state, 'unavailable');
  const invalid = structuredClone(points); invalid.at(-1).sensor_a = { status: 'timeout', distance_mm: null };
  assert.equal(forecast(invalid, calibration).state, 'unavailable');
  const rising = points.map((p, i) => ({ ...p, sensor_a: { status: 'ok', distance_mm: 350 - i } }));
  assert.equal(forecast(rising, calibration).state, 'unavailable');
  const full = computedView(record({ measurements: points, recording_status: 'finished' }), 8);
  const prefix = computedView(record({ measurements: points.slice(0, 9), recording_status: 'finished' }));
  assert.deepEqual(full.timeline, prefix.timeline);
});
test('single-table storage enforces one active recording and preserves unrelated sources', async t => {
  const store = new SQLiteRecordStore(':memory:'); t.after(() => store.close());
  const row = record({}); await store.insert(row);
  await assert.rejects(() => store.insert(record({})), e => e.status === 409);
  await store.insert(record({ data_source: 'sensor' }));
  assert.equal((await store.list({ fixture_id: 'sink-one' })).length, 2);
  assert.deepEqual(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name), ['drain_records']);
});
test('API requires empty confirmation and isolates calibration by fixture and data source', async t => {
  const { api } = await fixture(t);
  assert.equal((await api('/records', 'POST', { fixture_id: 'sink-one', record_type: 'calibration', data_source: 'simulation' })).status, 422);
  assert.equal((await api('/records', 'POST', { fixture_id: 'sink-one', record_type: 'drainage', data_source: 'simulation' })).status, 409);
  await calibrate(api);
  assert.equal((await api('/records', 'POST', { fixture_id: 'sink-one', record_type: 'drainage', data_source: 'sensor' })).status, 409);
  assert.equal((await api('/records', 'POST', { fixture_id: 'other', record_type: 'drainage', data_source: 'simulation' })).status, 409);
  assert.equal((await api('/records', 'POST', { fixture_id: 'sink-one', record_type: 'drainage', data_source: 'simulation' })).status, 201);
});
test('concurrent uploads and identical retries never overwrite measurements; changed duplicates fail', async t => {
  const { api } = await fixture(t);
  const created = await api('/records', 'POST', { fixture_id: 'sink-one', record_type: 'monitoring', data_source: 'simulation' });
  const id = created.data.record_id, p = point(Date.now() - 20000);
  const responses = await Promise.all(Array.from({ length: 10 }, () => api(`/records/${id}/measurements`, 'POST', p)));
  assert.equal(responses.filter(r => r.status === 201).length, 1); assert.equal(responses.filter(r => r.status === 200).length, 9);
  const next = Array.from({ length: 8 }, (_, i) => point(Date.now() - 15000 + i * 500));
  assert.ok((await Promise.all(next.map(p => api(`/records/${id}/measurements`, 'POST', p)))).every(r => r.status === 201));
  assert.equal((await api(`/records/${id}`)).data.record.measurements.length, 9);
  assert.equal((await api(`/records/${id}/measurements`, 'POST', { ...p, sensor_a: { status: 'ok', distance_mm: 399 } })).status, 409);
});
test('backend auto-finishes drainage and freezes results while allowing identical retry acknowledgements', async t => {
  const { api, app } = await fixture(t); await calibrate(api);
  const created = await api('/records', 'POST', { fixture_id: 'sink-one', data_source: 'simulation', record_type: 'drainage' }); const id = created.data.record_id;
  let last;
  for (const p of simulateMeasurements({ scenario: 'normal', start: Date.now() - 120000 })) { last = p; const r = await api(`/records/${id}/measurements`, 'POST', p); if (r.data.recording_status === 'finished') break; }
  const saved = await app.store.get(id); assert.equal(saved.result.outcome, 'completed');
  assert.equal((await api(`/records/${id}/measurements`, 'POST', last)).status, 200);
  assert.equal((await api(`/records/${id}/measurements`, 'POST', { ...last, reading_id: randomUUID() })).status, 409);
  assert.deepEqual((await api(`/records/${id}/finish`, 'POST')).data.record.result, saved.result);
});
test('failed or abandoned calibration does not hide an earlier usable baseline', async t => {
  const { api } = await fixture(t); await calibrate(api);
  const abandoned = await api('/records', 'POST', { fixture_id: 'sink-one', data_source: 'simulation', record_type: 'calibration', confirm_empty: true });
  await api(`/records/${abandoned.data.record_id}/finish`, 'POST');
  assert.equal((await api('/records', 'POST', { fixture_id: 'sink-one', data_source: 'simulation', record_type: 'drainage' })).status, 201);
});
test('auth, CORS, body limits and unavailable storage never silently fall back', async t => {
  const { api, base } = await fixture(t);
  assert.equal((await api('/records', 'GET', undefined, false)).status, 401);
  assert.equal((await api('/records?limit=999')).status, 422);
  assert.equal((await api('/devices')).status, 200);
  const options = await fetch(base + '/api/v1/records', { method: 'OPTIONS', headers: { Origin: 'https://untrusted.example' } }); assert.equal(options.status, 403);
  assert.equal((await api('/records', 'POST', { padding: 'a'.repeat(20000) })).status, 413);
});
test('seed data is repeatable, sensor-like, source labeled, and results are computed rather than invented', async t => {
  const store = new SQLiteRecordStore(':memory:'); t.after(() => store.close());
  const first = await seedPracticeData(store), second = await seedPracticeData(store);
  assert.deepEqual(first, second); assert.equal(first.records, 7);
  const rows = await store.list({ fixture_id: first.fixture_id }, 100);
  assert.ok(rows.every(r => r.data_source === 'simulation'));
  const drainage = rows.filter(r => r.record_type === 'drainage');
  assert.ok(drainage.some(r => r.result.outcome === 'uncertain'));
  assert.ok(drainage.some(r => r.measurements.some(p => p.sensor_a.status !== 'ok' || p.sensor_b.status !== 'ok')));
  assert.ok(drainage.every(r => r.measurements.every(p => ['sensor_a','sensor_b'].every(s => p[s].distance_mm === null || Number.isInteger(p[s].distance_mm)))));
});
test('legacy migration preserves measurements, baseline snapshots and completed duration, without overwrites', async t => {
  const store = new SQLiteRecordStore(':memory:'); t.after(() => store.close());
  const calId = randomUUID(), sessionId = randomUUID(), sampleId = randomUUID(), time = '2026-10-20T12:00:00.000Z';
  const legacy = { devices: [{ device_id: 'old-sink', created_at: time, calibration: { hardware: { id: calId, device_id: 'old-sink', created_at: time, empty_distance_mm: { a: 400, b: 420 }, source: 'hardware' } } }], readings: [{ event_id: sampleId, device_id: 'old-sink', source: 'hardware', measured_at: time, calibration_id: calId, readings: [{ sensor_id: 'a', status: 'ok', distance_mm: 300 }, { sensor_id: 'b', status: 'timeout', distance_mm: null }] }], sessions: [{ id: sessionId, device_id: 'old-sink', source: 'hardware', started_at: time, finished_at: '2026-10-20T12:01:00.000Z', status: 'finished', calibration_id: calId, analysis: { outcome: 'completed', drain_duration_ms: 42000 } }] };
  assert.equal(convertLegacy(legacy).length, 2);
  const migrated = await migrateRecords(store, legacy); assert.equal(migrated.measurements, 1);
  assert.deepEqual(await migrateRecords(store, legacy), migrated);
  const row = await store.get(sessionId); assert.equal(row.measurements[0].reading_id, sampleId); assert.equal(row.result.drainage_time_seconds, 42); assert.deepEqual(row.calibration, calibration);
  const changed = structuredClone(legacy); changed.sessions[0].analysis.drain_duration_ms = 99;
  await assert.rejects(() => migrateRecords(store, changed), /overwrite/);
});
test('same-origin gateway and typed client use only new routes, forward auth and preserve server calculations', async t => {
  const { base } = await fixture(t);
  const before = process.env.BACKEND_URL; process.env.BACKEND_URL = base;
  t.after(() => { if (before === undefined) delete process.env.BACKEND_URL; else process.env.BACKEND_URL = before; });
  const context = { params: Promise.resolve({ path: ['api','v1','records'] }) };
  const request = new Request('http://frontend/api/backend/api/v1/records', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' }, body: JSON.stringify({ fixture_id: 'proxy-sink', data_source: 'simulation', record_type: 'monitoring' }) });
  assert.equal((await POST(request, context)).status, 201);
  const response = await GET(new Request('http://frontend/api/backend/api/v1/records?fixture_id=proxy-sink', { headers: { Authorization: 'Bearer test-token' } }), context);
  assert.equal((await response.json()).records.length, 1);
  assert.equal((await GET(new Request('http://frontend/api/backend/rest/v1/drain_records'), { params: Promise.resolve({ path: ['rest','v1','drain_records'] }) })).status, 404);
  const client = new DrainApi(base, 'test-token'); assert.equal((await client.records('proxy-sink','simulation')).records.length, 1);
});
test('SSE sends backend snapshots and cleans up disconnected streams', async t => {
  const { api, base } = await fixture(t);
  const created = await api('/records', 'POST', { fixture_id: 'sink-one', record_type: 'monitoring', data_source: 'simulation' });
  const controller = new AbortController();
  const response = await fetch(`${base}/api/v1/records/${created.data.record_id}/stream`, { headers: { Authorization: 'Bearer test-token' }, signal: controller.signal });
  const reader = response.body.getReader(); let value = '';
  while (!value.includes('event: snapshot')) value += new TextDecoder().decode((await reader.read()).value);
  assert.match(value, /"computed"/); controller.abort(); await reader.cancel().catch(() => {});
});

test('migration rejects conflicting calibration histories instead of silently choosing a baseline', () => {
  const id = randomUUID(), original = { id, device_id: 'sink', source: 'hardware', created_at: new Date().toISOString(), empty_distance_mm: { a: 400, b: 420 } };
  assert.throws(() => convertLegacy({ devices: [{ device_id: 'sink', calibration: { hardware: { ...original, empty_distance_mm: { a: 900, b: 900 } } } }], calibrations: [original], readings: [], sessions: [] }), /Conflicting/);
});
test('production configuration requires Supabase, strong API authentication and explicit origins', () => {
  assert.throws(() => configFromEnv({ NODE_ENV: 'production', STORAGE_BACKEND: 'sqlite' }));
  assert.throws(() => configFromEnv({ NODE_ENV: 'production', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_fixture', API_KEY: 'short' }));
  assert.throws(() => configFromEnv({ NODE_ENV: 'production', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_fixture', API_KEY: 'a'.repeat(32), CORS_ORIGINS: '*' }));
});

test('long stretches of failed echoes cannot produce a precise completed duration', () => {
  const start = Date.now() - 60000;
  const points = [point(start)];
  for (let i = 1; i <= 15; i++) points.push({ ...point(start + i * 1000), sensor_b: { distance_mm: null, status: 'timeout' } });
  for (let i = 16; i <= 18; i++) points.push(point(start + i * 1000, 400));
  const result = analyzeDrainage(points, calibration).result;
  assert.equal(result.outcome, 'uncertain'); assert.equal(result.drainage_time_seconds, null);
});
