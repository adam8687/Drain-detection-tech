import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { configFromEnv } from '../src/config.js';
import { createStore } from '../src/storage.js';
import { validateFrame, validateCalibration } from '../src/validation.js';
import { analyzeSession } from '../src/domain.js';

export const PRACTICE_DEVICE = 'graph-practice-sink-v1';
export const PRACTICE_DURATIONS = [39, 40, 38, 42, 48, 55];
const seedTag = 'supabase-graph-practice-v1';
function id(label) {
  const hash = createHash('sha256').update(`${seedTag}:${label}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

// Only this explicitly invoked script writes practice records. Page loads are read-only.
export async function seedPracticeData(store, now = Date.now(), progress = () => {}) {
  await store.ready();
  let device = await store.get('devices', PRACTICE_DEVICE);
  if (device && device.seed_tag !== seedTag) throw Error('Practice device ID is already in use; refusing to modify it.');
  if (!device) device = await store.insert('devices', { device_id: PRACTICE_DEVICE, name: 'Supabase practice sink — synthetic readings', created_at: new Date(now).toISOString(), seed_tag: seedTag, seed_started_at: new Date(now - 7 * 86400000).toISOString() });
  const calibration = { ...validateCalibration({ source: 'mock', empty_distance_mm: { a: 400, b: 420 } }), id: id('calibration'), device_id: PRACTICE_DEVICE, created_at: device.seed_started_at, seed_tag: seedTag };
  const existingCalibration = await store.get('calibrations', calibration.id);
  if (existingCalibration) assert.deepEqual(existingCalibration, calibration);
  else await store.insert('calibrations', calibration);
  const saved = new Map((await store.list('readings', { device_id: PRACTICE_DEVICE }, 500, 'measured_at')).map(frame => [frame.event_id, frame]));
  const expected = [];
  for (const [testIndex, seconds] of PRACTICE_DURATIONS.entries()) {
    const start = Date.parse(device.seed_started_at) + (testIndex + 1) * 86400000;
    const session = { id: id(`test-${testIndex}`), device_id: PRACTICE_DEVICE, source: 'mock', name: `Practice test ${testIndex + 1} — synthetic ${seconds}s drainage`, status: 'finished', started_at: new Date(start).toISOString(), finished_at: new Date(start + (seconds + 2) * 1000).toISOString(), calibration_id: calibration.id, seed_tag: seedTag };
    const records = Array.from({ length: seconds + 3 }, (_, sequence) => {
      const depth = sequence < seconds ? 8 + (seconds - sequence) * 92 / seconds : Math.max(0, 6 - (sequence - seconds) * 3);
      const input = validateFrame({ event_id: id(`test-${testIndex}-frame-${sequence}`), device_id: PRACTICE_DEVICE, boot_id: id(`boot-${testIndex}`), sequence, source: 'mock', captured_at: new Date(start + sequence * 1000).toISOString(), temperature_c: 20,
        readings: ['a', 'b'].map((sensor_id, index) => ({ sensor_id, status: 'ok', distance_mm: Math.round(((index ? 420 : 400) - depth + Math.sin(sequence * 0.8 + index) * 0.25) * 10) / 10 })) });
      const request_hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const old = saved.get(input.event_id);
      if (old) { assert.equal(old.request_hash, request_hash); assert.equal(old.calibration_id, calibration.id); return old; }
      return { ...input, received_at: new Date(now).toISOString(), measured_at: input.captured_at, time_basis: 'device_clock', calibration_id: calibration.id, request_hash, seed_tag: seedTag };
    });
    for (let offset = 0; offset < records.length; offset += 8) {
      await Promise.all(records.slice(offset, offset + 8).filter(frame => !saved.has(frame.event_id)).map(frame => store.insert('readings', frame)));
    }
    expected.push(...records);
    const analysis = analyzeSession(session, records, calibration);
    assert.equal(analysis.outcome, 'completed'); assert.equal(analysis.drain_duration_ms, seconds * 1000);
    const report = { ...session, analysis };
    const existingSession = await store.get('sessions', report.id);
    if (existingSession) assert.deepEqual(existingSession, report);
    else await store.insert('sessions', report);
    progress(`Saved practice test ${testIndex + 1}: ${seconds} seconds.`);
  }
  // Query again after persistence, rather than returning generated fixtures to the graph.
  const readback = await store.list('readings', { device_id: PRACTICE_DEVICE, source: 'mock' }, 500, 'measured_at');
  const sessions = await store.list('sessions', { device_id: PRACTICE_DEVICE, source: 'mock' }, 30, 'started_at');
  assert.equal(readback.length, expected.length);
  assert.equal(sessions.length, PRACTICE_DURATIONS.length);
  for (const frame of expected) assert.deepEqual(readback.find(row => row.event_id === frame.event_id), frame);
  return { device_id: PRACTICE_DEVICE, readings: readback.length, tests: sessions.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let store;
  try {
    const config = configFromEnv({ ...process.env, STORAGE_BACKEND: 'supabase' });
    store = createStore(config);
    const result = await seedPracticeData(store, Date.now(), console.log);
    // A separate adapter confirms that reads do not depend on seed-process state.
    const observer = createStore(config);
    try {
      const frames = await observer.list('readings', { device_id: result.device_id, source: 'mock' }, 500, 'measured_at');
      assert.equal(frames.length, result.readings);
    } finally { await observer.close(); }
    console.log(`PASS: Supabase readback verified ${result.readings} mock readings and ${result.tests} completed tests. Device: ${result.device_id}. Rerunning is safe and adds no duplicates.`);
  } catch (error) {
    console.error(error.status === 503 ? error.message : 'Practice seed failed. Check database access and existing practice records; partial mock records can be resumed by rerunning.');
    process.exitCode = 1;
  } finally { if (store) await store.close(); }
}
