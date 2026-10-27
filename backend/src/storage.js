import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ApiError } from './validation.js';
import { attachCalibration, fixtureCalibrations } from './fixture-calibration.js';

const tables = {
  devices: { key: 'device_id', columns: ['device_id', 'created_at'] },
  readings: { key: 'event_id', columns: ['event_id', 'device_id', 'boot_id', 'sequence', 'source', 'measured_at', 'received_at'] },
  sessions: { key: 'id', columns: ['id', 'device_id', 'source', 'status', 'started_at'] },
  device_members: { key: 'id', columns: ['id', 'device_id', 'user_id', 'role', 'created_at'] },
  device_keys: { key: 'key_hash', columns: ['key_hash', 'device_id', 'created_at'] },
};
const allowedColumns = new Set(Object.values(tables).flatMap(t => t.columns));
function definition(table) {
  if (!tables[table]) throw Error('Unknown storage table');
  return tables[table];
}
function filterParts(filters) {
  return Object.entries(filters).map(([column, value]) => {
    if (!allowedColumns.has(column)) throw Error('Unknown storage filter');
    return [column, value];
  });
}
function storageError() { return new ApiError(503, 'storage_unavailable', 'Storage unavailable. Check server configuration, connectivity and database migration.'); }
function conflict() { return new ApiError(409, 'conflict', 'Record already exists, sequence was reused, or a session is already active'); }

class FixtureCalibrationStore {
  async listCalibrations(deviceId) { return fixtureCalibrations(await this.get('devices', deviceId)); }
  async getCalibration(deviceId, id) { return (await this.listCalibrations(deviceId)).find(cal => cal.id === id) ?? null; }
  async saveCalibration(value, options = {}) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const previous = await this.get('devices', value.device_id);
      const next = attachCalibration(previous, value, options);
      if (next === previous || await this.compareAndSetDevice(previous, next)) return value;
    }
    throw new ApiError(409, 'fixture_changed', 'Fixture changed concurrently; retry calibration');
  }
}

