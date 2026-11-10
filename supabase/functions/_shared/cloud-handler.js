import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { ApiError, uuid, deviceId, validateDevice } from './validation.js';
import { hashDeviceKey, newDeviceKey, supabaseUserVerifier } from './auth.js';
import { SupabaseRecordStore } from './records-storage.js';
import { SupabaseAccessStore } from './access-storage.js';
import { validateRecordInput, validateMeasurements, appendMeasurements, analyzeDrainage, computedView, drainStatuses, fail } from './records-domain.js';
import { buildAlerts, summarizeAlerts, SEVERITIES } from './alerts.js';

const equalToken = (a, b) => timingSafeEqual(Buffer.from(hashDeviceKey(a)), Buffer.from(hashDeviceKey(b)));
async function readBody(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new ApiError(415, 'unsupported_media_type', 'Send Content-Type: application/json');
  const reader = request.body?.getReader(), chunks = []; let size = 0;
  if (reader) while (true) {
    const next = await reader.read(); if (next.done) break;
    size += next.value.length;
    if (size > 16384) { await reader.cancel(); throw new ApiError(413, 'body_too_large', 'Send at most 20 measurements per request (maximum 16KB)'); }
    chunks.push(next.value);
  }
  const body = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(body)); } catch { throw new ApiError(400, 'invalid_json', 'Malformed JSON'); }
}

