import test from 'node:test';
import assert from 'node:assert/strict';
import { compactTimeline, completedDrains, selectDeviceRecord } from '../lib/chart-data.ts';

function record(overrides = {}) {
  return { record_id: 'old-drain', fixture_id: 'sink', record_type: 'drainage', data_source: 'sensor', recording_status: 'finished', created_at: '2026-11-10T12:00:00Z', calibration: null, result: { outcome: 'completed', drainage_time_seconds: 24.5 }, measurement_count: 10, drain_status: null, ...overrides };
}

test('compresses a long outage without changing real elapsed labels or normal spacing', () => {
  const result = compactTimeline([0, 1, 2, 3602, 3603]);
  assert.deepEqual(result.map(p => p.position), [0, 1, 2, 7, 8]);
  assert.deepEqual(result.map(p => p.time), [0, 1, 2, 3602, 3603]);
  assert.deepEqual(result.map(p => p.gap), [false, false, false, true, false]);
  assert.equal(result[3].missingSeconds, 3600);
  assert.deepEqual(compactTimeline([]), []);
  assert.equal(compactTimeline([12])[0].position, 0);
});

test('device opens active monitoring before an old completed drain; explicit history choice wins', () => {
  const records = [record(), record({ record_id: 'live', record_type: 'monitoring', recording_status: 'recording', created_at: '2026-11-10T13:00:00Z', result: null })];
  assert.equal(selectDeviceRecord(records), 'live');
  assert.equal(selectDeviceRecord(records, 'old-drain'), 'old-drain');
  assert.equal(selectDeviceRecord(records, 'deleted'), 'live');
  assert.equal(selectDeviceRecord([]), '');
  assert.equal(selectDeviceRecord([record(), record({ record_id: 'new', created_at: '2026-11-10T14:00:00Z' })]), 'new');
});

test('drain duration chart includes only valid completed drain results in its date range', () => {
  const records = [record(), record({ record_type: 'monitoring' }), record({ recording_status: 'recording' }), record({ result: null }), record({ result: { outcome: 'uncertain', drainage_time_seconds: 30 } }), record({ result: { outcome: 'completed', drainage_time_seconds: null } }), record({ result: { outcome: 'completed', drainage_time_seconds: NaN } }), record({ created_at: '2026-01-01T00:00:00Z' }), record({ created_at: '2027-01-01T00:00:00Z' })];
  assert.deepEqual(completedDrains(records, 30, Date.parse('2026-11-10T20:00:00Z')), [records[0]]);
});

test('incremental live updates retain graph history and replace it when the cursor is no longer valid',async()=>{
 const {mergeLiveView}=await import('../lib/chart-data.ts');
 const view=(ids,mode='replace')=>({record:{record_id:'live',measurements:ids.map(i=>({reading_id:String(i),timestamp:new Date(i*1000).toISOString()}))},computed:{series_mode:mode,sample_count:10,timeline:ids.map(i=>({elapsed_seconds:i,seconds_remaining:i})),water_levels:ids.map(i=>({elapsed_seconds:i,depth_mm:i,gap_before:false}))}});
 const initial=view([1,2]),next=mergeLiveView(initial,view([3],'append'));assert.deepEqual(next.record.measurements.map(p=>p.reading_id),['1','2','3']);assert.equal(next.computed.sample_count,10);assert.equal(mergeLiveView(next,view([],'append')).record.measurements.length,3);assert.equal(mergeLiveView(next,view([3],'replace')).record.measurements.length,1);assert.equal(mergeLiveView(next,view([3,4],'append'),2).record.measurements.length,2);
});
