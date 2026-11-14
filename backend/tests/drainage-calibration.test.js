import test from 'node:test';import assert from 'node:assert/strict';import{randomUUID}from'node:crypto';
import{updateDrainageCalibration,validateDrainageAction,validateDrainageCalibration,emptyDrainageCalibration}from'../../supabase/functions/_shared/drainage-calibration.js';
import{calibrationSnapshot,validateMeasurement}from'../src/records-domain.js';
const time=Date.parse('2026-11-12T12:00:00Z');
const point=(ms,depth=40)=>({reading_id:randomUUID(),timestamp:new Date(ms).toISOString(),sensor:{distance_mm:300-depth,status:'ok'}});
const calibration=()=>({record_id:randomUUID(),fixture_id:'sink',data_source:'sensor',record_type:'calibration',recording_status:'finished',schema_version:2,calibration:{empty_distance_mm:300},measurements:[],result:null,created_at:new Date(time-20000).toISOString()});
const monitoring=(base=time,record_id=randomUUID())=>({record_id,fixture_id:'sink',data_source:'sensor',record_type:'monitoring',recording_status:'recording',calibration:{empty_distance_mm:300},measurements:[point(base)],result:null,created_at:new Date(base).toISOString()});
function drain(record,base=time,scale=1){const levels=[40,36,32,30,27.5,25,22.5,20,17.5,15,12.5,10,7.5,5,2.5,0,0,0];return{...record,measurements:[...record.measurements,...levels.map((depth,i)=>point(base+(i+1)*500*scale,depth))]};}
function run(cal,source,base=time,scale=1){const id=randomUUID();const started=updateDrainageCalibration(cal,source,validateDrainageAction({action:'start',recording_id:source.record_id,confirm_tap_off:true,confirm_clear:true}),id,base+1);const observed=drain(source,base,scale);const finished=updateDrainageCalibration(started,observed,{action:'complete',capture_id:id},id,base+20000);return{started,finished,observed,id};}

