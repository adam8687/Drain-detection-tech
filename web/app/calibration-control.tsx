'use client';

import { useEffect, useRef, useState } from 'react';
import type { Calibration, DrainApi, Frame, Source } from '../lib/api';
import { learnEmptyFixture } from '../lib/calibration';
import styles from './insights/insights.module.css';

export default function CalibrationControl({ api, deviceId, source, readings, onSaved }: { api: DrainApi; deviceId: string; source: Source; readings: Frame[]; onSaved: (calibration: Calibration) => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const [state, setState] = useState('idle');
  const [startedAt, setStartedAt] = useState(0);
  const [message, setMessage] = useState('');
  const [collected, setCollected] = useState<Frame[]>([]);
  const saving = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (state !== 'collecting') return;
    setCollected(previous => {
      const events = new Map(previous.map(frame => [frame.event_id, frame]));
      for (const frame of readings) if (Date.parse(frame.received_at) >= startedAt) events.set(frame.event_id, frame);
      return [...events.values()].slice(-3000);
    });
  }, [readings, state, startedAt]);
  const result = learnEmptyFixture(collected, startedAt, source);
  useEffect(() => {
    if (state !== 'collecting') return;
    const timeout = setTimeout(() => { setState('failed'); setMessage('Calibration timed out. Check the sensor stream, empty the fixture and try again.'); }, Math.max(0, 30000 - (Date.now() - startedAt)));
    return () => clearTimeout(timeout);
  }, [state, startedAt]);
  useEffect(() => {
    if (state !== 'collecting' || !result.calibration || saving.current) return;
    saving.current = true; setState('saving');
    void api.calibrate(deviceId, result.calibration).then(calibration => {
      if (!mounted.current) return;
      setState('saved'); setMessage(`Saved empty references A ${result.calibration!.empty_distance_mm.a} mm / B ${result.calibration!.empty_distance_mm.b} mm. Observed sample noise A ${result.noise.a.toFixed(2)} / B ${result.noise.b.toFixed(2)} mm (standard deviation).`);
      onSaved(calibration);
    }).catch(error => { if (mounted.current) { setState('failed'); setMessage(error instanceof Error ? error.message : 'Calibration could not be saved.'); } }).finally(() => { saving.current = false; });
  }, [readings, state, api, deviceId, result, onSaved]);
  return <section className={styles.chart} aria-label="Empty fixture calibration">
    <h3>Learn this fixture’s empty reference</h3>
    <p>No basin dimensions required. Collect 20 stable paired samples over at least eight seconds, then save per-sensor reference distances. Keep the tap off and mounts fixed.</p>
    <div className={styles.controls}>
      <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} disabled={state === 'collecting' || state === 'saving'} />I confirm the fixture is empty and clear of objects.</label>
      <button type="button" disabled={!confirmed || state === 'collecting' || state === 'saving'} onClick={() => { setCollected([]); setStartedAt(Date.now()); setState('collecting'); setMessage(''); }}>Calibrate empty fixture</button>
      {state === 'collecting' && <button type="button" onClick={() => { setState('idle'); setMessage('Calibration canceled.'); }}>Cancel</button>}
    </div>
    {state === 'collecting' && <><progress max="1" value={result.progress} aria-label="Calibration progress" /><p role="status">{result.reason}</p></>}
    {state === 'saving' && <p role="status">Saving the baseline…</p>}
    {message && <p role={state === 'failed' ? 'alert' : 'status'}>{message}</p>}
  </section>;
}
