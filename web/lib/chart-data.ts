import type { RecordSummary, RecordView } from './api';

// Five seconds matches the backend's maximum continuous measurement interval.
// Compress only the display coordinates; timestamps and computed results stay intact.
export function compactTimeline(times: number[], maxGap = 5) {
  let position = 0;
  return times.map((time, index) => {
    const delta = index ? Math.max(0, time - times[index - 1]) : 0;
    position += Math.min(delta, maxGap);
    return { time, position, gap: index > 0 && delta > maxGap, missingSeconds: delta };
  });
}

export function selectDeviceRecord(records: RecordSummary[], choice = '') {
  const sorted = [...records].sort((a, b) => b.created_at.localeCompare(a.created_at));
  return sorted.find(r => r.record_id === choice)?.record_id
    || sorted.find(r => r.recording_status === 'recording')?.record_id
    || sorted[0]?.record_id || '';
}

export function completedDrains(records: RecordSummary[], range: number, now = Date.now()) {
  return records.filter(r => r.record_type === 'drainage' && r.recording_status === 'finished'
    && r.result?.outcome === 'completed' && r.result.drainage_time_seconds !== null
    && Number.isFinite(r.result.drainage_time_seconds) && r.result.drainage_time_seconds >= 0
    && Date.parse(r.created_at) >= now - range * 86400000 && Date.parse(r.created_at) <= now)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

// Expand server-computed monitoring cycles for charts while linking to the real record.
export function expandDrainCycles(records: RecordSummary[]):RecordSummary[] {
  return records.flatMap(r => [r,...(r.drain_cycles??[]).map(c => ({...r,record_id:c.cycle_id,parent_record_id:r.record_id,drain_cycles:undefined,record_type:'drainage' as const,recording_status:'finished' as const,created_at:c.started_at,result:{outcome:c.outcome,drainage_time_seconds:c.drainage_time_seconds}}))]);
}

export function mergeLiveView(previous:RecordView|null,next:RecordView,window=120):RecordView {
 if(!previous||previous.record.record_id!==next.record.record_id||next.computed.series_mode!=='append')return next;
 const points=[...new Map([...previous.record.measurements,...next.record.measurements].map(p=>[p.reading_id,p])).values()].sort((a,b)=>a.timestamp.localeCompare(b.timestamp)).slice(-window);
 const merge=<T extends {elapsed_seconds:number}>(old:T[],added:T[])=>[...new Map([...old,...added].map(p=>[p.elapsed_seconds,p])).values()].sort((a,b)=>a.elapsed_seconds-b.elapsed_seconds).slice(-window);
 return {...next,record:{...next.record,measurements:points},computed:{...next.computed,water_levels:merge(previous.computed.water_levels??[],next.computed.water_levels??[]),timeline:merge(previous.computed.timeline,next.computed.timeline)}};
}
