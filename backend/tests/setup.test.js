import test from 'node:test';
import assert from 'node:assert/strict';
import {setupGuidance,monitoringEvents,learnCalibration,computedView} from '../src/records-domain.js';
import {buildAlerts} from '../src/alerts.js';
const now=Date.parse('2026-11-12T12:00:00Z');
const point=(id,depth,offset=0,failed=false)=>({reading_id:id,timestamp:new Date(now+offset).toISOString(),sensor:failed?{status:'timeout',distance_mm:null}:{status:'ok',distance_mm:300-depth}});
const record=(points,calibration={empty_distance_mm: 300})=>({record_id:'setup-water-check',fixture_id:'sink',data_source:'sensor',record_type:'monitoring',recording_status:'recording',created_at:new Date(now-10000).toISOString(),calibration,measurements:points,result:null});
test('water check needs empty calibration and fresh sensor evidence, not a guessed fill level',()=>{
 assert.equal(setupGuidance(record([],null),now).phase,'needs_calibration');
 assert.equal(setupGuidance(record([]),now).phase,'waiting');
 for(const p of [point('old',50,-15000),point('future',50,1000),point('failed',50,0,true)])assert.equal(setupGuidance(record([p]),now).phase,'sensor_problem');
 assert.equal(setupGuidance(record([point('low',10)]),now).phase,'add_water');
 assert.equal(setupGuidance(record([point('ready',40)]),now).phase,'confirm_water');
 assert.equal(setupGuidance(record([point('first',40),point('duplicate-time',41)]),now).phase,'confirm_water');
 assert.equal(setupGuidance(record([point('expired',40,-5100)]),now).phase,'sensor_problem');
 const ready=setupGuidance(record([point('first',40,-500),point('ready',40)]),now);
 assert.equal(ready.phase,'water_ready');assert.match(ready.message,/Turn the tap off/);assert.equal(ready.water_depth_mm,40);
});
test('setup requires three distinct and steady readings from a fresh batch without changing connection status', () => {
 const newest=Date.now()-500;
 const sample=(id,depth,ms,failed=false)=>({...point(id,depth,0,failed),timestamp:new Date(newest+ms).toISOString()});
 const a=sample('A',0,-1000), b=sample('B',2,-500), c=sample('C',4,0);
 assert.equal(computedView(record([c])).setup_signal,'checking');
 assert.equal(computedView(record([a,{...b,timestamp:c.timestamp},c])).setup_signal,'checking');
 assert.equal(computedView(record([a,b,sample('C',20,0)])).setup_signal,'unstable');
 assert.equal(computedView(record([a,sample('B',0,-500,true),c])).setup_signal,'unstable');
 assert.equal(computedView(record([a,b,c])).setup_signal,'steady');
 const batch = [-7000, -6500, -6000].map((offset, i) => sample(String(i), 0, offset));
 assert.equal(computedView(record(batch)).setup_signal,'steady');
 assert.equal(computedView(record([sample('old',0,-6000)])).setup_signal,'checking');
 assert.equal(computedView(record([sample('old',0,-13000)])).setup_signal,'stale');
});
test('running water cannot substitute for the empty-basin reference',()=>{
 const filling=Array.from({length:20},(_,i)=>point(String(i),i*3,-10000+i*500));
 assert.equal(learnCalibration(filling).calibration,null);
 const empty=Array.from({length:20},(_,i)=>point(String(i),0,-10000+i*500));
 assert.deepEqual(learnCalibration(empty).calibration,{empty_distance_mm: 300});
});
test('three copies of a dry timestamp cannot end a monitored cycle',()=>{
 const samples=[point('wet',50,-3000),point('dry-1',0),point('dry-2',0),point('dry-3',0)];
 assert.equal(monitoringEvents(record(samples))[0].recording_status,'recording');
});
test('finishing a water-preparation window does not send an untimed-drain alert',()=>{
 const prep={...record([point('wet',50,-1000),point('still-wet',50)]),recording_status:'finished'};
 assert.deepEqual(buildAlerts([prep],now),[]);
});

test('healthy continuous drains tolerate ordinary cadence jitter and occasional missing echoes without clog alerts',()=>{
 const calibration={empty_distance_mm: 300};
 const training=[0,1,2].map(i=>({...record([point(`b${i}`,50,-1000000+i*1000)]),record_id:`b${i}`,record_type:'drainage',recording_status:'finished',created_at:new Date(now-1000000+i*1000).toISOString(),result:{outcome:'completed',drainage_time_seconds:20}}));
 for(let seed=1;seed<=50;seed++){
  let state=seed;const random=()=>{state=(state*1664525+1013904223)>>>0;return state/2**32;};
  const samples=[];let elapsed=0;
  for(let i=0;i<60;i++){
   const depth=i>=44?0:Math.max(0,50*(1-i/44)+(random()-.5)*2);
   samples.push(point(`${seed}-${i}`,depth,-40000+elapsed,i>0&&i<40&&random()<.04));elapsed+=450+random()*100;
  }
  const row={...record(samples,calibration),record_id:`healthy-${seed}`,recording_status:'finished'};
  assert.ok(!buildAlerts([...training,row],now).some(a=>a.severity==='critical'),`Healthy cycle ${seed} was critical`);
 }
});

test('connection checks expire before the longer graph stale timeout',()=>{
 const row=record([point('last',50)]);
 row.measurements[0].timestamp=new Date(Date.now()-13000).toISOString();
 const view=computedView(row);
 assert.equal(view.sensor_connection,'stale');
 assert.equal(view.setup_guidance.phase,'sensor_problem');
});

test('a reading up to 12 s old still counts as connected, because the board uploads every ~5 s', () => {
 for (const age of [1, 6, 9, 11]) {
  const row = record([point('last', 50)]);
  row.measurements[0].timestamp = new Date(Date.now() - age * 1000).toISOString();
  assert.equal(computedView(row).sensor_connection, 'connected', `${age} s old`);
 }
 const row = record([point('last', 50)]);
 row.measurements[0].timestamp = new Date(Date.now() - 13000).toISOString();
 assert.equal(computedView(row).sensor_connection, 'stale', 'but not forever');
});
