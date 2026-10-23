const $ = id => document.getElementById(id);
let base = location.origin, token = '', streamAbort, selectedSession, sequence = 0;
// crypto.randomUUID needs HTTPS or localhost; this fallback supports an HTTP LAN demo.
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const h = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
const boot = uuid();
const notice = value => { $('notice').textContent = value; };
function device() { const id = $('devices').value; if (!id) throw Error('Select or register a device first'); return encodeURIComponent(id); }
function headers() { return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }; }
async function api(path, method = 'GET', data) {
  const response = await fetch(base + '/api/v1' + path, { method, headers: headers(), ...(data ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(10000) });
  const value = await response.json();
  if (!response.ok) throw Error(`${response.status}: ${value.error?.message || 'Request failed'}`);
  return value;
}
const action = fn => async event => { event?.preventDefault(); try { await fn(event); } catch (error) { notice(error.message); } };
function stopStream() { streamAbort?.abort(); streamAbort = null; $('stream').textContent = 'Start live stream'; }
async function listDevices(selected) {
  const data = await api('/devices');
  $('devices').replaceChildren(new Option('Select a device', ''), ...data.devices.map(d => new Option(d.name, d.device_id)));
  if (selected) $('devices').value = selected;
  notice(`Connected. ${data.devices.length} device(s).`);
}
function showFrame(frame) {
  $('levels').replaceChildren(...frame.levels.map(r => {
    const row = document.createElement('tr');
    for (const value of [r.sensor_id.toUpperCase(), r.distance_mm?.toFixed(1) ?? '—', r.depth_mm ?? '—', r.quality]) {
      const cell = document.createElement('td'); cell.textContent = String(value); row.append(cell);
    }
    return row;
  }));
  $('state').textContent = `${frame.source.toUpperCase()} · ${frame.measured_at} · ${frame.time_basis}`;
}
async function refresh() {
  const data = await api(`/devices/${device()}?source=${$('source').value}`);
  if (data.latest) showFrame(data.latest); else { $('levels').replaceChildren(); $('state').textContent = 'No readings for this source.'; }
  if (data.stale) $('state').textContent += ' · STALE / no recent data';
  const frames = await api(`/devices/${device()}/readings?source=${$('source').value}&limit=10`);
  $('history').textContent = JSON.stringify(frames.readings, null, 2);
}
$('connection').addEventListener('submit', action(async () => { stopStream(); base = ($('base').value || location.origin).replace(/\/$/, ''); token = $('token').value; await listDevices(); }));
$('register').addEventListener('submit', action(async event => {
  const data = Object.fromEntries(new FormData(event.target));
  await api('/devices', 'POST', data); await listDevices(data.device_id); notice('Device registered. Keep the fixture empty for automatic calibration, or save a manual baseline.');
}));
$('calibrate').addEventListener('submit', action(async event => {
  const data = new FormData(event.target);
  await api(`/devices/${device()}/calibrations`, 'POST', { empty_distance_mm: { a: Number(data.get('a')), b: Number(data.get('b')) } }); notice('Calibration saved.'); await refresh();
}));
$('send').addEventListener('submit', action(async event => {
  const data = new FormData(event.target);
  await api('/readings', 'POST', { event_id: uuid(), device_id: decodeURIComponent(device()), boot_id: boot, sequence: sequence++, captured_at: new Date().toISOString(), source: 'mock', readings: [{ sensor_id: 'a', status: 'ok', distance_mm: Number(data.get('a')) }, data.has('timeout') ? { sensor_id: 'b', status: 'timeout' } : { sensor_id: 'b', status: 'ok', distance_mm: Number(data.get('b')) }] });
  $('source').value = 'mock'; await refresh(); notice('Mock frame accepted.');
}));
$('refresh').onclick = action(refresh);
$('devices').onchange = action(async () => { stopStream(); selectedSession = null; await refresh(); });
$('source').onchange = action(async () => { stopStream(); selectedSession = null; await refresh(); });
$('start').onclick = action(async () => {
  selectedSession = await api(`/devices/${device()}/sessions`, 'POST', { source: $('source').value });
  $('session').textContent = JSON.stringify(selectedSession, null, 2); notice('Drainage test started.');
});
$('sessions').onclick = action(async () => {
  const list = await api(`/devices/${device()}/sessions`);
  selectedSession = list.sessions.find(s => s.source === $('source').value && s.status === 'active') || list.sessions.find(s => s.source === $('source').value);
  $('session').textContent = JSON.stringify(selectedSession ? await api(`/sessions/${selectedSession.id}`) : list, null, 2);
});
$('finish').onclick = action(async () => {
  if (!selectedSession) throw Error('Start a test or refresh tests to select the latest test');
  selectedSession = await api(`/sessions/${selectedSession.id}/finish`, 'POST');
  $('session').textContent = JSON.stringify(selectedSession, null, 2); notice(`Test ${selectedSession.analysis.outcome}.`);
});
$('stream').onclick = action(async () => {
  if (streamAbort) { stopStream(); notice('Live stream stopped.'); return; }
  const controller = new AbortController(); streamAbort = controller;
  try {
    const response = await fetch(`${base}/api/v1/devices/${device()}/stream?source=${$('source').value}`, { headers: headers(), signal: controller.signal });
    if (!response.ok) throw Error(`Stream failed: HTTP ${response.status}`);
    $('stream').textContent = 'Stop live stream'; notice('Live stream connected. History is available through Refresh readings.');
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader(); let buffer = '';
    while (true) {
      const { value, done } = await reader.read(); if (done) break; buffer += value;
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const entry = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const line = entry.split('\n').find(s => s.startsWith('data: '));
        if (entry.startsWith('event: snapshot') && line) { const snapshot = JSON.parse(line.slice(6)); if (snapshot.device.latest) showFrame(snapshot.device.latest); $('history').textContent = JSON.stringify(snapshot.readings, null, 2); }
        if (entry.startsWith('event: reading') && line) { const frame = JSON.parse(line.slice(6)); if (frame.source === $('source').value) showFrame(frame); }
      }
    }
    notice('Stream disconnected. Refresh to recover stored readings, then reconnect.');
  } catch (error) { if (error.name !== 'AbortError') notice(error.message); }
  finally { if (streamAbort === controller) stopStream(); }
});
listDevices().catch(error => notice(error.message));
