import {randomUUID,createHash} from 'node:crypto';
export function createEmailTables(db){db.exec(`CREATE TABLE IF NOT EXISTS drain_email_references(fixture_id TEXT NOT NULL,cycle_id TEXT NOT NULL,started_at TEXT NOT NULL,depth_mm REAL NOT NULL,duration_seconds REAL NOT NULL,PRIMARY KEY(fixture_id,cycle_id));
 CREATE TABLE IF NOT EXISTS drain_email_preferences(fixture_id TEXT NOT NULL,user_id TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,threshold_seconds INTEGER,PRIMARY KEY(fixture_id,user_id));
 CREATE TABLE IF NOT EXISTS drain_email_outbox(id TEXT PRIMARY KEY,fixture_id TEXT NOT NULL,user_id TEXT NOT NULL,event TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL,created_at INTEGER NOT NULL,lease_token TEXT,recipient TEXT,payload TEXT,provider_id TEXT);`);}
export function saveEmailReferences(db,samples){for(const s of samples){if(db.prepare('SELECT count(*) AS n FROM drain_email_references WHERE fixture_id=?').get(s.fixture_id).n>=50)continue;db.prepare('INSERT OR IGNORE INTO drain_email_references VALUES(?,?,?,?,?)').run(s.fixture_id,s.cycle_id,s.started_at,s.depth_mm,s.duration_seconds);}}
export function enqueueEmailEvents(db,events){
 for(const event of events)for(const pref of db.prepare('SELECT * FROM drain_email_preferences WHERE fixture_id=? AND enabled=1').all(event.fixture_id)){
  const threshold=pref.threshold_seconds??event.threshold_seconds;if(event.elapsed_seconds<threshold)continue;
  const id=createHash('sha256').update(`${pref.user_id}:${event.event_key}`).digest('hex');if(db.prepare('SELECT id FROM drain_email_outbox WHERE id=?').get(id))continue;
  const now=Date.now();if(db.prepare("SELECT id FROM drain_email_outbox WHERE fixture_id=? AND user_id=? AND created_at>? AND status!='cancelled' LIMIT 1").get(event.fixture_id,pref.user_id,now-3600000))continue;
  db.prepare('INSERT INTO drain_email_outbox(id,fixture_id,user_id,event,available_at,created_at)VALUES(?,?,?,?,?,?)').run(id,event.fixture_id,pref.user_id,JSON.stringify({...event,email_threshold_seconds:threshold}),now,now);
 }
}
export class SQLiteEmailStore{
 constructor(db){this.db=db;createEmailTables(db);}
 async references(fixture){return this.db.prepare('SELECT * FROM drain_email_references WHERE fixture_id=? ORDER BY started_at LIMIT 50').all(fixture);}
 async preference(fixture,user){const p=this.db.prepare('SELECT * FROM drain_email_preferences WHERE fixture_id=? AND user_id=?').get(fixture,user);return p?{...p,enabled:Boolean(p.enabled)}:null;}
 async savePreference(p){this.db.prepare('INSERT INTO drain_email_preferences VALUES(?,?,?,?) ON CONFLICT(fixture_id,user_id) DO UPDATE SET enabled=excluded.enabled,threshold_seconds=excluded.threshold_seconds').run(p.fixture_id,p.user_id,Number(p.enabled),p.threshold_seconds);}
 async claim(limit){const now=Date.now(),rows=this.db.prepare("SELECT * FROM drain_email_outbox WHERE status IN('pending','sending') AND available_at<=? AND attempts<5 AND created_at>? ORDER BY created_at LIMIT ?").all(now,now-23*3600000,limit),claimed=[];
  for(const row of rows){const lease=randomUUID();if(this.db.prepare("UPDATE drain_email_outbox SET status='sending',attempts=attempts+1,lease_token=?,available_at=? WHERE id=? AND available_at<=? AND status IN('pending','sending')").run(lease,now+90000,row.id,now).changes)claimed.push({...row,event:JSON.parse(row.event),payload:row.payload?JSON.parse(row.payload):null,attempts:row.attempts+1,lease_token:lease});}return claimed;
 }
 async seal(job,recipient,payload){if(this.db.prepare("UPDATE drain_email_outbox SET recipient=coalesce(recipient,?),payload=coalesce(payload,?) WHERE id=? AND lease_token=? AND status='sending'").run(recipient,JSON.stringify(payload),job.id,job.lease_token).changes!==1)throw Error('Email lease expired');}
 async finish(job,status,provider=null){if(this.db.prepare('UPDATE drain_email_outbox SET status=?,provider_id=? WHERE id=? AND lease_token=?').run(status,provider,job.id,job.lease_token).changes!==1)throw Error('Email lease expired');}
 async retry(job){this.db.prepare("UPDATE drain_email_outbox SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,available_at=? WHERE id=? AND lease_token=?").run(Date.now()+Math.min(3600000,30000*2**job.attempts),job.id,job.lease_token);}
}
