import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {monitoringEvents,drainStatuses,emptyLevelShift,dropEchoes} from '../src/records-domain.js';
import {buildAlerts} from '../src/alerts.js';
import {point,time,EMPTY,DRAIN_DEPTHS} from './helpers/drainage-fixtures.js';
const row=(measurements,extra={})=>({record_id:randomUUID(),fixture_id:'sink',data_source:'sensor',record_type:'monitoring',recording_status:'recording',schema_version:2,calibration:{empty_distance_mm:EMPTY},measurements,result:null,created_at:new Date(time).toISOString(),...extra});
const idle=(n,depth=0,every=500,start=time)=>Array.from({length:n},(_,i)=>point(start+i*every,depth+((i*7)%5-2)*.6));
const echo=(p,distance)=>({...p,sensor:{status:'ok',distance_mm:distance}});

test('stray echoes in an idle sink no longer start phantom drain events',()=>{
 const m=idle(120);for(const i of[10,31,50,77,100])m[i]=echo(m[i],45);          // short echoes read as 255 mm of water
 m[20]=echo(m[20],3422);m[60]=echo(m[60],4000);                                   // long echoes beyond the basin
 assert.equal(monitoringEvents(row(m)).length,0);
 assert.ok(dropEchoes(m,{empty_distance_mm:EMPTY}).length<=m.length-7);
});
test('a real drain with an echo and a timeout inside is still one completed event',()=>{
 const m=[...idle(6,0,500,time),...DRAIN_DEPTHS.map((d,i)=>point(time+3000+i*500,d)),...idle(20,0,500,time+12500)];
 m[12]=echo(m[12],40);m[16]={...m[16],sensor:{status:'timeout',distance_mm:null}};
 const events=monitoringEvents(row(m)).filter(e=>e.recording_status==='finished');
 assert.equal(events.length,1);assert.equal(events[0].result.outcome,'completed');
});
test('a stable offset while idle is reported as a shifted empty level; deep water and noise are not',()=>{
 assert.equal(emptyLevelShift(row(idle(100))),null,'normal idle');
 const warm=emptyLevelShift(row(idle(100,12)));assert.ok(warm&&Math.abs(warm.shift_mm-12)<1.5,JSON.stringify(warm));
 const cold=emptyLevelShift(row(idle(100,-15)));assert.ok(cold&&cold.shift_mm<-10);
 assert.equal(emptyLevelShift(row(idle(100,45))),null,'a filled sink is not a shift');
 assert.equal(emptyLevelShift(row(idle(100,12).slice(0,30))),null,'too short to judge');
 const moving=idle(100,0).map((p,i)=>point(time+i*500,i*0.4));assert.equal(emptyLevelShift(row(moving)),null,'level moving');
 assert.equal(emptyLevelShift(row(idle(100,12),{record_type:'drainage'})),null);
});
test('the shift surfaces in status, fleet-facing field and alerts',()=>{
 const now=time+49500,r=row(idle(100,12));
 const status=drainStatuses([r],now).get(r.record_id);
 assert.ok(Math.abs(status.empty_shift_mm-12)<1.5);assert.match(status.message,/above the saved empty level/);
 const alert=buildAlerts([r],now).find(a=>a.type==='empty_level_shift');
 assert.ok(alert);assert.equal(alert.severity,'warning');assert.match(alert.message,/record the empty sink again/);
 assert.equal(buildAlerts([row(idle(100))],now).some(a=>a.type==='empty_level_shift'),false);
 assert.equal(drainStatuses([row(idle(100))],now).get(r.record_id)?.empty_shift_mm??null,null);
});
