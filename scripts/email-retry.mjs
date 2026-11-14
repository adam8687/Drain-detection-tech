// Operator-only retry command; normal sends are triggered by sensor ingestion.
import{readFile}from'node:fs/promises';import{parseEnv}from'node:util';
const env={...parseEnv(await readFile(new URL('../backend/.env',import.meta.url),'utf8').catch(()=>'')),...process.env};
const base=env.SUPABASE_FUNCTION_URL||(env.SUPABASE_URL?env.SUPABASE_URL+'/functions/v1/drain-api':env.API_BASE_URL),token=env.DRAIN_EMAIL_WORKER_TOKEN;
if(!base||!token||token.length<32)throw Error('Email worker deployment is not configured');
const response=await fetch(base.replace(/\/$/,'')+'/api/v1/internal/email-deliveries',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(60000)});
if(!response.ok)throw Error('Email worker request failed; no credentials were printed');console.log(await response.json());
