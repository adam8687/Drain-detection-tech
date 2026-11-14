'use client';

import { useEffect, useMemo, useState } from 'react';
import AccountPanel from '../../components/account-panel';
import { useSession } from '../../lib/supabase';
import { DrainApi, DrainApiError } from '../../lib/api';
import type { AlertList, AlertSeverity, DataSource, DrainAlert } from '../../lib/api';
import styles from './page.module.css';

const ACK_KEY = 'drain-monitor:acknowledged-alerts';
const REFRESH_MS = 30000;
const SEVERITY_TEXT: Record<AlertSeverity, string> = { critical: 'Critical', warning: 'Warning', info: 'Info' };

function loadAcknowledged(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(ACK_KEY) || '[]')); } catch { return new Set(); }
}

function timeAgo(iso: string, now: number) {
  const minutes = Math.round((now - Date.parse(iso)) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}

function AlertCard({ alert, acknowledged, onToggle, now }: { alert: DrainAlert; acknowledged: boolean; onToggle: () => void; now: number }) {
  const viewHref = `/live-demo?fixture=${encodeURIComponent(alert.fixture_id)}&record=${encodeURIComponent(alert.record_id)}&source=${alert.data_source}`;
  return <li className={`${styles.card} ${styles[alert.severity]} ${acknowledged ? styles.acknowledged : ''}`}>
    <div className={styles.cardHead}>
      <span className={`${styles.severity} ${styles[`severity_${alert.severity}`]}`}>{SEVERITY_TEXT[alert.severity]}</span>
      <h2>{alert.title}</h2>
      <time dateTime={alert.occurred_at} title={new Date(alert.occurred_at).toLocaleString()}>{timeAgo(alert.occurred_at, now)}</time>
    </div>
    <p>{alert.message}</p>
    <div className={styles.cardFoot}>
      <span className={styles.fixture}>{alert.fixture_id}{alert.data_source === 'simulation' ? ' · simulated' : ''}</span>
      <a href={viewHref}>View recording →</a>
      <button type="button" onClick={onToggle}>{acknowledged ? 'Mark unread' : 'Acknowledge'}</button>
    </div>
  </li>;
}

export default function AlertsList() {
  const session = useSession();
  const [fixture, setFixture] = useState('');
  const [source, setSource] = useState<DataSource>('sensor');
  const [severity, setSeverity] = useState<AlertSeverity | ''>('');
  const [showAcknowledged, setShowAcknowledged] = useState(false);
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());
  const [needsToken, setNeedsToken] = useState(false);
  const [data, setData] = useState<AlertList | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const api = useMemo(() => new DrainApi('/api/backend', session?.access_token || ''), [session?.access_token]);

  useEffect(() => {
    setAcknowledged(loadAcknowledged());
    const params = new URLSearchParams(window.location.search);
    if (params.get('fixture')) setFixture(params.get('fixture')!);
    if (params.get('source') === 'sensor' || params.get('source') === 'simulation') setSource(params.get('source') as DataSource);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      setLoading(true);
      try {
        const value = await api.alerts({ fixture: fixture.trim() || undefined, source, limit: 200 }, controller.signal);
        if (controller.signal.aborted) return;
        setData(value); setError(''); setNeedsToken(false); setNow(Date.now());
      } catch (err) {
        if (controller.signal.aborted) return;
        setNeedsToken(err instanceof DrainApiError && err.status === 401);
        setError(err instanceof Error ? err.message : 'Backend unavailable');
      } finally { if (!controller.signal.aborted) setLoading(false); }
      timer = setTimeout(load, REFRESH_MS);
    };
    timer = setTimeout(() => void load(), 250);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, fixture, source, refresh]);

  function toggle(id: string) {
    setAcknowledged(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem(ACK_KEY, JSON.stringify([...next])); } catch { /* storage unavailable; keep in memory */ }
      return next;
    });
  }

  const all = data?.alerts ?? [];
  const unread = all.filter(a => !acknowledged.has(a.alert_id));
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const a of unread) counts[a.severity]++;
  const visible = all.filter(a => (!severity || a.severity === severity) && (showAcknowledged || !acknowledged.has(a.alert_id)));

  return <main className={styles.shell}>
    <a href="/dashboard">← Back to dashboard</a>
    <h1>Alerts</h1>
    <p className={styles.intro}>The empty-sink reference detects water. Time limits flag standing water while usual drain times are learned during normal use. Alerts refresh every 30 seconds.</p>
    <div id="account" tabIndex={-1}><AccountPanel /></div>

    <div className={styles.controls}>
      <label>Fixture <input placeholder="All fixtures" value={fixture} onChange={e => setFixture(e.target.value)} /></label>
      <label>Data <select aria-label="Data" value={source} onChange={e => setSource(e.target.value as DataSource)}><option value="simulation">Simulation</option><option value="sensor">Physical sensors</option></select></label>
      <label><input type="checkbox" checked={showAcknowledged} onChange={e => setShowAcknowledged(e.target.checked)} />Show acknowledged</label>
      <button type="button" onClick={() => setRefresh(n => n + 1)} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
    </div>

    {needsToken && <a href="/login">Sign in to view your alerts</a>}
    {error && <p role="alert" className={styles.error}>{error}</p>}

    {data && <div className={styles.summary} role="group" aria-label="Filter by severity">
      <button type="button" aria-pressed={severity === ''} onClick={() => setSeverity('')}><strong>{unread.length}</strong><span>Unread</span></button>
      {(['critical', 'warning', 'info'] as const).map(level => <button key={level} type="button" className={styles[`chip_${level}`]} aria-pressed={severity === level} onClick={() => setSeverity(severity === level ? '' : level)}>
        <strong>{counts[level]}</strong><span>{SEVERITY_TEXT[level]}</span>
      </button>)}
    </div>}

    {data && visible.length === 0 && <div className={styles.empty}>
      <h2>{all.length ? 'Nothing left to review' : 'No alerts to show'}</h2>
      <p>{all.length ? 'Every alert matching this filter has been acknowledged.' : 'No alerts were found for this selection. Save the empty-sink reference and keep the device connected to monitor for standing water.'}</p>
    </div>}

    {visible.length > 0 && <ul className={styles.list} aria-live="polite">
      {visible.map(alert => <AlertCard key={alert.alert_id} alert={alert} acknowledged={acknowledged.has(alert.alert_id)} onToggle={() => toggle(alert.alert_id)} now={now} />)}
    </ul>}
  </main>;
}
