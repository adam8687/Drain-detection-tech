import type { RecordSummary, WaterLevelPoint } from '../../lib/api';
import styles from './page.module.css';

export function WaterLevelChart({ points }: { points: WaterLevelPoint[] }) {
  const maxTime = Math.max(10, ...points.map(p => p.elapsed_seconds));
  const maxDepth = Math.max(10, ...points.flatMap(p => [p.sensor_a_mm ?? 0, p.sensor_b_mm ?? 0]));
  function path(sensor: 'sensor_a_mm' | 'sensor_b_mm') {
    let connected = false;
    return points.map(point => {
      const depth = point[sensor];
      if (depth === null) { connected = false; return ''; }
      if (point.gap_before) connected = false;
      const command = connected ? 'L' : 'M'; connected = true;
      return `${command}${4 + point.elapsed_seconds / maxTime * 352},${190 - depth / maxDepth * 180}`;
    }).join(' ');
  }
  return <div className={styles.waterChart}>
    <p className={styles.caption}>Water level <span>mm</span></p>
    <div className={styles.plotRow}>
      <div className={styles.axisY} aria-hidden="true">{[4, 3, 2, 1, 0].map(i => <span key={i}>{Math.round(maxDepth * i / 4)}</span>)}</div>
      <div className={styles.plotCanvas}>
        <svg viewBox="0 0 364 200" preserveAspectRatio="none" role="img" aria-label="Measured water depth in millimeters against elapsed seconds for sensors A and B">
          {[0, 1, 2, 3, 4].map(i => <line key={i} x1="4" x2="356" y1={190 - i * 45} y2={190 - i * 45} stroke="#b8c0ca" strokeWidth=".7" />)}
          <path d={path('sensor_a_mm')} fill="none" stroke="#4b5865" strokeWidth="3" vectorEffect="non-scaling-stroke" />
          <path d={path('sensor_b_mm')} fill="none" stroke="#7fa3c7" strokeWidth="2.5" strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
          {points.length === 1 && points[0].sensor_a_mm !== null && <circle cx="4" cy={190 - points[0].sensor_a_mm / maxDepth * 180} r="4" fill="#4b5865" />}
        </svg>
        <div className={styles.axisX} aria-hidden="true">{[0, 1, 2, 3, 4].map(i => <span key={i}>{Math.round(maxTime * i / 4)} s</span>)}</div>
      </div>
    </div>
    <div className={styles.legend}><span>● Sensor A</span><span>┄ Sensor B</span></div>
  </div>;
}

export function HistoryChart({ records, range }: { records: RecordSummary[]; range: number }) {
  const end = Date.now(), start = end - range * 86400000;
  const points = records.filter(r => r.record_type === 'drainage' && r.result?.outcome === 'completed'
    && r.result.drainage_time_seconds !== null && Date.parse(r.created_at) >= start && Date.parse(r.created_at) <= end)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (!points.length) return <p className={styles.emptyChart}>No completed drainage tests in the last {range} days.</p>;
  const maxY = Math.max(10, ...points.map(p => p.result!.drainage_time_seconds!));
  const coordinates = points.map(p => ({ x: 8 + (Date.parse(p.created_at) - start) / (end - start) * 664, y: 190 - p.result!.drainage_time_seconds! / maxY * 180, record: p }));
  return <div className={styles.historyChart}>
    <div className={styles.plotRow}>
      <div className={styles.axisY} aria-hidden="true">{[4, 3, 2, 1, 0].map(i => <span key={i}>{Math.round(maxY * i / 4)} s</span>)}</div>
      <div className={styles.plotCanvas}>
        <svg viewBox="0 0 680 200" preserveAspectRatio="none" role="img" aria-label={`Completed drainage durations in seconds over the last ${range} days, positioned by recording date`}>
          {[0, 1, 2, 3, 4].map(i => <line key={i} x1="8" x2="672" y1={190 - i * 45} y2={190 - i * 45} stroke="#b8c0ca" strokeWidth=".7" />)}
          <path d={coordinates.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ')} fill="none" stroke="#4b5865" strokeWidth="3" vectorEffect="non-scaling-stroke" />
          {coordinates.map(p => <circle key={p.record.record_id} cx={p.x} cy={p.y} r="4" fill="white" stroke="#4b5865" strokeWidth="2" vectorEffect="non-scaling-stroke"><title>{new Date(p.record.created_at).toLocaleString()}: {p.record.result!.drainage_time_seconds!.toFixed(1)} seconds</title></circle>)}
        </svg>
        <div className={styles.axisX} aria-hidden="true">{[0, 1, 2, 3].map(i => <span key={i}>{i === 3 ? 'Today' : new Date(start + (end - start) * i / 3).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>)}</div>
      </div>
    </div>
    <p className={styles.caption}>{points.length} completed {points.length === 1 ? 'test' : 'tests'} · dated by recording start</p>
  </div>;
}
