import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { configFromEnv } from '../src/config.js';
import { SupabaseRecordStore } from '../src/records-storage.js';
import { distances } from '../src/domain.js';
import { validateMeasurement } from '../src/records-domain.js';

const stableId = label => { const h = createHash('sha256').update(`legacy-records-v1:${label}`).digest('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`; };
const source = value => value === 'mock' ? 'simulation' : 'sensor';
const snapshot = calibration => calibration ? { sensor_a_empty_mm: calibration.empty_distance_mm.a, sensor_b_empty_mm: calibration.empty_distance_mm.b } : null;
export function convertLegacy({ devices, calibrations = [], readings, sessions }) {
  const byId = new Map();
  const addCalibration = cal => { const existing = byId.get(cal.id); if (existing && !isDeepStrictEqual(existing, cal)) throw Error('Conflicting legacy calibration versions; refusing to choose one'); byId.set(cal.id, cal); };
  calibrations.forEach(addCalibration);
  for (const fixture of devices) {
    for (const cal of Object.values(fixture.calibration_history || {})) addCalibration(cal);
    for (const cal of Object.values(fixture.calibration || {})) if (cal?.id) addCalibration(cal);
  }
  const point = frame => validateMeasurement({ reading_id: frame.event_id, timestamp: frame.measured_at, ...Object.fromEntries(distances(frame).map(r => [`sensor_${r.sensor_id}`, { status: r.status, distance_mm: r.distance_mm }])) });
  const result = [], assigned = new Set();
  for (const cal of byId.values()) {
    for (const data_source of cal.source ? [source(cal.source)] : ['sensor','simulation']) {
      result.push({ record_id: stableId(`cal:${cal.device_id}:${cal.id}:${data_source}`), fixture_id: cal.device_id, record_type: 'calibration', data_source, recording_status: 'finished', calibration: snapshot(cal), measurements: [], result: null, created_at: cal.created_at });
    }
  }
  for (const session of [...sessions].sort((a, b) => a.started_at.localeCompare(b.started_at))) {
    const frames = readings.filter(f => !assigned.has(f.event_id) && f.device_id === session.device_id && f.source === session.source && Date.parse(f.measured_at) >= Date.parse(session.started_at) && (!session.finished_at || Date.parse(f.measured_at) <= Date.parse(session.finished_at))).sort((a, b) => a.measured_at.localeCompare(b.measured_at));
    if (frames.length > 5000) throw Error('A legacy session exceeds 5000 points; export and split it before migration');
    frames.forEach(f => assigned.add(f.event_id));
    const cal = byId.get(session.calibration_id);
    if (session.calibration_id && !cal) throw Error('Legacy calibration is missing; refusing to lose interpretation');
    const finished = session.status === 'finished';
    const analysis = session.analysis;
    if (analysis?.outcome === 'completed' && (typeof analysis.drain_duration_ms !== 'number' || !Number.isFinite(analysis.drain_duration_ms) || analysis.drain_duration_ms < 0)) throw Error('Invalid legacy completed duration');
    const outcome = analysis?.outcome === 'completed' ? 'completed' : analysis?.outcome === 'incomplete' ? 'incomplete' : 'uncertain';
    result.push({ record_id: session.id, fixture_id: session.device_id, record_type: 'drainage', data_source: source(session.source), recording_status: finished ? 'finished' : 'recording', calibration: snapshot(cal), measurements: frames.map(point), result: finished ? { drainage_time_seconds: outcome === 'completed' ? analysis.drain_duration_ms / 1000 : null, outcome } : null, created_at: session.started_at });
  }
  const buckets = new Map();
  for (const frame of readings) if (!assigned.has(frame.event_id)) {
    const key = `${frame.device_id}:${frame.source}:${frame.calibration_id || 'none'}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(frame);
  }
  for (const [key, values] of buckets) {
    const frames = values.sort((a, b) => a.measured_at.localeCompare(b.measured_at));
    for (let offset = 0; offset < frames.length; offset += 5000) {
      const chunk = frames.slice(offset, offset + 5000), first = chunk[0], cal = byId.get(first.calibration_id);
      if (first.calibration_id && !cal) throw Error('Missing calibration for monitoring readings');
      result.push({ record_id: stableId(`monitor:${key}:${offset}`), fixture_id: first.device_id, record_type: 'monitoring', data_source: source(first.source), recording_status: 'finished', calibration: snapshot(cal), measurements: chunk.map(point), result: null, created_at: first.measured_at });
    }
  }
  for (const fixture of devices) if (!result.some(r => r.fixture_id === fixture.device_id)) result.push({ record_id: stableId(`empty:${fixture.device_id}`), fixture_id: fixture.device_id, record_type: 'monitoring', data_source: 'sensor', recording_status: 'finished', calibration: null, measurements: [], result: null, created_at: fixture.created_at });
  return result;
}
export async function migrateRecords(store, legacy) {
  const records = convertLegacy(legacy);
  for (const record of records) {
    const previous = await store.get(record.record_id);
    if (previous) { if (!isDeepStrictEqual(previous, record)) throw Error('Existing destination differs; no overwrite is allowed'); }
    else await store.insert(record);
    if (!isDeepStrictEqual(await store.get(record.record_id), record)) throw Error('Destination verification failed');
  }
  return { records: records.length, measurements: records.reduce((n, r) => n + r.measurements.length, 0) };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let store;
  try {
    const config = configFromEnv({ ...process.env, STORAGE_BACKEND: 'supabase' }); store = new SupabaseRecordStore(config.supabaseUrl, config.supabaseKey); await store.ready();
    const legacy = {};
    for (const table of ['devices','calibrations','readings','sessions']) {
      const payloads = [];
      for (let offset = 0; ; offset = payloads.length) {
        const { rows, total } = await store.request(`dm_${table}?select=payload&offset=${offset}&limit=200&order=${table === 'devices' ? 'device_id' : table === 'readings' ? 'event_id' : 'id'}.asc`, { headers: { Prefer: 'return=representation,count=exact' } }, true, true);
        if (!rows.length && payloads.length < total) throw Error('Incomplete legacy export');
        payloads.push(...rows.map(row => row.payload)); if (payloads.length >= total || !rows.length) break;
      }
      legacy[table] = payloads;
    }
    const result = await migrateRecords(store, legacy);
    console.log(`PASS: copied and verified ${result.records} records containing ${result.measurements} measurements. All legacy tables remain untouched. Stop old writers before migration; reruns never overwrite destination records.`);
    console.log('Legacy custom thresholds are replaced by fixed backend defaults for new analysis; saved completed durations are retained unchanged.');
  } catch (error) { console.error(error.status === 503 ? error.message : `Migration stopped: ${error.message}. Legacy tables were not changed. Partial copies can be resumed after resolving the problem.`); process.exitCode = 1; }
  finally { if (store) await store.close(); }
}
