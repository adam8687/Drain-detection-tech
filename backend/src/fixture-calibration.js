import { isDeepStrictEqual } from 'node:util';
import { ApiError } from './validation.js';

export function fixtureCalibrations(fixture) {
  const records = new Map(Object.entries(fixture?.calibration_history || {}));
  for (const value of Object.values(fixture?.calibration || {})) if (value?.id) records.set(value.id, value);
  return [...records.values()].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
}

export function attachCalibration(fixture, value, { migrating = false } = {}) {
  if (!fixture || fixture.device_id !== value.device_id) throw new ApiError(404, 'device_not_found', 'Register this fixture first');
  const records = fixtureCalibrations(fixture);
  const existing = records.find(cal => cal.id === value.id);
  if (existing) {
    if (migrating && isDeepStrictEqual(existing, value)) return fixture;
    throw new ApiError(409, 'conflict', 'This calibration version already exists');
  }
  records.push(value);
  records.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  const calibration = Object.fromEntries(['mock', 'hardware'].map(source => [source, records.find(cal => !cal.source || cal.source === source) ?? null]));
  const activeIds = new Set(Object.values(calibration).filter(Boolean).map(cal => cal.id));
  return { ...fixture, calibration, calibration_history: Object.fromEntries(records.filter(cal => !activeIds.has(cal.id)).map(cal => [cal.id, cal])) };
}
