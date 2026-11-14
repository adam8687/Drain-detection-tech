import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildAlerts, summarizeAlerts } from '../src/alerts.js';
import { SQLiteRecordStore } from '../src/records-storage.js';
import { createApp } from '../src/server.js';
import { configFromEnv } from '../src/config.js';

const point = (timestamp, ok = true) => ({ reading_id: randomUUID(), timestamp, sensor: ok ? { distance_mm: 200, status: 'ok' } : { distance_mm: null, status: 'timeout' } });
const drain = (id, day, seconds, extra = {}) => ({
  record_id: id, fixture_id: 'sink', data_source: 'sensor', record_type: 'drainage', recording_status: 'finished',
  created_at: `2026-11-${String(day).padStart(2, '0')}T00:00:00.000Z`, calibration: null,
  measurements: [point(`2026-11-${String(day).padStart(2, '0')}T00:00:30.000Z`)],
  result: seconds === null ? null : { drainage_time_seconds: seconds, outcome: 'completed' }, ...extra,
});
const baseline = () => [drain('a', 1, 10), drain('b', 2, 10), drain('c', 3, 10)];
const types = alerts => alerts.map(a => `${a.type}:${a.record_id}`);

test('no alerts while a fixture is still learning its baseline', () => {
  assert.deepEqual(buildAlerts([drain('a', 1, 10), drain('b', 2, 60)]), []);
});

test('slow drains are warnings and very slow drains are critical', () => {
  const alerts = buildAlerts([...baseline(), drain('prior', 3, 21, {created_at:'2026-11-03T01:00:00.000Z'}), drain('slow', 4, 22), drain('severe', 5, 45)]);
  assert.deepEqual(types(alerts), ['slow_drain:severe', 'slow_drain:slow']);
  assert.equal(alerts[0].severity, 'critical');
  assert.equal(alerts[1].severity, 'warning');
  assert.equal(alerts[1].details.ratio, 2.2);
  assert.match(alerts[1].message, /2\.2× the usual 10\.0 seconds/);
});

test('a drain still running past three times the baseline is critical', () => {
  const now = Date.parse('2026-11-09T00:01:00.000Z');
  const active = drain('live', 9, null, { recording_status: 'recording', calibration: {empty_distance_mm: 250}, measurements: Array.from({length:61}, (_,i) => point(new Date(now-60000+i*1000).toISOString())) });
  const [first] = buildAlerts([...baseline(), active], now);
  assert.equal(first.type, 'running_too_long');
  assert.equal(first.severity, 'critical');
});

test('steadily rising drain times raise an early warning before they count as slow', () => {
  const alerts = buildAlerts([...baseline(), drain('d', 4, 11), drain('e', 5, 12), drain('f', 6, 13)]);
  assert.deepEqual(types(alerts), ['worsening_trend:f']);
  assert.deepEqual(alerts[0].details.drainage_times_seconds, [11, 12, 13]);
});

test('no trend warning when times fluctuate or are already flagged slow', () => {
  assert.deepEqual(buildAlerts([...baseline(), drain('d', 4, 13), drain('e', 5, 11), drain('f', 6, 14)]), []);
  assert.deepEqual(types(buildAlerts([...baseline(), drain('d', 4, 11), drain('e', 5, 13), drain('f', 6, 16)])), ['worsening_trend:f']);
});

test('unfinished drain times are reported for information only', () => {
  const [uncertain, incomplete] = buildAlerts([...baseline(), drain('u', 4, null, { result: { drainage_time_seconds: null, outcome: 'uncertain' } }), drain('i', 3, null)]);
  assert.equal(uncertain.type, 'unreliable_result');
  assert.equal(uncertain.severity, 'info');
  assert.match(uncertain.message, /irregular readings/);
  assert.equal(incomplete.details.outcome, 'incomplete');
});

test('frequent missing echoes raise a sensor fault warning', () => {
  const measurements = Array.from({ length: 12 }, (_, i) => point(`2026-11-04T00:00:${String(i).padStart(2, '0')}.000Z`, i % 3 !== 0));
  const alerts = buildAlerts([{ ...drain('m', 4, null, { measurements }), record_type: 'monitoring' }]);
  assert.deepEqual(types(alerts), ['sensor_faults:m']);
  assert.equal(alerts[0].details.failed_readings, 4);
  const few = buildAlerts([{ ...drain('few', 4, null, { measurements: measurements.slice(0, 3) }), record_type: 'monitoring' }]);
  assert.deepEqual(few, []);
});

test('an open recording that stops receiving readings is flagged', () => {
  const now = Date.parse('2026-11-04T00:05:00.000Z');
  const quiet = { ...drain('q', 4, null, { recording_status: 'recording' }), record_type: 'monitoring' };
  const empty = { ...drain('e', 4, null, { recording_status: 'recording', measurements: [] }), record_type: 'monitoring' };
  const alerts = buildAlerts([quiet, empty], now);
  assert.deepEqual(alerts.map(a => a.type), ['device_silent', 'device_silent']);
  assert.match(alerts.find(a => a.record_id === 'q').message, /No readings for 5 minutes/);
  assert.match(alerts.find(a => a.record_id === 'e').message, /has not received any readings/);
});

