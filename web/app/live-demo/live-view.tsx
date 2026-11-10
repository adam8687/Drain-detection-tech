'use client';

import { useState } from 'react';
import MobileMenu from '../../components/mobile-menu';
import type { DataSource } from '../../lib/api';
import { useLiveRecording } from './use-live-recording';
import { HistoryChart, WaterLevelChart } from './charts';
import styles from './page.module.css';

const artwork = '/images/live-view/';
const statusLabels = { learning: 'Learning baseline', unknown: 'Status unavailable', in_progress: 'Draining', normal: 'Normal', slow_drain: 'Slow drain', running_too_long: 'Running too long' };
const date = (value: string) => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export default function LiveView({ initialFixture = '', initialRecord = '', initialSource = 'sensor' }: { initialFixture?: string; initialRecord?: string; initialSource?: DataSource }) {
  const data = useLiveRecording(initialFixture, initialRecord, initialSource);
  const [range, setRange] = useState(30);
  const [query, setQuery] = useState('');
  const [draftToken, setDraftToken] = useState('');
  const view = data.view;
  const fixtureName = data.fixtures.find(f => f.id === data.fixture)?.name || 'Live view';
  const recent = view?.record.measurements.at(-1);
  const levels = view?.computed.water_levels ?? [];
  const hasLevels = levels.some(p => p.sensor_a_mm !== null || p.sensor_b_mm !== null);
  const firstLevel = levels.find(p => p.sensor_a_mm !== null);
  const duration = view?.record.result?.drainage_time_seconds;
  const active = view?.record.recording_status === 'recording';
  const drainStatus = view?.computed.drain_status;
  const baseline = drainStatus?.baseline_seconds;
  const status = !view ? 'No recording' : active && view.computed.stale ? 'Waiting for data' : drainStatus ? statusLabels[drainStatus.status] : active ? 'Recording' : view.record.result?.outcome || 'Saved recording';
  const statusMessage = view?.record.record_type === 'calibration' ? view.computed.calibration_message : view?.computed.forecast.message;
  const fixtureMatches = data.fixtures.filter(f => `${f.name} ${f.id}`.toLowerCase().includes(query.toLowerCase()));

  return <>
    <a href="#live-content" className={styles.skipLink}>Skip to content</a>
    <header className={styles.header}>
      <a className={styles.brand} href="/"><img src="/images/marketing/logo.png" width="32" height="32" alt="" /><span>Company Name</span></a>
      <nav className={styles.navigation} aria-label="Main navigation">
        <a className={styles.activeNav} href="/dashboard">Fleet</a>
        <button disabled title="The building heat map is not available yet">Heat map</button>
      </nav>
      <div className={styles.search}>
        <img src={`${artwork}search.png`} width="16" height="16" alt="" />
        <input aria-label="Search units" placeholder="Search units" type="search" value={query} onChange={event => setQuery(event.target.value)} />
        {query && <div className={styles.searchResults}>
          {fixtureMatches.length ? fixtureMatches.map(f => <button key={f.id} onClick={() => { data.setFixture(f.id); setQuery(''); }}>{f.name}<small>{f.id}</small></button>) : <p>No matching units.</p>}
        </div>}
      </div>
      <a className={`${styles.primary} ${styles.addUnit}`} href="/add-unit">Add unit</a>
      <a className={styles.avatar} href="/login" aria-label="Your account"><img src={`${artwork}avatar.png`} width="40" height="40" alt="" /></a>
      <MobileMenu><a href="/">Home</a><a href="/dashboard">Fleet / recordings</a><a href="/add-unit">Add unit</a><a href="/login">Account</a></MobileMenu>
    </header>

    <main id="live-content" className={styles.content}>
      <a href="/dashboard" className={styles.back}>‹ Back to fleet</a>
      <div className={styles.titleRow}>
        <div className={styles.title}>
          <h1>{fixtureName}</h1>
          <div className={styles.meta}><span className={styles.tag}>{status}</span><span>{data.fixture || 'Choose a fixture'} · {data.source === 'sensor' ? 'Physical sensors' : 'Simulation recordings'}</span></div>
        </div>
        <div className={styles.titleActions}>
          <button className={styles.secondary} disabled aria-describedby="unsupported-actions">Mute alerts</button>
          <button className={styles.primary} disabled aria-describedby="unsupported-actions">Create work order</button>
        </div>
      </div>
      <p id="unsupported-actions" className={styles.supportNote}>{data.source === 'sensor' ? 'Physical sensor recordings' : 'Simulation recordings'} · Alert management and work orders are not available yet.</p>

      <div className={styles.filters}>
        <label>Fixture<select value={data.fixture} disabled={data.loading && !data.fixtures.length} onChange={event => data.setFixture(event.target.value)}>
          {!data.fixtures.length && <option value="">No fixtures available</option>}
          {data.fixtures.map(f => <option key={f.id} value={f.id}>{f.name} · {f.id}</option>)}
        </select></label>
        <label>Data source<select value={data.source} onChange={event => data.setSource(event.target.value as DataSource)}><option value="sensor">Physical sensors</option><option value="simulation">Simulation recordings</option></select></label>
        <label className={styles.recordPicker}>Recording<select value={data.recordId} onChange={event => data.setRecordId(event.target.value)}>
          {!data.records.length && <option value="">No recordings available</option>}
          {data.records.map(r => <option key={r.record_id} value={r.record_id}>{r.record_type} · {date(r.created_at)} · {r.recording_status}</option>)}
        </select></label>
        <button className={styles.secondary} onClick={data.refresh} disabled={data.loading}>Refresh</button>
      </div>

      {data.error && <div className={styles.connection} role="alert">
        <p>{data.needsAuth ? 'Sign in to view your recordings, or connect with your backend access token.' : data.error}</p>
        {data.needsAuth && <><a href="/login">Sign in to your account</a><form onSubmit={event => { event.preventDefault(); data.setToken(draftToken); }}><label>Backend access token<input type="password" autoComplete="off" value={draftToken} onChange={event => setDraftToken(event.target.value)} /></label><button className={styles.primary}>Connect</button></form></>}
      </div>}
      <p className={styles.loading} role="status" aria-live="polite">{data.loading ? 'Loading recordings…' : !data.error && !view ? data.fixture ? 'No recordings for this fixture and data source. Use Recording controls on the dashboard to begin.' : 'No saved fixtures or recordings were found.' : ''}</p>

      <div className={styles.columns} aria-busy={data.loading}>
        <div className={styles.leftColumn}>
          <section className={styles.card} aria-labelledby="last-test">
            <div className={styles.cardHeader}><h2 id="last-test">{view?.record.record_type === 'calibration' ? 'Calibration recording' : view?.record.record_type === 'monitoring' ? 'Monitoring recording' : 'Last drain test'}</h2><span>{view ? date(view.record.created_at) : 'No recording selected'}</span></div>
            <div className={styles.testBody}>
              <figure className={styles.tube}><img src={`${artwork}tube.png`} width="170" height="262" alt="Illustration of a water-level sensor tube" /><figcaption>{firstLevel ? `Start level: ${firstLevel.sensor_a_mm!.toFixed(0)} mm (A)` : 'Sensor illustration'}</figcaption></figure>
              <div className={styles.stats}>
                <p className={styles.caption}>Drain time</p>
                <p className={styles.duration}><strong style={duration != null && duration.toFixed(1).length >= 5 ? { fontSize: 36 } : undefined}>{duration != null ? duration.toFixed(1) : '—'}</strong><span>s</span></p>
                <p className={styles.result}>{duration != null ? 'Measured drainage duration' : active ? 'Test in progress' : view?.record.result?.outcome || 'Result unavailable'}</p>
                <p className={styles.normal}>{baseline != null ? `Baseline ${baseline.toFixed(1)} s` : 'Normal baseline unavailable'}</p>
                <p className={styles.caption}>{baseline != null ? 'Baseline uses the earliest completed drains; starting water level is not normalized.' : 'Needs three completed drains to establish a baseline.'}</p>
              </div>
              {hasLevels ? <WaterLevelChart points={levels} /> : <div className={styles.emptyWater}><p className={styles.caption}>Water level</p><p>{data.loading ? 'Loading measurements…' : 'Calibrated water-level measurements are not available for this recording.'}</p></div>}
            </div>
            {statusMessage && <p className={styles.measurementNote}>{statusMessage}</p>}
            {view && <p className={styles.measurementNote}>Elapsed time starts at the first reading. Drainage duration uses the observed wet-to-dry thresholds; it is not a tap-off timer.</p>}
          </section>

          <section className={styles.card} aria-labelledby="history-title">
            <div className={styles.cardHeader}><h2 id="history-title">Drain time, last {range} days</h2><div className={styles.range} role="group" aria-label="History range">{[7, 30, 90].map(days => <button key={days} aria-pressed={range === days} onClick={() => setRange(days)}>{days}d</button>)}</div></div>
            <HistoryChart records={data.records} range={range} />
            <p className={styles.caption}>Completed recordings for this fixture and source. History is limited to the latest 200 recordings returned by the service.</p>
          </section>
        </div>

        <aside className={styles.rightColumn}>
          <section className={styles.card} aria-labelledby="placement-title">
            <h2 id="placement-title">Where this sensor sits</h2>
            <div className={styles.cutaway}><img src={`${artwork}cutaway.png`} width="360" height="232" alt="Illustration of a sensor mounted beside a sink and its drain pipe" /></div>
            <p className={styles.placement}>Illustrative placement. {data.fixture ? `Fixture: ${data.fixture}.` : 'Select a fixture to view its recording.'} Room and floor details have not been recorded.</p>
          </section>

          <section className={styles.card} aria-labelledby="details-title">
            <h2 id="details-title">Recording details</h2>
            <p className={styles.description}>These values come from the selected recording. A completed test alone does not establish a blockage or slowdown alert.</p>
            <dl className={styles.metrics}>
              <div><dt>Drain status</dt><dd>{drainStatus ? statusLabels[drainStatus.status] : '—'}</dd></div>
              <div><dt>Recording type</dt><dd>{view?.record.record_type || '—'}</dd></div>
              <div><dt>Measurements</dt><dd>{view?.computed.sample_count ?? '—'}</dd></div>
              <div><dt>Empty calibration</dt><dd>{view ? view.record.calibration ? 'Available' : 'Not available' : '—'}</dd></div>
              <div><dt>Connection</dt><dd>{data.error ? 'Unavailable' : view ? active ? view.computed.stale ? 'Stale readings' : 'Live recording' : 'Saved recording' : '—'}</dd></div>
            </dl>
          </section>

          <section className={styles.card} aria-labelledby="activity-title">
            <h2 id="activity-title">Activity</h2>
            <ol className={styles.activity}>
              {recent && <li><img src={`${artwork}dot-dark.png`} width="12" height="12" alt="" /><div><strong>Latest measurement</strong><time dateTime={recent.timestamp}>{date(recent.timestamp)}</time></div></li>}
              {view && <li><img src={`${artwork}dot-muted.png`} width="12" height="12" alt="" /><div><strong>Recording started</strong><time dateTime={view.record.created_at}>{date(view.record.created_at)}</time></div></li>}
              {!view && <li className={styles.caption}>Activity appears when a recording is selected.</li>}
            </ol>
            <a className={styles.managementLink} href="/dashboard">Open recording controls →</a>
          </section>
        </aside>
      </div>
    </main>
  </>;
}
