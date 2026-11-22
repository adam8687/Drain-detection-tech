'use client';
import {useEffect,useMemo,useState,useRef} from 'react';
import {DrainApi,DrainApiError,type EmergencyContactChange} from '../lib/api';
import {useSession} from '../lib/supabase';
import styles from '../app/live-demo/page.module.css';
import EmergencyContacts from './emergency-contacts';
export default function EmailSettings({fixture}:{fixture:string}){
 const session=useSession(),api=useMemo(()=>new DrainApi('/api/backend',session?.access_token||''),[session?.access_token]);
 const current=useRef('');current.current=`${session?.user.id??''}:${fixture}`;
 const[pref,setPref]=useState<Awaited<ReturnType<DrainApi['emailPreference']>>|null>(null),[error,setError]=useState(''),[owner,setOwner]=useState(true),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 async function saveContact(change:EmergencyContactChange){
  const key=current.current;
  setBusy(true);setError('');setMessage('');
  try{
   const saved=await api.saveEmergencyContact(fixture,change);
   if(current.current!==key)return false;
   setPref(saved);
   if('set_emergency_contact_email' in change){
    setMessage(change.set_emergency_contact_email.enabled?'Contact emails resumed.':'Contact emails paused.');
   }else{
    setMessage('add_emergency_contact' in change?'Emergency contact added.':'Emergency contact removed.');
   }
   return true;
  }catch(error){
   if(current.current===key)setError(error instanceof DrainApiError&&error.status===422?error.message:'Could not update emergency contacts. Please try again.');
   return false;
  }finally{if(current.current===key)setBusy(false);}
 }
 useEffect(()=>{if(!session||!fixture)return;const controller=new AbortController();setPref(null);setBusy(false);setMessage('');setError('');setOwner(true);void api.emailPreference(fixture,controller.signal).then(value=>{if(!controller.signal.aborted){setPref(value);}}).catch(e=>{if(!controller.signal.aborted){if(e instanceof DrainApiError&&(e.status===403||e.status===404))setOwner(false);else setError('Email settings are not ready yet. Please try again later.');}});return()=>controller.abort();},[api,fixture,session]);
 return <section className={styles.card} aria-labelledby="email-alerts-title"><h2 id="email-alerts-title">Email alerts</h2>{!session?<p><a href="/login">Sign in</a> to manage alerts.</p>:!owner?<p>Only the unit owner can manage alerts.</p>:<><p>Send drainage warnings to your verified account email.</p>{pref?<><label className={styles.notificationChoice}><input type="checkbox" checked={pref.enabled} disabled={busy} onChange={async e=>{const previous=pref,enabled=e.target.checked,key=current.current;setPref({...pref,enabled});setBusy(true);setMessage('');setError('');try{const saved=await api.saveEmailPreference(fixture,enabled,pref.threshold_seconds);if(current.current!==key)return;setPref(saved);setMessage('Email preference saved.');}catch{if(current.current!==key)return;setPref(previous);setError('Could not save your preference. Please try again.');}finally{if(current.current===key)setBusy(false);}}}/> Email me when drainage takes unusually long</label><p>{pref.threshold_seconds?`Your email limit is ${pref.threshold_seconds} seconds.`:'During learning, email warnings start after two minutes. After ten comparable uses, the limit adapts to this fixture.'}</p><p>Each recipient can receive one email per drain event, up to one per hour for this unit.</p>{!pref.provider_configured&&<p role="status">Email delivery is being set up. Your preference can be saved now.</p>}
 <EmergencyContacts key={current.current} contacts={pref.emergency_contacts??[]} busy={busy} onSave={saveContact}/>
 </>:!error&&<p>Loading alert settings…</p>}{message&&<p role="status">{message}</p>}{error&&<p role="alert">{error}</p>}</>}</section>;
}