export class SQLiteStore extends FixtureCalibrationStore {
  constructor(path) {
    super();
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS dm_devices (device_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dm_readings (event_id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES dm_devices(device_id), boot_id TEXT NOT NULL, sequence INTEGER NOT NULL, source TEXT NOT NULL, measured_at TEXT NOT NULL, received_at TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(device_id, boot_id, sequence));
      CREATE INDEX IF NOT EXISTS dm_readings_device_time ON dm_readings(device_id, source, measured_at DESC);
      CREATE TABLE IF NOT EXISTS dm_sessions (id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES dm_devices(device_id), source TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS dm_one_active_session ON dm_sessions(device_id, source) WHERE status='active';
      CREATE TABLE IF NOT EXISTS dm_device_members (id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES dm_devices(device_id), user_id TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(device_id, user_id));
      CREATE INDEX IF NOT EXISTS dm_device_members_user ON dm_device_members(user_id);
      CREATE TABLE IF NOT EXISTS dm_device_keys (key_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES dm_devices(device_id), created_at TEXT NOT NULL, payload TEXT NOT NULL);
    `);
    this.migrateLegacyCalibrations();
  }
  migrateLegacyCalibrations() {
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dm_calibrations'").get()) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare('SELECT payload FROM dm_calibrations').all();
      for (const row of rows) {
        const cal = JSON.parse(row.payload);
        const previous = this.db.prepare('SELECT payload FROM dm_devices WHERE device_id = ?').get(cal.device_id);
        const fixture = previous ? JSON.parse(previous.payload) : null;
        const next = attachCalibration(fixture, cal, { migrating: true });
        this.db.prepare('UPDATE dm_devices SET payload = ? WHERE device_id = ?').run(JSON.stringify(next), cal.device_id);
      }
      this.db.exec('DROP TABLE dm_calibrations; COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async compareAndSetDevice(previous, next) {
    return this.db.prepare('UPDATE dm_devices SET payload = ? WHERE device_id = ? AND payload = ?')
      .run(JSON.stringify(next), previous.device_id, JSON.stringify(previous)).changes === 1;
  }
  async ready() { this.db.prepare('SELECT 1 FROM dm_devices LIMIT 1').all(); }
  async get(table, id) {
    const row = this.db.prepare(`SELECT payload FROM dm_${table} WHERE ${definition(table).key} = ?`).get(id);
    return row ? JSON.parse(row.payload) : null;
  }
  async list(table, filters = {}, limit = 100, order = 'created_at', range = {}) {
    definition(table);
    if (!allowedColumns.has(order)) throw Error('Unknown sort');
    const parts = filterParts(filters), conditions = parts.map(([k]) => `${k} = ?`), params = parts.map(([, v]) => v);
    for (const [op, value] of Object.entries(range)) {
      if (!['gte', 'lte'].includes(op)) throw Error('Unknown range');
      conditions.push(`measured_at ${op === 'gte' ? '>=' : '<='} ?`); params.push(value);
    }
    return this.db.prepare(`SELECT payload FROM dm_${table}${conditions.length ? ' WHERE ' + conditions.join(' AND ') : ''} ORDER BY ${order} DESC, ${tables[table].key} DESC LIMIT ?`)
      .all(...params, limit).map(r => JSON.parse(r.payload));
  }
  async insert(table, payload) {
    const { columns } = definition(table);
    try {
      this.db.prepare(`INSERT INTO dm_${table} (${[...columns, 'payload'].join(',')}) VALUES (${[...columns, 'payload'].map(() => '?').join(',')})`).run(...columns.map(c => payload[c]), JSON.stringify(payload));
    } catch (error) {
      if (String(error.message).includes('UNIQUE constraint')) throw conflict();
      throw storageError();
    }
    return payload;
  }
  async updateSession(payload) {
    this.db.prepare('UPDATE dm_sessions SET status = ?, payload = ? WHERE id = ?').run(payload.status, JSON.stringify(payload), payload.id);
    return payload;
  }
  async close() { this.db.close(); }
}

export class SupabaseStore extends FixtureCalibrationStore {
  constructor(url, key, fetcher = fetch) { super(); this.url = url; this.key = key; this.fetcher = fetcher; }
  async request(path, options = {}, withMetadata = false) {
    let response;
    try {
      response = await this.fetcher(`${this.url}/rest/v1/${path}`, {
        ...options, cache: 'no-store', signal: AbortSignal.timeout(8000),
        headers: { apikey: this.key, 'Content-Type': 'application/json', Prefer: 'return=representation', ...options.headers },
      });
    } catch { throw new ApiError(503, 'supabase_unreachable', 'Cannot reach Supabase. Check network access and SUPABASE_URL. No local fallback is used.'); }
    if (response.status === 409) throw conflict();
    if (response.status === 401 || response.status === 403) throw new ApiError(503, 'supabase_access_denied', `Supabase request denied (HTTP ${response.status}). Check the server key, table permissions and network policy.`);
    if (!response.ok) throw storageError();
    try {
      const rows = await response.json();
      return withMetadata ? { rows, range: response.headers.get('content-range') } : rows;
    } catch { throw storageError(); }
  }
  async compareAndSetDevice(previous, next) {
    const query = new URLSearchParams({ device_id: `eq.${previous.device_id}`, payload: `eq.${JSON.stringify(previous)}` });
    const rows = await this.request(`dm_devices?${query}`, { method: 'PATCH', body: JSON.stringify({ payload: next }) });
    if (rows.length > 1 || (rows.length === 1 && rows[0]?.payload?.device_id !== next.device_id)) throw storageError();
    return rows.length === 1;
  }
  async ready() {
    await Promise.all(Object.entries(tables).map(([table, spec]) => this.request(`dm_${table}?select=${spec.key}&limit=1`)));
  }
  async get(table, id) {
    const rows = await this.request(`dm_${table}?${definition(table).key}=eq.${encodeURIComponent(id)}&select=payload&limit=1`);
    return rows[0]?.payload ?? null;
  }
  async list(table, filters = {}, limit = 100, order = 'created_at', range = {}) {
    definition(table);
    if (!allowedColumns.has(order)) throw Error('Unknown sort');
    const query = new URLSearchParams({ select: 'payload', order: `${order}.desc,${tables[table].key}.desc` });
    for (const [key, value] of filterParts(filters)) query.set(key, `eq.${value}`);
    for (const [op, value] of Object.entries(range)) {
      if (!['gte', 'lte'].includes(op)) throw Error('Unknown range');
      query.append('measured_at', `${op}.${value}`);
    }
    const result = [];
    // Supabase may cap rows per request. Read the advertised total and paginate,
    // rather than treating a truncated session as a complete drainage record.
    while (result.length < limit) {
      query.set('offset', String(result.length)); query.set('limit', String(Math.min(200, limit - result.length)));
      const { rows, range } = await this.request(`dm_${table}?${query}`, { headers: { Prefer: 'return=representation,count=exact' } }, true);
      const total = Number(range?.split('/')[1]);
      if (!range || !Number.isFinite(total)) throw storageError();
      if (!rows.length && result.length < Math.min(total, limit)) throw storageError();
      result.push(...rows.map(r => r.payload));
      if (result.length >= total || !rows.length) break;
    }
    return result;
  }
  async insert(table, payload) {
    const row = Object.fromEntries(definition(table).columns.map(c => [c, payload[c]]));
    const rows = await this.request(`dm_${table}`, { method: 'POST', body: JSON.stringify({ ...row, payload }) });
    if (rows.length !== 1 || rows[0]?.payload?.[definition(table).key] !== payload[definition(table).key]) throw storageError();
    return rows[0].payload;
  }
  async updateSession(payload) {
    const rows = await this.request(`dm_sessions?id=eq.${encodeURIComponent(payload.id)}`, { method: 'PATCH', body: JSON.stringify({ status: payload.status, payload }) });
    if (rows.length !== 1 || rows[0]?.payload?.id !== payload.id) throw storageError();
    return rows[0].payload;
  }
  async close() {}
}

export function createStore(config) {
  if (config.storage === 'supabase') return new SupabaseStore(config.supabaseUrl, config.supabaseKey);
  if (config.storage === 'sqlite') return new SQLiteStore(config.sqlitePath);
  throw Error('Unknown storage backend');
}
