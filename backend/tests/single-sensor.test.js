import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SQLiteRecordStore} from '../src/records-storage.js';
import {validateMeasurement,calibrationSnapshot,learnedBaseline,boundedRecordView,drainStatuses} from '../src/records-domain.js';
const point=(i=0)=>({reading_id:randomUUID(),timestamp:new Date(Date.now()-100000+i*500).toISOString(),sensor:{distance_mm:300,status:'ok'}});
test('live contract accepts exactly one sensor and rejects old two-sensor payloads',()=>{
 const p=point();assert.deepEqual(validateMeasurement(p),p);
 const {sensor,...rest}=p;
 for(const invalid of [{...rest,sensor_a:sensor,sensor_b:sensor},{...p,sensor_b:sensor},{...rest}, {...p,sensor:{distance_mm:0,status:'timeout'}}])assert.throws(()=>validateMeasurement(invalid));
 assert.deepEqual(calibrationSnapshot({empty_distance_mm:400}),{empty_distance_mm:400});
 assert.throws(()=>calibrationSnapshot({sensor_a_empty_mm:400,sensor_b_empty_mm:420}));
});
test('SQLite migration archives the original channels, freezes finished timings, closes old active windows and permits new single-sensor writes',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'drain-migration-'));const file=join(folder,'db.sqlite');let store;
 try{
 const old=new DatabaseSync(file);old.exec('CREATE TABLE drain_records(record_id TEXT PRIMARY KEY,fixture_id TEXT,record_type TEXT,data_source TEXT,recording_status TEXT,calibration TEXT,measurements TEXT,result TEXT,created_at TEXT)');
 const p=point(),{sensor,...rest}=p;
 const original={record_id:randomUUID(),fixture_id:'sink',record_type:'drainage',data_source:'sensor',recording_status:'finished',calibration:{sensor_a_empty_mm:400,sensor_b_empty_mm:420},measurements:[{...rest,sensor_a:sensor,sensor_b:{distance_mm:null,status:'timeout'}}],result:{drainage_time_seconds:42,outcome:'completed'},created_at:new Date().toISOString()};
 const insert=row=>old.prepare('INSERT INTO drain_records VALUES(?,?,?,?,?,?,?,?,?)').run(...Object.values(row).map(v=>typeof v==='object'?JSON.stringify(v):v));
 insert(original);const active={...original,record_id:randomUUID(),recording_status:'recording',result:null};insert(active);old.close();
 store=new SQLiteRecordStore(file);
 const saved=await store.get(original.record_id);assert.equal(saved.schema_version,1);assert.deepEqual(saved.measurements,[p]);assert.deepEqual(saved.result,original.result);assert.deepEqual(saved.calibration,{empty_distance_mm:400});
 const backup=JSON.parse(store.db.prepare('SELECT original_record FROM drain_records_two_sensor_backup WHERE record_id=?').get(original.record_id).original_record);assert.deepEqual(backup.measurements,original.measurements);assert.deepEqual(backup.result,original.result);
 assert.equal((await store.get(active.record_id)).recording_status,'finished');assert.equal((await store.get(active.record_id)).result.outcome,'uncertain');
 assert.equal(learnedBaseline([saved,saved,saved]).seconds,null);assert.equal(drainStatuses([saved]).get(saved.record_id).status,'unknown');
 const next={...saved,record_id:randomUUID(),recording_status:'recording',schema_version:2,measurements:[],result:null};await store.insert(next);assert.equal((await store.list({schema_version:2})).length,1);
 await store.close();store=new SQLiteRecordStore(file);assert.equal(store.db.prepare('SELECT count(*) AS n FROM drain_records_two_sensor_backup').get().n,2);
 }finally{await store?.close();rmSync(folder,{recursive:true,force:true});}
});
test('bounded live responses preserve total count, timing and full replay history',()=>{
 const start=Date.now()-1000000; const measurements=Array.from({length:1000},(_,i)=>({...point(i),timestamp:new Date(start+i*500).toISOString()}));const record={record_id:randomUUID(),fixture_id:'sink',record_type:'monitoring',data_source:'sensor',recording_status:'finished',calibration:{empty_distance_mm:300},measurements,result:null};
 const full=boundedRecordView(record),limited=boundedRecordView(record,null,120);
 assert.equal(limited.record.measurements.length,120);assert.equal(limited.computed.water_levels.length,120);assert.equal(limited.computed.sample_count,1000);assert.equal(limited.computed.elapsed_seconds,full.computed.elapsed_seconds);assert.equal(limited.computed.water_levels[0].elapsed_seconds,440);assert.equal(record.measurements.length,1000);assert.equal(boundedRecordView(record,10).computed.sample_index,10);assert.throws(()=>boundedRecordView(record,null,501));
 const reduction=1-JSON.stringify(limited).length/JSON.stringify(full).length;assert.ok(reduction>.8); console.log(`Live response reduction with 1000 points: ${(reduction*100).toFixed(1)}%`);
});

test('incremental live responses return only new observations and recover from an unknown cursor',()=>{
 const samples=Array.from({length:30},(_,i)=>point(i)),record={record_id:randomUUID(),fixture_id:'sink',record_type:'monitoring',data_source:'sensor',recording_status:'finished',calibration:{empty_distance_mm:300},measurements:samples,result:null};
 const next=boundedRecordView(record,null,120,samples[25].reading_id);assert.equal(next.computed.series_mode,'append');assert.equal(next.record.measurements.length,4);assert.equal(next.computed.water_levels.length,4);assert.equal(boundedRecordView(record,null,120,samples.at(-1).reading_id).record.measurements.length,0);assert.equal(boundedRecordView(record,null,120,randomUUID()).computed.series_mode,'replace');assert.throws(()=>boundedRecordView(record,0,120,samples[0].reading_id));
});
