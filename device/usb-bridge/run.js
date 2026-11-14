import { open, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Outbox, measurementFromReply, uploadNext } from './bridge.js';
import { uuid } from '../../backend/src/validation.js';

const args = process.argv.slice(2);
const base = (process.env.API_BASE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const token = process.env.SENSOR_KEY || process.env.API_KEY || '';
const follow = args.includes('--follow');
let record = follow ? null : process.env.SENSOR_RECORD_ID;
let lastDiscovery = 0;
let running = true, fatal = false, pendingRequest = null, outbox, serial, worker, reader;
const stop = () => { running = false; };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
const usbPorts = async () => (await readdir('/dev')).filter(p => /^cu\.(usbmodem|usbserial)[\w.-]*$/.test(p)).map(p => `/dev/${p}`);

try {
  if (args.includes('--ports')) {
    console.log((await usbPorts()).join('\n') || 'No USB Arduino port found. Connect the board with a USB data cable.');
    process.exit(0);
  }
  if (process.platform !== 'darwin') throw Error('This USB launcher currently supports macOS.');
  if (follow && !token.startsWith('dk_')) throw Error('Automatic setup needs the fixture sensor key (dk_).');
  if (!follow) uuid(record, 'SENSOR_RECORD_ID');
  if (token.startsWith('sb_') || token.split('.').length === 3) throw Error('Use the fixture sensor key, not a Supabase key or browser sign-in token.');
  const available = await usbPorts();
  const port = args.find(arg => !arg.startsWith('--')) || process.env.SENSOR_PORT || (available.length === 1 ? available[0] : '');
  if (!port && !available.length) throw Error('No USB Arduino port found. Connect the board with a USB data cable.');
  // ttys devices also allow a local pseudo-terminal to exercise this exact loop.
  if (!port || !/^\/dev\/(cu\.(usbmodem|usbserial)[\w.-]*|ttys\d+)$/.test(port)) throw Error('Pass the USB port, e.g. npm run device:upload -- /dev/cu.usbmodemXXXX');
  // No serial dependency or driver is needed for the Nano's native USB CDC.
  // A short read timeout lets Ctrl+C stop even if the board never replies.
  execFileSync('/bin/stty', ['-f', port, '115200', 'raw', '-echo', '-ixon', '-ixoff', 'min', '0', 'time', '1']);
  serial = await open(port, 'r+');
  outbox = new Outbox(process.env.SENSOR_OUTBOX || fileURLToPath(new URL('./data/outbox.sqlite', import.meta.url)));
  const onLine = line => {
    if (!pendingRequest || !line.trim().startsWith('{')) return;
    let point;
    try {
      point = measurementFromReply(line, pendingRequest);
    } catch {
      console.error('Ignored malformed or stale serial reply; no measurement uploaded.');
      return;
    }
    try {
      outbox.enqueue(pendingRequest.record_id, point); // Persist before any HTTP attempt.
      pendingRequest = null;
    } catch {
      console.error('Could not save a reading to the local outbox. Stopping acquisition; check disk space and permissions.');
      fatal = true; stop();
    }
  };
  const readSerial = async () => {
    const buffer = Buffer.alloc(1024);
    let text = '';
    while (running) {
      try {
        const { bytesRead } = await serial.read(buffer, 0, buffer.length, null);
        if (!bytesRead) { await delay(10); continue; }
        text += buffer.toString('utf8', 0, bytesRead);
        let newline;
        while ((newline = text.indexOf('\n')) >= 0) {
          onLine(text.slice(0, newline).replace(/\r$/, ''));
          text = text.slice(newline + 1);
        }
        if (text.length > 4096) { text = ''; console.error('Discarded oversized USB output.'); }
      } catch {
        console.error('USB connection lost; queued readings remain saved. Reconnect and restart.');
        fatal = true; stop();
      }
    }
  };
  const uploadLoop = async () => {
    while (running) {
      try {
        const saved = await uploadNext(outbox, { base, token, follow });
        if (saved) {
          const p = saved.point;
          if (saved.rejected) console.log('The setup step ended before this reading arrived. Kept locally; following the next step.');
          else console.log(`Saved ${p.timestamp}: sensor=${p.sensor.distance_mm ?? p.sensor.status}${saved.duplicate ? ' (retry confirmed)' : ''}`);
          if (saved.recording_status === 'finished' && saved.record_id === record) {
            if (follow) { record = null; pendingRequest = null; console.log('Step complete. Waiting for the next setup step…'); }
            else { console.log('Recording finished. Start a new recording before collecting more.'); stop(); }
          }
        } else await delay(100);
      } catch (error) {
        console.error(`${error.message}. Reading retained locally.`);
        if (error.retryable === false) { fatal = true; stop(); }
        else await delay(2000);
      }
    }
  };
  console.log(`USB -> backend -> Supabase; ${follow ? 'following guided setup' : `recording ${record}` }. Close Arduino Serial Monitor while this runs.`);
  console.log(`Recovering ${outbox.pending()} queued reading(s). Ctrl+C stops without deleting them.`);
  worker = uploadLoop();
  reader = readSerial();
  while (running) {
    if (follow && !pendingRequest && !outbox.pending() && Date.now() - lastDiscovery >= 1000) {
      lastDiscovery = Date.now();
      try {
        const response = await fetch(`${base}/api/v1/sensor/active-record`, {headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10000)});
        if (!response.ok) throw Error(`Could not find the active recording (${response.status}).`);
        const value = await response.json();
        const next = value.record?.record_id ?? null;
        if (next) uuid(next, 'active record');
        if (record !== next) { record = next; console.log(record ? `Following ${value.record.record_type} step.` : 'Waiting for a setup step…'); }
      } catch (error) { record = null; console.error(error.message); }
    }
    if (record && (!follow || !outbox.pending()) && !pendingRequest && outbox.count(record) < 5000 && outbox.pending() < 5000) {
      pendingRequest = { record_id:record, reading_id: randomUUID(), timestamp: new Date().toISOString(), started: Date.now() };
      await serial.write(`READ ${pendingRequest.reading_id}\n`);
    } else if (pendingRequest && Date.now() - pendingRequest.started > 2000) {
      console.error('No structured USB response. Upload us100_usb_upload.ino and close Serial Monitor. No distance invented.');
      pendingRequest = null;
    } else if (record && !pendingRequest && outbox.count(record) >= 5000 && !outbox.pending()) {
      console.log('Reached 5000 points. Finish this recording and start another.'); stop();
    }
    await delay(500);
  }
  await worker;
  console.log(`${outbox.pending()} reading(s) remain pending; ${outbox.rejected()} late reading(s) are retained locally for ended steps.`);
} catch (error) {
  console.error(error.message); fatal = true;
} finally {
  running = false;
  if (worker) await worker.catch(() => {});
  if (reader) await reader.catch(() => {});
  if (serial) await serial.close().catch(() => {});
  outbox?.close();
  if (fatal) process.exitCode = 1;
}
