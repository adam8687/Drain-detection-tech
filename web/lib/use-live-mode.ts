'use client';
import {useEffect,useState} from 'react';
import {DrainApi,DrainApiError} from './api';
import type {LiveModeState} from './api';

export const LIVE_RECORD_POLL_MS = 1000;
export const LIVE_DEMO_DURATION_MS = 5 * 60 * 1000;

export function useLiveMode(api:DrainApi,fixture:string,enabled:boolean,reason:'demo'|'calibration'){
 const [state,setState]=useState<{fixture:string;value:LiveModeState}|null>(null),[error,setError]=useState('');
 const [takingLonger,setTakingLonger]=useState(false);
 const active=enabled&&state?.fixture===fixture&&state.value.active;
 useEffect(()=>{
  setTakingLonger(false);
  if(!fixture||!enabled||active)return;
  const timer=setTimeout(()=>setTakingLonger(true),12000);
  return()=>clearTimeout(timer);
 },[active,enabled,fixture]);
 useEffect(()=>{
  setState(null);setError('');if(!fixture||!enabled)return;
  const id=crypto.randomUUID(),controller=new AbortController();let timer:ReturnType<typeof setTimeout>,staleTimer:ReturnType<typeof setTimeout>,retired=false,working=false,renewed=0;
  const release=()=>{void api.releaseLiveMode(fixture,id,reason).catch(()=>{});};
  const tick=async()=>{
   if(retired||working)return;
   if(document.hidden){setState(null);return;}
   working=true;
   let pollDelay=1000;
   try{
    const renew=Date.now()-renewed>=30000;
    const next=renew?await api.setLiveMode(fixture,id,true,reason,controller.signal):await api.liveMode(fixture,controller.signal);
    if(renew)renewed=Date.now();
    if(retired||document.hidden){release();return;}
    if(next.active)pollDelay=2000;
    setState({fixture,value:next});setError('');clearTimeout(staleTimer);staleTimer=setTimeout(()=>{if(!retired)setState(null);},4000);
   }catch(e){if(!retired){setState(null);setError(e instanceof DrainApiError&&e.status===403?'Only the unit owner can start live mode.':'Live mode could not connect. Keep the unit powered on and try again.');}}
   finally{working=false;if(!retired)timer=setTimeout(()=>void tick(),pollDelay);}
  };
  const visibility=()=>{clearTimeout(timer);if(document.hidden){renewed=0;setState(null);release();}else void tick();};
  const leave=()=>{renewed=0;release();};
  document.addEventListener('visibilitychange',visibility);window.addEventListener('pagehide',leave);void tick();
  return()=>{retired=true;clearTimeout(timer);clearTimeout(staleTimer);controller.abort();document.removeEventListener('visibilitychange',visibility);window.removeEventListener('pagehide',leave);release();};
 },[api,fixture,enabled,reason]);
 return {
  active:Boolean(active),
  message:!enabled?'Normal updates':error||(active?'Fast updates connected.':takingLonger?'The unit hasn’t confirmed fast updates. Check that it’s powered on and connected. If it still doesn’t respond, contact your installer.':'Starting fast updates. This can take a few seconds.'),
 };
}
