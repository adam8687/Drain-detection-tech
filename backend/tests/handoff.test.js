import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server.js';
import { configFromEnv } from '../src/config.js';
import { DrainApi, DrainApiError } from '../../web/lib/api.ts';
import { POST } from '../../web/app/api/events/route.ts';

test('frontend client preserves the browser global receiver when invoking fetch', async () => {
  let calls = 0;
  const browserFetch = function (url, options) {
    if (this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    calls++;
    assert.equal(url, 'http://localhost:8000/api/v1/devices');
    assert.equal(options.method, 'GET');
    return Promise.resolve(Response.json({ devices: [] }));
  };
  const api = new DrainApi('http://localhost:8000', '', browserFetch);
  assert.deepEqual(await api.devices(), { devices: [] });
  assert.equal(calls, 1);
});

test('design-team TypeScript client and existing Next ingest proxy use the real API contract', async t => {
  const app = createApp({ ...configFromEnv({ STORAGE_BACKEND: 'sqlite', SQLITE_PATH: ':memory:' }), apiKey: 'team-test-token' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const previous = process.env.BACKEND_URL; process.env.BACKEND_URL = base;
  t.after(async () => { if (previous === undefined) delete process.env.BACKEND_URL; else process.env.BACKEND_URL = previous; await app.close(); });
  const api = new DrainApi(base, 'team-test-token');
  await assert.rejects(() => new DrainApi(base).devices(), error => error instanceof DrainApiError && error.status === 401);
  await api.register('handoff-tub', 'Frontend handoff');
  await api.calibrate('handoff-tub', { empty_distance_mm: { a: 400, b: 420 } });
  const frame = { device_id: 'handoff-tub', event_id: randomUUID(), boot_id: randomUUID(), sequence: 0, source: 'mock', readings: [{ sensor_id: 'a', status: 'ok', distance_mm: 300 }, { sensor_id: 'b', status: 'ok', distance_mm: 320 }] };
  const request = token => new Request('http://frontend/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(frame) });
  assert.equal((await POST(request())).status, 401);
  const ingested = await POST(request('team-test-token')); assert.equal(ingested.status, 201);
  assert.equal((await ingested.json()).reading.levels[0].depth_mm, 100);
  assert.equal((await api.ingest(frame)).duplicate, true);
  assert.equal((await api.history('handoff-tub', 'mock')).readings.length, 1);
  assert.equal((await api.device('handoff-tub', 'mock')).latest.source, 'mock');
  const session = await api.startTest('handoff-tub', 'mock');
  assert.equal((await api.finishTest(session.id)).analysis.outcome, 'inconclusive');
  const oversized = new Request('http://frontend/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(17000) });
  assert.equal((await POST(oversized)).status, 413);
});
