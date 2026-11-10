import { readFile, writeFile, mkdir, chmod, rename } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import { connect } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { configFromEnv } from '../backend/src/config.js';
import { SupabaseAccessStore } from '../supabase/functions/_shared/access-storage.js';
import { hashDeviceKey } from '../backend/src/auth.js';
import { api, settings, firmwareHeader, prepareRecord, checkTables } from '../device/wifi/testing.js';
import { selectTrustedRoot } from './cloud-tls.js';

const root = new URL('../', import.meta.url), command = process.argv[2];
const location = relative => new URL(relative, root);
async function text(relative) { try { return await readFile(location(relative),'utf8'); } catch(e) {if(e.code==='ENOENT') return '';throw e;} }
async function privateFile(relative, content) {
  const url=location(relative), temp=new URL(url.href+'.tmp');
  await mkdir(new URL('./',url),{recursive:true});
  await writeFile(temp,content,{mode:0o600});await chmod(temp,0o600);await rename(temp,url);
}
const envText = env => Object.entries(env).map(([key,value])=>`${key}=${JSON.stringify(value)}`).join('\n')+'\n';
function cli(args) {
  const result=spawnSync('supabase',args,{cwd:fileURLToPath(root),encoding:'utf8',timeout:120000});
  if(result.error || result.status!==0) throw Error('Supabase CLI step failed. Check supabase login and project permissions; no credential output was printed.');
}
function rootCertificate(host) {
  return new Promise((resolve,reject)=>{
    const socket=connect({host,port:443,servername:host,rejectUnauthorized:true},()=>{
      try {
        if(!socket.authorized) throw Error('Supabase TLS verification failed');
        let cert=socket.getPeerCertificate(true);const chain=[];
        for(let n=0;n<10;n++) {
          if(!cert?.raw) break;
          chain.push(cert.raw);
          if(cert.issuerCertificate?.fingerprint256===cert.fingerprint256) break;
          cert=cert.issuerCertificate;
        }
        const pem=selectTrustedRoot(chain);socket.end();resolve(pem);
      }catch(e){socket.destroy();reject(e);}
    });
    socket.setTimeout(15000,()=>socket.destroy(Error('TLS connection timed out')));
    socket.once('error',()=>reject(Error('Cannot verify Supabase TLS certificate. Check Internet access.')));
  });
}

