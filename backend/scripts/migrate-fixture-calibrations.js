// Non-destructive bridge for existing Supabase projects. The SQL migration can
// subsequently remove the redundant legacy table after another verified copy.
import assert from 'node:assert/strict';
import { configFromEnv } from '../src/config.js';
import { createStore } from '../src/storage.js';

let store;
try {
  const config = configFromEnv({ ...process.env, STORAGE_BACKEND: 'supabase' });
  store = createStore(config);
  await store.ready();
  const legacy = [];
  for (let offset = 0; ; offset = legacy.length) {
    const { rows, range } = await store.request(`dm_calibrations?select=payload&order=id.asc&offset=${offset}&limit=200`, { headers: { Prefer: 'return=representation,count=exact' } }, true);
    const total = Number(range?.split('/')[1]);
    if (!range || !Number.isFinite(total) || (!rows.length && legacy.length < total)) throw Error('Incomplete calibration export');
    legacy.push(...rows.map(row => row.payload));
    if (legacy.length >= total) break;
  }
  for (const calibration of legacy) await store.saveCalibration(calibration, { migrating: true });
  const observer = createStore(config);
  try {
    for (const calibration of legacy) assert.deepEqual(await observer.getCalibration(calibration.device_id, calibration.id), calibration);
  } finally { await observer.close(); }
  console.log(`PASS: ${legacy.length} calibration versions copied into fixture records and verified through a separate Supabase adapter. Existing readings and sessions are unchanged.`);
  console.log('The legacy table is retained. Apply supabase/migrations/202610260001_fixture_calibrations.sql in the Supabase SQL Editor to verify the copy again and remove that table. Stop older backends before applying it.');
} catch (error) {
  console.error(error.status === 503 ? error.message : 'Migration could not be verified. The legacy table was not deleted. Fix configuration or conflicting calibration versions, then retry.');
  process.exitCode = 1;
} finally { if (store) await store.close(); }
