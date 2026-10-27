import { configFromEnv } from '../src/config.js';
import { createRecordStore } from '../src/records-storage.js';
let store;
try { store = createRecordStore(configFromEnv({ ...process.env, STORAGE_BACKEND: 'supabase' })); await store.ready(); console.log('PASS: Supabase drain_records is reachable. No data written.'); }
catch (error) { console.error(error.status === 503 ? error.message : 'Check backend/.env and apply the drain_records SQL migration.'); process.exitCode = 1; }
finally { if (store) await store.close(); }
