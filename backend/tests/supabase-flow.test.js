import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server.js';
import { configFromEnv } from '../src/config.js';
import { SupabaseStore } from '../src/storage.js';

// A PostgREST protocol fixture, not the SQLite adapter. This exercises the actual
// Supabase HTTP adapter and API together without claiming a live cloud test.
function databaseFixture() {
  const rows = new Map(['devices', 'calibrations', 'readings', 'sessions'].map(t => [t, []]));
  let unavailable = false, rejectReadingWrite = false;
  const fetcher = async (url, options = {}) => {
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers.apikey, 'sb_secret_protocol_test');
    if (unavailable) throw Error('network unreachable');
    const query = new URL(url), table = query.pathname.split('/').at(-1).replace('dm_', '');
    let values = rows.get(table);
    const method = options.method || 'GET';
    if (method === 'POST') {
      if (table === 'readings' && rejectReadingWrite) return new Response('{}', { status: 503 });
      const inserted = JSON.parse(options.body); values.push(structuredClone(inserted)); return Response.json([inserted], { status: 201 });
    }
    const selected = values.filter(row => [...query.searchParams].every(([key, filter]) => {
      if (filter.startsWith('eq.')) return String(row[key]) === filter.slice(3);
      if (filter.startsWith('gte.')) return row[key] >= filter.slice(4);
      if (filter.startsWith('lte.')) return row[key] <= filter.slice(4);
      return true;
    }));
    if (method === 'PATCH') {
      const update = JSON.parse(options.body);
      selected.forEach(row => Object.assign(row, structuredClone(update)));
      return Response.json(selected);
    }
    const order = query.searchParams.get('order');
    if (order) selected.sort((a, b) => {
      for (const part of order.split(',')) {
        const [key, direction] = part.split('.');
        if (a[key] !== b[key]) return (String(a[key]) < String(b[key]) ? -1 : 1) * (direction === 'desc' ? -1 : 1);
      }
      return 0;
    });
    const offset = Number(query.searchParams.get('offset') || 0), limit = Number(query.searchParams.get('limit') || 100);
    const result = selected.slice(offset, offset + limit);
    return Response.json(result, { headers: { 'Content-Range': `${offset}-${Math.max(offset, offset + result.length - 1)}/${selected.length}` } });
  };
  return { rows, fetcher, setUnavailable: value => { unavailable = value; }, rejectWrites: value => { rejectReadingWrite = value; } };
}

test('Supabase is the default; missing cloud settings fail instead of falling back', () => {
  assert.throws(() => configFromEnv({}));
  const config = configFromEnv({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_protocol_test' });
  assert.equal(config.storage, 'supabase');
  assert.throws(() => configFromEnv({ NODE_ENV: 'production', STORAGE_BACKEND: 'sqlite', API_KEY: 'x'.repeat(32) }));
});

test('API persists through Supabase, sees other writers, and never acknowledges failed writes', async t => {
  const database = databaseFixture();
  const config = configFromEnv({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_protocol_test' });
  const store = new SupabaseStore(config.supabaseUrl, config.supabaseKey, database.fetcher);
  await store.ready();
  const app = createApp(config, store);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  async function api(path, method = 'GET', value) {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, ...(value ? { body: JSON.stringify(value) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  assert.equal((await api('/devices', 'POST', { device_id: 'cloud-tub', name: 'Cloud test' })).status, 201);
  await api('/devices/cloud-tub/calibrations', 'POST', { empty_distance_mm: { a: 400, b: 420 } });
  const event = { event_id: randomUUID(), device_id: 'cloud-tub', boot_id: randomUUID(), sequence: 0, source: 'mock', captured_at: null, readings: [{ sensor_id: 'a', status: 'ok', distance_mm: 300 }, { sensor_id: 'b', status: 'ok', distance_mm: 320 }] };
  const accepted = await api('/readings', 'POST', event);
  assert.equal(accepted.status, 201);
  assert.equal(database.rows.get('readings')[0].payload.event_id, event.event_id);
  const observer = new SupabaseStore(config.supabaseUrl, config.supabaseKey, database.fetcher);
  assert.equal((await observer.get('readings', event.event_id)).event_id, event.event_id);
  const newer = { ...await observer.get('readings', event.event_id), event_id: randomUUID(), sequence: 1, measured_at: new Date(Date.now() + 1).toISOString(), readings: [{ sensor_id: 'a', status: 'ok', distance_mm: 350 }, { sensor_id: 'b', status: 'ok', distance_mm: 370 }] };
  await observer.insert('readings', newer);
  const latest = await api('/devices/cloud-tub?source=mock');
  assert.equal(latest.data.latest.event_id, newer.event_id);
  assert.equal(latest.data.latest.levels[0].depth_mm, 50);
  assert.equal((await api('/devices/cloud-tub/readings?source=mock')).data.readings.length, 2);
  const started = await api('/devices/cloud-tub/sessions', 'POST', { source: 'mock' });
  assert.equal(started.status, 201);
  assert.equal((await api(`/sessions/${started.data.id}/finish`, 'POST')).status, 200);
  assert.equal((await observer.get('sessions', started.data.id)).status, 'finished');
  database.rejectWrites(true);
  const failed = await api('/readings', 'POST', { ...event, event_id: randomUUID(), sequence: 2 });
  assert.equal(failed.status, 503); assert.equal(database.rows.get('readings').length, 2);
  database.setUnavailable(true);
  const offline = await api('/devices/cloud-tub?source=mock');
  assert.equal(offline.status, 503); assert.equal(offline.data.latest, undefined);
});
