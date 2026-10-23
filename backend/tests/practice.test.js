import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStore } from '../src/storage.js';
import { seedPracticeData, PRACTICE_DEVICE, PRACTICE_DURATIONS } from '../scripts/seed-practice.js';
import { createApp } from '../src/server.js';
import { configFromEnv } from '../src/config.js';
import { GET } from '../../web/app/api/backend/[...path]/route.ts';

test('practice seed persists complete mock sessions and resumes without duplicate records', async t => {
  const store = new SQLiteStore(':memory:');
  t.after(() => store.close());
  const first = await seedPracticeData(store);
  assert.deepEqual(first, { device_id: PRACTICE_DEVICE, readings: 280, tests: 6 });
  assert.deepEqual(await seedPracticeData(store, Date.now() + 10000), first);
  assert.equal((await store.list('devices')).length, 1);
  const sessions = (await store.list('sessions', { device_id: PRACTICE_DEVICE }, 30, 'started_at')).reverse();
  assert.deepEqual(sessions.map(session => session.analysis.drain_duration_ms / 1000), PRACTICE_DURATIONS);
  assert.ok(sessions.every(session => session.source === 'mock' && session.status === 'finished' && session.analysis.outcome === 'completed'));
  assert.equal((await store.list('readings', { device_id: PRACTICE_DEVICE, source: 'hardware' }, 500, 'measured_at')).length, 0);
});

test('same-origin practice read gateway forwards auth/query, reads stored frames and limits routes', async t => {
  const store = new SQLiteStore(':memory:');
  await seedPracticeData(store);
  const app = createApp({ ...configFromEnv({ STORAGE_BACKEND: 'sqlite', SQLITE_PATH: ':memory:' }), apiKey: 'practice-test-token' }, store);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.BACKEND_URL;
  process.env.BACKEND_URL = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { if (previous === undefined) delete process.env.BACKEND_URL; else process.env.BACKEND_URL = previous; await app.close(); });
  const context = { params: Promise.resolve({ path: ['api', 'v1', 'devices', PRACTICE_DEVICE, 'readings'] }) };
  const url = 'http://frontend/api/backend/api/v1/devices/practice/readings?source=mock&limit=500';
  assert.equal((await GET(new Request(url), context)).status, 401);
  const response = await GET(new Request(url, { headers: { Authorization: 'Bearer practice-test-token' } }), context);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const data = await response.json();
  assert.equal(data.readings.length, 280);
  assert.equal(data.readings[0].levels.length, 2);
  assert.equal(data.readings[0].request_hash, undefined);
  const hardware = await GET(new Request(url.replace('source=mock', 'source=hardware'), { headers: { Authorization: 'Bearer practice-test-token' } }), context);
  assert.equal((await hardware.json()).readings.length, 0);
  assert.equal((await GET(new Request(url), { params: Promise.resolve({ path: ['rest', 'v1', 'dm_devices'] }) })).status, 404);
});
