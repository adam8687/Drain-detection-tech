import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRecordStore } from '../src/records-storage.js';
import { configFromEnv } from '../src/config.js';
import { simulateMeasurements } from '../src/simulation.js';
import { analyzeDrainage, learnCalibration } from '../src/records-domain.js';

export const PRACTICE_FIXTURE = 'practice-sink-v2';
const stableId = label => { const h = createHash('sha256').update(`records-practice-v2:${label}`).digest('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`; };
export async function seedPracticeData(store, progress = () => {}) {
  await store.ready();
  // Stable historical times and IDs make retries independent of the day of rerun.
  const start = Date.parse('2026-10-20T12:00:00.000Z');
  const measurements = simulateMeasurements({ scenario: 'empty', start, makeId: i => stableId(`cal-${i}`) });
  const calibration = learnCalibration(measurements).calibration;
  if (!calibration) throw Error('Invalid calibration fixture');
  const records = [{ record_id: stableId('calibration'), fixture_id: PRACTICE_FIXTURE, record_type: 'calibration', data_source: 'simulation', recording_status: 'finished', calibration, measurements, result: null, created_at: new Date(start).toISOString() }];
  for (const [index, scenario] of ['normal','slow','pooling','timeout','gap','shallow'].entries()) {
    const time = start + (index + 1) * 86400000;
    const points = simulateMeasurements({ scenario, start: time, seed: 100 + index, makeId: i => stableId(`${scenario}-${i}`) });
    records.push({ record_id: stableId(scenario), fixture_id: PRACTICE_FIXTURE, record_type: 'drainage', data_source: 'simulation', recording_status: 'finished', calibration, measurements: points, result: analyzeDrainage(points, calibration).result, created_at: new Date(time).toISOString() });
  }
  for (const record of records) {
    const existing = await store.get(record.record_id);
    if (existing) { if (!isDeepStrictEqual(existing, record)) throw Error('Practice record conflict; refusing to overwrite'); }
    else await store.insert(record);
    if (!isDeepStrictEqual(await store.get(record.record_id), record)) throw Error('Readback mismatch');
    progress(`${record.record_type}: ${record.result?.outcome ?? 'calibrated'} (${record.measurements.length} measurements)`);
  }
  return { fixture_id: PRACTICE_FIXTURE, records: records.length, measurements: records.reduce((n, row) => n + row.measurements.length, 0) };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let store;
  try { store = createRecordStore(configFromEnv({ ...process.env, STORAGE_BACKEND: 'supabase' })); const result = await seedPracticeData(store, console.log); console.log(`PASS: saved and read back ${result.records} records and ${result.measurements} measurements for ${result.fixture_id}. No hardware data changed.`); }
  catch (error) { console.error(error.status === 503 ? error.message : 'Practice seed failed; no existing records were overwritten. Apply the new migration, then retry.'); process.exitCode = 1; }
  finally { if (store) await store.close(); }
}
