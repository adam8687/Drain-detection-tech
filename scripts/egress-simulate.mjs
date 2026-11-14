// Local model of Supabase database egress (bytes the database returns). No network. Usage:
//   HOURS=1 UNITS=1 npm run egress:simulate     (NO_DELTA=1 disables incremental reads; SHARED=1 = viewers share the writer's cache)
import {randomUUID} from 'node:crypto';import {isDeepStrictEqual} from 'node:util';
const root=new URL('../',import.meta.url).href;
const {SupabaseRecordStore}=await import(root+'supabase/functions/_shared/records-storage.js');
const D=await import(root+'supabase/functions/_shared/records-domain.js');
const {profiledCalibration}=await import(root+'backend/tests/helpers/drainage-fixtures.js');
const HOURS=Number(process.env.HOURS||1),UNITS=Number(process.env.UNITS||1),USE_PROFILE=true;
// ---- fake PostgREST that counts bytes it returns
const rows=[],bytes={header:0,full:0,list_header:0,rpc:0,delta:0},calls={header:0,full:0,list_header:0,rpc:0,delta:0};
const fetcher=async(url,o={})=>{
 const q=new URL(url),method=o.method||'GET';
 if(q.pathname.endsWith('/rpc/update_drain_record_compact')){
  const {p_record_id,p_expected,p_changes}=JSON.parse(o.body),row=rows.find(r=>r.record_id===p_record_id);
  if(!row||!Object.entries(p_expected).every(([k,v])=>isDeepStrictEqual(row[k],v)))return Response.json([]);
  Object.assign(row,structuredClone(p_changes));row.revision++;const out=[{record_id:row.record_id,revision:row.revision}];bytes.rpc+=JSON.stringify(out).length;calls.rpc++;return Response.json(out);}
 if(q.pathname.endsWith('/rpc/drain_record_delta')){
  if(process.env.NO_DELTA)return new Response('{}',{status:404});
  const {p_record_id,p_after}=JSON.parse(o.body),row=rows.find(r=>r.record_id===p_record_id&&r.schema_version===2);
  const out=row?[{record_id:row.record_id,revision:row.revision,total:row.measurements.length,tail:row.measurements.filter(e=>e.timestamp>p_after),calibration:row.calibration,result:row.result,recording_status:row.recording_status}]:[];
  bytes.delta+=JSON.stringify(out).length;calls.delta++;return Response.json(out);}
 if(method==='POST'){const row={...JSON.parse(o.body),revision:0};rows.push(structuredClone(row));return Response.json([row],{status:201});}
 const sel=[...q.searchParams].filter(([k])=>!['select','order','offset','limit'].includes(k));
 let r=rows.filter(row=>sel.every(([k,f])=>f.startsWith('eq.')?String(row[k])===f.slice(3):f==='not.is.null'?row[k]!==null:true));
 r.sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));if(q.searchParams.get('order')?.startsWith('created_at.asc'))r.reverse();
 const off=Number(q.searchParams.get('offset')||0),lim=Math.min(200,Number(q.searchParams.get('limit')||100)),total=r.length;r=r.slice(off,off+lim);
 const select=q.searchParams.get('select'),isFull=select==='*';
 const out=isFull?r:r.map(row=>Object.fromEntries(select.split(',').map(k=>[k,row[k]])));
 const n=JSON.stringify(out).length;
 if(isFull){bytes.full+=n;calls.full++;}else if(select.includes('fixture_id')){bytes.list_header+=n;calls.list_header++;}else{bytes.header+=n;calls.header++;}
 return Response.json(out,{headers:{'Content-Range':`${off}-${off+out.length-1}/${total}`}});
};
const mk=()=>new SupabaseRecordStore('https://x.supabase.co','sb_secret_x',fetcher);
const writerStore=mk(),viewerStore=process.env.SHARED?writerStore:mk(),fleetStore=process.env.SHARED?writerStore:mk();
// ---- fixtures: UNITS sinks, each with a finished calibration record (profile) and a recording monitoring record
const EMPTY=300,T0=Date.now()-HOURS*3600e3-60e3;
const profileRec=profiledCalibration(1,1.1);
const units=[];
for(let u=0;u<UNITS;u++){
 const fx=`unit-${u}`;
 const cal={...profileRec,record_id:randomUUID(),fixture_id:fx,created_at:new Date(T0-1e4).toISOString(),revision:0,schema_version:2};
 rows.push(structuredClone(cal));
 const mon={record_id:randomUUID(),fixture_id:fx,record_type:'monitoring',data_source:'sensor',recording_status:'recording',calibration:{empty_distance_mm:EMPTY},measurements:[],result:null,created_at:new Date(T0).toISOString(),revision:0,schema_version:2};
 rows.push(structuredClone(mon));units.push({fx,id:mon.record_id});
}
let seed=3;const rnd=()=>(seed=(seed*1664525+1013904223)%4294967296)/4294967296;
const pt=(ms,depth)=>({reading_id:randomUUID(),timestamp:new Date(ms).toISOString(),sensor:{distance_mm:Math.round(EMPTY-depth+(rnd()-.5)*2),status:'ok'}});
// one use every 10 minutes: fill 3 s, hold 5 s, drain 8 s, 3 s tail (500 ms samples); idle otherwise
const depthAt=(s)=>{const m=s%600;if(m<3)return 45*(m/3);if(m<8)return 45;if(m<16)return 45*(1-(m-8)/8);return 0;};
const stop=T0+HOURS*3600e3;let now=T0;const writers=units.map(u=>({...u,pending:[]}));
let nextLive=T0,nextFleet=T0,drops=0,fullStops=0;
const ingestNow=process.env.INGEST_NOW?true:false;
for(let t=T0;t<stop;t+=500){
 for(const w of writers){w.pending.push(pt(t,depthAt((t-T0)/1000)));
  if(w.pending.length>=4||(t-T0)%2000===1500){
   const points=w.pending.splice(0);
   try{const prev=await writerStore.get(w.id);const r=D.appendMeasurements(prev,points);if(r.record!==prev)await writerStore.compareAndSet(prev,r.record);}
   catch(e){if(e.code==='record_full'||/5000/.test(e.message)){fullStops++;}else throw e;}}}
 // live viewer for unit 0 every 1.5 s on its own worker
 if(t>=nextLive){nextLive+=1500;const row=await viewerStore.get(units[0].id);D.boundedRecordView(row,null,120);}
 // a fleet dashboard open on another worker polling every 30 s
 if(t>=nextFleet){nextFleet+=30000;const list=await fleetStore.list({data_source:'sensor'},200);D.drainStatuses(await D.statusContext(fleetStore,list),t);}
}
const mb=n=>Math.round(n/1e4)/100;
const recSize=JSON.stringify(rows.find(r=>r.record_id===units[0].id)).length;
console.log(JSON.stringify({scenario:{hours:HOURS,units:UNITS},fullStopsFromRecordFull:fullStops,monitoringRowBytes:recSize,monitoringPoints:rows.find(r=>r.record_id===units[0].id).measurements.length,
 egressMB:{fullRowReads:mb(bytes.full),headerReads:mb(bytes.header),listHeaders:mb(bytes.list_header),rpcAcks:mb(bytes.rpc),deltaReads:mb(bytes.delta),TOTAL:mb(bytes.full+bytes.header+bytes.list_header+bytes.rpc+bytes.delta)},
 calls,perDayMB_x24:mb((bytes.full+bytes.header+bytes.list_header+bytes.rpc+bytes.delta)*24/HOURS)}));
