import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const {PGlite}=await import(process.env.PGLITE_MODULE_PATH?pathToFileURL(process.env.PGLITE_MODULE_PATH).href:'@electric-sql/pglite');
const db=new PGlite();
try {
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);');
  const migrate=async name=>db.exec(await readFile(new URL(`../migrations/${name}.sql`,import.meta.url),'utf8'));
  for(const name of ['202610270001_drain_records','202610270002_records_access','202611120001_single_sensor',
    '202611120002_email_notifications','202611140003_drain_history','202611150002_incremental_record_writes'])await migrate(name);
  const owner=randomUUID(),viewer=randomUUID(),first=randomUUID(),successor=randomUUID();
  await db.query('insert into auth.users values($1),($2)',[owner,viewer]);
  await db.exec(`insert into dm_devices values('alpha',now(),'{}'),('sink',now(),'{"name":"Kitchen"}');`);
  await db.query(`insert into dm_device_members values(gen_random_uuid(),'sink',$1,'owner',now(),'{}'),(gen_random_uuid(),'alpha',$2,'viewer',now(),'{}')`,[owner,viewer]);
  const sensors=Array.from({length:5000},(_,i)=>({reading_id:randomUUID(),timestamp:new Date(Date.parse('2026-01-01T00:00:00Z')+i*500).toISOString(),sensor:{distance_mm:300,status:'ok'}}));
  await db.query(`insert into drain_records(record_id,fixture_id,record_type,data_source,recording_status,measurements,calibration)
    values($1,'sink','monitoring','sensor','recording',$2,'{"empty_distance_mm":300}')`,[first,sensors]);
  for(let i=0;i<2;i++)for(const name of ['202611200001_recording_continuations','202611200002_fleet_summaries'])await migrate(name);
  const read=async id=>(await db.query('select * from drain_records where record_id=$1',[id])).rows[0];
  const full=await read(first);
  assert.deepEqual(full.measurements,sensors);
  assert.equal(full.last_reading_at,sensors.at(-1).timestamp);
  const roll=async(next=successor,incoming=1)=>(await db.query('select * from roll_monitoring_record($1,$2,$3,now())',[first,next,incoming])).rows;
  await db.exec('set role service_role');
  assert.equal((await roll(successor,0)).length,0);
  const [newRow]=await roll();
  assert.equal(newRow.continued_from,first);
  assert.equal(newRow.rollover_root,first);
  assert.deepEqual(newRow.measurements,[]);
  assert.equal((await roll(randomUUID()))[0].record_id,successor);
  const sealed=await read(first);
  assert.equal(sealed.continued_in,successor);
  assert.equal(sealed.recording_status,'finished');
  assert.equal(sealed.revision,full.revision+1);
  assert.deepEqual(sealed.measurements,sensors);
  await db.query('insert into drain_events values ($1,$2,$3,$4,$5,$6)',[first+':event','sink','sensor',successor,sensors[0].timestamp,5]);
  const summary={drain_status:null,alerts:[]};
  const save=revision=>db.query('select * from save_drain_record_health($1,$2,$3)',[successor,revision,summary]);
  assert.equal((await save(99)).rows.length,0);
  assert.equal((await save(0)).rows[0].saved,true);
  const fleet=(user=null,viewerScope=null,admin=false,after='',q='',limit=10)=>db.query(
    `select * from drain_fleet_page($1,$2,$3,'sensor',$4,$5,$6)`,[user,viewerScope,admin,after,q,limit]);
  assert.deepEqual((await fleet(owner)).rows.map(r=>r.device_id),['sink']);
  assert.deepEqual((await fleet(viewer)).rows.map(r=>r.device_id),['alpha']);
  assert.deepEqual((await fleet(null,'sink')).rows.map(r=>r.device_id),['sink']);
  assert.deepEqual((await fleet(null,null,true,'alpha','KitCHen',1)).rows.map(r=>r.device_id),['sink']);
  const [card]=(await fleet(owner)).rows;
  assert.equal(card.record.record_id,successor);
  assert.equal('measurements' in card.record,false);
  assert.equal(card.recent_drains[0].seconds,5);
  assert.deepEqual(card.health,summary);
  assert.equal(card.last_reading_at,null);
  const expected={calibration:{empty_distance_mm:300},result:null,recording_status:'recording'};
  const update=await db.query('select * from update_drain_record_incremental($1,$2,$3,$4)',
    [successor,newRow.revision,expected,{...expected,append_measurements:[sensors.at(-1)]}]);
  assert.equal(update.rows[0].revision,newRow.revision+1);
  assert.equal((await fleet(owner)).rows[0].last_reading_at,sensors.at(-1).timestamp);
  assert.deepEqual((await read(successor)).measurements,[sensors.at(-1)]);
  await db.exec('reset role');
  for(const role of ['anon','authenticated']){
    await db.exec(`set role ${role}`);
    await assert.rejects(fleet(null,null,true),/permission denied/);
    await assert.rejects(roll(),/permission denied/);
    await db.exec('reset role');
  }
  console.log('PASS: atomic rollover and retry preserve raw readings; scoped fleet pages return indexed drain summaries and reject obsolete health snapshots.');
} finally {await db.close();}
