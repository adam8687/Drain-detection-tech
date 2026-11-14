// Explicit opt-in smoke test: leaves ONE finished, labeled simulation recording.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../backend/src/server.js';
import { configFromEnv } from '../../backend/src/config.js';
import { Outbox, measurementFromReply, uploadNext } from './bridge.js';

let app, queue, recordId, base;
const token = randomUUID();
async function api(path, body) {
  const res = await fetch(`${base}/api/v1${path}`, { method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  const value = await res.json();
  if (!res.ok) throw Error(`${res.status}: ${value.error?.message || 'Cloud verification failed'}`);
  return value;
}
try {
  const config = configFromEnv({ ...process.env, STORAGE_BACKEND: 'supabase' });
  app = createApp({ ...config, apiKey: token });
  await app.store.ready();
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${app.server.address().port}`;
  const fixture = `usb-pipeline-check-${randomUUID().slice(0, 8)}`;
  const record = await api('/records', { fixture_id: fixture, record_type: 'monitoring', data_source: 'simulation' });
  recordId = record.record_id;
  queue = new Outbox(':memory:');
  const request = { reading_id: randomUUID(), timestamp: new Date().toISOString() };
  const point = measurementFromReply(JSON.stringify({ reading_id: request.reading_id,
    sensor: { distance_mm: 313, status: 'ok' } }), request);
  queue.enqueue(recordId, point);
  let saved = await uploadNext(queue, { base, token });
  assert.equal(saved.duplicate, false);
  // A separate outbox models a lost acknowledgement/replayed upload.
  queue.close(); queue = new Outbox(':memory:'); queue.enqueue(recordId, point);
  saved = await uploadNext(queue, { base, token }); assert.equal(saved.duplicate, true);
  const stored = await api(`/records/${recordId}`);
  assert.deepEqual(stored.record.measurements, [point]);
  assert.equal(stored.record.data_source, 'simulation');
  await api(`/records/${recordId}/finish`, {});
  console.log(`PASS: exact measurement persisted in Supabase; retry stored no duplicate. Finished simulation record ${recordId} (${fixture}).`);
} catch (error) {
  console.error(error.message);
  if (recordId && base) await api(`/records/${recordId}/finish`, {}).catch(() => {});
  process.exitCode = 1;
} finally {
  queue?.close();
  if (app) await app.close().catch(() => {});
}
