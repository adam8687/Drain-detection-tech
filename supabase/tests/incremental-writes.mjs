import {pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const {PGlite}=await import(process.env.PGLITE_MODULE_PATH?pathToFileURL(process.env.PGLITE_MODULE_PATH).href:'@electric-sql/pglite');
const db=new PGlite();
try {
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);');
  const migrate=async name=>db.exec(await readFile(new URL(`../migrations/${name}.sql`,import.meta.url),'utf8'));
  for(const name of ['202610270001_drain_records','202611120001_single_sensor','202610270002_records_access','202611120002_email_notifications'])await migrate(name);
  const id=randomUUID(),owner=randomUUID(),empty={empty_distance_mm:300};
  await db.query('insert into auth.users values($1)',[owner]);
  await db.query(`insert into dm_devices values('sink',now(),'{}')`);
  await db.query(`insert into dm_device_members(id,device_id,user_id,role,created_at,payload)values(gen_random_uuid(),'sink',$1,'owner',now(),'{}')`,[owner]);
  await db.query(`insert into drain_email_preferences(fixture_id,user_id,enabled)values('sink',$1,true)`,[owner]);
  const point=i=>({reading_id:randomUUID(),timestamp:new Date(Date.parse('2026-11-01T00:00:00Z')+i*500).toISOString(),sensor:{distance_mm:300,status:'ok'}});
  const original=Array.from({length:1000},(_,i)=>point(i));
  await db.query(`insert into drain_records(record_id,fixture_id,record_type,data_source,recording_status,calibration,measurements)values($1,'sink','monitoring','sensor','recording',$2,$3)`,[id,empty,original]);
  const get=async()=>(await db.query('select * from drain_records where record_id=$1',[id])).rows[0];
  const before=await get();
  await migrate('202611150002_incremental_record_writes');await migrate('202611150002_incremental_record_writes');
  assert.deepEqual(await get(),before,'migration does not rewrite evidence or revisions');
  const expected={calibration:empty,result:null,recording_status:'recording'},added=[point(1000),point(1001)];
  const event={event_key:'standing-cycle',fixture_id:'sink',record_id:id,elapsed_seconds:130,threshold_seconds:120,completed:false};
  const change={...expected,append_measurements:added,notification_events:[event],notification_references:[{fixture_id:'sink',cycle_id:'prior-use',started_at:'2026-10-31T00:00:00Z',depth_mm:50,duration_seconds:20}]};
  const update=(revision,changes=change,exp=expected)=>db.query('select * from update_drain_record_incremental($1,$2,$3,$4)',[id,revision,exp,changes]);
  assert.deepEqual((await update(before.revision)).rows,[{record_id:id,revision:before.revision+1}]);
  assert.deepEqual((await get()).measurements,[...original,...added]);
  assert.equal((await db.query('select count(*) from drain_email_outbox')).rows[0].count,1);
  assert.equal((await db.query('select count(*) from drain_email_references')).rows[0].count,1);
  assert.equal((await update(before.revision)).rows.length,0,'lost response retry cannot append twice');
  assert.equal((await update(before.revision+1,change,{...expected,calibration:null})).rows.length,0,'metadata mismatch cannot overwrite the snapshot');
  const stable=await get();
  // A transactional notification failure must roll back the append as well.
  const bad={...change,append_measurements:[point(1002)],notification_events:[{...event,elapsed_seconds:'invalid'}]};
  await assert.rejects(update(stable.revision,bad));assert.deepEqual(await get(),stable);
  await assert.rejects(update(stable.revision,{...change,append_measurements:[{...point(1002),sensor:{distance_mm:0,status:'ok'}}]}),/measurements_shape/);
  await assert.rejects(update(stable.revision,{...change,append_measurements:Array.from({length:21},(_,i)=>point(1002+i))}),/20 appended/);
  await assert.rejects(update(stable.revision,{...change,append_measurements:{}}),/array|20 appended/);
  assert.deepEqual(await get(),stable);
  assert.equal((await update(stable.revision,{...expected,append_measurements:[],recording_status:'finished'})).rows.length,1,'metadata-only mutations still work');
  assert.deepEqual((await get()).measurements,stable.measurements);
  for(const role of ['anon','authenticated']) {
    await db.exec(`set role ${role}`);
    await assert.rejects(update(stable.revision),/permission denied/);
    await db.exec('reset role');
  }
  // The service role has the table grants and the RPC grant needed in production.
  await db.exec('set role service_role');
  assert.equal((await update(stable.revision)).rows.length,0);
  const final=await get();
  assert.equal((await update(final.revision,{...expected,append_measurements:[],recording_status:'finished'},{...expected,recording_status:'finished'})).rows.length,1,'service-role mutation works with the production grants');
  await db.exec('reset role');
  console.log('PASS: incremental writes preserve all readings, conflicts, notification transactions, constraints and access controls; migration is repeatable and does not rewrite rows.');
} finally {await db.close();}
