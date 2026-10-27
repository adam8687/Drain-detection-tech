import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SQLiteRecordStore } from '../src/records-storage.js';
import { createApp } from '../src/server.js';
import { configFromEnv } from '../src/config.js';
const ADMIN = 'admin-token-that-is-long-enough-for-tests';
const users = { 'alice-session': 'alice-id', 'bob-session': 'bob-id' };
async function start(t) {
  const config = { ...configFromEnv({ STORAGE_BACKEND:'sqlite',SQLITE_PATH:':memory:' }),apiKey:ADMIN };
  const app=createApp(config,new SQLiteRecordStore(':memory:'),{verifyUser:async token=>users[token]??null});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());
  const base=`http://127.0.0.1:${app.server.address().port}/api/v1`;
  const api=async(path,token,body)=>{const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};};
  api.access=app.accessStore;return api;
}
test('upstream user ownership is retained for registry and new recording data',async t=>{
  const api=await start(t);
  assert.equal((await api('/records')).status,401);
  assert.equal((await api('/records','stolen-session')).status,401);
  await api('/devices','alice-session',{device_id:'alice-sink',name:'Alice sink'});
  await api('/devices','bob-session',{device_id:'bob-sink',name:'Bob sink'});
  assert.equal((await api('/devices','bob-session',{device_id:'alice-sink',name:'Takeover'})).status,409);
  assert.deepEqual((await api('/devices','alice-session')).body.devices.map(d=>d.device_id),['alice-sink']);
  const row=await api('/records','alice-session',{fixture_id:'alice-sink',data_source:'sensor',record_type:'monitoring'});assert.equal(row.status,201);
  assert.equal((await api(`/records/${row.body.record_id}`,'bob-session')).status,404);
  assert.equal((await api('/records?fixture_id=alice-sink','bob-session')).status,404);
  assert.equal((await api('/records','bob-session')).body.records.length,0);
  assert.equal((await api(`/records/${row.body.record_id}/finish`,'bob-session',{})).status,404);
  assert.equal((await api('/devices/alice-sink/keys','bob-session',{})).status,404);
});
test('upstream device keys can only append physical readings for their own fixture',async t=>{
  const api=await start(t);
  await api('/devices','alice-session',{device_id:'alice-sink',name:'Alice sink'});
  await api('/devices',ADMIN,{device_id:'other-sink',name:'Other sink'});
  const key=(await api('/devices/alice-sink/keys','alice-session',{})).body.key;assert.match(key,/^dk_/);
  const own=(await api('/records','alice-session',{fixture_id:'alice-sink',data_source:'sensor',record_type:'monitoring'})).body;
  const other=(await api('/records',ADMIN,{fixture_id:'other-sink',data_source:'sensor',record_type:'monitoring'})).body;
  const point={reading_id:randomUUID(),timestamp:new Date().toISOString(),sensor_a:{distance_mm:200,status:'ok'},sensor_b:{distance_mm:210,status:'ok'}};
  assert.equal((await api(`/records/${own.record_id}/measurements`,key,point)).status,201);
  assert.equal((await api(`/records/${other.record_id}/measurements`,key,point)).status,403);
  assert.equal((await api(`/records/${own.record_id}/measurements`,'alice-session',{...point,reading_id:randomUUID()})).status,403);
  assert.equal((await api('/records',key)).status,403);
  assert.equal((await api(`/records/${own.record_id}`,key)).status,403);
  assert.equal((await api('/devices',key)).status,403);
  assert.equal((await api(`/records/${own.record_id}/measurements`,'dk_fake',point)).status,401);
  assert.equal((await api(`/records/${own.record_id}/finish`,key,{})).status,403);
});
test('upstream viewers can read but cannot create or finish recordings or issue sensor keys',async t=>{
  const api=await start(t);await api('/devices','alice-session',{device_id:'shared-sink',name:'Shared sink'});
  await api.access.insert('device_members',{id:randomUUID(),device_id:'shared-sink',user_id:'bob-id',role:'viewer',created_at:new Date().toISOString()});
  const row=(await api('/records','alice-session',{fixture_id:'shared-sink',data_source:'sensor',record_type:'monitoring'})).body;
  assert.equal((await api(`/records/${row.record_id}`,'bob-session')).status,200);
  assert.equal((await api('/records','bob-session',{fixture_id:'shared-sink',data_source:'sensor',record_type:'calibration',confirm_empty:true})).status,403);
  assert.equal((await api(`/records/${row.record_id}/finish`,'bob-session',{})).status,403);
  assert.equal((await api('/devices/shared-sink/keys','bob-session',{})).status,403);
});
