import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drainStatuses } from '../src/records-domain.js';

const drain = (id, day, seconds, extra = {}) => ({ record_id: id, fixture_id: 'sink', data_source: 'sensor', record_type: 'drainage', recording_status: 'finished', created_at: `2026-11-0${day}T00:00:00.000Z`, measurements: [], result: seconds === null ? null : { drainage_time_seconds: seconds, outcome: 'completed' }, ...extra });

test('drain status needs three completed drains before labelling', () => {
  const statuses = drainStatuses([drain('a', 1, 10), drain('b', 2, 30)]);
  assert.equal(statuses.get('a').status, 'learning');
  assert.equal(statuses.get('b').baseline_seconds, null);
});

test('drain status compares against the earliest completed drains', () => {
  const statuses = drainStatuses([drain('a', 1, 10), drain('b', 2, 12), drain('c', 3, 11), drain('d', 4, 16), drain('e', 5, 17)]);
  assert.equal(statuses.get('a').baseline_seconds, 11);
  assert.equal(statuses.get('d').status, 'normal');
  assert.equal(statuses.get('e').status, 'slow_drain');
});

test('an active drain running past three times the baseline is flagged', () => {
  const now = Date.parse('2026-11-09T00:01:00.000Z');
  const active = (id, start) => drain(id, 9, null, { recording_status: 'recording', measurements: [{ reading_id: id, timestamp: start }] });
  const statuses = drainStatuses([drain('a', 1, 10), drain('b', 2, 10), drain('c', 3, 10), active('slow', '2026-11-09T00:00:00.000Z'), active('fresh', '2026-11-09T00:00:50.000Z')], now);
  assert.equal(statuses.get('slow').status, 'running_too_long');
  assert.equal(statuses.get('fresh').status, 'in_progress');
});

test('baselines are kept separate per fixture and data source', () => {
  const other = { fixture_id: 'tub' };
  const statuses = drainStatuses([drain('a', 1, 10), drain('b', 2, 10), drain('c', 3, 10), drain('t', 4, 40, other)]);
  assert.equal(statuses.get('t').status, 'learning');
});