test('drainage calibration extends the existing empty reference, uses matched depths and requires two repeatable runs',()=>{
 const cal=calibration(),source=monitoring(),original=structuredClone(source),first=run(cal,source);
 assert.deepEqual(source,original);assert.equal(first.finished.calibration.empty_distance_mm,300);assert.equal(first.finished.calibration.drainage.status,'collecting');assert.equal(first.finished.calibration.drainage.runs.length,1);
 assert.equal(first.finished.calibration.drainage.runs[0].duration_seconds,4);assert.equal(first.finished.calibration.drainage.runs[0].recession_mm_per_second,5);
 const secondBase=time+30000,secondSource={...first.observed,measurements:[...first.observed.measurements,point(secondBase)]};const second=run(first.finished,secondSource,secondBase,1.1),metric=second.finished.calibration.drainage;
 assert.equal(metric.status,'ready');assert.equal(metric.runs.length,2);assert.equal(metric.baseline_duration_seconds,4.2);assert.equal(metric.baseline_recession_mm_per_second,4.762);assert.equal(metric.bands.length,4);assert.equal(second.finished.recording_status,'finished');assert.deepEqual(calibrationSnapshot(second.finished.calibration),second.finished.calibration);
 assert.equal(second.observed.record_id,source.record_id,'both calibration checks use the same unmodified recording stream');assert.ok(second.observed.measurements.every(p=>assert.deepEqual(validateMeasurement(p),p)===undefined));
 assert.equal(updateDrainageCalibration(second.finished,second.observed,{action:'complete',capture_id:second.id},randomUUID(),secondBase+21000),second.finished);
});
test('calibration requires clear-drain/tap-off confirmations, same fixture/source/reference and fresh valid wet evidence',()=>{
 const cal=calibration(),source=monitoring();assert.throws(()=>validateDrainageAction({action:'start',recording_id:source.record_id}),/Confirm/);
 for(const changed of [{...source,fixture_id:'other'},{...source,data_source:'simulation'},{...source,calibration:{empty_distance_mm:310}},{...source,record_type:'drainage'},{...source,measurements:[point(time,10)]},{...source,recording_status:'finished'},{...source,measurements:[{...point(time),sensor:{distance_mm:null,status:'timeout'}}]}])assert.throws(()=>run(cal,changed));
 assert.throws(()=>run(cal,monitoring(time-10000),time));assert.throws(()=>run({...cal,schema_version:1},source));assert.throws(()=>calibrationSnapshot({empty_distance_mm:300,drainage:{...emptyDrainageCalibration(),status:'ready'}}));
 assert.throws(()=>validateDrainageAction({action:'complete',capture_id:randomUUID(),baseline_duration_seconds:1}));
});
test('interrupted, refilled, unresolved and inconsistent trials cannot silently establish a baseline',()=>{
 const cal=calibration(),source=monitoring(),id=randomUUID(),start=updateDrainageCalibration(cal,source,{action:'start'},id,time+1);
 assert.throws(()=>updateDrainageCalibration(start,source,{action:'complete',capture_id:id},id,time+2000),e=>e.code==='drainage_pending');
 const one=drain(source);one.measurements[6].sensor={status:'timeout',distance_mm:null};assert.equal(updateDrainageCalibration(start,one,{action:'complete',capture_id:id},id,time+20000).calibration.drainage.runs.length,1,'an isolated timeout is tolerated');
 const lossy=drain(source);for(const i of [4,5,6,7,8,9])lossy.measurements[i].sensor={status:'timeout',distance_mm:null};const lost=updateDrainageCalibration(start,lossy,{action:'complete',capture_id:id},id,time+20000);assert.equal(lost.calibration.drainage.runs.length,0);assert.equal(lost.calibration.drainage.active_capture,null);assert.match(lost.calibration.drainage.last_issue,/unreliable/);
 const outage=drain(source);outage.measurements.splice(4,12);const gap=updateDrainageCalibration(start,outage,{action:'complete',capture_id:id},id,time+20000);assert.equal(gap.calibration.drainage.runs.length,0);assert.match(gap.calibration.drainage.last_issue,/interrupted/);
 const first=run(cal,source),nextBase=time+30000,secondSource={...first.observed,measurements:[...first.observed.measurements,point(nextBase)]};const mismatch=run(first.finished,secondSource,nextBase,2);assert.equal(mismatch.finished.calibration.drainage.status,'collecting');assert.equal(mismatch.finished.calibration.drainage.runs.length,1);assert.match(mismatch.finished.calibration.drainage.last_issue,/differed/);
 const rising=drain(source);for(const i of [8,9,10])rising.measurements[i].sensor.distance_mm=268;const rise=updateDrainageCalibration(start,rising,{action:'complete',capture_id:id},id,time+20000);assert.equal(rise.calibration.drainage.runs.length,0);assert.match(rise.calibration.drainage.last_issue,/rose/);
 const spike=drain(source);spike.measurements[8].sensor.distance_mm=268;assert.equal(updateDrainageCalibration(start,spike,{action:'complete',capture_id:id},id,time+20000).calibration.drainage.runs.length,1,'one stray echo is not a refill');
 const cancelled=updateDrainageCalibration(start,null,{action:'cancel',capture_id:id},id,time+1000);assert.equal(cancelled.calibration.drainage.active_capture,null);assert.deepEqual(cal.calibration,{empty_distance_mm:300});
});
test('cancelled or duplicate requests cannot overwrite another capture and existing empty-only records remain valid',()=>{
 const cal=calibration(),source=monitoring(),id=randomUUID(),start=updateDrainageCalibration(cal,source,{action:'start'},id,time+1);
 assert.equal(updateDrainageCalibration(start,source,{action:'start'},randomUUID(),time+2),start);assert.throws(()=>updateDrainageCalibration(start,source,{action:'cancel',capture_id:randomUUID()},randomUUID(),time+3),e=>e.code==='capture_changed');assert.deepEqual(calibrationSnapshot(cal.calibration),{empty_distance_mm:300});assert.deepEqual(validateDrainageCalibration(emptyDrainageCalibration()),emptyDrainageCalibration());
});

