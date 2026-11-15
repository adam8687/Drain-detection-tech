// Focused owner-notification UI check. Uses the product-test build and simulated identity.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createApp} from '../../backend/src/server.js';
import {configFromEnv} from '../../backend/src/config.js';
const root=fileURLToPath(new URL('../../',import.meta.url));
const userId=randomUUID(),token=`eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({sub:userId,exp:Math.floor(Date.now()/1000)+7200,aud:'authenticated'})).toString('base64url')}.test`;
const session={access_token:token,refresh_token:'test-refresh',expires_in:7200,expires_at:Math.floor(Date.now()/1000)+7200,token_type:'bearer',user:{id:userId,aud:'authenticated',role:'authenticated',email:'owner@example.test',app_metadata:{},user_metadata:{},created_at:new Date().toISOString()}};
const app=createApp({...configFromEnv({STORAGE_BACKEND:'sqlite',SQLITE_PATH:':memory:'}),apiKey:'test-admin' },undefined,{verifyUser:async t=>t===token?userId:null});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const backend=`http://127.0.0.1:${app.server.address().port}`,port=3136,origin=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,[root+'web/node_modules/next/dist/bin/next','start','--port',String(port)],{cwd:root+'web',env:{...process.env,DRAIN_TEST_DIST_DIR:'.next-product-test',BACKEND_URL:backend,SUPABASE_FUNCTION_URL:'',DRAIN_VIEWER_TOKEN:''},stdio:'ignore'});
let browser;
try{
 const response=await fetch(backend+'/api/v1/devices',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({device_id:'notification-sink',name:'Kitchen'})});assert.equal(response.status,201);
 const id=randomUUID();await app.store.insert({record_id:id,fixture_id:'notification-sink',record_type:'monitoring',data_source:'sensor',recording_status:'recording',created_at:new Date().toISOString(),calibration:{empty_distance_mm:300},measurements:[],result:null});
 let ready=false;for(let i=0;i<80;i++){try{if((await fetch(origin+'/login')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}assert.ok(ready);
 browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 await mkdir('/tmp/drain-sms-ui',{recursive:true});
 for(const width of [1440,320]){
  const context=await browser.newContext({viewport:{width,height:1000}});
  await context.addInitScript(value=>localStorage.setItem('sb-product-test-auth-token',JSON.stringify(value)),session);
  const page=await context.newPage();page.setDefaultTimeout(12000);
  await page.route('https://product-test.supabase.co/**',route=>route.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':origin},body:JSON.stringify(session.user)}));
  await page.goto(`${origin}/live-demo?fixture=notification-sink&record=${id}&source=sensor`);
  const email=page.getByLabel('Email me when drainage takes unusually long',{exact:true}),sms=page.getByLabel('Text me when drainage takes unusually long',{exact:true}),phone=page.getByLabel('Mobile number (with country code)',{exact:true});
  await email.waitFor();await email.check();
  await phone.fill('+15125550124');await sms.check();await page.getByRole('button',{name:'Save SMS settings',exact:true}).click();await page.getByText('SMS preference saved.',{exact:true}).waitFor();
  await page.reload();await phone.waitFor();await page.waitForFunction(()=>document.querySelector('input[type="tel"]')?.value==='+15125550124');assert.equal(await sms.isChecked(),true);assert.equal(await email.isChecked(),true);
  await page.screenshot({path:`/tmp/drain-sms-ui/settings-${width}.png`,fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'page must fit phone width');
  await sms.uncheck();await page.getByRole('button',{name:'Save SMS settings',exact:true}).click();await page.getByText('SMS preference saved.',{exact:true}).waitFor();
  assert.equal(await email.isChecked(),true);await context.close();console.log(`PASS notification settings at ${width}px: email, SMS opt-in, phone persistence and independent opt-out.`);
 }
}finally{await browser?.close();server.kill('SIGTERM');await app.close();}
