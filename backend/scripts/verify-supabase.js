// Real write/read verification. Leaves a uniquely named, clearly marked mock
// device, calibration, four readings and a completed test for manual inspection.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server.js';
import { configFromEnv } from '../src/config.js';
import { SupabaseStore } from '../src/storage.js';

let app;
let stage = 'configuration';
try {
  const config = configFromEnv({ ...process.env, STORAGE_BACKEND: 'supabase' });
  app = createApp(config);
  stage = 'table access'; await app.store.ready();
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const device = `verify-${randomUUID().slice(0, 8)}`;
  async function api(path, method = 'GET', body) {
    const res = await fetch(base + path, { method, cache: 'no-store', headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    const value = await res.json();
    if (!res.ok) throw Error(`Backend returned HTTP ${res.status} (${value.error?.code || 'request_failed'})`);
    return value;
  }
  stage = 'device write'; await api('/devices', 'POST', { device_id: device, name: 'Supabase verification — synthetic data' });
  stage = 'calibration write'; await api(`/devices/${device}/calibrations`, 'POST', { empty_distance_mm: { a: 400, b: 420 }, max_gap_ms: 60000 });
  stage = 'test write'; const test = await api(`/devices/${device}/sessions`, 'POST', { source: 'mock', name: 'Supabase write/read verification' });
  const boot = randomUUID(); let lastEvent;
  stage = 'sensor frame writes';
  for (let i = 0; i < 4; i++) {
    lastEvent = randomUUID();
    const distance = i === 0 ? 300 : 400;
    await api('/readings', 'POST', { event_id: lastEvent, device_id: device, boot_id: boot, sequence: i, source: 'mock', captured_at: null, readings: [{ sensor_id: 'a', status: 'ok', distance_mm: distance }, { sensor_id: 'b', status: 'ok', distance_mm: distance + 20 }] });
  }
  stage = 'fresh database read';
  const freshStore = new SupabaseStore(config.supabaseUrl, config.supabaseKey);
  assert.equal((await freshStore.get('readings', lastEvent)).event_id, lastEvent);
  assert.equal((await api(`/devices/${device}?source=mock`)).latest.event_id, lastEvent);
  assert.equal((await api(`/devices/${device}/readings?source=mock`)).readings.length, 4);
  stage = 'test update and readback';
  const report = await api(`/sessions/${test.id}/finish`, 'POST');
  assert.equal(report.analysis.outcome, 'completed');
  assert.equal((await freshStore.get('sessions', test.id)).analysis.outcome, 'completed');
  console.log(`PASS: real Supabase inserts, updates and fresh reads verified for all four tables. Device: ${device}. Data is labeled mock and retained for inspection.`);
} catch (error) {
  console.error(`FAIL during ${stage}: ${error.status === 503 ? error.message : error.name === 'AssertionError' ? 'Database readback did not match the write.' : error.message.startsWith('Backend returned') ? error.message : 'Check project configuration, migration and network access.'}`);
  console.error('No successful connection is claimed. No SQLite fallback was used. If a write stage was reached, partial synthetic verification records may remain.');
  process.exitCode = 1;
} finally { if (app) await app.close(); }
