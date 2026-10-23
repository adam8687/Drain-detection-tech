'use client';

import { useEffect, useState } from 'react';
import { DrainApi, DrainApiError } from '../lib/api';
import type { Calibration, DrainTest, Frame } from '../lib/api';
import DrainageGraphs from './drainage-graphs';
import styles from './insights/insights.module.css';

const deviceId = 'graph-practice-sink-v1';
// This view has no synthetic-data generator: every plotted frame is read via the API.
export default function SupabasePractice() {
  const [data, setData] = useState<{ calibration: Calibration | null; readings: Frame[]; tests: DrainTest[] } | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [sample, setSample] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [fetchedAt, setFetchedAt] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [token, setToken] = useState('');
  const [draftToken, setDraftToken] = useState('');
  const [needsToken, setNeedsToken] = useState(false);
  useEffect(() => {
    let stopped = false;
    const api = new DrainApi('/api/backend', token);
    void Promise.all([api.device(deviceId, 'mock'), api.history(deviceId, 'mock', 500), api.tests(deviceId)]).then(([device, history, reports]) => {
      if (stopped) return;
      const tests = reports.sessions.filter(t => t.source === 'mock' && t.status === 'finished').sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
      setData({ calibration: device.calibration, readings: history.readings, tests });
      setSelectedId(previous => tests.some(t => t.id === previous) ? previous : tests.at(-1)?.id || '');
      setFetchedAt(new Date().toISOString()); setError(''); setNeedsToken(false);
    }).catch(err => {
      if (stopped) return;
      setNeedsToken(err instanceof DrainApiError && err.status === 401);
      setError(err instanceof DrainApiError && err.status === 404 ? 'Practice data is not seeded yet. Run npm run seed:practice from the repository root.' : err instanceof Error ? err.message : 'Could not read Supabase practice data.');
    });
    return () => { stopped = true; };
  }, [token, refresh]);
  const selected = data?.tests.find(t => t.id === selectedId);
  const frames = data?.readings.filter(f => selected && Date.parse(f.measured_at) >= Date.parse(selected.started_at) && Date.parse(f.measured_at) <= Date.parse(selected.finished_at!)).sort((a, b) => Date.parse(a.measured_at) - Date.parse(b.measured_at)) ?? [];
  const position = Math.min(sample ?? Math.floor((frames.length - 1) / 2), Math.max(0, frames.length - 1));
  const seconds = frames.length ? (Date.parse(frames[position].measured_at) - Date.parse(frames[0].measured_at)) / 1000 : 0;
  return <section aria-label="Supabase practice data">
    <p className={styles.explanation}>Saved mock data from Supabase · historical replay.</p>
    <div className={styles.controls}>
      {data && <>
        <label>Saved test <select value={selectedId} onChange={e => { setSelectedId(e.target.value); setSample(null); }}>{data.tests.map((test, i) => <option key={test.id} value={test.id}>Test {i + 1} · {(test.analysis?.drain_duration_ms ?? 0) / 1000} seconds</option>)}</select></label>
        {frames.length > 0 && <label>Replay <input type="range" min="0" max={frames.length - 1} value={position} onChange={e => setSample(Number(e.target.value))} /><output>{seconds.toFixed(0)} seconds into the saved test</output></label>}
      </>}
      <button type="button" onClick={() => setRefresh(value => value + 1)}>Read Supabase again</button>
    </div>
    {needsToken && <form onSubmit={e => { e.preventDefault(); setToken(draftToken); }}><label>Backend API token <input type="password" autoComplete="off" value={draftToken} onChange={e => setDraftToken(e.target.value)} /></label><button type="submit">Connect</button></form>}
    {error && <p role="alert">{error}</p>}
    {!data && !error && <p role="status">Reading saved tests and sensor frames from Supabase…</p>}
    {data && !error && <>
      <p className={styles.note}>{data.readings.length} readings · {data.tests.length} tests · {fetchedAt && <>Updated: <time dateTime={fetchedAt}>{new Date(fetchedAt).toLocaleTimeString()}</time>.</>}</p>
      <DrainageGraphs frames={frames.slice(0, position + 1)} calibration={data.calibration} tests={data.tests} stale={false} historicalReplay />
    </>}
  </section>;
}
