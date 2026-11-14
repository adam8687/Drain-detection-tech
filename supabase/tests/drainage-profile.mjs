// PGlite regression for the drainage profile constraint. Run like single-sensor.mjs (see supabase/README.md).
import {pathToFileURL,fileURLToPath} from 'node:url';
const {PGlite}=await import(process.env.PGLITE_MODULE_PATH?pathToFileURL(process.env.PGLITE_MODULE_PATH).href:'@electric-sql/pglite');
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const root=fileURLToPath(new URL('../../',import.meta.url));
const {profiledCalibration,instantProfiledCalibration}=await import(root+'backend/tests/helpers/drainage-fixtures.js');
const {emptyDrainageCalibration}=await import(root+'supabase/functions/_shared/drainage-calibration.js');
const db=new PGlite();
await db.exec('create role anon;create role authenticated;create role service_role;');
for(const file of ['202610270001_drain_records','202611120001_single_sensor','202611120003_drainage_calibration'])await db.exec(await readFile(`${root}supabase/migrations/${file}.sql`,'utf8'));
const migration=await readFile(root+'supabase/migrations/202611130001_drainage_profile.sql','utf8');
const ready=profiledCalibration(1,1.1).calibration,instant=instantProfiledCalibration(0.5).calibration;
const {profile:_,...legacyDrainage}=ready.drainage;
const legacy={empty_distance_mm:300,drainage:{...legacyDrainage,version:1}};
const insert=async(calibration,id=randomUUID())=>db.query(`insert into drain_records(record_id,fixture_id,record_type,data_source,recording_status,calibration) values($1,'sink','calibration','sensor','finished',$2)`,[id,calibration]);
// Before the migration a version 1 setup is valid and a profile is not.
await insert(legacy);await assert.rejects(insert(ready),/calibration_shape/);
await db.exec(migration);await db.exec(migration);
await db.exec(await readFile(root+'supabase/migrations/202611140001_drainage_instant.sql','utf8'));await db.exec(await readFile(root+'supabase/migrations/202611140001_drainage_instant.sql','utf8'));
// Existing and new data both validate.
await insert(legacy);await insert(ready);await insert(instant);await insert({empty_distance_mm:300});
await insert({empty_distance_mm:300,drainage:emptyDrainageCalibration()});
const bad=(edit,base=ready)=>{const value=structuredClone(base);edit(value.drainage);return value;};
const rejected=[
 bad(d=>{delete d.profile;}),                                  // version 2 ready needs a profile
 bad(d=>{d.profile=null;}),                                    // ... and not null
 {...legacy,drainage:{...legacy.drainage,profile:ready.drainage.profile}}, // version 1 cannot carry one
 {empty_distance_mm:300,drainage:{...emptyDrainageCalibration(),profile:ready.drainage.profile}}, // collecting has none
 bad(d=>{d.profile.clear_drain_confirmed=false;}),
 bad(d=>{d.profile.bands.pop();}),
 bad(d=>{d.profile.bands[2].from_depth_mm=99;}),
 bad(d=>{d.profile.bands[0].slow_seconds='fast';}),
 bad(d=>{d.profile.total.slow_seconds=d.profile.total.expected_seconds;}),
 bad(d=>{d.profile.total.severe_seconds=d.profile.total.slow_seconds/2;}),
 bad(d=>{d.profile.policy.repeat_count=1;}),
 bad(d=>{d.profile.policy.repeat_window=1;}),
 bad(d=>{d.profile.policy.slow_ratio=9;}),
 bad(d=>{d.profile.noise_seconds=11;}),
 bad(d=>{d.profile.extra=true;}),
 bad(d=>{d.version=3;}),
 bad(d=>{d.profile.resolution='fast';}),
 bad(d=>{delete d.profile.resolution;}),
 bad(d=>{delete d.profile.policy.min_slow_seconds;}),
 bad(d=>{d.profile.policy.min_severe_seconds=1;}),
 bad(d=>{d.repeatability_ratio=3.5;}),
];
for(const [i,value] of rejected.entries())await assert.rejects(insert(value),/calibration_shape/,`case ${i} should be rejected`);
assert.equal((await db.query('select count(*)::int as n from drain_records')).rows[0].n,6);
console.log('drainage profile constraint: ok');
