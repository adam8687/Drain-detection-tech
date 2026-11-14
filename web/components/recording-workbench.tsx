'use client';

import { useEffect, useMemo, useState } from 'react';
import AccountPanel from '../components/account-panel';
import { useSession } from '../lib/supabase';
import { DrainApi, DrainApiError } from '../lib/api';
import type { AlertSummary, DataSource, DrainStatus, RecordSummary, RecordView } from '../lib/api';
import styles from '../app/dashboard/recording-workbench.module.css';
import { DrainForecastChart, HistoryChart, RawDistanceChart } from '../app/live-demo/charts';
import { selectDeviceRecord } from '../lib/chart-data';

const STATUS_TEXT: Record<DrainStatus['status'], string> = { learning: 'Learning baseline', unknown: 'Status unavailable', in_progress: 'Draining', normal: 'Normal', slow_drain: 'Slow drain', running_too_long: 'Running too long' };
function StatusPill({ value }: { value: DrainStatus | null | undefined }) {
  if (!value) return null;
  const detail = value.baseline_seconds === null ? 'Usual time learning during normal use' : `Usual time ${value.baseline_seconds.toFixed(1)} s${value.ratio === null ? '' : ` · ${value.ratio.toFixed(2)}×`}`;
  return <span className={`${styles.status} ${styles[`status_${value.status}`]}`} title={detail}>{STATUS_TEXT[value.status]}</span>;
}

