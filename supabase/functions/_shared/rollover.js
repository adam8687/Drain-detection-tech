import { randomUUID } from 'node:crypto';
import { SETTINGS, MAX_BATCH, monitoringEvents } from './records-domain.js';

// A board keeps posting to the recording ID baked into its secrets.h. A monitoring recording holds at most
// SETTINGS.maxMeasurements readings (about 42 minutes at 500 ms). When it is full, finish it and continue in a fresh
// recording for the same unit, so history spans several recordings and the board never has to be reflashed.
// Returns the ID the readings should be appended to (the posted ID when no rollover is needed).
export async function appendTarget({ store, row, mutate, incoming = 1, clock = Date.now }) {
  if (row.record_type !== 'monitoring') return row.record_id;
  // Roll over before a batch would overflow, and keep forwarding for a recording that rollover already finished.
  const overflow = row.measurements.length + incoming > SETTINGS.maxMeasurements;
  const rolledOver = row.recording_status === 'finished' && row.measurements.length > SETTINGS.maxMeasurements - MAX_BATCH;
  if (!overflow && !rolledOver) return row.record_id;
  if (row.recording_status === 'recording') await mutate(row.record_id, previous => previous.recording_status === 'finished' ? { record: previous } : { record: { ...previous, recording_status: 'finished' } });
  const find = store.headers?.bind(store) ?? store.list.bind(store);
  const filters = { fixture_id: row.fixture_id, data_source: row.data_source, recording_status: 'recording' };
  const active = (await find(filters, 1))[0];
  if (active) return active.record_type === 'monitoring' ? active.record_id : row.record_id;   // never mix into a calibration or drainage
  try {
    return (await store.insert({ record_id: randomUUID(), fixture_id: row.fixture_id, record_type: 'monitoring', data_source: row.data_source,
      recording_status: 'recording', calibration: row.calibration, measurements: [], result: null, created_at: new Date(clock()).toISOString() })).record_id;
  } catch (error) {
    if (error.status === 409) { const again = (await find(filters, 1))[0]; if (again?.record_type === 'monitoring') return again.record_id; }
    throw error;
  }
}

// One small summary per completed drain. Stable IDs let the same drain be saved any number of times safely.
export function completedEventRows(record) {
  if (!record.calibration || record.schema_version === 1) return [];
  const events = record.record_type === 'monitoring' ? monitoringEvents(record) : record.record_type === 'drainage' ? [record] : [];
  return events.filter(e => e.recording_status === 'finished' && e.result?.outcome === 'completed' && Number.isFinite(e.result.drainage_time_seconds) && e.result.drainage_time_seconds > 0 && e.result.drainage_time_seconds < 86400)
    .map(e => ({ event_id: e.record_id, fixture_id: record.fixture_id, data_source: record.data_source, record_id: record.record_id, started_at: e.created_at, seconds: e.result.drainage_time_seconds }));
}
const pendingHistory = new WeakMap();
export async function saveNewDrainEvents(store, before, after) {
  if (!store.saveDrainEvents || !after) return;
  let pending = pendingHistory.get(store);
  if (!pending) { pending = new Map(); pendingHistory.set(store, pending); }
  const known = new Set(before ? completedEventRows(before).map(r => r.event_id) : []);
  for (const event of completedEventRows(after)) if (!known.has(event.event_id)) pending.set(event.event_id,event);
  // Retry failed summaries on subsequent uploads, including duplicate uploads.
  // Bound worker memory during a prolonged database outage. The original raw
  // history is never deleted and the reconciliation tool repairs across restarts.
  while (pending.size > 2000) pending.delete(pending.keys().next().value);
  const batch = [...pending.values()].slice(0,200);
  if (batch.length) {
    try { await store.saveDrainEvents(batch); for (const event of batch) pending.delete(event.event_id); }
    catch { /* derived history must not prevent saving sensor evidence */ }
  }
}

// Explicit operator reconciliation for recordings that predate drain_events or
// whose derived summaries could not be saved. Re-running never duplicates events.
export async function reconcileDrainHistory(store, {fixture, source='sensor', apply=false} = {}) {
  if (!store.saveDrainEvents) throw new Error('Drain history summaries are not available on this storage backend');
  const filters = {data_source:source,...(fixture?{fixture_id:fixture}:{})};
  let recordings=0,events=0,offset=0;
  const list = store.headers?.bind(store) ?? store.list.bind(store);
  for (;;) {
    const page = await list(filters,25,'asc',offset);
    for (const header of page) {
      const record = header.measurements ? header : await store.get(header.record_id);
      if (!record) continue;
      const summaries = completedEventRows(record);
      recordings++;events+=summaries.length;
      if (apply) for (let i=0;i<summaries.length;i+=200) await store.saveDrainEvents(summaries.slice(i,i+200));
    }
    if (page.length<25) break;
    offset+=page.length;
  }
  return {recordings,events,applied:apply};
}

export const HISTORY_RANGES = Object.freeze({ '1d': 1, '1w': 7, '1m': 30, '3m': 90, '1y': 365, all: 0 });
export const HISTORY_POINTS = 160;