test('Node and hosted owner APIs save the metric without changing the sensor stream or historical snapshots',async t=>{
 const {createApp}=await import('../src/server.js'),{createCloudHandler}=await import('../../supabase/functions/_shared/cloud-handler.js'),{SQLiteRecordStore}=await import('../src/records-storage.js'),{configFromEnv}=await import('../src/config.js'),{createStore}=await import('../src/storage.js');
 for(const runtime of ['node','cloud']){
  const admin='a'.repeat(32),config={...configFromEnv({STORAGE_BACKEND:'sqlite',SQLITE_PATH:':memory:'}),apiKey:admin},store=new SQLiteRecordStore(':memory:'),accessStore=createStore(config);let clock=Date.now(),invoke;
  const options={store,accessStore,clock:()=>clock,verifyUser:async token=>token==='owner'?'owner-id':token==='viewer'?'viewer-id':null};
  if(runtime==='node'){const app=createApp(config,store,options);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.close());invoke=(path,token,body)=>fetch(`http://127.0.0.1:${app.server.address().port}/api/v1${path}`,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});}
  else{const handler=createCloudHandler({adminToken:admin},options);t.after(()=>{store.close();accessStore.close();});invoke=(path,token,body)=>handler(new Request('https://test/api/v1'+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));}
  const call=async(path,token='owner',body)=>{const r=await invoke(path,token,body);return{status:r.status,data:await r.json()};};
  assert.equal((await call('/devices','owner',{device_id:'sink',name:'Kitchen'})).status,201);
  await accessStore.insert('device_members',{id:randomUUID(),device_id:'sink',user_id:'viewer-id',role:'viewer',created_at:new Date().toISOString()});
  const key=(await call('/devices/sink/keys','owner',{})).data.key;
  const empty=(await call('/records','owner',{fixture_id:'sink',record_type:'calibration',data_source:'sensor',confirm_empty:true})).data;
  for(let i=0;i<20;i++)assert.equal((await call(`/records/${empty.record_id}/measurements`,key,point(Date.now()-10000+i*500,0))).status,201);
  const reference=await store.get(empty.record_id),source=(await call('/records','owner',{fixture_id:'sink',record_type:'monitoring',data_source:'sensor'})).data;
  assert.deepEqual(source.calibration,{empty_distance_mm:300});
  const endpoint=`/records/${empty.record_id}/drainage-calibration`;
  assert.equal((await call(endpoint,'viewer',{action:'start',recording_id:source.record_id,confirm_tap_off:true,confirm_clear:true})).status,403);
  assert.equal((await call(endpoint,key,{action:'start',recording_id:source.record_id,confirm_tap_off:true,confirm_clear:true})).status,403);
  assert.equal((await call(endpoint,'owner',{action:'start',recording_id:source.record_id})).status,422);
  const all=[];
  for(let i=0;i<2;i++){
   clock=Date.now()+i*30000;const wet=point(clock);all.push(wet);assert.equal((await call(`/records/${source.record_id}/measurements`,key,wet)).status,201);
   const start=await call(endpoint,'owner',{action:'start',recording_id:source.record_id,confirm_tap_off:true,confirm_clear:true});assert.equal(start.status,200);const capture=start.data.calibration.drainage.active_capture;
   assert.equal((await call(endpoint,'owner',{action:'complete',capture_id:capture.capture_id})).status,409);
   const observed=drain({...source,measurements:[]},clock);for(const p of observed.measurements){all.push(p);const ack=await call(`/records/${source.record_id}/measurements`,key,p);assert.equal(ack.status,201);assert.deepEqual(Object.keys(ack.data).sort(),['calibration','duplicate','measurement_count','record_id','recording_status','result']);}
   clock+=20000;const complete=await call(endpoint,'owner',{action:'complete',capture_id:capture.capture_id});assert.equal(complete.status,200);assert.equal(complete.data.calibration.drainage.runs.length,i+1);
   const same=await call(endpoint,'owner',{action:'complete',capture_id:capture.capture_id});assert.deepEqual(same.data,complete.data);
  }
  const saved=await store.get(empty.record_id),stream=await store.get(source.record_id);
  assert.equal(saved.calibration.drainage.status,'ready');assert.equal(saved.calibration.drainage.baseline_duration_seconds,4);assert.deepEqual(saved.measurements,reference.measurements);assert.deepEqual(saved.result,reference.result);assert.deepEqual(stream.measurements,all);assert.equal(stream.recording_status,'recording');assert.deepEqual(stream.calibration,source.calibration);
  // Live monitoring now takes its status limits from the saved profile, on both runtimes.
  const live=await call(`/records/${source.record_id}`,'owner');assert.equal(live.status,200);assert.equal(live.data.computed.drain_status.baseline_source,'drainage_profile');assert.equal(live.data.computed.drain_status.baseline_count,2);
  const listed=await call('/records?fixture_id=sink&record_type=monitoring','owner');assert.equal(listed.data.records.find(r=>r.record_id===source.record_id).drain_status.baseline_source,'drainage_profile');
  assert.equal((await call(`/records/${source.record_id}/measurements`,key,all.at(-1))).data.duplicate,true);
  await call(`/records/${source.record_id}/finish`,'owner',{});const next=(await call('/records','owner',{fixture_id:'sink',data_source:'sensor',record_type:'monitoring'})).data;assert.deepEqual(next.calibration,{empty_distance_mm:300});const ack=(await call(`/records/${next.record_id}/measurements`,key,point(Date.now(),0))).data;assert.deepEqual(ack.calibration,{empty_distance_mm:300});assert.equal(ack.calibration.drainage,undefined);assert.equal((await store.get(empty.record_id)).calibration.drainage.status,'ready');assert.deepEqual((await store.get(source.record_id)).calibration,{empty_distance_mm:300});
 }
});
