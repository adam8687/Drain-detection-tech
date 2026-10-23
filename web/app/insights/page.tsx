'use client';

import { useState } from 'react';
import DrainageGraphs from '../drainage-graphs';
import BackendData from '../backend-data';
import SupabasePractice from '../supabase-practice';
import { demoCalibration, demoFrames, demoTests } from '../../lib/demo';
import type { Scenario } from '../../lib/demo';
import styles from './insights.module.css';

export default function InsightsPage() {
  const [mode, setMode] = useState('practice');
  const [scenario, setScenario] = useState<Scenario>('normal');
  const [sample, setSample] = useState(40);
  const [stale, setStale] = useState(false);
  const frames = demoFrames(scenario).slice(0, sample + 1);
  return <main className={styles.shell}>
    <h1>Drainage insights</h1>
    <div className={styles.controls}>
      <label>Data <select value={mode} onChange={e => setMode(e.target.value)}><option value="practice">Supabase practice data</option><option value="preview">Local synthetic preview</option><option value="live">Live Supabase data</option></select></label>
      {mode === 'preview' && <>
        <label>Scenario <select value={scenario} onChange={e => { setScenario(e.target.value as Scenario); setSample(40); }}><option value="normal">Normal drainage</option><option value="slow">Slower drainage</option><option value="timeout">Missing echo at sensor B</option><option value="rising">Water rising / tap on</option></select></label>
        <label>Playback <input type="range" min="0" max="80" value={sample} onChange={e => setSample(Number(e.target.value))} /><output>{(sample / 2).toFixed(1)} s</output></label>
        <label><input type="checkbox" checked={stale} onChange={e => setStale(e.target.checked)} />Simulate stale data</label>
      </>}
    </div>
    {mode === 'practice' ? <SupabasePractice /> : mode === 'preview' ? <DrainageGraphs frames={frames} calibration={demoCalibration} tests={demoTests} stale={stale} preview /> : <BackendData />}
  </main>;
}
