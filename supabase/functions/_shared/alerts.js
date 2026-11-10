import { drainStatuses, ordered, STATUS_SETTINGS } from './records-domain.js';

export const ALERT_SETTINGS = Object.freeze({
  criticalSlowRatio: 2.5,
  trendDrains: 3,
  trendRatio: 1.25,
  faultMinimumSamples: 10,
  faultShare: 0.25,
  silentMs: 60000,
});
export const SEVERITIES = Object.freeze(['critical', 'warning', 'info']);
const rank = Object.fromEntries(SEVERITIES.map((severity, index) => [severity, index]));

const lastActivity = row => row.measurements.length ? ordered(row.measurements).at(-1).timestamp : row.created_at;
const failed = point => point.sensor_a.status !== 'ok' || point.sensor_b.status !== 'ok';
const seconds = value => `${value.toFixed(1)} seconds`;
const alert = (row, type, severity, title, message, occurred_at, details = {}) => ({
  alert_id: `${type}:${row.record_id}`,
  type, severity, title, message, occurred_at,
  fixture_id: row.fixture_id, data_source: row.data_source, record_id: row.record_id, record_type: row.record_type,
  details,
});

function drainageAlerts(group, statuses) {
  const alerts = [];
  for (const row of group) {
    const status = statuses.get(row.record_id);
    if (status?.status === 'running_too_long') {
      alerts.push(alert(row, 'running_too_long', 'critical', 'Drain running too long',
        `Water has been draining for ${(status.ratio).toFixed(1)}× the usual ${seconds(status.baseline_seconds)}. Check for a blockage or a tap left on.`,
        lastActivity(row), { baseline_seconds: status.baseline_seconds, ratio: status.ratio }));
    }
    if (status?.status === 'slow_drain') {
      const critical = status.ratio > ALERT_SETTINGS.criticalSlowRatio;
      alerts.push(alert(row, 'slow_drain', critical ? 'critical' : 'warning', critical ? 'Severe slow drain' : 'Slow drain',
        `Drained in ${seconds(row.result.drainage_time_seconds)}, ${status.ratio.toFixed(1)}× the usual ${seconds(status.baseline_seconds)}. Schedule cleaning${critical ? ' soon' : ''}.`,
        lastActivity(row), { drainage_time_seconds: row.result.drainage_time_seconds, baseline_seconds: status.baseline_seconds, ratio: status.ratio }));
    }
    if (row.recording_status === 'finished' && row.result?.outcome !== 'completed') {
      alerts.push(alert(row, 'unreliable_result', 'info', 'Drain time not measured',
        row.result?.outcome === 'uncertain'
          ? 'Missing or irregular readings prevented a reliable drain time. This drain is excluded from status checks.'
          : 'The recording ended before both sensors confirmed the basin was empty.',
        lastActivity(row), { outcome: row.result?.outcome ?? 'incomplete' }));
    }
  }

  // Early warning: steadily rising times that are still under the slow-drain threshold.
  const completed = group.filter(r => r.result?.outcome === 'completed').sort((a, b) => a.created_at.localeCompare(b.created_at));
  const recent = completed.slice(-ALERT_SETTINGS.trendDrains);
  const latest = recent.at(-1), latestStatus = latest && statuses.get(latest.record_id);
  if (completed.length > STATUS_SETTINGS.baselineDrains && recent.length === ALERT_SETTINGS.trendDrains && latestStatus?.status === 'normal'
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
      `${Math.round(faults / points.length * 100)}% of readings had a missing echo. Check that both sensors are mounted, dry and unobstructed.`,
      lastActivity(row), { failed_readings: faults, total_readings: points.length }));
  }
  if (row.recording_status === 'recording' && now - Date.parse(lastActivity(row)) > ALERT_SETTINGS.silentMs) {
    alerts.push(alert(row, 'device_silent', 'warning', 'Sensor stopped reporting',
      points.length
        ? `No readings for ${Math.round((now - Date.parse(lastActivity(row))) / 60000)} minutes during an open recording. Check power and Wi-Fi.`
        : 'This recording was started but has not received any readings. Check that the device is on and has the recording ID.',
      lastActivity(row), { measurement_count: points.length }));
  }
  return alerts;
}

export function buildAlerts(rows, now = Date.now()) {
  const statuses = drainStatuses(rows, now);
  const groups = new Map();
  for (const row of rows) if (row.record_type === 'drainage') {
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
