'use client';

import EmailSettings from '../../components/email-settings';
import { useEffect, useState } from 'react';
import ProductHeader from '../../components/product-header';
import OceanWaves from '../../components/ocean-waves';
import DesignAsset from '../../components/design-asset';
import type { DataSource, Measurement } from '../../lib/api';
import { useLiveRecording } from './use-live-recording';
import { DrainForecastChart, HistoryChart, RawDistanceChart, WaterLevelChart } from './charts';
import styles from './page.module.css';


const statusLabels = { learning: 'Empty baseline needed', unknown: 'Status unavailable', in_progress: 'Draining', normal: 'Normal', slow_drain: 'Slow drain', running_too_long: 'Running too long' };
const date = (value: string) => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const readingTime = (value: string) => new Date(value).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const FAST_READING_MAX_AGE_MS = 3000;

function ReadingUpdates({ recording, fast, enabled, expired, status, recent, depth, unavailable, onToggle }: {
  recording: boolean; fast: boolean; enabled: boolean; expired: boolean; status: string; recent?: Measurement;
  depth: number | null; unavailable: boolean; onToggle: (enabled: boolean) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!recording) return;
    const update = () => { if (!document.hidden) setNow(Date.now()); };
    update();
    const timer = setInterval(update, 500);
    document.addEventListener('visibilitychange', update);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', update); };
  }, [recording]);

  const ageMs = recent ? Math.max(0, now - Date.parse(recent.timestamp)) : null;
  const ageSeconds = ageMs === null ? null : Math.floor(ageMs / 1000);
  const age = ageSeconds === null ? '' : ageSeconds === 0 ? 'less than 1 second ago'
    : ageSeconds === 1 ? '1 second ago' : ageSeconds >= 60 ? 'over a minute ago' : `${ageSeconds} seconds ago`;
  let message = 'Monitoring updates arrive in groups. When the sink is idle, a change can take around 20 seconds to appear.';
  if (!recording && !enabled) message = recent ? 'Viewing a saved recording.' : 'Select an active recording to watch for updates.';
  else if (unavailable) message = 'Connection interrupted. Showing the last available readings.';
  else if (expired) message = 'Live updates ended. Normal monitoring has resumed.';
  else if (enabled) {
    if (!fast) message = status;
    else if (ageMs === null) message = 'Fast updates connected. Waiting for the first reading.';
    else if (ageMs > FAST_READING_MAX_AGE_MS) message = 'Readings are delayed. Check that the unit is powered on and connected.';
    else if (recent?.sensor.status !== 'ok') message = 'The unit is responding. Check that the sensor is clear and secure.';
    else message = 'Live readings are arriving.';
  }

  return <section className={styles.card} aria-label="Reading updates">
    <label><input type="checkbox" role="switch" aria-label="Live updates" checked={enabled} disabled={!recording && !enabled} onChange={event => onToggle(event.target.checked)}/> Live updates</label>
    <p role="status">{message}</p>
    {recent && <p className={styles.caption}>
      Last reading at <time dateTime={recent.timestamp}>{readingTime(recent.timestamp)}</time>
      {recording && age && ` · ${age}`}
      {depth !== null && ` · Water level ${Math.round(depth)} mm`}
    </p>}
    <p className={styles.caption}>Live updates run for up to five minutes while this page is visible. Turn them on again when you need them.</p>
  </section>;
}