try {
  if(Number(process.versions.node.split('.')[0])<24) throw Error('Use Node.js 24 or newer.');
  if(command==='start') {
    const web=parseEnv(await text('web/.env.cloud.local'));
    if(!web.SUPABASE_FUNCTION_URL) throw Error('Run cloud:deploy then cloud:configure first.');
    // Start only the frontend. Server credentials/admin tokens are not passed to it.
    const clean={...process.env};for(const key of ['SUPABASE_SECRET_KEY','API_KEY','OWNER_TOKEN','DRAIN_ADMIN_TOKEN','DRAIN_SERVICE_KEY']) delete clean[key];
    const wifi=parseEnv(await text('device/wifi/.env'));
    const child=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','--port',wifi.WEB_PORT||'3000'],{cwd:fileURLToPath(location('web/')),stdio:'inherit',env:{...clean,...web}});
    child.on('error',()=>{console.error('Cannot start frontend. Run npm --prefix web ci.');process.exitCode=1;});
    child.on('exit',code=>{process.exitCode=code??1;});
    for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill(signal));
  } else {
    const config=configFromEnv({...process.env,STORAGE_BACKEND:'supabase'});
    const ref=new URL(config.supabaseUrl).hostname.split('.')[0];
    const base=`${config.supabaseUrl}/functions/v1/drain-api`;
    let secrets=parseEnv(await text('supabase/.env.cloud'));
    if(command==='deploy') {
      await checkTables(config);
      if(!secrets.DRAIN_ADMIN_TOKEN) {
        let existing=false;
        try {const response=await fetch(`${base}/health`,{signal:AbortSignal.timeout(10000)});existing=response.ok && (await response.json()).runtime==='supabase-edge';}catch{}
        if(existing) throw Error('Cloud function already exists but this checkout lacks its admin setup. Use an authorized owner session or the maintainer’s private setup; admin credentials were not rotated.');
      }
      secrets={...secrets,DRAIN_ADMIN_TOKEN:secrets.DRAIN_ADMIN_TOKEN||randomBytes(32).toString('base64url'),DRAIN_SERVICE_KEY:config.supabaseKey};
      await privateFile('supabase/.env.cloud',envText(secrets));
      cli(['secrets','set','--project-ref',ref,'--env-file',fileURLToPath(location('supabase/.env.cloud'))]);
      cli(['functions','deploy','drain-api','--project-ref',ref,'--no-verify-jwt','--use-api']);
      console.log('Deployed authenticated drain-api to your existing Supabase project. No table/schema change.');
      console.log(`Cloud endpoint: ${base}`);
    } else if(command==='configure') {
      if(!secrets.DRAIN_ADMIN_TOKEN) throw Error('Run cloud:deploy first.');
      const health=await fetch(`${base}/ready`,{signal:AbortSignal.timeout(15000)});
      if(!health.ok || (await health.json()).runtime!=='supabase-edge') throw Error('Cloud function not ready. Deploy and verify it before switching the board.');
      const wifiSource=await text('device/wifi/.env');
      if(!wifiSource) throw Error('Run wifi:init and fill device/wifi/.env first.');
      const wifi=parseEnv(wifiSource);
      const state=JSON.parse(await text('device/wifi/data/state.json')||'{"fixtures":{}}');
      const fixture=process.argv[3]||state.fixtures[state.current]?.fixture||'friend-sink';
      const oldSlot=Object.keys(state.fixtures).findLast(key=>state.fixtures[key].fixture===fixture && state.fixtures[key].recordId);
      const old=oldSlot ? state.fixtures[oldSlot]:null;
      const rootCa=await rootCertificate(new URL(config.supabaseUrl).hostname);
      await privateFile('device/wifi/data/supabase-root-ca.pem',rootCa);
      const cloudConfig=settings(process.env,{...wifi,CLOUD_API_URL:base});cloudConfig.rootCa=rootCa;
      let record,key;
      if(old) {
        const remote=await api(base,secrets.DRAIN_ADMIN_TOKEN,`/records/${old.recordId}`);
        if(remote.record.fixture_id!==fixture || remote.record.data_source!=='sensor' || remote.record.recording_status!=='recording') throw Error('The existing record cannot be migrated safely. Review/finish it before creating a new cloud recording.');
        const accessStore=new SupabaseAccessStore(config.supabaseUrl,config.supabaseKey);
        const registered=await accessStore.get('device_keys',hashDeviceKey(old.key));
        if(!registered || registered.revoked_at || registered.device_id!==fixture) throw Error('Existing sensor key is invalid; preserve pending board data and review access before migration.');
        record=remote.record;key=old.key;
        const oldBase=oldSlot.split('|')[0];
        if(oldBase!==base) cloudConfig.previousBase=oldBase;
      } else {
        const result=await prepareRecord({config:cloudConfig,token:secrets.DRAIN_ADMIN_TOKEN,fixture,type:'monitoring',previous:{saveKey:async saved=>{
          state.fixtures[`${base}|${fixture}`]={fixture,key:saved};await privateFile('device/wifi/data/state.json',JSON.stringify(state,null,2)+'\n');
        }}});record=result.record;key=result.key;
      }
      // Preserve existing Wi-Fi password and sensor mode while changing only routing.
      let updated=wifiSource;
      for(const [name,value] of Object.entries({CLOUD_API_URL:base,API_ROOT_CA_FILE:'device/wifi/data/supabase-root-ca.pem'})) {
        const regex=new RegExp(`^${name}=.*$`,'gm');
        if(regex.test(updated)){regex.lastIndex=0;updated=updated.replace(regex,`${name}=${JSON.stringify(value)}`);}else updated+=`\n${name}=${JSON.stringify(value)}\n`;
      }
      await privateFile('device/wifi/.env',updated);
      state.current=`${base}|${fixture}`;state.fixtures[state.current]={fixture,key,recordId:record.record_id,type:record.record_type};
      await privateFile('device/wifi/data/state.json',JSON.stringify(state,null,2)+'\n');
      await privateFile('device/us100_wifi_upload/secrets.h',firmwareHeader(cloudConfig,record.record_id,key));
      let viewer;
      const previousWeb=parseEnv(await text('web/.env.cloud.local'));
      if(previousWeb.SUPABASE_FUNCTION_URL===base && previousWeb.NEXT_PUBLIC_DEFAULT_FIXTURE_ID===fixture && previousWeb.DRAIN_VIEWER_TOKEN?.startsWith('dv_')) {
        try{await api(base,previousWeb.DRAIN_VIEWER_TOKEN,`/records?fixture_id=${fixture}`);viewer=previousWeb.DRAIN_VIEWER_TOKEN;}catch{}
      }
      viewer||=(await api(base,secrets.DRAIN_ADMIN_TOKEN,`/devices/${fixture}/view-key`,{})).key;
      await privateFile('web/.env.cloud.local',envText({SUPABASE_FUNCTION_URL:base,DRAIN_VIEWER_TOKEN:viewer,NEXT_PUBLIC_DEFAULT_FIXTURE_ID:fixture,NEXT_PUBLIC_DEFAULT_DATA_SOURCE:'sensor'}));
      console.log(`Configured ESP HTTPS and frontend for ${fixture}, record ${record.record_id}. Existing backend/frontend environment files preserved.`);
      console.log('The generated migration header preserves an old pending point’s record, ID, timestamp and body. After recovery, finish that record and prepare a new one.');
      console.log('No credential values were printed. Start only the frontend with npm run cloud:start.');
    } else if(command==='check') {
      const health=await fetch(`${base}/ready`,{signal:AbortSignal.timeout(15000)});
      if(!health.ok || (await health.json()).runtime!=='supabase-edge') throw Error('Supabase cloud function is not ready.');
      const anonymous=await fetch(`${base}/api/v1/records`,{signal:AbortSignal.timeout(15000)});
      if(anonymous.status!==401) throw Error('Cloud function did not reject anonymous database access.');
      await api(base,secrets.DRAIN_ADMIN_TOKEN,'/devices');
      const web=parseEnv(await text('web/.env.cloud.local'));
      if(web.DRAIN_VIEWER_TOKEN) await api(base,web.DRAIN_VIEWER_TOKEN,`/records?fixture_id=${web.NEXT_PUBLIC_DEFAULT_FIXTURE_ID}`);
      console.log('PASS: hosted function, Supabase storage, anonymous rejection and configured authenticated access. No measurements written.');
    } else throw Error('Use cloud:deploy, cloud:configure, cloud:start or cloud:check.');
  }
}catch(error){console.error(error.message);process.exitCode=1;}
