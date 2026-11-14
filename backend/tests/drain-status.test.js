import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drainStatuses, monitoringEvents } from '../src/records-domain.js';

const drain = (id, day, seconds, extra = {}) => ({ record_id: id, fixture_id: 'sink', data_source: 'sensor', record_type: 'drainage', recording_status: 'finished', created_at: `2026-11-0${day}T00:00:00.000Z`, measurements: [], result: seconds === null ? null : { drainage_time_seconds: seconds, outcome: 'completed' }, ...extra });

test('drain status needs three completed drains before labelling', () => {
  const statuses = drainStatuses([drain('a', 1, 10), drain('b', 2, 30)]);
  assert.equal(statuses.get('a').status, 'learning');
  assert.equal(statuses.get('b').baseline_seconds, null);
});

test('drain status compares against the earliest completed drains', () => {
  const statuses = drainStatuses([drain('a', 1, 10), drain('b', 2, 12), drain('c', 3, 11), drain('d', 4, 20), drain('e', 5, 22)]);
  assert.equal(statuses.get('a').baseline_seconds, 11);
  assert.equal(statuses.get('d').status, 'normal');
  assert.equal(statuses.get('e').status, 'slow_drain');
});

test('live timeouts require fresh, continuous wet readings, and respect the minimum margin', () => {
  const now = Date.parse('2026-11-09T00:01:00.000Z');
  const calibration = {empty_distance_mm: 250};
  const active = (id, length, stale = 0) => drain(id, 9, null, {recording_status:'recording', calibration,
    measurements:Array.from({length},(_,i) => ({reading_id:`${id}-${i}`, timestamp:new Date(now - stale - (length-1-i)*1000).toISOString(), sensor:{status:'ok',distance_mm:200}}))});
  const statuses = drainStatuses([drain('a',1,10),drain('b',2,10),drain('c',3,10),active('slow',41),active('fresh',31),active('stale',61,10000)],now);
  assert.equal(statuses.get('slow').status, 'running_too_long');
  assert.equal(statuses.get('slow').timeout_threshold_seconds, 40);
  assert.equal(statuses.get('fresh').status, 'in_progress');
  assert.equal(statuses.get('stale').status, 'unknown');
});

test('baselines are kept separate per fixture and data source', () => {
  const other = { fixture_id: 'tub' };
  const statuses = drainStatuses([drain('a', 1, 10), drain('b', 2, 10), drain('c', 3, 10), drain('t', 4, 40, other)]);
  assert.equal(statuses.get('t').status, 'learning');
});

test('baseline rejects inconsistent training and then freezes the first consistent window', () => {
  const rows = [drain('a',1,10),drain('b',2,40),drain('c',3,20),drain('d',4,21),drain('e',5,22),drain('f',6,80)];
  const status = drainStatuses(rows).get('f');
  assert.equal(status.baseline_seconds,21);
  assert.deepEqual(status.baseline_record_ids,['c','d','e']);
  assert.equal(status.timeout_threshold_seconds,63);
  assert.equal(drainStatuses(rows.slice(0,3)).get('c').status,'learning');
});

test('zero and uncertain results cannot establish a baseline', () => {
  const rows = [drain('a',1,0),drain('b',2,10),drain('c',3,10)];
  assert.equal(drainStatuses(rows).get('c').baseline_seconds,null);
});

test('two of the last three post-setup slow drains confirm a maintenance warning', () => {
  const rows = [drain('a',1,20),drain('b',2,20),drain('c',3,20),drain('d',4,32),drain('e',5,22),drain('f',6,34)];
  const statuses = drainStatuses(rows);
  assert.equal(statuses.get('d').repeated_slow,false);
  assert.equal(statuses.get('f').repeated_slow,true);
});

test('water evidence, gaps and fill level control live classification', () => {
  const now = Date.parse('2026-11-09T00:01:00Z');
  const calibration = {empty_distance_mm: 250};
  const sample = (offset, depth=50) => ({reading_id:String(offset),timestamp:new Date(now+offset*1000).toISOString(),sensor:{status:'ok',distance_mm:250-depth}});
  const rows = [1,2,3].map(i => drain(String(i),i,10,{calibration,measurements:[sample(-60)]}));
  const live = (id, measurements) => drain(id,9,null,{calibration,measurements,recording_status:'recording'});
  const all = [...rows,live('dry',[sample(-60,0),sample(0,0)]),live('gap',[sample(-60),sample(0)]),live('different',Array.from({length:61},(_,i)=>sample(i-60,100))),live('failed',[sample(-60),{...sample(0),sensor:{status:'timeout',distance_mm:null}}])];
  const statuses = drainStatuses(all,now);
  assert.equal(statuses.get('dry').status,'in_progress');
  for (const id of ['gap','different','failed']) assert.equal(statuses.get(id).status,'unknown');
});

test('continuous monitoring follows initial filling, flags standing water and separates later cycles', () => {
  const now=Date.parse('2026-11-09T00:02:00Z'), calibration={empty_distance_mm: 250};
  const point=(second,depth)=>({reading_id:`p-${second}`,timestamp:new Date(now-120000+second*1000).toISOString(),sensor:{status:'ok',distance_mm:250-depth}});
  const training=[1,2,3].map(i=>drain(`b${i}`,i,20,{calibration,measurements:[point(0,50)]}));
  const measurements=Array.from({length:121},(_,i)=>point(i,i<10?i*5:50));
  const row={...drain('monitor',9,null),record_type:'monitoring',recording_status:'recording',calibration,measurements};
  const status=drainStatuses([...training,row],now).get('monitor');
  assert.equal(status.status,'running_too_long');
  assert.equal(status.baseline_seconds,20);
  assert.equal(status.elapsed_seconds,110);
  const events=monitoringEvents(row),stableId=events[0].record_id;
  const finished={...row,measurements:[...measurements,point(121,0),point(122,0),point(123,0)]};
  assert.equal(monitoringEvents(finished)[0].record_id,stableId);
  const again={...finished,measurements:[...finished.measurements,point(124,50),point(125,50)]};
  assert.equal(monitoringEvents(again).length,2);
  assert.equal(drainStatuses([...training,again],now+5000).get('monitor').status,'in_progress');
  assert.equal(drainStatuses([...training,again],now+5000).get('monitor').baseline_seconds,20);
});
