import {randomUUID,createHash} from 'node:crypto';
export function createEmailTables(db){db.exec(`CREATE TABLE IF NOT EXISTS drain_email_references(fixture_id TEXT NOT NULL,cycle_id TEXT NOT NULL,started_at TEXT NOT NULL,depth_mm REAL NOT NULL,duration_seconds REAL NOT NULL,PRIMARY KEY(fixture_id,cycle_id));
 CREATE TABLE IF NOT EXISTS drain_email_preferences(fixture_id TEXT NOT NULL,user_id TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,threshold_seconds INTEGER,PRIMARY KEY(fixture_id,user_id));
 CREATE TABLE IF NOT EXISTS drain_email_outbox(id TEXT PRIMARY KEY,fixture_id TEXT NOT NULL,user_id TEXT NOT NULL,event TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL,created_at INTEGER NOT NULL,lease_token TEXT,recipient TEXT,payload TEXT,provider_id TEXT);`);
 for(const [table,column,definition] of [['drain_email_preferences','emergency_contacts',"TEXT NOT NULL DEFAULT '[]'"],['drain_email_outbox','channel',"TEXT NOT NULL DEFAULT 'email'"],['drain_email_outbox','contact_id','TEXT']]){
  if(!db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name===column))db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
 }
 db.exec("UPDATE drain_email_outbox SET status='cancelled' WHERE channel='sms' AND status IN ('pending','sending')");
}
export function saveEmailReferences(db,samples){for(const s of samples){if(db.prepare('SELECT count(*) AS n FROM drain_email_references WHERE fixture_id=?').get(s.fixture_id).n>=50)continue;db.prepare('INSERT OR IGNORE INTO drain_email_references VALUES(?,?,?,?,?)').run(s.fixture_id,s.cycle_id,s.started_at,s.depth_mm,s.duration_seconds);}}
export function enqueueEmailEvents(db,events){
 if(!events.length)return;
 const preferences=db.prepare('SELECT * FROM drain_email_preferences WHERE fixture_id=? AND (enabled=1 OR json_array_length(emergency_contacts)>0)');
 const recent=db.prepare(`SELECT 1 FROM drain_email_outbox WHERE fixture_id=? AND channel='email' AND created_at>? AND status!='cancelled'
  AND ((user_id=? AND contact_id IS NULL AND ? IS NULL) OR recipient=?) LIMIT 1`);
 const insert=db.prepare('INSERT OR IGNORE INTO drain_email_outbox(id,fixture_id,user_id,event,available_at,created_at,recipient,contact_id) VALUES(?,?,?,?,?,?,?,?)');
 for(const event of events)for(const pref of preferences.all(event.fixture_id)){
  const threshold=pref.threshold_seconds??event.threshold_seconds;
  if(event.elapsed_seconds<threshold)continue;
  const jobs=[];
  if(pref.enabled)jobs.push({email:null,contactId:null});
  for(const contact of JSON.parse(pref.emergency_contacts)){
   if(contact.email_enabled!==true||!contact.email)continue;
   jobs.push({email:contact.email,contactId:contact.subscription_id??contact.id});
  }
  const now=Date.now();
  for(const {email,contactId} of jobs){
   if(recent.get(event.fixture_id,now-3600000,pref.user_id,contactId,email))continue;
   const suffix=contactId?`:email:contact:${email}`:'';
   const id=createHash('sha256').update(`${pref.user_id}:${event.event_key}${suffix}`).digest('hex');
   insert.run(id,event.fixture_id,pref.user_id,JSON.stringify({...event,email_threshold_seconds:threshold}),now,now,email,contactId);
  }
 }
}
export class SQLiteEmailStore{
 constructor(db){this.db=db;createEmailTables(db);}
 async references(fixture){return this.db.prepare('SELECT * FROM drain_email_references WHERE fixture_id=? ORDER BY started_at LIMIT 50').all(fixture);}
 async preference(fixture,user){const p=this.db.prepare('SELECT * FROM drain_email_preferences WHERE fixture_id=? AND user_id=?').get(fixture,user);return p?{...p,enabled:Boolean(p.enabled),emergency_contacts:JSON.parse(p.emergency_contacts)}:null;}
 async savePreference(p){this.db.prepare('INSERT INTO drain_email_preferences(fixture_id,user_id,enabled,threshold_seconds) VALUES(?,?,?,?) ON CONFLICT(fixture_id,user_id) DO UPDATE SET enabled=excluded.enabled,threshold_seconds=excluded.threshold_seconds').run(p.fixture_id,p.user_id,Number(p.enabled),p.threshold_seconds);}
 async addEmergencyContact(fixture,user,contact,limit){
  return this.db.prepare(`INSERT INTO drain_email_preferences(fixture_id,user_id,emergency_contacts) VALUES(?,?,json_array(json(?)))
   ON CONFLICT(fixture_id,user_id) DO UPDATE SET emergency_contacts=json_insert(emergency_contacts,'$[#]',json(?))
   WHERE json_array_length(emergency_contacts)< ? AND NOT EXISTS(
    SELECT 1 FROM json_each(emergency_contacts) WHERE json_extract(value,'$.email')=?)`)
   .run(fixture,user,JSON.stringify(contact),JSON.stringify(contact),limit,contact.email).changes===1;
 }
 async removeEmergencyContact(fixture,user,id){
  this.db.prepare(`UPDATE drain_email_preferences SET emergency_contacts=(
   SELECT json_group_array(json(value)) FROM json_each(emergency_contacts) WHERE json_extract(value,'$.id')<>?)
   WHERE fixture_id=? AND user_id=?`).run(id,fixture,user);
 }
 async setEmergencyContactEmail(fixture,user,id,patch){
  return this.db.prepare(`UPDATE drain_email_preferences SET emergency_contacts=(
    SELECT json_group_array(json(CASE
     WHEN json_extract(value,'$.id')=? AND (coalesce(json_extract(value,'$.email_enabled'),0)<>?
      OR (? IS NOT NULL AND json_extract(value,'$.email') IS NOT ?))
     THEN json_patch(value,?) ELSE value END))
    FROM json_each(emergency_contacts))
    WHERE fixture_id=? AND user_id=? AND EXISTS(
     SELECT 1 FROM json_each(emergency_contacts) WHERE json_extract(value,'$.id')=?
      AND (?=0 OR coalesce(?,json_extract(value,'$.email')) IS NOT NULL))
    AND NOT EXISTS(SELECT 1 FROM json_each(emergency_contacts)
     WHERE json_extract(value,'$.id')<>? AND json_extract(value,'$.email')=?)`)
   .run(id,Number(patch.email_enabled),patch.email??null,patch.email??null,JSON.stringify(patch),
    fixture,user,id,Number(patch.email_enabled),patch.email??null,id,patch.email??null).changes===1;
 }
 async claim(limit){
  const now=Date.now();
  this.db.prepare("UPDATE drain_email_outbox SET status='expired' WHERE status IN('pending','sending') AND created_at<=?").run(now-23*3600000);
  const rows=this.db.prepare("SELECT * FROM drain_email_outbox WHERE channel='email' AND status IN('pending','sending') AND available_at<=? AND attempts<5 ORDER BY created_at LIMIT ?").all(now,limit),claimed=[];
  for(const row of rows){const lease=randomUUID();if(this.db.prepare("UPDATE drain_email_outbox SET status='sending',attempts=attempts+1,lease_token=?,available_at=? WHERE id=? AND available_at<=? AND status IN('pending','sending')").run(lease,now+90000,row.id,now).changes)claimed.push({...row,event:JSON.parse(row.event),payload:row.payload?JSON.parse(row.payload):null,attempts:row.attempts+1,lease_token:lease});}return claimed;
 }
 async seal(job,recipient,payload){if(this.db.prepare("UPDATE drain_email_outbox SET recipient=coalesce(recipient,?),payload=coalesce(payload,?) WHERE id=? AND lease_token=? AND status='sending'").run(recipient,JSON.stringify(payload),job.id,job.lease_token).changes!==1)throw Error('Email lease expired');}
 async finish(job,status,provider=null){if(this.db.prepare("UPDATE drain_email_outbox SET status=?,provider_id=? WHERE id=? AND lease_token=? AND status='sending'").run(status,provider,job.id,job.lease_token).changes!==1)throw Error('Email lease expired');}
 async retry(job){this.db.prepare("UPDATE drain_email_outbox SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,available_at=? WHERE id=? AND lease_token=? AND status='sending'").run(Date.now()+Math.min(3600000,30000*2**job.attempts),job.id,job.lease_token);}
}
