import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { SupabaseRecordStore } from '../src/records-storage.js';
import { createApp } from '../src/server.js';
import { configFromEnv } from '../src/config.js';

function fixture() {
  const rows = []; let rejectWrites = false, unavailable = false;
  const fetcher = async (url, options = {}) => {
    assert.equal(options.cache, 'no-store'); assert.equal(options.headers.apikey, 'sb_secret_fixture');
    if (unavailable) throw Error('offline');
    const query = new URL(url), method = options.method || 'GET';
    if (query.pathname.endsWith('/rpc/update_drain_record')) {
      assert.equal(method, 'POST'); assert.ok(url.length < 200);
      if (rejectWrites) return new Response('{}', { status: 503 });
      const { p_record_id, p_expected, p_changes } = JSON.parse(options.body);
      const row = rows.find(r => r.record_id === p_record_id);
      if (!row || !Object.entries(p_expected).every(([key, value]) => isDeepStrictEqual(row[key], value))) return Response.json([]);
      Object.assign(row, structuredClone(p_changes)); return Response.json([row]);
    }
    assert.equal(query.pathname.split('/').at(-1), 'drain_records');
    if (method === 'POST') {
      if (rejectWrites) return new Response('{}', { status: 503 });
      const row = JSON.parse(options.body);
      if (rows.some(r => r.record_id === row.record_id || r.fixture_id === row.fixture_id && r.data_source === row.data_source && r.recording_status === 'recording')) return new Response('{}', { status: 409 });
      rows.push(structuredClone(row)); return Response.json([row], { status: 201 });
    }
    const selected = rows.filter(row => [...query.searchParams].every(([key, filter]) => filter.startsWith('eq.') ? row[key] === filter.slice(3) : filter === 'not.is.null' ? row[key] !== null : true)).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.record_id.localeCompare(a.record_id));
    // Simulate a hosted row cap smaller than the requested page size.
    const offset = Number(query.searchParams.get('offset') || 0), limit = Math.min(2, Number(query.searchParams.get('limit') || 100));
    const result = selected.slice(offset, offset + limit);
    return Response.json(result, { headers: { 'Content-Range': `${offset}-${offset + result.length - 1}/${selected.length}` } });
  };
  return { rows, fetcher, reject: () => { rejectWrites = true; }, offline: () => { unavailable = true; } };
}
test('Supabase adapter uses one table, paginates hosted row caps and keeps credentials in headers', async () => {
  const db = fixture(), store = new SupabaseRecordStore('https://example.supabase.co','sb_secret_fixture',db.fetcher);
  await store.ready();
  for (let i = 0; i < 5; i++) await store.insert({ record_id: randomUUID(), fixture_id: `sink-${i}`, record_type: 'monitoring', data_source: 'simulation', recording_status: 'finished', calibration: null, measurements: [], result: null, created_at: new Date(i * 1000).toISOString() });
  assert.equal((await store.list({}, 100)).length, 5);
  db.offline(); await assert.rejects(() => store.get(randomUUID()), e => e.status === 503 && !e.message.includes('sb_secret'));
});
test('real Supabase adapter/API prevent lost appends, see external writers and never acknowledge rejected writes', async t => {
  const db = fixture(), store = new SupabaseRecordStore('https://example.supabase.co','sb_secret_fixture',db.fetcher);
  const app = createApp({ ...configFromEnv({ STORAGE_BACKEND: 'sqlite', SQLITE_PATH: ':memory:' }), storage: 'supabase' }, store);
  await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve)); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const create = await fetch(base + '/records', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ fixture_id:'cloud-sink',data_source:'simulation',record_type:'monitoring' }) });
  const row = await create.json(); assert.equal(create.status,201);
  const points = Array.from({length:8},(_,i)=>({ reading_id:randomUUID(),timestamp:new Date(Date.now()-10000+i*500).toISOString(),sensor_a:{distance_mm:300,status:'ok'},sensor_b:{distance_mm:320,status:'ok'} }));
  const send = p => fetch(base + `/records/${row.record_id}/measurements`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});
  const accepted = await Promise.all(points.map(send)); assert.ok(accepted.every(r=>r.status===201));
  assert.equal((await store.get(row.record_id)).measurements.length,8);
  db.rows[0].measurements.push({...points[0],reading_id:randomUUID()});
  assert.equal((await (await fetch(base+`/records/${row.record_id}`)).json()).record.measurements.length,9);
  db.reject(); assert.equal((await send({...points[0],reading_id:randomUUID()})).status,503);
  assert.equal(db.rows[0].measurements.length,9);
});
