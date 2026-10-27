import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { simulateMeasurements, SCENARIOS } from '../src/simulation.js';
const scenario = process.argv[2] || 'normal';
if (!SCENARIOS.includes(scenario)) throw Error(`Choose ${SCENARIOS.join(', ')}`);
const base = (process.env.API_BASE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const fixture = process.env.MOCK_FIXTURE_ID || 'live-simulation';
async function api(path, body) {
  const response = await fetch(`${base}/api/v1${path}`, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', ...(process.env.API_KEY ? { Authorization: `Bearer ${process.env.API_KEY}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  const value = await response.json(); if (!response.ok) throw Error(`${response.status}: ${value.error?.message || 'Request failed'}`); return value;
}
try {
  const type = scenario === 'empty' ? 'calibration' : 'drainage';
  const listed = await api(`/records?fixture_id=${encodeURIComponent(fixture)}&data_source=simulation&recording_status=recording`);
  const active = listed.records.find(record => record.record_type === type);
  let record = active || await api('/records', { fixture_id: fixture, data_source: 'simulation', record_type: type, ...(type === 'calibration' ? { confirm_empty: true } : {}) });
  const start = Date.now();
  const points = simulateMeasurements({ scenario, start, seed: Date.now() & 0xffffffff, makeId: () => randomUUID() });
  console.log(`Fixture ${fixture}, recording ${record.record_id}: ${scenario}. Select this fixture / Simulation on the website.`);
  for (const point of points) {
    await delay(Math.max(0, Date.parse(point.timestamp) - Date.now()));
    let saved;
    for (let attempt = 0; attempt < 3; attempt++) { try { saved = await api(`/records/${record.record_id}/measurements`, point); break; } catch (error) { if (attempt === 2) throw error; await delay(250 * (attempt + 1)); } }
    console.log(`${point.timestamp}: A ${point.sensor_a.distance_mm ?? point.sensor_a.status}, B ${point.sensor_b.distance_mm ?? point.sensor_b.status}`);
    if (saved.recording_status === 'finished') { console.log(JSON.stringify(saved.result || saved.calibration)); process.exitCode = 0; break; }
  }
  const finished = await api(`/records/${record.record_id}/finish`, {});
  console.log(JSON.stringify(finished.record.result || finished.record.calibration));
} catch (error) { console.error(error.message); console.error('For a new fixture, run npm run simulate -- empty first.'); process.exitCode = 1; }
