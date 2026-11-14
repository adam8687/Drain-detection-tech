import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {isDeepStrictEqual} from 'node:util';
import {appendMeasurements,monitoringEvents,INGEST,analyzeDrainage} from '../src/records-domain.js';
import {SupabaseRecordStore} from '../src/records-storage.js';
import {point,time,EMPTY,DRAIN_DEPTHS} from './helpers/drainage-fixtures.js';

const monitoring=(extra={})=>({record_id:randomUUID(),fixture_id:'sink',data_source:'sensor',record_type:'monitoring',recording_status:'recording',schema_version:2,calibration:{empty_distance_mm:EMPTY},measurements:[],result:null,created_at:new Date(time).toISOString(),...extra});
const feed=(record,readings)=>{let current=record,kept=0;for(const p of readings){const r=appendMeasurements(current,[p]);if(r.record!==current)kept++;current=r.record;}return{record:current,kept};};
const idle=(from,seconds,every=500)=>Array.from({length:Math.round(seconds*1000/every)},(_,i)=>point(from+i*every,((i*7)%5-2)*.5));

test('an idle sink keeps one reading per 8 s, but use and the 30 s after it stay dense',()=>{
 let {record,kept}=feed(monitoring(),idle(time,120));
 assert.ok(record.measurements.length<=16&&record.measurements.length>=14,`idle 2 min -> ${record.measurements.length} stored`);
 // Use: every reading is kept while water is present, then the 30 s afterwards, then thinning resumes.
 const use=DRAIN_DEPTHS.map((d,i)=>point(time+120000+i*500,d));
 const before=record.measurements.length;
 ({record}=feed(record,use));assert.equal(record.measurements.length-before,use.length,'no use reading is dropped');
 const tail=idle(time+120000+use.length*500,60);
 const after=record.measurements.length;({record}=feed(record,tail));
 const addedInTail=record.measurements.length-after;
 assert.ok(addedInTail>=54&&addedInTail<=66,`60 s tail: ${addedInTail} stored of 120 (about 30 s dense, then thinned)`);
 // a record without a calibration, and failed readings, are never thinned
 assert.equal(feed(monitoring({calibration:null}),idle(time,20)).record.measurements.length,40);
 const failed=Array.from({length:20},(_,i)=>({...point(time+i*500,0),sensor:{status:'timeout',distance_mm:null}}));
 assert.equal(feed(monitoring(),failed).record.measurements.length,20);
});
test('thinned readings are acknowledged without writing, and drain timing is unchanged by thinning',()=>{
 const start=feed(monitoring(),idle(time,40)).record;
 const next=appendMeasurements(start,[point(time+start.measurements.length*0+start.measurements.at(-1).timestamp.length*0+Date.parse(start.measurements.at(-1).timestamp)-time+2000,0)]);
 assert.equal(next.record,start,'same object: the handler skips the database write');assert.equal(next.duplicate,true);
 const events=readings=>monitoringEvents(feed(monitoring(),readings).record).filter(e=>e.recording_status==='finished');
 const day=[...idle(time,300),...DRAIN_DEPTHS.map((d,i)=>point(time+300000+i*500,d)),...idle(time+300000+DRAIN_DEPTHS.length*500,120)];
 const thinned=events(day);
 // Same readings with thinning disabled by removing the calibration snapshot until analysis.
 const dense=monitoringEvents({...feed(monitoring({calibration:null}),day).record,calibration:{empty_distance_mm:EMPTY}}).filter(e=>e.recording_status==='finished');
 assert.equal(thinned.length,1);assert.equal(dense.length,1);
 assert.deepEqual(thinned[0].result,dense[0].result);assert.equal(thinned[0].result.outcome,'completed');
});
test('monitoring keeps a rolling window instead of stopping; other recordings still stop at 5000',()=>{
 let record=monitoring();
 // Non-idle readings are always kept, so this fills the window quickly.
 const busy=Array.from({length:INGEST.monitoringWindow+300},(_,i)=>point(time+i*500,30+(i%7)));
 ({record}=feed(record,busy));
 assert.equal(record.measurements.length,INGEST.monitoringWindow);
 assert.equal(record.measurements.at(-1).reading_id,busy.at(-1).reading_id,'newest kept');
 assert.equal(record.measurements[0].reading_id,busy[300].reading_id,'oldest dropped first');
 const full=monitoring({record_type:'drainage',measurements:Array.from({length:5000},(_,i)=>point(time+i*500,30))});
 assert.throws(()=>appendMeasurements(full,[point(time+5000*500,30)]),e=>e.code==='record_full');
});

// ---- Supabase store: incremental reads
function database({delta=true}={}){
 const rows=[],traffic={full:0,fullBytes:0,delta:0,deltaBytes:0,headers:0};
 const fetcher=async(url,o={})=>{
  const q=new URL(url),method=o.method||'GET';
  if(q.pathname.endsWith('/rpc/update_drain_record_compact')){const {p_record_id,p_expected,p_changes}=JSON.parse(o.body),row=rows.find(r=>r.record_id===p_record_id);
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
 return{rows,traffic,store:()=>new SupabaseRecordStore('https://x.supabase.co','sb_secret_x',fetcher)};
}
const write=async(store,id,points)=>{const prev=await store.get(id),r=appendMeasurements(prev,points);if(r.record!==prev)assert.equal(await store.compareAndSet(prev,r.record),true);};

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
test('incremental reads follow a rolling window and carry changed status fields',async()=>{
 const db=database(),writer=db.store(),reader=db.store(),id=randomUUID();
 await writer.insert(monitoring({record_id:id}));
 await write(writer,id,Array.from({length:20},(_,i)=>point(time+i*500,30)));await reader.get(id);
 for(let i=0;i<INGEST.monitoringWindow/20+3;i++){await write(writer,id,Array.from({length:20},(_,k)=>point(time+(20+i*20+k)*500,30+(k%4))));const seen=await reader.get(id);assert.deepEqual(seen.measurements,(await writer.get(id)).measurements);}
 assert.equal((await reader.get(id)).measurements.length,INGEST.monitoringWindow);
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
 // 3. A legacy row longer than the window is read in full, not mis-merged.
 db=database();writer=db.store();reader=db.store();id=randomUUID();
 await writer.insert(monitoring({record_id:id,measurements:Array.from({length:2300},(_,i)=>point(time+i*500,30))}));await reader.get(id);
 db.rows[0].measurements.push(point(time+2300*500,30));db.rows[0].revision++;
 assert.equal((await reader.get(id)).measurements.length,2301);
});
