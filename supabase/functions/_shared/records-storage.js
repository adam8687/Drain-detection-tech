import {publicSensorRecord} from './single-sensor-migration.js';
import { ApiError } from './validation.js';
import { INGEST, ordered } from './records-domain.js';
const filtersAllowed = new Set(['fixture_id', 'record_type', 'data_source', 'recording_status', 'calibration_present','schema_version']);
const unavailable = () => new ApiError(503, 'storage_unavailable', 'Storage unavailable. Apply the single-sensor SQL migration (202611120001_single_sensor.sql) and check database access.');
const conflict = () => new ApiError(409, 'record_conflict', 'Record ID already exists or a recording is already active for this fixture and source.');
const normalize = row => row ? publicSensorRecord({ ...row, created_at: new Date(row.created_at).toISOString() }) : null;
const filterEntries = filters => Object.entries(filters).map(([key, value]) => { if (!filtersAllowed.has(key)) throw Error('Unsupported filter'); return [key, value]; });
export class SupabaseRecordStore {
  constructor(url, key, fetcher = fetch) { this.url = url; this.key = key; this.fetcher = fetcher; this.cache = new Map(); this.cacheBytes = 0; this.deltaOffUntil = 0; }
  async request(path, options = {}, metadata = false, optional = false) {
    let response;
    try { response = await this.fetcher(`${this.url}/rest/v1/${path}`, { ...options, cache: 'no-store', signal: AbortSignal.timeout(10000), headers: { apikey: this.key, ...(this.key.startsWith('eyJ') ? { Authorization: `Bearer ${this.key}` } : {}), 'Content-Type': 'application/json', Prefer: 'return=representation', ...options.headers } }); }
    catch { throw new ApiError(503, 'supabase_unreachable', 'Cannot reach Supabase; no local fallback is used.'); }
    if (optional && response.status === 404) return metadata ? { rows: [], total: 0 } : [];
    if (response.status === 409) throw conflict();
    if (!response.ok) throw unavailable();
    try {
      const rows = await response.json();
      if (!Array.isArray(rows)) throw Error('Invalid response');
      if (!metadata) return rows;
      const range = response.headers.get('content-range'), total = Number(range?.split('/')[1]);
      if (!range || !Number.isFinite(total)) throw Error('Missing row count');
      return { rows, total };
    } catch { throw unavailable(); }
  }
  async ready() { await this.request('drain_records?select=record_id,schema_version,revision&limit=1'); }
  // Revisions are checked against the database on every read: external writers stay
  // visible, while unchanged histories never cross the database network again.
  remember(raw) {
    const old = this.cache.get(raw.record_id);
    if (old && Number(old.revision) > Number(raw.revision)) return normalize(raw);
    if (old) { this.cacheBytes -= old.bytes; this.cache.delete(raw.record_id); }
    const row = normalize(raw), bytes = JSON.stringify(raw).length * 2;
    if (bytes <= 16 * 1024 * 1024) {
      this.cache.set(raw.record_id, {revision:raw.revision,row,bytes}); this.cacheBytes += bytes;
      while (this.cacheBytes > 16 * 1024 * 1024 || this.cache.size > 128) {
        const key = this.cache.keys().next().value; this.cacheBytes -= this.cache.get(key).bytes; this.cache.delete(key);
      }
    }
    return structuredClone(row);
  }
  keep(recordId, revision, row) {
    const old = this.cache.get(recordId);
    if (old) { this.cacheBytes -= old.bytes; this.cache.delete(recordId); }
    const bytes = JSON.stringify(row).length * 2;
    if (bytes <= 16 * 1024 * 1024) {
      this.cache.set(recordId, { revision, row, bytes }); this.cacheBytes += bytes;
      while (this.cacheBytes > 16 * 1024 * 1024 || this.cache.size > 128) { const key = this.cache.keys().next().value; this.cacheBytes -= this.cache.get(key).bytes; this.cache.delete(key); }
    }
  }
  // Fetch only readings newer than the cached copy. The merged result must match the database's own reading count;
  // anything else (older readings arriving late, a trimmed window, a missing function) takes the full read instead.
  async delta(header, cached) {
    const last = cached.row.measurements.at(-1)?.timestamp;
    if (!last || Number(cached.revision) > Number(header.revision) || Date.now() < this.deltaOffUntil) return null;
    let rows;
    try { rows = await this.request('rpc/drain_record_delta', { method: 'POST', body: JSON.stringify({ p_record_id: header.record_id, p_after: last }) }); }
    catch { this.deltaOffUntil = Date.now() + 300000; return null; }
    const d = rows[0];
    if (!d || !Array.isArray(d.tail)) return null;
    const known = new Map(cached.row.measurements.map(p => [p.reading_id, p]));
    for (const p of d.tail) known.set(p.reading_id, p);
    let merged = ordered([...known.values()]);
    if (cached.row.record_type === 'monitoring' && merged.length > INGEST.monitoringWindow) merged = merged.slice(-INGEST.monitoringWindow);
    if (merged.length !== d.total) return null;
    const row = { ...cached.row, calibration: d.calibration, result: d.result, recording_status: d.recording_status, measurements: merged };
    this.keep(header.record_id, d.revision, row);
    return structuredClone(row);
  }
  async hydrate(header) {
    const cached = this.cache.get(header.record_id);
    if (cached && header.revision !== undefined && String(cached.revision) === String(header.revision)) return structuredClone(cached.row);
    if (cached && header.revision !== undefined) { const fresh = await this.delta(header, cached); if (fresh) return fresh; }
    const raw = (await this.request(`drain_records?record_id=eq.${encodeURIComponent(header.record_id)}&select=*&limit=1`))[0];
    return raw ? this.remember(raw) : null;
  }
  async get(id) {
    const header = (await this.request(`drain_records?record_id=eq.${encodeURIComponent(id)}&select=record_id,revision&limit=1`))[0];
    return header ? this.hydrate(header) : null;
  }
  async headers(filters = {}, limit = 100, direction = 'desc', offset = 0) {
    const query = new URLSearchParams({ select: 'record_id,fixture_id,record_type,revision', order: direction === 'asc' ? 'created_at.asc,record_id.asc' : 'created_at.desc,record_id.desc' });
    for (const [key, value] of filterEntries(filters)) query.set(key === 'calibration_present' ? 'calibration' : key, key === 'calibration_present' ? 'not.is.null' : `eq.${value}`);
    const result = [];
    while (result.length < limit) {
      query.set('offset', String(offset + result.length)); query.set('limit', String(Math.min(200, limit - result.length)));
      const { rows, total } = await this.request(`drain_records?${query}`, { headers: { Prefer: 'return=representation,count=exact' } }, true);
      if (!rows.length && result.length < Math.min(total - offset, limit)) throw unavailable();
      result.push(...rows); if (offset + result.length >= total || !rows.length) break;
    }
    return result;
  }
  async list(filters = {}, limit = 100, direction = 'desc', offset = 0) {
    const headers = await this.headers(filters, limit, direction, offset);
    const rows = [];
    for (const header of headers) { const row = await this.hydrate(header); if (row) rows.push(row); }
    return rows;
  }
  async insert(record) {
    const rows = await this.request('drain_records', { method: 'POST', body: JSON.stringify({schema_version:2,...record}) });
    if (rows.length !== 1 || rows[0].record_id !== record.record_id) throw unavailable();
    return this.remember(rows[0]);
  }
  async compareAndSet(previous, next, notificationEvents=[],notificationReferences=[]) {
    // Send the comparison in a POST body, not a URL that grows with the recording.
    const expected = { measurements: previous.measurements, calibration: previous.calibration, result: previous.result, recording_status: previous.recording_status };
    const changes = { calibration: next.calibration, measurements: next.measurements, result: next.result, recording_status: next.recording_status, ...(notificationEvents.length?{notification_events:notificationEvents}:{}),...(notificationReferences.length?{notification_references:notificationReferences}:{}) };
    const rows = await this.request('rpc/update_drain_record_compact', { method: 'POST', body: JSON.stringify({ p_record_id: previous.record_id, p_expected: expected, p_changes: changes }) });
    if (rows.length > 1 || (rows.length && rows[0].record_id !== next.record_id)) throw unavailable();
    if (rows.length === 1) this.remember({...next,revision:rows[0].revision});
    else { const old = this.cache.get(previous.record_id); if (old) {this.cacheBytes -= old.bytes; this.cache.delete(previous.record_id);} }
    return rows.length === 1;
  }
  async close() { this.cache.clear(); this.cacheBytes=0; }
}
