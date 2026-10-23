import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forecastDrainage, drainageTimeSeries } from '../../web/lib/forecast.ts';
import { learnEmptyFixture } from '../../web/lib/calibration.ts';

const calibration = { id: 'test-cal', empty_distance_mm: { a: 400, b: 420 }, dry_threshold_mm: 8, wet_threshold_mm: 20, stable_samples: 3, max_gap_ms: 5000 };
function frames(count = 20, step = 500, depth = i => 100 - i * 2) {
  return Array.from({ length: count }, (_, i) => ({ event_id: `event-${i}`, device_id: 'test', boot_id: 'boot', sequence: i, source: 'hardware', calibration_id: 'test-cal', time_basis: 'device_clock', measured_at: new Date(i * step).toISOString(), received_at: new Date(i * step).toISOString(), levels: ['a', 'b'].map(sensor_id => ({ sensor_id, status: 'ok', quality: 'ok', distance_mm: calibration.empty_distance_mm[sensor_id] - depth(i), depth_mm: depth(i) })) }));
}
test('forecast extrapolates observed depth slope to tolerance, using the slower sensor', () => {
  const data = frames();
  const result = forecastDrainage(data, calibration, false);
  assert.equal(result.state, 'forecast');
  assert.equal(result.remaining, (62 - 8) / 4);
  for (const f of data) f.levels[1].depth_mm = 100 - f.sequence;
  const slower = forecastDrainage(data, calibration, false);
  assert.equal(slower.remaining, (81 - 8) / 2);
});
test('forecast refuses missing, stale, uncalibrated, rising, flat and discontinuous evidence', () => {
  assert.equal(forecastDrainage(frames(), calibration, true).state, 'withheld');
  assert.equal(forecastDrainage(frames(), null, false).state, 'withheld');
  assert.equal(forecastDrainage(frames(4), calibration, false).state, 'withheld');
  assert.equal(forecastDrainage(frames(20, 500, i => 10 + i), calibration, false).state, 'withheld');
  assert.equal(forecastDrainage(frames(20, 500, () => 80), calibration, false).state, 'withheld');
  for (const mutate of [
    f => { f.at(-1).levels[1].quality = 'timeout'; f.at(-1).levels[1].depth_mm = null; },
    f => { f.at(-1).calibration_id = 'other'; },
    f => { f.at(-2).boot_id = 'other'; },
    f => { f.at(-2).time_basis = 'server_received'; },
    f => { f.at(-2).source = 'mock'; },
    f => { f.at(-2).sequence = 50; },
    f => { f.at(-2).measured_at = f.at(-1).measured_at; },
  ]) { const data = frames(); mutate(data); assert.equal(forecastDrainage(data, calibration, false).state, 'withheld'); }
});
test('dry confirmation requires both sensors and consecutive valid observations', () => {
  assert.equal(forecastDrainage(frames(20, 500, () => 0), calibration, false).state, 'dry');
  const data = frames(); data.at(-1).levels.forEach(l => { l.depth_mm = 0; });
  assert.equal(forecastDrainage(data, calibration, false).state, 'withheld');
  data.at(-1).levels[1].quality = 'timeout';
  assert.notEqual(forecastDrainage(data, calibration, false).state, 'dry');
});
test('guided calibration learns per-sensor references and rejects contaminated samples', () => {
  const data = frames(20, 500, () => 0);
  const learned = learnEmptyFixture(data, 0, 'hardware');
  assert.deepEqual(learned.calibration.empty_distance_mm, { a: 400, b: 420 });
  assert.equal(learned.calibration.source, 'hardware');
  assert.equal(learned.noise.a, 0);
  assert.equal(learnEmptyFixture(data, 0, 'mock').calibration, null);
  assert.equal(learnEmptyFixture(data, 5000, 'hardware').calibration, null);
  assert.equal(learnEmptyFixture(data.slice(0, 10), 0, 'hardware').calibration, null);
  const noisy = structuredClone(data); noisy[4].levels[1].distance_mm = 430;
  assert.equal(learnEmptyFixture(noisy, 0, 'hardware').calibration, null);
  const invalid = structuredClone(data); invalid[10].levels[1].status = 'timeout';
  assert.equal(learnEmptyFixture(invalid, 0, 'hardware').calibration, null);
  const reboot = structuredClone(data); reboot[10].boot_id = 'reboot';
  assert.equal(learnEmptyFixture(reboot, 0, 'hardware').calibration, null);
});
test('calibration supports high-frequency streams without shrinking the time window', () => {
  assert.ok(learnEmptyFixture(frames(181, 50, () => 0), 0, 'hardware').calibration);
  assert.equal(learnEmptyFixture(frames(20, 50, () => 0), 0, 'hardware').calibration, null);
});

test('time plot uses only observations available at each point and keeps unknown estimates as gaps', () => {
  const data = frames();
  const timeline = drainageTimeSeries(data, calibration);
  assert.equal(timeline[0].x, 0);
  assert.equal(timeline[0].y, null);
  assert.equal(timeline.at(-1).y, forecastDrainage(data, calibration, false).remaining);
  assert.equal(timeline[8].y, drainageTimeSeries(data.slice(0, 9), calibration).at(-1).y);
  const stale = drainageTimeSeries(data, calibration, true);
  assert.equal(stale.at(-1).y, null);
  assert.equal(stale[8].y, timeline[8].y);
  const missing = structuredClone(data); missing[10].levels[1].quality = 'timeout'; missing[10].levels[1].depth_mm = null;
  assert.equal(drainageTimeSeries(missing, calibration)[10].y, null);
});
test('time plot waits for water and reaches zero only after valid dry confirmation', () => {
  assert.deepEqual(drainageTimeSeries(frames(20, 500, () => 0), calibration), []);
  assert.deepEqual(drainageTimeSeries(frames(), null), []);
  const data = frames(30, 500, i => Math.max(0, 100 - i * 5));
  assert.equal(drainageTimeSeries(data, calibration).at(-1).y, 0);
});