export default function LiveView({ initialFixture = '', initialRecord = '', initialSource = 'sensor' }: { initialFixture?: string; initialRecord?: string; initialSource?: DataSource }) {
  const data = useLiveRecording(initialFixture, initialRecord, initialSource);
  const [range, setRange] = useState(30);
  const [query, setQuery] = useState('');
  const view = data.view;
  const fixtureName = data.fixtures.find(f => f.id === data.fixture)?.name || 'Live view';
  const recent = view?.record.measurements.at(-1);
  const levels = view?.computed.water_levels ?? [];
  const rawReadings = view?.record.measurements ?? [];
  const hasLevels = levels.some(p => p.depth_mm !== null);
  const hasDistances = rawReadings.some(r => r.sensor.status === 'ok' && r.sensor.distance_mm !== null);
  const hasChart = hasLevels || hasDistances;
  const distance = recent?.sensor.status === 'ok' ? recent.sensor.distance_mm : null;
  const reading = hasLevels ? levels.at(-1)?.depth_mm : distance;
  const lastCycle = view?.computed.drain_cycles?.findLast(cycle => cycle.outcome === 'completed' && cycle.drainage_time_seconds !== null);
  const result = view?.record.result;
  const duration = result?.outcome === 'completed' ? result.drainage_time_seconds : lastCycle?.drainage_time_seconds;
  const active = view?.record.recording_status === 'recording';
  const drainStatus = view?.computed.drain_status;
  const baseline = drainStatus?.baseline_seconds;
  const drainLabel=drainStatus?.status==='in_progress'&&drainStatus.elapsed_seconds===null?'Monitoring':drainStatus?statusLabels[drainStatus.status]:'';
  const status = data.error ? 'Connection interrupted' : !view ? 'No recording' : active && view.computed.stale ? 'Waiting for data' : drainStatus ? drainLabel : active ? 'Recording' : view.record.result?.outcome || 'Saved recording';
  const calibrating = view?.record.record_type === 'calibration';
  const needsCalibration = view?.record.record_type === 'monitoring' && !view.record.calibration;
  const fixtureMatches = data.fixtures.filter(f => `${f.name} ${f.id}`.toLowerCase().includes(query.toLowerCase()));

  return <>
    <a href="#live-content" className={styles.skipLink}>Skip to content</a>
    <ProductHeader active="live" query={query} onQuery={setQuery}/>

    <main id="live-content" className={styles.content}><OceanWaves bottom/>
      <a href="/dashboard" className={styles.back}>‹ Back to dashboard</a>
      <div className={styles.titleRow}>
        <div className={styles.title}>
          <h1>{fixtureName}</h1>
          <div className={styles.meta}><span className={styles.tag}>{status}</span><span>{data.fixture || 'Choose a unit'} · {data.source === 'sensor' ? 'Physical sensor' : 'Simulation recordings'}</span></div>
        </div>
      </div>

      <details className={styles.recordingOptions}><summary>Device and recording options</summary><div className={styles.filters}>
        <label>Data source<select aria-label="Data source" value={data.source} onChange={event => data.setSource(event.target.value as DataSource)}><option value="sensor">Physical sensor</option><option value="simulation">Simulation recordings</option></select></label><button className={styles.secondary} onClick={data.refresh} disabled={data.loading}>Refresh</button>
      </div><section className={styles.deviceList} aria-label="Devices">{fixtureMatches.map(f=><button key={f.id} className={styles.deviceCard} aria-pressed={data.fixture===f.id} onClick={()=>{data.setFixture(f.id);setQuery('');}}><strong>{f.name}</strong><span>{f.id}</span></button>)}</section></details>
      {query&&<div className={styles.searchResultsInline}>{fixtureMatches.map(f=><button key={f.id} className={styles.secondary} onClick={()=>{data.setFixture(f.id);setQuery('');}}>{f.name}</button>)}</div>}

      {data.error && <div className={styles.connection} role="alert">
        <p>{data.needsAuth ? 'Sign in to view your recordings.' : data.error}</p>
        {data.needsAuth && <a href="/login">Sign in to your account</a>}
      </div>}
      <p className={styles.loading} role="status" aria-live="polite">{data.loading ? 'Loading recordings…' : !data.error && !view ? data.fixture ? 'No recordings for this unit yet. Use guided drain setup below to begin.' : 'No units or recordings yet. Add a unit to begin.' : ''}</p>

      {data.fixture && <a className={styles.back} href={`/add-unit?fixture=${encodeURIComponent(data.fixture)}`}>Guided drain setup →</a>}
      {data.fixture && data.source === 'sensor' && <ReadingUpdates recording={active} fast={data.live.active} enabled={data.demo} expired={data.demoExpired} status={data.live.message} recent={recent} depth={levels.at(-1)?.depth_mm ?? null} unavailable={Boolean(data.error)} onToggle={data.setDemo}/>}
      {drainStatus && (active || drainStatus.status==='unknown' || drainStatus.status==='learning') && <div className={styles.connection} role={drainStatus.status === 'running_too_long' ? 'alert' : 'status'}><strong>{drainLabel}</strong><p>{drainStatus.message}</p><p>Slow threshold: {drainStatus.slow_threshold_seconds?.toFixed(1)} s · Water-still-present limit: {drainStatus.timeout_threshold_seconds?.toFixed(1)} s</p><a href={`/alerts?fixture=${encodeURIComponent(data.fixture)}&source=${data.source}`}>View alerts →</a></div>}
      <div className={styles.columns} aria-busy={data.loading}>
        <div className={styles.leftColumn}>
          <section className={styles.card} aria-labelledby="last-test">
            <div className={styles.cardHeader}><h2 id="last-test">{view?.record.record_type === 'calibration' ? 'Calibration recording' : view?.record.record_type === 'monitoring' ? 'Monitoring recording' : 'Last drain test'}</h2><span>{view ? date(view.record.created_at) : 'No recording selected'}</span></div>
            {(view?.record.continued_from || view?.record.continued_in) && <nav aria-label="Monitoring windows" className={styles.measurementNote}>
              {view.record.continued_from && <a href={`/live-demo?fixture=${encodeURIComponent(data.fixture)}&source=${data.source}&record=${view.record.continued_from}`}>Previous recording window</a>}
              {view.record.continued_from && view.record.continued_in && ' · '}
              {view.record.continued_in && <a href={`/live-demo?fixture=${encodeURIComponent(data.fixture)}&source=${data.source}&record=${view.record.continued_in}`}>Next recording window</a>}
            </nav>}
            {(hasChart || duration != null) && <dl className={styles.recordingMetrics}>
              {hasChart && <div>
                <dt>{hasLevels ? 'Latest water level' : 'Latest sensor distance'}</dt>
                <dd>{reading != null ? <><strong>{reading.toLocaleString(undefined, { maximumFractionDigits: 1 })}</strong> <span>mm</span></> : 'No clear reading'}</dd>
              </div>}
              {duration != null && <div>
                <dt>{lastCycle ? 'Last completed drain' : 'Measured drain time'}</dt>
                <dd><strong>{duration.toFixed(1)}</strong> <span>s</span></dd>
                {baseline != null && <dd className={styles.caption}>Usual drain time {baseline.toFixed(1)} s</dd>}
              </div>}
            </dl>}
            {hasLevels ? <WaterLevelChart points={levels} /> : hasDistances ? <RawDistanceChart readings={rawReadings} startAt={view?.computed.first_measurement_at} /> : <p className={styles.recordingEmpty}>
              {data.loading ? 'Loading measurements…' : active ? recent ? 'The sensor is responding, but hasn’t returned a clear distance yet.' : 'Waiting for the first sensor reading.' : 'No sensor readings to show.'}
            </p>}
            {calibrating && view.computed.calibration_message && <p className={styles.measurementNote}>{view.computed.calibration_message}</p>}
            {needsCalibration && <p className={styles.measurementNote}>{data.source === 'sensor' && data.fixture
              ? <a href={`/add-unit?fixture=${encodeURIComponent(data.fixture)}`}>Calibrate the empty sink</a> : 'This recording needs an empty-sink reference'} to see water level and drain time.</p>}
            {view?.record.record_type === 'drainage' && duration == null && <p className={styles.measurementNote}>{active ? 'Drain test in progress.' : 'This test ended without a measured drain time.'}</p>}
          </section>

          <section className={styles.card} aria-labelledby="history-title">
            <div className={styles.cardHeader}><h2 id="history-title">Drain time, last {range} days</h2><div className={styles.range} role="group" aria-label="History range">{[7, 30, 90].map(days => <button key={days} aria-pressed={range === days} onClick={() => setRange(days)}>{days}d</button>)}</div></div>
            <HistoryChart records={data.records} range={range} onSelect={data.setRecordId} presentation="line" />
            <p className={styles.caption}>Completed recordings for this unit. Includes server-measured cycles in monitoring windows and completed tests from the latest 200 recordings.</p>
          </section>
          <details className={styles.card}><summary>Drain-time forecast</summary><section aria-labelledby="forecast-title">
            <h2 id="forecast-title">Time left to drain</h2>
            <DrainForecastChart view={view} />
            <p className={styles.caption}>Seconds on the vertical axis. Estimates require valid calibration and a measurable fall in water level.</p>
          </section></details>

        </div>

        <aside className={styles.rightColumn}>
          {data.fixture&&<EmailSettings fixture={data.fixture}/>}
          <section className={styles.card} aria-labelledby="flagged-title"><h2 id="flagged-title">{drainStatus?.status==='slow_drain'||drainStatus?.status==='running_too_long'?'Why it was flagged':'Drain monitoring'}</h2><p className={styles.description}>{drainStatus?.message??'Save the empty-sink reference to begin monitoring.'}</p><dl className={styles.metrics}><div><dt>Usual drain time</dt><dd>{baseline!=null?`${baseline.toFixed(1)} s`:'Learning from normal use'}</dd></div><div><dt>Slow-drain threshold</dt><dd>{drainStatus?.slow_threshold_seconds!=null?`${drainStatus.slow_threshold_seconds.toFixed(1)} s`:'—'}</dd></div><div><dt>Water-still-present limit</dt><dd>{drainStatus?.timeout_threshold_seconds!=null?`${drainStatus.timeout_threshold_seconds.toFixed(1)} s`:'—'}</dd></div><div><dt>Empty reference</dt><dd>{view?.record.calibration?'Saved':'Not recorded'}</dd></div></dl></section>
          <section className={styles.card}><h2>Where this sensor sits</h2><div className={styles.cutaway}><div className={styles.cutawayCanvas}><DesignAsset file="adace.svg"/></div></div><p className={styles.placement}>{fixtureName==='Live view'?'Select a unit to see its location.':fixtureName}</p></section>
          <section className={styles.card} aria-labelledby="activity-title">
            <h2 id="activity-title">Activity</h2>
            <ol className={styles.activity}>
              {recent && <li><DesignAsset file="fc4c2.svg"/><div><strong>Latest measurement</strong><time dateTime={recent.timestamp}>{date(recent.timestamp)}</time></div></li>}
              {view && <li><DesignAsset file="77fd1.svg"/><div><strong>Recording started</strong><time dateTime={view.record.created_at}>{date(view.record.created_at)}</time></div></li>}
              {!view && <li className={styles.caption}>Activity appears when a recording is selected.</li>}
            </ol>
            <a className={styles.managementLink} href="/dashboard">Open recording controls →</a>
          </section>
          <details className={styles.card}><summary>Latest sensor readings</summary><section aria-labelledby="readings-title">
            <h2 id="readings-title">Latest sensor readings</h2>
            <dl className={styles.metrics}>
              {(['sensor'] as const).map((key) => <div key={key}><dt>Sensor distance</dt><dd>{recent?.[key].status === 'ok' && recent[key].distance_mm !== null ? `${recent[key].distance_mm.toFixed(1)} mm` : 'No valid reading'}</dd></div>)}
              <div><dt>Time left to drain</dt><dd>{view?.computed.forecast.seconds_remaining != null ? `${view.computed.forecast.seconds_remaining.toFixed(1)} s` : 'Not available'}</dd></div>
              <div><dt>Read at</dt><dd>{recent ? new Date(recent.timestamp).toLocaleString() : '—'}</dd></div>
            </dl>
          </section></details>

          <details className={styles.card}><summary>Recordings</summary><section aria-labelledby="recordings-title">
            <h2 id="recordings-title">Recordings</h2>
            <div className={styles.recordList}>
              {data.records.map(r => <button key={r.record_id} aria-pressed={data.recordId === r.record_id} onClick={() => data.setRecordId(r.record_id)}>
                <strong>{r.record_type} · {r.recording_status === 'recording' ? 'Live' : 'Saved'}</strong>
                <span>{date(r.created_at)}</span>
                <small>{r.measurement_count} readings{r.result?.drainage_time_seconds != null ? ` · ${r.result.drainage_time_seconds.toFixed(1)} s to drain` : ''}</small>
              </button>)}
              {!data.records.length && <p className={styles.caption}>No recordings for this device.</p>}
            </div>
          </section></details>

          <details className={styles.card}><summary>Recording details</summary><section aria-labelledby="details-title">
            <h2 id="details-title">Recording details</h2>
            <p className={styles.description}>These values come from the selected recording. A completed test alone does not establish a blockage or slowdown alert.</p>
            <dl className={styles.metrics}>
              <div><dt>Drain status</dt><dd>{drainStatus ? statusLabels[drainStatus.status] : '—'}</dd></div>
              <div><dt>Recording type</dt><dd>{view?.record.record_type || '—'}</dd></div>
              <div><dt>Measurements</dt><dd>{view?.computed.sample_count ?? '—'}</dd></div>
              <div><dt>Empty calibration</dt><dd>{view ? view.record.calibration ? 'Available' : 'Not available' : '—'}</dd></div>
              <div><dt>Connection</dt><dd>{data.error ? 'Unavailable' : view ? active ? view.computed.stale ? 'Waiting for readings' : 'Recording in progress' : 'Saved recording' : '—'}</dd></div>
            </dl>
          </section></details>


        </aside>
      </div>
    </main>
  </>;
}
