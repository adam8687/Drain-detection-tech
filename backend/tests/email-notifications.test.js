import test from 'node:test';import assert from 'node:assert/strict';import{randomUUID}from'node:crypto';
import {SQLiteRecordStore}from'../src/records-storage.js';import{SQLiteEmailStore}from'../src/email-storage.js';
import {emailCandidates,emailTimeLimit,createEmailNotifications,providerConfiguration}from'../../supabase/functions/_shared/email-notifications.js';
const now=Date.now(),calibration={empty_distance_mm:300};
const point=(elapsed,depth=50)=>({reading_id:randomUUID(),timestamp:new Date(now-130000+elapsed*1000).toISOString(),sensor:{distance_mm:300-depth,status:'ok'}});
const row=(overrides={})=>({record_id:randomUUID(),fixture_id:'sink',data_source:'sensor',record_type:'monitoring',recording_status:'recording',created_at:new Date(now-130000).toISOString(),calibration,measurements:Array.from({length:131},(_,i)=>point(i)),result:null,...overrides});
test('email policy uses a conservative learning limit, then a robust comparable-depth history',()=>{
 const current=row(),events=emailCandidates(current,[current],now);assert.equal(events.length,1);assert.equal(events[0].threshold_seconds,120);assert.equal(events[0].elapsed_seconds,130);
 for(const bad of [row({data_source:'simulation'}),row({schema_version:1}),row({calibration:null}),row({measurements:[point(0),point(130)]}),row({measurements:current.measurements.map((p,i)=>i===20?{...p,sensor:{status:'timeout',distance_mm:null}}:p)})])assert.equal(emailCandidates(bad,[bad],now).length,0);
 const history=Array.from({length:10},(_,i)=>row({record_type:'drainage',measurements:[{...point(0),timestamp:new Date(now-1000000+i*1000).toISOString()}],created_at:new Date(now-1000000+i*1000).toISOString(),recording_status:'finished',result:{outcome:'completed',drainage_time_seconds:20+i%2}}));
 assert.equal(emailTimeLimit(history,current).seconds,62);assert.equal(emailTimeLimit(history.slice(0,9),current).seconds,120);
 const wide=history.map((r,i)=>({...r,result:{outcome:'completed',drainage_time_seconds:10+i*10}}));assert.ok(emailTimeLimit(wide,current).seconds>=185);
});
test('notification events commit atomically with measurements, deduplicate and respect opt-out/cooldown',async t=>{
 const store=new SQLiteRecordStore(':memory:');t.after(()=>store.close());const mail=new SQLiteEmailStore(store.db);await mail.savePreference({fixture_id:'sink',user_id:'owner',enabled:true,threshold_seconds:null});
 const record=row({measurements:[]});await store.insert(record);const next=row({...record,measurements:row().measurements}),events=emailCandidates(next,[next],now);
 assert.equal(await store.compareAndSet(record,next,events),true);assert.equal(await store.compareAndSet(record,next,events),false);assert.equal(store.db.prepare('SELECT count(*) n FROM drain_email_outbox').get().n,1);
 const changed={...next,measurements:[...next.measurements,point(131)]};await store.compareAndSet(next,changed,[...events,{...events[0],event_key:'other-cycle'}]);assert.equal(store.db.prepare('SELECT count(*) n FROM drain_email_outbox').get().n,1);
 const job=(await mail.claim(10))[0];assert.ok(job.lease_token);assert.equal((await mail.claim(10)).length,0);
});
test('worker sends only to a verified current owner, retries the identical payload, and stops after delivery',async t=>{
 const store=new SQLiteRecordStore(':memory:');t.after(()=>store.close());const mail=new SQLiteEmailStore(store.db);await mail.savePreference({fixture_id:'sink',user_id:'owner',enabled:true,threshold_seconds:null});
 const before=row({measurements:[]}),after={...before,measurements:row().measurements};await store.insert(before);await store.compareAndSet(before,after,emailCandidates(after,[after],now));
 const calls=[];let fail=true;const notifier=createEmailNotifications({config:{enabled:true,apiKey:'private-test-key',from:'Drains <alerts@example.test>',appUrl:'https://drain-detection-tech.vercel.app'},deliveryStore:mail,accessStore:{list:async()=>[{role:'owner'}]},userEmail:async()=> 'owner@example.test',fetcher:async(url,options)=>{calls.push({url,options});return fail?new Response('',{status:503}):Response.json({id:'provider-id'});}});
 assert.equal((await notifier.flush()).failed,1);assert.equal(store.db.prepare('SELECT status FROM drain_email_outbox').get().status,'pending');store.db.exec('UPDATE drain_email_outbox SET available_at=0');fail=false;assert.equal((await notifier.flush()).sent,1);assert.equal((await notifier.flush()).sent,0);assert.equal(calls.length,2);assert.equal(calls[0].options.body,calls[1].options.body);assert.equal(calls[0].options.headers['Idempotency-Key'],calls[1].options.headers['Idempotency-Key']);assert.deepEqual(JSON.parse(calls[1].options.body).to,['owner@example.test']);assert.ok(!calls[1].options.body.includes('private-test-key'));
});
test('revoked ownership, opt-out, unverified email and simulation cannot trigger delivery',async t=>{
 for(const condition of ['viewer','opt-out','unverified']){
 const store=new SQLiteRecordStore(':memory:');t.after(()=>store.close());const mail=new SQLiteEmailStore(store.db);await mail.savePreference({fixture_id:'sink',user_id:'owner',enabled:true,threshold_seconds:null});const before=row({measurements:[]}),after={...before,measurements:row().measurements};await store.insert(before);await store.compareAndSet(before,after,emailCandidates(after,[after],now));if(condition==='opt-out')await mail.savePreference({fixture_id:'sink',user_id:'owner',enabled:false,threshold_seconds:null});
 const service=createEmailNotifications({config:{enabled:true},deliveryStore:mail,accessStore:{list:async()=>[{role:condition==='viewer'?'viewer':'owner'}]},userEmail:async()=>condition==='unverified'?null:'owner@example.test',fetcher:()=>{throw Error('Must not send');}});assert.deepEqual(await service.flush(),{sent:0,failed:0});assert.equal(store.db.prepare('SELECT status FROM drain_email_outbox').get().status,'cancelled');}
 assert.equal(providerConfiguration({DRAIN_EMAIL_ENABLED:'true',RESEND_API_KEY:'x',DRAIN_EMAIL_FROM:'alerts@example.test',DRAIN_APP_URL:'http://insecure.test'}).enabled,false);
});

