import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const scenario = process.argv[2] || 'normal';
if (!['normal', 'slow', 'timeout', 'shallow'].includes(scenario)) throw Error('Choose normal, slow, timeout or shallow');
const base = (process.env.API_BASE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const device = process.env.MOCK_DEVICE_ID || 'demo-tub';
const headers = { 'Content-Type': 'application/json', ...(process.env.API_KEY ? { Authorization: `Bearer ${process.env.API_KEY}` } : {}) };
async function api(path, method = 'GET', value) {
  const res = await fetch(base + '/api/v1' + path, { method, headers, ...(value ? { body: JSON.stringify(value) } : {}), signal: AbortSignal.timeout(10000) });
  const data = await res.json();
  if (!res.ok) throw Error(`${res.status}: ${data.error?.message || 'Request failed'}`);
  return data;
}
try {
  const existing = await fetch(`${base}/api/v1/devices/${device}?source=mock`, { headers });
  if (existing.status === 404) await api('/devices', 'POST', { device_id: device, name: 'Mock bathtub — not hardware measurements' });
  else if (!existing.ok) throw Error(`Cannot access device: HTTP ${existing.status}`);
  await api(`/devices/${device}/calibrations`, 'POST', { empty_distance_mm: { a: 400, b: 420 }, wet_threshold_mm: 20, dry_threshold_mm: 8, stable_samples: 3, max_gap_ms: 5000 });
  const session = await api(`/devices/${device}/sessions`, 'POST', { source: 'mock', name: `Simulated ${scenario} drainage` });
  console.log(`Session ${session.id}: ${scenario}. Open ${base}/ and select ${device} / mock.`);
  const boot = randomUUID(), count = scenario === 'slow' ? 50 : 18;
  for (let i = 0; i < count; i++) {
    const depth = scenario === 'shallow' ? Math.max(0, 5 - i) : Math.max(0, 100 * (1 - i / (count - 5)));
    const missing = scenario === 'timeout' && i >= count - 5;
    const frame = {
      event_id: randomUUID(), device_id: device, boot_id: boot, sequence: i,
      captured_at: new Date().toISOString(), source: 'mock', temperature_c: 20,
      readings: ['a','b'].map((sensor_id, index) => missing && index === 1
        ? { sensor_id, status: 'timeout' }
        : { sensor_id, status: 'ok', distance_mm: Math.round((index ? 420 : 400) - depth + Math.sin(i * 2 + index) * 1.5) }),
    };
    // Retry exactly the same event ID/body, so a lost HTTP response cannot double count.
    let sent = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await api('/readings', 'POST', frame); sent = true; break; }
      catch (error) { if (attempt === 2) throw error; await delay(250 * (attempt + 1)); }
    }
    if (sent) console.log(`Frame ${i}: ${depth.toFixed(0)}mm${missing ? ' (B timeout)' : ''}`);
    await delay(500);
  }
  const result = await api(`/sessions/${session.id}/finish`, 'POST');
  console.log(JSON.stringify(result.analysis, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
