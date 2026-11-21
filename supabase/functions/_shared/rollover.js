import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { SETTINGS, MAX_BATCH, MONITORING_PREFIX, appendMeasurements, fail, monitoringCarry, monitoringEvents } from './records-domain.js';

const carryCache = new WeakMap();

// Previous windows are immutable once rolled over. Cache just the open drain
// and its boundary samples. Keep the prefix out of storage and API payloads.
export async function withMonitoringCarry(store, row) {
  if (!row.continued_from || !row.calibration || row[MONITORING_PREFIX]) return row;
  let cache = carryCache.get(store);
  if (!cache) { cache = new Map(); carryCache.set(store, cache); }
  let carry = cache.get(row.continued_from);
  if (!carry) {
    const previous = await store.get(row.continued_from);
    if (!previous || previous.continued_in !== row.record_id || previous.fixture_id !== row.fixture_id ||
        previous.data_source !== row.data_source ||
        previous.calibration?.empty_distance_mm !== row.calibration.empty_distance_mm) return row;
    carry = monitoringCarry(previous);
    if (previous.continued_from && !carry?.reset) {
      carry = monitoringCarry(await withMonitoringCarry(store,previous));
    }
    if (carry && carry.measurements.length <= SETTINGS.maxMeasurements) {
      cache.set(previous.record_id, carry);
      if (cache.size > 16) cache.delete(cache.keys().next().value);
    }
  }
  return carry ? {...row,[MONITORING_PREFIX]:carry} : row;
}

function withoutDuplicates(points, records) {
  const stored = new Map(records.flatMap(row => row.measurements.map(p => [p.reading_id,p])));
  return points.filter(point => {
    const prior = stored.get(point.reading_id);
    if (prior && !isDeepStrictEqual(prior,point)) fail('reading_id was reused with different measurements',409,'reading_conflict');
    return !prior;
  });
}

export async function appendRecordingBatch({store,row,points,mutate,allowRollover,clock=Date.now}) {
  const posted = row;
  const rollover = allowRollover && row.record_type === 'monitoring' && row.schema_version !== 1;
  for (let attempt=0;attempt<12;attempt++) {
    let target = attempt===0 ? posted : await store.get(posted.record_id);
    if (rollover && target.recording_status === 'finished' &&
        (target.continued_in || (!target.rollover_root && target.measurements.length > SETTINGS.maxMeasurements - MAX_BATCH))) {
      const find = store.headers?.bind(store) ?? store.list.bind(store);
      const [header] = await find({ fixture_id:posted.fixture_id,data_source:posted.data_source,recording_status:'recording' },1);
      if (header?.record_type === 'monitoring') {
        const active = await store.get(header.record_id);
        if (active?.rollover_root === (target.rollover_root ?? target.record_id) ||
            (active && !target.continued_in && !target.rollover_root && active.created_at>=target.created_at &&
             active.calibration?.empty_distance_mm === target.calibration?.empty_distance_mm)) target = active;
      }
    }
    let incoming = points;
    if (rollover) {
      const previous = [target];
      if (posted.record_id !== target.record_id) previous.push(posted);
      // Retries straddling the boundary can contain IDs from the prior window.
      // Only inspect sealed windows for points with older timestamps.
      let link = target.continued_from;
      let first = target.measurements[0]?.timestamp;
      while (link && (!first || points.some(p => p.timestamp <= first))) {
        const sealed = await store.get(link);
        if (!sealed) break;
        previous.push(sealed);
        if (first && sealed.measurements[0]?.timestamp >= first) break;
        first = sealed.measurements[0]?.timestamp;
        link = sealed.continued_from;
      }
      incoming = withoutDuplicates(points, previous);
      if (!incoming.length) {
        await saveNewDrainEvents(store,null,target);
        return {target:target.record_id,record:target,duplicate:true};
      }
      if (target.recording_status === 'recording' && target.measurements.length + incoming.length > SETTINGS.maxMeasurements) {
        const next = await store.rollMonitoringRecord(target.record_id,randomUUID(),incoming.length,new Date(clock()).toISOString());
        if (!next || next.recording_status !== 'recording') continue;
        target = next;
      }
    }
    let before;
    try {
      const result = await mutate(target.record_id, previous => {before=previous;return appendMeasurements(previous,incoming);});
      await saveNewDrainEvents(store,result.duplicate?null:before,result.record);
      return {...result,target:target.record_id};
    } catch (error) {
      if (rollover && (error.code === 'record_full' || error.code === 'record_finished')) {
        const latest = await store.get(target.record_id);
        if (error.code === 'record_full' || latest?.continued_in) continue;
      }
      throw error;
    }
  }
  fail('Recording is busy; retry with the same reading IDs',409,'concurrent_update');
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
  const known = new Set(before ? completedEventRows(await withMonitoringCarry(store,before)).map(r => r.event_id) : []);
  for (const event of completedEventRows(await withMonitoringCarry(store,after))) if (!known.has(event.event_id)) pending.set(event.event_id,event);
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
      const summaries = completedEventRows(await withMonitoringCarry(store,record));
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
