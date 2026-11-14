import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCloudHandler } from '../../supabase/functions/_shared/cloud-handler.js';
import { SQLiteRecordStore } from '../src/records-storage.js';
import { SQLiteStore } from '../src/storage.js';
import { analyzeDrainage, computedView, SETTINGS } from '../src/records-domain.js';
import { hashDeviceKey } from '../src/auth.js';
import { ApiError } from '../src/validation.js';
import { GET, POST } from '../../web/app/api/backend/[...path]/route.ts';
import { rootCertificates } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { selectTrustedRoot } from '../../scripts/cloud-tls.js';

const ADMIN = 'cloud-test-admin-token-with-at-least-32-characters';
test('ESP trust configuration selects only a valid matching trusted root',()=>{
  const roots=rootCertificates.map(pem=>({pem,cert:new X509Certificate(pem)})).filter(({cert})=>cert.subject===cert.issuer && Date.parse(cert.validTo)>Date.now());
  const first=roots[0], other=roots.find(r=>r.cert.subject!==first.cert.subject);
  assert.equal(selectTrustedRoot([first.cert.raw],[first.pem]).trim(),first.pem.trim());
  assert.throws(()=>selectTrustedRoot([first.cert.raw],[other.pem]));
  assert.throws(()=>selectTrustedRoot([first.cert.raw],[first.pem],Date.parse(first.cert.validTo)+1000));
});
function setup(t) {
  const store = new SQLiteRecordStore(':memory:'), accessStore = new SQLiteStore(':memory:');
  t.after(async () => { await store.close(); await accessStore.close(); });
  const handler = createCloudHandler({ url:'https://test.supabase.co',serviceKey:'sb_secret_test',adminToken:ADMIN,origins:['http://localhost:3000'] }, {store,accessStore,verifyUser:async token=>({'alice':'alice-id','bob':'bob-id'}[token] || null)});
  const call = async (path, token = ADMIN, body, method) => {
    const response = await handler(new Request(`https://test.supabase.co/functions/v1/drain-api${path}`, {method:method || (body === undefined ? 'GET':'POST'),headers:{'Content-Type':'application/json',...(token ? {Authorization:`Bearer ${token}`} : {})},...(body === undefined ? {}:{body:typeof body === 'string' ? body:JSON.stringify(body)})}));
    return {status:response.status,body:await response.json()};
  };
  const start = async (type='monitoring',fixture='sink',source='sensor') => (await call('/api/v1/records',ADMIN,{fixture_id:fixture,record_type:type,data_source:source,...(type==='calibration'?{confirm_empty:true}:{})})).body;
  const point = (ms, a=300,b=a+20) => ({reading_id:randomUUID(),timestamp:new Date(ms).toISOString(),sensor:{distance_mm:a,status:'ok'}});
  return {handler,call,start,point,store,accessStore};
}
test('cloud rejects anonymous access and short admin tokens; validates JSON, size and CORS',async t=>{
  const {handler,call,start}=setup(t);
  assert.equal((await call('/api/v1/records','')).status,401);
  assert.equal((await call('/api/v1/records','stolen')).status,401);
  assert.equal((await call('/ready','')).body.runtime,'supabase-edge');
  assert.throws(()=>createCloudHandler({adminToken:'short'}));
  assert.equal((await call('/api/v1/records',ADMIN,'{broken')).status,400);
  const row=await start();
  assert.equal((await call(`/api/v1/records/${row.record_id}/measurements`,ADMIN,'x'.repeat(17000))).status,413);
  assert.equal((await handler(new Request('https://test/drain-api/api/v1/records',{method:'OPTIONS',headers:{Origin:'https://untrusted.test'}}))).status,403);
  assert.equal((await handler(new Request('https://test/drain-api/api/v1/records',{method:'OPTIONS',headers:{Origin:'http://localhost:3000'}}))).status,204);
});
test('cloud retains ownership, viewer roles, sensor-only appends and fixture scope',async t=>{
  const {call,point,accessStore}=setup(t);
  await call('/api/v1/devices','alice',{device_id:'alice-sink',name:'Alice'});
  await call('/api/v1/devices','bob',{device_id:'bob-sink',name:'Bob'});
  const row=(await call('/api/v1/records','alice',{fixture_id:'alice-sink',record_type:'monitoring',data_source:'sensor'})).body;
  const key=(await call('/api/v1/devices/alice-sink/keys','alice',{})).body.key;
  assert.equal((await call(`/api/v1/records/${row.record_id}`,'bob')).status,404);
  assert.equal((await call('/api/v1/records',key)).status,403);
  assert.equal((await call(`/api/v1/records/${row.record_id}/finish`,key,{})).status,403);
  assert.equal((await call(`/api/v1/records/${row.record_id}/measurements`,'alice',point(Date.now()))).status,403);
  assert.equal((await call(`/api/v1/records/${row.record_id}/measurements`,key,point(Date.now()))).status,201);
  await accessStore.insert('device_members',{id:randomUUID(),device_id:'alice-sink',user_id:'bob-id',role:'viewer',created_at:new Date().toISOString()});
  assert.equal((await call(`/api/v1/records/${row.record_id}`,'bob')).status,200);
  assert.equal((await call(`/api/v1/records/${row.record_id}/finish`,'bob',{})).status,403);
  const viewer=(await call('/api/v1/devices/alice-sink/view-key','alice',{})).body.key;
  assert.match(viewer,/^dv_/);
  assert.equal((await call(`/api/v1/records/${row.record_id}`,viewer)).status,200);
  assert.equal((await call('/api/v1/records?fixture_id=bob-sink',viewer)).status,403);
  assert.equal((await call('/api/v1/devices',viewer,{device_id:'new',name:'New'})).status,403);
  assert.equal((await call(`/api/v1/records/${row.record_id}/measurements`,viewer,point(Date.now()))).status,403);
  assert.equal((await call('/api/v1/devices/alice-sink/keys',viewer,{})).status,403);
  const stored=await accessStore.get('device_keys',hashDeviceKey(viewer));
  assert.equal(stored.kind,'viewer');
});
test('cloud calibrates, computes drainage and replay identically, and freezes completed results',async t=>{
  const {call,start,point,store}=setup(t);
  const base=Date.now()-60000;
  assert.equal((await call('/api/v1/records',ADMIN,{fixture_id:'sink',record_type:'calibration',data_source:'sensor'})).status,422);
  assert.equal((await call('/api/v1/records',ADMIN,{fixture_id:'sink',record_type:'drainage',data_source:'sensor'})).status,409);
  const calibration=await start('calibration');
  for(let i=0;i<20;i++) assert.equal((await call(`/api/v1/records/${calibration.record_id}/measurements`,ADMIN,point(base+i*500,400,420))).status,201);
  const learned=await store.get(calibration.record_id);
  assert.equal(learned.recording_status,'finished');
  assert.deepEqual(learned.calibration,{empty_distance_mm: 400});
  const drain=await start('drainage');
  for(let i=0;i<24;i++) await call(`/api/v1/records/${drain.record_id}/measurements`,ADMIN,point(base+15000+i*500,Math.min(400,300+i*5),Math.min(420,320+i*5)));
  const saved=await store.get(drain.record_id);
  assert.equal(saved.recording_status,'finished');
  assert.deepEqual(saved.result,analyzeDrainage(saved.measurements,saved.calibration).result);
  const prefix=await call(`/api/v1/records/${drain.record_id}?sample=8`);
  assert.deepEqual(prefix.body.computed.timeline,computedView(saved,8).timeline);
  const last=saved.measurements.at(-1);
  assert.equal((await call(`/api/v1/records/${drain.record_id}/measurements`,ADMIN,last)).body.duplicate,true);
  assert.equal((await call(`/api/v1/records/${drain.record_id}/measurements`,ADMIN,point(Date.now()))).status,409);
  assert.deepEqual((await store.get(drain.record_id)).result,saved.result);
  assert.equal(SETTINGS.maxMeasurements,5000);
});
test('cloud concurrent appends are retry-safe, reject conflicting duplicates and never acknowledge failed writes',async t=>{
  const {call,start,point,store}=setup(t);
  const row=await start(),sample=point(Date.now());
  const replies=await Promise.all(Array.from({length:6},()=>call(`/api/v1/records/${row.record_id}/measurements`,ADMIN,sample)));
  assert.equal(replies.filter(r=>r.status===201).length,1);
  assert.equal((await store.get(row.record_id)).measurements.length,1);
  assert.equal((await call(`/api/v1/records/${row.record_id}/measurements`,ADMIN,{...sample,sensor:{distance_mm:999,status:'ok'}})).status,409);
  const original=store.compareAndSet;store.compareAndSet=async()=>false;
  assert.equal((await call(`/api/v1/records/${row.record_id}/measurements`,ADMIN,point(Date.now()))).status,409);
  store.compareAndSet=async()=>{throw new ApiError(503,'storage_unavailable','Cloud write rejected');};
  assert.equal((await call(`/api/v1/records/${row.record_id}/measurements`,ADMIN,point(Date.now()))).status,503);
  store.compareAndSet=original;
});
test('frontend preserves function URL prefix and injects only a scoped viewer on reads',async t=>{
  const {handler,call,start}=setup(t);
  await call('/api/v1/devices',ADMIN,{device_id:'sink',name:'Sink'});
  await start();
  const viewer=(await call('/api/v1/devices/sink/view-key',ADMIN,{})).body.key;
  const previous={url:process.env.SUPABASE_FUNCTION_URL,viewer:process.env.DRAIN_VIEWER_TOKEN,bench:process.env.DRAIN_ENABLE_BENCH_VIEWER,fetch:globalThis.fetch};
  process.env.SUPABASE_FUNCTION_URL='https://test.supabase.co/functions/v1/drain-api';process.env.DRAIN_VIEWER_TOKEN=viewer;process.env.DRAIN_ENABLE_BENCH_VIEWER='true';
  t.after(()=>{
    if(previous.url===undefined)delete process.env.SUPABASE_FUNCTION_URL;else process.env.SUPABASE_FUNCTION_URL=previous.url;
    if(previous.viewer===undefined)delete process.env.DRAIN_VIEWER_TOKEN;else process.env.DRAIN_VIEWER_TOKEN=previous.viewer;
    if(previous.bench===undefined)delete process.env.DRAIN_ENABLE_BENCH_VIEWER;else process.env.DRAIN_ENABLE_BENCH_VIEWER=previous.bench;
    globalThis.fetch=previous.fetch;
  });
  let target;
  globalThis.fetch=async(url,options)=>{target=String(url);return handler(new Request(url,options));};
  const context={params:Promise.resolve({path:['api','v1','records']})};
  delete process.env.DRAIN_ENABLE_BENCH_VIEWER;const anonymous=await GET(new Request('http://frontend/api/backend/api/v1/records?fixture_id=sink'),context);assert.equal(anonymous.status,401);process.env.DRAIN_ENABLE_BENCH_VIEWER='true';
  const read=await GET(new Request('http://frontend/api/backend/api/v1/records?fixture_id=sink'),context);
  assert.equal(read.status,200);assert.equal((await read.json()).records.length,1);
  assert.ok(target.includes('/functions/v1/drain-api/api/v1/records?fixture_id=sink'));
  const write=await POST(new Request('http://frontend/api/backend/api/v1/records',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fixture_id:'sink',record_type:'monitoring',data_source:'sensor'})}),context);
  assert.equal(write.status,401);
  const bad=await GET(new Request('http://frontend/api/backend/api/v1/records',{headers:{Authorization:'Bearer invalid'}}),context);
  assert.equal(bad.status,401);
});

