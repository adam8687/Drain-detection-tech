import type { Measurement, RecordSummary, RecordView, WaterLevelPoint } from '../../lib/api';
import { compactTimeline, completedDrains, expandDrainCycles } from '../../lib/chart-data';
import styles from './page.module.css';

type Point = { time: number; a: number | null; b?: number | null; gap?: boolean };
const seconds = (value: number) => value < 60 ? `${value.toFixed(1)} s` : value < 3600 ? `${Math.floor(value / 60)}m ${Math.floor(value % 60)}s` : `${Math.floor(value / 3600)}h ${Math.floor(value % 3600 / 60)}m`;

function SensorPlot({ points, title, unit, labels }: { points: Point[]; title: string; unit: string; labels: string[] }) {
  const visible = points.slice(-120);
  const timeline = compactTimeline(visible.map(p => p.time));
  const maxX = Math.max(1, timeline.at(-1)?.position ?? 0);
  const maxY = Math.max(unit === 'mm' ? 100 : 10, ...visible.flatMap(p => [p.a ?? 0, p.b ?? 0]));
  const x = (i: number) => 4 + timeline[i].position / maxX * 352;
  const y = (value: number) => 190 - value / maxY * 180;
  const ticks = [...new Set([0, 1, 2, 3, 4].map(i => Math.round(i * (visible.length - 1) / 4)))].filter(i => i >= 0);
  function path(key: 'a' | 'b') {
    let connected = false;
    return visible.map((p, i) => {
      const value = p[key];
      if (value == null) { connected = false; return ''; }
      if (timeline[i].gap || p.gap) connected = false;
      const command = connected ? 'L' : 'M'; connected = true;
      return `${command}${x(i)},${y(value)}`;
    }).join(' ');
  }
  const gaps = timeline.map((p, i) => ({ ...p, index: i })).filter(p => p.gap);
  const values = visible.some(p => p.a !== null || p.b != null);
  return <div className={styles.waterChart}>
    <p className={styles.caption}>{title} <span>{unit}</span></p>
    {!values ? <p className={styles.emptyChart}>No reliable {unit === 's' ? 'drain-time estimates' : 'sensor readings'} yet.</p> : <>
      <div className={styles.plotRow}>
        <div className={styles.axisY} aria-hidden="true">{[4, 3, 2, 1, 0].map(i => <span key={i}>{(maxY * i / 4).toFixed(0)}</span>)}</div>
        <div className={styles.plotCanvas}>
          <svg viewBox="0 0 364 200" preserveAspectRatio="none" role="img" aria-label={`${title}, ${unit} on the vertical axis. Long pauses are compressed and marked; lines stop at missing data.`}>
            {[0, 1, 2, 3, 4].map(i => <line key={i} x1="4" x2="356" y1={190 - i * 45} y2={190 - i * 45} stroke="#a8d3f0" strokeWidth=".7" />)}
            {gaps.map(p => <g key={p.index}><title>No readings for {seconds(p.missingSeconds)}; pause compressed</title><line x1={(x(p.index - 1) + x(p.index)) / 2} x2={(x(p.index - 1) + x(p.index)) / 2} y1="8" y2="190" stroke="#3f6ea6" strokeDasharray="3 4" /><text x={(x(p.index - 1) + x(p.index)) / 2} y="9" textAnchor="middle">//</text></g>)}
            {(['a', 'b'] as const).slice(0, labels.length).map((key, sensor) => <g key={key}>
              <path d={path(key)} fill="none" stroke={sensor ? '#6baae0' : '#2563ae'} strokeWidth="2.5" strokeDasharray={sensor ? '6 4' : undefined} vectorEffect="non-scaling-stroke" />
              {visible.map((p, i) => p[key] == null ? null : <circle key={i} cx={x(i)} cy={y(p[key]!)} r="2.5" fill={sensor ? '#6baae0' : '#2563ae'}><title>{labels[sensor]}: {p[key]!.toFixed(1)} {unit} · elapsed {seconds(p.time)}</title></circle>)}
            </g>)}
          </svg>
          <div className={styles.timeTicks} aria-hidden="true">{ticks.map(i => <span key={i} style={{ left: `${timeline[i].position / maxX * 100}%` }}>{seconds(timeline[i].time)}</span>)}</div>
        </div>
      </div>
      <div className={styles.legend}>{labels.map((label, i) => <span key={label}>{i ? '┄' : '●'} {label}</span>)}</div>
    </>}
    <p className={styles.caption}>Elapsed time · latest {visible.length} readings{gaps.length ? ` · ${gaps.length} long pause${gaps.length === 1 ? '' : 's'} compressed (//). Labels show actual elapsed time.` : ''}</p>
    {gaps.length > 0 && <details className={styles.gapDetails}><summary>Missing-data periods</summary><ul>{gaps.map(p => <li key={p.index}>{seconds(timeline[p.index - 1].time)} → {seconds(p.time)}: {seconds(p.missingSeconds)} without readings</li>)}</ul></details>}
  </div>;
}

export function WaterLevelChart({ points }: { points: WaterLevelPoint[] }) {
  return <SensorPlot title="Measured water level" unit="mm" labels={['Sensor']} points={points.map(p => ({ time: p.elapsed_seconds, a: p.depth_mm, gap: p.gap_before }))} />;
}

export function RawDistanceChart({ readings, startAt }: { readings: Measurement[]; startAt?:string|null }) {
  const start = Date.parse(startAt ?? readings[0]?.timestamp ?? '');
  return <SensorPlot title="Measured distance (uncalibrated)" unit="mm" labels={['Sensor']} points={readings.map(p => ({ time: (Date.parse(p.timestamp) - start) / 1000, a: p.sensor.status === 'ok' ? p.sensor.distance_mm : null }))} />;
}

export function DrainForecastChart({ view }: { view: RecordView | null }) {
  return <SensorPlot title="Estimated seconds left to drain" unit="s" labels={['Backend estimate']} points={(view?.computed.timeline ?? []).map(p => ({ time: p.elapsed_seconds, a: p.seconds_remaining }))} />;
}

export function HistoryChart({ records, range, onSelect, presentation='bars' }: { records: RecordSummary[]; range: number; onSelect?: (id: string) => void; presentation?:'bars'|'line' }) {
  const points = completedDrains(expandDrainCycles(records), range);
  if (!points.length) return <p className={styles.emptyChart}>No completed drainage tests in the last {range} days. Actual drain times will appear here after a valid test.</p>;
  const threshold=records.find(r=>r.drain_status)?.drain_status?.slow_threshold_seconds??null;
  const maxY = Math.max(10, threshold??0, ...points.map(p => p.result!.drainage_time_seconds!)) * 1.15;
  if(presentation==='line'){
    const first=Date.parse(points[0].created_at),span=Math.max(1,Date.parse(points.at(-1)!.created_at)-first);
    const x=(i:number)=>points.length===1?340:20+(Date.parse(points[i].created_at)-first)/span*640;
    const y=(v:number)=>180-v/maxY*160;
    return <div className={styles.historyChart}><svg viewBox="0 0 680 220" role="img" aria-label={`Measured drain times over the last ${range} days`}>
      {[0,1,2,3,4].map(i=><g key={i}><line x1="20" x2="660" y1={20+i*40} y2={20+i*40} stroke="#a8d3f0"/><text x="0" y={24+i*40} fontSize="10">{Math.round(maxY*(1-i/4))}</text></g>)}
      {threshold!=null&&<g><rect x="20" y={y(threshold)} width="640" height={180-y(threshold)} fill="#cfe6f6" opacity=".6"/><line x1="20" x2="660" y1={y(threshold)} y2={y(threshold)} stroke="#6baae0" strokeDasharray="5 4"/><text x="25" y={y(threshold)-7} fontSize="10">Slow threshold: {threshold.toFixed(1)} s</text></g>}
      <polyline points={points.map((p,i)=>`${x(i)},${y(p.result!.drainage_time_seconds!)}`).join(' ')} fill="none" stroke="#2563ae" strokeWidth="3"/>
      {points.map((p,i)=><g key={p.record_id} role="button" tabIndex={0} aria-label={`Open drain ${p.result!.drainage_time_seconds!.toFixed(1)} seconds`} onClick={()=>onSelect?.(p.parent_record_id??p.record_id)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onSelect?.(p.parent_record_id??p.record_id);}}}><circle cx={x(i)} cy={y(p.result!.drainage_time_seconds!)} r="6" fill="#2563ae" stroke="#fbf8f0" strokeWidth="2"/><title>{new Date(p.created_at).toLocaleString()}: {p.result!.drainage_time_seconds!.toFixed(1)} seconds</title></g>)}
      <text x="20" y="207" fontSize="10">{new Date(points[0].created_at).toLocaleDateString()}</text><text x="660" y="207" fontSize="10" textAnchor="end">{new Date(points.at(-1)!.created_at).toLocaleDateString()}</text>
    </svg></div>;
  }
  return <div className={styles.historyChart}>
    <p className={styles.caption}>Time taken to drain (seconds)</p>
    <div className={styles.plotRow}>
      <div className={styles.axisY} aria-hidden="true">{[4, 3, 2, 1, 0].map(i => <span key={i}>{(maxY * i / 4).toFixed(0)}</span>)}</div>
      <div className={styles.historyBars}>{points.map((p, i) => <button key={p.record_id} onClick={() => onSelect?.(p.parent_record_id??p.record_id)} aria-label={`Open drain test ${new Date(p.created_at).toLocaleString()}, ${p.result!.drainage_time_seconds!.toFixed(1)} seconds`} title={new Date(p.created_at).toLocaleString()}>
        <span className={styles.barValue}>{p.result!.drainage_time_seconds!.toFixed(1)} s</span>
        <span className={styles.bar} style={{ height: `${Math.max(1, p.result!.drainage_time_seconds! / maxY * 180)}px` }} />
        <span className={styles.barDate}>{new Date(p.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}<small>Test {i + 1}</small></span>
      </button>)}</div>
    </div>
    <p className={styles.caption}>{points.length} completed {points.length === 1 ? 'test' : 'tests'} · equal spacing between tests; dates shown below. Click a bar to open the recording.</p>
  </div>;
}
