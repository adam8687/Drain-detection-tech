import { isDeepStrictEqual } from 'node:util';
import { ApiError, object, number, uuid, timestamp, deviceId } from './validation.js';

export const SETTINGS = Object.freeze({ wet: 20, dry: 8, stable: 3, maxGap: 5000, maxMeasurements: 5000 });
export const fail = (message, status = 422, code = 'validation_error') => { throw new ApiError(status, code, message); };
export function calibrationSnapshot(value) {
  if (value === null) return null;
  object(value, ['sensor_a_empty_mm', 'sensor_b_empty_mm']);
  return { sensor_a_empty_mm: number(value.sensor_a_empty_mm, 'sensor_a_empty_mm', 20, 4500), sensor_b_empty_mm: number(value.sensor_b_empty_mm, 'sensor_b_empty_mm', 20, 4500) };
}
export function validateRecordInput(value) {
  object(value, ['fixture_id', 'record_type', 'data_source', 'confirm_empty']);
  if (!['calibration', 'drainage', 'monitoring'].includes(value.record_type)) fail('record_type must be calibration, drainage or monitoring');
  if (!['sensor', 'simulation'].includes(value.data_source)) fail('data_source must be sensor or simulation');
  if (value.record_type === 'calibration' && value.confirm_empty !== true) fail('Confirm the fixture is empty before calibration', 422, 'empty_confirmation_required');
  return { fixture_id: deviceId(value.fixture_id), record_type: value.record_type, data_source: value.data_source };
}
export function validateMeasurement(value, now = Date.now()) {
  object(value, ['reading_id', 'timestamp', 'sensor_a', 'sensor_b']);
  const time = timestamp(value.timestamp, 'timestamp');
  if (Date.parse(time) > now + 120000) fail('timestamp is more than two minutes in the future');
  const sensor = input => {
    object(input, ['distance_mm', 'status']);
    if (!['ok', 'timeout', 'out_of_range'].includes(input.status)) fail('Invalid sensor status');
    if (input.status !== 'ok') { if (input.distance_mm !== null) fail('Failed readings require distance_mm: null'); return { distance_mm: null, status: input.status }; }
    return { distance_mm: number(input.distance_mm, 'distance_mm', 20, 4500), status: 'ok' };
  };
  return { reading_id: uuid(value.reading_id, 'reading_id'), timestamp: time, sensor_a: sensor(value.sensor_a), sensor_b: sensor(value.sensor_b) };
}
export const ordered = points => [...points].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.reading_id.localeCompare(b.reading_id));
export function depths(point, calibration) {
  if (!calibration) return null;
  const result = [];
  for (const sensor of ['a', 'b']) {
    const reading = point[`sensor_${sensor}`];
    if (reading.status !== 'ok' || reading.distance_mm === null) return null;
    const depth = calibration[`sensor_${sensor}_empty_mm`] - reading.distance_mm;
    if (depth < -20) return null;
    result.push(Math.max(0, depth));
  }
  return result;
}
export function learnCalibration(points) {
  const window = [];
  for (const point of ordered(points)) {
    if (['sensor_a', 'sensor_b'].some(sensor => point[sensor].status !== 'ok')) { window.length = 0; continue; }
    const previous = window.at(-1);
    if (previous && (Date.parse(point.timestamp) <= Date.parse(previous.timestamp) || Date.parse(point.timestamp) - Date.parse(previous.timestamp) > SETTINGS.maxGap)) window.length = 0;
    window.push(point);
  }
  while (window.length > 20 && Date.parse(window.at(-1).timestamp) - Date.parse(window[1].timestamp) >= 8000) window.shift();
  const span = window.length ? Date.parse(window.at(-1).timestamp) - Date.parse(window[0].timestamp) : 0;
  const progress = Math.min(1, window.length / 20, span / 8000);
  const calibration = {};
  for (const sensor of ['a', 'b']) {
    const values = window.map(p => p[`sensor_${sensor}`].distance_mm).sort((a, b) => a - b);
    if (!values.length || values.at(-1) - values[0] > 4) return { progress: 0, calibration: null, message: 'Keep the fixture empty and the sensor mounts still.' };
    const median = (values[Math.floor(values.length / 2)] + values[Math.floor((values.length - 1) / 2)]) / 2;
    calibration[`sensor_${sensor}_empty_mm`] = Math.round(median * 10) / 10;
  }
  return { progress, calibration: progress === 1 ? calibration : null, message: `${window.length} stable samples; ${(span / 1000).toFixed(1)} seconds (minimum 20 samples over 8 seconds).` };
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
      // Water at either location starts observation; both must be dry to finish.
      if (!values.some(v => v >= SETTINGS.wet)) continue;
      wetAt = time;
    }
    lastValidTime = time;
    if (values.every(v => v <= SETTINGS.dry)) {
      if (!dryCount) dryAt = time;
      dryCount++;
      if (dryCount >= SETTINGS.stable) return gap
        ? { result: { drainage_time_seconds: null, outcome: 'uncertain' }, message: 'A sampling gap prevents reliable drainage timing.' }
        : { result: { drainage_time_seconds: (dryAt - wetAt) / 1000, outcome: 'completed' }, message: 'Both sensors confirmed the empty range.' };
    } else { dryCount = 0; dryAt = null; }
  }
  return { result: { drainage_time_seconds: null, outcome: wetAt === null ? 'uncertain' : 'incomplete' }, message: wetAt === null ? 'No measurable drainage event was observed.' : invalid ? 'Waiting for valid dry confirmation from both sensors.' : 'Drainage has not been confirmed complete.' };
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
  if (window.length >= SETTINGS.stable && window.slice(0, SETTINGS.stable).every(p => depths(p, calibration).every(d => d <= SETTINGS.dry))) return { state: 'dry', seconds_remaining: 0, message: 'Both sensors confirm no measurable water.' };
  if (window.length < 6) return withheld('Waiting for consecutive valid readings.');
  window.reverse();
  const start = Date.parse(window[0].timestamp), times = window.map(p => (Date.parse(p.timestamp) - start) / 1000);
  if (times.at(-1) < 2) return withheld('Waiting for a longer measurement window.');
  const remaining = [];
  for (let sensor = 0; sensor < 2; sensor++) {
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
export function computedView(record, sample = null) {
  const rows = ordered(record.measurements);
  const position = sample === null ? rows.length - 1 : Math.min(sample, rows.length - 1);
  const visible = rows.slice(0, position + 1);
  const stale = record.recording_status === 'recording' && (!rows.length || Date.now() - Date.parse(rows.at(-1).timestamp) > 15000);
  const result = forecast(visible, record.calibration, stale && sample === null);
  const first = rows[0]?.timestamp;
  const timeline = visible.map((p, i) => ({ elapsed_seconds: (Date.parse(p.timestamp) - Date.parse(first)) / 1000, seconds_remaining: forecast(visible.slice(Math.max(0, i - 7), i + 1), record.calibration).seconds_remaining }));
  if (stale && sample === null && timeline.length) timeline.at(-1).seconds_remaining = null;
  const learning = record.record_type === 'calibration' ? learnCalibration(visible) : null;
  return { forecast: result, timeline, sample_index: Math.max(0, position), sample_count: rows.length, elapsed_seconds: visible.length ? (Date.parse(visible.at(-1).timestamp) - Date.parse(first)) / 1000 : 0, stale, calibration_progress: learning?.progress ?? null, calibration_message: learning?.message ?? null };
}
export function appendMeasurement(record, point) {
  const existing = record.measurements.find(p => p.reading_id === point.reading_id);
  if (existing) { if (!isDeepStrictEqual(existing, point)) fail('reading_id was reused with different measurements', 409, 'reading_conflict'); return { record, duplicate: true }; }
  if (record.recording_status !== 'recording') fail('Recording is finished; start a new record', 409, 'record_finished');
  if (record.measurements.length >= SETTINGS.maxMeasurements) fail('Recording reached 5000 samples; finish it and start another', 409, 'record_full');
  const next = { ...record, measurements: ordered([...record.measurements, point]) };
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
