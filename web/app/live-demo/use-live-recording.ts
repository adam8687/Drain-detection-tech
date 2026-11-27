'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { DrainApi, DrainApiError } from '../../lib/api';
import type { DataSource, RecordSummary, RecordView } from '../../lib/api';
import { selectDeviceRecord, mergeLiveView } from '../../lib/chart-data';
import { useSession } from '../../lib/supabase';
import { LIVE_DEMO_DURATION_MS, LIVE_RECORD_POLL_MS, useLiveMode } from '../../lib/use-live-mode';

export function useLiveRecording(initialFixture = '', initialRecord = '', initialSource: DataSource = 'sensor') {
  const session = useSession();
  const api = useMemo(() => new DrainApi('/api/backend', session?.access_token || ''), [session?.access_token]);
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
  const [startingMonitoring, setStartingMonitoring] = useState(false);
  const [startError, setStartError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [demoState, setDemoState] = useState<'auto' | 'off' | 'running' | 'expired'>('auto');
  const demo = demoState === 'running';
  const cachedView = useRef<{ api: DrainApi; view: RecordView } | null>(null);

  function reportError(err: unknown) {
    setNeedsAuth(err instanceof DrainApiError && err.status === 401);
    setError(err instanceof Error ? err.message : 'Could not load recordings.');
  }

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setRecords([]); setDevices([]); setView(null); setError(''); setNeedsAuth(false);
    let timer: ReturnType<typeof setTimeout>;
    async function loadSummaries() {
      if(document.hidden){timer=setTimeout(()=>void loadSummaries(),1000);return;}
      try {
        const [registry, summaries] = await Promise.allSettled([api.devices(controller.signal), fixtureChoice
          ? api.records(fixtureChoice,source,controller.signal) : api.recordSummaries(source,controller.signal)]);
        if (controller.signal.aborted) return;
        if (summaries.status === 'rejected') throw summaries.reason;
        // Names are optional metadata; a registry outage must not hide recordings.
        setDevices(registry.status === 'fulfilled' ? registry.value.devices : []);
        setRecords(summaries.value.records);
      } catch (err) { if (!controller.signal.aborted) reportError(err); }
      finally {
        if (!controller.signal.aborted) { setLoading(false); timer = setTimeout(() => void loadSummaries(), 60000); }
      }
    }
    void loadSummaries();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, source, refresh, fixtureChoice]);

  const fixtures = useMemo(() => {
    const names = new Map(devices.map(d => [d.device_id, d.name]));
    for (const record of records) if (!names.has(record.fixture_id)) names.set(record.fixture_id, record.fixture_id);
    return [...names].map(([id, name]) => ({ id, name }));
  }, [devices, records]);
  const fixture = fixtures.some(f => f.id === fixtureChoice) ? fixtureChoice : records[0]?.fixture_id || fixtures[0]?.id || '';
  const fixtureRecords = useMemo(() => records.filter(r => r.fixture_id === fixture), [records, fixture]);
  const recordId = fixture ? recordChoice || selectDeviceRecord(fixtureRecords) : '';
  const activeRecordId = fixtureRecords.find(record => record.recording_status === 'recording')?.record_id;
  const currentView = view?.record.record_id === recordId ? view : null;
  const isLiveSensorRecording = source === 'sensor' && currentView?.record.fixture_id === fixture
    && currentView.record.data_source === source && currentView.record.recording_status === 'recording';
  const live=useLiveMode(api,fixture,demo&&source==='sensor'&&Boolean(recordId),'demo');
  useEffect(() => setDemoState('auto'), [fixture, source]);
  useEffect(() => setStartError(''), [fixture, source]);
  useEffect(() => {
    if (isLiveSensorRecording) setDemoState(state => state === 'auto' ? 'running' : state);
  }, [isLiveSensorRecording, recordId]);
  useEffect(() => {
    if (!demo) return;
    const timer = setTimeout(() => setDemoState('expired'), LIVE_DEMO_DURATION_MS);
    return () => clearTimeout(timer);
  }, [demo]);

  useEffect(() => {
    if (!recordId) { setView(null); setLoadingRecord(false); return; }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const cached = cachedView.current;
    let previousView = cached?.api === api && cached.view.record.record_id === recordId ? cached.view : null;
    if (!previousView) { setView(null); setLoadingRecord(true); }
    async function load() {
      if(document.hidden){timer=setTimeout(()=>void load(),1000);return;}
      const requestStarted = performance.now();
      try {
        const next = await api.record(recordId, null, controller.signal, 120, previousView?.record.measurements.at(-1)?.reading_id);
        if (controller.signal.aborted) return;
        if (next.record.fixture_id !== fixture || next.record.data_source !== source) {
          throw new DrainApiError(404,'record_not_found','This recording belongs to a different unit or data source.');
        }
        const wasRecording = previousView?.record.recording_status === 'recording';
        previousView = mergeLiveView(previousView, next);
        cachedView.current = { api, view: previousView };
        setView(previousView); setError(''); setNeedsAuth(false); setLoadingRecord(false);
        setRecords(previous => previous.map(record => record.record_id === recordId
          ? { ...record, recording_status: next.record.recording_status, result: next.record.result, measurement_count: next.computed.sample_count, calibration: next.record.calibration, drain_status: next.computed.drain_status,drain_cycles:next.computed.drain_cycles }
          : record));
        if (next.record.recording_status === 'recording') {
          const depth=previousView.computed.water_levels?.at(-1)?.depth_mm;
          const idle=next.record.record_type==='monitoring'&&depth!=null&&depth<=8&&!next.computed.stale;
          // Count the request itself toward the live interval while keeping one fetch in flight.
          const liveDelay=Math.max(0,Math.ceil(LIVE_RECORD_POLL_MS-(performance.now()-requestStarted)));
          timer=setTimeout(() => void load(), demo?liveDelay:idle?15000:3000);
        } else {
          if(wasRecording&&next.record.continued_in){setRecordChoice(next.record.continued_in);}
          else setDemoState(state => state === 'running' ? 'off' : state);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          if (err instanceof DrainApiError && (err.status === 401 || err.status === 403 || err.status === 404)) {
            previousView = null;
            cachedView.current = null;
            setView(null);
          }
          setLoadingRecord(false); reportError(err);
          timer = setTimeout(() => void load(), 5000);
        }
      }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, recordId, fixture, source, refresh, demo]);

  function liveRecordingUrl(id: string) {
    return `/live-demo?fixture=${encodeURIComponent(fixture)}&source=sensor&record=${encodeURIComponent(id)}`;
  }

  async function startMonitoring() {
    if (!fixture || source !== 'sensor' || startingMonitoring) return;
    setStartingMonitoring(true);
    setStartError('');
    try {
      let id: string;
      try {
        id = (await api.start(fixture, 'sensor', 'monitoring')).record_id;
      } catch (err) {
        if (!(err instanceof DrainApiError) || err.code !== 'record_conflict') throw err;
        const { records: latest } = await api.records(fixture, 'sensor');
        const active = latest.find(record => record.recording_status === 'recording');
        if (!active) throw err;
        id = active.record_id;
      }
      window.location.assign(liveRecordingUrl(id));
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'Could not start monitoring. Try again.');
    } finally {
      setStartingMonitoring(false);
    }
  }

  return { source, setSource: (value: DataSource) => { setRecordChoice(''); setSource(value); }, fixtures, fixture, setFixture: (id: string) => { setFixtureChoice(id); setRecordChoice(''); },
    records: fixtureRecords, recordId, setRecordId: (id: string) => {
      if (id !== recordId) setDemoState('auto');
      setRecordChoice(id);
    },
    view: currentView, error, needsAuth, demo, demoExpired: demoState === 'expired', setDemo: (enabled: boolean) => setDemoState(enabled ? 'running' : 'off'), live,
    activeRecordingUrl: activeRecordId ? liveRecordingUrl(activeRecordId) : null, startMonitoring, startingMonitoring, startError,
    loading: loading || loadingRecord, refresh: () => setRefresh(n => n + 1) };
}
