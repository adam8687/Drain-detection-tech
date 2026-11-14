'use client';

import EmailSettings from '../../components/email-settings';
import { useState } from 'react';
import ProductHeader from '../../components/product-header';
import OceanWaves from '../../components/ocean-waves';
import DesignAsset from '../../components/design-asset';
import type { DataSource } from '../../lib/api';
import { useLiveRecording } from './use-live-recording';
import { DrainForecastChart, HistoryChart, RawDistanceChart, WaterLevelChart } from './charts';
import styles from './page.module.css';


const statusLabels = { learning: 'Empty baseline needed', unknown: 'Status unavailable', in_progress: 'Draining', normal: 'Normal', slow_drain: 'Slow drain', running_too_long: 'Running too long' };
const date = (value: string) => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

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
  const duration = view?.record.result?.drainage_time_seconds;
  const active = view?.record.recording_status === 'recording';
  const drainStatus = view?.computed.drain_status;
  const baseline = drainStatus?.baseline_seconds;
  const drainLabel=drainStatus?.status==='in_progress'&&drainStatus.elapsed_seconds===null?'Monitoring':drainStatus?statusLabels[drainStatus.status]:'';
  const status = !view ? 'No recording' : active && view.computed.stale ? 'Waiting for data' : drainStatus ? drainLabel : active ? 'Recording' : view.record.result?.outcome || 'Saved recording';
  const statusMessage = view?.record.record_type === 'calibration' ? view.computed.calibration_message : view?.computed.forecast.message;
  const fixtureMatches = data.fixtures.filter(f => `${f.name} ${f.id}`.toLowerCase().includes(query.toLowerCase()));

  return <>
    <a href="#live-content" className={styles.skipLink}>Skip to content</a>
    <ProductHeader active="live" query={query} onQuery={setQuery}/>

    <main id="live-content" className={styles.content}><OceanWaves bottom/>
      <a href="/dashboard" className={styles.back}>‹ Back to fleet</a>
      <div className={styles.titleRow}>
        <div className={styles.title}>
          <h1>{fixtureName}</h1>
          <div className={styles.meta}><span className={styles.tag}>{status}</span><span>{data.fixture || 'Choose a fixture'} · {data.source === 'sensor' ? 'Physical sensor' : 'Simulation recordings'}</span></div>
        </div>
        <div className={styles.titleActions}>
          <button className={styles.secondary} disabled aria-describedby="unsupported-actions">Mute alerts</button>
          <button className={styles.primary} disabled aria-describedby="unsupported-actions">Create work order</button>
        </div>
      </div>
      <p id="unsupported-actions" className={styles.supportNote}>{data.source === 'sensor' ? 'Physical sensor recordings' : 'Simulation recordings'} · Alert management and work orders are not available yet.</p>

      <details className={styles.recordingOptions}><summary>Device and recording options</summary><div className={styles.filters}>
        <label>Data source<select aria-label="Data source" value={data.source} onChange={event => data.setSource(event.target.value as DataSource)}><option value="sensor">Physical sensor</option><option value="simulation">Simulation recordings</option></select></label><button className={styles.secondary} onClick={data.refresh} disabled={data.loading}>Refresh</button>
      </div><section className={styles.deviceList} aria-label="Devices">{fixtureMatches.map(f=><button key={f.id} className={styles.deviceCard} aria-pressed={data.fixture===f.id} onClick={()=>{data.setFixture(f.id);setQuery('');}}><strong>{f.name}</strong><span>{f.id}</span></button>)}</section></details>
      {query&&<div className={styles.searchResultsInline}>{fixtureMatches.map(f=><button key={f.id} className={styles.secondary} onClick={()=>{data.setFixture(f.id);setQuery('');}}>{f.name}</button>)}</div>}

      {data.error && <div className={styles.connection} role="alert">
        <p>{data.needsAuth ? 'Sign in to view your recordings.' : data.error}</p>
        {data.needsAuth && <a href="/login">Sign in to your account</a>}
      </div>}
      <p className={styles.loading} role="status" aria-live="polite">{data.loading ? 'Loading recordings…' : !data.error && !view ? data.fixture ? 'No recordings for this fixture and data source. Use Recording controls on the dashboard to begin.' : 'No saved fixtures or recordings were found.' : ''}</p>

      {data.fixture && <a className={styles.back} href={`/add-unit?fixture=${encodeURIComponent(data.fixture)}`}>Guided drain setup →</a>}
      {drainStatus && (active || drainStatus.status==='unknown' || drainStatus.status==='learning') && <div className={styles.connection} role={drainStatus.status === 'running_too_long' ? 'alert' : 'status'}><strong>{drainLabel}</strong><p>{drainStatus.message}</p><p>Slow threshold: {drainStatus.slow_threshold_seconds?.toFixed(1)} s · Water-still-present limit: {drainStatus.timeout_threshold_seconds?.toFixed(1)} s</p><a href={`/alerts?fixture=${encodeURIComponent(data.fixture)}&source=${data.source}`}>View alerts →</a></div>}
      <div className={styles.columns} aria-busy={data.loading}>
        <div className={styles.leftColumn}>
          <section className={styles.card} aria-labelledby="last-test">
            <div className={styles.cardHeader}><h2 id="last-test">{view?.record.record_type === 'calibration' ? 'Calibration recording' : view?.record.record_type === 'monitoring' ? 'Monitoring recording' : 'Last drain test'}</h2><span>{view ? date(view.record.created_at) : 'No recording selected'}</span></div>
            <div className={styles.testBody}>
              <figure className={styles.tube}><DesignAsset file="f4251.svg"/><figcaption>Sensor illustration</figcaption></figure>
              <div className={styles.stats}>
                <p className={styles.caption}>Drain time</p>
                <p className={styles.duration}><strong style={duration != null && duration.toFixed(1).length >= 5 ? { fontSize: 36 } : undefined}>{duration != null ? duration.toFixed(1) : '—'}</strong><span>s</span></p>
                <p className={styles.result}>{duration != null ? 'Measured drainage duration' : active ? view?.record.record_type === 'drainage' ? 'Drain test in progress' : 'No completed drain test' : view?.record.result?.outcome || 'Result unavailable'}</p>
                <p className={styles.normal}>{baseline != null ? `Usual time ${baseline.toFixed(1)} s` : 'Usual time learning'}</p>
                <p className={styles.caption}>{baseline != null ? 'Usual drain time is learned from comparable completed uses.' : 'Only the empty-sink reference is required for setup.'}</p>
              </div>
              {hasLevels ? <WaterLevelChart points={levels} /> : rawReadings.some(r => r.sensor.distance_mm !== null) ? <RawDistanceChart readings={rawReadings} startAt={view?.computed.first_measurement_at} /> : <div className={styles.emptyWater}><p className={styles.caption}>Water level</p><p>{data.loading ? 'Loading measurements…' : 'Calibrated water-level measurements are not available for this recording.'}</p></div>}
            </div>
            {statusMessage && <p className={styles.measurementNote}>{statusMessage}</p>}
            {view && <p className={styles.measurementNote}>Elapsed time starts at the first reading. Drainage duration uses the observed wet-to-dry thresholds; it is not a tap-off timer.</p>}
          </section>

          <section className={styles.card} aria-labelledby="history-title">
            <div className={styles.cardHeader}><h2 id="history-title">Drain time, last {range} days</h2><div className={styles.range} role="group" aria-label="History range">{[7, 30, 90].map(days => <button key={days} aria-pressed={range === days} onClick={() => setRange(days)}>{days}d</button>)}</div></div>
            <HistoryChart records={data.records} range={range} onSelect={data.setRecordId} presentation="line" />
            <p className={styles.caption}>Completed recordings for this fixture and source. Includes server-measured cycles in monitoring windows and completed tests from the latest 200 recordings.</p>
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
          <section className={styles.card}><h2>Where this sensor sits</h2><div className={styles.cutaway}><div className={styles.cutawayCanvas}><DesignAsset file="adace.svg"/></div></div><p className={styles.placement}>{fixtureName==='Live view'?'Select a fixture to see its location.':fixtureName}</p></section>
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
              <div><dt>Connection</dt><dd>{data.error ? 'Unavailable' : view ? active ? view.computed.stale ? 'Stale readings' : 'Live recording' : 'Saved recording' : '—'}</dd></div>
            </dl>
          </section></details>


        </aside>
      </div>
    </main>
  </>;
}
