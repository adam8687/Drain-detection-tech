// Operator setup only. Secrets are read from the environment and never printed.
import {readFile}from'node:fs/promises';import{parseEnv}from'node:util';
const stored=parseEnv(await readFile(new URL('../backend/.env',import.meta.url),'utf8').catch(()=>''));
const env={...stored,...process.env},app=new URL(env.DRAIN_APP_URL||'https://drain-detection-tech.vercel.app');
if(app.protocol!=='https:')throw Error('Use the production HTTPS application URL');
const wanted={site_url:app.origin,uri_allow_list:[app.origin+'/login',app.origin+'/reset-password'].join(','),external_email_enabled:true,mailer_autoconfirm:false,mailer_secure_email_change_enabled:true};
const smtp=process.argv.includes('--smtp'),apply=process.argv.includes('--apply');
if(smtp){const from=(env.DRAIN_AUTH_EMAIL_FROM||env.DRAIN_EMAIL_FROM||'').match(/<?([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>?$/)?.[1];if(!env.RESEND_API_KEY||!from)throw Error('Set the verified sender and Resend credential in private server configuration first');Object.assign(wanted,{smtp_host:'smtp.resend.com',smtp_port:'465',smtp_user:'resend',smtp_pass:env.RESEND_API_KEY,smtp_admin_email:from,smtp_sender_name:'Drain Monitor'});}
if(!apply){console.log(JSON.stringify({application:app.origin,auth:{...wanted,...smtp?{smtp_pass:'[server credential omitted]'}:{}},management_access_available:Boolean(env.SUPABASE_ACCESS_TOKEN),live_settings_changed:false},null,2));process.exit(0);}
if(!env.SUPABASE_ACCESS_TOKEN)throw Error('Hosted setup needs authorized Supabase project-management access; a database service key cannot change Auth settings');
const ref=new URL(env.SUPABASE_URL).hostname.split('.')[0],url=`https://api.supabase.com/v1/projects/${ref}/config/auth`,headers={Authorization:`Bearer ${env.SUPABASE_ACCESS_TOKEN}`,'Content-Type':'application/json'};
const current=await fetch(url,{headers,signal:AbortSignal.timeout(10000)});if(!current.ok)throw Error('Cannot read project Auth settings');const settings=await current.json();
wanted.uri_allow_list=[...new Set([...(settings.uri_allow_list||'').split(',').filter(Boolean),...wanted.uri_allow_list.split(',')])].join(',');
const result=await fetch(url,{method:'PATCH',headers,body:JSON.stringify(wanted),signal:AbortSignal.timeout(10000)});if(!result.ok)throw Error('Auth settings update failed; credentials were not printed');console.log('Updated production sign-in URLs and confirmation settings'+(smtp?' with the configured SMTP sender.':'. SMTP still needs configuration.'));
