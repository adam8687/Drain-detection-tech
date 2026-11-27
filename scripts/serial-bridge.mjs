// Forward USB readings from device/us100_stream to the backend records API.
// Usage: node scripts/serial-bridge.mjs <port> <fixture> [monitor|calibrate|drain] [--mirror]
// One physical US-100 is reported as sensor_a. By default sensor_b is honestly
// absent (status "timeout"), which limits recordings to monitoring. --mirror
// copies sensor_a into sensor_b for SINGLE-SENSOR BENCH TESTS ONLY, so the
// backend's calibration and drainage analysis can run; never use it with two
// real sensors or for data meant to establish real drain health.
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2).filter(a => a !== '--mirror');
const mirror = process.argv.includes('--mirror');
const port = args[0] || '/dev/cu.usbmodem48CA432DA7542';
const fixture = args[1] || 'bench-sink-1';
const mode = args[2] || 'monitor';
const recordType = { monitor: 'monitoring', calibrate: 'calibration', drain: 'drainage' }[mode];
if (!recordType) { console.error('Mode must be monitor, calibrate or drain'); process.exit(1); }
const base = process.env.API_BASE_URL || 'http://127.0.0.1:8000';

async function api(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw Error(`${path}: ${value.error?.code ?? response.status} ${value.error?.message ?? ''}`);
  return value;
}

async function startRecord() {
  const record = await api('/api/v1/records', {
    fixture_id: fixture, record_type: recordType, data_source: 'sensor',
    confirm_empty: recordType === 'calibration',
  });
  console.log(`${recordType} recording ${record.record_id} started for ${fixture}${mirror ? ' (BENCH MIRROR MODE: one sensor reported as both channels)' : ''}`);
  return record.record_id;
}

execFileSync('stty', ['-f', port, '115200', 'raw', '-echo']);
let recordId = await startRecord();
let sent = 0;
let done = false;
const finish = async (finished = false) => {
  if (done) return;
  done = true;
  if (!finished) {
    try { await api(`/api/v1/records/${recordId}/finish`, {}); } catch (error) { console.error(error.message); }
  }
  console.log(`\nRecord ${recordId}: ${sent} readings sent.`);
  process.exit(0);
};
process.on('SIGINT', () => finish());
process.on('SIGTERM', () => finish());

const lines = createInterface({ input: createReadStream(port) });
for await (const line of lines) {
  let reading;
  try { reading = JSON.parse(line); } catch { continue; }
  if (!('status' in reading)) continue;
  const point = {
    reading_id: randomUUID(),
    timestamp: new Date().toISOString(),
    sensor_a: reading,
    sensor_b: mirror ? { ...reading } : { distance_mm: null, status: 'timeout' },
  };
  try {
    const ack = await api(`/api/v1/records/${recordId}/measurements`, point);
    sent++;
    process.stdout.write(`\r${ack.measurement_count} readings | latest: ${reading.status === 'ok' ? `${reading.distance_mm} mm` : reading.status}   `);
    if (ack.recording_status === 'finished') {
      if (recordType === 'calibration') console.log(`\nCalibration saved: ${JSON.stringify(ack.calibration)}`);
      if (recordType === 'drainage') console.log(`\nDrainage result: ${JSON.stringify(ack.result)}`);
      await finish(true);
    }
  } catch (error) {
    if (recordType === 'monitoring' && String(error.message).includes('record_full')) {
      recordId = await startRecord();
    } else if (!done) {
      console.error(`\n${error.message}`);
    }
  }
}
await finish();
