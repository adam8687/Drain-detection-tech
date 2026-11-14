import {createEmailTables,enqueueEmailEvents,saveEmailReferences} from './email-storage.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {convertTwoSensorRecord,publicSensorRecord} from '../../supabase/functions/_shared/single-sensor-migration.js';
import { ApiError } from './validation.js';
import { SupabaseRecordStore } from '../../supabase/functions/_shared/records-storage.js';
export { SupabaseRecordStore };

const columns = ['record_id', 'fixture_id', 'record_type', 'data_source', 'recording_status', 'calibration', 'measurements', 'result', 'created_at', 'schema_version'];
const filtersAllowed = new Set(['fixture_id', 'record_type', 'data_source', 'recording_status', 'calibration_present','schema_version']);
const unavailable = () => new ApiError(503, 'storage_unavailable', 'Storage unavailable. Apply the drain_records SQL migration and check database access.');
const conflict = () => new ApiError(409, 'record_conflict', 'Record ID already exists or a recording is already active for this fixture and source.');
const normalize = row => row ? { ...row, created_at: new Date(row.created_at).toISOString() } : null;
const filterEntries = filters => Object.entries(filters).map(([key, value]) => { if (!filtersAllowed.has(key)) throw Error('Unsupported filter'); return [key, value]; });
function parse(row) { return row ? publicSensorRecord({ ...row, calibration: JSON.parse(row.calibration), measurements: JSON.parse(row.measurements), result: JSON.parse(row.result) }) : null; }
export class SQLiteRecordStore {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS drain_records (
        record_id TEXT PRIMARY KEY, fixture_id TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 2 CHECK(schema_version IN(1,2)),
        record_type TEXT NOT NULL CHECK(record_type IN ('calibration','drainage','monitoring')),
        data_source TEXT NOT NULL CHECK(data_source IN ('sensor','simulation')),
        recording_status TEXT NOT NULL CHECK(recording_status IN ('recording','finished')),
        calibration TEXT NOT NULL, measurements TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS drain_record_history ON drain_records(fixture_id,data_source,created_at DESC,record_id DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS drain_one_active ON drain_records(fixture_id,data_source) WHERE recording_status='recording';`);
    this.migrateSingleSensor();createEmailTables(this.db);
  }
  migrateSingleSensor() {
    if(this.db.prepare('PRAGMA table_info(drain_records)').all().some(c=>c.name==='schema_version'))return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('ALTER TABLE drain_records ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1');
      this.db.exec('CREATE TABLE IF NOT EXISTS drain_records_two_sensor_backup (record_id TEXT PRIMARY KEY,original_record TEXT NOT NULL,saved_at TEXT NOT NULL)');
      for(const raw of this.db.prepare('SELECT * FROM drain_records').all()){
        const original={...raw,calibration:JSON.parse(raw.calibration),measurements:JSON.parse(raw.measurements),result:JSON.parse(raw.result)};
        this.db.prepare('INSERT OR IGNORE INTO drain_records_two_sensor_backup VALUES(?,?,?)').run(raw.record_id,JSON.stringify(original),new Date().toISOString());
        const converted=convertTwoSensorRecord(original);
        this.db.prepare('UPDATE drain_records SET calibration=?,measurements=?,result=?,recording_status=?,schema_version=1 WHERE record_id=?').run(JSON.stringify(converted.calibration),JSON.stringify(converted.measurements),JSON.stringify(converted.result),converted.recording_status,raw.record_id);
      }
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  async ready() { this.db.prepare('SELECT record_id FROM drain_records LIMIT 1').all(); }
  async get(id) { return parse(this.db.prepare('SELECT * FROM drain_records WHERE record_id=?').get(id)); }
  async list(filters = {}, limit = 100, direction = 'desc', offset = 0) {
    const order = direction === 'asc' ? 'ASC' : 'DESC';
    const parts = filterEntries(filters);
    return this.db.prepare(`SELECT * FROM drain_records${parts.length ? ' WHERE ' + parts.map(([key]) => key === 'calibration_present' ? "calibration != 'null'" : `${key}=?`).join(' AND ') : ''} ORDER BY created_at ${order}, record_id ${order} LIMIT ? OFFSET ?`).all(...parts.filter(([key]) => key !== 'calibration_present').map(([, value]) => value), limit, offset).map(parse);
  }
  async insert(record) {
    try { this.db.prepare(`INSERT INTO drain_records (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(key => ['calibration', 'measurements', 'result'].includes(key) ? JSON.stringify(record[key]) : key==='schema_version'?(record.schema_version??2):record[key])); }
    catch (error) { if (String(error.message).includes('UNIQUE constraint')) throw conflict(); throw unavailable(); }
    return record;
  }
  async compareAndSet(previous, next, notificationEvents=[],notificationReferences=[]) {
    this.db.exec('BEGIN IMMEDIATE');try{const changed=this.db.prepare('UPDATE drain_records SET calibration=?,measurements=?,result=?,recording_status=? WHERE record_id=? AND measurements=? AND calibration=? AND result=? AND recording_status=?').run(JSON.stringify(next.calibration), JSON.stringify(next.measurements), JSON.stringify(next.result), next.recording_status, previous.record_id, JSON.stringify(previous.measurements), JSON.stringify(previous.calibration), JSON.stringify(previous.result), previous.recording_status).changes === 1;
    if(changed){saveEmailReferences(this.db,notificationReferences);enqueueEmailEvents(this.db,notificationEvents);}this.db.exec('COMMIT');return changed;}catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  async close() { this.db.close(); }
}
export function createRecordStore(config) { return config.storage === 'supabase' ? new SupabaseRecordStore(config.supabaseUrl, config.supabaseKey) : new SQLiteRecordStore(config.sqlitePath); }