test('alerts are ordered by severity then newest first, with stable ids and counts', () => {
  const alerts = buildAlerts([...baseline(), drain('prior', 3, 21, {created_at:'2026-11-03T01:00:00.000Z'}), drain('w', 4, 22), drain('c1', 5, 45), drain('u', 6, null, { result: { drainage_time_seconds: null, outcome: 'uncertain' } })]);
  assert.deepEqual(alerts.map(a => a.severity), ['critical', 'warning', 'info']);
  assert.equal(alerts[0].alert_id, 'slow_drain:c1');
  assert.deepEqual(summarizeAlerts(alerts), { total: 3, critical: 1, warning: 1, info: 1 });
});

test('baselines and trends never mix fixtures or data sources', () => {
  const tub = { fixture_id: 'tub' }, sim = { data_source: 'simulation' };
  assert.deepEqual(buildAlerts([...baseline(), drain('t', 4, 40, tub), drain('s', 5, 40, sim)]), []);
});

const ADMIN = 'admin-token-that-is-long-enough-for-tests';
const users = { 'alice-session': 'alice-id', 'bob-session': 'bob-id' };
async function start(t) {
  const config = { ...configFromEnv({ STORAGE_BACKEND: 'sqlite', SQLITE_PATH: ':memory:' }), apiKey: ADMIN };
  const store = new SQLiteRecordStore(':memory:');
  const app = createApp(config, store, { verifyUser: async token => users[token] ?? null });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const api = async (path, token, body) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { api, store };
}

test('alerts endpoint filters by fixture, source and severity and validates input', async t => {
  const { api, store } = await start(t);
  for (const row of [...baseline(), drain('prior', 3, 21, {created_at:'2026-11-03T01:00:00.000Z'}), drain('slow', 4, 22), drain('severe', 5, 45), drain('sim', 5, 30, { data_source: 'simulation' })]) {
    await store.insert({ ...row, record_id: randomUUID() });
  }
  const all = await api('/alerts?fixture_id=sink&data_source=sensor', ADMIN);
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.summary, { total: 2, critical: 1, warning: 1, info: 0 });
  assert.deepEqual(all.body.alerts.map(a => a.title), ['Severe slow drain', 'Slow drain']);
  const critical = await api('/alerts?fixture_id=sink&data_source=sensor&severity=critical', ADMIN);
  assert.equal(critical.body.alerts.length, 1);
  assert.equal(critical.body.summary.total, 2);
  assert.equal((await api('/alerts?fixture_id=sink&data_source=sensor&limit=1', ADMIN)).body.alerts.length, 1);
  assert.equal((await api('/alerts?severity=loud', ADMIN)).status, 422);
  assert.equal((await api('/alerts?data_source=pipes', ADMIN)).status, 422);
  assert.equal((await api('/alerts?limit=0', ADMIN)).status, 422);
  assert.equal((await api('/alerts')).status, 401);
});

test('alerts endpoint only shows fixtures the signed-in user can access', async t => {
  const { api, store } = await start(t);
  await api('/devices', 'alice-session', { device_id: 'sink', name: 'Alice sink' });
  for (const row of [...baseline(), drain('slow', 4, 22)]) await store.insert({ ...row, record_id: randomUUID() });
  assert.equal((await api('/alerts', 'alice-session')).body.alerts.length, 0);
  assert.equal((await api('/alerts', 'bob-session')).body.alerts.length, 0);
  assert.equal((await api('/alerts?fixture_id=sink', 'bob-session')).status, 404);
  const key = (await api('/devices/sink/keys', 'alice-session', {})).body.key;
  assert.equal((await api('/alerts', key)).status, 403);
});

test('record list filters and limits do not relearn the baseline', async t => {
  const {api,store} = await start(t);
  const training = baseline().map(r => ({...r,record_id:randomUUID()}));
  for (const row of training) await store.insert(row);
  let latest;
  for (let i=0;i<205;i++) {
    latest = {...drain(randomUUID(),4,45),created_at:new Date(Date.parse('2026-11-04T00:00:00Z')+i*1000).toISOString()};
    await store.insert(latest);
  }
  const list = await api('/records?fixture_id=sink&data_source=sensor&limit=1&recording_status=finished',ADMIN);
  assert.equal(list.body.records.length,1);
  assert.equal(list.body.records[0].drain_status.baseline_seconds,10);
  const detail = await api(`/records/${latest.record_id}`,ADMIN);
  assert.equal(detail.body.computed.drain_status.baseline_seconds,10);
  assert.equal(detail.body.computed.drain_status.timeout_threshold_seconds,40);
});
