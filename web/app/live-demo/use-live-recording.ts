'use client';

import { useEffect, useMemo, useState } from 'react';
import { DrainApi, DrainApiError } from '../../lib/api';
import type { DataSource, RecordSummary, RecordView } from '../../lib/api';
import { useSession } from '../../lib/supabase';

export function useLiveRecording(initialFixture = '', initialRecord = '', initialSource: DataSource = 'sensor') {
  const session = useSession();
  const [token, setToken] = useState('');
  const api = useMemo(() => new DrainApi('/api/backend', session?.access_token || token), [session?.access_token, token]);
  const [source, setSource] = useState<DataSource>(initialSource);
  const [devices, setDevices] = useState<{ device_id: string; name: string }[]>([]);
  const [records, setRecords] = useState<RecordSummary[]>([]);
  const [fixtureChoice, setFixtureChoice] = useState(initialFixture);
  const [recordChoice, setRecordChoice] = useState(initialRecord);
  const [view, setView] = useState<RecordView | null>(null);
  const [error, setError] = useState('');
  const [needsAuth, setNeedsAuth] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingRecord, setLoadingRecord] = useState(false);
  const [refresh, setRefresh] = useState(0);

  function reportError(err: unknown) {
    setNeedsAuth(err instanceof DrainApiError && err.status === 401);
    setError(err instanceof Error ? err.message : 'Could not load recordings.');
  }

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setRecords([]); setDevices([]); setView(null); setError(''); setNeedsAuth(false);
    void Promise.allSettled([api.devices(controller.signal), api.recordSummaries(source, controller.signal)]).then(([registry, summaries]) => {
      if (controller.signal.aborted) return;
      if (summaries.status === 'rejected') throw summaries.reason;
      // Names are optional metadata; a registry outage must not hide accessible recordings.
      setDevices(registry.status === 'fulfilled' ? registry.value.devices : []);
      setRecords(summaries.value.records);
    }).catch(err => { if (!controller.signal.aborted) reportError(err); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, source, refresh]);

  const fixtures = useMemo(() => {
    const names = new Map(devices.map(d => [d.device_id, d.name]));
    for (const record of records) if (!names.has(record.fixture_id)) names.set(record.fixture_id, record.fixture_id);
    return [...names].map(([id, name]) => ({ id, name }));
  }, [devices, records]);
  const fixture = fixtures.some(f => f.id === fixtureChoice) ? fixtureChoice : records[0]?.fixture_id || fixtures[0]?.id || '';
  const fixtureRecords = useMemo(() => records.filter(r => r.fixture_id === fixture), [records, fixture]);
  const recordId = fixtureRecords.some(r => r.record_id === recordChoice) ? recordChoice
    : fixtureRecords.find(r => r.record_type === 'drainage' && r.recording_status === 'recording')?.record_id
      || fixtureRecords.find(r => r.record_type === 'drainage' && r.result?.outcome === 'completed')?.record_id
      || fixtureRecords.find(r => r.record_type === 'drainage')?.record_id || fixtureRecords[0]?.record_id || '';

  useEffect(() => {
    if (!recordId) { setView(null); setLoadingRecord(false); return; }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setView(null); setLoadingRecord(true);
    async function load() {
      try {
        const next = await api.record(recordId, null, controller.signal);
        if (controller.signal.aborted) return;
        setView(next); setError(''); setNeedsAuth(false); setLoadingRecord(false);
        setRecords(previous => previous.map(record => record.record_id === recordId
          ? { ...record, recording_status: next.record.recording_status, result: next.record.result, measurement_count: next.record.measurements.length, calibration: next.record.calibration, drain_status: next.computed.drain_status }
          : record));
        if (next.record.recording_status === 'recording') timer = setTimeout(() => void load(), 1500);
      } catch (err) {
        if (!controller.signal.aborted) {
          setView(null); setLoadingRecord(false); reportError(err);
          timer = setTimeout(() => void load(), 5000);
        }
      }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, recordId, refresh]);

  return { source, setSource, fixtures, fixture, setFixture: (id: string) => { setFixtureChoice(id); setRecordChoice(''); },
    records: fixtureRecords, recordId, setRecordId: setRecordChoice, view, error, needsAuth,
    loading: loading || loadingRecord, setToken, refresh: () => setRefresh(n => n + 1) };
}