export default function RecordingWorkbench() {
  const session = useSession();
  const [fixture, setFixture] = useState(process.env.NEXT_PUBLIC_DEFAULT_FIXTURE_ID || 'practice-sink-v2');
  const [source, setSource] = useState<DataSource>(process.env.NEXT_PUBLIC_DEFAULT_DATA_SOURCE === 'sensor' ? 'sensor' : 'simulation');
  const [token, setToken] = useState(''); const [draftToken, setDraftToken] = useState('');
  const [needsToken, setNeedsToken] = useState(false);
  const [devices, setDevices] = useState<{ id: string; name: string }[]>([]);
  const [records, setRecords] = useState<RecordSummary[]>([]);
  const [id, setId] = useState(''); const [sample, setSample] = useState<number | null>(null);
  const [view, setView] = useState<RecordView | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [confirmed, setConfirmed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [alerts, setAlerts] = useState<AlertSummary | null>(null);
  const api = useMemo(() => new DrainApi('/api/backend', session?.access_token || token), [token, session?.access_token]);
  const reportError = (err: unknown) => { setNeedsToken(err instanceof DrainApiError && err.status === 401); setError(err instanceof Error ? err.message : 'Backend unavailable'); };
  useEffect(() => {
    const controller = new AbortController();
    void Promise.allSettled([api.devices(controller.signal), api.recordSummaries(source, controller.signal)]).then(([registry, summaries]) => {
      if (controller.signal.aborted) return;
      const names = new Map(registry.status === 'fulfilled' ? registry.value.devices.map(d => [d.device_id, d.name]) : []);
      if (summaries.status === 'fulfilled') for (const r of summaries.value.records) if (!names.has(r.fixture_id)) names.set(r.fixture_id, r.fixture_id);
      setDevices([...names].map(([id, name]) => ({ id, name })));
      setFixture(previous => names.has(previous) ? previous : names.keys().next().value || previous);
    });
    return () => controller.abort();
  }, [api, source, refresh]);
  useEffect(() => {
    const controller = new AbortController(); setView(null); setRecords([]); setError('');
    const timer = setTimeout(() => { void api.records(fixture, source, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setRecords(value.records); setNeedsToken(false);
      setId(previous => selectDeviceRecord(value.records, previous));
      setSample(null);
    }).catch(err => { if (!controller.signal.aborted) reportError(err); }); }, 250);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, fixture, source, refresh]);
  useEffect(() => {
    const controller = new AbortController(); setAlerts(null);
    const timer = setTimeout(() => { void api.alerts({ fixture, source, limit: 1 }, controller.signal).then(value => { if (!controller.signal.aborted) setAlerts(value.summary); }).catch(() => {}); }, 300);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, fixture, source, refresh]);
  useEffect(() => {
    if (!id || !records.some(r => r.record_id === id)) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      if(document.hidden){timer=setTimeout(load,1000);return;}
      try {
        const value = await api.record(id, sample, controller.signal, records.find(r=>r.record_id===id)?.recording_status==='recording'?120:undefined);
        if (controller.signal.aborted) return;
        setView(value); setError(''); setNeedsToken(false);
        if (value.record.recording_status === 'recording') timer = setTimeout(load, 3000);
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
  return <section className={styles.shell}>
    <a href="/">← Back to home</a>
    <h2>Recording tools</h2>
    <a href="/alerts">All alerts →</a>
    <a href={`/add-unit?fixture=${encodeURIComponent(fixture)}`}>Guided setup for this fixture →</a>
    <div id="account" tabIndex={-1}><AccountPanel /></div>
    <div className={styles.controls}>

      <label>Data <select value={source} onChange={e => { setSource(e.target.value as DataSource); setId(''); }}><option value="simulation">Simulation</option><option value="sensor">Physical sensors</option></select></label>
      <button onClick={() => setRefresh(n => n + 1)}>Refresh</button>
    </div>
    <section className={styles.deviceList} aria-label="Devices">
      {(devices.length ? devices : [{ id: fixture, name: fixture }]).map(d => <button key={d.id} aria-pressed={d.id === fixture} onClick={() => { setFixture(d.id); setId(d.id === fixture ? selectDeviceRecord(records) : ''); setSample(null); }}><strong>{d.name}</strong><small>{d.id}</small><span>View readings →</span></button>)}
    </section>
    {needsToken && <form onSubmit={e => { e.preventDefault(); setToken(draftToken); }}><label>Backend token <input type="password" autoComplete="off" value={draftToken} onChange={e => setDraftToken(e.target.value)} /></label><button>Connect</button></form>}
    {error && <p role="alert">{error}</p>}
    <div className={styles.controls}>
      <details className={styles.recordHistory}><summary>Saved recordings ({records.length})</summary><div className={styles.deviceList}>{records.map(r => <button key={r.record_id} aria-pressed={id === r.record_id} onClick={() => { setId(r.record_id); setSample(null); }}><strong>{r.record_type} · {r.recording_status === 'recording' ? 'Live' : 'Saved'}</strong><small>{new Date(r.created_at).toLocaleString()}</small></button>)}</div></details>
      {view && !active && view.computed.sample_count > 0 && <label>Replay <input type="range" min="0" max={view.computed.sample_count - 1} value={sample ?? view.computed.sample_count - 1} onChange={e => setSample(Number(e.target.value))} /><output>{view.computed.elapsed_seconds.toFixed(1)} seconds</output></label>}
    </div>
    {alerts && alerts.critical + alerts.warning > 0 && <a className={`${styles.alertBanner} ${alerts.critical ? styles.alertBannerCritical : ''}`} href={`/alerts?fixture=${encodeURIComponent(fixture)}&source=${source}`}>
      <strong>{alerts.critical ? `${alerts.critical} critical` : `${alerts.warning} warning`}{alerts.critical && alerts.warning ? ` · ${alerts.warning} warning` : ''}</strong>
      <span>alert{alerts.critical + alerts.warning === 1 ? '' : 's'} for this fixture. View alerts →</span>
    </a>}
    {!records.length && !error && <p>No recordings. Run <code>npm run seed:practice</code> for saved examples, or start a recording below.</p>}
    {view && <>
      <a href={`/live-demo?fixture=${encodeURIComponent(fixture)}&record=${encodeURIComponent(view.record.record_id)}&source=${source}`}>Open live view →</a>
      <div className={styles.badge}>{source === 'simulation' ? 'Simulated sensor data' : 'Physical sensor data'} · {active ? 'Live recording' : 'Saved recording'}</div>
      {view.computed.drain_status && <p role={view.computed.drain_status.status === 'running_too_long' ? 'alert' : 'status'}>{view.computed.drain_status.message}{view.computed.drain_status.timeout_threshold_seconds != null && ` Water-still-present limit: ${view.computed.drain_status.timeout_threshold_seconds.toFixed(1)} s.`}</p>}
      <div className={styles.metrics}>
        {view.computed.drain_status && <div><span>Drain status</span><strong><StatusPill value={view.computed.drain_status} /></strong><small>{view.computed.drain_status.baseline_seconds === null ? 'Needs 3 completed drains for a baseline' : `Baseline ${view.computed.drain_status.baseline_seconds.toFixed(1)} seconds`}</small></div>}
        <div><span>Time left to drain</span><strong>{view.computed.forecast.state === 'forecast' ? `About ${Math.ceil(view.computed.forecast.seconds_remaining!)} seconds` : view.computed.forecast.state === 'dry' ? 'No measurable water' : 'Estimate unavailable'}</strong></div>
        <div><span>Recorded drainage time</span><strong>{view.record.result?.drainage_time_seconds != null ? `${view.record.result.drainage_time_seconds.toFixed(1)} seconds` : view.record.result?.outcome || 'Not finished'}</strong></div>
        <div><span>Measurements</span><strong>{view.computed.sample_count}</strong></div>
      </div>
      <p className={styles.explanation} role="status">{view.record.record_type === 'calibration' ? view.computed.calibration_message : view.computed.forecast.message}</p>
      {view.record.record_type === 'calibration' && active && <progress max="1" value={view.computed.calibration_progress ?? 0} aria-label="Calibration progress" />}
      <section className={`${styles.chart} ${styles.sensorChart}`}><h3>Live sensor distance</h3><RawDistanceChart readings={view.record.measurements} startAt={view.computed.first_measurement_at} /></section>
      <section className={`${styles.chart} ${styles.sensorChart}`}><h3>Time left to drain</h3><DrainForecastChart view={view} /><p>Backend estimate; calibration and valid drainage readings are required.</p></section>
      <details className={styles.chart}><summary>Sensor readings and calibration</summary><pre style={{ overflowX: 'auto', fontSize: 12 }}>{JSON.stringify({ calibration: view.record.calibration, latest_measurement: view.record.measurements[view.computed.sample_index], result: view.record.result }, null, 2)}</pre></details>
    </>}
    <section className={`${styles.chart} ${styles.sensorChart}`}><h3>Time taken to drain</h3><HistoryChart records={records} range={90} onSelect={recordId => { setId(recordId); setSample(null); }} /></section>
    <details className={styles.chart}><summary>Recording controls</summary><div className={styles.controls}>
      <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />Fixture is empty, tap off, sensors fixed.</label>
      <button disabled={busy || !confirmed || active} onClick={() => void action('calibration')}>Calibrate empty fixture</button>
      <button disabled={busy || active} onClick={() => void action('drainage')}>Start drainage</button>
      <button disabled={busy || active} onClick={() => void action('monitoring')}>Start monitoring</button>
      <button disabled={busy || !active} onClick={() => void action('finish')}>Finish recording</button>
    </div></details>
  </section>;
}