test('batched measurements append atomically, retry as duplicates and reject bad batches',async t=>{
  const {call,start,point,store}=setup(t);
  const row=await start(), base=Date.now()-60000, path=`/api/v1/records/${row.record_id}/measurements`;
  const batch=Array.from({length:10},(_,i)=>point(base+i*100));
  const first=await call(path,ADMIN,{measurements:batch});
  assert.equal(first.status,201); assert.equal(first.body.measurement_count,10); assert.equal(first.body.duplicate,false);
  const retry=await call(path,ADMIN,{measurements:batch});
  assert.equal(retry.status,200); assert.equal(retry.body.duplicate,true); assert.equal(retry.body.measurement_count,10);
  assert.equal((await call(path,ADMIN,{measurements:[]})).status,422);
  assert.equal((await call(path,ADMIN,{measurements:Array.from({length:21},(_,i)=>point(base+5000+i))})).status,422);
  const p=point(base+9000);
  assert.equal((await call(path,ADMIN,{measurements:[p,p]})).status,422);
  assert.equal((await call(path,ADMIN,{measurements:[point(base+9500),{...batch[0],sensor:{distance_mm:999,status:'ok'}}]})).status,409);
  assert.equal((await store.get(row.record_id)).measurements.length,10,'a failed batch must not partially apply');
  assert.equal((await call(path,ADMIN,point(base+9600))).status,201,'single-point bodies still work');
  assert.equal((await store.get(row.record_id)).measurements.length,11);
});

