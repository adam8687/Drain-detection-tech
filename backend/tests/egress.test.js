import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {isDeepStrictEqual} from 'node:util';
import {appendMeasurements,appendMeasurement} from '../src/records-domain.js';
import {SupabaseRecordStore} from '../src/records-storage.js';
import {point,time,EMPTY} from './helpers/drainage-fixtures.js';

const monitoring=(extra={})=>({record_id:randomUUID(),fixture_id:'sink',data_source:'sensor',record_type:'monitoring',recording_status:'recording',schema_version:2,calibration:{empty_distance_mm:EMPTY},measurements:[],result:null,created_at:new Date(time).toISOString(),...extra});
const feed=(record,readings)=>{let current=record,kept=0;for(const p of readings){const r=appendMeasurements(current,[p]);if(r.record!==current)kept++;current=r.record;}return{record:current,kept};};
const idle=(from,seconds,every=500)=>Array.from({length:Math.round(seconds*1000/every)},(_,i)=>point(from+i*every,((i*7)%5-2)*.5));

// ---- Supabase store: incremental reads
function database({delta=true,incremental=true}={}){
 const rows=[],traffic={full:0,fullBytes:0,delta:0,deltaBytes:0,headers:0,incremental:0,compact:0,writeBodies:[]};
 const fetcher=async(url,o={})=>{
  const q=new URL(url),method=o.method||'GET';
  if(q.pathname.endsWith('/rpc/update_drain_record_incremental')){
   traffic.incremental++;traffic.writeBodies.push(JSON.parse(o.body));
   if(!incremental)return new Response('{}',{status:404});
   const {p_record_id,p_revision,p_expected,p_changes}=JSON.parse(o.body),row=rows.find(r=>r.record_id===p_record_id);
   if(!row||String(row.revision)!==p_revision||!Object.entries(p_expected).every(([k,v])=>isDeepStrictEqual(row[k],v)))return Response.json([]);
   const {append_measurements,...changes}=p_changes;Object.assign(row,structuredClone(changes),{measurements:[...row.measurements,...structuredClone(append_measurements)]});row.revision++;
   return Response.json([{record_id:row.record_id,revision:row.revision}]);
  }
  if(q.pathname.endsWith('/rpc/update_drain_record_compact')){traffic.compact++;traffic.writeBodies.push(JSON.parse(o.body));const {p_record_id,p_expected,p_changes}=JSON.parse(o.body),row=rows.find(r=>r.record_id===p_record_id);
   if(!row||!Object.entries(p_expected).every(([k,v])=>isDeepStrictEqual(row[k],v)))return Response.json([]);Object.assign(row,structuredClone(p_changes));row.revision++;return Response.json([{record_id:row.record_id,revision:row.revision}]);}
  if(q.pathname.endsWith('/rpc/drain_record_delta')){
   traffic.delta++;
   if(!delta)return new Response('{}',{status:404});
   const {p_record_id,p_after}=JSON.parse(o.body),row=rows.find(r=>r.record_id===p_record_id),out=row?[{record_id:row.record_id,revision:row.revision,total:row.measurements.length,tail:row.measurements.filter(e=>e.timestamp>p_after),calibration:row.calibration,result:row.result,recording_status:row.recording_status}]:[];
   traffic.deltaBytes+=JSON.stringify(out).length;return Response.json(out);}
  if(method==='POST'){const row={...JSON.parse(o.body),revision:0};rows.push(structuredClone(row));return Response.json([row],{status:201});}
  const eq=[...q.searchParams].filter(([k,f])=>f.startsWith('eq.')),r=rows.filter(row=>eq.every(([k,f])=>String(row[k])===f.slice(3)));
  const select=q.searchParams.get('select'),out=select==='*'?r:r.map(row=>Object.fromEntries(select.split(',').map(k=>[k,row[k]])));
  if(select==='*'){traffic.full++;traffic.fullBytes+=JSON.stringify(out).length;}else traffic.headers++;
  return Response.json(out,{headers:{'Content-Range':`0-${out.length-1}/${r.length}`}});
 };
 return{rows,traffic,fetcher,store:()=>new SupabaseRecordStore('https://x.supabase.co','sb_secret_x',fetcher)};
}
const write=async(store,id,points)=>{const prev=await store.get(id),r=appendMeasurements(prev,points);if(r.record!==prev)assert.equal(await store.compareAndSet(prev,r.record),true);};

