import {ApiError,object,uuid} from './validation.js';
export const LIVE_MODE={leaseMs:120000,freshMs:12000};
export function liveInput(value){object(value,['session_id','enabled','reason']);uuid(value.session_id,'session_id');if(typeof value.enabled!=='boolean'||!['demo','calibration'].includes(value.reason))throw new ApiError(422,'validation_error','Choose live demo or calibration mode');return value;}
export function liveView(row){const now=Number(row.now),expires=Number(row.expires_at)||0,seen=Number(row.seen_at)||0,applied=Number(row.applied_at)||0;return{requested:expires>now,active:expires>now&&applied>0&&now>=applied&&now-applied<=LIVE_MODE.freshMs,capable:seen>0&&now>=seen&&now-seen<=60000,expires_at:expires>now?new Date(expires).toISOString():null,remaining_ms:Math.max(0,Math.min(LIVE_MODE.leaseMs,Math.floor(expires-now))),server_now:new Date(now).toISOString()};}

// Session leases keep one browser from turning off another browser's live view.
// No measurement/calibration JSON is changed. Old upload acknowledgments stay identical.
export class LiveModeStore{
 constructor(store,clock=()=>Date.now()){
  this.store=store;this.clock=clock;
  if(store.db)store.db.exec(`CREATE TABLE IF NOT EXISTS drain_live_sessions(fixture_id TEXT NOT NULL,session_id TEXT NOT NULL,reason TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(fixture_id,session_id));CREATE TABLE IF NOT EXISTS drain_live_devices(fixture_id TEXT PRIMARY KEY,seen_at INTEGER NOT NULL,applied_at INTEGER NOT NULL);`);
 }
 async state(fixture,action='get',input={}){
  if(!this.store.db){
   if(!this.store.request)throw new ApiError(503,'live_unavailable','Live view is not available yet. Contact your installer.');
   try{const rows=await this.store.request('rpc/drain_live_mode',{method:'POST',body:JSON.stringify({p_fixture:fixture,p_action:action,p_session:input.session_id??null,p_reason:input.reason??null,p_applied:input.applied===true})});if(!rows[0]?.state)throw Error();return liveView(rows[0].state);}
   catch{throw new ApiError(503,'live_unavailable','Live view is not available yet. Contact your installer.');}
  }
  const db=this.store.db,now=this.clock();
  if(action==='on'){
   db.prepare('UPDATE drain_live_devices SET applied_at=0 WHERE fixture_id=? AND NOT EXISTS(SELECT 1 FROM drain_live_sessions WHERE fixture_id=? AND expires_at>?)').run(fixture,fixture,now);
   db.prepare('DELETE FROM drain_live_sessions WHERE fixture_id=? AND expires_at<=?').run(fixture,now);
   db.prepare('INSERT INTO drain_live_sessions VALUES(?,?,?,?) ON CONFLICT(fixture_id,session_id) DO UPDATE SET reason=excluded.reason,expires_at=excluded.expires_at').run(fixture,input.session_id,input.reason,now+LIVE_MODE.leaseMs);
  }else if(action==='off')db.prepare('DELETE FROM drain_live_sessions WHERE fixture_id=? AND session_id=?').run(fixture,input.session_id);
  if(action==='poll')db.prepare('INSERT INTO drain_live_devices VALUES(?,?,?) ON CONFLICT(fixture_id) DO UPDATE SET seen_at=excluded.seen_at,applied_at=excluded.applied_at WHERE drain_live_devices.seen_at<=? OR (drain_live_devices.applied_at>0) != (? > 0)').run(fixture,now,input.applied?now:0,now-5000,input.applied?now:0);
  const expires=db.prepare('SELECT max(expires_at) AS value FROM drain_live_sessions WHERE fixture_id=?').get(fixture).value;
  const device=db.prepare('SELECT seen_at,applied_at FROM drain_live_devices WHERE fixture_id=?').get(fixture);
  return liveView({now,expires_at:expires,...device});
 }
 // A failed optional control request must never reject a committed measurement.
 async command(fixture,applied,observedAt,idle=false){try{const fresh=idle||(Number.isFinite(Date.parse(observedAt))&&Math.abs(this.clock()-Date.parse(observedAt))<=3000);return(await this.state(fixture,'poll',{applied:applied&&fresh})).remaining_ms;}catch{return 0;}}
}
