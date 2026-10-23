'use client';

import { useEffect, useState } from 'react';
import { DrainApi, DrainApiError } from '../lib/api';
import type { Device, Source } from '../lib/api';
import { loadReadings } from '../lib/readings';
import DrainageGraphs from './drainage-graphs';
import CalibrationControl from './calibration-control';
import DrainageTestControl from './drainage-test-control';

const baseUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000';
type Readings = Awaited<ReturnType<typeof loadReadings>>;

export default function BackendData() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [source, setSource] = useState<Source>('mock');
  const [data, setData] = useState<Readings | null>(null);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [draftToken, setDraftToken] = useState('');
  const [needsToken, setNeedsToken] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const api = new DrainApi(baseUrl, token);
    setLoaded(false); setData(null); setUpdatedAt(null); setError('');
    async function poll() {
      try {
        const list = await api.devices();
        if (stopped) return;
        setDevices(list.devices);
        const selected = list.devices.some(d => d.device_id === deviceId) ? deviceId
          : list.devices.find(d => d.device_id === 'demo-tub')?.device_id || list.devices[0]?.device_id || '';
        if (selected !== deviceId) { setDeviceId(selected); return; }
        const snapshot = selected ? await loadReadings(api, selected, source) : null;
        if (stopped) return;
        setData(snapshot); setUpdatedAt(new Date().toISOString()); setError(''); setNeedsToken(false); setLoaded(true);
      } catch (err) {
        if (stopped) return;
        setNeedsToken(err instanceof DrainApiError && err.status === 401);
        setError(err instanceof DrainApiError ? err.message : `Cannot reach the backend at ${baseUrl}. Check that it is running and permits this frontend origin.`);
        setLoaded(true);
      }
      if (!stopped) timer = setTimeout(poll, 15000);
    }
    void poll();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [deviceId, source, token, refresh]);

  useEffect(() => {
    if (!deviceId) return;
    const controller = new AbortController();
    const api = new DrainApi(baseUrl, token);
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function connect() {
      try {
        await api.stream(deviceId, source, controller.signal, snapshot => {
          if (controller.signal.aborted) return;
          setData(snapshot); setUpdatedAt(new Date().toISOString());
          setError(''); setNeedsToken(false); setLoaded(true);
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        setNeedsToken(err instanceof DrainApiError && err.status === 401);
        setError(err instanceof DrainApiError ? err.message : 'Live connection interrupted. Reconnecting automatically.');
      }
      if (!controller.signal.aborted) timer = setTimeout(connect, 2000);
    }
    void connect();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [deviceId, source, token, refresh]);

  return <section aria-label="Backend data">
    <h2>Backend data</h2>
    <p>Refreshes automatically while this page is open.</p>
    <p>
      <label>Device{' '}<select value={deviceId} onChange={event => setDeviceId(event.target.value)}>
        <option value="">Select a device</option>
        {devices.map(device => <option key={device.device_id} value={device.device_id}>{device.name}</option>)}
      </select></label>{' '}
      <label>Source{' '}<select value={source} onChange={event => setSource(event.target.value as Source)}>
        <option value="mock">Mock</option><option value="hardware">Hardware</option>
      </select></label>{' '}
      <button type="button" onClick={() => setRefresh(value => value + 1)}>Refresh now</button>
    </p>
    {needsToken && <form onSubmit={event => { event.preventDefault(); setToken(draftToken); setRefresh(value => value + 1); }}>
      <label>Backend API token <input type="password" autoComplete="off" value={draftToken} onChange={event => setDraftToken(event.target.value)} /></label>
      <button type="submit">Connect</button>
    </form>}
    {!loaded && <p role="status">Loading backend data…</p>}
    {error && <p role="alert">{error}</p>}
    {loaded && !error && !devices.length && <p>No devices yet. Run <code>npm run simulate -- normal</code> from the project root to create mock data.</p>}
    {loaded && !error && data && <>
      <p>{updatedAt && <>Last fetched: <time dateTime={updatedAt}>{new Date(updatedAt).toLocaleTimeString()}</time>. </>}
        {data.device.stale ? 'No recent sensor frames; showing stored readings.' : 'Recent sensor frames received.'}</p>
      <p>{data.device.calibration
        ? data.device.calibration.method === 'automatic_empty_fixture' ? 'Empty-fixture baseline calibrated automatically.' : 'Manual empty-fixture baseline active.'
        : 'Waiting for stable empty-fixture readings. Keep the fixture empty during startup calibration.'}</p>
      <CalibrationControl key={`${deviceId}:${source}:${token}`} api={new DrainApi(baseUrl, token)} deviceId={deviceId} source={source} readings={data.readings} onSaved={calibration => setData(current => current ? { ...current, device: { ...current.device, calibration } } : current)} />
      <DrainageGraphs frames={data.readings} calibration={data.device.calibration} tests={data.tests} stale={data.device.stale} />
      <h3>Latest sensor readings</h3>
      {data.device.latest ? <>
        <p>Source: {data.device.latest.source}. Measured: <time dateTime={data.device.latest.measured_at}>{data.device.latest.measured_at}</time>.</p>
        <table>
          <thead><tr><th scope="col">Sensor</th><th scope="col">Distance (mm)</th><th scope="col">Local depth (mm)</th><th scope="col">Quality</th></tr></thead>
          <tbody>{data.device.latest.levels.map(level => <tr key={level.sensor_id}>
            <th scope="row">{level.sensor_id.toUpperCase()}</th>
            <td>{level.distance_mm == null ? 'Unknown' : level.distance_mm.toFixed(1)}</td>
            <td>{level.depth_mm == null ? 'Unknown' : level.depth_mm.toFixed(1)}</td>
            <td>{level.quality}</td>
          </tr>)}</tbody>
        </table>
      </> : <p>No {source} readings for this device.</p>}
      <DrainageTestControl key={`test:${deviceId}:${source}:${token}`} api={new DrainApi(baseUrl, token)} deviceId={deviceId} source={source} tests={data.tests} calibrated={Boolean(data.device.calibration)} />
      <h3>Drainage tests</h3>
      {data.tests.length ? <ul>{data.tests.slice(0, 5).map(test => <li key={test.id}>
        {test.name}: {test.analysis?.outcome || test.status}
        {test.analysis?.drain_duration_ms != null && <> — {(test.analysis.drain_duration_ms / 1000).toFixed(2)} seconds</>}
      </li>)}</ul> : <p>No tests for this source.</p>}
      <details><summary>Recent raw readings ({data.readings.length})</summary><pre>{JSON.stringify(data.readings, null, 2)}</pre></details>
    </>}
  </section>;
}
