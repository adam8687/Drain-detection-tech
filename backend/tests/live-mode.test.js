import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {LiveModeStore,liveInput} from '../../supabase/functions/_shared/live-mode.js';
import {SQLiteRecordStore} from '../src/records-storage.js';
import {createApp} from '../src/server.js';import {createCloudHandler} from '../../supabase/functions/_shared/cloud-handler.js';
import {configFromEnv} from '../src/config.js';import {createStore} from '../src/storage.js';

test('leases are independent, expire, require fresh device confirmation and cannot alter readings',async()=>{
 const store=new SQLiteRecordStore(':memory:');let now=Date.now();const live=new LiveModeStore(store,()=>now),a=randomUUID(),b=randomUUID();
 try{
  assert.equal((await live.state('sink')).active,false);
  const on=await live.state('sink','on',{session_id:a,reason:'calibration'});assert.equal(on.requested,true);assert.equal(on.active,false);assert.equal(on.remaining_ms,120000);
  await live.command('sink',false,new Date(now).toISOString());assert.equal((await live.state('sink')).capable,true);assert.equal((await live.state('sink')).active,false);
  await live.command('sink',true,new Date(now).toISOString());assert.equal((await live.state('sink')).active,true);
  now+=1000;await live.state('sink','on',{session_id:b,reason:'demo'});await live.state('sink','off',{session_id:a});assert.equal((await live.state('sink')).requested,true);
  now+=13000;assert.equal((await live.state('sink')).active,false,'unreported device does not stay live');
  await live.command('sink',true,new Date(now-60000).toISOString());assert.equal((await live.state('sink')).active,false,'replayed backlog is not live');
  await live.command('sink',true,new Date(now).toISOString());assert.equal((await live.state('sink')).active,true);
  now+=120001;assert.equal((await live.state('sink')).requested,false);assert.equal(await live.command('sink',true,new Date(now).toISOString()),0);
  assert.equal((await live.state('sink','on',{session_id:a,reason:'demo'})).active,false,'an expired session acknowledgment cannot confirm a new session');
  assert.equal((await live.state('other')).requested,false);
  assert.equal(await new LiveModeStore({request:async()=>{throw Error('migration not installed');}}).command('sink',true,new Date().toISOString()),0,'optional mode errors request normal batching');
  assert.equal((await store.list()).length,0,'no recordings or calibration profiles are created');
  for(const value of [{session_id:a,enabled:true,reason:'other'},{session_id:'bad',enabled:true,reason:'demo'},{session_id:a,enabled:1,reason:'demo'},{session_id:a,enabled:true,reason:'demo',expires_at:'forever'}])assert.throws(()=>liveInput(value));
 }finally{await store.close();}
});

for(const runtime of ['node','edge'])test(`${runtime}: owners control live mode; sensor handshake preserves acknowledgment and measurement contracts`,async t=>{
 const admin='a'.repeat(32),config={...configFromEnv({STORAGE_BACKEND:'sqlite',SQLITE_PATH:':memory:'}),apiKey:admin};
 const store=new SQLiteRecordStore(':memory:'),accessStore=createStore(config);let now=Date.now();
 const options={store,accessStore,clock:()=>now,verifyUser:async token=>token==='owner'?'owner-id':token==='viewer'?'viewer-id':null};let invoke;
 if(runtime==='node'){const app=createApp(config,store,options);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.close());invoke=(path,token,body,extra={})=>fetch(`http://127.0.0.1:${app.server.address().port}/api/v1${path}`,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});}
 else{const handler=createCloudHandler({adminToken:admin},options);t.after(()=>{store.close();accessStore.close();});invoke=(path,token,body,extra={})=>handler(new Request('https://test/api/v1'+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...extra},...(body===undefined?{}:{body:JSON.stringify(body)})}));}
 const call=async(...args)=>{const response=await invoke(...args);return{status:response.status,headers:response.headers,data:await response.json()};};
 await call('/devices','owner',{device_id:'sink',name:'Kitchen'});const key=(await call('/devices/sink/keys','owner',{})).data.key;
 await accessStore.insert('device_members',{id:randomUUID(),device_id:'sink',user_id:'viewer-id',role:'viewer',created_at:new Date(now).toISOString()});
 const input={session_id:randomUUID(),enabled:true,reason:'demo'},route='/devices/sink/live-mode';
 for(const token of ['viewer',key])assert.equal((await call(route,token,input)).status,403);
 assert.equal((await call(route,'owner',{...input,enabled:'yes'})).status,422);
 assert.equal((await call('/devices/other/live-mode','owner',input)).status,404);
 assert.equal((await call(route,'owner',input)).data.active,false);
 const idle=await call('/sensor/active-record',key,undefined,{'X-Drain-Live-Capability':'1','X-Drain-Live-Active':'0'});assert.equal(idle.data.record,null);assert.equal(idle.headers.get('x-drain-live-for-ms'),'120000');
 await call('/sensor/active-record',key,undefined,{'X-Drain-Live-Capability':'1','X-Drain-Live-Active':'1'});assert.equal((await call(route,'owner')).data.active,true,'an idle board can confirm readiness before a calibration recording is created');
 const record=(await call('/records','owner',{fixture_id:'sink',record_type:'monitoring',data_source:'sensor'})).data;
 const point=()=>({reading_id:randomUUID(),timestamp:new Date(now).toISOString(),sensor:{distance_mm:300,status:'ok'}}),p=point();
 const old=await call(`/records/${record.record_id}/measurements`,key,p);assert.equal(old.status,201);assert.equal(old.headers.get('x-drain-live-for-ms'),null);
 const supports={'X-Drain-Live-Capability':'1','X-Drain-Live-Active':'0'};
 const command=await call(`/records/${record.record_id}/measurements`,key,p,supports);assert.equal(command.status,200);assert.equal(command.headers.get('x-drain-live-for-ms'),'120000');assert.deepEqual(Object.keys(command.data).sort(),Object.keys(old.data).sort());
 assert.equal((await call(route,'owner')).data.active,false);
 await call(`/records/${record.record_id}/measurements`,key,p,{...supports,'X-Drain-Live-Active':'1'});assert.equal((await call(route,'owner')).data.active,true);
 assert.deepEqual((await store.get(record.record_id)).measurements,[p]);
 now+=120001;const expired=await call(`/records/${record.record_id}/measurements`,key,p,supports);assert.equal(expired.headers.get('x-drain-live-for-ms'),'0');assert.equal((await call(route,'owner')).data.active,false);
 store.db.exec('DROP TABLE drain_live_sessions');
 const retained=await call(`/records/${record.record_id}/measurements`,key,{...point(),timestamp:new Date().toISOString()},supports);assert.equal(retained.status,201);assert.equal(retained.headers.get('x-drain-live-for-ms'),'0','optional control failures cannot reject saved measurements');
});
