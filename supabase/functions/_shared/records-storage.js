import { ApiError } from './validation.js';
const filtersAllowed = new Set(['fixture_id', 'record_type', 'data_source', 'recording_status', 'calibration_present']);
const unavailable = () => new ApiError(503, 'storage_unavailable', 'Storage unavailable. Apply the drain_records SQL migration and check database access.');
const conflict = () => new ApiError(409, 'record_conflict', 'Record ID already exists or a recording is already active for this fixture and source.');
const normalize = row => row ? { ...row, created_at: new Date(row.created_at).toISOString() } : null;
const filterEntries = filters => Object.entries(filters).map(([key, value]) => { if (!filtersAllowed.has(key)) throw Error('Unsupported filter'); return [key, value]; });
export class SupabaseRecordStore {
  constructor(url, key, fetcher = fetch) { this.url = url; this.key = key; this.fetcher = fetcher; }
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
  async ready() { await this.request('drain_records?select=record_id&limit=1'); }
  async get(id) { return normalize((await this.request(`drain_records?record_id=eq.${encodeURIComponent(id)}&select=*&limit=1`))[0]); }
  async list(filters = {}, limit = 100) {
    const query = new URLSearchParams({ select: '*', order: 'created_at.desc,record_id.desc' });
    for (const [key, value] of filterEntries(filters)) query.set(key === 'calibration_present' ? 'calibration' : key, key === 'calibration_present' ? 'not.is.null' : `eq.${value}`);
    const result = [];
    while (result.length < limit) {
      query.set('offset', String(result.length)); query.set('limit', String(Math.min(200, limit - result.length)));
      const { rows, total } = await this.request(`drain_records?${query}`, { headers: { Prefer: 'return=representation,count=exact' } }, true);
      if (!rows.length && result.length < Math.min(total, limit)) throw unavailable();
      result.push(...rows.map(normalize)); if (result.length >= total || !rows.length) break;
    }
    return result;
  }
  async insert(record) {
    const rows = await this.request('drain_records', { method: 'POST', body: JSON.stringify(record) });
    if (rows.length !== 1 || rows[0].record_id !== record.record_id) throw unavailable();
    return normalize(rows[0]);
  }
  async compareAndSet(previous, next) {
    // Send the comparison in a POST body, not a URL that grows with the recording.
    const expected = { measurements: previous.measurements, calibration: previous.calibration, result: previous.result, recording_status: previous.recording_status };
    const changes = { calibration: next.calibration, measurements: next.measurements, result: next.result, recording_status: next.recording_status };
    const rows = await this.request('rpc/update_drain_record', { method: 'POST', body: JSON.stringify({ p_record_id: previous.record_id, p_expected: expected, p_changes: changes }) });
    if (rows.length > 1 || (rows.length && rows[0].record_id !== next.record_id)) throw unavailable();
    return rows.length === 1;
  }
  async close() {}
}
