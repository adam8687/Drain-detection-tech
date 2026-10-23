import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../src/server.js';
import { configFromEnv } from '../src/config.js';
import { SQLiteStore, SupabaseStore } from '../src/storage.js';
import { analyzeSession, distances, emptyFixtureBaseline } from '../src/domain.js';
import { validateFrame } from '../src/validation.js';

const config = overrides => ({ ...configFromEnv({ STORAGE_BACKEND: 'sqlite', SQLITE_PATH: ':memory:' }), ...overrides });
const cal = { id: randomUUID(), empty_distance_mm: { a: 400, b: 420 }, wet_threshold_mm: 20, dry_threshold_mm: 8, stable_samples: 3, max_gap_ms: 5000 };
const session = { source: 'mock', started_at: '2026-10-22T00:00:00.000Z', finished_at: '2026-10-22T00:01:00.000Z' };
function frame(depth = 100, time = '2026-10-22T00:00:01.000Z', sequence = 0) {
  return { event_id: randomUUID(), device_id: 'tub-01', boot_id: '20000000-0000-4000-8000-000000000001', sequence, source: 'mock', captured_at: time, measured_at: time, time_basis: 'device_clock', temperature_c: 20,
    readings: [{ sensor_id: 'a', status: 'ok', distance_mm: 400 - depth }, { sensor_id: 'b', status: 'ok', distance_mm: 420 - depth }] };
}
function input(value) { const { measured_at, time_basis, received_at, ...raw } = value; return raw; }
async function fixture(t, overrides = {}, suppliedStore) {
  const app = createApp(config(overrides), suppliedStore);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (path, method = 'GET', payload, extraHeaders = {}) => {
    const response = await fetch(url + path, { method, headers: { 'Content-Type': 'application/json', ...extraHeaders }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    const data = await response.json(); return { status: response.status, data, response };
  };
  return { app, api, url };
}
async function setup(api) {
  assert.equal((await api('/api/v1/devices', 'POST', { device_id: 'tub-01', name: 'Test tub' })).status, 201);
  const { id, ...values } = cal;
  assert.equal((await api('/api/v1/devices/tub-01/calibrations', 'POST', values)).status, 201);
}

test('ingestion, immutable calibration history and idempotent retries', async t => {
  const { api } = await fixture(t); await setup(api);
  const payload = input(frame());
  const first = await api('/api/v1/readings', 'POST', payload);
  assert.equal(first.status, 201); assert.equal(first.data.reading.levels[0].depth_mm, 100);
  assert.equal(first.data.reading.request_hash, undefined);
  const retry = await api('/api/v1/readings', 'POST', payload);
  assert.equal(retry.status, 200); assert.equal(retry.data.duplicate, true);
  const changed = structuredClone(payload); changed.readings[0].distance_mm = 310;
  assert.equal((await api('/api/v1/readings', 'POST', changed)).status, 409);
  assert.equal((await api('/api/v1/readings', 'POST', { ...payload, event_id: randomUUID() })).status, 409);
  await api('/api/v1/devices/tub-01/calibrations', 'POST', { empty_distance_mm: { a: 450, b: 450 } });
  const rows = await api('/api/v1/devices/tub-01/readings?source=mock');
  assert.equal(rows.data.readings.length, 1); assert.equal(rows.data.readings[0].levels[0].depth_mm, 100);
  const latest = await api('/api/v1/devices/tub-01?source=mock');
  assert.equal(latest.data.latest.levels[0].depth_mm, 100);
});
test('simultaneous identical retries insert exactly one record', async t => {
  const { api } = await fixture(t); await setup(api);
  const payload = input(frame());
  const requests = await Promise.all(Array.from({ length: 15 }, () => api('/api/v1/readings', 'POST', payload)));
  assert.equal(requests.filter(r => r.status === 201).length, 1);
  assert.equal(requests.filter(r => r.status === 200).length, 14);
});
test('validates modes, units, unique sensors, bounds and timestamps', async t => {
  const { api } = await fixture(t); await setup(api);
  const good = input(frame());
  const invalid = [
    { ...good, source: 'guess' }, { ...good, sequence: -1 }, { ...good, temperature_c: '20' },
    { ...good, captured_at: '2026-10-22T00:00:00' },
    { ...good, captured_at: new Date(Date.now() + 600000).toISOString() },
    { ...good, readings: [good.readings[0], good.readings[0]] },
    { ...good, readings: [{ sensor_id: 'a', status: 'ok', distance_mm: 0 }, good.readings[1]] },
    { ...good, readings: [{ sensor_id: 'a', status: 'timeout', distance_mm: 0 }, good.readings[1]] },
    { ...good, readings: [{ sensor_id: 'a', status: 'ok', distance_mm: 300, echo_us: 1747 }, good.readings[1]] },
    { ...good, sensor_count: 4 },
  ];
  for (const payload of invalid) assert.equal((await api('/api/v1/readings', 'POST', payload)).status, 422);
  const noEcho = { ...good, readings: [{ sensor_id: 'a', status: 'timeout' }, { sensor_id: 'b', status: 'out_of_range' }] };
  const result = await api('/api/v1/readings', 'POST', noEcho);
  assert.equal(result.status, 201); assert.equal(result.data.reading.levels[0].depth_mm, null);
});
test('raw echo conversion and server-clock fallback', async t => {
  const { api } = await fixture(t); await setup(api);
  const payload = input(frame()); payload.captured_at = null;
  payload.readings[0] = { sensor_id: 'a', status: 'ok', echo_us: 1747 };
  const result = await api('/api/v1/readings', 'POST', payload);
  assert.equal(result.status, 201); assert.equal(result.data.reading.time_basis, 'server_received');
  assert.ok(Math.abs(result.data.reading.levels[0].distance_mm - 300) < 1);
  assert.equal(result.data.reading.measured_at, result.data.reading.received_at);
  assert.throws(() => validateFrame({ ...payload, readings: [{ sensor_id: 'a', status: 'ok', echo_us: 1 }, payload.readings[1]] }));
  assert.ok(Math.abs(distances({ ...payload, temperature_c: 30 })[0].distance_mm - 305.27) < 1);
});
test('auth, cross-origin preflight, malformed JSON and body size', async t => {
  const { api, url } = await fixture(t, { apiKey: 'test-key', origins: ['http://localhost:5173'] });
  assert.equal((await api('/api/v1/devices')).status, 401);
  assert.equal((await api('/api/v1/devices', 'GET', undefined, { Authorization: 'Bearer test-key' })).status, 200);
  const preflight = await fetch(url + '/api/v1/readings', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.equal((await fetch(url + '/api/v1/readings', { method: 'OPTIONS', headers: { Origin: 'https://untrusted.example' } })).status, 403);
  const malformed = await fetch(url + '/api/v1/readings', { method: 'POST', headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  const huge = await api('/api/v1/readings', 'POST', { x: 'a'.repeat(17000) }, { Authorization: 'Bearer test-key' });
  assert.equal(huge.status, 413);
  assert.equal((await fetch(url + '/api/v1/readings', { method: 'POST', headers: { Authorization: 'Bearer test-key', 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
});
test('mock and hardware data stay separated; unknown device is not registered silently', async t => {
  const { api } = await fixture(t); await setup(api);
  assert.equal((await api('/api/v1/readings', 'POST', { ...input(frame()), device_id: 'typo' })).status, 404);
  await api('/api/v1/readings', 'POST', input(frame()));
  assert.equal((await api('/api/v1/devices/tub-01/readings')).data.readings.length, 0);
  assert.equal((await api('/api/v1/devices/tub-01?source=hardware')).data.latest, null);
  assert.equal((await api('/api/v1/devices/tub-01/readings?limit=501')).status, 422);
});
test('sessions require calibration, reject overlap and survive restarts with frozen reports', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'drain-test-'));
  const path = join(directory, 'test.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = new SQLiteStore(path);
  await store.insert('devices', { device_id: 'tub-01', name: 'Tub', created_at: new Date().toISOString() });
  await store.close();
  store = new SQLiteStore(path);
  const { api } = await fixture(t, {}, store);
  assert.equal((await api('/api/v1/devices')).data.devices.length, 1);
  assert.equal((await api('/api/v1/devices/tub-01/sessions', 'POST', { source: 'mock' })).status, 409);
  await api('/api/v1/devices/tub-01/calibrations', 'POST', { empty_distance_mm: { a: 400, b: 420 } });
  const started = await api('/api/v1/devices/tub-01/sessions', 'POST', { source: 'mock' });
  assert.equal(started.status, 201);
  assert.equal((await api('/api/v1/devices/tub-01/sessions', 'POST', { source: 'mock' })).status, 409);
  const finished = await api(`/api/v1/sessions/${started.data.id}/finish`, 'POST');
  assert.equal(finished.data.analysis.outcome, 'inconclusive');
  assert.deepEqual((await api(`/api/v1/sessions/${started.data.id}/finish`, 'POST')).data, finished.data);
});
test('session analysis is independent of ingestion order and detects actual elapsed time', () => {
  const frames = [frame(100, '2026-10-22T00:00:01Z', 0), frame(2, '2026-10-22T00:00:03Z', 1), frame(1, '2026-10-22T00:00:04Z', 2), frame(0, '2026-10-22T00:00:05Z', 3)];
  const result = analyzeSession(session, frames.reverse(), cal);
  assert.equal(result.outcome, 'completed'); assert.equal(result.drain_duration_ms, 2000);
});
test('no echo, shallow runoff, sparse sampling and repeated timestamps cannot fake completion', () => {
  const wet = frame();
  const missing = [2,3,4].map(n => { const f = frame(0, `2026-10-22T00:00:0${n}Z`, n); f.readings[1] = { sensor_id: 'b', status: 'timeout' }; return f; });
  assert.equal(analyzeSession(session, [wet, ...missing], cal).outcome, 'incomplete');
  assert.equal(analyzeSession(session, [frame(4), frame(0)], cal).outcome, 'inconclusive');
  const gaps = [wet, frame(0, '2026-10-22T00:00:20Z'), frame(0, '2026-10-22T00:00:21Z'), frame(0, '2026-10-22T00:00:22Z')];
  assert.equal(analyzeSession(session, gaps, cal).outcome, 'inconclusive');
  const repeated = [wet, frame(0, '2026-10-22T00:00:02Z', 1), frame(0, '2026-10-22T00:00:02Z', 2), frame(0, '2026-10-22T00:00:02Z', 3)];
  assert.equal(analyzeSession(session, repeated, cal).outcome, 'incomplete');
});
test('one dry end, invalid baseline echo, and another source do not satisfy both-sensor completion', () => {
  const f = frame(0); f.readings[0].distance_mm = 300;
  assert.equal(analyzeSession(session, [f], cal).outcome, 'inconclusive');
  const beyond = frame(-30, '2026-10-22T00:00:02Z');
  assert.equal(analyzeSession(session, [frame(), beyond], cal).invalid_frames, 1);
  assert.equal(analyzeSession(session, [{ ...frame(), source: 'hardware' }], cal).outcome, 'inconclusive');
});
test('SSE delivers new readings; disconnected clients are cleaned up', async t => {
  const { api, url } = await fixture(t); await setup(api);
  const controller = new AbortController();
  const response = await fetch(url + '/api/v1/devices/tub-01/stream', { signal: controller.signal });
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: connected/);
  await api('/api/v1/readings', 'POST', input(frame()));
  let event = '';
  while (!event.includes('event: reading')) event += new TextDecoder().decode((await reader.read()).value);
  assert.match(event, /event: reading/); assert.match(event, /"depth_mm":100/);
  controller.abort(); await reader.cancel().catch(() => {});
});
test('Supabase adapter sends server key only in apikey, paginates row caps and redacts errors', async () => {
  let calls = 0;
  const store = new SupabaseStore('https://example.supabase.co', 'sb_secret_test', async (url, options) => {
    assert.equal(options.headers.apikey, 'sb_secret_test'); assert.equal(options.headers.Authorization, undefined);
    const offset = Number(new URL(url).searchParams.get('offset') || 0); calls++;
    return new Response(JSON.stringify([{ payload: { id: offset } }]), { headers: { 'content-range': `${offset}-${offset}/3` } });
  });
  assert.deepEqual(await store.list('devices', {}, 3), [{ id: 0 }, { id: 1 }, { id: 2 }]); assert.equal(calls, 3);
  const unavailable = new SupabaseStore('https://example.supabase.co', 'sb_secret_should_not_leak', async () => new Response('private upstream error sb_secret_should_not_leak', { status: 403 }));
  await assert.rejects(() => unavailable.ready(), error => error.status === 503 && !error.message.includes('sb_secret'));
});
test('production requires authentication and explicit browser origins', () => {
  assert.throws(() => configFromEnv({ NODE_ENV: 'production' }));
  assert.throws(() => configFromEnv({ NODE_ENV: 'production', API_KEY: 'x'.repeat(32), CORS_ORIGINS: '*' }));
  assert.throws(() => configFromEnv({ STORAGE_BACKEND: 'invalid' }));
});
test('mixed clock bases cannot produce a precise drainage duration', () => {
  const frames = [frame(100), ...[2,3,4].map(n => ({ ...frame(0, `2026-10-22T00:00:0${n}Z`, n), time_basis: 'server_received' }))];
  const result = analyzeSession(session, frames, cal);
  assert.equal(result.outcome, 'inconclusive'); assert.equal(result.drain_duration_ms, null);
});
test('console, guide and OpenAPI are served without server configuration', async t => {
  const { url } = await fixture(t, { apiKey: 'private-backend-token', supabaseKey: 'sb_secret_do_not_expose' });
  for (const path of ['/', '/app.js', '/styles.css', '/docs', '/openapi.json']) {
    const response = await fetch(url + path); assert.equal(response.status, 200);
    const content = await response.text();
    assert.ok(!content.includes('private-backend-token')); assert.ok(!content.includes('sb_secret_do_not_expose'));
    if (path === '/openapi.json') {
      const document = JSON.parse(content); assert.equal(document.openapi, '3.1.0');
      assert.ok(document.paths['/api/v1/readings'].post.requestBody.required);
    }
  }
});
test('starting a second backend reports an occupied port without an unhandled crash', async t => {
  const { app } = await fixture(t);
  await assert.rejects(() => promisify(execFile)(process.execPath, ['src/server.js'], {
    cwd: new URL('../', import.meta.url), timeout: 5000,
    env: { ...process.env, NODE_ENV: 'test', STORAGE_BACKEND: 'sqlite', SQLITE_PATH: ':memory:', HOST: '127.0.0.1', PORT: String(app.server.address().port) },
  }), error => error.code === 1 && error.stderr.includes('already in use') && !error.stderr.includes('Unhandled'));
});

function emptyFrames() {
  return Array.from({ length: 5 }, (_, i) => ({ ...frame(0, `2026-10-22T00:00:0${i + 1}Z`, i), received_at: `2026-10-22T00:00:0${i + 1}Z` })).reverse();
}
test('automatic baseline rejects noise, invalid echoes, gaps, reboots, clocks and repeated samples', () => {
  const frames = emptyFrames();
  assert.deepEqual(emptyFixtureBaseline(frames), { a: 400, b: 420 });
  assert.equal(emptyFixtureBaseline(frames.slice(0, 4)), null);
  for (const mutate of [
    f => { f[2].readings[0].status = 'timeout'; },
    f => { f[2].readings[1].distance_mm = 430; },
    f => { f[2].boot_id = randomUUID(); },
    f => { f[2].source = 'hardware'; },
    f => { f[2].time_basis = 'server_received'; },
    f => { f[2].sequence = 20; },
    f => { f[2].measured_at = f[1].measured_at; },
    f => { f[0].measured_at = '2026-10-22T00:00:30Z'; },
  ]) {
    const changed = structuredClone(frames); mutate(changed);
    assert.equal(emptyFixtureBaseline(changed), null);
  }
  const fast = frames.map(f => ({ ...f, measured_at: new Date(Date.parse('2026-10-22T00:00:00Z') + f.sequence * 10).toISOString() }));
  assert.equal(emptyFixtureBaseline(fast), null);
});
test('automatic calibration uses persisted empty samples, survives app restart, and isolates sources', async t => {
  const { api, app } = await fixture(t);
  await api('/api/v1/devices', 'POST', { device_id: 'tub-01', name: 'Auto tub' });
  const frames = emptyFrames().reverse();
  for (const f of frames) assert.equal((await api('/api/v1/readings', 'POST', input(f))).data.reading.calibration_id, null);
  const next = input(frame(10, '2026-10-22T00:00:06Z', 5));
  const accepted = await api('/api/v1/readings', 'POST', next);
  assert.equal(accepted.status, 201);
  assert.equal(accepted.data.reading.levels[0].depth_mm, 10);
  const baseline = (await api('/api/v1/devices/tub-01?source=mock')).data.calibration;
  assert.equal(baseline.method, 'automatic_empty_fixture');
  assert.equal(baseline.sample_event_ids.length, 5);
  assert.deepEqual(baseline.empty_distance_mm, { a: 400, b: 420 });
  assert.equal((await api('/api/v1/devices/tub-01?source=hardware')).data.calibration, null);
  assert.equal((await api('/api/v1/devices/tub-01/sessions', 'POST', { source: 'hardware' })).status, 409);
  const duplicate = await api('/api/v1/readings', 'POST', next);
  assert.deepEqual(duplicate.data.reading, accepted.data.reading);
  assert.equal((await app.store.list('calibrations', { device_id: 'tub-01' })).length, 1);
  // A new app has no in-memory calibration state to restore.
  const restarted = createApp(config(), app.store);
  await new Promise(resolve => restarted.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => restarted.server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${restarted.server.address().port}/api/v1/devices/tub-01?source=mock`);
  assert.equal((await response.json()).calibration.id, baseline.id);
});
test('automatic calibration can be disabled and never replaces an existing manual calibration', async t => {
  const { api, app } = await fixture(t, { autoCalibrate: false });
  await api('/api/v1/devices', 'POST', { device_id: 'tub-01', name: 'Manual tub' });
  for (const f of emptyFrames().reverse()) await api('/api/v1/readings', 'POST', input(f));
  const next = input(frame(0, '2026-10-22T00:00:06Z', 5));
  assert.equal((await api('/api/v1/readings', 'POST', next)).data.reading.calibration_id, null);
  assert.equal((await app.store.list('calibrations')).length, 0);
  await api('/api/v1/devices/tub-01/calibrations', 'POST', { empty_distance_mm: { a: 440, b: 460 } });
  const reading = await api('/api/v1/readings', 'POST', input(frame(0, '2026-10-22T00:00:07Z', 6)));
  assert.equal(reading.data.reading.levels[0].depth_mm, 40);
});

test('guided calibration writes source-specific baselines without changing legacy requests', async t => {
  const { api } = await fixture(t, { autoCalibrate: false });
  await api('/api/v1/devices', 'POST', { device_id: 'tub-01', name: 'Guided calibration' });
  const saved = await api('/api/v1/devices/tub-01/calibrations', 'POST', { source: 'mock', empty_distance_mm: { a: 400, b: 420 } });
  assert.equal(saved.status, 201);
  assert.equal((await api('/api/v1/devices/tub-01?source=mock')).data.calibration.source, 'mock');
  assert.equal((await api('/api/v1/devices/tub-01?source=hardware')).data.calibration, null);
  assert.equal((await api('/api/v1/devices/tub-01/calibrations', 'POST', { source: 'wrong', empty_distance_mm: { a: 400, b: 420 } })).status, 422);
});
