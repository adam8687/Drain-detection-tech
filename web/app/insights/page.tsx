'use client';

import { useEffect, useMemo, useState } from 'react';
import AccountPanel from '../account-panel';
import { useSession } from '../../lib/supabase';
import { DrainApi, DrainApiError } from '../../lib/api';
import type { DataSource, RecordSummary, RecordView } from '../../lib/api';
import styles from './insights.module.css';

export default function InsightsPage() {
  const session = useSession();
  const [fixture, setFixture] = useState('practice-sink-v2');
  const [source, setSource] = useState<DataSource>('simulation');
  const [token, setToken] = useState(''); const [draftToken, setDraftToken] = useState('');
  const [needsToken, setNeedsToken] = useState(false);
  const [records, setRecords] = useState<RecordSummary[]>([]);
  const [id, setId] = useState(''); const [sample, setSample] = useState<number | null>(null);
  const [view, setView] = useState<RecordView | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [confirmed, setConfirmed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const api = useMemo(() => new DrainApi('/api/backend', session?.access_token || token), [token, session?.access_token]);
  const reportError = (err: unknown) => { setNeedsToken(err instanceof DrainApiError && err.status === 401); setError(err instanceof Error ? err.message : 'Backend unavailable'); };
  useEffect(() => {
    const controller = new AbortController(); setView(null); setRecords([]); setError('');
    const timer = setTimeout(() => { void api.records(fixture, source, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setRecords(value.records); setNeedsToken(false);
      setId(previous => value.records.some(r => r.record_id === previous) ? previous : value.records.find(r => r.recording_status === 'recording')?.record_id || value.records.find(r => r.result?.outcome === 'completed')?.record_id || value.records.find(r => r.record_type === 'drainage')?.record_id || value.records[0]?.record_id || '');
      setSample(null);
    }).catch(err => { if (!controller.signal.aborted) reportError(err); }); }, 250);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, fixture, source, refresh]);
  useEffect(() => {
    if (!id || !records.some(r => r.record_id === id)) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const value = await api.record(id, sample, controller.signal);
        if (controller.signal.aborted) return;
        setView(value); setError(''); setNeedsToken(false);
        if (value.record.recording_status === 'recording') timer = setTimeout(load, 1500);
      } catch (err) { if (!controller.signal.aborted) reportError(err); }
    };
    timer = setTimeout(() => void load(), 120);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, id, sample, records]);
  async function action(type: 'calibration' | 'drainage' | 'monitoring' | 'finish') {
    setBusy(true); setError('');
    try {
      if (type === 'finish') { if (!view) return; await api.finish(view.record.record_id); }
      else { const next = await api.start(fixture, source, type, confirmed); setId(next.record_id); }
      setRefresh(n => n + 1);
    } catch (err) { reportError(err); } finally { setBusy(false); }
  }
  const active = view?.record.recording_status === 'recording';
  const chart = view?.computed.timeline ?? [];
  const maxX = Math.max(10, ...chart.map(p => p.elapsed_seconds)), maxY = Math.max(10, ...chart.map(p => p.seconds_remaining ?? 0));
  let drawing = false;
  const path = chart.map(p => { if (p.seconds_remaining === null) { drawing = false; return ''; } const prefix = drawing ? 'L' : 'M'; drawing = true; return `${prefix}${60 + p.elapsed_seconds / maxX * 590},${220 - p.seconds_remaining / maxY * 180}`; }).join(' ');
  const results = records.filter(r => r.result?.outcome === 'completed');
  const maxDuration = Math.max(1, ...results.map(r => r.result!.drainage_time_seconds!));
  return <main className={styles.shell}>
    <h1>Drainage insights</h1>
    <AccountPanel />
    <div className={styles.controls}>
      <label>Fixture <input aria-label="Fixture" value={fixture} onChange={e => { setFixture(e.target.value); setId(''); }} /></label>
      <label>Data <select value={source} onChange={e => { setSource(e.target.value as DataSource); setId(''); }}><option value="simulation">Simulation</option><option value="sensor">Physical sensors</option></select></label>
      <button onClick={() => setRefresh(n => n + 1)}>Refresh</button>
    </div>
    {needsToken && <form onSubmit={e => { e.preventDefault(); setToken(draftToken); }}><label>Backend token <input type="password" autoComplete="off" value={draftToken} onChange={e => setDraftToken(e.target.value)} /></label><button>Connect</button></form>}
    {error && <p role="alert">{error}</p>}
    <div className={styles.controls}>
      <label>Recording <select value={id} onChange={e => { setId(e.target.value); setSample(null); setView(null); }}><option value="">Select a recording</option>{records.map(r => <option key={r.record_id} value={r.record_id}>{r.record_type} · {r.result?.drainage_time_seconds != null ? `${r.result.drainage_time_seconds.toFixed(1)} seconds` : r.result?.outcome || r.recording_status} · {new Date(r.created_at).toLocaleDateString()}</option>)}</select></label>
      {view && !active && view.computed.sample_count > 0 && <label>Replay <input type="range" min="0" max={view.computed.sample_count - 1} value={sample ?? view.computed.sample_count - 1} onChange={e => setSample(Number(e.target.value))} /><output>{view.computed.elapsed_seconds.toFixed(1)} seconds</output></label>}
    </div>
    {!records.length && !error && <p>No recordings. Run <code>npm run seed:practice</code> for saved examples, or start a recording below.</p>}
    {view && <>
      <div className={styles.badge}>{source === 'simulation' ? 'Simulated sensor data' : 'Physical sensor data'} · {active ? 'Live recording' : 'Saved recording'}</div>
      <div className={styles.metrics}>
        <div><span>Time left to drain</span><strong>{view.computed.forecast.state === 'forecast' ? `About ${Math.ceil(view.computed.forecast.seconds_remaining!)} seconds` : view.computed.forecast.state === 'dry' ? 'No measurable water' : 'Estimate unavailable'}</strong></div>
        <div><span>Recorded drainage time</span><strong>{view.record.result?.drainage_time_seconds != null ? `${view.record.result.drainage_time_seconds.toFixed(1)} seconds` : view.record.result?.outcome || 'Not finished'}</strong></div>
        <div><span>Measurements</span><strong>{view.computed.sample_count}</strong></div>
      </div>
      <p className={styles.explanation} role="status">{view.record.record_type === 'calibration' ? view.computed.calibration_message : view.computed.forecast.message}</p>
      {view.record.record_type === 'calibration' && active && <progress max="1" value={view.computed.calibration_progress ?? 0} aria-label="Calibration progress" />}
      <figure className={styles.chart}><figcaption><h3>Estimated time left to drain</h3><p>Calculated by the backend. Gaps mean an estimate was unavailable.</p></figcaption>
        <svg viewBox="0 0 700 280" role="img" aria-label="Estimated seconds remaining against elapsed seconds">
          {[0,1,2,3,4].map(i => <g key={i}><line x1="60" x2="650" y1={220 - i * 45} y2={220 - i * 45} stroke="currentColor" opacity=".12" /><text x="50" y={224 - i * 45} textAnchor="end" fill="currentColor" fontSize="12">{Math.round(maxY * i / 4)}</text><text x={60 + i * 147.5} y="244" textAnchor="middle" fill="currentColor" fontSize="12">{Math.round(maxX * i / 4)}</text></g>)}
          <text x="60" y="20" fill="currentColor" fontSize="12">Seconds remaining</text><path d={path} fill="none" stroke="#2563eb" strokeWidth="2.5" /><text x="350" y="272" textAnchor="middle" fill="currentColor" fontSize="12">Elapsed seconds</text>
        </svg>
      </figure>
      <details className={styles.chart}><summary>Sensor readings and calibration</summary><pre style={{ overflowX: 'auto', fontSize: 12 }}>{JSON.stringify({ calibration: view.record.calibration, latest_measurement: view.record.measurements[view.computed.sample_index], result: view.record.result }, null, 2)}</pre></details>
    </>}
    {results.length > 0 && <figure className={styles.chart}><figcaption><h3>Drainage time by recording</h3><p>Shorter bars mean faster drainage.</p></figcaption><div className={styles.bars}>{[...results].reverse().map((r, i) => <div className={styles.barRow} key={r.record_id}><span>Test {i + 1}</span><div className={styles.barTrack}><div style={{ width: `${r.result!.drainage_time_seconds! / maxDuration * 100}%` }} /></div><strong>{r.result!.drainage_time_seconds!.toFixed(1)} seconds</strong></div>)}</div></figure>}
    <details className={styles.chart}><summary>Recording controls</summary><div className={styles.controls}>
      <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />Fixture is empty, tap off, sensors fixed.</label>
      <button disabled={busy || !confirmed || active} onClick={() => void action('calibration')}>Calibrate empty fixture</button>
      <button disabled={busy || active} onClick={() => void action('drainage')}>Start drainage</button>
      <button disabled={busy || active} onClick={() => void action('monitoring')}>Start monitoring</button>
      <button disabled={busy || !active} onClick={() => void action('finish')}>Finish recording</button>
    </div></details>
  </main>;
}
