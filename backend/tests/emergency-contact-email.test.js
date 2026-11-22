import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {SQLiteRecordStore} from '../src/records-storage.js';
import {SQLiteEmailStore,enqueueEmailEvents} from '../src/email-storage.js';
import {createEmailNotifications,providerConfiguration} from '../../supabase/functions/_shared/email-notifications.js';

const env={DRAIN_APP_URL:'https://example.test',DRAIN_EMAIL_ENABLED:'true',RESEND_API_KEY:'test-secret',DRAIN_EMAIL_FROM:'Alerts <alerts@example.test>'};
const event={event_key:'cycle',fixture_id:'sink',record_id:'record',elapsed_seconds:130,threshold_seconds:120,completed:false};
function setup(t){
 const store=new SQLiteRecordStore(':memory:');
 t.after(()=>store.close());
 const deliveryStore=new SQLiteEmailStore(store.db),calls=[];
 const service=createEmailNotifications({
  config:providerConfiguration(env),deliveryStore,accessStore:{list:async()=>[{role:'owner'}]},
  userEmail:async()=>'owner@example.test',
  fetcher:async(url,request)=>{calls.push({url,...request,body:JSON.parse(request.body)});return Response.json({id:'email-'+calls.length});},
 });
 return{store,deliveryStore,service,calls};
}
const add=(s,email,fixture='sink')=>s.service.savePreference(fixture,'owner',{
 add_emergency_contact:{name:'Maintenance',email,consent_confirmed:true},
});
const setEmail=(s,id,change)=>s.service.savePreference('sink','owner',{set_emergency_contact_email:{id,...change}});

test('legacy SMS settings cannot enable delivery and legacy SMS jobs are retired',async t=>{
 assert.equal(providerConfiguration({...env,DRAIN_EMAIL_ENABLED:'false',DRAIN_SMS_ENABLED:'true'}).enabled,false);
 const s=setup(t);
 const db=s.store.db;
 db.prepare("INSERT INTO drain_email_outbox(id,fixture_id,user_id,event,available_at,created_at,channel) VALUES(?,?,?,?,?,?,'sms')")
  .run('legacy','sink','owner',JSON.stringify(event),0,Date.now());
 assert.deepEqual(await s.service.flush(),{sent:0,failed:0});
 new SQLiteEmailStore(db);
 assert.equal(db.prepare("SELECT status FROM drain_email_outbox WHERE id='legacy'").get().status,'cancelled');
});

test('contact emails are scoped to the unit, independent of owner email and deduplicated',async t=>{
 const s=setup(t);
 const addresses=['maintenance@example.test','backup@example.test','third@example.test'];
 for(const address of addresses)await add(s,address);
 await add(s,'another@example.test','other-sink');
 await s.service.savePreference('sink','owner',{enabled:false});
 enqueueEmailEvents(s.store.db,[event,event,{...event,event_key:'cooldown'}]);
 assert.deepEqual(await s.service.flush(),{sent:3,failed:0});
 assert.deepEqual(s.calls.map(call=>call.body.to[0]).sort(),addresses.sort());
 for(const call of s.calls){
  assert.equal(call.url,'https://api.resend.com/emails');
  assert.ok(call.headers['Idempotency-Key'].startsWith('drain/'));
  assert.match(call.body.subject,/sink/);
  assert.match(call.body.text,/Contact the unit owner to stop/);
 }
});

test('owner and contact at the same address receive one email',async t=>{
 const s=setup(t);
 await add(s,'Owner@example.test');
 await s.service.savePreference('sink','owner',{enabled:true});
 enqueueEmailEvents(s.store.db,[event]);
 assert.deepEqual(await s.service.flush(),{sent:1,failed:0});
 assert.deepEqual(s.calls[0].body.to,['owner@example.test']);
 assert.match(s.calls[0].body.text,/View your unit/);
});

test('paused and removed contacts miss queued alerts; resuming requires consent',async t=>{
 const s=setup(t);
 const {emergency_contacts:[first,second]}=await (async()=>{
  await add(s,'maintenance@example.test');
  return add(s,'removed@example.test');
 })();
 enqueueEmailEvents(s.store.db,[event]);
 await s.service.savePreference('sink','owner',{remove_emergency_contact:second.id});
 const paused=await setEmail(s,first.id,{enabled:false});
 assert.deepEqual(paused.emergency_contacts,[{...first,email_enabled:false}]);
 await assert.rejects(setEmail(s,first.id,{enabled:true}),/agreed/);
 enqueueEmailEvents(s.store.db,[{...event,event_key:'while-paused'}]);
 assert.deepEqual((await setEmail(s,first.id,{enabled:true,consent_confirmed:true})).emergency_contacts,[first]);
 assert.deepEqual(await s.service.flush(),{sent:0,failed:0});
 assert.equal(s.store.db.prepare("SELECT count(*) n FROM drain_email_outbox WHERE status='cancelled'").get().n,2);
 enqueueEmailEvents(s.store.db,[{...event,event_key:'after-resuming'}]);
 await setEmail(s,first.id,{enabled:true,consent_confirmed:true});
 assert.deepEqual(await s.service.flush(),{sent:1,failed:0});
});

test('phone-only contacts stay paused until a unique email address and consent are supplied',async t=>{
 const s=setup(t),id=randomUUID();
 const phoneOnly={id,name:'Legacy contact',phone:'+15125550125',sms_enabled:true};
 await add(s,'Existing@example.test');
 s.store.db.prepare("UPDATE drain_email_preferences SET emergency_contacts=json_insert(emergency_contacts,'$[#]',json(?))").run(JSON.stringify(phoneOnly));
 const pref=await s.service.preference('sink','owner');
 assert.deepEqual(pref.emergency_contacts[1],{id,name:'Legacy contact',email:null,email_enabled:false});
 const consent={enabled:true,consent_confirmed:true};
 await assert.rejects(setEmail(s,id,consent),/valid email address/);
 await assert.rejects(setEmail(s,id,{...consent,email:'EXISTING@example.test'}),/unique/);
 const saved=await setEmail(s,id,{...consent,email:' Legacy@example.test '});
 assert.deepEqual(saved.emergency_contacts[1],{id,name:'Legacy contact',email:'legacy@example.test',email_enabled:true});
 await assert.rejects(add(s,'LEGACY@example.test'),/already on the list/);
 await assert.rejects(add(s,'legacy@example.test,other@example.test'),/valid email address/);
});
