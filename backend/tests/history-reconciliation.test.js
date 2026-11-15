import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {completedEventRows,saveNewDrainEvents,reconcileDrainHistory} from '../../supabase/functions/_shared/rollover.js';
import {SQLiteRecordStore} from '../src/records-storage.js';
import {point,time,EMPTY} from './helpers/drainage-fixtures.js';

const drain=(extra={})=>({record_id:randomUUID(),fixture_id:'sink',record_type:'drainage',data_source:'sensor',recording_status:'finished',calibration:{empty_distance_mm:EMPTY},measurements:[point(time,40),point(time+500,0)],result:{outcome:'completed',drainage_time_seconds:.5},created_at:new Date(time).toISOString(),...extra});

test('standalone tests retain their own event IDs and invalid/legacy results stay out of health history',()=>{
 const record=drain(),snapshot=structuredClone(record);
 const [event]=completedEventRows(record);
 assert.equal(event.event_id,record.record_id);assert.equal(event.record_id,record.record_id);assert.equal(event.seconds,.5);assert.deepEqual(record,snapshot);
 for(const overrides of [{schema_version:1},{calibration:null},{recording_status:'recording'},{result:{outcome:'uncertain',drainage_time_seconds:.5}},{result:{outcome:'completed',drainage_time_seconds:NaN}}])assert.deepEqual(completedEventRows({...record,...overrides}),[]);
});

test('failed history saves retry on a duplicate upload without changing sensor evidence',async()=>{
 const after=drain(),before={...after,recording_status:'recording',result:null},snapshot=structuredClone(after),saved=new Map();let attempts=0;
 const store={saveDrainEvents:async rows=>{attempts++;if(attempts===1)throw Error('temporary outage');for(const row of rows)saved.set(row.event_id,row);}};
 await saveNewDrainEvents(store,before,after);assert.equal(attempts,1);assert.equal(saved.size,0);
 await saveNewDrainEvents(store,after,after);assert.equal(attempts,2);assert.equal(saved.size,1);
 await saveNewDrainEvents(store,after,after);assert.equal(attempts,2,'successful summaries are not posted on every idle upload');
 assert.deepEqual(after,snapshot);
});

test('reconciliation repairs lifetime history across pages, preserves originals and is safe to rerun',async()=>{
 const store=new SQLiteRecordStore(':memory:'),saved=new Map();let writes=0;
 store.saveDrainEvents=async rows=>{writes++;for(const row of rows)saved.set(row.event_id,row);};
 try {
  for(let i=0;i<31;i++)await store.insert(drain({created_at:new Date(time+i*1000).toISOString()}));
  await store.insert(drain({fixture_id:'other'}));await store.insert(drain({data_source:'simulation'}));await store.insert(drain({schema_version:1}));
  const original=await store.list({},100);
  const preview=await reconcileDrainHistory(store,{fixture:'sink'});assert.deepEqual(preview,{recordings:32,events:31,applied:false});assert.equal(writes,0);
  const first=await reconcileDrainHistory(store,{fixture:'sink',apply:true});assert.equal(first.events,31);assert.equal(saved.size,31);
  await reconcileDrainHistory(store,{fixture:'sink',apply:true});assert.equal(saved.size,31,'stable IDs prevent duplicate results');
  assert.ok([...saved.values()].every(e=>e.fixture_id==='sink'&&e.data_source==='sensor'));
  assert.deepEqual(await store.list({},100),original,'calibration, raw readings and measured results are untouched');
  store.saveDrainEvents=async()=>{throw Error('not saved');};
  await assert.rejects(reconcileDrainHistory(store,{fixture:'sink',apply:true}),/not saved/,'maintenance reports errors rather than claiming it completed');
 }finally{await store.close();}
});
