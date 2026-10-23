'use client';

import { useState } from 'react';
import type { DrainApi, DrainTest, Source } from '../lib/api';
import styles from './insights/insights.module.css';

export default function DrainageTestControl({ api, deviceId, source, tests, calibrated }: { api: DrainApi; deviceId: string; source: Source; tests: DrainTest[]; calibrated: boolean }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [localActive, setLocalActive] = useState<DrainTest | null>(null);
  const [finished, setFinished] = useState<string | null>(null);
  const active = tests.find(test => test.source === source && test.status === 'active' && test.id !== finished) || (localActive?.id !== finished ? localActive : null);
  async function act() {
    setBusy(true); setMessage('');
    try {
      if (active) {
        const result = await api.finishTest(active.id);
        setFinished(result.id); setLocalActive(null);
        setMessage(`Test ${result.analysis?.outcome ?? 'finished'}. ${result.analysis?.reason ?? ''}`);
      } else {
        const result = await api.startTest(deviceId, source, 'Controlled drainage test');
        setLocalActive(result); setMessage('Test started. Release the drain with the tap off. Finish after both sensors show stable dry readings.');
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Test request failed.'); }
    finally { setBusy(false); }
  }
  return <section className={styles.chart} aria-label="Controlled drainage test">
    <h3>Capture a comparable drainage test</h3>
    <p>Use the same starting water mark, leave the tap off, and keep the sensor mounts fixed. Start before releasing the drain; finish after stable dry readings.</p>
    <div className={styles.controls}><button type="button" disabled={busy || !calibrated} onClick={() => void act()}>{busy ? 'Saving…' : active ? 'Finish drainage test' : 'Start drainage test'}</button>{!calibrated && <span>Calibrate first.</span>}</div>
    {message && <p role="status">{message}</p>}
  </section>;
}
