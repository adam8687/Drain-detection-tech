import { randomUUID } from 'node:crypto';
import { configFromEnv } from '../src/config.js';
import { createRecordStore } from '../src/records-storage.js';
import { createApp } from '../src/server.js';
import { simulateMeasurements } from '../src/simulation.js';
let app;
try {
  const config = configFromEnv({ ...process.env, STORAGE_BACKEND: 'supabase' });
  app = createApp(config); await app.store.ready();
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const fixture = `verify-${randomUUID().slice(0,8)}`, base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const call = async (path, body) => { const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); if (!response.ok) throw Error('API verification failed'); return response.json(); };
  for (const scenario of ['empty','normal']) {
    const row = await call('/records', { fixture_id: fixture, data_source: 'simulation', record_type: scenario === 'empty' ? 'calibration' : 'drainage', ...(scenario === 'empty' ? { confirm_empty: true } : {}) });
    let ack;
    for (const point of simulateMeasurements({ scenario, start: Date.now() - 120000 })) { ack = await call(`/records/${row.record_id}/measurements`, point); if (ack.recording_status === 'finished') break; }
    const observer = createRecordStore(config);
    try { const saved = await observer.get(row.record_id); if (saved.recording_status !== 'finished' || (scenario === 'normal' && saved.result?.outcome !== 'completed')) throw Error('Readback failed'); } finally { await observer.close(); }
  }
  console.log(`PASS: real API writes, append acknowledgements, backend results and separate-adapter reads verified. Fixture ${fixture}; labeled simulation records retained.`);
} catch (error) { console.error(error.status === 503 ? error.message : 'Live verification failed. Partial simulation records may remain; no successful connection is claimed.'); process.exitCode = 1; }
finally { if (app) await app.close(); }
