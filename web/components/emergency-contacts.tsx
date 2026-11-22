'use client';

import {useState} from 'react';
import type {EmergencyContact,EmergencyContactChange} from '../lib/api';
import styles from '../app/live-demo/page.module.css';

export default function EmergencyContacts({contacts,busy,onSave}:{
 contacts:EmergencyContact[];
 busy:boolean;
 onSave:(change:EmergencyContactChange)=>Promise<boolean>;
}){
 const [name,setName]=useState('');
 const [email,setEmail]=useState('');
 const [consent,setConsent]=useState(false);
 const [resumeId,setResumeId]=useState<string|null>(null);

 return (
  <section className={styles.notificationForm} aria-labelledby="emergency-contacts-title">
   <h3 id="emergency-contacts-title">Emergency contacts</h3>
   <p>Email your maintenance contacts when this drain is slow or water stays in the basin.</p>
   {contacts.length>0&&<ul className={styles.emergencyContactList}>
    {contacts.map(contact=><li key={contact.id}>
     <div><strong>{contact.name}</strong><br/>{contact.email??'Email address needed'}<br/>{!contact.email_enabled?'Emails paused':'Emails on'}</div>
     <div className={styles.emergencyContactActions}>
      {!contact.email_enabled?<button type="button" className={styles.secondary} disabled={busy}
       aria-label={`${contact.email?'Resume emails':'Add email address'} for ${contact.name}`} aria-expanded={resumeId===contact.id}
       onClick={()=>setResumeId(resumeId===contact.id?null:contact.id)}>{contact.email?'Resume emails':'Add email address'}</button>:
       <button type="button" className={styles.secondary} disabled={busy} aria-label={`Pause emails for ${contact.name}`}
        onClick={()=>void onSave({set_emergency_contact_email:{id:contact.id,enabled:false}})}>Pause emails</button>}
      <button type="button" className={styles.secondary} disabled={busy} aria-label={`Remove ${contact.name}`}
       onClick={()=>void onSave({remove_emergency_contact:contact.id})}>Remove</button>
     </div>
     {!contact.email_enabled&&resumeId===contact.id&&<form className={styles.emergencyContactResume} onSubmit={async event=>{
      event.preventDefault();
      const formEmail=new FormData(event.currentTarget).get('contact_email');
      if(await onSave({set_emergency_contact_email:{id:contact.id,enabled:true,consent_confirmed:true,
       ...(typeof formEmail==='string'?{email:formEmail.trim()}:{})}}))setResumeId(null);
     }}>
      {!contact.email&&<p><label>Email address for {contact.name}
       <input className={styles.notificationInput} name="contact_email" type="email" maxLength={254} disabled={busy} required/>
      </label></p>}
      <p><label className={styles.notificationChoice}>
       <input type="checkbox" required disabled={busy}/>
       This contact agreed in writing to receive Drain Monitor emails.
      </label></p>
      <button type="submit" className={styles.primary} disabled={busy}>{contact.email?'Confirm and resume':'Save and enable emails'}</button>
     </form>}
    </li>)}
   </ul>}
   {contacts.length<5?<form onSubmit={async event=>{
    event.preventDefault();
    if(!consent)return;
    if(await onSave({add_emergency_contact:{name:name.trim(),email:email.trim(),consent_confirmed:true}})){
     setName('');setEmail('');setConsent(false);
    }
   }}>
    <p><label>Contact name
     <input className={styles.notificationInput} type="text" maxLength={80} value={name} disabled={busy} onChange={event=>setName(event.target.value)} required/>
    </label></p>
    <p><label>Contact email address
     <input className={styles.notificationInput} type="email" maxLength={254} value={email} disabled={busy} onChange={event=>setEmail(event.target.value)} required/>
    </label></p>
    <p><label className={styles.notificationChoice}>
     <input type="checkbox" checked={consent} disabled={busy} onChange={event=>setConsent(event.target.checked)} required/>
     This contact agreed in writing to receive Drain Monitor emails about this drain.
    </label></p>
    <button className={styles.primary} type="submit" disabled={busy}>Add emergency contact</button>
   </form>:<p>This unit has five emergency contacts.</p>}
  </section>
 );
}
