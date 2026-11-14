import styles from './page.module.css';

// One status line per calibration step, in the app's existing status-box look (the same box the connection check uses).
export type Stage = 'waiting' | 'ready' | 'running' | 'done';
const LABEL: Record<Stage, string> = { waiting: 'Waiting', ready: 'Ready to calibrate', running: 'Calibrating…', done: 'Finished calibrating' };

export default function CalibrationStage({ title, stage, detail }: { title: string; stage: Stage; detail?: string }) {
  return <div className={`${styles.live} ${stage === 'done' ? styles.ok : ''}`} role="status" aria-live="polite">
    <strong>{title} · {LABEL[stage]}</strong>{detail && <span>{detail}</span>}
  </div>;
}

// The empty-sink reading is ruined by water, so say so before and during it.
export function WaterWarning() {
  return <p className={styles.error} role="alert"><strong>Don’t turn on the water.</strong> Keep the sink empty and still until this finishes.</p>;
}
