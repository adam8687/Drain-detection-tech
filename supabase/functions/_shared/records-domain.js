import {validateDrainageCalibration,drainageProfileOf,judgeDrainage} from './drainage-calibration.js';
import { isDeepStrictEqual } from 'node:util';
import { ApiError, object, number, uuid, timestamp, deviceId } from './validation.js';

export const SETTINGS = Object.freeze({ wet: 20, dry: 8, stable: 3, maxGap: 5000, maxMeasurements: 5000 });
export const fail = (message, status = 422, code = 'validation_error') => { throw new ApiError(status, code, message); };
export function calibrationSnapshot(value) {
  if (value === null) return null;
  object(value, ['empty_distance_mm','drainage']);
  return { empty_distance_mm: number(value.empty_distance_mm, 'empty_distance_mm', 20, 4500),...(value.drainage===undefined?{}:{drainage:validateDrainageCalibration(value.drainage)}) };
}
export function validateRecordInput(value) {
  object(value, ['fixture_id', 'record_type', 'data_source', 'confirm_empty']);
  if (!['calibration', 'drainage', 'monitoring'].includes(value.record_type)) fail('record_type must be calibration, drainage or monitoring');
  if (!['sensor', 'simulation'].includes(value.data_source)) fail('data_source must be sensor or simulation');
  if (value.record_type === 'calibration' && value.confirm_empty !== true) fail('Confirm the fixture is empty before calibration', 422, 'empty_confirmation_required');
  return { fixture_id: deviceId(value.fixture_id), record_type: value.record_type, data_source: value.data_source };
}
export function validateMeasurement(value, now = Date.now()) {
  object(value, ['reading_id', 'timestamp', 'sensor']);
  const time = timestamp(value.timestamp, 'timestamp');
  if (Date.parse(time) > now + 120000) fail('timestamp is more than two minutes in the future');
  const sensor = input => {
    object(input, ['distance_mm', 'status']);
    if (!['ok', 'timeout', 'out_of_range'].includes(input.status)) fail('Invalid sensor status');
    if (input.status !== 'ok') { if (input.distance_mm !== null) fail('Failed readings require distance_mm: null'); return { distance_mm: null, status: input.status }; }
    return { distance_mm: number(input.distance_mm, 'distance_mm', 20, 4500), status: 'ok' };
  };
  return { reading_id: uuid(value.reading_id, 'reading_id'), timestamp: time, sensor: sensor(value.sensor) };
}
export const MAX_BATCH = 20;
// Accepts one measurement object or {measurements:[...]} (1..MAX_BATCH points).
export function validateMeasurements(value, now = Date.now()) {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'measurements' in value) {
    object(value, ['measurements']);
    if (!Array.isArray(value.measurements) || value.measurements.length < 1 || value.measurements.length > MAX_BATCH) fail(`measurements must contain 1 to ${MAX_BATCH} points`);
    const points = value.measurements.map(point => validateMeasurement(point, now));
    if (new Set(points.map(p => p.reading_id)).size !== points.length) fail('reading_id values must be unique within a batch');
    return points;
  }
  return [validateMeasurement(value, now)];
}
export const ordered = points => [...points].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.reading_id.localeCompare(b.reading_id));
export function depths(point, calibration) {
  if (!calibration || !point?.sensor || point.sensor.status !== 'ok' || point.sensor.distance_mm === null) return null;
  const depth = calibration.empty_distance_mm - point.sensor.distance_mm;
  return depth < -20 ? null : [Math.max(0, depth)];
}
// Empty-sink reference. Tolerates the ordinary noise of an ultrasonic sensor: isolated timeouts are skipped (only a
// real outage longer than maxGap restarts the window), a few stray echoes are ignored, and stability is judged on the
// middle 80% of readings. A moving mount, filling water or an unreliable sensor still fail.
export const CALIBRATION_NOISE = Object.freeze({ trim: 0.1, maxSpreadMm: 10, echoMm: 15, maxEchoShare: 0.1, maxFailedShare: 0.25 });
export function learnCalibration(points) {
  const window = [], failed = [];
  for (const point of ordered(points)) {
    if (point.sensor.status !== 'ok') { failed.push(Date.parse(point.timestamp)); continue; }
    const previous = window.at(-1);
    if (previous && (Date.parse(point.timestamp) <= Date.parse(previous.timestamp) || Date.parse(point.timestamp) - Date.parse(previous.timestamp) > SETTINGS.maxGap)) window.length = 0;
    window.push(point);
  }
  while (window.length > 20 && Date.parse(window.at(-1).timestamp) - Date.parse(window[1].timestamp) >= 8000) window.shift();
  const first = window.length ? Date.parse(window[0].timestamp) : 0, last = window.length ? Date.parse(window.at(-1).timestamp) : 0;
  const span = last - first;
  const progress = Math.min(1, window.length / 20, span / 8000);
  const values = window.map(p => p.sensor.distance_mm).sort((a,b)=>a-b);
  const unstable = { progress:0, calibration:null, message:'Keep the sink empty and the sensor mount still.' };
  if (!values.length) return unstable;
  const median = (values[Math.floor(values.length/2)] + values[Math.floor((values.length-1)/2)]) / 2;
  const cut = Math.floor(values.length * CALIBRATION_NOISE.trim), core = values.slice(cut, values.length - cut);
  const echoes = values.filter(v => Math.abs(v - median) > CALIBRATION_NOISE.echoMm).length;
  const lost = failed.filter(t => t >= first && t <= last).length;
  if (core.at(-1) - core[0] > CALIBRATION_NOISE.maxSpreadMm || echoes > values.length * CALIBRATION_NOISE.maxEchoShare) return unstable;
  if (lost > (values.length + lost) * CALIBRATION_NOISE.maxFailedShare) return { progress:0, calibration:null, message:'The sensor is missing too many readings. Check its wiring and that nothing blocks it.' };
  return {progress,calibration:progress===1?{empty_distance_mm:Math.round(median*10)/10}:null,message:`${window.length} stable readings; ${(span/1000).toFixed(1)} seconds (minimum 20 readings over 8 seconds).`};
}
export function analyzeDrainage(points, calibration) {
  if (!calibration) return { result: { drainage_time_seconds: null, outcome: 'uncertain' }, message: 'No calibration is available.' };
  let wetAt = null, dryAt = null, dryCount = 0, lastTime = null, lastValidTime = null, gap = false, invalid = false;
  for (const point of ordered(points)) {
    const time = Date.parse(point.timestamp);
    if (time === lastTime) continue;
    if (wetAt !== null && lastValidTime !== null && time - lastValidTime > SETTINGS.maxGap) gap = true;
    lastTime = time;
    const values = depths(point, calibration);
    if (!values) { invalid = true; dryCount = 0; dryAt = null; continue; }
    if (wetAt === null) {
      // A valid wet reading starts observation; stable dry readings finish it.
      if (!values.some(v => v >= SETTINGS.wet)) continue;
      wetAt = time;
    }
    lastValidTime = time;
    if (values.every(v => v <= SETTINGS.dry)) {
      if (!dryCount) dryAt = time;
      dryCount++;
      if (dryCount >= SETTINGS.stable) return gap
        ? { result: { drainage_time_seconds: null, outcome: 'uncertain' }, message: 'A sampling gap prevents reliable drainage timing.' }
        : { result: { drainage_time_seconds: (dryAt - wetAt) / 1000, outcome: 'completed' }, message: 'The sensor confirmed the empty range.' };
    } else { dryCount = 0; dryAt = null; }
  }
  return { result: { drainage_time_seconds: null, outcome: wetAt === null ? 'uncertain' : 'incomplete' }, message: wetAt === null ? 'No measurable drainage event was observed.' : invalid ? 'Waiting for valid dry confirmation from the sensor.' : 'Drainage has not been confirmed complete.' };
}
// Status policy v3 changes classification only; measured results and replay stay frozen.
export const STATUS_SETTINGS = Object.freeze({ baselineDrains: 3, baselineSpread: 1.3, slowRatio: 1.5, tooLongRatio: 3, slowMargin: 10, timeoutMargin: 30, initialSlowSeconds: 30, initialTimeoutSeconds: 60 });
const duration = row => row.result?.outcome === 'completed' && Number.isFinite(row.result.drainage_time_seconds) && row.result.drainage_time_seconds > 0 ? row.result.drainage_time_seconds : null;
const median = values => [...values].sort((a,b) => a-b)[Math.floor(values.length / 2)];
function wetStart(row) {
  if (!row.calibration) return null;
  return ordered(row.measurements).find(p => depths(p, row.calibration)?.some(d => d >= SETTINGS.wet)) ?? null;
}
function startingDepth(row) {
  const start = wetStart(row);
  return start ? Math.max(...depths(start, row.calibration)) : null;
}
// A single stray echo (a reading far from both neighbours that agree with each other, or an in-range 'ok' reading that
// is impossible for this sink) must not start a phantom drain event or end a real one.
export const ECHO_MM = 15;
export function dropEchoes(points, calibration) {
  const raw = points.map(p => p.sensor?.status === 'ok' && p.sensor.distance_mm !== null ? calibration.empty_distance_mm - p.sensor.distance_mm : null);
  const good = v => v !== null && v >= -20;
  return points.filter((p, i) => {
    const x = raw[i], a = raw[i - 1], b = raw[i + 1];
    if (x === null || !good(a) || !good(b)) return true;
    if (!good(x)) return false;
    return !(Math.abs(x - a) > ECHO_MM && Math.abs(x - b) > ECHO_MM && Math.abs(a - b) <= ECHO_MM);
  });
}
// While idle the sensor should read the empty level. A stable offset (temperature, a bumped mount, or standing water)
// makes drains undetectable, so report it instead of failing silently. Water that is simply deep is not an offset.
export const SHIFT_SETTINGS = Object.freeze({ seconds: 30, minReadings: 20, tolerance: 6, maxShift: 30, spread: 6 });
export function emptyLevelShift(row) {
  if (!row.calibration || row.record_type !== 'monitoring' || row.schema_version === 1) return null;
  const ok = ordered(row.measurements).filter(p => p.sensor.status === 'ok' && p.sensor.distance_mm !== null);
  if (!ok.length) return null;
  const window = [];
  for (let i = ok.length - 1; i >= 0; i--) {
    const t = Date.parse(ok[i].timestamp);
    if (window.length && (Date.parse(window[0].timestamp) - t > SETTINGS.maxGap)) break;
    if (Date.parse(ok.at(-1).timestamp) - t > 60000) break;
    window.unshift(ok[i]);
  }
  if (window.length < SHIFT_SETTINGS.minReadings || Date.parse(window.at(-1).timestamp) - Date.parse(window[0].timestamp) < SHIFT_SETTINGS.seconds * 1000) return null;
  const values = window.map(p => row.calibration.empty_distance_mm - p.sensor.distance_mm).sort((a, b) => a - b);
  const cut = Math.floor(values.length * 0.1), core = values.slice(cut, values.length - cut);
  const median = (values[Math.floor(values.length / 2)] + values[Math.floor((values.length - 1) / 2)]) / 2;
  if (core.at(-1) - core[0] > SHIFT_SETTINGS.spread || Math.abs(median) <= SHIFT_SETTINGS.tolerance || Math.abs(median) > SHIFT_SETTINGS.maxShift) return null;
  return { shift_mm: Math.round(median * 10) / 10, readings: window.length, observed_at: window.at(-1).timestamp };
}
// Monitoring stores a continuous window. Derive individual cycles without rewriting
// measurements or saving synthetic records. Event IDs remain stable across polls.
export function monitoringEvents(row) {
  if (row.schema_version===1 || row.record_type !== 'monitoring' || !row.calibration) return [];
  const points = dropEchoes(ordered(row.measurements).filter((p,i,all) => !i || p.timestamp !== all[i-1].timestamp), row.calibration), events = [];
  let start = null, dryCount = 0, peakIndex = null, peakDepth = 0, fallCount = 0, draining = false;
  const event = (end, finished) => {
    const measurements = points.slice(peakIndex, end + 1);
    return {...row, record_id:`${row.record_id}:${points[start].reading_id}`, parent_record_id:row.record_id,
      monitoring_event:true, record_type:'drainage', created_at:points[start].timestamp,
      measurements, recording_status:finished ? 'finished' : row.recording_status,
      result:analyzeDrainage(measurements,row.calibration).result};
  };
  for (let i=0;i<points.length;i++) {
    const values = depths(points[i],row.calibration);
    if (start === null) {
      if (!values?.some(d => d >= SETTINGS.wet)) continue;
      start = i; peakIndex = i; peakDepth = Math.max(...values); fallCount = 0; draining = false;
    }
    // Follow the initial fill, then freeze the peak once three samples confirm a fall.
    // Small fluctuations cannot keep restarting the standing-water timeout.
    if (values && !draining) {
      const level = Math.max(...values);
      if (level > peakDepth + 4) { peakDepth = level; peakIndex = i; }
      fallCount = level < peakDepth - 4 ? fallCount + 1 : 0;
      if (fallCount >= SETTINGS.stable) draining = true;
    }
    dryCount = values?.every(d => d <= SETTINGS.dry) ? dryCount + 1 : 0;
    if (dryCount >= SETTINGS.stable) { events.push(event(i,true)); start = null; dryCount = 0; }
  }
  if (start !== null) events.push(event(points.length-1,false));
  return events;
}
export function drainCycleSummaries(record) {
  return monitoringEvents(record).filter(e => e.recording_status === 'finished').map(e => ({cycle_id:e.record_id, started_at:e.created_at, ended_at:e.measurements.at(-1).timestamp, drainage_time_seconds:e.result.drainage_time_seconds, outcome:e.result.outcome}));
}
export function learnedBaseline(rows) {
  const completed = rows.flatMap(r => r.record_type === 'monitoring' ? monitoringEvents(r) : [r]).filter(r => r.schema_version!==1 && duration(r) !== null).sort((a,b) => a.created_at.localeCompare(b.created_at) || a.record_id.localeCompare(b.record_id));
  for (let i = 0; i <= completed.length - STATUS_SETTINGS.baselineDrains; i++) {
    const window = completed.slice(i, i + STATUS_SETTINGS.baselineDrains);
    const times = window.map(duration), levels = window.map(startingDepth).filter(v => v !== null);
    if (Math.max(...times) / Math.min(...times) > STATUS_SETTINGS.baselineSpread) continue;
    if (levels.length === window.length && Math.max(...levels) / Math.min(...levels) > 1.25) continue;
    return { seconds: median(times), records: window, depth: levels.length === window.length ? median(levels) : null, count: window.length };
  }
  return { seconds: null, records: [], depth: null, count: Math.min(completed.length, STATUS_SETTINGS.baselineDrains - 1) };
}
// Retrieve the original training runs independently of history limits or UI filters.
// Stop once the first consistent window is found so later slowdowns cannot move it.
const contextCache = new WeakMap();
export async function statusContext(store, rows) {
  let cache=contextCache.get(store);if(!cache){cache=new Map();contextCache.set(store,cache);}
  const groups=new Map();for(const row of rows)if(['drainage','monitoring'].includes(row.record_type))groups.set(`${row.fixture_id}\0${row.data_source}`,row);
  const context=await Promise.all([...groups].map(async([key,row])=>{
    // A saved drainage profile replaces the learned baseline, so skip the history scan (and its reads) entirely.
    const profiled=await sinkProfile(store,row);if(profiled&&row.calibration?.empty_distance_mm===profiled.empty)return[];
    const hit=cache.get(key);let training=hit&&hit.expires>Date.now()?hit.rows:null;
    if(!training){training=[];for(let offset=0;;offset+=20){const page=await store.list({fixture_id:row.fixture_id,data_source:row.data_source,schema_version:2},20,'asc',offset);training.push(...page);if(learnedBaseline(training).seconds!==null||page.length<20)break;}}
    const combined=[...new Map([...training,...rows.filter(r=>r.fixture_id===row.fixture_id&&r.data_source===row.data_source)].map(r=>[r.record_id,r])).values()];
    const baseline=learnedBaseline(combined);
    // Cache frozen training evidence, never a stale open recording that could
    // create a false silence notification. Current rows override cached evidence.
    const ids=new Set(baseline.records.map(r=>r.parent_record_id??r.record_id));
    const saved=baseline.seconds!==null?combined.filter(r=>ids.has(r.record_id)).map(r=>({...r,recording_status:'finished'})):combined.filter(r=>r.recording_status==='finished');
    const bytes=JSON.stringify(saved).length*2;
    if(hit){cache.bytes=(cache.bytes??0)-hit.bytes;cache.delete(key);}
    if(bytes<=4*1024*1024){cache.set(key,{rows:saved,bytes,expires:Date.now()+(baseline.seconds!==null?300000:5000)});cache.bytes=(cache.bytes??0)+bytes;}
    while(cache.size>32||(cache.bytes??0)>8*1024*1024){const oldest=cache.keys().next().value;cache.bytes-=cache.get(oldest).bytes;cache.delete(oldest);}
    return training;
  }));
  const all=[...new Map([...context.flat(),...rows].map(r=>[r.record_id,r])).values()];
  // The profile lives on the empty-reference record; it applies only to drains measured against that same reference.
  const profiles=new Map(await Promise.all([...groups].map(async([key,row])=>[key,await sinkProfile(store,row)])));
  return all.map(r=>{const found=profiles.get(`${r.fixture_id}\0${r.data_source}`);return found&&r.calibration?.empty_distance_mm===found.empty?{...r,drainage_profile:found.profile}:r;});
}
// Copy of a row carrying its sink's drainage profile (never persisted), for notification limits.
export async function withDrainageProfile(store,row){
  if(!row.calibration||!['monitoring','drainage'].includes(row.record_type))return row;
  const found=await sinkProfile(store,row);
  return found&&row.calibration.empty_distance_mm===found.empty?{...row,drainage_profile:found.profile}:row;
}
const profileCache=new WeakMap();
async function sinkProfile(store,row){
  let cache=profileCache.get(store);if(!cache){cache=new Map();profileCache.set(store,cache);}
  const key=`${row.fixture_id}\0${row.data_source}`,hit=cache.get(key);if(hit&&hit.expires>Date.now())return hit.value;
  const latest=(await store.list({fixture_id:row.fixture_id,data_source:row.data_source,record_type:'calibration',recording_status:'finished',calibration_present:true,schema_version:2},1))[0];
  const profile=drainageProfileOf(latest?.calibration?.drainage),value=profile?{profile,empty:latest.calibration.empty_distance_mm}:null;
  cache.set(key,{value,expires:Date.now()+30000});if(cache.size>64)cache.delete(cache.keys().next().value);return value;
}
export function drainStatuses(rows, now = Date.now()) {
  const shifts = new Map(rows.filter(r => r.record_type === 'monitoring').map(r => [r.record_id, emptyLevelShift(r)]));
  rows = rows.flatMap(row => {
    if (row.record_type !== 'monitoring') return [row];
    const events = monitoringEvents(row);
    return events.length ? events : [{...row, record_type:'drainage', monitoring_event:true, parent_record_id:row.record_id}];
  });
  const groups = new Map();
  for (const row of rows) if (row.record_type === 'drainage') {
    const key = `${row.fixture_id}\0${row.data_source}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const statuses = new Map();
  for (const group of groups.values()) {
    const training = learnedBaseline(group), learned = training.seconds;
    const learnedSlow = learned === null ? STATUS_SETTINGS.initialSlowSeconds : Math.max(learned * STATUS_SETTINGS.slowRatio, learned + STATUS_SETTINGS.slowMargin);
    const learnedTimeout = learned === null ? STATUS_SETTINGS.initialTimeoutSeconds : Math.max(learned * STATUS_SETTINGS.tooLongRatio, learned + STATUS_SETTINGS.timeoutMargin);
    const completed = group.filter(r => r.schema_version!==1 && duration(r) !== null).sort((a,b) => a.created_at.localeCompare(b.created_at) || a.record_id.localeCompare(b.record_id));
    const judgements = new Map();
    const judge = row => { if (!judgements.has(row.record_id)) judgements.set(row.record_id, row.drainage_profile && row.calibration ? judgeDrainage(row.measurements, row.calibration.empty_distance_mm, row.drainage_profile) : null); return judgements.get(row.record_id); };
    for (const row of group) {
      // A saved drainage profile for this sink replaces thresholds learned from its first drains.
      const profile = row.schema_version!==1 ? row.drainage_profile ?? null : null;
      const baseline = profile ? profile.total.expected_seconds : learned;
      const calibrated = row.schema_version!==1 && (Boolean(row.calibration) || baseline !== null);
      let seconds = duration(row), status = row.schema_version===1 ? 'unknown' : calibrated ? 'unknown' : 'learning';
      let message = row.schema_version===1 ? 'Historical two-sensor result. Recalibrate the empty sink before using this device with the single-sensor schema.' : calibrated ? 'No reliable drain time is available.' : 'Save stable empty-sink readings to start monitoring.';
      const start = wetStart(row), initialDepth = startingDepth(row);
      // Profiled sinks are compared only at the depth bands the drain covered, against that sink's own times.
      const judged = profile && seconds !== null ? judge(row) : null;
      const matchedBaseline = profile ? judged?.expected_seconds ?? baseline : baseline;
      const slow = profile ? judged?.slow_seconds ?? profile.total.slow_seconds : learnedSlow;
      const timeout = profile ? profile.total.standing_water_seconds : learnedTimeout;
      if (judged) seconds = judged.observed_seconds;
      const comparable = profile ? seconds === null || judged !== null
        : training.depth === null || initialDepth === null || Math.abs(initialDepth / training.depth - 1) <= 0.25;
      if (calibrated && !comparable) message = profile ? 'This drain did not cover a depth range measured during drainage setup, so it is not compared with the sink profile.' : 'Starting water level differs from usual uses. Drain times at this depth are not compared with the usual time.';
      else if (calibrated && row.recording_status === 'recording') {
        status = 'in_progress'; message = 'Empty reference saved. Watching for water.';
        if (start) {
          const points = ordered(row.measurements), latest = points.at(-1), values = depths(latest, row.calibration);
          seconds = Math.max(0, (Date.parse(latest.timestamp) - Date.parse(start.timestamp)) / 1000);
          const gaps = points.filter(p => p.timestamp >= start.timestamp);
          const reliable = now - Date.parse(latest.timestamp) <= SETTINGS.maxGap && now >= Date.parse(latest.timestamp)
            && gaps.every((p,i) => depths(p,row.calibration) && (!i || Date.parse(p.timestamp) - Date.parse(gaps[i-1].timestamp) <= SETTINGS.maxGap));
          if (!reliable) { status = 'unknown'; message = 'Fresh, continuous readings from the sensor are required. Check the device.'; }
          else if (values.some(d => d > SETTINGS.dry) && seconds >= timeout) { status = 'running_too_long'; message = `Water remains after ${seconds.toFixed(1)} seconds (limit ${timeout.toFixed(1)} seconds). Check for a blockage or continuing water input.`; }
          else message = `Draining: ${seconds.toFixed(1)} seconds. Check the fixture if water remains at ${timeout.toFixed(1)} seconds.`;
        }
      } else if (calibrated && seconds !== null && comparable) {
        status = seconds >= slow ? 'slow_drain' : 'normal';
        message = profile
          ? status === 'slow_drain' ? `Drained in ${seconds.toFixed(1)} seconds at matching depths; this sink usually takes ${matchedBaseline.toFixed(1)} (warning at ${slow.toFixed(1)}).` : `Drain time is within this sink's normal range (usually ${matchedBaseline.toFixed(1)} seconds, ±${judged.tolerance_seconds.toFixed(1)} allowed).`
          : status === 'slow_drain' ? `Drain time exceeded the ${slow.toFixed(1)} second warning threshold.` : 'Drain time is within the normal range.';
      }
      const position = completed.findIndex(r => r.record_id === row.record_id);
      let repeatedSlow;
      if (profile) {
        // Repeated slowdown: repeat_count slow drains among the last repeat_window comparable drains on this reference.
        const seen = completed.slice(0, position < 0 ? 0 : position + 1).filter(r => r.drainage_profile && judge(r)).slice(-profile.policy.repeat_window);
        repeatedSlow = seen.filter(r => judge(r).slow).length >= profile.policy.repeat_count;
      } else {
        const recent = completed.slice(0, position < 0 ? 0 : position + 1).filter(r => !training.records.some(t => t.record_id === r.record_id)).slice(-3);
        repeatedSlow = recent.filter(r => duration(r) >= slow && (training.depth === null || startingDepth(r) === null || Math.abs(startingDepth(r) / training.depth - 1) <= 0.25)).length >= 2;
      }
      const shift = shifts.get(row.parent_record_id ?? row.record_id) ?? null;
      if (shift && status === 'in_progress' && !start) message = `The sensor reads ${Math.abs(shift.shift_mm).toFixed(0)} mm ${shift.shift_mm > 0 ? 'above' : 'below'} the saved empty level while idle. If the sink is empty, record the empty sink again; otherwise check for standing water.`;
      const view = { status, empty_shift_mm: shift?.shift_mm ?? null, baseline_seconds: matchedBaseline, ratio: matchedBaseline && seconds !== null ? Math.round(seconds / matchedBaseline * 100) / 100 : null,
        elapsed_seconds: seconds, slow_threshold_seconds: slow, timeout_threshold_seconds: timeout, baseline_count: profile ? 2 : training.count,
        baseline_record_ids: profile ? [] : training.records.map(r => r.record_id), baseline_depth_mm: profile ? profile.bands[0].from_depth_mm : training.depth, repeated_slow: repeatedSlow, message,
        ...(profile ? { baseline_source: 'drainage_profile', tolerance_seconds: judged?.tolerance_seconds ?? profile.total.tolerance_seconds, severe_threshold_seconds: judged?.severe_seconds ?? profile.total.severe_seconds, severe: judged?.severe ?? false, matched_bands: judged?.bands ?? [] } : { baseline_source: learned === null ? null : 'learned_drains' }) };
      statuses.set(row.record_id,view);
      if (row.parent_record_id) statuses.set(row.parent_record_id,view);
    }
  }
  return statuses;
}
export function forecast(points, calibration, stale = false) {
  const withheld = message => ({ state: 'unavailable', seconds_remaining: null, message });
  if (!calibration) return withheld('Calibrate this fixture first.');
  if (stale) return withheld('Waiting for fresh sensor readings.');
  const rows = ordered(points), window = [];
  for (let i = rows.length - 1; i >= 0 && window.length < 8; i--) {
    const p = rows[i], newer = window.at(-1);
    if (!depths(p, calibration) || (newer && (Date.parse(newer.timestamp) <= Date.parse(p.timestamp) || Date.parse(newer.timestamp) - Date.parse(p.timestamp) > SETTINGS.maxGap))) break;
    window.push(p);
  }
  if (window.length >= SETTINGS.stable && window.slice(0, SETTINGS.stable).every(p => depths(p, calibration).every(d => d <= SETTINGS.dry))) return { state: 'dry', seconds_remaining: 0, message: 'The sensor confirms no measurable water.' };
  if (window.length < 6) return withheld('Waiting for consecutive valid readings.');
  window.reverse();
  const start = Date.parse(window[0].timestamp), times = window.map(p => (Date.parse(p.timestamp) - start) / 1000);
  if (times.at(-1) < 2) return withheld('Waiting for a longer measurement window.');
  const remaining = [];
  for (let sensor = 0; sensor < 1; sensor++) {
    const values = window.map(p => depths(p, calibration)[sensor]), depth = values.at(-1);
    if (depth <= SETTINGS.dry) { remaining.push(0); continue; }
    const meanT = times.reduce((a, b) => a + b, 0) / times.length, meanD = values.reduce((a, b) => a + b, 0) / values.length;
    const slope = times.reduce((sum, t, i) => sum + (t - meanT) * (values[i] - meanD), 0) / times.reduce((sum, t) => sum + (t - meanT) ** 2, 0);
    const variation = values.reduce((sum, d) => sum + (d - meanD) ** 2, 0);
    const error = values.reduce((sum, d, i) => sum + (d - meanD - slope * (times[i] - meanT)) ** 2, 0);
    if (slope >= -0.2 || !variation || 1 - error / variation < 0.85 || values.some((d, i) => i && d - values[i - 1] > 4)) return withheld('The water level is too irregular or is not falling.');
    remaining.push((depth - SETTINGS.dry) / -slope);
  }
  const seconds = Math.max(...remaining);
  if (seconds === 0) return withheld('Waiting for stable dry confirmation.');
  if (seconds > 120) return withheld('Drainage is beyond the two-minute forecast horizon.');
  return { state: 'forecast', seconds_remaining: seconds, message: 'Experimental estimate; assumes the tap is off.' };
}
// Onboarding observes water before a timed test. It never infers tap-off from level.
export function setupGuidance(record, now = Date.now()) {
  const latest = ordered(record.measurements).at(-1), target = 40;
  const reply = (phase, message, water_depth_mm = null) => ({phase, message, water_depth_mm, target_depth_mm:target});
  if (!record.calibration) return reply('needs_calibration','Record the empty basin first.');
  if (!latest) return reply('waiting','Waiting for the device. Keep the tap off until readings arrive.');
  if (now - Date.parse(latest.timestamp) > SETTINGS.maxGap || Date.parse(latest.timestamp) > now) return reply('sensor_problem','Readings have paused. Turn the tap off and reconnect the device.');
  const values = depths(latest,record.calibration);
  if (!values) return reply('sensor_problem','The sensor needs a clear reading. Turn the tap off and check its position.');
  const level = Math.max(...values);
  if (level < target) return reply('add_water',`Put the plug in and run the tap gently. Aim for about ${target} mm of water, well below the rim.`,level);
  return reply('water_ready','Enough water. Turn the tap off, keep the plug in, then start the drain test.',level);
}
export function computedView(record, sample = null) {
  const rows = ordered(record.measurements);
  const position = sample === null ? rows.length - 1 : Math.min(sample, rows.length - 1);
  const visible = rows.slice(0, position + 1);
  const stale = record.recording_status === 'recording' && (!rows.length || Date.now() - Date.parse(rows.at(-1).timestamp) > 15000);
  const result = forecast(visible, record.calibration, stale && sample === null);
  const first = rows[0]?.timestamp;
  const timeline = visible.map((p, i) => ({ elapsed_seconds: (Date.parse(p.timestamp) - Date.parse(first)) / 1000, seconds_remaining: forecast(visible.slice(Math.max(0, i - 7), i + 1), record.calibration).seconds_remaining }));
  const water_levels = visible.map((point, index) => {
    const values = depths(point, record.calibration);
    const gap_before = index > 0 && Date.parse(point.timestamp) - Date.parse(visible[index - 1].timestamp) > SETTINGS.maxGap;
    return { elapsed_seconds: (Date.parse(point.timestamp) - Date.parse(first)) / 1000, depth_mm: values?.[0] ?? null, gap_before };
  });
  if (stale && sample === null && timeline.length) timeline.at(-1).seconds_remaining = null;
  const learning = record.record_type === 'calibration' ? learnCalibration(visible) : null;
  const latest = visible.at(-1);
  const sensor_connection = !latest ? 'waiting' : latest.sensor.status !== 'ok' ? 'problem' : record.recording_status === 'recording' && (Date.now() - Date.parse(latest.timestamp) > SETTINGS.maxGap || Date.parse(latest.timestamp) > Date.now()) ? 'stale' : 'connected';
  return { drain_cycles: drainCycleSummaries(record), monitoring_limits: { slow_seconds: STATUS_SETTINGS.initialSlowSeconds, standing_water_seconds: STATUS_SETTINGS.initialTimeoutSeconds }, sensor_connection, setup_guidance: setupGuidance({...record, measurements:visible}), forecast: result, timeline, water_levels, sample_index: Math.max(0, position), sample_count: rows.length, first_measurement_at: first ?? null, elapsed_seconds: visible.length ? (Date.parse(visible.at(-1).timestamp) - Date.parse(first)) / 1000 : 0, stale, calibration_progress: learning?.progress ?? null, calibration_message: learning?.message ?? null };
}
// Applies points in order inside one atomic update. Points arriving after the
// recording completes (calibration/drainage reaching its result) are dropped.
export function appendMeasurements(record, points) {
  let current = record, duplicate = true; const wasRecording = record.recording_status === 'recording';
  for (const point of points) {
    if (wasRecording && current.recording_status !== 'recording') break;
    const step = appendMeasurement(current, point);
    current = step.record; duplicate = duplicate && step.duplicate;
  }
  return { record: current, duplicate };
}
// Egress and record-size control for continuous monitoring. A sink that is just sitting there does not need every
// reading: while idle keep one reading per idleKeepMs. During use, and for quietMs afterwards, keep every reading so
// drain timing, setup checks and the shifted-level check always see dense data. Monitoring keeps a rolling window
// instead of refusing readings when full, so a unit can run for months. Skipped readings are acknowledged normally.
export const INGEST = Object.freeze({ idleBandMm: 8, quietMs: 30000, idleKeepMs: 8000, monitoringWindow: 2000 });
const rawDepth = (p, c) => p.sensor?.status === 'ok' && p.sensor.distance_mm !== null ? c.empty_distance_mm - p.sensor.distance_mm : null;
const idleReading = (p, c) => { const d = rawDepth(p, c); return d !== null && Math.abs(d) <= INGEST.idleBandMm; };
function skipIdle(record, point) {
  if (record.record_type !== 'monitoring' || !record.calibration || !record.measurements.length || !idleReading(point, record.calibration)) return false;
  const t = Date.parse(point.timestamp), stored = record.measurements, last = Date.parse(stored.at(-1).timestamp);
  if (t < last || t - last >= INGEST.idleKeepMs) return false;
  for (let i = stored.length - 1; i >= 0 && t - Date.parse(stored[i].timestamp) <= INGEST.quietMs; i--) if (!idleReading(stored[i], record.calibration)) return false;
  return true;
}
export function appendMeasurement(record, point) {
  const existing = record.measurements.find(p => p.reading_id === point.reading_id);
  if (existing) { if (!isDeepStrictEqual(existing, point)) fail('reading_id was reused with different measurements', 409, 'reading_conflict'); return { record, duplicate: true }; }
  if (record.recording_status !== 'recording') fail('Recording is finished; start a new record', 409, 'record_finished');
  if (skipIdle(record, point)) return { record, duplicate: true, thinned: true };
  if (record.measurements.length >= SETTINGS.maxMeasurements && record.record_type !== 'monitoring') fail('Recording reached 5000 samples; finish it and start another', 409, 'record_full');
  let measurements = ordered([...record.measurements, point]);
  if (record.record_type === 'monitoring' && measurements.length > INGEST.monitoringWindow) measurements = measurements.slice(-INGEST.monitoringWindow);
  const next = { ...record, measurements };
  if (next.record_type === 'calibration') {
    const learned = learnCalibration(next.measurements);
    if (learned.calibration) { next.calibration = learned.calibration; next.recording_status = 'finished'; }
  }
  if (next.record_type === 'drainage') {
    const analysis = analyzeDrainage(next.measurements, next.calibration);
    if (analysis.result.outcome === 'completed') { next.result = analysis.result; next.recording_status = 'finished'; }
  }
  return { record: next, duplicate: false };
}

// Bound live graph responses without changing stored history or measured timings.
// Replay callers omit window and retain the full recording.
export function boundedRecordView(record, sample = null, window = null, after = null) {
  if (window !== null && (!Number.isInteger(window) || window < 1 || window > 500)) fail('window must be an integer from 1 to 500');
  if(after!==null){uuid(after,'after');if(window===null||sample!==null)fail('after requires window and cannot be combined with replay');}
  const computed = computedView(record, sample);
  if (window === null) return {record,computed};
  const visible=ordered(record.measurements).slice(0,computed.sample_index+1);
  const index=after===null?-1:visible.findIndex(p=>p.reading_id===after);
  const start=index<0?Math.max(0,visible.length-window):Math.max(index+1,visible.length-window);
  const series_mode=index<0?'replace':'append';
  return {record:{...record,measurements:visible.slice(start)},computed:{...computed,series_mode,timeline:computed.timeline.slice(start),water_levels:computed.water_levels.slice(start)}};
}