test('notification preferences require the signed-in owner in both Node and hosted handlers',async t=>{
 const {createApp}=await import('../src/server.js'),{createCloudHandler}=await import('../../supabase/functions/_shared/cloud-handler.js'),{configFromEnv}=await import('../src/config.js'),{createStore}=await import('../src/storage.js');
 const admin='a'.repeat(32);
 for(const runtime of ['node','cloud']){
  const config={...configFromEnv({STORAGE_BACKEND:'sqlite',SQLITE_PATH:':memory:'}),apiKey:admin,emailWorkerToken:'w'.repeat(32)};const store=new SQLiteRecordStore(':memory:'),accessStore=createStore(config),deliveryStore=new SQLiteEmailStore(store.db);
  const notifications=createEmailNotifications({config:{enabled:false},deliveryStore,accessStore,userEmail:async()=>null});let invoke;
  if(runtime==='node'){const app=createApp(config,store,{accessStore,notifications,verifyUser:async token=>token==='owner'?'owner-id':token==='viewer'?'viewer-id':null});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.close());invoke=(path,token,body)=>fetch(`http://127.0.0.1:${app.server.address().port}${path}`,{method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});}
  else{const handler=createCloudHandler({adminToken:admin,emailWorkerToken:'w'.repeat(32)},{store,accessStore,notifications,verifyUser:async token=>token==='owner'?'owner-id':token==='viewer'?'viewer-id':null});t.after(()=>{store.close();accessStore.close();});invoke=(path,token,body)=>handler(new Request('https://test'+path,{method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}));}
  assert.equal((await invoke('/api/v1/devices','owner',{device_id:'sink',name:'Sink'})).status,201);
  await accessStore.insert('device_members',{id:randomUUID(),device_id:'sink',user_id:'viewer-id',role:'viewer',created_at:new Date().toISOString()});
  const path='/api/v1/devices/sink/notifications';assert.equal((await invoke(path,'owner')).status,200);assert.equal((await invoke(path,'viewer')).status,403);assert.equal((await invoke(path,admin)).status,403);
  assert.equal((await invoke(path,'owner',{enabled:true,threshold_seconds:null})).status,200);assert.equal((await invoke(path,'owner',{enabled:true,recipient:'outsider@example.test'})).status,422);assert.equal((await invoke(path,'owner',{enabled:true,threshold_seconds:0})).status,422);
  const value=await(await invoke(path,'owner')).json();assert.equal(value.enabled,true);assert.equal(value.provider_configured,false);assert.equal((await invoke('/api/v1/internal/email-deliveries','owner',{})).status,403);assert.equal((await invoke('/api/v1/internal/email-deliveries','w'.repeat(32),{})).status,200);assert.equal((await invoke('/api/v1/records','w'.repeat(32))).status,403);
 }
});

test('compact timing references survive recording changes without re-reading old measurement histories',async t=>{
 const {emailReferenceSamples}=await import('../../supabase/functions/_shared/email-notifications.js');const store=new SQLiteRecordStore(':memory:');t.after(()=>store.close());const mail=new SQLiteEmailStore(store.db);
 for(let i=0;i<10;i++){const started=now-1000000+i*30000,first=row({record_type:'drainage',created_at:new Date(started).toISOString(),measurements:[]});await store.insert(first);const finished={...first,recording_status:'finished',measurements:[{...point(0),timestamp:new Date(started).toISOString()}],result:{outcome:'completed',drainage_time_seconds:20}};await store.compareAndSet(first,finished,[],emailReferenceSamples(finished));}
 const refs=await mail.references('sink');assert.equal(refs.length,10);assert.equal(emailTimeLimit([],row(),refs).seconds,60);
});
