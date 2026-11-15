import test from 'node:test';
import assert from 'node:assert/strict';
import {SQLiteRecordStore} from '../src/records-storage.js';
import {SQLiteEmailStore,enqueueEmailEvents} from '../src/email-storage.js';
import {createEmailNotifications,providerConfiguration} from '../../supabase/functions/_shared/email-notifications.js';
const env={DRAIN_APP_URL:'https://example.test',DRAIN_SMS_ENABLED:'true',TWILIO_ACCOUNT_SID:'AC'+'1'.repeat(32),TWILIO_AUTH_TOKEN:'server-secret',TWILIO_FROM_NUMBER:'+15125550123'};
const event={event_key:'cycle',fixture_id:'sink',record_id:'record',elapsed_seconds:130,threshold_seconds:120,completed:false};
function setup(t,options={}){
 const store=new SQLiteRecordStore(':memory:');t.after(()=>store.close());
 const deliveryStore=new SQLiteEmailStore(store.db),calls=[];
 const service=createEmailNotifications({config:providerConfiguration(env),deliveryStore,accessStore:{list:async()=>[{role:options.role??'owner'}]},userEmail:async()=>{throw Error('SMS must not look up email');},fetcher:async(url,request)=>{calls.push({url,request});return options.respond?options.respond():Response.json({sid:'SMaccepted'});}});
 return{store,deliveryStore,service,calls};
}
async function queue(s){await s.service.savePreference('sink','owner',{enabled:false,sms_enabled:true,sms_phone:'+15125550124'});enqueueEmailEvents(s.store.db,[event]);}
test('SMS can be configured independently; incomplete configuration cannot activate delivery',()=>{
 assert.equal(providerConfiguration(env).sms.enabled,true);assert.equal(providerConfiguration(env).emailEnabled,false);
 for(const change of [{TWILIO_AUTH_TOKEN:''},{TWILIO_ACCOUNT_SID:'bad'},{TWILIO_FROM_NUMBER:''},{DRAIN_SMS_ENABLED:'false'},{DRAIN_APP_URL:'http://example.test'}])assert.equal(providerConfiguration({...env,...change}).enabled,false);
 assert.equal(providerConfiguration({...env,TWILIO_FROM_NUMBER:'',TWILIO_MESSAGING_SERVICE_SID:'MG'+'2'.repeat(32)}).enabled,true);
});
test('owner SMS opt-in validates destination and preserves SMS settings on legacy email updates',async t=>{
 const s=setup(t);
 for(const phone of ['5125550124','+1','+15125550124\n','arbitrary@example.test'])await assert.rejects(s.service.savePreference('sink','owner',{enabled:true,sms_enabled:true,sms_phone:phone}));
 await assert.rejects(s.service.savePreference('sink','owner',{enabled:false,sms_enabled:true}));
 await queue(s);await s.service.savePreference('sink','owner',{enabled:true});
 const pref=await s.service.preference('sink','owner');assert.equal(pref.sms_enabled,true);assert.equal(pref.sms_phone,'+15125550124');assert.equal(pref.enabled,true);
});
test('SMS uses Twilio form encoding and server authentication, once per event and hour',async t=>{
 const s=setup(t);await queue(s);enqueueEmailEvents(s.store.db,[event,{...event,event_key:'another-cycle'}]);
 assert.equal((await s.service.flush()).sent,1);assert.equal((await s.service.flush()).sent,0);assert.equal(s.calls.length,1);
 const {url,request}=s.calls[0],body=new URLSearchParams(request.body);
 assert.equal(url,`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`);assert.equal(atob(request.headers.Authorization.slice(6)),`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
 assert.equal(body.get('To'),'+15125550124');assert.equal(body.get('From'),env.TWILIO_FROM_NUMBER);assert.match(body.get('Body'),/Reply STOP/);assert.ok(!request.body.includes(env.TWILIO_AUTH_TOKEN));
});
test('SMS cancels for revoked ownership, opt-out, or changed destination before delivery',async t=>{
 for(const condition of ['viewer','opt-out','changed']){
  const s=setup(t,{role:condition==='viewer'?'viewer':'owner'});await queue(s);
  if(condition==='opt-out')await s.service.savePreference('sink','owner',{enabled:false,sms_enabled:false});
  if(condition==='changed')s.store.db.prepare('UPDATE drain_email_outbox SET recipient=?').run('+15125550125');
  assert.deepEqual(await s.service.flush(),{sent:0,failed:0});assert.equal(s.calls.length,0);assert.equal(s.store.db.prepare('SELECT status FROM drain_email_outbox').get().status,'cancelled');
 }
});
test('email and SMS enqueue independently and workers do not claim disabled channels',async t=>{
 const s=setup(t);await s.service.savePreference('sink','owner',{enabled:true,sms_enabled:true,sms_phone:'+15125550124'});enqueueEmailEvents(s.store.db,[event]);
 assert.equal(s.store.db.prepare('SELECT count(*) n FROM drain_email_outbox').get().n,2);assert.equal((await s.service.flush()).sent,1);
 assert.equal(s.store.db.prepare("SELECT status FROM drain_email_outbox WHERE channel='email'").get().status,'pending');
});
test('SMS rate limits retry but ambiguous sends and permanent rejections do not risk duplicate texts',async t=>{
 for(const condition of ['rate-limit','network','server','opted-out']){
  const s=setup(t,{respond:()=>{if(condition==='network')throw Error('timeout');return new Response('',{status:condition==='rate-limit'?429:condition==='server'?503:400});}});await queue(s);
  assert.equal((await s.service.flush()).failed,1);assert.equal(s.store.db.prepare('SELECT status FROM drain_email_outbox').get().status,condition==='rate-limit'?'pending':'failed');
  s.store.db.exec('UPDATE drain_email_outbox SET available_at=0');await s.service.flush();assert.equal(s.calls.length,condition==='rate-limit'?2:1);
 }
});
test('a worker crash cannot cause a previously claimed SMS to be sent twice',async t=>{
 const s=setup(t);await queue(s);assert.equal((await s.deliveryStore.claim(2,['sms'])).length,1);s.store.db.exec('UPDATE drain_email_outbox SET available_at=0');
 assert.equal((await s.service.flush()).sent,0);assert.equal(s.calls.length,0);assert.equal(s.store.db.prepare('SELECT status FROM drain_email_outbox').get().status,'failed');
});
