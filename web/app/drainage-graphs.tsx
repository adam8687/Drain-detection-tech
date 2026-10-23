'use client';

import { useId } from 'react';
import type { Calibration, DrainTest, Frame } from '../lib/api';
import { forecastDrainage, drainageTimeSeries } from '../lib/forecast';
import styles from './insights/insights.module.css';

type Point = { x: number; y: number | null };
type Series = { name: string; color: string; points: Point[]; dashed?: boolean };
const colors = ['#2563eb', '#c05621'];
function Plot({ title, description, series, guides = [], xMax, yMin = 0, yMax, unit = 'mm', xLabel = 'Seconds from first displayed reading', accessibilityDescription = 'Separate lines show sensor A and sensor B. Gaps indicate missing measurements.' }: {
  title: string; description: string; series: Series[]; guides?: { y: number; label: string; color: string }[]; xMax: number; yMin?: number; yMax: number; unit?: string; xLabel?: string; accessibilityDescription?: string;
}) {
  const id = useId();
  const x = (n: number) => 60 + n / Math.max(1, xMax) * 596;
  const y = (n: number) => 220 - (n - yMin) / Math.max(1, yMax - yMin) * 184;
  return <figure className={styles.chart}>
    <figcaption><h3>{title}</h3><p>{description}</p></figcaption>
    <svg viewBox="0 0 700 278" role="img" aria-labelledby={`${id}-title ${id}-description`}>
      <title id={`${id}-title`}>{title}</title><desc id={`${id}-description`}>{description} {accessibilityDescription}</desc>
      {[0, 1, 2, 3, 4].map(i => { const value = yMin + (yMax - yMin) * i / 4; return <g key={i}>
        <line x1="60" x2="656" y1={y(value)} y2={y(value)} stroke="currentColor" opacity="0.12" />
        <text x="50" y={y(value) + 4} textAnchor="end" fill="currentColor" fontSize="12">{Math.round(value)}</text>
        <text x={x(xMax * i / 4)} y="242" textAnchor="middle" fill="currentColor" fontSize="12">{(xMax * i / 4).toFixed(0)}</text>
      </g>; })}
      <text x="60" y="20" fill="currentColor" fontSize="12">{unit}</text><text x="358" y="266" fill="currentColor" fontSize="12" textAnchor="middle">{xLabel}</text>
      {guides.map(guide => <g key={guide.label}><line x1="60" x2="656" y1={y(guide.y)} y2={y(guide.y)} stroke={guide.color} strokeDasharray="3 5" /><text x="655" y={y(guide.y) - 5} textAnchor="end" fill={guide.color} fontSize="11">{guide.label}</text></g>)}
      {series.map(line => {
        let drawing = false;
        const path = line.points.map(p => { if (p.y == null) { drawing = false; return ''; } const command = drawing ? 'L' : 'M'; drawing = true; return `${command}${x(p.x).toFixed(2)},${y(p.y).toFixed(2)}`; }).join(' ');
        return <path key={line.name} d={path} fill="none" stroke={line.color} strokeWidth="2.5" strokeDasharray={line.dashed ? '7 5' : undefined} />;
      })}
    </svg>
    <div className={styles.legend}>{series.map(line => <span key={line.name}><i style={{ borderColor: line.color, borderTopStyle: line.dashed ? 'dashed' : 'solid' }} />{line.name}</span>)}</div>
  </figure>;
}

