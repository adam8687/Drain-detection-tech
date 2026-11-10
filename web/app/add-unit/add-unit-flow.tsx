'use client';

import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import AccountPanel from '../../components/account-panel';
import MobileMenu from '../../components/mobile-menu';
import { DrainApi, DrainApiError } from '../../lib/api';
import type { RecordView } from '../../lib/api';
import { supabase, useSession } from '../../lib/supabase';
import { useRecording } from './use-recording';
import shell from '../live-demo/page.module.css';
import styles from './page.module.css';

type Step = 'add' | 'connect' | 'teach' | 'done';
type Method = 'wifi' | 'network';
interface Drain { record_id: string; seconds: number | null }

const BASELINE_DRAINS = 3;
const STEPS: { id: Exclude<Step, 'done'>; label: string }[] = [{ id: 'add', label: 'Add unit' }, { id: 'connect', label: 'Connect' }, { id: 'teach', label: 'Teach baseline' }];
const UNIT_PATTERN = '[a-zA-Z0-9_\\-]{1,64}';

const message = (err: unknown, fallback: string) => err instanceof Error ? err.message : fallback;
const reading = (view: RecordView | null) => {
  const latest = view?.record.measurements.at(-1);
  if (!latest) return null;
  const show = (s: typeof latest.sensor_a) => s.status === 'ok' ? `${s.distance_mm} mm` : s.status.replace('_', ' ');
  return `Sensor A ${show(latest.sensor_a)} · Sensor B ${show(latest.sensor_b)}`;
};

const PhoneIcon = () => <svg className={styles.methodIcon} viewBox="0 0 64 48" aria-hidden="true">
  <rect x="6" y="2" width="22" height="42" rx="4" /><line x1="13" y1="38" x2="21" y2="38" />
  <path d="M36 16a10 10 0 0 1 0 16M42 11a17 17 0 0 1 0 26M48 6a24 24 0 0 1 0 36" />
</svg>;
const ServerIcon = () => <svg className={styles.methodIcon} viewBox="0 0 64 48" aria-hidden="true">
  <rect x="4" y="4" width="40" height="16" rx="4" /><rect x="4" y="28" width="40" height="16" rx="4" />
  <circle cx="12" cy="12" r="2" /><circle cx="12" cy="36" r="2" /><line x1="20" y1="12" x2="36" y2="12" /><line x1="20" y1="36" x2="36" y2="36" />
</svg>;

function Stepper({ step }: { step: Step }) {
  const current = step === 'done' ? STEPS.length : STEPS.findIndex(s => s.id === step);
  return <ol className={styles.stepper} aria-label="Setup progress">
    {STEPS.map((s, i) => <li key={s.id} className={i <= current ? styles.reached : ''} aria-current={i === current ? 'step' : undefined}>
      <span>{i + 1} {s.label}</span><i />
    </li>)}
  </ol>;
}

function DeviceConfig({ unit, recordId, sensorKey }: { unit: string; recordId: string; sensorKey: string | null }) {
  const [copied, setCopied] = useState(false);
  const text = [
    'API_BASE_URL=http://127.0.0.1:8000',
    `SENSOR_FIXTURE_ID=${unit}`,
    `SENSOR_RECORD_ID=${recordId}`,
    `SENSOR_KEY=${sensorKey ?? '<the sensor key you saved in step 2>'}`,
  ].join('\n');
  return <details className={styles.config}>
    <summary>Device settings for this recording</summary>
    <p>Put these in <code>device/usb-bridge/.env</code> on the computer the unit is plugged into, then restart <code>npm run device:upload</code>. Change <code>API_BASE_URL</code> if the backend runs on another machine.</p>
    <pre>{text}</pre>
    <button type="button" className={shell.secondary} onClick={() => void navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); })}>{copied ? 'Copied' : 'Copy settings'}</button>
  </details>;
}

