import { drainStatuses, ordered, STATUS_SETTINGS, monitoringEvents, emptyLevelShift } from './records-domain.js';

export const ALERT_SETTINGS = Object.freeze({
  trendDrains: 3,
  trendRatio: 1.25,
  faultMinimumSamples: 10,
  faultShare: 0.25,
  silentMs: 60000,
});
export const SEVERITIES = Object.freeze(['critical', 'warning', 'info']);
const rank = Object.fromEntries(SEVERITIES.map((severity, index) => [severity, index]));

const lastActivity = row => row.measurements.length ? ordered(row.measurements).at(-1).timestamp : row.created_at;
const failed = point => point.sensor.status !== 'ok';
const seconds = value => `${value.toFixed(1)} seconds`;
const alert = (row, type, severity, title, message, occurred_at, details = {}) => ({
  alert_id: `${type}:${row.record_id}`,
  type, severity, title, message, occurred_at,
  fixture_id: row.fixture_id, data_source: row.data_source, record_id: row.parent_record_id ?? row.record_id, record_type: row.parent_record_id ? 'monitoring' : row.record_type,
  details,
});

function drainageAlerts(group, statuses) {
  const alerts = [];
  for (const row of group) {
    const status = statuses.get(row.record_id);
    if (status?.status === 'running_too_long') {
      alerts.push(alert(row, 'running_too_long', 'critical', 'Drain running too long',
        `Water remains after ${seconds(status.elapsed_seconds)} (limit ${seconds(status.timeout_threshold_seconds)}). Check for a blockage or continuing water input.`,
        lastActivity(row), { baseline_seconds: status.baseline_seconds, ratio: status.ratio, threshold_seconds: status.timeout_threshold_seconds }));
    }
    if (status?.status === 'slow_drain') {
      // Profiled sinks: severe means far beyond this sink's own time at matching depths; otherwise the wet-to-dry time is used.
      const critical = status.baseline_source === 'drainage_profile' ? status.severe : row.result.drainage_time_seconds >= status.timeout_threshold_seconds;
      if (!critical && !status.repeated_slow) continue;
      alerts.push(alert(row, 'slow_drain', critical ? 'critical' : 'warning', critical ? 'Severe slow drain' : 'Slow drain',
        status.baseline_seconds === null ? `Water took ${seconds(row.result.drainage_time_seconds)} to clear, exceeding the ${seconds(critical ? status.timeout_threshold_seconds : status.slow_threshold_seconds)} time limit. Check the fixture and confirm the tap is off.` : `Drained in ${seconds(status.elapsed_seconds)}, ${status.ratio.toFixed(1)}× the usual ${seconds(status.baseline_seconds)}. Schedule cleaning${critical ? ' soon' : ''}.`,
        lastActivity(row), { drainage_time_seconds: status.elapsed_seconds, baseline_seconds: status.baseline_seconds, ratio: status.ratio, threshold_seconds: status.slow_threshold_seconds, repeated_slow: status.repeated_slow }));
    }
    if (!row.monitoring_event && row.recording_status === 'finished' && row.result?.outcome !== 'completed') {
      alerts.push(alert(row, 'unreliable_result', 'info', 'Drain time not measured',
        row.result?.outcome === 'uncertain'
          ? 'Missing or irregular readings prevented a reliable drain time. This drain is excluded from status checks.'
          : 'The recording ended before the sensor confirmed the basin was empty.',
        lastActivity(row), { outcome: row.result?.outcome ?? 'incomplete' }));
    }
  }

  // Early warning: steadily rising times that are still under the slow-drain threshold.
  const completed = group.filter(r => r.result?.outcome === 'completed').sort((a, b) => a.created_at.localeCompare(b.created_at));
  const recent = completed.slice(-ALERT_SETTINGS.trendDrains);
  const latest = recent.at(-1), latestStatus = latest && statuses.get(latest.record_id);
  if (completed.length > STATUS_SETTINGS.baselineDrains && recent.length === ALERT_SETTINGS.trendDrains && ['normal', 'slow_drain'].includes(latestStatus?.status) && !latestStatus?.repeated_slow && latest.result.drainage_time_seconds < latestStatus.timeout_threshold_seconds
    && recent.every((r, i) => i === 0 || r.result.drainage_time_seconds > recent[i - 1].result.drainage_time_seconds)
    && latestStatus.ratio >= ALERT_SETTINGS.trendRatio) {
    alerts.push(alert(latest, 'worsening_trend', 'warning', 'Drain getting slower',
      `The last ${ALERT_SETTINGS.trendDrains} drains each took longer, now ${latestStatus.ratio.toFixed(2)}× the usual ${seconds(latestStatus.baseline_seconds)}. A clog may be forming.`,
      lastActivity(latest), { drainage_times_seconds: recent.map(r => r.result.drainage_time_seconds), baseline_seconds: latestStatus.baseline_seconds, ratio: latestStatus.ratio }));
  }
  return alerts;
}

