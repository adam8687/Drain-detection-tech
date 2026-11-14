import { readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

const args = process.argv.slice(2);
const fixture = args[0] || 'usb-bench';
const type = args[1] || 'monitoring';
const confirmEmpty = args.includes('--confirm-empty');
const base = (process.env.API_BASE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const adminToken = process.env.OWNER_TOKEN || process.env.API_KEY || '';
const configPath = new URL('./.env', import.meta.url);

async function api(path, value) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method: value === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}) },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!response.ok) throw Error(`${response.status}: ${result.error?.message || 'Setup request failed'}`);
  return result;
}

try {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(fixture)) throw Error('Use a fixture ID containing letters, digits, dashes or underscores.');
  if (!['monitoring', 'calibration', 'drainage'].includes(type)) throw Error('Choose monitoring, calibration or drainage.');
  if (type === 'calibration' && !confirmEmpty) throw Error('Confirm the fixture is empty using --confirm-empty; the sensor must work.');
  const devices = await api('/devices');
  if (!devices.devices.some(d => d.device_id === fixture)) await api('/devices', { device_id: fixture, name: fixture });
  const listed = await api(`/records?fixture_id=${fixture}&data_source=sensor&recording_status=recording`);
  let record = listed.records[0];
  if (record && record.record_type !== type) throw Error(`An active ${record.record_type} recording already exists. Finish it on the website before starting ${type}.`);
  let previous = {};
  try { previous = parseEnv(await readFile(configPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const reuse = previous.SENSOR_FIXTURE_ID === fixture && previous.API_BASE_URL === base && previous.SENSOR_KEY?.startsWith('dk_');
  const sensorKey = reuse ? previous.SENSOR_KEY : (await api(`/devices/${fixture}/keys`, {})).key;
  record ||= await api('/records', { fixture_id: fixture, record_type: type, data_source: 'sensor', ...(type === 'calibration' ? { confirm_empty: true } : {}) });
  // Only a scoped fixture key is saved here; the backend secret is never copied.
  const config = { API_BASE_URL: base, SENSOR_FIXTURE_ID: fixture, SENSOR_RECORD_ID: record.record_id, SENSOR_KEY: sensorKey,
    ...(previous.SENSOR_PORT ? { SENSOR_PORT: previous.SENSOR_PORT } : {}), ...(previous.SENSOR_OUTBOX ? { SENSOR_OUTBOX: previous.SENSOR_OUTBOX } : {}) };
  await writeFile(configPath, Object.entries(config).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('\n') + '\n', { mode: 0o600 });
  console.log(`Ready: fixture ${fixture}, ${type} record ${record.record_id}.`);
  console.log('Saved the fixture sensor key privately in device/usb-bridge/.env (not printed).');
  console.log('Upload us100_usb_upload.ino, close Serial Monitor, then run npm run device:upload (automatically selects a single USB board).');
} catch (error) {
  console.error(error.message);
  console.error('Start the backend first. For a signed-in owner, set OWNER_TOKEN locally; sensor keys cannot start recordings.');
  process.exitCode = 1;
}
