import {createEmailTables,enqueueEmailEvents,saveEmailReferences} from './email-storage.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {convertTwoSensorRecord,publicSensorRecord} from '../../supabase/functions/_shared/single-sensor-migration.js';
import { ApiError } from './validation.js';
import { SupabaseRecordStore } from '../../supabase/functions/_shared/records-storage.js';
import { SETTINGS, MAX_BATCH } from './records-domain.js';
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
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = new Set(this.db.prepare('PRAGMA table_info(drain_records)').all().map(c => c.name));
      for (const column of ['continued_from','continued_in','rollover_root','last_reading_at']) {
        if (!existing.has(column)) this.db.exec(`ALTER TABLE drain_records ADD COLUMN ${column} TEXT`);
      }
      if (!existing.has('last_reading_at')) {
        this.db.exec("UPDATE drain_records SET last_reading_at=json_extract(measurements,'$[#-1].timestamp') WHERE recording_status='recording'");
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.db.exec(`CREATE TABLE IF NOT EXISTS drain_events (event_id TEXT PRIMARY KEY,fixture_id TEXT NOT NULL,
      data_source TEXT NOT NULL,record_id TEXT NOT NULL,started_at TEXT NOT NULL,seconds REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS drain_events_history ON drain_events(fixture_id,data_source,started_at DESC,event_id DESC);
      CREATE TABLE IF NOT EXISTS drain_record_health (record_id TEXT PRIMARY KEY, summary TEXT NOT NULL);`);
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
    try { this.db.prepare(`INSERT INTO drain_records (${columns.join(',')},rollover_root,last_reading_at) VALUES (${columns.map(() => '?').join(',')},?,?)`).run(...columns.map(key => ['calibration', 'measurements', 'result'].includes(key) ? JSON.stringify(record[key]) : key==='schema_version'?(record.schema_version??2):record[key]),record.record_type==='monitoring'?record.record_id:null,record.measurements.at(-1)?.timestamp??null); }
    catch (error) { if (String(error.message).includes('UNIQUE constraint')) throw conflict(); throw unavailable(); }
    return record;
  }
  async rollMonitoringRecord(id, nextId, incoming, createdAt) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = parse(this.db.prepare('SELECT * FROM drain_records WHERE record_id=?').get(id));
      let next = null;
      if (previous?.continued_in) next = parse(this.db.prepare('SELECT * FROM drain_records WHERE record_id=?').get(previous.continued_in));
      else if (previous?.record_type === 'monitoring' && previous.schema_version !== 1 && previous.recording_status === 'recording' && incoming>=1 && incoming<=MAX_BATCH && previous.measurements.length + incoming > SETTINGS.maxMeasurements) {
        this.db.prepare("UPDATE drain_records SET recording_status='finished', continued_in=? WHERE record_id=?").run(nextId,id);
        this.db.prepare(`INSERT INTO drain_records(record_id,fixture_id,record_type,data_source,recording_status,calibration,measurements,result,created_at,continued_from,rollover_root)
          VALUES(?,?,'monitoring',?,'recording',?,'[]','null',?,?,?)`).run(nextId,previous.fixture_id,previous.data_source,JSON.stringify(previous.calibration),createdAt,id,previous.rollover_root??id);
        next = parse(this.db.prepare('SELECT * FROM drain_records WHERE record_id=?').get(nextId));
      }
      this.db.exec('COMMIT');
      return next;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async saveDrainEvents(events) {
    const insert = this.db.prepare('INSERT OR IGNORE INTO drain_events VALUES(?,?,?,?,?,?)');
    for (const e of events) insert.run(e.event_id,e.fixture_id,e.data_source,e.record_id,e.started_at,e.seconds);
  }
  async drainHistory(fixture, source, since, points) {
    return this.db.prepare(`WITH ev AS (
        SELECT started_at, seconds, unixepoch(started_at,'subsec') epoch FROM drain_events
        WHERE fixture_id=? AND data_source=? AND started_at>=?
      ), bounds AS (SELECT count(*) n,min(epoch) lo,max(epoch) hi FROM ev)
      SELECT started_at t,seconds avg_seconds,seconds min_seconds,seconds max_seconds,1 n FROM ev,bounds WHERE bounds.n<=?
      UNION ALL
      SELECT min(started_at),avg(seconds),min(seconds),max(seconds),count(*) FROM ev,bounds WHERE bounds.n>?
      GROUP BY min(?-1,CAST((epoch-lo)/max(hi-lo,1)*? AS INTEGER)) ORDER BY t`).all(fixture,source,since,points,points,points,points);
  }
  async saveFleetHealth(record, health) {
    return this.db.prepare(`INSERT INTO drain_record_health(record_id,summary)
      SELECT record_id,? FROM drain_records WHERE record_id=? AND recording_status=? AND measurements=? AND calibration=?
      ON CONFLICT(record_id) DO UPDATE SET summary=excluded.summary`).run(JSON.stringify(health),record.record_id,
        record.recording_status,JSON.stringify(record.measurements),JSON.stringify(record.calibration)).changes>0;
  }
  async fleetSummaries(devices, source) {
    if (!devices.length) return [];
    return this.db.prepare(`WITH units AS (SELECT json_extract(value,'$.device_id') device_id,json_extract(value,'$.name') name FROM json_each(?))
      SELECT u.device_id,u.name,CASE WHEN r.record_id IS NOT NULL THEN json_object('record_id',r.record_id,
        'record_type',r.record_type,'recording_status',r.recording_status,'created_at',r.created_at,'schema_version',r.schema_version) END record,
      EXISTS(SELECT 1 FROM drain_records c WHERE c.fixture_id=u.device_id AND c.data_source=? AND c.schema_version=2 AND c.calibration!='null') empty_ready,
      (SELECT json_group_array(json_object('seconds',q.seconds,'started_at',q.started_at,'record_id',q.record_id)) FROM
        (SELECT seconds,started_at,record_id FROM drain_events WHERE fixture_id=u.device_id AND data_source=? ORDER BY started_at DESC,event_id DESC LIMIT 12) q) recent_drains,
      h.summary health, CASE WHEN r.recording_status='recording' THEN r.last_reading_at END last_reading_at
      FROM units u LEFT JOIN drain_records r ON r.record_id=coalesce(
        (SELECT record_id FROM drain_records WHERE fixture_id=u.device_id AND data_source=? AND recording_status='recording'),
        (SELECT record_id FROM drain_records WHERE fixture_id=u.device_id AND data_source=? ORDER BY created_at DESC,record_id DESC LIMIT 1))
      LEFT JOIN drain_record_health h ON h.record_id=r.record_id ORDER BY u.device_id`).all(JSON.stringify(devices),source,source,source,source)
      .map(row=>({...row,record:JSON.parse(row.record),recent_drains:JSON.parse(row.recent_drains),health:JSON.parse(row.health),empty_ready:Boolean(row.empty_ready)}));
  }
  async fleetSimulations(after, search, limit) {
    return this.db.prepare(`SELECT DISTINCT fixture_id device_id,fixture_id name FROM drain_records
      WHERE data_source='simulation' AND fixture_id>? AND instr(lower(fixture_id),lower(?))>0
      ORDER BY fixture_id LIMIT ?`).all(after,search,limit);
  }
  async compareAndSet(previous, next, notificationEvents=[],notificationReferences=[]) {
    this.db.exec('BEGIN IMMEDIATE');try{const changed=this.db.prepare('UPDATE drain_records SET calibration=?,measurements=?,result=?,recording_status=?,last_reading_at=? WHERE record_id=? AND measurements=? AND calibration=? AND result=? AND recording_status=?').run(JSON.stringify(next.calibration), JSON.stringify(next.measurements), JSON.stringify(next.result), next.recording_status, next.measurements.at(-1)?.timestamp??null, previous.record_id, JSON.stringify(previous.measurements), JSON.stringify(previous.calibration), JSON.stringify(previous.result), previous.recording_status).changes === 1;
    if(changed){saveEmailReferences(this.db,notificationReferences);enqueueEmailEvents(this.db,notificationEvents);}this.db.exec('COMMIT');return changed;}catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  async close() { this.db.close(); }
}
export function createRecordStore(config) { return config.storage === 'supabase' ? new SupabaseRecordStore(config.supabaseUrl, config.supabaseKey) : new SQLiteRecordStore(config.sqlitePath); }
