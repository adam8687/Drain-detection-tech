import http from 'node:http';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { configFromEnv } from './config.js';
import { createStore } from './storage.js';
import { ApiError, fail, object, source, text, timestamp, validateCalibration, validateDevice, validateFrame, deviceId } from './validation.js';
import { levels, analyzeSession, emptyFixtureBaseline } from './domain.js';

const ROOT = new URL('../', import.meta.url);
const MAX_BODY_BYTES = 16384;
const MAX_SESSION_FRAMES = 5000;
function equalToken(a, b) {
  const hash = s => createHash('sha256').update(s).digest();
  return timingSafeEqual(hash(a), hash(b));
}
async function body(req) {
  const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
  if (contentType !== 'application/json') throw new ApiError(415, 'unsupported_media_type', 'Send Content-Type: application/json');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ApiError(413, 'payload_too_large', 'JSON body exceeds 16KB');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'invalid_json', 'Malformed JSON body'); }
}
function safeFrame(frame, calibration) {
  const { request_hash, ...visible } = frame;
  return { ...visible, levels: levels(frame, calibration) };
}

export function createApp(config, store = createStore(config)) {
  const listeners = new Map();
  const streamStops = new Set();
  const now = () => new Date().toISOString();
  const json = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };
  const requireDevice = async id => {
    const value = await store.get('devices', deviceId(id));
    if (!value) throw new ApiError(404, 'device_not_found', 'Register this device first');
    return value;
  };
  const calibration = async (id, selectedSource) => {
    // Legacy manual calibrations apply to either source; automatic ones never do.
    const rows = await store.list('calibrations', { device_id: id }, 1000);
    return rows.find(cal => !cal.source || cal.source === selectedSource) ?? null;
  };
  const automaticCalibration = async frame => {
    const existing = await calibration(frame.device_id, frame.source);
    if (existing || config.autoCalibrate === false) return existing;
    const recent = await store.list('readings', { device_id: frame.device_id, source: frame.source }, 5, 'measured_at');
    if (!recent.length || recent[0].boot_id !== frame.boot_id || frame.sequence !== recent[0].sequence + 1 ||
        Date.parse(frame.captured_at || now()) - Date.parse(recent[0].measured_at) > 5000 ||
        Date.parse(frame.captured_at || now()) <= Date.parse(recent[0].measured_at)) return null;
    const baseline = emptyFixtureBaseline(recent);
    if (!baseline) return null;
    // Deterministic ID makes concurrent API replicas converge on the same baseline.
    const hash = createHash('sha256').update(`auto:${frame.device_id}:${frame.source}:${recent[0].event_id}`).digest('hex');
    const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
    const value = { ...validateCalibration({ empty_distance_mm: baseline }), id, device_id: frame.device_id,
      created_at: now(), source: frame.source, method: 'automatic_empty_fixture', sample_event_ids: recent.map(r => r.event_id) };
    try { return await store.insert('calibrations', value); }
    catch (error) { if (error.status === 409) return await calibration(frame.device_id, frame.source); throw error; }
  };
  const sessionView = async session => {
    // Completed reports are frozen: late buffered frames must not rewrite a demo result.
    if (session.status === 'finished' && session.analysis) return session;
    const cal = await store.get('calibrations', session.calibration_id);
    const frames = await store.list('readings', { device_id: session.device_id, source: session.source }, MAX_SESSION_FRAMES + 1, 'measured_at', { gte: session.started_at, lte: session.finished_at || now() });
    if (frames.length > MAX_SESSION_FRAMES) return { ...session, analysis: { outcome: 'inconclusive', reason: 'Session exceeds 5000 frames; use a shorter test', drain_duration_ms: null } };
    return { ...session, analysis: analyzeSession(session, frames, cal) };
  };
  const publish = (id, data) => {
    for (const res of listeners.get(id) || []) {
      // A slow dashboard must not accumulate an unbounded write buffer.
      if (res.writableLength > 65536) { res.end(); continue; }
      res.write(`event: reading\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };
  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('X-Request-ID', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    const origin = req.headers.origin;
    const originAllowed = config.origins.includes('*') || config.origins.includes(origin);
    if (origin && originAllowed) {
      res.setHeader('Access-Control-Allow-Origin', config.origins.includes('*') ? '*' : origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    }
    if (req.method === 'OPTIONS') { res.writeHead(originAllowed ? 204 : 403); res.end(); return; }
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if (req.method === 'GET' && ['/health', '/ready'].includes(path)) {
        if (path === '/ready') await store.ready();
        return json(res, 200, { status: 'ok', storage: config.storage, auth_required: Boolean(config.apiKey) });
      }
      if (req.method === 'GET' && ['/','/app.js','/styles.css','/docs','/openapi.json'].includes(path)) {
        const files = { '/': ['public/index.html','text/html'], '/app.js': ['public/app.js','text/javascript'], '/styles.css': ['public/styles.css','text/css'], '/docs': ['public/docs.html','text/html'], '/openapi.json': ['docs/openapi.json','application/json'] };
        const [file, type] = files[path];
        const data = await readFile(new URL(file, ROOT));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Content-Security-Policy': "default-src 'self'; connect-src 'self' http: https:; style-src 'self'; script-src 'self'; frame-ancestors 'none'" });
        res.end(data); return;
      }
      if (!path.startsWith('/api/v1/')) throw new ApiError(404, 'not_found', 'Route not found');
      if (config.apiKey && !equalToken(req.headers.authorization || '', `Bearer ${config.apiKey}`)) throw new ApiError(401, 'unauthorized', 'Send Authorization: Bearer <API_KEY>');
      const method = req.method;
      if (path === '/api/v1/devices') {
        if (method === 'GET') return json(res, 200, { devices: await store.list('devices', {}, 100) });
        if (method === 'POST') {
          const value = validateDevice(await body(req));
          return json(res, 201, await store.insert('devices', { ...value, created_at: now() }));
        }
      }
      if (path === '/api/v1/readings' && method === 'POST') {
        const frame = validateFrame(await body(req));
        const requestHash = createHash('sha256').update(JSON.stringify(frame)).digest('hex');
        await requireDevice(frame.device_id);
        const existing = await store.get('readings', frame.event_id);

        if (existing) {
          if (existing.request_hash !== requestHash) throw new ApiError(409, 'event_conflict', 'event_id was already used with a different payload');
          const originalCal = existing.calibration_id ? await store.get('calibrations', existing.calibration_id) : null;
          return json(res, 200, { duplicate: true, reading: safeFrame(existing, originalCal) });
        }
        const cal = await automaticCalibration(frame);
        const receivedAt = now();
        const record = { ...frame, received_at: receivedAt, measured_at: frame.captured_at || receivedAt, time_basis: frame.captured_at ? 'device_clock' : 'server_received', calibration_id: cal?.id ?? null, request_hash: requestHash };
        let savedRecord;
        try { savedRecord = await store.insert('readings', record); }
        catch (error) {
          // Concurrent retry may lose the insert race, but still succeeds idempotently.
          if (error.status === 409) {
            const winner = await store.get('readings', frame.event_id);
            if (winner?.request_hash === requestHash) {
              const originalCal = winner.calibration_id ? await store.get('calibrations', winner.calibration_id) : null;
              return json(res, 200, { duplicate: true, reading: safeFrame(winner, originalCal) });
            }
          }
          throw error;
        }
        const view = safeFrame(savedRecord, cal); publish(frame.device_id, view);
        return json(res, 201, { duplicate: false, reading: view });
      }
      const match = path.match(/^\/api\/v1\/devices\/([a-zA-Z0-9_-]+)(?:\/(calibrations|readings|stream|sessions))?$/);
      if (match) {
        const [, id, resource] = match;
        const device = await requireDevice(id);
        if (!resource && method === 'GET') {
          const selectedSource = source(url.searchParams.get('source') || 'hardware');
          const latest = (await store.list('readings', { device_id: id, source: selectedSource }, 1, 'measured_at'))[0];
          const cal = await calibration(id, selectedSource);
          const frameCal = latest?.calibration_id ? await store.get('calibrations', latest.calibration_id) : null;
          return json(res, 200, { ...device, source: selectedSource, calibration: cal, latest: latest ? safeFrame(latest, frameCal) : null, stale: !latest || Date.now() - Date.parse(latest.received_at) > 15000 });
        }
        if (resource === 'calibrations') {
          if (method === 'GET') return json(res, 200, { calibration: await calibration(id, source(url.searchParams.get('source') || 'hardware')) });
          if (method === 'POST') return json(res, 201, await store.insert('calibrations', { ...validateCalibration(await body(req)), id: randomUUID(), device_id: id, created_at: now() }));
        }
        if (resource === 'readings' && method === 'GET') {
          const limit = Number(url.searchParams.get('limit') || 100);
          if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail('limit must be 1–500');
          const filters = { device_id: id, source: source(url.searchParams.get('source') || 'hardware') };
          const since = url.searchParams.get('since');
          const range = since ? { gte: timestamp(since, 'since') } : {};
          const rows = await store.list('readings', filters, limit, 'measured_at', range);
          const calibrations = new Map();
          for (const frame of rows) if (frame.calibration_id && !calibrations.has(frame.calibration_id)) calibrations.set(frame.calibration_id, await store.get('calibrations', frame.calibration_id));
          return json(res, 200, { readings: rows.map(f => safeFrame(f, calibrations.get(f.calibration_id))), order: 'newest_first', limit });
        }
        if (resource === 'stream' && method === 'GET') {
          if (streamStops.size >= 100) throw new ApiError(429, 'stream_limit', 'Too many live dashboard connections');
          const selectedSource = source(url.searchParams.get('source') || 'hardware');
          res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.write('event: connected\ndata: {}\n\n');
          if (!listeners.has(id)) listeners.set(id, new Set());
          listeners.get(id).add(res);
          let stopped = false, timer, fingerprint;
          const stop = () => {
            stopped = true; clearTimeout(timer); streamStops.delete(stop);
            listeners.get(id)?.delete(res); if (!listeners.get(id)?.size) listeners.delete(id);
            res.end();
          };
          streamStops.add(stop);
          res.on('close', stop);
          const poll = async () => {
            try {
              const [rows, tests, cal] = await Promise.all([
                store.list('readings', { device_id: id, source: selectedSource }, 120, 'measured_at'),
                store.list('sessions', { device_id: id, source: selectedSource }, 30, 'started_at'),
                calibration(id, selectedSource),
              ]);
              const calibrations = new Map();
              for (const frame of rows) if (frame.calibration_id && !calibrations.has(frame.calibration_id)) calibrations.set(frame.calibration_id, await store.get('calibrations', frame.calibration_id));
              const readings = rows.map(frame => safeFrame(frame, calibrations.get(frame.calibration_id)));
              const latest = readings[0] || null;
              const snapshot = { device: { ...device, source: selectedSource, calibration: cal, latest,
                stale: !latest || Date.now() - Date.parse(latest.received_at) > 15000 }, readings, tests };
              const next = JSON.stringify(snapshot);
              if (stopped) return;
              if (res.writableLength > 65536) { stop(); return; }
              if (next !== fingerprint) { res.write(`event: snapshot\ndata: ${next}\n\n`); fingerprint = next; }
              else res.write(': heartbeat\n\n');
            } catch {
              if (!stopped) res.write('event: unavailable\ndata: {}\n\n');
              stop(); return;
            }
            if (!stopped) timer = setTimeout(poll, 1000);
          };
          timer = setTimeout(poll, 0);
          return;
        }
        if (resource === 'sessions') {
          if (method === 'GET') {
            const rows = await store.list('sessions', { device_id: id }, 30, 'started_at');
            return json(res, 200, { sessions: rows });
          }
          if (method === 'POST') {
            const value = object(await body(req), ['source', 'name']);
            const selectedSource = source(value.source);
            const cal = await calibration(id, selectedSource);
            if (!cal) throw new ApiError(409, 'calibration_required', 'Calibrate both sensors before starting a drainage test');
            return json(res, 201, await store.insert('sessions', { id: randomUUID(), device_id: id, source: source(value.source), name: text(value.name || 'Drainage test', 'name'), status: 'active', started_at: now(), finished_at: null, calibration_id: cal.id }));
          }
        }
      }
      const sessionMatch = path.match(/^\/api\/v1\/sessions\/([0-9a-f-]+)(\/finish)?$/);
      if (sessionMatch) {
        const session = await store.get('sessions', sessionMatch[1]);
        if (!session) throw new ApiError(404, 'session_not_found', 'Session not found');
        if (method === 'GET' && !sessionMatch[2]) return json(res, 200, await sessionView(session));
        if (method === 'POST' && sessionMatch[2]) {
          if (session.status === 'finished') return json(res, 200, await sessionView(session));
          const done = { ...session, status: 'finished', finished_at: now() };
          const result = await sessionView(done);
          await store.updateSession(result);
          return json(res, 200, result);
        }
      }
      throw new ApiError(404, 'not_found', 'Route or method not found');
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      // No headers, request bodies, URLs containing credentials, or raw upstream errors in logs.
      if (!(error instanceof ApiError)) console.error(JSON.stringify({ request_id: requestId, code: 'internal_error' }));
      json(res, error.status || 500, { error: { code: error.code || 'internal_error', message: error instanceof ApiError ? error.message : 'Unexpected server error', request_id: requestId } });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 64;
  return { server, store, close: async () => {
    for (const stop of streamStops) stop();
    await new Promise(resolve => server.close(resolve));
    await store.close();
  } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let app;
  let config;
  try {
    config = configFromEnv();
    app = createApp(config);
    await app.store.ready(); // Fail startup rather than silently substituting local storage.
    await new Promise((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(config.port, config.host, resolve);
    });
    console.log(`Drain monitor listening on ${config.host}:${config.port} (${config.storage}; auth ${config.apiKey ? 'enabled' : 'disabled for local development'})`);
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await app.close(); process.exit(0); };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  } catch (error) {
    if (app) await app.close().catch(() => {});
    console.error(error.code === 'EADDRINUSE'
      ? `Port ${config.port} is already in use. Stop the existing backend with Ctrl+C in its terminal before starting another copy.`
      : error instanceof ApiError ? error.message : 'Startup failed. Check backend/.env, database connectivity and migration.');
    process.exitCode = 1;
  }
}