export default function DrainageGraphs({ frames, calibration, tests, stale, preview = false, historicalReplay = false }: { frames: Frame[]; calibration: Calibration | null; tests: DrainTest[]; stale: boolean; preview?: boolean; historicalReplay?: boolean }) {
  const latest = [...frames].sort((a, b) => Date.parse(b.measured_at) - Date.parse(a.measured_at))[0];
  // Never connect different installations, clock bases, devices or sources with a line.
  const rows = frames.filter(f => latest && f.device_id === latest.device_id && f.source === latest.source && f.boot_id === latest.boot_id && f.time_basis === latest.time_basis && f.calibration_id === latest.calibration_id).sort((a, b) => Date.parse(a.measured_at) - Date.parse(b.measured_at));
  const origin = rows.length ? Date.parse(rows[0].measured_at) : 0;
  const elapsed = rows.length ? (Date.parse(rows.at(-1)!.measured_at) - origin) / 1000 : 0;
  const forecast = forecastDrainage(rows, calibration, stale);
  const countdown = drainageTimeSeries(rows, calibration, stale);
  const countdownElapsed = countdown.at(-1)?.x ?? 0;
  const dry = calibration?.dry_threshold_mm ?? 8;
  const wet = calibration?.wet_threshold_mm ?? 20;
  const depthValues = rows.flatMap(f => f.levels.filter(l => l.quality === 'ok' && l.depth_mm !== null).map(l => l.depth_mm!));
  const distanceValues = rows.flatMap(f => f.levels.filter(l => l.status === 'ok' && l.distance_mm !== null).map(l => l.distance_mm!));
  const maxDepth = Math.max(40, ...depthValues) * 1.15;
  const chartSeries = (field: 'depth_mm' | 'distance_mm'): Series[] => (['a', 'b'] as const).map((sensor, i) => {
    const points: Point[] = [];
    rows.forEach((frame, index) => {
      const seconds = (Date.parse(frame.measured_at) - origin) / 1000;
      if (index && (frame.sequence !== rows[index - 1].sequence + 1 || Date.parse(frame.measured_at) - Date.parse(rows[index - 1].measured_at) > (calibration?.max_gap_ms ?? 5000))) points.push({ x: seconds, y: null });
      const level = frame.levels.find(l => l.sensor_id === sensor);
      points.push({ x: seconds, y: level && (field === 'distance_mm' ? level.status === 'ok' : level.quality === 'ok') ? level[field] : null });
    });
    return { name: `Sensor ${sensor.toUpperCase()}`, color: colors[i], points };
  });
  const extrapolation: Series[] = forecast.state === 'forecast' ? forecast.lines.filter(l => l.remaining > 0).map(l => ({ name: `${l.sensor.toUpperCase()} forecast`, color: colors[l.sensor === 'a' ? 0 : 1], dashed: true, points: [{ x: elapsed, y: l.depth }, { x: elapsed + l.remaining, y: dry }] })) : [];
  const complete = tests.filter(t => latest && t.device_id === latest.device_id && t.source === latest.source && t.calibration_id === calibration?.id && t.status === 'finished' && t.analysis?.outcome === 'completed' && Number.isFinite(t.analysis.drain_duration_ms)).sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
  const maxDuration = Math.max(1, ...complete.map(t => t.analysis!.drain_duration_ms! / 1000));
  const lastTest = complete.at(-1);
  const countdownSeries: Series[] = [{ name: 'Earlier estimates', color: colors[0], points: countdown }];
  if (forecast.state === 'forecast' && countdown.length) countdownSeries.push({ name: 'Projected countdown', color: colors[0], dashed: true, points: [{ x: countdownElapsed, y: forecast.remaining }, { x: countdownElapsed + forecast.remaining!, y: 0 }] });
  const timeStatus = forecast.state === 'forecast' ? `About ${Math.ceil(forecast.remaining!)} seconds left`
    : forecast.state === 'dry' ? countdown.length ? 'Drainage complete' : 'No measurable water' : 'Estimate unavailable';
  return <section className={styles.graphs} aria-label="Drainage visualizations">
    <div className={styles.badge}>{historicalReplay ? 'Supabase · recorded mock data replay' : preview ? 'Synthetic preview · never written to Supabase' : `Stored ${latest?.source ?? 'sensor'} readings · Supabase`}</div>
    <div className={styles.metrics}>
      <div><span>Time left to drain</span><strong>{timeStatus}</strong></div>
      <div><span>Latest completed test</span><strong>{lastTest ? `${(lastTest.analysis!.drain_duration_ms! / 1000).toFixed(1)} seconds` : 'No completed tests'}</strong></div>
      <div><span>Completed tests</span><strong>{complete.length}</strong></div>
    </div>
    <p className={styles.explanation} role="status">{forecast.state === 'forecast' ? historicalReplay ? 'Replaying a saved test · estimated countdown.' : 'Estimate assumes the tap is off.' : forecast.state === 'dry' ? 'No measurable water detected.' : forecast.reason}</p>
    {!rows.length ? <p>No readings yet. Choose a device or use the synthetic preview.</p> : <>
      <Plot title="Estimated time left to drain" description="Estimated seconds remaining. Dashed line shows the projection." series={countdownSeries} guides={[{ y: 0, label: 'No waiting left', color: '#64748b' }]} xMax={Math.max(10, countdownElapsed + (forecast.remaining ?? 0))} yMax={Math.max(10, ...countdown.map(p => p.y ?? 0)) * 1.15} unit="Seconds left" xLabel="Seconds since water was first detected in this view" accessibilityDescription="A single line shows estimated seconds remaining. Gaps mean an estimate was unavailable. Zero requires valid dry confirmation, not a missing echo." />
      {!countdown.length && <p className={styles.note}>The countdown begins after water is detected. Waiting for a drainage event.</p>}
    </>}
    <figure className={styles.chart}><figcaption><h3>Drainage time by test</h3><p>Shorter bars mean faster drainage.</p></figcaption>
      {complete.length ? <div className={styles.bars}>{complete.map((test, index) => <div className={styles.barRow} key={test.id}><span>Test {index + 1}</span><div className={styles.barTrack}><div style={{ width: `${test.analysis!.drain_duration_ms! / 1000 / maxDuration * 100}%` }} /></div><strong>{(test.analysis!.drain_duration_ms! / 1000).toFixed(1)} seconds</strong></div>)}</div> : <p>No completed tests with this calibration. Start and finish a controlled drainage test to build the history.</p>}
    </figure>
    <details className={styles.chart}><summary>Sensor measurements and calibration details</summary>
      <p className={styles.note}>{forecast.reason}</p>
      <p className={styles.note}>The sensors measure distance. The app uses those measurements to estimate time; seconds remaining are a prediction, not a direct sensor reading.</p>
      <p>Empty reference A / B: {calibration ? `${calibration.empty_distance_mm.a} / ${calibration.empty_distance_mm.b} mm` : 'Not calibrated'}.</p>
      <Plot title="Water depth → estimated time to dry" description="Depth = empty reference − measured distance. Solid lines are observations; dashed lines extrapolate the recent trend. Missing echoes leave gaps." series={[...chartSeries('depth_mm'), ...extrapolation]} guides={[{ y: dry, label: `Dry threshold ${dry} mm`, color: '#64748b' }, { y: wet, label: `Wet threshold ${wet} mm`, color: '#64748b' }]} xMax={Math.max(10, elapsed + (forecast.remaining ?? 0))} yMax={maxDepth} />
      <Plot title="What the US-100 actually measures" description="Distance increases as water drains away from the sensor. Each sensor has its own empty reference." series={chartSeries('distance_mm')} guides={calibration ? (['a', 'b'] as const).map((sensor, i) => ({ y: calibration.empty_distance_mm[sensor], label: `${sensor.toUpperCase()} empty reference`, color: colors[i] })) : []} xMax={Math.max(10, elapsed)} yMin={Math.max(0, Math.min(...distanceValues, calibration?.empty_distance_mm.a ?? 400) - 20)} yMax={Math.max(100, ...distanceValues, calibration?.empty_distance_mm.a ?? 0, calibration?.empty_distance_mm.b ?? 0) + 30} />
    </details>
    <details className={styles.chart}><summary>Inspect plotted readings and measurement quality</summary><div className={styles.tableScroll}><table><thead><tr><th>Elapsed (s)</th><th>A distance / depth (mm)</th><th>B distance / depth (mm)</th><th>Quality A / B</th></tr></thead><tbody>{rows.map(f => <tr key={f.event_id}><td>{((Date.parse(f.measured_at) - origin) / 1000).toFixed(1)}</td>{(['a', 'b'] as const).map(sensor => { const l = f.levels.find(l => l.sensor_id === sensor); return <td key={sensor}>{l?.distance_mm?.toFixed(1) ?? '—'} / {l?.depth_mm?.toFixed(1) ?? '—'}</td>; })}<td>{f.levels.map(l => l.quality).join(' / ')}</td></tr>)}</tbody></table></div></details>
  </section>;
}
