import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createApp } from '../src/server.js';
import { configFromEnv } from '../src/config.js';
import { Outbox, measurementFromReply, uploadNext } from '../../device/usb-bridge/bridge.js';

const sensor = { distance_mm: 313, status: 'ok' };
const missing = { distance_mm: null, status: 'timeout' };
function reply(request, overrides = {}) { return JSON.stringify({ reading_id: request.reading_id, sensor_a: sensor, sensor_b: missing, ...overrides }); }
function request() { return { reading_id: randomUUID(), timestamp: new Date().toISOString() }; }

test('USB decoding preserves exact schema, request time and real missing sensor status', () => {
  const req = request();
  const point = measurementFromReply(reply(req), req);
  assert.deepEqual(point, { ...req, sensor_a: sensor, sensor_b: missing });
  assert.throws(() => measurementFromReply(reply(req, { reading_id: randomUUID() }), req));
  assert.throws(() => measurementFromReply(reply(req, { temperature_c: 20 }), req));
  assert.throws(() => measurementFromReply(reply(req, { sensor_a: { distance_mm: 0, status: 'ok' } }), req));
  assert.throws(() => measurementFromReply(reply(req, { sensor_b: { distance_mm: 0, status: 'timeout' } }), req));
  assert.throws(() => measurementFromReply('Distance: 313 mm', req));
});

test('USB outbox survives restart and keeps payload immutable after network failure', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'drain-usb-'));
  let queue;
  try {
    const path = join(folder, 'outbox.sqlite'), record = randomUUID(), req = request();
    const point = measurementFromReply(reply(req), req);
    queue = new Outbox(path); queue.enqueue(record, point);
    const before = queue.next().body;
    await assert.rejects(uploadNext(queue, { base: 'http://test', fetcher: async () => { throw Error('offline'); } }));
    queue.close(); queue = new Outbox(path);
    assert.equal(queue.pending(), 1); assert.equal(queue.next().body, before);
    queue.enqueue(record, point); assert.equal(queue.count(record), 1);
    assert.throws(() => queue.enqueue(record, { ...point, sensor_a: { distance_mm: 314, status: 'ok' } }));
    await assert.rejects(uploadNext(queue, { base: 'http://test', fetcher: async () => new Response('{}', { status: 201 }) }));
    assert.equal(queue.pending(), 1);
  } finally { queue?.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('USB uploads use fixture keys; lost acknowledgement retries produce one stored point', async t => {
  const config = { ...configFromEnv({ STORAGE_BACKEND: 'sqlite', SQLITE_PATH: ':memory:' }), apiKey: 'admin-test' };
  const app = createApp(config);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (path, body) => {
    const res = await fetch(`${base}/api/v1${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admin-test' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(res.ok, String(res.status)); return res.json();
  };
  await api('/devices', { device_id: 'usb-test', name: 'USB Test' });
  const { key } = await api('/devices/usb-test/keys', {});
  const record = await api('/records', { fixture_id: 'usb-test', record_type: 'monitoring', data_source: 'sensor' });
  const queue = new Outbox(':memory:'); t.after(() => queue.close());
  const req = request(); queue.enqueue(record.record_id, measurementFromReply(reply(req), req));
  const options = { base, token: key };
  await assert.rejects(uploadNext(queue, { ...options, fetcher: async (...args) => { const res = await fetch(...args); assert.equal(res.status, 201); throw Error('acknowledgement lost'); } }));
  assert.equal(queue.pending(), 1);
  const saved = await uploadNext(queue, options);
  assert.equal(saved.duplicate, true); assert.equal(queue.pending(), 0);
  const stored = await api(`/records/${record.record_id}`);
  assert.equal(stored.record.data_source, 'sensor');
  assert.deepEqual(stored.record.measurements, [{ ...req, sensor_a: sensor, sensor_b: missing }]);
  const simulation = await api('/records', { fixture_id: 'usb-test', record_type: 'monitoring', data_source: 'simulation' });
  const next = request(); queue.enqueue(simulation.record_id, measurementFromReply(reply(next), next));
  await assert.rejects(uploadNext(queue, options), error => error.retryable === false && error.message.includes('403'));
  assert.equal(queue.pending(), 1);
});

test('Mac serial launcher accepts fragmented device replies and exits cleanly', { skip: process.platform !== 'darwin', timeout: 20000 }, async t => {
  const app = createApp({ ...configFromEnv({ STORAGE_BACKEND: 'sqlite', SQLITE_PATH: ':memory:' }), apiKey: 'serial-test' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const created = await fetch(`${base}/api/v1/records`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer serial-test' },
    body: JSON.stringify({ fixture_id: 'usb-pty-test', record_type: 'monitoring', data_source: 'sensor' }) });
  assert.equal(created.status, 201);
  const record = await created.json();
  const folder = mkdtempSync(join(tmpdir(), 'drain-usb-pty-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  // A device emulator, not physical sensor evidence. It deliberately fragments
  // each reply to exercise the launcher's real serial buffering and shutdown.
  const python = spawn('python3', ['-u', '-c', `
import os, pty, select, json, time, tty
master, slave = pty.openpty()
tty.setraw(slave)
print(os.ttyname(slave), flush=True)
buffer = b''
while True:
    if not select.select([master], [], [], 1)[0]: continue
    buffer += os.read(master, 1024)
    while b'\\n' in buffer:
        line, buffer = buffer.split(b'\\n', 1)
        if not line.startswith(b'READ '): continue
        reply = json.dumps({'reading_id': line[5:].decode().strip(), 'sensor_a': {'distance_mm': 313, 'status': 'ok'}, 'sensor_b': {'distance_mm': None, 'status': 'timeout'}}).encode() + b'\\n'
        os.write(master, reply[:21])
        time.sleep(.02)
        os.write(master, reply[21:])
`]);
  t.after(() => python.kill('SIGKILL'));
  const port = await new Promise((resolve, reject) => {
    let text = '';
    python.on('error', reject);
    python.stdout.on('data', chunk => { text += chunk; if (text.includes('\n')) resolve(text.split('\n')[0].trim()); });
    python.once('exit', code => reject(Error(`Pseudo-terminal setup exited (${code})`)));
  });
  const runner = spawn(process.execPath, [fileURLToPath(new URL('../../device/usb-bridge/run.js', import.meta.url)), port], {
    env: { ...process.env, API_BASE_URL: base, SENSOR_RECORD_ID: record.record_id, SENSOR_KEY: 'serial-test', SENSOR_OUTBOX: join(folder, 'outbox.sqlite') },
  });
  t.after(() => runner.kill('SIGKILL'));
  let output = '';
  runner.stdout.on('data', chunk => {
    output += chunk;
    if (output.includes('Saved ')) runner.kill('SIGINT');
  });
  runner.stderr.on('data', chunk => { output += chunk; });
  const [exitCode] = await once(runner, 'exit');
  assert.equal(exitCode, 0, output);
  assert.match(output, /A=313, B=timeout/);
  const stored = await app.store.get(record.record_id);
  assert.equal(stored.measurements.length, 1);
  assert.deepEqual(stored.measurements[0].sensor_a, sensor);
  assert.deepEqual(stored.measurements[0].sensor_b, missing);
  const queue = new Outbox(join(folder, 'outbox.sqlite'));
  assert.equal(queue.pending(), 0); queue.close();
});
