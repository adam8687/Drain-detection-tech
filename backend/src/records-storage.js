import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ApiError } from './validation.js';

const columns = ['record_id', 'fixture_id', 'record_type', 'data_source', 'recording_status', 'calibration', 'measurements', 'result', 'created_at'];
const filtersAllowed = new Set(['fixture_id', 'record_type', 'data_source', 'recording_status', 'calibration_present']);
const unavailable = () => new ApiError(503, 'storage_unavailable', 'Storage unavailable. Apply the drain_records SQL migration and check database access.');
const conflict = () => new ApiError(409, 'record_conflict', 'Record ID already exists or a recording is already active for this fixture and source.');
const normalize = row => row ? { ...row, created_at: new Date(row.created_at).toISOString() } : null;
const filterEntries = filters => Object.entries(filters).map(([key, value]) => { if (!filtersAllowed.has(key)) throw Error('Unsupported filter'); return [key, value]; });
function parse(row) { return row ? { ...row, calibration: JSON.parse(row.calibration), measurements: JSON.parse(row.measurements), result: JSON.parse(row.result) } : null; }
export class SQLiteRecordStore {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS drain_records (
        record_id TEXT PRIMARY KEY, fixture_id TEXT NOT NULL,
        record_type TEXT NOT NULL CHECK(record_type IN ('calibration','drainage','monitoring')),
        data_source TEXT NOT NULL CHECK(data_source IN ('sensor','simulation')),
        recording_status TEXT NOT NULL CHECK(recording_status IN ('recording','finished')),
        calibration TEXT NOT NULL, measurements TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS drain_record_history ON drain_records(fixture_id,data_source,created_at DESC,record_id DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS drain_one_active ON drain_records(fixture_id,data_source) WHERE recording_status='recording';`);
  }
  async ready() { this.db.prepare('SELECT record_id FROM drain_records LIMIT 1').all(); }
  async get(id) { return parse(this.db.prepare('SELECT * FROM drain_records WHERE record_id=?').get(id)); }
  async list(filters = {}, limit = 100) {
    const parts = filterEntries(filters);
    return this.db.prepare(`SELECT * FROM drain_records${parts.length ? ' WHERE ' + parts.map(([key]) => key === 'calibration_present' ? "calibration != 'null'" : `${key}=?`).join(' AND ') : ''} ORDER BY created_at DESC, record_id DESC LIMIT ?`).all(...parts.filter(([key]) => key !== 'calibration_present').map(([, value]) => value), limit).map(parse);
  }
  async insert(record) {
    try { this.db.prepare(`INSERT INTO drain_records (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(key => ['calibration', 'measurements', 'result'].includes(key) ? JSON.stringify(record[key]) : record[key])); }
    catch (error) { if (String(error.message).includes('UNIQUE constraint')) throw conflict(); throw unavailable(); }
    return record;
  }
  async compareAndSet(previous, next) {
    return this.db.prepare('UPDATE drain_records SET calibration=?,measurements=?,result=?,recording_status=? WHERE record_id=? AND measurements=? AND calibration=? AND result=? AND recording_status=?').run(JSON.stringify(next.calibration), JSON.stringify(next.measurements), JSON.stringify(next.result), next.recording_status, previous.record_id, JSON.stringify(previous.measurements), JSON.stringify(previous.calibration), JSON.stringify(previous.result), previous.recording_status).changes === 1;
  }
  async close() { this.db.close(); }
}
export class SupabaseRecordStore {
  constructor(url, key, fetcher = fetch) { this.url = url; this.key = key; this.fetcher = fetcher; }
  async request(path, options = {}, metadata = false, optional = false) {
    let response;
    try { response = await this.fetcher(`${this.url}/rest/v1/${path}`, { ...options, cache: 'no-store', signal: AbortSignal.timeout(10000), headers: { apikey: this.key, 'Content-Type': 'application/json', Prefer: 'return=representation', ...options.headers } }); }
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
export function createRecordStore(config) { return config.storage === 'supabase' ? new SupabaseRecordStore(config.supabaseUrl, config.supabaseKey) : new SQLiteRecordStore(config.sqlitePath); }