test('guided setup calibrates, learns three drains, resumes and reports a live timeout',async t=>{
  const {call,point}=setup(t);
  const fixture='guided-sink';
  assert.equal((await call('/api/v1/devices','alice',{device_id:fixture,name:'Kitchen sink'})).status,201);
  const key=(await call(`/api/v1/devices/${fixture}/keys`,'alice',{})).body.key;
  const create=async type => {
    const response=await call('/api/v1/records','alice',{fixture_id:fixture,data_source:'sensor',record_type:type,...(type==='calibration'?{confirm_empty:true}:{})});
    assert.equal(response.status,201);return response.body;
  };
  const append=async (row,points)=>{
    let response;
    for(let i=0;i<points.length;i+=20) {response=await call(`/api/v1/records/${row.record_id}/measurements`,key,{measurements:points.slice(i,i+20)});assert.equal(response.status,201);}
    return response.body;
  };
  const calibration=await create('calibration');
  const now=Date.now()-300000;
  await append(calibration,Array.from({length:20},(_,i)=>point(now+i*500)));
  const durations=[20,21,19];
  for(let n=0;n<durations.length;n++){
    const row=await create('drainage'),seconds=durations[n],start=now+20000+n*30000;
    const points=Array.from({length:seconds+3},(_,i)=>point(start+i*1000,300-(i>=seconds?0:Math.max(10,50*(1-i/seconds)))));
    const result=await append(row,points);
    assert.equal(result.result.outcome,'completed');
    const view=await call(`/api/v1/records/${row.record_id}`,'alice');
    assert.equal(view.body.computed.drain_status.baseline_count,n+1);
  }
  const resumed=await call(`/api/v1/records?fixture_id=${fixture}&data_source=sensor&limit=1`,'alice');
  assert.equal(resumed.body.records[0].drain_status.baseline_seconds,20);
  assert.equal(resumed.body.records[0].drain_status.timeout_threshold_seconds,60);
  const live=await create('drainage');
  const discovery=await call('/api/v1/sensor/active-record',key);
  assert.deepEqual(discovery.body.record,{record_id:live.record_id,record_type:'drainage',fixture_id:fixture});
  assert.equal((await call('/api/v1/sensor/active-record','alice')).status,403);
  const start=Date.now()-65000;
  await append(live,Array.from({length:66},(_,i)=>point(start+i*1000,250)));
  const view=await call(`/api/v1/records/${live.record_id}`,'alice');
  assert.equal(view.body.computed.drain_status.status,'running_too_long');
  const alerts=await call(`/api/v1/alerts?fixture_id=${fixture}`,'alice');
  assert.ok(alerts.body.alerts.some(a=>a.type==='running_too_long'&&a.severity==='critical'));
  assert.equal((await call(`/api/v1/records/${live.record_id}`,'bob')).status,404);
});

