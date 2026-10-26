import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SQLiteStore } from '../src/storage.js';
import { createApp } from '../src/server.js';
import { configFromEnv } from '../src/config.js';

const ADMIN = 'admin-token-that-is-long-enough-for-tests';
const users = { 'alice-session': 'alice-id', 'bob-session': 'bob-id' };

async function start(t) {
  const store = new SQLiteStore(':memory:');
  const config = { ...configFromEnv({ STORAGE_BACKEND: 'sqlite', SQLITE_PATH: ':memory:' }), apiKey: ADMIN, autoCalibrate: false };
  const app = createApp(config, store, { verifyUser: async token => users[token] ?? null });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const api = async (path, token, body) => {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  api.store = store;
  return api;
}
const frame = deviceId => ({ event_id: randomUUID(), device_id: deviceId, boot_id: randomUUID(), sequence: 0, source: 'hardware',
  readings: [{ sensor_id: 'a', status: 'ok', distance_mm: 200 }, { sensor_id: 'b', status: 'ok', distance_mm: 210 }] });

test('users only see and change devices they own', async t => {
  const api = await start(t);
  assert.equal((await api('/devices')).status, 401);
  assert.equal((await api('/devices', 'stolen-session')).status, 401);
  assert.equal((await api('/devices', 'alice-session', { device_id: 'alice-tub', name: 'Alice tub' })).status, 201);
  assert.equal((await api('/devices', 'bob-session', { device_id: 'bob-sink', name: 'Bob sink' })).status, 201);
  assert.equal((await api('/devices', 'bob-session', { device_id: 'alice-tub', name: 'Takeover' })).status, 409);
  assert.deepEqual((await api('/devices', 'alice-session')).body.devices.map(d => d.device_id), ['alice-tub']);
  assert.equal((await api('/devices/bob-sink', 'alice-session')).status, 404);
  assert.equal((await api('/devices/bob-sink/keys', 'alice-session', {})).status, 404);
  assert.equal((await api('/devices', ADMIN)).body.devices.length, 2);
});

test('device keys only send readings for their own device', async t => {
  const api = await start(t);
  await api('/devices', 'alice-session', { device_id: 'alice-tub', name: 'Alice tub' });
  await api('/devices', ADMIN, { device_id: 'other-tub', name: 'Other tub' });
  const created = await api('/devices/alice-tub/keys', 'alice-session', {});
  assert.equal(created.status, 201);
  assert.match(created.body.key, /^dk_/);
  const key = created.body.key;
  assert.equal((await api('/readings', key, frame('alice-tub'))).status, 201);
  assert.equal((await api('/readings', key, frame('other-tub'))).status, 403);
  assert.equal((await api('/readings', 'alice-session', frame('alice-tub'))).status, 403);
  assert.equal((await api('/devices', key)).status, 403);
  assert.equal((await api('/devices/alice-tub', key)).status, 403);
  assert.equal((await api('/readings', 'dk_not-a-real-key', frame('alice-tub'))).status, 401);
  assert.equal((await api('/devices/alice-tub/readings?limit=5', 'alice-session')).body.readings.length, 1);
});

test('viewers can read but not change a device', async t => {
  const api = await start(t);
  await api('/devices', 'alice-session', { device_id: 'shared-tub', name: 'Shared tub' });
  await api.store.insert('device_members', { id: randomUUID(), device_id: 'shared-tub', user_id: 'bob-id', role: 'viewer', created_at: new Date().toISOString() });
  assert.equal((await api('/devices/shared-tub', 'bob-session')).status, 200);
  assert.equal((await api('/devices/shared-tub/keys', 'bob-session', {})).status, 403);
  assert.equal((await api('/devices/shared-tub/calibrations', 'bob-session', { empty_distance_mm: { a: 200, b: 210 } })).status, 403);
});
