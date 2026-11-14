import {randomUUID} from 'node:crypto';
import {analyzeDrainage} from '../../src/records-domain.js';
import {updateDrainageCalibration,validateDrainageAction} from '../../../supabase/functions/_shared/drainage-calibration.js';
export const time=Date.parse('2026-11-12T12:00:00Z');
export const EMPTY=300;
export const point=(ms,depth=40)=>({reading_id:randomUUID(),timestamp:new Date(ms).toISOString(),sensor:{distance_mm:EMPTY-depth,status:'ok'}});
export const calibrationRecord=()=>({record_id:randomUUID(),fixture_id:'sink',data_source:'sensor',record_type:'calibration',recording_status:'finished',schema_version:2,calibration:{empty_distance_mm:EMPTY},measurements:[],result:null,created_at:new Date(time-20000).toISOString()});
export const monitoring=(base=time)=>({record_id:randomUUID(),fixture_id:'sink',data_source:'sensor',record_type:'monitoring',recording_status:'recording',calibration:{empty_distance_mm:EMPTY},measurements:[point(base)],result:null,created_at:new Date(base).toISOString()});
// Fill to 40 mm, then fall through 30..10 mm; scale stretches time so a sink can be fast or slow.
export const DRAIN_DEPTHS=[40,36,32,30,27.5,25,22.5,20,17.5,15,12.5,10,7.5,5,2.5,0,0,0];
export const drainPoints=(base,scale=1)=>DRAIN_DEPTHS.map((depth,i)=>point(base+(i+1)*500*scale,depth));
export const withDrain=(record,base,scale=1)=>({...record,measurements:[...record.measurements,...drainPoints(base,scale)]});
// One confirmed tap-off run on a clear drain.
export function captureRun(cal,source,base,scale){
 const id=randomUUID(),started=updateDrainageCalibration(cal,source,validateDrainageAction({action:'start',recording_id:source.record_id,confirm_tap_off:true,confirm_clear:true}),id,base+1);
 const observed=withDrain(source,base,scale);
 return{observed,finished:updateDrainageCalibration(started,observed,{action:'complete',capture_id:id},id,base+600000)};
}
// A finished empty reference whose drainage profile came from two runs at `scale` and `scale*secondScale`.
export function profiledCalibration(scale=1,secondScale=1.1){
 let source=monitoring(),first=captureRun(calibrationRecord(),source,time,scale);
 const base=time+300000;source={...first.observed,measurements:[...first.observed.measurements,point(base)]};
 return captureRun(first.finished,source,base,scale*secondScale).finished;
}
// A finished explicit drainage record measured against the same empty reference.
export const drainRecord=(id,day,scale,profile,extra={})=>{
 const base=Date.parse(`2026-11-0${day}T00:00:00Z`),measurements=drainPoints(base,scale);
 return{record_id:id,fixture_id:'sink',data_source:'sensor',record_type:'drainage',recording_status:'finished',schema_version:2,created_at:new Date(base).toISOString(),calibration:{empty_distance_mm:EMPTY},measurements,
  result:analyzeDrainage(measurements,{empty_distance_mm:EMPTY}).result,drainage_profile:profile,...extra};
};
// A drain that empties between two readings: fill, then dry almost at once.
export function instantRun(cal,source,base,seconds=0.5){
 const id=randomUUID(),lead=[...source.measurements];
 const started=updateDrainageCalibration(cal,source,validateDrainageAction({action:'start',recording_id:source.record_id,confirm_tap_off:true,confirm_clear:true}),id,base+1);
 const steps=Math.max(1,Math.round(seconds*2)),after=[...Array.from({length:steps},(_,i)=>point(base+(i+1)*500,45*(1-(i+1)/(steps+1)))),...Array.from({length:6},(_,i)=>point(base+(steps+1+i)*500,0))];
 const observed={...source,measurements:[...lead,...after]};
 return{observed,finished:updateDrainageCalibration(started,observed,{action:'complete',capture_id:id},id,base+600000)};
}
export function instantProfiledCalibration(seconds=0.5){
 let source={...monitoring(),measurements:[point(time,45),point(time+500,45)]},first=instantRun(calibrationRecord(),source,time+500,seconds);
 const base=time+300000;source={...first.observed,measurements:[...first.observed.measurements,point(base,45),point(base+500,45)]};
 return instantRun(first.finished,source,base+500,seconds).finished;
}
