import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateMeasurement } from '../../backend/src/records-domain.js';
import { object, uuid } from '../../backend/src/validation.js';

// Serial-only metadata never enters the database contract. Timestamp is the
// Mac's UTC acquisition-request time, before the board measures either sensor.
export function measurementFromReply(line, request) {
  if (line.length > 4096) throw Error('Oversized sensor reply');
  const reply = JSON.parse(line);
  object(reply, ['reading_id', 'sensor_a', 'sensor_b']);
  if (uuid(reply.reading_id, 'reading_id') !== request.reading_id) throw Error('Reply does not match the current acquisition request');
  return validateMeasurement({ ...reply, timestamp: request.timestamp });
}

export class Outbox {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS usb_outbox (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        reading_id TEXT UNIQUE NOT NULL, record_id TEXT NOT NULL,
        body TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0
      );`);
  }
  enqueue(recordId, point) {
    uuid(recordId, 'record_id');
    const body = JSON.stringify(validateMeasurement(point));
    const existing = this.db.prepare('SELECT * FROM usb_outbox WHERE reading_id=?').get(point.reading_id);
    if (existing) {
      if (existing.body !== body || existing.record_id !== recordId) throw Error('Conflicting reading ID in outbox');
      return;
    }
    this.db.prepare('INSERT INTO usb_outbox (reading_id,record_id,body) VALUES (?,?,?)').run(point.reading_id, recordId, body);
  }
  next() { return this.db.prepare('SELECT * FROM usb_outbox WHERE acknowledged=0 ORDER BY sequence LIMIT 1').get(); }
  acknowledge(id) { this.db.prepare('UPDATE usb_outbox SET acknowledged=1 WHERE reading_id=?').run(id); }
  count(recordId) { return this.db.prepare('SELECT count(*) AS n FROM usb_outbox WHERE record_id=?').get(recordId).n; }
  pending() { return this.db.prepare('SELECT count(*) AS n FROM usb_outbox WHERE acknowledged=0').get().n; }
  close() { this.db.close(); }
}

export async function uploadNext(outbox, { base, token = '', fetcher = fetch }) {
  const item = outbox.next();
  if (!item) return null;
  const response = await fetcher(`${base}/api/v1/records/${item.record_id}/measurements`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: item.body, signal: AbortSignal.timeout(15000),
  });
  const value = await response.json().catch(() => null);
  if (![200, 201].includes(response.status)) {
    const error = Error(`Upload failed (${response.status}): ${value?.error?.message || 'no acknowledgement'}`);
    error.retryable = response.status >= 500 || response.status === 429 || value?.error?.code === 'concurrent_update';
    throw error;
  }
  if (value?.record_id !== item.record_id || typeof value.duplicate !== 'boolean' || !['recording', 'finished'].includes(value.recording_status)) {
    throw Error('Invalid persistence acknowledgement; keeping the reading for retry');
  }
  outbox.acknowledge(item.reading_id);
  return { ...value, point: JSON.parse(item.body) };
}
