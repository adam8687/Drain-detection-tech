import {createHash} from 'node:crypto';
import {monitoringEvents,ordered,depths,SETTINGS} from './records-domain.js';

// EPA documents varying faucet flows; there is no universal drain-time limit.
// NIST's modified z-score (>3.5) informs the robust bound after 10 observations.
// Floors, multipliers and the learning fallback are engineering policy, not codes.
export const EMAIL_POLICY={version:'email-v1',learningSeconds:120,minimumSeconds:60,referenceCount:10,cooldownSeconds:3600};
const MAX_EMERGENCY_CONTACTS=5;
const contactIdPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const median=xs=>{const s=[...xs].sort((a,b)=>a-b);return(s[Math.floor((s.length-1)/2)]+s[Math.floor(s.length/2)])/2;};
const firstWet=row=>ordered(row.measurements).find(p=>depths(p,row.calibration)?.[0]>=SETTINGS.wet);
export function emailReferenceSamples(record){
 if(record.data_source!=='sensor'||record.schema_version===1||!record.calibration)return[];
 return (record.record_type==='monitoring'?monitoringEvents(record):[record]).filter(e=>e.recording_status==='finished'&&e.result?.outcome==='completed'&&e.result.drainage_time_seconds>0&&e.result.drainage_time_seconds<EMAIL_POLICY.learningSeconds).flatMap(e=>{const wet=firstWet(e),depth=wet&&depths(wet,e.calibration)?.[0];return depth?[{cycle_id:e.record_id,fixture_id:record.fixture_id,started_at:wet.timestamp,depth_mm:depth,duration_seconds:e.result.drainage_time_seconds}]:[];}).slice(0,50);
}
export function emailTimeLimit(context,event,referenceSamples=[]){
 // A saved drainage profile (clear-drain setup) sets this sink's standing-water limit directly.
 if(event.drainage_profile){const t=event.drainage_profile.total;return{seconds:Math.ceil(t.standing_water_seconds),reference_count:2,usual_seconds:t.expected_seconds};}
 const initial=firstWet(event),depth=initial&&depths(initial,event.calibration)?.[0];
 const samples=[...new Map([...referenceSamples,...context.flatMap(emailReferenceSamples)].map(s=>[s.cycle_id,s])).values()];
 const history=samples.filter(s=>s.fixture_id===event.fixture_id&&s.cycle_id!==event.record_id&&s.started_at<event.created_at&&depth&&Math.abs(s.depth_mm/depth-1)<=.25).sort((a,b)=>a.started_at.localeCompare(b.started_at)).slice(0,EMAIL_POLICY.referenceCount);
 if(history.length<EMAIL_POLICY.referenceCount)return{seconds:EMAIL_POLICY.learningSeconds,reference_count:history.length,usual_seconds:null};
 const values=history.map(s=>s.duration_seconds),usual=median(values),mad=median(values.map(v=>Math.abs(v-usual)));
 return{seconds:Math.ceil(Math.max(EMAIL_POLICY.minimumSeconds,3*usual,usual+30,usual+3.5*mad/.6745)),reference_count:history.length,usual_seconds:usual};
}
export function emailCandidates(record,context=[record],now=Date.now(),referenceSamples=[]){
 if(record.data_source!=='sensor'||record.schema_version===1||!record.calibration||record.record_type==='calibration')return[];
 const events=record.record_type==='monitoring'?monitoringEvents(record):[record];
 return events.flatMap(event=>{
  const points=ordered(event.measurements),start=firstWet(event),last=points.at(-1);if(!start||!last)return[];
  const completed=event.recording_status==='finished'&&event.result?.outcome==='completed';
  const elapsed=completed?event.result.drainage_time_seconds:(Date.parse(last.timestamp)-Date.parse(start.timestamp))/1000;
  // Only current evidence is queued; history is never emailed as new activity.
  if(elapsed<30||now<Date.parse(last.timestamp)||now-Date.parse(last.timestamp)>(completed?300000:SETTINGS.maxGap))return[];
  if(!completed){const wet=points.filter(p=>p.timestamp>=start.timestamp);if(event.recording_status!=='recording'||depths(last,event.calibration)?.[0]<=SETTINGS.dry||!wet.every((p,i)=>depths(p,event.calibration)&&(!i||Date.parse(p.timestamp)-Date.parse(wet[i-1].timestamp)<=SETTINGS.maxGap)))return[];}
  const policy=emailTimeLimit(context,event,referenceSamples);
  return[{event_key:createHash('sha256').update(`${EMAIL_POLICY.version}:${record.fixture_id}:${record.record_id}:${event.record_id}`).digest('hex'),fixture_id:record.fixture_id,record_id:record.record_id,elapsed_seconds:elapsed,threshold_seconds:policy.seconds,reference_count:policy.reference_count,usual_seconds:policy.usual_seconds,observed_at:last.timestamp,completed,policy_version:EMAIL_POLICY.version}];
 });
}
function contactEmail(value){
 if(typeof value!=='string')return null;
 const email=value.trim().toLowerCase();
 return email.length<=254&&/^[^\s@<>,;:]+@[^\s@<>,;:]+\.[^\s@<>,;:]+$/.test(email)?email:null;
}
export function providerConfiguration(env={}){
 const apiKey=env.RESEND_API_KEY||'',from=env.DRAIN_EMAIL_FROM||'',appUrl=env.DRAIN_APP_URL||'';
 let valid=false;try{valid=new URL(appUrl).protocol==='https:';}catch{}
 const emailEnabled=env.DRAIN_EMAIL_ENABLED==='true'&&Boolean(apiKey)&&valid&&/^([^<>\r\n]+ <)?[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>?$/.test(from);
 return{apiKey,from,appUrl,emailEnabled,enabled:emailEnabled};
}
export function createEmailNotifications({config,deliveryStore,accessStore,userEmail,fetcher=fetch,logger=()=>{}}){
 const emailEnabled=config.emailEnabled??config.enabled??false;
 let flushing=null,lastKick=0;const references=new Map();
 const service={enabled:emailEnabled,deliveryStore,
  async references(fixture){const hit=references.get(fixture);if(hit&&hit.expires>Date.now())return hit.rows;const rows=await deliveryStore.references(fixture);references.set(fixture,{rows,expires:Date.now()+30000});while(references.size>128)references.delete(references.keys().next().value);return rows;},
  async preference(fixture,user){
   const p=await deliveryStore.preference(fixture,user);
   return{enabled:p?.enabled??false,threshold_seconds:p?.threshold_seconds??null,provider_configured:emailEnabled,learning_threshold_seconds:EMAIL_POLICY.learningSeconds,
    emergency_contacts:(p?.emergency_contacts??[]).map(({id,name,email=null,email_enabled})=>({id,name,email,email_enabled:email_enabled===true&&Boolean(email)}))};
  },
  async savePreference(fixture,user,input){
   if(input&&Object.keys(input).length===1){
    if(Object.hasOwn(input,'add_emergency_contact')){
     const contact=input.add_emergency_contact;
     const name=typeof contact?.name==='string'?contact.name.trim():'';
     const email=contactEmail(contact?.email);
     if(!name||name.length>80||!email)throw Error('Enter a contact name and a valid email address.');
     if(contact.consent_confirmed!==true)throw Error('Confirm that the contact agreed to receive drain alert emails.');
     const saved=await deliveryStore.addEmergencyContact(fixture,user,{id:crypto.randomUUID(),name,email,email_enabled:true,consent_confirmed_at:new Date().toISOString()},MAX_EMERGENCY_CONTACTS);
     if(!saved)throw Error('This email is already on the list or the unit has five emergency contacts.');
     return service.preference(fixture,user);
    }
    if(Object.hasOwn(input,'remove_emergency_contact')){
     const id=input.remove_emergency_contact;
     if(typeof id!=='string'||!contactIdPattern.test(id))throw Error('Choose an emergency contact to remove.');
     await deliveryStore.removeEmergencyContact(fixture,user,id);
     return service.preference(fixture,user);
    }
    if(Object.hasOwn(input,'set_emergency_contact_email')){
     const change=input.set_emergency_contact_email;
     if(typeof change?.id!=='string'||!contactIdPattern.test(change.id)||typeof change.enabled!=='boolean')throw Error('Choose an emergency contact and whether to send emails.');
     if(change.enabled&&change.consent_confirmed!==true)throw Error('Confirm that the contact agreed to receive drain alert emails.');
     const patch={email_enabled:change.enabled,subscription_id:crypto.randomUUID()};
     if(change.enabled){
      patch.consent_confirmed_at=new Date().toISOString();
      if(Object.hasOwn(change,'email')){
       const email=contactEmail(change.email);
       if(!email)throw Error('Enter a valid email address.');
       patch.email=email;
      }
     }
     const saved=await deliveryStore.setEmergencyContactEmail(fixture,user,change.id,patch);
     if(!saved)throw Error('Choose a saved contact with a valid email address that is unique on this unit.');
     return service.preference(fixture,user);
    }
   }
   if(!input||typeof input.enabled!=='boolean'||Object.keys(input).some(k=>!['enabled','threshold_seconds'].includes(k)))throw Error('Choose whether to enable email alerts.');
   const threshold=input.threshold_seconds??null;if(threshold!==null&&(!Number.isInteger(threshold)||threshold<30||threshold>3600))throw Error('Choose a time limit from 30 to 3600 seconds.');
   await deliveryStore.savePreference({fixture_id:fixture,user_id:user,enabled:input.enabled,threshold_seconds:threshold});
   return service.preference(fixture,user);
  },
  async flush(){
   if(!service.enabled)return{sent:0,failed:0};if(flushing)return flushing;
   flushing=(async()=>{let sent=0,failed=0;const ownerEmails=new Map();await Promise.all((await deliveryStore.claim(MAX_EMERGENCY_CONTACTS+1)).map(async job=>{
    try{
     const membership=(await accessStore.list('device_members',{device_id:job.fixture_id,user_id:job.user_id},1))[0];
     const preference=await deliveryStore.preference(job.fixture_id,job.user_id);
     let recipient=null;
     if(membership?.role==='owner'){
      if(preference?.enabled&&!ownerEmails.has(job.user_id))ownerEmails.set(job.user_id,Promise.resolve().then(()=>userEmail(job.user_id)));
      const ownerEmail=preference?.enabled?await ownerEmails.get(job.user_id):null;
      if(job.contact_id)recipient=preference?.emergency_contacts?.find(contact=>contact.email_enabled===true&&(contact.subscription_id??contact.id)===job.contact_id)?.email;
      else recipient=ownerEmail;
      if(job.contact_id&&recipient&&recipient===contactEmail(ownerEmail))recipient=null;
     }
     if(!recipient||job.recipient&&job.recipient!==recipient){await deliveryStore.finish(job,'cancelled');return;}
     const event=job.event;
     const link=`${config.appUrl.replace(/\/$/,'')}/live-demo?fixture=${encodeURIComponent(job.fixture_id)}&record=${encodeURIComponent(event.record_id)}&source=sensor`;
     const footer=job.contact_id?'Contact the unit owner to stop these alerts.':`View your unit: ${link}`;
     const text=`${event.completed?'Slow drainage was measured':'Water is still present'} at ${job.fixture_id}.\nObserved time: ${event.elapsed_seconds.toFixed(1)} seconds.\nAlert limit: ${event.email_threshold_seconds} seconds.\nCheck that the tap is off and the plug is open, then inspect the drain. This is not a confirmed blockage diagnosis.\n\n${footer}`;
     const payload=job.payload??{from:config.from,to:[recipient],subject:`Drainage needs attention: ${job.fixture_id}`,text};
     // Seal before sending so retries cannot change the destination or content.
     await deliveryStore.seal(job,recipient,payload);
     const response=await fetcher('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${config.apiKey}`,'Content-Type':'application/json','Idempotency-Key':`drain/${job.id}`},body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)});
     if(!response.ok)throw Error('Email provider unavailable');
     const {id}=await response.json();
     if(typeof id!=='string')throw Error('Invalid provider acknowledgment');
     await deliveryStore.finish(job,'sent',id);sent++;
    }catch{failed++;
     await deliveryStore.retry(job).catch(()=>{});
     logger('Drainage email remains queued for retry.');
    }
   }));return{sent,failed};})().finally(()=>{flushing=null;});return flushing;
  },
  kick(waitUntil){if(!service.enabled||Date.now()-lastKick<5000)return;lastKick=Date.now();const task=service.flush().catch(()=>logger('Notification delivery worker unavailable.'));if(waitUntil)waitUntil(task);else void task;}
 };return service;
}
export function verifiedUserEmail(url,key,fetcher=fetch){return async id=>{
 const response=await fetcher(`${url}/auth/v1/admin/users/${encodeURIComponent(id)}`,{headers:{apikey:key,...(key.startsWith('eyJ')?{Authorization:`Bearer ${key}`}:{})},signal:AbortSignal.timeout(10000)});if(!response.ok)return null;const user=await response.json();return user.email_confirmed_at&&typeof user.email==='string'?user.email:null;
};}
