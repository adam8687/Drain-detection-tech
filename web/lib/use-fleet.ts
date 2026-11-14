'use client';
import {useEffect,useMemo,useState} from 'react';
import {DrainApi,DrainApiError} from './api';
import type {DataSource,DrainAlert,RecordSummary} from './api';
import {useSession} from './supabase';
import {expandDrainCycles,selectDeviceRecord} from './chart-data';
export type FleetCategory='high'|'moderate'|'offline'|'baseline'|'good';
export interface FixtureCard {id:string;name:string;category:FleetCategory;status:string;record:RecordSummary|null;history:RecordSummary[];seconds:number|null;usual:number|null;emptyReady:boolean;at:string|null;reason:string|null}
// Seconds beyond this sink's own baseline: the most overdue unit leads its group.
const over=(f:FixtureCard)=>f.seconds!=null&&f.usual!=null?f.seconds-f.usual:-Infinity;
export function describeFixtures(devices:{device_id:string;name:string}[],records:RecordSummary[],alerts:DrainAlert[]):FixtureCard[] {
 const names=new Map(devices.map(d=>[d.device_id,d.name]));for(const r of records)if(!names.has(r.fixture_id))names.set(r.fixture_id,r.fixture_id);
 return [...names].map(([id,name])=>{
  const raw=records.filter(r=>r.fixture_id===id).sort((a,b)=>b.created_at.localeCompare(a.created_at)||b.record_id.localeCompare(a.record_id));
  const history=expandDrainCycles(raw).sort((a,b)=>b.created_at.localeCompare(a.created_at));
  const selected=selectDeviceRecord(raw),record=raw.find(r=>r.record_id===selected)??null;
  const completed=history.find(r=>r.result?.outcome==='completed');
  const current=record?.drain_status,emptyReady=history.some(r=>r.schema_version!==1&&r.calibration!==null);
  const own=alerts.filter(a=>a.fixture_id===id&&a.record_id===record?.record_id);
  let category:FleetCategory='good',status='Monitoring';
  if(!emptyReady){category='baseline';status='Needs empty baseline';}
  else if(current?.status==='running_too_long'||(current?.status==='slow_drain'&&own.some(a=>a.severity==='critical'))){category='high';status=current.status==='running_too_long'?'Running too long':'Slow drain';}
  else if(current?.empty_shift_mm!=null||own.some(a=>a.type==='empty_level_shift')){category='offline';status='Re-check empty level';}
  else if(own.some(a=>a.type==='device_silent'||a.type==='sensor_faults')||(record?.recording_status==='recording'&&current?.status==='unknown')){category='offline';status='Check readings';}
  else if(current?.status==='slow_drain'||own.some(a=>a.type==='worsening_trend')){category='moderate';status='Slow drain';}
  else if(record?.recording_status==='finished')status=record.record_type==='calibration'?'Ready to monitor':record.record_type==='monitoring'?'Monitoring paused':'Last test normal';
  // With a drainage profile the status already holds the time at matching depths, the same basis as `usual`.
  const matched=current?.baseline_source==='drainage_profile'&&current.elapsed_seconds!=null&&(current.status==='normal'||current.status==='slow_drain')?current.elapsed_seconds:null;
  const seconds=matched??completed?.result?.drainage_time_seconds??(current?.status==='running_too_long'||current?.status==='slow_drain'||current?.status==='normal'?current.elapsed_seconds:null)??null;
  const at=current?.status==='running_too_long'?new Date().toISOString():completed?.created_at??null;
  return{id,name,category,status,record,history,seconds,usual:current?.baseline_seconds??null,emptyReady,at,reason:category==='good'||category==='baseline'?null:current?.message??null};
 }).sort((a,b)=>({high:0,moderate:1,offline:2,baseline:3,good:4}[a.category]-{high:0,moderate:1,offline:2,baseline:3,good:4}[b.category])||over(b)-over(a)||a.name.localeCompare(b.name));
}
export function useFleet(){
 const session=useSession();const[source,setSource]=useState<DataSource>(process.env.NEXT_PUBLIC_DEFAULT_DATA_SOURCE==='simulation'?'simulation':'sensor');
 const[devices,setDevices]=useState<{device_id:string;name:string}[]>([]),[records,setRecords]=useState<RecordSummary[]>([]),[alerts,setAlerts]=useState<DrainAlert[]>([]);
 const[error,setError]=useState(''),[needsAuth,setNeedsAuth]=useState(false),[loading,setLoading]=useState(true),[revision,setRevision]=useState(0);
 const api=useMemo(()=>new DrainApi('/api/backend',session?.access_token||''),[session?.access_token]);
 useEffect(()=>{const q=new URLSearchParams(window.location.search);if(q.get('source')==='simulation')setSource('simulation');},[]);
 useEffect(()=>{const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;setLoading(true);
  const load=async()=>{if(document.hidden){timer=setTimeout(load,1000);return;}try{
   const [registry,summary,warning]=await Promise.allSettled([api.devices(controller.signal),api.recordSummaries(source,controller.signal),api.alerts({source,limit:200},controller.signal)]);
   if(controller.signal.aborted)return;if(summary.status==='rejected')throw summary.reason;
   setRecords(summary.value.records);setDevices(registry.status==='fulfilled'?registry.value.devices:[]);setAlerts(warning.status==='fulfilled'?warning.value.alerts:[]);setError('');setNeedsAuth(false);
  }catch(e){if(!controller.signal.aborted){setError(e instanceof Error?e.message:'Connection unavailable');setNeedsAuth(e instanceof DrainApiError&&e.status===401);}}
  finally{if(!controller.signal.aborted){setLoading(false);timer=setTimeout(load,30000);}}};void load();return()=>{controller.abort();clearTimeout(timer);};
 },[api,source,revision]);
 const fixtures=useMemo(()=>describeFixtures(devices,records,alerts),[devices,records,alerts]);
 return{fixtures,records,alerts,source,setSource,error,needsAuth,loading,refresh:()=>setRevision(n=>n+1)};
}
