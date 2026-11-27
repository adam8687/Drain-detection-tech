'use client';

import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { DrainApi, DrainApiError } from '../../lib/api';
import type { Calibration } from '../../lib/api';
import { useRecording } from './use-recording';
import styles from './page.module.css';
import shell from '../live-demo/page.module.css';

type Props = {
  api: DrainApi;
  fixture: string;
  calibrationId: string;
  calibration: Calibration;
  initialObservationId: string | null;
  onSaved: (value: Calibration) => void;
  onRedoBaseline: () => void;
};

export default function DrainageSetup({ api, fixture, calibrationId, calibration, initialObservationId, onSaved, onRedoBaseline }: Props) {
  const [recordId, setRecordId] = useState(calibration.drainage?.active_capture?.recording_id ?? initialObservationId);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saveFailed, setSaveFailed] = useState(false);
  const pending = useRef(false);
  const capture = calibration.drainage?.active_capture;
  const recording = useRecording(api, recordId);
  const guidance = recording.error ? undefined : recording.view?.computed.setup_guidance;
  const count = calibration.drainage?.runs.length ?? 0;
  const needsBaseline = guidance?.phase === 'needs_calibration';
  const ended = recording.view?.record.recording_status === 'finished';
  const waterReady = !ended && guidance?.phase === 'water_ready';
  const level = guidance?.water_depth_mm;
  const connection = recording.view?.computed.sensor_connection;
  const lastChecked = useRef({ captureId: '', readingId: '' });

  useEffect(() => { document.getElementById('setup-title')?.focus(); }, [capture?.capture_id]);

  function report(err: unknown, fallback: string) {
    setError(err instanceof DrainApiError && err.status < 500 ? err.message : fallback);
  }

  async function run(action: () => Promise<void>, fallback: string) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try { await action(); }
    catch (err) { report(err, fallback); }
    finally { pending.current = false; setBusy(false); }
  }

  async function observe() {
    const { records } = await api.records(fixture, 'sensor');
    const active = records.find(record => record.recording_status === 'recording');
    if (active && (active.record_type !== 'monitoring' || active.calibration?.empty_distance_mm !== calibration.empty_distance_mm)) {
      throw new DrainApiError(409, 'observation_conflict', 'Another recording is active for this unit. Finish it before starting a water check.');
    }
    setRecordId((active ?? await api.start(fixture, 'sensor', 'monitoring')).record_id);
  }

  async function redoBaseline() {
    if (recordId) await api.finish(recordId);
    onRedoBaseline();
  }

  async function complete(captureId: string) {
    if (pending.current) return;
    pending.current = true;
    setSaveFailed(false);
    setError('');
    try {
      const result = await api.calibrateDrainage(calibrationId, { action: 'complete', capture_id: captureId });
      setConfirmed(false);
      onSaved(result.calibration);
    } catch (err) {
      if (err instanceof DrainApiError && err.code === 'drainage_pending') return;
      report(err, 'Could not save the drainage check. You can retry saving without starting over.');
      setSaveFailed(true);
    } finally { pending.current = false; }
  }

  const checkCompletion = useEffectEvent((captureId: string, confirmedAt: string) => {
    if (document.hidden || saveFailed || pending.current) return;
    const latest = recording.view?.record.measurements.at(-1);
    const newSample = latest && (lastChecked.current.captureId !== captureId || lastChecked.current.readingId !== latest.reading_id);
    if (newSample || Date.now() - Date.parse(confirmedAt) >= 600000) {
      if (latest) lastChecked.current = { captureId, readingId: latest.reading_id };
      void complete(captureId);
    }
  });

  useEffect(() => {
    if (!capture) return;
    const { capture_id, confirmed_at } = capture;
    const timer = setInterval(() => checkCompletion(capture_id, confirmed_at), 3000);
    return () => clearInterval(timer);
  }, [capture]);

  const fillMessage = ended ? 'The water-check recording ended. Keep the tap off and reconnect the check.'
    : guidance?.message ?? 'Keep the tap off while the app waits for sensor readings.';
  const captureMessage = needsBaseline ? guidance?.message
    : connection === 'problem' ? 'The unit is online, but the sensor has no distance. Keep the tap off and check the sensor wiring and aim.'
    : connection === 'stale' || recording.error ? 'Waiting for uploads to resume. Keep the tap off.'
    : level == null ? 'Waiting for a clear view of the water. Keep your hands away from the sensor.'
    : level <= 8 ? 'Confirming the sink is empty…' : 'Measuring the water level…';

  return <div className={styles.form}>
    <div><h1 id="setup-title" tabIndex={-1}>{capture ? 'Release the plug' : 'Measure normal drainage'}</h1>
      <p className={styles.lead}>{capture ? 'Keep the tap off. The app checks the result as the sink empties.' : 'Run two checks so the app can learn this sink’s normal drainage speed.'}</p></div>
    <p className={styles.note}>{count} of 2 drainage checks saved · Empty reference saved</p>
    {calibration.drainage?.last_issue && <p className={styles.error} role="alert">{calibration.drainage.last_issue}</p>}
    {capture ? <>
      <div className={styles.live} role="status"><strong>{captureMessage}</strong>{level != null && <span>Water depth: {level.toFixed(0)} mm</span>}</div>
      {saveFailed && <button className={shell.primary} disabled={busy} onClick={() => void complete(capture.capture_id)}>Retry saving check</button>}
      <button className={shell.secondary} disabled={busy} onClick={() => void run(async () => {
        const result = await api.calibrateDrainage(calibrationId, { action: 'cancel', capture_id: capture.capture_id });
        setConfirmed(false);
        setSaveFailed(false);
        onSaved(result.calibration);
      }, 'Could not stop the drainage check. Try again when the app reconnects.')}>Stop and try again</button>
    </> : !recordId ? <>
      <p>Keep the tap off until the app shows a water-level reading.</p>
      <button className={shell.primary} disabled={busy} onClick={() => void run(observe, 'Could not start the water check. Check your connection and retry.')}>Start water check</button>
    </> : <>
      <div className={`${styles.live} ${waterReady ? styles.ok : ''}`} role="status">
        <strong>{fillMessage}</strong>
        {level != null && !ended && <span>{level.toFixed(0)} mm of water · Fill target {guidance.target_depth_mm} mm</span>}
        {!needsBaseline && !ended && <p>Keep the plug in and stop filling before the water approaches the rim.</p>}
      </div>
      {waterReady && <label className={styles.check}><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/>The drain is clear, the tap is off, and the plug is still in.</label>}
      {waterReady && <button className={shell.primary} disabled={!confirmed || busy} onClick={() => void run(async () => {
        const result = await api.calibrateDrainage(calibrationId, { action: 'start', recording_id: recordId, confirm_tap_off: true, confirm_clear: true });
        onSaved(result.calibration);
      }, 'Could not start the drainage check. Keep the plug in and try again.')}>Start drainage check {count + 1} of 2</button>}
      {ended && <button className={shell.secondary} disabled={busy} onClick={() => void run(observe, 'Could not reconnect the water check.')}>Reconnect water check</button>}
    </>}
    {!capture && <button className={shell.secondary} disabled={busy} onClick={() => void run(redoBaseline, 'Could not restart empty-sink calibration.')}>Redo empty-sink reference</button>}
    {(error || recording.error) && <p className={styles.error} role="alert">{error || recording.error}</p>}
  </div>;
}
