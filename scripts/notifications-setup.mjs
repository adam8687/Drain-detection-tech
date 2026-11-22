// Prepare or activate owner notifications without printing server credentials.
import {readFile,writeFile,chmod,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {parseEnv} from 'node:util';
import {randomBytes} from 'node:crypto';
import {providerConfiguration} from '../supabase/functions/_shared/email-notifications.js';
const root=new URL('../',import.meta.url),apply=process.argv.includes('--apply'),activate=process.argv.includes('--activate')||process.argv.includes('--activate-email'),secretsOnly=process.argv.includes('--secrets-only');
const read=path=>readFile(new URL(path,root),'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;});
const encode=env=>Object.entries(env).map(([key,value])=>`${key}=${JSON.stringify(value)}`).join('\n')+'\n';
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const keys=['DRAIN_APP_URL','DRAIN_EMAIL_ENABLED','DRAIN_EMAIL_FROM','RESEND_API_KEY','DRAIN_EMAIL_WORKER_TOKEN'];
async function privateWrite(path,body){const url=new URL(path,root);await writeFile(url,body,{mode:0o600});await chmod(url,0o600);}
function cli(args){const r=spawnSync('supabase',args,{cwd:fileURLToPath(root),encoding:'utf8',timeout:120000});if(r.error||r.status!==0)throw Error('Supabase setup step failed. Check CLI login/project access. Provider secrets were not printed.');}
let temporary;
try{
 const backendText=await read('backend/.env'),backend=parseEnv(backendText),cloud=parseEnv(await read('supabase/.env.cloud'));
 const env={...backend,...cloud,...process.env};
 // Nonempty credentials freshly added in backend/.env take priority over cloud placeholders.
 for(const key of keys)if(backend[key]&&!key.endsWith('_ENABLED'))env[key]=backend[key];
 env.DRAIN_APP_URL||='https://drain-detection-tech.vercel.app';env.DRAIN_EMAIL_WORKER_TOKEN||=randomBytes(32).toString('base64url');
 if(env.DRAIN_EMAIL_WORKER_TOKEN.length<32)throw Error('Worker token must have at least 32 characters');
 if(process.argv.includes('--activate-sms'))throw Error('SMS delivery has been retired. Use --activate-email for email.');
 if(activate)env.DRAIN_EMAIL_ENABLED='true';
 env.DRAIN_EMAIL_ENABLED||='false';
 const configured=providerConfiguration(env);
 if(activate&&!configured.emailEnabled)throw Error('Add the Resend key and verified sender to backend/.env before email activation.');
 console.log(JSON.stringify({email_ready:configured.emailEnabled,live_changes:apply},null,2));
 if(!apply){console.log('Use --apply to prepare the hosted backend, --activate-email to enable sending, and --secrets-only on an already-prepared deployment.');process.exit(0);}
 if(!env.SUPABASE_URL||!cloud.DRAIN_ADMIN_TOKEN)throw Error('This checkout needs its existing Supabase URL and private cloud admin setup.');
 const ref=new URL(env.SUPABASE_URL).hostname.split('.')[0];
 const linked=(await read('supabase/.temp/project-ref')).trim();if(linked!==ref)throw Error('Supabase CLI must be linked to the same project as backend/.env.');
 // Apply notification schema changes without applying unrelated pending migrations.
 if(!secretsOnly){
  cli(['db','query','--linked','--file','supabase/migrations/202611220002_email_only_alerts.sql']);
 }
 for(const key of keys)cloud[key]=env[key]||'';
 cloud.DRAIN_SMS_ENABLED='false'; // Older hosted builds still read this flag.
 await privateWrite('supabase/.env.cloud',encode(cloud));
 let updated=backendText;
 for(const key of keys){const line=`${key}=${JSON.stringify(cloud[key])}`,pattern=new RegExp(`^${key}=.*$`,'m');updated=pattern.test(updated)?updated.replace(pattern,()=>line):updated+'\n'+line+'\n';}
 await privateWrite('backend/.env',updated);
 cli(['secrets','set','--project-ref',ref,'--env-file',fileURLToPath(new URL('supabase/.env.cloud',root))]);
 if(!secretsOnly)cli(['functions','deploy','drain-api','--project-ref',ref,'--no-verify-jwt','--use-api']);
 const base=env.SUPABASE_URL.replace(/\/$/,'')+'/functions/v1/drain-api';
 if(!secretsOnly){
 temporary=await mkdtemp(join(tmpdir(),'drain-notifications-'));
 const vault=`create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
do $vault$ declare existing uuid; begin
 select id into existing from vault.secrets where name='drain_email_api_url' limit 1;
 if existing is null then perform vault.create_secret(${quote(base)},'drain_email_api_url');else perform vault.update_secret(existing,${quote(base)});end if;
 select id into existing from vault.secrets where name='drain_email_worker_token' limit 1;
 if existing is null then perform vault.create_secret(${quote(env.DRAIN_EMAIL_WORKER_TOKEN)},'drain_email_worker_token');else perform vault.update_secret(existing,${quote(env.DRAIN_EMAIL_WORKER_TOKEN)});end if;
end; $vault$;\n`;
 const file=join(temporary,'retry.sql');await writeFile(file,vault+await read('supabase/operations/schedule-email-delivery.sql'),{mode:0o600});
 cli(['db','query','--linked','--file',file]);
 }
 const r=await fetch(base+'/api/v1/internal/email-deliveries',{method:'POST',headers:{Authorization:`Bearer ${env.DRAIN_EMAIL_WORKER_TOKEN}`,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(30000)});
 // Delivery remains disabled during preparation. Activation can process real queued owner alerts.
 if(!r.ok)throw Error('Deployed worker verification failed.');
 console.log(secretsOnly?'Updated private notification credentials on the existing hosted function.':'Notification database update, hosted function, private credentials and retry schedule configured.');
 console.log(JSON.stringify({email_enabled:configured.emailEnabled,worker_verified:true}));
}catch(error){console.error(error.message);process.exitCode=1;}finally{if(temporary)await rm(temporary,{recursive:true,force:true});}
