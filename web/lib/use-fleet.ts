'use client';

import { useEffect, useMemo, useState } from 'react';
import { DrainApi, DrainApiError } from './api';
import type { DataSource, FleetSummary } from './api';
import { useSession } from './supabase';

export type FleetCategory = 'high' | 'moderate' | 'offline' | 'baseline' | 'good';
export interface FixtureCard {
  id: string; name: string; category: FleetCategory; status: string; record: FleetSummary['record'];
  history: FleetSummary['recent_drains']; seconds: number | null; usual: number | null;
  emptyReady: boolean; at: string | null; reason: string | null;
}

const priority = { high: 0, moderate: 1, offline: 2, baseline: 3, good: 4 };
const overdue = (f: FixtureCard) => f.seconds != null && f.usual != null ? f.seconds - f.usual : -Infinity;
function describeFixtures(units: FleetSummary[]): FixtureCard[] {
  return units.map(unit => {
    const { record, drain_status: current, recent_drains: history, alerts, empty_ready: emptyReady } = unit;
    const latest = history[0];
    let category: FleetCategory = 'good', status = 'Monitoring';
    if (!emptyReady) { category = 'baseline'; status = 'Needs empty baseline'; }
    else if (alerts.some(a => a.type === 'device_silent')) { category = 'offline'; status = 'Check readings'; }
    else if (current?.status === 'running_too_long' || (current?.status === 'slow_drain' && alerts.some(a => a.severity === 'critical'))) {
      category = 'high'; status = current.status === 'running_too_long' ? 'Running too long' : 'Slow drain';
    } else if (current?.empty_shift_mm != null || alerts.some(a => a.type === 'empty_level_shift')) {
      category = 'offline'; status = 'Re-check empty level';
    } else if (alerts.some(a => a.type === 'sensor_faults') || (record?.recording_status === 'recording' && current?.status === 'unknown')) {
      category = 'offline'; status = 'Check readings';
    } else if (current?.status === 'slow_drain' || alerts.some(a => a.type === 'worsening_trend')) {
      category = 'moderate'; status = 'Slow drain';
    } else if (record?.recording_status === 'finished') {
      status = record.record_type === 'calibration' ? 'Ready to monitor' : record.record_type === 'monitoring' ? 'Monitoring paused' : 'Last test normal';
    }
    const measuredStatus = current && ['running_too_long','slow_drain','normal'].includes(current.status);
    const seconds = current?.status === 'running_too_long' || (measuredStatus && current.baseline_source === 'drainage_profile')
      ? current.elapsed_seconds : latest?.seconds ?? (measuredStatus ? current.elapsed_seconds : null);
    return {
      id:unit.device_id,name:unit.name,category,status,record,history,seconds,usual:current?.baseline_seconds??null,emptyReady,
      at:current?.status==='running_too_long' ? unit.last_reading_at : latest?.started_at??null,
      reason:category==='good'||category==='baseline'?null:current?.message??null,
    };
  }).sort((a,b)=>priority[a.category]-priority[b.category] || overdue(b)-overdue(a) || a.name.localeCompare(b.name));
}

export function useFleet(search = '') {
  const session = useSession();
  const [source,setSource] = useState<DataSource>(process.env.NEXT_PUBLIC_DEFAULT_DATA_SOURCE==='simulation'?'simulation':'sensor');
  const [page,setPage] = useState<{key:string;cursors:string[]}>({key:'',cursors:[]});
  const [result,setResult] = useState<{queryKey:string; units:FleetSummary[]; next:string|null}|null>(null);
  const [error,setError] = useState(''), [needsAuth,setNeedsAuth] = useState(false), [loading,setLoading] = useState(true);
  const [revision,setRevision] = useState(0);
  const accessToken = session?.access_token || '';
  const api = useMemo(()=>new DrainApi('/api/backend',accessToken),[accessToken]);
  const normalizedSearch = search.trim().slice(0,100);
  const pageKey = JSON.stringify([source, normalizedSearch, session?.user.id]);
  const cursors = page.key===pageKey ? page.cursors : [];
  const after = cursors.at(-1) ?? '';
  const queryKey = JSON.stringify([pageKey,after]);

  useEffect(()=>{
    if(new URLSearchParams(window.location.search).get('source')==='simulation')setSource('simulation');
  },[]);
  useEffect(()=>{
    const controller = new AbortController();
    let timer:ReturnType<typeof setTimeout>;
    const load = async () => {
      if(document.hidden){timer=setTimeout(load,1000);return;}
      try {
        const next=await api.fleet(source,after,normalizedSearch,controller.signal);
        if(controller.signal.aborted)return;
        setResult({queryKey,units:next.units,next:next.next_cursor});
        setError('');setNeedsAuth(false);
      } catch(e) {
        if(controller.signal.aborted)return;
        setError(e instanceof Error?e.message:'Connection unavailable');
        setNeedsAuth(e instanceof DrainApiError&&e.status===401);
        if(e instanceof DrainApiError&&(e.status===401||e.status===403))setResult(null);
      } finally {
        if(!controller.signal.aborted){setLoading(false);timer=setTimeout(load,30000);}
      }
    };
    setLoading(true);setError('');void load();
    return()=>{controller.abort();clearTimeout(timer);};
  },[api,source,after,normalizedSearch,queryKey,revision]);
  const current = result?.queryKey===queryKey ? result : null;
  const fixtures=useMemo(()=>describeFixtures(current?.units??[]),[current]);
  return {
    fixtures, alertCount:current?.units.reduce((sum,unit)=>sum+unit.alert_count,0)??0,
    source,setSource,error,needsAuth,loading,refresh:()=>setRevision(n=>n+1),
    hasPrevious:cursors.length>0,hasNext:Boolean(current?.next),
    previousPage:()=>setPage({key:pageKey,cursors:cursors.slice(0,-1)}),
    nextPage:()=>{if(current?.next)setPage({key:pageKey,cursors:[...cursors,current.next]});},
  };
}