function recordingAlerts(row, now) {
  const alerts = [];
  const points = row.measurements;
  const faults = points.filter(failed).length;
  if (points.length >= ALERT_SETTINGS.faultMinimumSamples && faults / points.length >= ALERT_SETTINGS.faultShare) {
    alerts.push(alert(row, 'sensor_faults', 'warning', 'Sensor readings failing',
      `${Math.round(faults / points.length * 100)}% of readings had a missing echo. Check that the sensor is mounted, dry and unobstructed.`,
      lastActivity(row), { failed_readings: faults, total_readings: points.length }));
  }
  if (row.recording_status === 'recording' && now - Date.parse(lastActivity(row)) > ALERT_SETTINGS.silentMs) {
    alerts.push(alert(row, 'device_silent', 'warning', 'Sensor stopped reporting',
      points.length
        ? `No readings for ${Math.round((now - Date.parse(lastActivity(row))) / 60000)} minutes during an open recording. Check power and Wi-Fi.`
        : 'This recording was started but has not received any readings. Check that the device is on and has the recording ID.',
      lastActivity(row), { measurement_count: points.length }));
  }
  const shift = row.recording_status === 'recording' && now - Date.parse(lastActivity(row)) <= ALERT_SETTINGS.silentMs ? emptyLevelShift(row) : null;
  if (shift) {
    alerts.push(alert(row, 'empty_level_shift', 'warning', 'Empty level has shifted',
      `While idle the sensor reads ${Math.abs(shift.shift_mm).toFixed(0)} mm ${shift.shift_mm > 0 ? 'above' : 'below'} the saved empty level (temperature, a moved sensor or standing water). If the sink is empty, record the empty sink again; otherwise check for water that is not draining.`,
      shift.observed_at, { shift_mm: shift.shift_mm, readings: shift.readings }));
  }
  return alerts;
}

export function buildAlerts(rows, now = Date.now()) {
  rows=rows.filter(row=>row.schema_version!==1);
  const statuses = drainStatuses(rows, now);
  const groups = new Map();
  for (const row of rows.flatMap(r => r.record_type === 'monitoring' ? monitoringEvents(r) : [r])) if (row.record_type === 'drainage') {
    const key = `${row.fixture_id}\u0000${row.data_source}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const alerts = [...groups.values()].flatMap(group => drainageAlerts(group, statuses));
  for (const row of rows) alerts.push(...recordingAlerts(row, now));
  return alerts.sort((a, b) => rank[a.severity] - rank[b.severity] || b.occurred_at.localeCompare(a.occurred_at) || a.alert_id.localeCompare(b.alert_id));
}

export function summarizeAlerts(alerts) {
  const counts = Object.fromEntries(SEVERITIES.map(severity => [severity, 0]));
  for (const item of alerts) counts[item.severity]++;
  return { total: alerts.length, ...counts };
}