// Fetch API adapter. All measurement/calibration/forecast/alert logic is the same
// module used by the Node backend; only transport and always-on auth differ.
export function createCloudHandler(config, {
  store = new SupabaseRecordStore(config.url, config.serviceKey),
  accessStore = new SupabaseAccessStore(config.url, config.serviceKey),
  verifyUser = supabaseUserVerifier(config.url, config.serviceKey),
} = {}) {
  if (config.adminToken && config.adminToken.length < 32) throw Error('Cloud admin token must have at least 32 characters');
  const get = async id => { const row = await store.get(uuid(id, 'record_id')); if (!row) throw new ApiError(404, 'record_not_found', 'Recording not found'); return row; };
  const authorize = async request => {
    const header = request.headers.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const denied = () => new ApiError(401, 'unauthorized', 'Sign in or supply a valid fixture token');
    if (!token) throw denied();
    if (config.adminToken && equalToken(token, config.adminToken)) return { admin: true };
    if (token.startsWith('dk_') || token.startsWith('dv_')) {
      const key = await accessStore.get('device_keys', hashDeviceKey(token));
      if (!key || key.revoked_at) throw denied();
      if (token.startsWith('dv_')) { if (key.kind !== 'viewer') throw denied(); return { viewerFixture: key.device_id }; }
      if (key.kind === 'viewer') throw denied();
      return { deviceId: key.device_id };
    }
    const userId = await verifyUser(token); if (!userId) throw denied(); return { userId };
  };
  const access = async (who, fixture, write = false, ingest = false) => {
    if (who.admin) return;
    if (who.viewerFixture) {
      if (who.viewerFixture !== fixture || write || ingest) throw new ApiError(403, 'forbidden', 'Viewer token is read-only for its fixture');
      return;
    }
    if (who.deviceId) {
      if (!ingest || who.deviceId !== fixture) throw new ApiError(403, 'forbidden', 'Sensor keys can only append readings for their fixture');
      return;
    }
    if (ingest) throw new ApiError(403, 'forbidden', 'Upload readings using the fixture sensor key');
    const membership = (await accessStore.list('device_members', { device_id: fixture, user_id: who.userId }, 1))[0];
    if (!membership) throw new ApiError(404, 'fixture_not_found', 'Fixture not found');
    if (write && membership.role !== 'owner') throw new ApiError(403, 'forbidden', 'Only owners can change this fixture');
  };
  const visible = async (who, filters, limit) => {
    if (who.deviceId) throw new ApiError(403, 'forbidden', 'Sensor keys cannot list recordings');
    if (filters.fixture_id) await access(who, filters.fixture_id);
    if (who.viewerFixture) return store.list({ ...filters, fixture_id: who.viewerFixture }, limit);
    if (who.userId && !filters.fixture_id) {
      const members = await accessStore.list('device_members', { user_id: who.userId }, 100);
      return (await Promise.all(members.map(m => store.list({ ...filters, fixture_id: m.device_id }, limit)))).flat().sort((a,b) => b.created_at.localeCompare(a.created_at)).slice(0,limit);
    }
    return store.list(filters, limit);
  };
  const mutate = async (id, transform) => {
    for (let n = 0; n < 12; n++) { const previous = await get(id), response = transform(previous); if (response.record === previous || await store.compareAndSet(previous, response.record)) return response; }
    throw new ApiError(409, 'concurrent_update', 'Recording is busy; retry with the same reading_id');
  };
  return async request => {
    const origin = request.headers.get('origin');
    const allowed = !origin || (config.origins || []).includes(origin);
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      ...(origin && allowed ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'authorization,apikey,content-type,x-client-info' } : {}) };
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers });
    if (request.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers });
    try {
      const url = new URL(request.url);
      // Supabase preserves the function prefix in the path; do not discard it in callers.
      const path = url.pathname.replace(/^\/functions\/v1\/drain-api(?=\/|$)/, '').replace(/^\/drain-api(?=\/|$)/, '') || '/';
      if (request.method === 'GET' && ['/health','/ready'].includes(path)) {
        if (path === '/ready') await store.ready();
        return json(200, { status: 'ok', schema: 'drain_records', storage: 'supabase', auth_required: true, runtime: 'supabase-edge' });
      }
      const who = await authorize(request);
      if (path === '/api/v1/devices') {
        if (who.deviceId) throw new ApiError(403, 'forbidden', 'Sensor keys cannot access the registry');
        if (request.method === 'GET') {
          if (who.admin) return json(200, { devices: await accessStore.list('devices') });
          if (who.viewerFixture) { const value = await accessStore.get('devices', who.viewerFixture); return json(200,{devices:value ? [value] : []}); }
          const members = await accessStore.list('device_members', { user_id: who.userId }, 100);
          return json(200, { devices: (await Promise.all(members.map(m => accessStore.get('devices', m.device_id)))).filter(Boolean) });
        }
        if (request.method === 'POST') {
          if (who.viewerFixture) throw new ApiError(403, 'forbidden', 'Viewer token is read-only');
          const value = validateDevice(await readBody(request));
          const row = await accessStore.insert('devices', { ...value, created_at: new Date().toISOString() });
          if (who.userId) await accessStore.insert('device_members', { id: randomUUID(), device_id: value.device_id, user_id: who.userId, role: 'owner', created_at: new Date().toISOString() });
          return json(201, row);
        }
      }
      const keys = path.match(/^\/api\/v1\/devices\/([a-zA-Z0-9_-]+)\/(keys|view-key)$/);
      if (keys && request.method === 'POST') {
        const fixture = deviceId(keys[1]); await access(who, fixture, true);
        if (!await accessStore.get('devices', fixture)) throw new ApiError(404, 'fixture_not_found', 'Register the fixture first');
        const viewer = keys[2] === 'view-key';
        const key = viewer ? newDeviceKey().replace(/^dk_/, 'dv_') : newDeviceKey();
        await accessStore.insert('device_keys', { key_hash: hashDeviceKey(key), device_id: fixture, created_at: new Date().toISOString(), ...(viewer ? { kind: 'viewer' } : {}), created_by: who.userId || 'admin' });
        return json(201, { device_id: fixture, key });
      }
      if (path === '/api/v1/records' && request.method === 'POST') {
        const input = validateRecordInput(await readBody(request)); await access(who, input.fixture_id, true);
        const latest = (await store.list({ fixture_id: input.fixture_id, data_source: input.data_source, record_type: 'calibration', recording_status: 'finished', calibration_present: true },1))[0];
        const calibration = input.record_type === 'calibration' ? null : latest?.calibration ?? null;
        if (input.record_type === 'drainage' && !calibration) throw new ApiError(409,'calibration_required','Complete empty-fixture calibration first');
        return json(201, await store.insert({ ...input, record_id: randomUUID(), recording_status: 'recording', calibration, measurements: [], result: null, created_at: new Date().toISOString() }));
      }
      if ((path === '/api/v1/records' || path === '/api/v1/alerts') && request.method === 'GET') {
        const filters = {};
        for (const name of ['fixture_id','data_source','record_type','recording_status']) if (url.searchParams.has(name)) filters[name] = url.searchParams.get(name);
        if (filters.fixture_id) deviceId(filters.fixture_id);
        for (const [key, values] of [['data_source',['sensor','simulation']],['record_type',['calibration','drainage','monitoring']],['recording_status',['recording','finished']]]) if (filters[key] && !values.includes(filters[key])) fail(`Invalid ${key}`);
        const limit = Number(url.searchParams.get('limit') || 100); if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail('limit must be 1–200');
        const severity = url.searchParams.get('severity');
        if (path.endsWith('/alerts') && severity !== null && !SEVERITIES.includes(severity)) fail('Invalid severity');
        const rows = await visible(who, filters, path.endsWith('/alerts') ? 200 : limit);
        if (path.endsWith('/alerts')) { const all = buildAlerts(rows); return json(200, { summary: summarizeAlerts(all), alerts: all.filter(a => !severity || a.severity === severity).slice(0,limit), generated_at: new Date().toISOString() }); }
        const statuses = drainStatuses(rows);
        return json(200, { records: rows.map(({measurements,...row}) => ({...row, measurement_count:measurements.length, drain_status:statuses.get(row.record_id) ?? null})) });
      }
      const match = path.match(/^\/api\/v1\/records\/([0-9a-f-]+)(?:\/(measurements|finish))?$/i);
      if (match) {
        const [, id, action] = match; const row = await get(id);
        if (!action && request.method === 'GET') {
          await access(who, row.fixture_id); const raw = url.searchParams.get('sample'), sample = raw === null ? null : Number(raw);
          if (sample !== null && (!Number.isInteger(sample) || sample < 0)) fail('sample must be nonnegative integer');
          const siblings = row.record_type === 'drainage' ? await store.list({fixture_id:row.fixture_id,data_source:row.data_source,record_type:'drainage'},200) : [];
          return json(200, { record: row, computed: {...computedView(row,sample), drain_status:drainStatuses([...siblings.filter(r=>r.record_id!==id),row]).get(id) ?? null} });
        }
        if (action === 'measurements' && request.method === 'POST') {
          await access(who,row.fixture_id,false,true);
          if (who.deviceId && row.data_source !== 'sensor') throw new ApiError(403,'forbidden','Sensor keys cannot append simulation data');
          const points = validateMeasurements(await readBody(request)); const result = await mutate(id, previous => appendMeasurements(previous,points));
          return json(result.duplicate ? 200 : 201, {duplicate:result.duplicate,record_id:id,recording_status:result.record.recording_status,measurement_count:result.record.measurements.length,result:result.record.result,calibration:result.record.calibration});
        }
        if (action === 'finish' && request.method === 'POST') {
          await access(who,row.fixture_id,true);
          const result = await mutate(id, previous => previous.recording_status === 'finished' ? {record:previous} : {record:{...previous,recording_status:'finished',result:previous.record_type==='drainage' ? analyzeDrainage(previous.measurements,previous.calibration).result : null}});
          return json(200,{record:result.record,computed:computedView(result.record)});
        }
      }
      throw new ApiError(404,'not_found','Unsupported record route');
    } catch (error) { return json(error instanceof ApiError ? error.status : 500, {error:{code:error instanceof ApiError ? error.code : 'internal_error',message:error instanceof ApiError ? error.message : 'Cloud request failed'}}); }
  };
}
