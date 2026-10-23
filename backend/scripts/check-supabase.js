import { SupabaseStore } from '../src/storage.js';
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) { console.error('Set SUPABASE_URL and SUPABASE_SECRET_KEY in your local .env'); process.exitCode = 1; }
else {
  try {
    const store = new SupabaseStore(url, key);
    await store.ready();
    console.log('Supabase connectivity, server key and all four dm_* tables verified. No data was written. Run npm run verify:supabase to test a real write/read round trip.');
  } catch (error) { console.error(error.status === 503 ? error.message : 'Supabase check failed. Confirm migration, project URL/key and network access.'); process.exitCode = 1; }
}
