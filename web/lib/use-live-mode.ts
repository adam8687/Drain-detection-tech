'use client';
import {useEffect,useState} from 'react';
import {DrainApi,DrainApiError} from './api';
import type {LiveModeState} from './api';

export function useLiveMode(api:DrainApi,fixture:string,enabled:boolean,reason:'demo'|'calibration'){
 const [state,setState]=useState<{fixture:string;value:LiveModeState}|null>(null),[error,setError]=useState('');
 useEffect(()=>{
  setState(null);setError('');if(!fixture||!enabled)return;
  const id=crypto.randomUUID(),controller=new AbortController();let timer:ReturnType<typeof setTimeout>,staleTimer:ReturnType<typeof setTimeout>,retired=false,working=false,renewed=0;
  const release=()=>{void api.releaseLiveMode(fixture,id,reason).catch(()=>{});};
  const tick=async()=>{
   if(retired||working)return;
   if(document.hidden){setState(null);return;}
   working=true;
   try{
    const renew=Date.now()-renewed>=30000;
    const next=renew?await api.setLiveMode(fixture,id,true,reason,controller.signal):await api.liveMode(fixture,controller.signal);
    if(renew)renewed=Date.now();
    if(retired||document.hidden){release();return;}
    setState({fixture,value:next});setError('');clearTimeout(staleTimer);staleTimer=setTimeout(()=>{if(!retired)setState(null);},4000);
   }catch(e){if(!retired){setState(null);setError(e instanceof DrainApiError&&e.status===403?'Only the unit owner can start live mode.':'Live mode could not connect. Keep the unit powered on and try again.');}}
   finally{working=false;if(!retired)timer=setTimeout(()=>void tick(),1000);}
  };
  const visibility=()=>{clearTimeout(timer);if(document.hidden){renewed=0;setState(null);release();}else void tick();};
  const leave=()=>{renewed=0;release();};
  document.addEventListener('visibilitychange',visibility);window.addEventListener('pagehide',leave);void tick();
  return()=>{retired=true;clearTimeout(timer);clearTimeout(staleTimer);controller.abort();document.removeEventListener('visibilitychange',visibility);window.removeEventListener('pagehide',leave);release();};
 },[api,fixture,enabled,reason]);
 const value=enabled&&state?.fixture===fixture?state.value:null;
 return {active:value?.active===true,state:value,error:enabled?error:'',message:!enabled?'Normal updates':error|| (value?.active?'Live · fast updates confirmed':value?.capable?'Starting live view…':'Waiting for the unit to confirm live mode. If this continues, contact your installer for a device update.')};
}