test('monitoring batch processing equals individual appends for late, repeated and conflicting points',()=>{
 const points=idle(time,5),record=monitoring({measurements:points.slice(0,3)}),incoming=[points[6],points[3],points[2],points[8],points[7]];
 let sequential=record,duplicate=true;
 for(const point of incoming){const step=appendMeasurement(sequential,point);sequential=step.record;duplicate&&=step.duplicate;}
 assert.deepEqual(appendMeasurements(record,incoming),{record:sequential,duplicate});assert.equal(record.measurements.length,3);
 assert.deepEqual(appendMeasurements(record,points.slice(0,3)),{record,duplicate:true});
 assert.throws(()=>appendMeasurements(record,[points[3],{...points[2],sensor:{distance_mm:99,status:'ok'}}]),/reused/);
 const finished={...record,recording_status:'finished'};
 assert.equal(appendMeasurements(finished,[points[2]]).record,finished);
 assert.throws(()=>appendMeasurements(finished,[points[3]]),/finished/);
 const full=monitoring({measurements:idle(time,2500)});
 assert.throws(()=>appendMeasurements(full,[point(time+2500000,0)]),/5000/);
 assert.equal(appendMeasurements(full,[full.measurements[0]]).record,full);
});

test('a worker holding an older copy downloads only new readings, and the result equals a full read',async()=>{
 const db=database(),writer=db.store(),reader=db.store(),id=randomUUID();
 await writer.insert(monitoring({record_id:id}));
 for(let i=0;i<75;i++)await write(writer,id,Array.from({length:20},(_,k)=>point(time+(i*20+k)*500,30+(k%5))));
 const first=await reader.get(id);assert.equal(first.measurements.length,1500);assert.equal(db.traffic.full,1,'cold worker reads the row once');
 const fullBytes=db.traffic.fullBytes;
 for(let round=0;round<20;round++){
  await write(writer,id,[point(time+(1500+round*2)*500,31),point(time+(1501+round*2)*500,32)]);
  const seen=await reader.get(id);
  assert.deepEqual(seen,await writer.get(id),'delta result identical to the writer\'s copy');
 }
 assert.equal(db.traffic.full,1,'no further full-row downloads');assert.equal(db.traffic.delta,20);
 assert.ok(db.traffic.deltaBytes*20<fullBytes,`20 delta reads (${db.traffic.deltaBytes} B) cost under 5% of one full read (${fullBytes} B)`);
});

test('database writes send only new readings and preserve concurrent-update protection',async()=>{
 const db=database(),store=db.store();const id=randomUUID();
 await store.insert(monitoring({record_id:id,measurements:idle(time,2000)}));
 const original=await store.get(id),next=appendMeasurements(original,idle(time+2000000,5)).record;
 assert.equal(await store.compareAndSet(original,next,[{event_key:'same-event'}],[{cycle_id:'same-reference'}]),true);
 const body=db.traffic.writeBodies.at(-1);
 assert.equal(body.p_changes.append_measurements.length,10);assert.equal(body.p_expected.measurements,undefined);assert.equal(body.p_changes.measurements,undefined);
 assert.deepEqual(body.p_changes.notification_events,[{event_key:'same-event'}]);assert.deepEqual(body.p_changes.notification_references,[{cycle_id:'same-reference'}]);
 const fullBytes=JSON.stringify({p_expected:{measurements:original.measurements},p_changes:{measurements:next.measurements}}).length;
 assert.ok(JSON.stringify(body).length<fullBytes/100,'write body is under 1% of the previous full-array payload');
 assert.deepEqual((await store.get(id)).measurements,next.measurements);
 assert.equal(await store.compareAndSet(original,next),false,'the revision is tied to the old snapshot, even after a newer read');
});

