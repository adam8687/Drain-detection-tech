'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import AccountPanel from '../../components/account-panel';
import ProductHeader from '../../components/product-header';
import DesignAsset from '../../components/design-asset';
import OceanWaves from '../../components/ocean-waves';
import { DrainApi, DrainApiError } from '../../lib/api';
import type { Calibration, RecordView } from '../../lib/api';
import { supabase, useSession } from '../../lib/supabase';
import { useRecording } from './use-recording';
import { useLiveMode } from '../../lib/use-live-mode';
import DrainageSetup from './drainage-setup';
import shell from '../live-demo/page.module.css';
import styles from './page.module.css';

type Step = 'add' | 'connect' | 'drain' | 'done';

const STEPS = [{ id: 'add', label: 'Add unit' }, { id: 'connect', label: 'Connect and calibrate' }, { id: 'drain', label: 'Check drainage' }];
const UNIT_PATTERN = '[a-zA-Z0-9_\\-]{1,64}';

function baselineStatus(view: RecordView | null, error: string, waitingTooLong: boolean) {
  if (error) return { title: 'Setup page couldn’t refresh', hint: error };
  switch (view?.computed.sensor_connection) {
    case 'stale':
      return { title: 'Uploads paused', hint: 'Check power and Wi-Fi. Leave this check open so it can resume when readings return.' };
    case 'problem':
      return { title: 'Device online, sensor has no distance', hint: 'Check the sensor wiring and aim it straight down at the empty basin. This check resumes automatically.' };
    case 'connected':
      return { title: 'Device online', hint: view?.computed.calibration_message ?? 'Keep the basin empty and the sensor still.' };
    default:
      return waitingTooLong
        ? { title: 'No uploads yet', hint: 'Check power and configured Wi-Fi, then restart the device once. For a USB installation, check that the bridge is running.' }
        : { title: 'Waiting for the first upload', hint: 'Keep the device powered on. Wi-Fi can take a moment after startup.' };
  }
}

function Stepper({ step }: { step: Step }) {
  const current = step === 'done' ? STEPS.length : STEPS.findIndex(item => item.id === step);
  return <ol className={styles.stepper} aria-label="Setup progress">
    {STEPS.map((item, i) => <li key={item.id} className={i <= current ? styles.reached : ''} aria-current={i === current ? 'step' : undefined}>
      <span>{i + 1} {item.label}</span><i />
    </li>)}
  </ol>;
}