export default function AddUnitFlow() {
  const session = useSession();
  const [token, setToken] = useState(''); const [draftToken, setDraftToken] = useState('');
  const [needsToken, setNeedsToken] = useState(false);
  const api = useMemo(() => new DrainApi('/api/backend', session?.access_token || token), [session?.access_token, token]);

  const [step, setStep] = useState<Step>('add');
  const [unit, setUnit] = useState(''); const [location, setLocation] = useState('');
  const [method, setMethod] = useState<Method>('wifi');
  const [existing, setExisting] = useState(false);
  const [sensorKey, setSensorKey] = useState<string | null>(null);
  const [keyCopied, setKeyCopied] = useState(false);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);

  const [testId, setTestId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [empty, setEmpty] = useState(false);
  const [calibrationId, setCalibrationId] = useState<string | null>(null);
  const [calibrated, setCalibrated] = useState(false);
  const [drainId, setDrainId] = useState<string | null>(null);
  const [drains, setDrains] = useState<Drain[]>([]);
  const [baseline, setBaseline] = useState<number | null>(null);

  const test = useRecording(api, testId);
  const calibration = useRecording(api, calibrationId);
  const drain = useRecording(api, drainId);
  const completed = drains.filter(d => d.seconds !== null);

  function fail(err: unknown, fallback: string) {
    setNeedsToken(err instanceof DrainApiError && err.status === 401);
    setError(message(err, fallback));
  }
  async function run(task: () => Promise<void>, fallback: string) {
    setBusy(true); setError('');
    try { await task(); } catch (err) { fail(err, fallback); } finally { setBusy(false); }
  }

  useEffect(() => { if ((test.view?.record.measurements.length ?? 0) > 0) setConnected(true); }, [test.view]);
  useEffect(() => {
    const record = calibration.view?.record;
    if (record?.recording_status !== 'finished') return;
    if (record.calibration) setCalibrated(true);
    else { setError('Calibration ended before the basin readings were stable. Check that both sensors read and try again.'); setCalibrationId(null); }
  }, [calibration.view]);
  useEffect(() => {
    const view = drain.view;
    if (!view || view.record.recording_status !== 'finished') return;
    const seconds = view.record.result?.outcome === 'completed' ? view.record.result.drainage_time_seconds : null;
    setDrains(previous => previous.some(d => d.record_id === view.record.record_id) ? previous : [...previous, { record_id: view.record.record_id, seconds }]);
    if (seconds === null) setError(`That drain couldn't be timed: ${view.computed.forecast.message} Try again.`);
    if (view.computed.drain_status?.baseline_seconds != null) setBaseline(view.computed.drain_status.baseline_seconds);
    setDrainId(null);
  }, [drain.view]);
  useEffect(() => { if (step === 'teach' && completed.length >= BASELINE_DRAINS) setStep('done'); }, [step, completed.length]);

  const finishTest = async () => { if (testId && test.view?.record.recording_status === 'recording') await api.finish(testId).catch(() => {}); };

  async function addUnit(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      try { await api.register(unit, location); }
      catch (err) {
        if (!(err instanceof DrainApiError && err.status === 409)) throw err;
        const owned = (await api.devices()).devices.some(d => d.device_id === unit);
        setExisting(owned);
        throw Error(owned ? `${unit} is already in your fleet. Continue to issue it a new sensor key and finish setup.` : `${unit} is registered to another account. Check the ID printed on the sensor.`);
      }
      setSensorKey((await api.createDeviceKey(unit)).key);
      setStep('connect');
    }, 'Could not add the unit.');
  }
  async function continueExisting() {
    await run(async () => { setSensorKey((await api.createDeviceKey(unit)).key); setExisting(false); setStep('connect'); }, 'Could not issue a sensor key.');
  }

  const authBlocked = Boolean(supabase) && !session;
  const active = (view: RecordView | null) => view?.record.recording_status === 'recording';

  return <>
    <header className={shell.header}>
      <a className={shell.brand} href="/"><img src="/images/marketing/logo.png" width="32" height="32" alt="" /><span>Company Name</span></a>
      <nav className={shell.navigation} aria-label="Main navigation">
        <a href="/dashboard">Fleet</a>
        <button disabled title="The building heat map is not available yet">Heat map</button>
      </nav>
      <a className={`${shell.primary} ${shell.addUnit} ${styles.headerAdd}`} href="/add-unit" aria-current="page">Add unit</a>
      <MobileMenu><a href="/">Home</a><a href="/dashboard">Fleet / recordings</a><a href="/alerts">Alerts</a><a href="/login">Account</a></MobileMenu>
    </header>

    <main className={styles.layout}>
      <section className={styles.panel} aria-labelledby="setup-title">
        <Stepper step={step} />

        {authBlocked && <>
          <h1 id="setup-title">Add a unit</h1>
          <p className={styles.lead}>Sign in to register sensors to your account.</p>
          <AccountPanel />
        </>}

        {!authBlocked && step === 'add' && <form onSubmit={addUnit} className={styles.form}>
          <div>
            <h1 id="setup-title">Add a unit</h1>
            <p className={styles.lead}>Register a sensor, then teach it what a normal drain looks like.</p>
          </div>
          <label className={styles.field}><span>Unit ID</span>
            <div className={styles.inputWrap}>
              <input required pattern={UNIT_PATTERN} maxLength={64} placeholder="DR-4851" value={unit} onChange={e => { setUnit(e.target.value.trim()); setExisting(false); setError(''); }} aria-describedby="unit-hint" />
              <small id="unit-hint">Printed on the sensor</small>
            </div>
          </label>
          <label className={styles.field}><span>Location</span>
            <input required maxLength={100} placeholder="Floor 3, Room 304" value={location} onChange={e => setLocation(e.target.value)} />
          </label>
          <fieldset className={styles.methods}>
            <legend>How will it connect?</legend>
            {([['wifi', 'Connect to Wi-Fi', 'Finish setup from your phone'], ['network', 'Already on network', 'The unit is already online']] as const).map(([value, title, hint]) =>
              <label key={value} className={method === value ? styles.selected : ''}>
                <input type="radio" name="method" value={value} checked={method === value} onChange={() => setMethod(value)} />
                {value === 'wifi' ? <PhoneIcon /> : <ServerIcon />}
                <strong>{title}</strong><small>{hint}</small>
              </label>)}
          </fieldset>
          <p className={styles.note}>{method === 'wifi' ? "Next you'll get the unit's connection settings, then teach it what normal looks like." : "Next we'll check that readings arrive, then teach the unit what normal looks like."}</p>
          {error && <p role="alert" className={styles.error}>{error}</p>}
          <div className={styles.actions}>
            {existing ? <button type="button" className={shell.primary} disabled={busy} onClick={() => void continueExisting()}>Continue setup</button>
              : <button type="submit" className={shell.primary} disabled={busy}>{busy ? 'Adding…' : 'Add and continue'}</button>}
            <a href="/dashboard" className={styles.cancel}>Cancel</a>
          </div>
        </form>}

        {!authBlocked && step === 'connect' && <div className={styles.form}>
          <div>
            <h1 id="setup-title">Connect {unit}</h1>
            <p className={styles.lead}>Give the unit its sensor key, then check that its readings reach us.</p>
          </div>
          {sensorKey && <div className={styles.keyBox}>
            <strong>Sensor key</strong>
            <p>Shown only once. The unit uses it to upload readings; it can&apos;t read or change anything else.</p>
            <code>{sensorKey}</code>
            <button type="button" className={shell.secondary} onClick={() => void navigator.clipboard.writeText(sensorKey).then(() => setKeyCopied(true))}>{keyCopied ? 'Copied' : 'Copy key'}</button>
          </div>}
          {method === 'wifi' && <p className={styles.note}>Phone-based Wi-Fi setup needs Wi-Fi firmware on the unit, which isn&apos;t available yet. For now, plug the unit into a computer and use the USB uploader with the settings below.</p>}
          {!testId ? <button type="button" className={`${shell.primary} ${styles.big}`} disabled={busy} onClick={() => void run(async () => setTestId((await api.start(unit, 'sensor', 'monitoring')).record_id), 'Could not start the connection test.')}>Start connection test</button>
            : <>
              <div className={`${styles.live} ${connected ? styles.ok : ''}`} role="status">
                <strong>{connected ? `Receiving readings (${test.view?.record.measurements.length})` : 'Waiting for the first reading…'}</strong>
                <span>{reading(test.view) ?? 'Start the uploader on the unit with the settings below.'}</span>
              </div>
              <DeviceConfig unit={unit} recordId={testId} sensorKey={sensorKey} />
            </>}
          {(error || test.error) && <p role="alert" className={styles.error}>{error || test.error}</p>}
          <div className={styles.actions}>
            <button type="button" className={shell.primary} disabled={!connected || busy} onClick={() => void run(async () => { await finishTest(); setStep('teach'); }, 'Could not finish the connection test.')}>Continue</button>
            <button type="button" className={styles.cancel} onClick={() => void run(async () => { await finishTest(); setStep('done'); }, 'Could not finish the connection test.')}>Finish later</button>
          </div>
        </div>}

        {!authBlocked && step === 'teach' && <div className={styles.form}>
          <div>
            <h1 id="setup-title">Teach baseline</h1>
            <p className={styles.lead}>{!calibrated ? 'First, record the empty basin so the unit knows where "dry" is.' : `Now record ${BASELINE_DRAINS} normal drains. Alerts compare future drains against these.`}</p>
          </div>

          {!calibrated && <>
            <label className={styles.check}><input type="checkbox" checked={empty} onChange={e => setEmpty(e.target.checked)} disabled={Boolean(calibrationId)} />The basin is empty, the tap is off and both sensors are fixed in place.</label>
            {!calibrationId ? <button type="button" className={`${shell.primary} ${styles.big}`} disabled={!empty || busy} onClick={() => void run(async () => setCalibrationId((await api.start(unit, 'sensor', 'calibration', true)).record_id), 'Could not start calibration.')}>● Record empty basin</button>
              : <>
                <div className={styles.live} role="status">
                  <strong>Recording empty basin… keep it still</strong>
                  <progress max={1} value={calibration.view?.computed.calibration_progress ?? 0} />
                  <span>{calibration.view?.computed.calibration_message ?? 'Waiting for readings.'}</span>
                </div>
                <DeviceConfig unit={unit} recordId={calibrationId} sensorKey={sensorKey} />
              </>}
          </>}

          {calibrated && <>
            <ol className={styles.drains}>
              {Array.from({ length: BASELINE_DRAINS }, (_, i) => <li key={i} className={completed[i] ? styles.ok : ''}>
                <span>Drain {i + 1}</span><strong>{completed[i] ? `${completed[i].seconds!.toFixed(1)} s` : i === completed.length && drainId ? 'Recording…' : '—'}</strong>
              </li>)}
            </ol>
            {!drainId ? <>
              <p className={styles.note}>Fill the basin as you normally would, press record, then pull the plug. The recording stops by itself once the basin is empty.</p>
              <button type="button" className={`${shell.primary} ${styles.big}`} disabled={busy} onClick={() => void run(async () => setDrainId((await api.start(unit, 'sensor', 'drainage')).record_id), 'Could not start the drain recording.')}>● Record drain {completed.length + 1} of {BASELINE_DRAINS}</button>
            </> : <>
              <div className={styles.live} role="status">
                <strong>Drain now</strong>
                <span>{drain.view?.computed.forecast.state === 'forecast' ? `About ${Math.ceil(drain.view.computed.forecast.seconds_remaining!)} seconds left` : drain.view?.computed.forecast.message ?? 'Waiting for readings.'}</span>
                <span>{reading(drain.view)}</span>
              </div>
              <DeviceConfig unit={unit} recordId={drainId} sensorKey={sensorKey} />
              {active(drain.view) && <button type="button" className={shell.secondary} disabled={busy} onClick={() => void run(async () => { await api.finish(drainId); }, 'Could not stop the recording.')}>Stop recording</button>}
            </>}
          </>}
          {(error || calibration.error || drain.error) && <p role="alert" className={styles.error}>{error || calibration.error || drain.error}</p>}
          <div className={styles.actions}><button type="button" className={styles.cancel} onClick={() => setStep('done')}>Finish later</button></div>
        </div>}

        {!authBlocked && step === 'done' && <div className={styles.form}>
          <div>
            <h1 id="setup-title">{completed.length >= BASELINE_DRAINS ? `${unit} is ready` : `${unit} added`}</h1>
            <p className={styles.lead}>{completed.length >= BASELINE_DRAINS
              ? `Normal drain time is ${baseline != null ? `${baseline.toFixed(1)} seconds` : 'set'}. You'll get an alert when drains get noticeably slower.`
              : `The unit is registered. Status and alerts start once it has ${BASELINE_DRAINS} completed drains (${completed.length} so far). You can record them from the dashboard.`}</p>
          </div>
          <dl className={styles.summary}>
            <div><dt>Unit ID</dt><dd>{unit}</dd></div>
            <div><dt>Location</dt><dd>{location || '—'}</dd></div>
            <div><dt>Connection</dt><dd>{connected ? 'Readings received' : 'Not tested'}</dd></div>
            <div><dt>Empty basin</dt><dd>{calibrated ? 'Recorded' : 'Not recorded'}</dd></div>
            <div><dt>Baseline drains</dt><dd>{completed.length} of {BASELINE_DRAINS}</dd></div>
          </dl>
          <div className={styles.actions}>
            <a className={shell.primary} href={`/live-demo?fixture=${encodeURIComponent(unit)}&source=sensor`}>Open live view</a>
            <a className={shell.secondary} href="/add-unit">Add another unit</a>
          </div>
        </div>}

        {needsToken && <form className={styles.token} onSubmit={e => { e.preventDefault(); setToken(draftToken); setNeedsToken(false); setError(''); }}>
          <label>Backend token <input type="password" autoComplete="off" value={draftToken} onChange={e => setDraftToken(e.target.value)} /></label>
          <button className={shell.secondary}>Connect</button>
        </form>}
      </section>

      <aside className={styles.art} aria-hidden="true">
        <img src="/images/live-view/cutaway.png" alt="" />
        <span className={`${styles.callout} ${styles.calloutUnit}`}>{unit || 'DR-4851'} is printed on the sensor</span>
        <span className={`${styles.callout} ${styles.calloutPhone}`}>{step === 'teach' ? 'Record the empty basin, then three drains' : 'Setup settings go on the unit'}</span>
      </aside>
    </main>
  </>;
}
