import test from 'node:test';import assert from 'node:assert/strict';
import {drainageProfileOf,validateDrainageCalibration,emptyDrainageCalibration,judgeDrainage,matchedBands} from '../../supabase/functions/_shared/drainage-calibration.js';
import {calibrationSnapshot,drainStatuses,statusContext} from '../src/records-domain.js';
import {profiledCalibration,drainPoints,drainRecord,point,time,EMPTY} from './helpers/drainage-fixtures.js';

const clone=value=>structuredClone(value);
test('completing two clear-drain runs stores a per-sink profile with tolerance and thresholds',()=>{
 const drainage=profiledCalibration(1,1.1).calibration.drainage,profile=drainage.profile;
 assert.equal(drainage.version,2);assert.equal(drainage.status,'ready');assert.equal(profile.clear_drain_confirmed,true);
 assert.equal(profile.total.expected_seconds,drainage.baseline_duration_seconds);
 assert.equal(profile.bands.length,4);
 for(const band of profile.bands){assert.ok(band.tolerance_seconds>=profile.noise_seconds);assert.ok(band.tolerance_seconds>=band.variation_seconds);assert.ok(band.slow_seconds>band.expected_seconds*1.5-1e-9);}
 assert.ok(profile.noise_seconds>0,'sampling interval is carried as sensor noise');
 assert.ok(profile.total.slow_seconds>profile.total.expected_seconds&&profile.total.severe_seconds>=profile.total.slow_seconds&&profile.total.standing_water_seconds>=profile.total.severe_seconds);
 assert.deepEqual(validateDrainageCalibration(clone(drainage)),drainage,'stored profile round-trips through validation');
 assert.deepEqual(calibrationSnapshot({empty_distance_mm:EMPTY,drainage}).drainage.profile,profile);
});
test('a fast and a slow sink get different thresholds from the same logic',()=>{
 const fast=profiledCalibration(1).calibration.drainage.profile,slow=profiledCalibration(4).calibration.drainage.profile;
 assert.ok(slow.total.expected_seconds>fast.total.expected_seconds*3);assert.ok(slow.total.slow_seconds>fast.total.slow_seconds*3);
 // The same 8 second drain is a slowdown for the fast sink and routine for the slow one.
 const eight=drainPoints(time,2);
 assert.equal(judgeDrainage(eight,EMPTY,fast).slow,true);assert.equal(judgeDrainage(eight,EMPTY,slow).slow,false);
});
test('matching is by depth band: a drain starting lower is compared only over the bands it covered',()=>{
 const profile=profiledCalibration(1).calibration.drainage.profile,partial=drainPoints(time,1).slice(5);
 assert.deepEqual(matchedBands(partial,EMPTY).map(v=>v===null),[true,false,false,false]);
 const judged=judgeDrainage(partial,EMPTY,profile);assert.equal(judged.bands.length,3);assert.equal(judged.expected_seconds,Math.round(profile.bands.slice(1).reduce((a,b)=>a+b.expected_seconds,0)*1000)/1000);
 assert.equal(judged.slow,false);
 assert.equal(judgeDrainage(drainPoints(time,1).slice(12),EMPTY,profile),null,'no profiled depth observed, so no comparison');
});
test('normal variation and sensor noise stay below the threshold; a significant slowdown crosses it',()=>{
 const profile=profiledCalibration(1,1.1).calibration.drainage.profile,expected=profile.total.expected_seconds;
 for(const scale of[0.9,1,1.15,1.3])assert.equal(judgeDrainage(drainPoints(time,scale),EMPTY,profile).slow,false,`scale ${scale}`);
 const slowed=judgeDrainage(drainPoints(time,2),EMPTY,profile);assert.equal(slowed.slow,true);assert.ok(slowed.observed_seconds>=profile.total.slow_seconds&&slowed.observed_seconds>expected*1.5);
 assert.equal(judgeDrainage(drainPoints(time,5),EMPTY,profile).severe,true);
});
test('profile thresholds replace drains learned in use, and slowdown is flagged singly then as repeated',()=>{
 const profile=profiledCalibration(1,1.1).calibration.drainage.profile;
 // Only the first two uses are normal. Three uses would otherwise teach a baseline; the profile must win.
 const rows=[drainRecord('a',1,1,profile),drainRecord('b',2,2,profile),drainRecord('c',3,1.05,profile),drainRecord('d',4,2.2,profile)];
 const statuses=drainStatuses(rows);
 assert.equal(statuses.get('a').status,'normal');assert.equal(statuses.get('a').baseline_source,'drainage_profile');assert.equal(statuses.get('a').baseline_count,2);
 assert.equal(statuses.get('b').status,'slow_drain');assert.equal(statuses.get('b').repeated_slow,false);
 assert.equal(statuses.get('c').status,'normal');
 assert.equal(statuses.get('d').status,'slow_drain');assert.equal(statuses.get('d').repeated_slow,true,'two slow of the last three');
 assert.ok(statuses.get('d').matched_bands.length>0);
 assert.equal(drainStatuses(rows.map(({drainage_profile,...row})=>row)).get('a').baseline_source,null,'without a profile nothing is taken from the sink profile');
});
test('the sink profile applies only to drains measured against the same empty reference',async()=>{
 const reference=profiledCalibration(1),profile=reference.calibration.drainage.profile;
 const store={list:async filters=>filters.record_type==='calibration'?[reference]:[]};
 const same=drainRecord('same',1,2,undefined),other={...drainRecord('other',2,2,undefined),calibration:{empty_distance_mm:EMPTY+10}};
 const rows=await statusContext(store,[same,other]),byId=Object.fromEntries(rows.map(r=>[r.record_id,r]));
 assert.deepEqual(byId.same.drainage_profile,profile);assert.equal(byId.other.drainage_profile,undefined);
 const statuses=drainStatuses(rows);assert.equal(statuses.get('same').status,'slow_drain');assert.equal(statuses.get('other').baseline_source,null);
 const none=await statusContext({list:async()=>[]},[drainRecord('x',3,2,undefined)]);assert.equal(none[0].drainage_profile,undefined);
});
test('legacy version 1 ready setups derive the same profile without a data rewrite',()=>{
 const current=profiledCalibration(1,1.1).calibration.drainage,{profile,...rest}=current,legacy=validateDrainageCalibration({...rest,version:1});
 assert.equal(legacy.version,1);assert.equal('profile' in legacy,false);
 assert.deepEqual(drainageProfileOf(legacy),profile);
 assert.equal(drainageProfileOf({...legacy,status:'collecting'}),null);
});
test('profile shape is enforced: version 2 needs it once ready, collecting and version 1 must not carry one',()=>{
 const ready=profiledCalibration(1).calibration.drainage;
 const without=clone(ready);delete without.profile;assert.throws(()=>validateDrainageCalibration(without),/profile/);
 assert.throws(()=>validateDrainageCalibration({...clone(ready),profile:null}),/profile/);
 assert.throws(()=>validateDrainageCalibration({...emptyDrainageCalibration(),profile:clone(ready.profile)}),/profile/);
 assert.throws(()=>validateDrainageCalibration({...clone(ready),version:1}),/profile/);
 for(const edit of[p=>{p.clear_drain_confirmed=false;},p=>{p.bands.pop();},p=>{p.total.slow_seconds=p.total.expected_seconds;},p=>{p.policy.repeat_count=1;},p=>{p.extra=1;},p=>{p.bands[0].from_depth_mm=31;}]){
  const bad=clone(ready);edit(bad.profile);assert.throws(()=>validateDrainageCalibration(bad));
 }
 assert.deepEqual(validateDrainageCalibration(emptyDrainageCalibration()),emptyDrainageCalibration());
});
test('alerts follow the profile: one severe slowdown is critical, a mild one waits for repetition',async()=>{
 const {buildAlerts}=await import('../src/alerts.js'),profile=profiledCalibration(1,1.1).calibration.drainage.profile;
 const mild=[drainRecord('a',1,1,profile),drainRecord('b',2,2,profile)];
 assert.equal(buildAlerts(mild).filter(a=>a.type==='slow_drain').length,0,'a single mild slowdown only changes status');
 const repeated=buildAlerts([...mild,drainRecord('c',3,2.2,profile)]).filter(a=>a.type==='slow_drain');
 assert.equal(repeated.length,1);assert.equal(repeated[0].severity,'warning');assert.match(repeated[0].message,/usual/);
 const severe=buildAlerts([drainRecord('a',1,1,profile),drainRecord('s',2,6,profile)]).filter(a=>a.type==='slow_drain');
 assert.equal(severe.length,1);assert.equal(severe[0].severity,'critical');
});
test('email limit for a profiled sink is its own standing-water limit, not the 60 s generic floor',async()=>{
 const {emailTimeLimit}=await import('../../supabase/functions/_shared/email-notifications.js'),{withDrainageProfile}=await import('../src/records-domain.js');
 const reference=profiledCalibration(1),profile=reference.calibration.drainage.profile,store={list:async f=>f.record_type==='calibration'?[reference]:[]};
 const event=await withDrainageProfile(store,drainRecord('e',1,1,undefined));assert.deepEqual(event.drainage_profile,profile);
 const limit=emailTimeLimit([],event);assert.equal(limit.seconds,Math.ceil(profile.total.standing_water_seconds));assert.equal(limit.usual_seconds,profile.total.expected_seconds);
 assert.equal(emailTimeLimit([],drainRecord('n',2,1,undefined)).seconds,120,'without a profile the existing learning limit is unchanged');
 assert.equal((await withDrainageProfile(store,{...drainRecord('m',3,1,undefined),calibration:{empty_distance_mm:EMPTY+5}})).drainage_profile,undefined);
});
test('a capture whose basin never empties ends with a clear message instead of waiting forever',async()=>{
 const {updateDrainageCalibration,validateDrainageAction}=await import('../../supabase/functions/_shared/drainage-calibration.js');
 const {calibrationRecord,monitoring,point,time}=await import('./helpers/drainage-fixtures.js');
 const cal=calibrationRecord(),source=monitoring(),id=crypto.randomUUID();
 const started=updateDrainageCalibration(cal,source,validateDrainageAction({action:'start',recording_id:source.record_id,confirm_tap_off:true,confirm_clear:true}),id,time+1);
 // Water hovers at 12 mm, never reaching the dry level.
 const hover={...source,measurements:[...source.measurements,...Array.from({length:40},(_,i)=>point(time+(i+1)*500,12))]};
 assert.throws(()=>updateDrainageCalibration(started,hover,{action:'complete',capture_id:id},id,time+60000),e=>e.code==='drainage_pending');
 const ended=updateDrainageCalibration(started,hover,{action:'complete',capture_id:id},id,time+601000).calibration.drainage;
 assert.equal(ended.active_capture,null);assert.match(ended.last_issue,/did not finish emptying/);assert.equal(ended.runs.length,0);
});
test('a healthy drain that empties between readings onboards as an instant profile with predetermined floors',async()=>{
 const {instantProfiledCalibration}=await import('./helpers/drainage-fixtures.js');
 for(const seconds of[0.5,1]){
  const drainage=instantProfiledCalibration(seconds).calibration.drainage;
  assert.equal(drainage.status,'ready');assert.equal(drainage.profile.resolution,'instant');assert.equal(drainage.repeatability_ratio,1);
  assert.ok(drainage.baseline_duration_seconds<=3,'stored as an upper bound within a couple of sampling intervals');
  assert.equal(drainage.profile.policy.min_slow_seconds,6);assert.equal(drainage.profile.policy.min_severe_seconds,15);
  assert.equal(drainage.profile.total.slow_seconds,6,'a ~1 s baseline would otherwise warn at noise level');assert.equal(drainage.profile.total.severe_seconds,15);
  assert.deepEqual(validateDrainageCalibration(clone(drainage)),drainage);
 }
});
test('floors keep measured profiles from flagging noise and judge later drains too quick to band',async()=>{
 const {instantProfiledCalibration}=await import('./helpers/drainage-fixtures.js');
 const profile=instantProfiledCalibration(0.5).calibration.drainage.profile,empty=EMPTY;
 // Healthy instant drain, then a drain that takes about 25 s, then a blocked one.
 const quick=drainPoints(time,0.2),clog=drainPoints(time,4),blocked=drainPoints(time,8);
 const healthy=judgeDrainage(quick,empty,profile);assert.equal(healthy.slow,false);
 assert.equal(judgeDrainage(clog,empty,profile).slow,true);assert.equal(judgeDrainage(blocked,empty,profile).severe,true);
 // A band-resolved profile also never warns below the floor.
 const banded=profiledCalibration(1,1.1).calibration.drainage.profile;assert.ok(banded.total.slow_seconds>=6&&banded.total.severe_seconds>=15);assert.equal(banded.resolution,'banded');
 // Below every profiled band: judged by the whole fall against the overall limits instead of "not comparable".
 assert.equal(judgeDrainage(drainPoints(time,1).slice(12),empty,banded),null,'nothing wet enough to time at all');
 const sub=[point(time,45),point(time+500,45),point(time+1000,0),point(time+1500,0),point(time+2000,0)],quickFall=judgeDrainage(sub,empty,banded);
 assert.equal(quickFall.slow,false);assert.ok(quickFall.observed_seconds<=1);
});
test('two runs that differ only within their own sampling uncertainty still agree',async()=>{
 const {updateDrainageCalibration}=await import('../../supabase/functions/_shared/drainage-calibration.js');
 const {captureRun,calibrationRecord,monitoring,point}=await import('./helpers/drainage-fixtures.js');
 const source=monitoring();let first=captureRun(calibrationRecord(),source,time,0.5);
 const base=time+300000,next={...first.observed,measurements:[...first.observed.measurements,point(base)]};
 const second=captureRun(first.finished,next,base,0.8).finished.calibration.drainage;
 assert.equal(second.status,'ready');assert.ok(second.repeatability_ratio>=1&&second.repeatability_ratio<=3);
 assert.ok(updateDrainageCalibration);
});
test('a shallow drain that never covers a profiled band is still judged by its whole fall',()=>{
 const banded=profiledCalibration(1,1.1).calibration.drainage.profile;
 const shallow=(seconds)=>{const n=Math.round(seconds*1000/2000);return[...Array.from({length:n},(_,i)=>point(time+i*2000,14*(1-i/n))),...Array.from({length:4},(_,i)=>point(time+(n+i)*2000,0))];};
 assert.deepEqual(matchedBands(shallow(20),EMPTY),[null,null,null,null]);
 const quick=judgeDrainage(shallow(4),EMPTY,banded),clogged=judgeDrainage(shallow(40),EMPTY,banded);
 assert.equal(quick.slow,false);assert.equal(clogged.slow,true);assert.deepEqual(clogged.bands,[]);
});
// Deterministic jitter so the noise tests never flake.
const jitter=(()=>{let x=11;return(amp)=>{x=(x*1103515245+12345)%2147483648;return((x/2147483648)-.5)*2*amp;};})();
const noisy=(p,amp)=>({...p,sensor:p.sensor.status==='ok'?{...p.sensor,distance_mm:Math.round(p.sensor.distance_mm+jitter(amp))}:p.sensor});
test('empty-sink reference tolerates ordinary sensor noise, a stray echo and an isolated timeout',async()=>{
 const {learnCalibration}=await import('../src/records-domain.js'),{point}=await import('./helpers/drainage-fixtures.js');
 const series=(n,amp)=>Array.from({length:n},(_,i)=>noisy(point(time+i*500,0),amp));
 for(const amp of[1,3,5])assert.ok(learnCalibration(series(24,amp)).calibration,`+-${amp} mm jitter`);
 const withEcho=series(24,2);withEcho[8].sensor.distance_mm=40;withEcho[15].sensor={status:'timeout',distance_mm:null};
 assert.ok(learnCalibration(withEcho).calibration,'one echo and one timeout');
 assert.ok(Math.abs(learnCalibration(withEcho).calibration.empty_distance_mm-300)<=2);
 // Genuine problems still fail: many echoes, a sensor missing a third of its readings, a mount that moves.
 const echoey=series(24,1);for(const i of[3,6,9,12,15])echoey[i].sensor.distance_mm=45;assert.equal(learnCalibration(echoey).calibration,null);
 const lossy=series(30,1);for(const i of[2,5,8,11,14,17,20,23,26])lossy[i].sensor={status:'timeout',distance_mm:null};assert.equal(learnCalibration(lossy).calibration,null);
 assert.match(learnCalibration(lossy).message,/missing too many/);
 const moving=series(24,1).map((p,i)=>({...p,sensor:{...p.sensor,distance_mm:p.sensor.distance_mm-i*2}}));assert.equal(learnCalibration(moving).calibration,null);
});
test('a noisy drain with a stray echo and a timeout still onboards, while a real refill or heavy loss does not',async()=>{
 const {updateDrainageCalibration,validateDrainageAction}=await import('../../supabase/functions/_shared/drainage-calibration.js');
 const {calibrationRecord,monitoring,point,drainPoints,time}=await import('./helpers/drainage-fixtures.js');
 const attempt=edit=>{const cal=calibrationRecord(),source=monitoring(),id=crypto.randomUUID();
  const started=updateDrainageCalibration(cal,source,validateDrainageAction({action:'start',recording_id:source.record_id,confirm_tap_off:true,confirm_clear:true}),id,time+1);
  const measurements=drainPoints(time,1.5).map(p=>noisy(p,3));edit(measurements);
  return updateDrainageCalibration(started,{...source,measurements:[...source.measurements,...measurements]},{action:'complete',capture_id:id},id,time+600000).calibration.drainage;};
 const ok=attempt(m=>{m[5].sensor.distance_mm=40;m[9].sensor={status:'timeout',distance_mm:null};});assert.equal(ok.runs.length,1);assert.equal(ok.last_issue,null);
 const refill=attempt(m=>{for(const i of[9,10,11])m[i].sensor.distance_mm=m[i].sensor.distance_mm-20;});assert.equal(refill.runs.length,0);assert.match(refill.last_issue,/rose/);
 const lossy=attempt(m=>{for(const i of[3,5,7,9,11])m[i].sensor={status:'timeout',distance_mm:null};});assert.equal(lossy.runs.length,0);assert.match(lossy.last_issue,/unreliable|interrupted/);
});
test('starting a drainage check is not blocked by a timeout or invalid latest reading',async()=>{
 const {updateDrainageCalibration,validateDrainageAction}=await import('../../supabase/functions/_shared/drainage-calibration.js');
 const {calibrationRecord,monitoring,point,time}=await import('./helpers/drainage-fixtures.js');
 const cal=calibrationRecord(),source={...monitoring(),measurements:[point(time,45),point(time+500,45),{...point(time+1000,45),sensor:{status:'timeout',distance_mm:null}}]};
 const started=updateDrainageCalibration(cal,source,validateDrainageAction({action:'start',recording_id:source.record_id,confirm_tap_off:true,confirm_clear:true}),crypto.randomUUID(),time+1200);
 assert.equal(started.calibration.drainage.active_capture.from_reading_id,source.measurements[1].reading_id);
 assert.throws(()=>updateDrainageCalibration(cal,{...source,measurements:[point(time,10),point(time+500,10)]},validateDrainageAction({action:'start',recording_id:source.record_id,confirm_tap_off:true,confirm_clear:true}),crypto.randomUUID(),time+700),e=>e.code==='water_not_ready');
});