test('continuous monitoring uses learned baseline and alerts reference the real recording',async t=>{
  const {call,store}=setup(t), now=Date.now();
  const calibration={empty_distance_mm: 300};
  const point=(ms,depth)=>({reading_id:randomUUID(),timestamp:new Date(ms).toISOString(),sensor:{status:'ok',distance_mm:300-depth}});
  for(let i=0;i<3;i++)await store.insert({record_id:randomUUID(),fixture_id:'continuous',data_source:'sensor',record_type:'drainage',recording_status:'finished',created_at:new Date(now-1000000+i*1000).toISOString(),calibration,measurements:[point(now-1000000+i*1000,50)],result:{outcome:'completed',drainage_time_seconds:20}});
  const empty=await call('/api/v1/records',ADMIN,{fixture_id:'continuous',data_source:'sensor',record_type:'monitoring'});
  const waiting=await call(`/api/v1/records/${empty.body.record_id}`);
  assert.equal(waiting.body.computed.drain_status.baseline_seconds,20);
  await call(`/api/v1/records/${empty.body.record_id}/finish`,ADMIN,{});
  const id=randomUUID();
  await store.insert({record_id:id,fixture_id:'continuous',data_source:'sensor',record_type:'monitoring',recording_status:'recording',created_at:new Date(now-70000).toISOString(),calibration,measurements:Array.from({length:66},(_,i)=>point(now-65000+i*1000,50)),result:null});
  const view=await call(`/api/v1/records/${id}`);
  assert.equal(view.body.computed.drain_status.status,'running_too_long');
  const alerts=await call('/api/v1/alerts?fixture_id=continuous');
  assert.equal(alerts.body.alerts[0].type,'running_too_long');
  assert.equal(alerts.body.alerts[0].record_id,id);
  assert.equal((await store.get(id)).result,null);
});