test('incremental writes fall back only when unavailable or when an edit is not an append',async()=>{
 let db=database({incremental:false}),store=db.store(),id=randomUUID();await store.insert(monitoring({record_id:id}));
 for(let i=0;i<3;i++)await write(store,id,[point(time+i*500,30)]);
 assert.equal(db.traffic.incremental,1,'missing function is probed once, not on each upload');assert.equal(db.traffic.compact,3);
 assert.equal((await store.get(id)).measurements.length,3);
 db=database();store=db.store();id=randomUUID();await store.insert(monitoring({record_id:id,measurements:[point(time+5000,30)]}));
 await write(store,id,[point(time,30)]);assert.equal(db.traffic.incremental,0,'late points take the full ordered comparison path');assert.equal(db.traffic.compact,1);
 const previous=await store.get(id),changed={...previous,measurements:previous.measurements.slice(1)};
 assert.equal(await store.compareAndSet(previous,changed),true);assert.equal(db.traffic.compact,2,'removals are never treated as appends');
});

test('incremental write errors never acknowledge rejected writes or duplicate a committed lost reply',async()=>{
 const db=database(),seed=db.store(),id=randomUUID();await seed.insert(monitoring({record_id:id}));
 let mode='reject';
 const store=new SupabaseRecordStore('https://x.supabase.co','sb_secret_x',async(url,options)=>{
  if(url.endsWith('/rpc/update_drain_record_incremental')){
   if(mode==='reject')return new Response('{}',{status:503});
   const reply=await db.fetcher(url,options);
   if(mode==='lost'){mode='normal';throw Error('reply lost after commit');}
   return reply;
  }
  return db.fetcher(url,options);
 });
 const reading=point(time,30),previous=await store.get(id),next=appendMeasurements(previous,[reading]).record;
 await assert.rejects(store.compareAndSet(previous,next));assert.equal(db.rows[0].measurements.length,0);assert.equal(db.traffic.compact,0,'a server error does not silently switch write protocols');
 mode='lost';await assert.rejects(store.compareAndSet(previous,next));assert.equal(db.rows[0].measurements.length,1);
 const recovered=await store.get(id),retry=appendMeasurements(recovered,[reading]);assert.equal(retry.duplicate,true);assert.equal(retry.record,recovered);assert.deepEqual(recovered.measurements,[reading]);
});
test('incremental reads carry changed status fields and never lose history',async()=>{
 const db=database(),writer=db.store(),reader=db.store(),id=randomUUID();
 await writer.insert(monitoring({record_id:id}));
 await write(writer,id,Array.from({length:20},(_,i)=>point(time+i*500,30)));await reader.get(id);
 for(let i=0;i<10;i++){await write(writer,id,Array.from({length:20},(_,k)=>point(time+(20+i*20+k)*500,30+(k%4))));assert.deepEqual((await reader.get(id)).measurements,(await writer.get(id)).measurements);}
 assert.equal((await reader.get(id)).measurements.length,220,'every reading is kept');
 const row=db.rows.find(r=>r.record_id===id);row.recording_status='finished';row.revision++;
 assert.equal((await reader.get(id)).recording_status,'finished','mutable fields come with the delta');
});
test('anything unexpected falls back to the authoritative full read',async()=>{
 // 1. The delta function is not installed yet: still correct, and it is not retried on every read.
 let db=database({delta:false}),writer=db.store(),reader=db.store(),id=randomUUID();
 await writer.insert(monitoring({record_id:id}));await write(writer,id,[point(time,30)]);await reader.get(id);
 for(let i=1;i<6;i++){await write(writer,id,[point(time+i*500,30)]);assert.equal((await reader.get(id)).measurements.length,i+1);}
 assert.equal(db.traffic.delta,1,'one failed attempt, then it stops asking');assert.equal(db.traffic.full,6);
 // 2. A reading older than the cached last one arrives late: the count check catches it.
 db=database();writer=db.store();reader=db.store();id=randomUUID();
 await writer.insert(monitoring({record_id:id}));await write(writer,id,[point(time+5000,30),point(time+5500,30)]);await reader.get(id);
 db.rows[0].measurements.push(point(time+1000,30));db.rows[0].measurements.sort((a,b)=>a.timestamp.localeCompare(b.timestamp));db.rows[0].revision++;
 const seen=await reader.get(id);assert.equal(seen.measurements.length,3);assert.equal(seen.measurements[0].timestamp,new Date(time+1000).toISOString());assert.equal(db.traffic.full,2);
});

