'use client';

import { useEffect, useState } from 'react';
import type { DrainApi } from '../lib/api';
import styles from '../app/dashboard/page.module.css';

type Unit = { device_id: string; name: string; can_delete?: boolean };

export default function DeleteUnit({ api, onDeleted }: { api: DrainApi; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [units, setUnits] = useState<Unit[]>([]);
  const [loading, setLoading] = useState(false);
  const [target, setTarget] = useState<Unit | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setUnits([]);
    setError('');
    setLoading(true);
    void api.devices(controller.signal).then(({ devices }) => {
      if (!controller.signal.aborted) setUnits(devices.filter(unit => unit.can_delete));
    }).catch(() => {
      if (!controller.signal.aborted) setError('Could not load your units. Close and reopen this section to retry.');
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [api, open]);

  async function remove() {
    if (!target || busy || confirmation !== target.device_id) return;
    setBusy(true);
    setError('');
    try {
      await api.deleteUnit(target.device_id);
      setUnits(current => current.filter(unit => unit.device_id !== target.device_id));
      setStatus(`Deleted ${target.name} (${target.device_id}).`);
      setTarget(null);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the unit. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return <section className={styles.recordingTools}>
    <button type="button" className={styles.secondary} aria-expanded={open} disabled={busy} onClick={() => {
      setOpen(!open);
      setTarget(null);
      setConfirmation('');
      setStatus('');
    }}>Delete a unit</button>
    {open && <>
      {status && <p role="status">{status}</p>}
      {loading && <p role="status">Loading your units…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && !units.length && <p>You have no units available to delete.</p>}
      {target ? <form onSubmit={event => { event.preventDefault(); void remove(); }}>
        <p>Deleting {target.name} permanently removes its readings, calibration, alerts and access keys.</p>
        <label>Type <strong>{target.device_id}</strong> to confirm{' '}
          <input autoComplete="off" disabled={busy} value={confirmation} onChange={event => setConfirmation(event.target.value)} />
        </label>{' '}
        <button type="submit" className={styles.secondary} disabled={busy || confirmation !== target.device_id}>{busy ? 'Deleting…' : 'Permanently delete unit'}</button>{' '}
        <button type="button" className={styles.secondary} disabled={busy} onClick={() => { setTarget(null); setError(''); }}>Cancel</button>
      </form> : units.length > 0 && <ul>{units.map(unit => <li key={unit.device_id}>
        {unit.name} ({unit.device_id}){' '}
        <button type="button" className={styles.secondary} aria-label={`Delete ${unit.device_id}`} onClick={() => {
          setConfirmation('');
          setStatus('');
          setTarget(unit);
        }}>Delete</button>
      </li>)}</ul>}
    </>}
  </section>;
}