export default function AddUnitFlow() {
  const session = useSession();
  const api = useMemo(() => new DrainApi('/api/backend', session?.access_token || ''), [session?.access_token]);
  const [step, setStep] = useState<Step>('add');
  const [unit, setUnit] = useState('');
  const [location, setLocation] = useState('');
  const [existing, setExisting] = useState(false);
  const [empty, setEmpty] = useState(false);
  const [recordId, setRecordId] = useState<string | null>(null);
  const [calibrationId, setCalibrationId] = useState<string | null>(null);
  const [observationId, setObservationId] = useState<string | null>(null);
  const [reference, setReference] = useState<Calibration | null>(null);
  const [provisioned, setProvisioned] = useState<boolean | null>(null);
  const [waitingTooLong, setWaitingTooLong] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [resumeFixture, setResumeFixture] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [restoreFailed, setRestoreFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const pendingAction = useRef(false);
  const recording = useRecording(api, recordId);
  const authBlocked = Boolean(supabase) && !session;
  const ready = reference?.drainage?.status === 'ready';
  const needsFastUpdates = !authBlocked && !restoring && !restoreFailed && Boolean(unit) && (step === 'drain' || (step === 'connect' && Boolean(recordId)));
  useLiveMode(api, unit, needsFastUpdates, 'calibration');

  function fail(err: unknown, fallback: string) {
    if (err instanceof DrainApiError && err.status === 401) setError('Please sign in again to continue setup.');
    else if (err instanceof DrainApiError && err.status >= 500) setError(fallback);
    else setError(err instanceof Error ? err.message : fallback);
  }

  async function run(action: () => Promise<void>, fallback: string) {
    if (pendingAction.current) return;
    pendingAction.current = true;
    setBusy(true);
    setError('');
    try { await action(); }
    catch (err) { fail(err, fallback); }
    finally { pendingAction.current = false; setBusy(false); }
  }

  useEffect(() => {
    const fixture = new URLSearchParams(window.location.search).get('fixture');
    if (fixture && /^[a-zA-Z0-9_-]{1,64}$/.test(fixture)) {
      setUnit(fixture);
      setResumeFixture(fixture);
      setStep('connect');
      setRestoring(true);
    }
  }, []);

  useEffect(() => { document.getElementById('setup-title')?.focus(); }, [step, restoring]);

  useEffect(() => {
    if (!resumeFixture || authBlocked) return;
    const controller = new AbortController();
    setRestoring(true);
    setRestoreFailed(false);
    void (async () => {
      try {
        const [{ records }, { records: calibrations }, registry] = await Promise.all([
          api.records(resumeFixture, 'sensor', controller.signal),
          api.calibrationRecords(resumeFixture, 'sensor', controller.signal),
          api.devices(controller.signal),
        ]);
        if (controller.signal.aborted) return;
        const active = records.find(item => item.recording_status === 'recording');
        const saved = calibrations.find(item => item.schema_version !== 1 && item.calibration);
        setLocation(registry.devices.find(device => device.device_id === resumeFixture)?.name ?? '');
        setError('');
        if (active?.record_type === 'calibration') {
          setEmpty(true);
          setRecordId(active.record_id);
          setStep('connect');
        } else if (saved?.calibration) {
          setCalibrationId(saved.record_id);
          setReference(saved.calibration);
          setRecordId(null);
          setObservationId(saved.calibration.drainage?.active_capture?.recording_id ??
            (active?.record_type === 'monitoring' ? active.record_id : null));
          setStep(saved.calibration.drainage?.status === 'ready' ? 'done' : 'drain');
        } else {
          setRecordId(null);
          setReference(null);
          setStep('connect');
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setRestoreFailed(true);
          fail(err, 'Could not recover setup. Check your connection and retry.');
        }
      } finally {
        if (!controller.signal.aborted) setRestoring(false);
      }
    })();
    return () => controller.abort();
  }, [api, resumeFixture, revision, authBlocked]);

  useEffect(() => {
    if (authBlocked || restoring || restoreFailed || step !== 'connect' || !unit) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setProvisioned(null);
    async function checkKey() {
      try {
        const result = await api.setupStatus(unit, controller.signal);
        if (controller.signal.aborted) return;
        setProvisioned(result.provisioned);
        if (!result.provisioned) timer = setTimeout(checkKey, 8000);
      } catch {
        // A deployment without this status endpoint can still start recording.
      }
    }
    void checkKey();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, authBlocked, restoring, restoreFailed, step, unit]);

  useEffect(() => {
    setWaitingTooLong(false);
    if (!recordId) return;
    const timer = setTimeout(() => setWaitingTooLong(true), 20000);
    return () => clearTimeout(timer);
  }, [recordId]);

  useEffect(() => {
    const view = recording.view;
    if (view?.record.record_type !== 'calibration' || view.record.recording_status !== 'finished') return;
    setRecordId(null);
    if (!view.record.calibration) {
      setError('The empty-sink recording ended before it had enough steady readings. You can start it again.');
      return;
    }
    setReference(view.record.calibration);
    setCalibrationId(view.record.record_id);
    setObservationId(null);
    setError('');
    setStep('drain');
  }, [recording.view]);

  async function addUnit(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      try { await api.register(unit, location); }
      catch (err) {
        if (!(err instanceof DrainApiError && err.status === 409)) throw err;
        const owned = (await api.devices()).devices.some(device => device.device_id === unit);
        setExisting(owned);
        throw new Error(owned ? 'This unit is already registered. Resume its setup below.' :
          'This unit is registered to another account. Check the printed ID or ask your installer to link it to you.');
      }
      window.history.replaceState(null, '', `/add-unit?fixture=${encodeURIComponent(unit)}`);
      setStep('connect');
    }, 'Could not add the unit. Check your connection and try again.');
  }

  async function startBaseline() {
    const { records } = await api.records(unit, 'sensor');
    const active = records.find(item => item.recording_status === 'recording');
    if (active?.record_type === 'calibration') {
      setRecordId(active.record_id);
      return;
    }
    if (active?.record_type === 'drainage') throw new Error('Finish the active drainage recording before recording a new empty reference.');
    if (active) await api.finish(active.record_id);
    const next = await api.start(unit, 'sensor', 'calibration', true);
    setRecordId(next.record_id);
  }

  async function startMonitoring() {
    const { records } = await api.records(unit, 'sensor');
    let active = records.find(item => item.recording_status === 'recording');
    if (active && active.record_type !== 'monitoring') throw new Error('Finish the active recording before starting monitoring.');
    if (active && reference?.drainage?.runs.some(run => run.recording_id === active?.record_id)) {
      await api.finish(active.record_id);
      active = undefined;
    }
    const next = active ?? await api.start(unit, 'sensor', 'monitoring');
    window.location.assign(`/live-demo?fixture=${encodeURIComponent(unit)}&source=sensor&record=${next.record_id}`);
  }

  const status = baselineStatus(recording.view, recording.error, waitingTooLong);
  const progress = recording.error || recording.view?.computed.sensor_connection === 'stale' ? null : recording.view?.computed.calibration_progress;
  return <>
    <ProductHeader active="add"/>
    <main className={styles.layout}><OceanWaves setup/>
      <section className={styles.panel} aria-labelledby="setup-title">
        <Stepper step={step}/>
        {authBlocked ? <><h1 id="setup-title" tabIndex={-1}>Add a unit</h1><p className={styles.lead}>Sign in to set up a unit.</p><AccountPanel/></> : <>
          {(restoring || restoreFailed) && <h1 id="setup-title" tabIndex={-1}>Resume unit setup</h1>}
          {restoring && <p role="status">Recovering saved setup…</p>}
          {restoreFailed && <button className={shell.secondary} onClick={() => setRevision(value => value + 1)}>Retry saved setup</button>}
          {step === 'add' && <form className={styles.form} onSubmit={addUnit}>
            <div><h1 id="setup-title" tabIndex={-1}>Add a unit</h1><p className={styles.lead}>Register your unit, record the empty sink, then check how it drains.</p></div>
            <label className={styles.field}><span>Unit ID</span><div className={styles.inputWrap}><input aria-label="Unit ID" aria-describedby="unit-hint" required pattern={UNIT_PATTERN} maxLength={64} placeholder="DR-4851" value={unit} onChange={event => { setUnit(event.target.value.trim()); setExisting(false); setError(''); }}/><small id="unit-hint">Printed on the unit</small></div></label>
            <label className={styles.field}><span>Location</span><input required maxLength={100} placeholder="Floor 3, Room 304" value={location} onChange={event => setLocation(event.target.value)}/></label>
            <div className={styles.actions}>{existing ? <button type="button" className={shell.primary} disabled={busy} onClick={() => {
              window.history.replaceState(null, '', `/add-unit?fixture=${encodeURIComponent(unit)}`);
              setRestoring(true);
              setResumeFixture(unit);
              setStep('connect');
            }}>Continue setup</button> : <button className={shell.primary} disabled={busy}>{busy ? 'Adding…' : 'Add and continue'}</button>}<a href="/dashboard" className={styles.cancel}>Cancel</a></div>
          </form>}
          {step === 'connect' && !restoring && !restoreFailed && <div className={styles.form}>
            <div><h1 id="setup-title" tabIndex={-1}>Connect and calibrate {unit}</h1>
              <p className={styles.lead}>Power on the unit and aim the mounted sensor straight down at the basin. One check confirms the connection and saves the empty-sink distance.</p></div>
            {provisioned === false ? <div className={styles.live} role="status">
              <strong>Installer setup needed</strong>
              <span>The unit is registered. Ask your installer to link the hardware to this registration. This page will check again automatically.</span>
            </div> : <>
              <label className={styles.check}><input type="checkbox" checked={empty} disabled={Boolean(recordId) || busy} onChange={event => setEmpty(event.target.checked)}/>The sink is empty, the tap is off and the sensor is fixed in place.</label>
              {recordId ? <>
                <div className={styles.live} role="status"><strong>{status.title}</strong><span>{status.hint}</span></div>
                {progress != null && <progress max={1} value={progress} aria-label="Empty-sink calibration progress"/>}
                <button className={shell.secondary} disabled={busy} onClick={() => void run(async () => {
                  await api.finish(recordId);
                  setRecordId(null);
                  setEmpty(false);
                }, 'Could not stop the empty-sink check.')}>Stop check</button>
              </> : <button className={shell.primary} disabled={!empty || busy} onClick={() => void run(startBaseline, 'Could not start the empty-sink check. Check your connection and retry.')}>{busy ? 'Starting…' : 'Connect and record empty sink'}</button>}
            </>}
            <a href="/dashboard" className={styles.cancel}>Finish later</a>
          </div>}
          {step === 'drain' && !restoring && !restoreFailed && reference && calibrationId && <DrainageSetup
            api={api} fixture={unit} calibrationId={calibrationId} calibration={reference} initialObservationId={observationId}
            onRedoBaseline={() => { setRecordId(null); setEmpty(false); setStep('connect'); }}
            onSaved={value => { setReference(value); if (value.drainage?.status === 'ready') setStep('done'); }}
          />}
          {step === 'done' && !restoring && !restoreFailed && <div className={styles.form}>
            <div><h1 id="setup-title" tabIndex={-1}>{unit} is ready</h1><p className={styles.lead}>The empty-sink reference and both drainage checks are saved.</p></div>
            <dl className={styles.summary}><div><dt>Location</dt><dd>{location}</dd></div><div><dt>Empty distance</dt><dd>{reference?.empty_distance_mm} mm</dd></div>
              <div><dt>Normal drainage</dt><dd>{reference?.drainage?.profile?.resolution === 'instant' ? 'Nearly instant' : `${reference?.drainage?.baseline_duration_seconds?.toFixed(2)} seconds`}</dd></div></dl>
            <div className={styles.actions}>{ready && <button className={shell.primary} disabled={busy} onClick={() => void run(startMonitoring, 'Could not start monitoring. Check your connection and retry.')}>{busy ? 'Starting…' : 'Start monitoring'}</button>}<a className={shell.secondary} href="/add-unit">Add another unit</a></div>
          </div>}
          {error && <p className={styles.error} role="alert">{error}</p>}
          {step === 'drain' && <a href="/dashboard" className={styles.cancel}>Finish later</a>}
        </>}
      </section>
      <aside className={styles.art} aria-hidden="true"><div className={styles.artCanvas}><picture><source media="(prefers-reduced-motion: reduce)" srcSet="/images/design/71e2d.svg"/><DesignAsset file="71e2d-animated.svg" className={styles.sinkScene}/></picture><div className={styles.phoneArt}><DesignAsset file="26625.svg"/></div></div></aside>
    </main>
  </>;
}
