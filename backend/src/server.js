import {validateDrainageAction,updateDrainageCalibration} from '../../supabase/functions/_shared/drainage-calibration.js';
import {createEmailNotifications,emailCandidates,emailReferenceSamples,verifiedUserEmail} from '../../supabase/functions/_shared/email-notifications.js';
import {SupabaseEmailStore} from '../../supabase/functions/_shared/email-storage.js';
import {SQLiteEmailStore} from './email-storage.js';
import http from 'node:http';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { configFromEnv } from './config.js';
import { createRecordStore } from './records-storage.js';
import { buildAlerts, summarizeAlerts, SEVERITIES } from './alerts.js';
import { createStore as createAccessStore } from './storage.js';
import { DEVICE_KEY_PREFIX, hashDeviceKey, newDeviceKey, supabaseUserVerifier } from './auth.js';
import { ApiError, uuid, deviceId, validateDevice } from './validation.js';
import { validateRecordInput, validateMeasurements, appendMeasurements, analyzeDrainage, computedView, boundedRecordView, drainStatuses, statusContext, withDrainageProfile, drainCycleSummaries, fail } from './records-domain.js';

const sameToken = (a, b) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
async function body(req) {
  if ((req.headers['content-type'] || '').split(';')[0].trim() !== 'application/json') throw new ApiError(415, 'unsupported_media_type', 'Send Content-Type: application/json');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 16384) throw new ApiError(413, 'payload_too_large', 'Send at most 20 measurements per request (maximum 16KB)'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError(400, 'invalid_json', 'Malformed JSON'); }
}
export function createApp(config, store = createRecordStore(config), {
  clock = ()=>Date.now(),
  verifyUser = config.storage === 'supabase' ? supabaseUserVerifier(config.supabaseUrl, config.supabaseKey) : async () => null,
  accessStore = createAccessStore(config),
  notifications = createEmailNotifications({config:config.email??{enabled:false},deliveryStore:store.db?new SQLiteEmailStore(store.db):new SupabaseEmailStore(config.supabaseUrl,config.supabaseKey),accessStore,userEmail:verifiedUserEmail(config.supabaseUrl,config.supabaseKey)}),
} = {}) {
  const streams = new Set();
  const authenticate = async req => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const unauthorized = () => new ApiError(401, 'unauthorized', 'Sign in or supply a valid backend/device token');
    if (!token) { if (config.apiKey||config.storage==='supabase'||config.production) throw unauthorized(); return { admin: true }; }
    if(config.emailWorkerToken&&sameToken(token,config.emailWorkerToken))return{emailWorker:true};
    if (config.apiKey && sameToken(token, config.apiKey)) return { admin: true };
    if (token.startsWith(DEVICE_KEY_PREFIX)) {
      const key = await accessStore.get('device_keys', hashDeviceKey(token));
      if (!key || key.revoked_at) throw unauthorized();
      return { deviceId: key.device_id };
    }
    const userId = await verifyUser(token);
    if (!userId) throw unauthorized();
    return { userId };
  };
  const requireAccess = async (who, fixture, write = false, ingest = false) => {
    if (who.admin) return;
    if (who.deviceId) {
      if (!ingest || who.deviceId !== fixture) throw new ApiError(403, 'forbidden', 'Sensor keys can only append readings for their own fixture');
      return;
    }
    if (ingest) throw new ApiError(403, 'forbidden', 'Upload sensor readings with the fixture sensor key');
    const membership = (await accessStore.list('device_members', { device_id: fixture, user_id: who.userId }, 1))[0];
    if (!membership) throw new ApiError(404, 'fixture_not_found', 'Fixture not found');
    if (write && membership.role !== 'owner') throw new ApiError(403, 'forbidden', 'Only the fixture owner can change it');
  };
  const get = async id => { const row = await store.get(uuid(id, 'record_id')); if (!row) throw new ApiError(404, 'record_not_found', 'Recording not found'); return row; };
  const mutate = async (id, transform) => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const previous = await get(id), response = transform(previous);
      if(response.record===previous)return response;
      const events=notifications.enabled&&emailCandidates(response.record).length?await (async()=>{const profiled=await withDrainageProfile(store,response.record);return emailCandidates(profiled,[profiled],Date.now(),await notifications.references(response.record.fixture_id));})():[];
      if(await store.compareAndSet(previous,response.record,events,notifications.enabled?emailReferenceSamples(response.record):[])){if(events.length)notifications.kick();return response;}
    }
    throw new ApiError(409, 'concurrent_update', 'Recording is busy; retry using the same reading_id');
  };
  const visibleRows = async (who, filters, limit) => {
    if (who.deviceId) throw new ApiError(403, 'forbidden', 'Sensor keys cannot list recordings');
    if (filters.fixture_id) await requireAccess(who, filters.fixture_id);
    if (who.userId && !filters.fixture_id) {
      const memberships = await accessStore.list('device_members', { user_id: who.userId }, 100);
      const lists = await Promise.all(memberships.map(m => store.list({ ...filters, fixture_id: m.device_id }, limit)));
      return lists.flat().sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
    }
    return store.list(filters, limit);
  };
  const summaries = async rows => { const statuses = drainStatuses(await statusContext(store, rows)); return rows.map(row => ({ ...summary(row), drain_status: statuses.get(row.record_id) ?? null })); };
  const summary = row => ({ ...(row.schema_version===1?{schema_version:1}:{}),record_id: row.record_id, fixture_id: row.fixture_id, record_type: row.record_type, data_source: row.data_source, recording_status: row.recording_status, calibration: row.calibration, result: row.result, created_at: row.created_at, measurement_count: row.measurements.length, drain_cycles:drainCycleSummaries(row) });
  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID(); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Request-ID', requestId); res.setHeader('X-Content-Type-Options', 'nosniff');
    const origin = req.headers.origin, allowed = config.origins.includes('*') || config.origins.includes(origin);
    if (origin && allowed) { res.setHeader('Access-Control-Allow-Origin', config.origins.includes('*') ? '*' : origin); res.setHeader('Vary', 'Origin'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization'); }
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    if (req.method === 'OPTIONS') { res.writeHead(allowed ? 204 : 403); res.end(); return; }
    try {
      const url = new URL(req.url, 'http://localhost'), path = url.pathname;
      if (req.method === 'GET' && ['/health', '/ready'].includes(path)) { if (path === '/ready') await store.ready(); return json(200, { status: 'ok', schema: 'drain_records', storage: config.storage, auth_required: Boolean(config.apiKey)||config.storage==='supabase'||config.production }); }
      if (req.method === 'GET' && path === '/openapi.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(await readFile(new URL('../docs/openapi.json', import.meta.url))); return; }
      if (req.method === 'GET' && ['/', '/docs'].includes(path)) return json(200, { service: 'Drain Monitor API', schema: 'drain_records', frontend: 'http://localhost:3000/insights', contract: '/openapi.json' });
      if (!path.startsWith('/api/v1/')) throw new ApiError(404, 'not_found', 'Route not found');
      const who = await authenticate(req);
      if(who.emailWorker&&(path!=='/api/v1/internal/email-deliveries'||req.method!=='POST'))throw new ApiError(403,'forbidden','Worker access is restricted to email delivery');
      if(path==='/api/v1/internal/email-deliveries'&&req.method==='POST'){
        if(!who.admin&&!who.emailWorker)throw new ApiError(403,'forbidden','Worker access required');return json(200,await notifications.flush());
      }
      const emailSettings=path.match(/^\/api\/v1\/devices\/([a-zA-Z0-9_-]+)\/notifications$/);
      if(emailSettings&&['GET','POST'].includes(req.method)){
        if(!who.userId)throw new ApiError(403,'forbidden','Sign in as the unit owner');const fixture=deviceId(emailSettings[1]);await requireAccess(who,fixture,true);
        if(req.method==='GET')return json(200,await notifications.preference(fixture,who.userId));
        try{return json(200,await notifications.savePreference(fixture,who.userId,await body(req)));}catch(error){if(error instanceof ApiError)throw error;fail(error.message);}
      }
      if (path === '/api/v1/sensor/active-record' && req.method === 'GET') {
        if (!who.deviceId) throw new ApiError(403, 'forbidden', 'Use the fixture sensor key for automatic recording selection');
        const row = (await (store.headers?.bind(store) ?? store.list.bind(store))({fixture_id:who.deviceId,data_source:'sensor',recording_status:'recording'},1))[0];
        return json(200, {record:row ? {record_id:row.record_id,record_type:row.record_type,fixture_id:row.fixture_id} : null});
      }
      if (path === '/api/v1/devices') {
        if (who.deviceId) throw new ApiError(403, 'forbidden', 'Sensor keys cannot access the fixture registry');
        if (req.method === 'GET') {
          if (who.admin) return json(200, { devices: await accessStore.list('devices', {}, 100) });
          const memberships = await accessStore.list('device_members', { user_id: who.userId }, 100);
          const devices = await Promise.all(memberships.map(m => accessStore.get('devices', m.device_id)));
          return json(200, { devices: devices.filter(Boolean) });
        }
        if (req.method === 'POST') {
          const value = validateDevice(await body(req));
          const device = await accessStore.insert('devices', { ...value, created_at: new Date().toISOString() });
          if (who.userId) await accessStore.insert('device_members', { id: randomUUID(), device_id: device.device_id, user_id: who.userId, role: 'owner', created_at: new Date().toISOString() });
          return json(201, device);
        }
      }
      const keys = path.match(/^\/api\/v1\/devices\/([a-zA-Z0-9_-]+)\/keys$/);
      if (keys && req.method === 'POST') {
        const fixture = deviceId(keys[1]); await requireAccess(who, fixture, true);
        if (!await accessStore.get('devices', fixture)) throw new ApiError(404, 'fixture_not_found', 'Register the fixture first');
        const key = newDeviceKey(), created_at = new Date().toISOString();
        await accessStore.insert('device_keys', { key_hash: hashDeviceKey(key), device_id: fixture, created_at, prefix: key.slice(0, 10), created_by: who.userId || 'admin' });
        return json(201, { device_id: fixture, key, created_at });
      }
      if (path === '/api/v1/records') {
        if (req.method === 'GET') {
          const filters = {};
          for (const name of ['fixture_id', 'data_source', 'record_type', 'recording_status']) if (url.searchParams.has(name)) filters[name] = url.searchParams.get(name);
          if (filters.fixture_id) deviceId(filters.fixture_id);
          if (filters.data_source && !['sensor', 'simulation'].includes(filters.data_source)) fail('Invalid data_source');
          if (filters.record_type && !['calibration', 'drainage', 'monitoring'].includes(filters.record_type)) fail('Invalid record_type');
          if (filters.recording_status && !['recording', 'finished'].includes(filters.recording_status)) fail('Invalid recording_status');
          const limit = Number(url.searchParams.get('limit') || 100); if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail('limit must be 1–200');
          return json(200, { records: await summaries(await visibleRows(who, filters, limit)) });
        }
        if (req.method === 'POST') {
          const input = validateRecordInput(await body(req));
          await requireAccess(who, input.fixture_id, true);
          const calibrationRecord = (await store.list({ fixture_id: input.fixture_id, data_source: input.data_source, record_type: 'calibration', recording_status: 'finished', calibration_present: true, schema_version:2 }, 1))[0];
          const calibration = input.record_type === 'calibration' || !calibrationRecord?.calibration ? null : {empty_distance_mm:calibrationRecord.calibration.empty_distance_mm};
          if (input.record_type === 'drainage' && !calibration) throw new ApiError(409, 'calibration_required', 'Complete empty-fixture calibration for this fixture and data source first');
          const row = await store.insert({ record_id: randomUUID(), fixture_id: input.fixture_id, record_type: input.record_type, data_source: input.data_source, recording_status: 'recording', calibration, measurements: [], result: null, created_at: new Date().toISOString() });
          return json(201, row);
        }
      }
      if (path === '/api/v1/alerts' && req.method === 'GET') {
        const filters = {};
        if (url.searchParams.has('fixture_id')) filters.fixture_id = deviceId(url.searchParams.get('fixture_id'));
        if (url.searchParams.has('data_source')) { filters.data_source = url.searchParams.get('data_source'); if (!['sensor', 'simulation'].includes(filters.data_source)) fail('Invalid data_source'); }
        const severity = url.searchParams.get('severity');
        if (severity !== null && !SEVERITIES.includes(severity)) fail('severity must be critical, warning or info');
        const limit = Number(url.searchParams.get('limit') || 50); if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail('limit must be 1–200');
        const all = buildAlerts(await statusContext(store, await visibleRows(who, filters, 200)));
        return json(200, { summary: summarizeAlerts(all), alerts: all.filter(a => severity === null || a.severity === severity).slice(0, limit), generated_at: new Date().toISOString() });
      }
      const match = path.match(/^\/api\/v1\/records\/([0-9a-f-]+)(?:\/(measurements|finish|stream|drainage-calibration))?$/i);
      if (match) {
        const [, id, action] = match;
        if (!action && req.method === 'GET') {
          const record = await get(id), rawSample = url.searchParams.get('sample'), sample = rawSample === null ? null : Number(rawSample);
          if (sample !== null && (!Number.isInteger(sample) || sample < 0)) fail('sample must be a nonnegative integer');
          await requireAccess(who, record.fixture_id);
          const siblings = ['drainage','monitoring'].includes(record.record_type) ? await store.list({ fixture_id: record.fixture_id, data_source: record.data_source }, 5) : [];
          const drain_status = drainStatuses(await statusContext(store, [...siblings.filter(r => r.record_id !== record.record_id), record])).get(record.record_id) ?? null;
          const view=boundedRecordView(record,sample,url.searchParams.has('window')?Number(url.searchParams.get('window')):null,url.searchParams.get('after'));
          return json(200, {...view,computed:{...view.computed,drain_status}});
        }
        if(action==='drainage-calibration'&&req.method==='POST'){
          const calibration=await get(id);await requireAccess(who,calibration.fixture_id,true);
          const input=validateDrainageAction(await body(req)),captureId=randomUUID();
          const observationId=input.recording_id??calibration.calibration?.drainage?.active_capture?.recording_id;
          const observation=observationId?await get(observationId):null;
          if(observation)await requireAccess(who,observation.fixture_id,true);
          const result=await mutate(id,previous=>({record:updateDrainageCalibration(previous,observation,input,captureId,clock())}));
          return json(200,{record_id:id,calibration:result.record.calibration});
        }
        if (action === 'measurements' && req.method === 'POST') {
          const current = await get(id);
          await requireAccess(who, current.fixture_id, false, true);
          if (who.deviceId && current.data_source !== 'sensor') throw new ApiError(403, 'forbidden', 'Sensor keys cannot append simulation data');
          const points = validateMeasurements(await body(req));
          const result = await mutate(id, previous => appendMeasurements(previous, points));
          // Return a compact acknowledgement; full records are retrieved separately.
          return json(result.duplicate ? 200 : 201, { duplicate: result.duplicate, record_id: id, recording_status: result.record.recording_status, measurement_count: result.record.measurements.length, result: result.record.result, calibration: result.record.calibration });
        }
        if (action === 'finish' && req.method === 'POST') {
          await requireAccess(who, (await get(id)).fixture_id, true);
          const result = await mutate(id, previous => {
            if (previous.recording_status === 'finished') return { record: previous };
            // Incomplete calibration is not marked usable; it can keep collecting or be abandoned by finishing without a baseline.
            const result = previous.record_type === 'drainage' ? analyzeDrainage(previous.measurements, previous.calibration).result : null;
            return { record: { ...previous, recording_status: 'finished', result } };
          });
          return json(200, { record: result.record, computed: computedView(result.record) });
        }
        if (action === 'stream' && req.method === 'GET') {
          await requireAccess(who, (await get(id)).fixture_id);
          if (streams.size >= 100) throw new ApiError(429, 'stream_limit', 'Too many live connections');
          res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.write('event: connected\ndata: {}\n\n');
          let closed = false, timer, last;
          const stop = () => { if (closed) return; closed = true; clearTimeout(timer); streams.delete(stop); res.end(); };
          streams.add(stop); res.on('close', stop);
          const poll = async () => {
            try {
              const record = await get(id);
              const drain_status = ['drainage','monitoring'].includes(record.record_type) ? drainStatuses(await statusContext(store, [record])).get(id) : null;
              const value = JSON.stringify({ record, computed: {...computedView(record), drain_status} });
              if (closed) return;
              if (res.writableLength > 65536) { stop(); return; }
              if (value !== last) { res.write(`event: snapshot\ndata: ${value}\n\n`); last = value; } else res.write(': heartbeat\n\n');
            } catch { if (!closed) res.write('event: unavailable\ndata: {}\n\n'); stop(); return; }
            if (!closed) timer = setTimeout(poll, 1000);
          };
          void poll(); return;
        }
      }
      throw new ApiError(404, 'not_found', 'Use /api/v1/records; legacy device/reading/session routes have been replaced');
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      json(error instanceof ApiError ? error.status : 500, { error: { code: error instanceof ApiError ? error.code : 'internal_error', message: error instanceof ApiError ? error.message : 'Unexpected server error', request_id: requestId } });
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  return { server, store, accessStore, close: async () => { for (const stop of streams) stop(); await new Promise(resolve => server.close(resolve)); await store.close(); await accessStore.close(); } };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let app;
  try {
    const config = configFromEnv(); app = createApp(config); await app.store.ready();
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(config.port, config.host, resolve); });
    console.log(`Drain Monitor API listening on ${config.host}:${config.port} (${config.storage}, drain_records)`);
    let stopping = false; const stop = async () => { if (stopping) return; stopping = true; await app.close(); process.exit(0); }; process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (error) { if (app) await app.close().catch(() => {}); console.error(error.code === 'EADDRINUSE' ? 'Backend port is already in use. Stop your existing backend before restarting.' : error instanceof ApiError ? error.message : 'Startup failed. Check configuration and apply the drain_records migration.'); process.exitCode = 1; }
}
