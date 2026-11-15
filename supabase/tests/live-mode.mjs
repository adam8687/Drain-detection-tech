import {pathToFileURL} from 'node:url';import {readFile} from 'node:fs/promises';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {liveView} from '../functions/_shared/live-mode.js';
const {PGlite}=await import(process.env.PGLITE_MODULE_PATH?pathToFileURL(process.env.PGLITE_MODULE_PATH).href:'@electric-sql/pglite');
const db=new PGlite();
try{
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);');
 await db.exec(await readFile(new URL('../migrations/202610270002_records_access.sql',import.meta.url),'utf8'));
 await db.query(`insert into dm_devices values('sink',now(),'{}'),('other',now(),'{}')`);
 const sql=await readFile(new URL('../migrations/202611150003_live_mode.sql',import.meta.url),'utf8');await db.exec(sql);await db.exec(sql);
 const a=randomUUID(),b=randomUUID(),get=async(action='get',session=null,reason=null,applied=false,fixture='sink')=>liveView((await db.query('select * from drain_live_mode($1,$2,$3,$4,$5)',[fixture,action,session,reason,applied])).rows[0].state);
 assert.equal((await get()).requested,false);const on=await get('on',a,'calibration');assert.equal(on.remaining_ms,120000);assert.equal(on.active,false);
 assert.equal((await get('poll',null,null,false)).capable,true);assert.equal((await get()).active,false);
 assert.equal((await get('poll',null,null,true)).active,true);
 await get('on',b,'demo');await get('off',a);assert.equal((await get()).requested,true);
 assert.equal((await get('get',null,null,false,'other')).requested,false);
 await db.query("update drain_live_devices set seen_at=now()-interval '20 seconds',applied_at=now()-interval '20 seconds'");assert.equal((await get()).active,false);
 await get('poll',null,null,true);assert.equal((await get()).active,true);
 await db.query("update drain_live_sessions set expires_at=now()-interval '1 second'");assert.equal((await get()).remaining_ms,0);assert.equal((await get()).active,false);
 assert.equal((await get('on',a,'demo')).active,false,'new live periods need new confirmation');assert.equal((await db.query('select count(*) from drain_live_sessions')).rows[0].count,1,'expired sessions are cleaned up');
 await assert.rejects(get('on',randomUUID(),'forever'),/Invalid live reason/);await assert.rejects(get('on'),/Session required/);
 for(const role of ['anon','authenticated']){await db.exec(`set role ${role}`);await assert.rejects(get(),/permission denied/);await assert.rejects(db.query('select * from drain_live_sessions'),/permission denied/);await db.exec('reset role');}
 await db.exec('set role service_role');assert.equal((await get()).requested,true);await get('off',a);assert.equal((await get()).requested,false);
 console.log('PASS: live-mode SQL is repeatable, isolated per fixture/session, expires, confirms device state, and restricts control to the trusted service.');
}finally{await db.close();}
