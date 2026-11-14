// Run against an isolated local backend and a production build. Authentication
// provider responses and physical readings are simulated; the UI and API are real.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createApp } from '../../backend/src/server.js';
import { configFromEnv } from '../../backend/src/config.js';
const {chromium,webkit,firefox,devices}=await import(process.env.PLAYWRIGHT_MODULE_PATH ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const root=fileURLToPath(new URL('../../',import.meta.url));
const build = async env => {
  const child=spawn(process.execPath,[root+'web/node_modules/next/dist/bin/next','build'],{cwd:root+'web',env,stdio:['ignore','pipe','pipe']});
  let log='';child.stdout.on('data',c=>log+=c);child.stderr.on('data',c=>log+=c);
  const code=await new Promise(r=>child.once('exit',r));assert.equal(code,0,log);
};
// Keep test identity settings out of the normal application build.
const originals=await Promise.all(['next-env.d.ts','tsconfig.json'].map(async file=>({file,body:await readFile(root+'web/'+file,'utf8')})));
const testEnv={...process.env,DRAIN_TEST_DIST_DIR:'.next-product-test',NEXT_PUBLIC_SUPABASE_URL:'https://product-test.supabase.co',NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_product_test'};
if(process.env.PRODUCT_TEST_SKIP_BUILD!=='1')await build(testEnv);
const output=process.env.PRODUCT_TEST_OUTPUT || '/tmp/drain-product-tests';
await mkdir(output,{recursive:true});
const userId=randomUUID(), token=`eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({sub:userId,exp:Math.floor(Date.now()/1000)+7200,aud:'authenticated'})).toString('base64url')}.test`;
const session={access_token:token,refresh_token:'local-test-refresh',expires_in:7200,expires_at:Math.floor(Date.now()/1000)+7200,token_type:'bearer',user:{id:userId,aud:'authenticated',role:'authenticated',email:'owner@example.test',app_metadata:{},user_metadata:{},created_at:new Date().toISOString()}};
const app=createApp({...configFromEnv({STORAGE_BACKEND:'sqlite',SQLITE_PATH:':memory:'}),apiKey:'local-product-test-admin' },undefined,{verifyUser:async t=>t===token?userId:null});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const backend=`http://127.0.0.1:${app.server.address().port}`, port=Number(process.env.PRODUCT_TEST_PORT||3127), origin=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,[root+'web/node_modules/next/dist/bin/next','start','--port',String(port)],{cwd:root+'web',env:{...testEnv,BACKEND_URL:backend,SUPABASE_FUNCTION_URL:'',DRAIN_VIEWER_TOKEN:''},stdio:['ignore','pipe','pipe']});
let serverLog=''; server.stdout.on('data',c=>serverLog+=c); server.stderr.on('data',c=>serverLog+=c);
const sample=(ms,depth=0,failed=false)=>({reading_id:randomUUID(),timestamp:new Date(ms).toISOString(),sensor:failed?{distance_mm:null,status:'timeout'}:{distance_mm:300-depth,status:'ok'}});
const results=[];
const profiles=[
 {name:'chrome-desktop',engine:chromium,options:{viewport:{width:1440,height:1000}}},
 {name:'android-phone',engine:chromium,options:{...devices['Pixel 7']}},
 {name:'small-phone-320',engine:chromium,options:{viewport:{width:320,height:568},isMobile:true,hasTouch:true,deviceScaleFactor:2}},
 {name:'iphone-webkit',engine:webkit,options:{...devices['iPhone 13']}},
 {name:'iphone-se-webkit',engine:webkit,options:{...devices['iPhone SE']}},
 {name:'ipad-webkit',engine:webkit,options:{...devices['iPad Mini']}},
 {name:'safari-engine-desktop',engine:webkit,options:{viewport:{width:1280,height:900}}},
 {name:'firefox-desktop',engine:firefox,options:{viewport:{width:1365,height:900}}},
];
async function journey(profile,index){
 let browser,context,page;const checks=[];const errors=[];const injectedFailurePaths=new Set();const authRedirects={};const fixture=`product-${index}`;let sensorKey;let credentialRequests=0;let offline=false;let streamTimer;let streamWork=Promise.resolve();
 try {
  browser=await profile.engine.launch({...((profile.engine===chromium && process.env.CHROME_PATH)?{executablePath:process.env.CHROME_PATH}:{}),headless:true,timeout:20000});
  context=await browser.newContext({...profile.options,reducedMotion:'reduce'});
  page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
  page.on('console',message=>{if(message.type()==='error'&&/hydration|Minified React error|Cannot read|TypeError/i.test(message.text()))errors.push(message.text());});
  if(process.env.PRODUCT_TEST_DEBUG)page.on('requestfailed',r=>console.log('Failed request',new URL(r.url()).origin,new URL(r.url()).pathname,r.failure()?.errorText));
  await page.route(/^https:\/\//,async route=>{
    const req=route.request(),url=new URL(req.url());
    if(process.env.PRODUCT_TEST_DEBUG)console.log('Identity mock',req.method(),url.origin,url.pathname);
    const headers={'access-control-allow-origin':origin,'access-control-allow-headers':'authorization,apikey,content-type,x-client-info,x-supabase-api-version','access-control-allow-methods':'GET,POST,OPTIONS'};
    if(req.method()==='OPTIONS')return route.fulfill({status:204,headers,body:''});
    if(url.pathname.endsWith('/auth/v1/signup')){authRedirects.signup=url.searchParams.get('redirect_to');return route.fulfill({status:200,headers,contentType:'application/json',body:JSON.stringify(session.user)});}
    if(url.pathname.endsWith('/auth/v1/recover')){authRedirects.recovery=url.searchParams.get('redirect_to');return route.fulfill({status:200,headers,contentType:'application/json',body:'{}'});}
    if(url.pathname.endsWith('/auth/v1/token')) {
      const body=req.postDataJSON();await route.fulfill({status:body.password==='test-password'?200:400,headers,contentType:'application/json',body:JSON.stringify(body.password==='test-password'?session:{error:'invalid_grant',error_description:'Email or password was not recognized'})});
    } else if(url.pathname.endsWith('/auth/v1/user'))await route.fulfill({status:200,headers,contentType:'application/json',body:JSON.stringify(session.user)});
    else await route.abort();
  });
  await page.route('**/api/backend/**',route=>{if(offline){injectedFailurePaths.add(new URL(route.request().url()).pathname);return route.abort();}return route.continue();});
  page.on('request',req=>{if(/\/devices\/[^/]+\/keys(?:\?|$)/.test(req.url()))credentialRequests++;});
  const check=async(name,fn)=>{await fn();checks.push(name);};
  const layout=async label=>check(`layout:${label}`,async()=>{
    await page.evaluate(()=>document.fonts.ready);
    const size=await page.evaluate(()=>({width:window.innerWidth,content:document.documentElement.scrollWidth}));assert.ok(size.content<=size.width+1,`Horizontal overflow: ${JSON.stringify(size)}`);
    assert.equal(await page.locator('h1').count(),1);
    assert.doesNotMatch(await page.locator('body').innerText(),/server key|sensor key|backend (?:access )?token|SENSOR_KEY|API_BASE_URL|npm run|\.env\b/i,'customer pages must not ask for technical credentials or commands');
    await page.waitForFunction(()=>[...document.images].every(img=>img.complete&&img.naturalWidth>0));
    if(['chrome-desktop','small-phone-320','iphone-webkit'].includes(profile.name))await page.screenshot({path:`${output}/${profile.name}-${label}.png`,fullPage:true});
  });
  const active=async expected=>{
    for(let attempt=0;attempt<60;attempt++){
      const res=await fetch(backend+'/api/v1/sensor/active-record',{headers:{authorization:`Bearer ${sensorKey}`}});assert.equal(res.status,200);
      const row=(await res.json()).record;if(row&&(!expected||row.record_type===expected))return row;
      await new Promise(r=>setTimeout(r,100));
    }
    throw Error(`Device did not receive an active ${expected||'setup'} recording`);
  };
  const append=async(points,expected)=>{const row=await active(expected);for(const point of points){const res=await fetch(`${backend}/api/v1/records/${row.record_id}/measurements`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${sensorKey}`},body:JSON.stringify(point)});assert.equal(res.status,201,await res.text());}};
  await page.goto(origin+'/add-unit');
  await check('signed-out setup explains sign-in',()=>page.getByText('Sign in to register sensors to your account.',{exact:false}).waitFor());
  await page.getByLabel('Email',{exact:true}).fill('owner@example.test');await page.getByLabel('Password',{exact:true}).fill('test-password');
  await page.getByRole('button',{name:'Create account',exact:true}).click();await check('signup sends confirmation back to this app',async()=>{await page.getByRole('alert').filter({hasText:'Check your email'}).waitFor();assert.equal(authRedirects.signup,origin+'/login');});
  await page.getByRole('button',{name:'Forgot password?',exact:true}).click();await check('password recovery uses the app reset page',async()=>{await page.getByRole('alert').filter({hasText:'If an account uses this email'}).waitFor();assert.equal(authRedirects.recovery,origin+'/reset-password');});
  await page.getByLabel('Password',{exact:true}).fill('wrong-password');await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await check('incorrect password can be corrected',()=>page.getByRole('alert').filter({hasText:'not recognized'}).waitFor());
  await page.getByLabel('Password',{exact:true}).fill('test-password');await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByLabel('Unit ID',{exact:true}).fill(fixture);await page.getByLabel('Location',{exact:true}).fill('Kitchen / upstairs bathroom');await layout('registration');
  const navigation=page.getByLabel('Navigation menu',{exact:true});
  if(await navigation.isVisible()){
    await navigation.click();await page.getByRole('navigation',{name:'Mobile navigation',exact:true}).waitFor();
    await page.keyboard.press('Escape');assert.equal(await navigation.evaluate(el=>el.parentElement.open),false);checks.push('mobile menu keyboard dismissal');
  }
  await page.getByRole('button',{name:'Add and continue'}).click();await page.getByRole('button',{name:'Start connection test'}).waitFor();
  await check('registration writes a recoverable URL',()=>assert.ok(page.url().includes(`fixture=${fixture}`)));
  // Installer-side provisioning is outside the customer browser. No credential
  // response reaches the customer and the authentication rules stay unchanged.
  const provisioned=await fetch(`${backend}/api/v1/devices/${fixture}/keys`,{method:'POST',headers:{authorization:'Bearer local-product-test-admin','content-type':'application/json'},body:'{}'});assert.equal(provisioned.status,201);sensorKey=(await provisioned.json()).key;
  await check('device credential stays outside customer setup',async()=>{assert.equal(credentialRequests,0);assert.ok(!(await page.locator('body').innerText()).includes(sensorKey));});
  await page.getByRole('button',{name:'Start connection test'}).click();await page.reload();
  await check('refresh recovers active connection test',()=>page.getByRole('heading',{name:`Connect ${fixture}`}).waitFor());
  await append([sample(Date.now(),0,true)]);await check('one failed sensor prevents continuing',async()=>{await page.getByText('Check the sensor',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Continue',exact:true}).isDisabled(),true);});
  await append([sample(Date.now())]);await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByLabel('The sink is empty',{exact:false}).check();await page.getByRole('button',{name:'Record empty sink',exact:false}).click();
  await append(Array.from({length:20},(_,i)=>sample(Date.now()-30000+i*500,i%2?6:0)),'calibration');
  await check('unstable empty readings cannot finish calibration',async()=>{await page.getByText('Keep the sink empty and the sensor mount still.',{exact:true}).waitFor();assert.equal(await page.getByText('Build your drain profile',{exact:true}).count(),0);});
  await append(Array.from({length:20},(_,i)=>sample(Date.now()-10000+i*500)),'calibration');
  await page.getByRole('heading',{name:'Measure normal drainage',exact:true}).waitFor();
  await check('empty reference alone does not mark drainage calibration ready',async()=>{assert.equal(await page.getByRole('button',{name:'Start monitoring',exact:true}).count(),0);});
  await page.getByRole('button',{name:'Start water check',exact:true}).click();
  const observation=await active('monitoring');
  for(let run=1;run<=2;run++){
    await append([sample(Date.now(),40)],'monitoring');await page.getByText('Enough water. Turn the tap off.',{exact:true}).waitFor();
    await page.getByLabel('This drain is known to be clear and working normally.',{exact:true}).check();await page.getByLabel('The tap is off and the plug is still in.',{exact:true}).check();
    await append([sample(Date.now(),40)],'monitoring');await page.getByRole('button',{name:`Start drainage check ${run} of 2`,exact:true}).click();await page.getByRole('heading',{name:'Release the plug',exact:true}).waitFor();
    if(run===1){await page.reload();await check('reload resumes the same drainage capture',()=>page.getByRole('heading',{name:'Release the plug',exact:true}).waitFor());}
    assert.equal((await active('monitoring')).record_id,observation.record_id);
    for(const depth of [40,36,32,30,27.5,25,22.5,20,17.5,15,12.5,10,7.5,5,2.5,0,0,0]){await new Promise(r=>setTimeout(r,500));await append([sample(Date.now(),depth)],'monitoring');}
    if(run===1)await page.getByText('1 of 2 drainage checks saved · Empty reference saved',{exact:true}).waitFor();
  }
  await page.getByRole('heading',{name:`${fixture} is ready`}).waitFor();
  await check('two controlled checks save calibration without changing the sensor stream',async()=>{const all=await app.store.list({fixture_id:fixture},100);const cal=all.find(r=>r.record_type==='calibration'&&r.calibration?.drainage?.status==='ready');assert.ok(cal);assert.equal(cal.calibration.drainage.runs.length,2);assert.ok(cal.calibration.drainage.baseline_duration_seconds>0);assert.ok(cal.calibration.drainage.runs.every(r=>r.recording_id===observation.record_id));await page.getByText('Empty distance: 300 mm',{exact:true}).waitFor();});
  offline=true;await page.reload();await page.getByRole('button',{name:'Retry saved setup',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Start monitoring',exact:true}).count(),0);
  offline=false;await page.getByRole('button',{name:'Retry saved setup',exact:true}).click();
  await check('failed setup restore blocks actions and recovers',()=>page.getByRole('button',{name:'Start monitoring',exact:true}).waitFor());
  await page.getByRole('heading',{name:`${fixture} is ready`}).waitFor();await page.getByText('Two consistent tap-off checks are saved in this unit’s calibration for later alert comparisons.',{exact:true}).waitFor();await layout('ready');
  await page.screenshot({path:`${output}/${profile.name}-calibration-ready.png`,fullPage:true});
  await page.getByRole('button',{name:'Start monitoring',exact:true}).click();await page.waitForURL('**/live-demo?**');await page.getByText('Empty reference saved. Watching for water.',{exact:true}).first().waitFor();await layout('live-monitoring');
  await check('owner can save email preferences while sender setup is pending',async()=>{const checkbox=page.getByLabel('Email me when drainage takes unusually long',{exact:true});await checkbox.check();await page.getByText('Email preference saved.',{exact:true}).waitFor();await page.getByText('Email delivery is being set up.',{exact:false}).waitFor();});
  await check('hidden live page pauses refresh requests',async()=>{
    await page.waitForTimeout(500);let count=0;const countRequest=req=>{if(req.url().includes('/api/backend/'))count++;};
    await page.evaluate(()=>Object.defineProperty(document,'hidden',{configurable:true,get:()=>true}));await page.waitForTimeout(500);page.on('request',countRequest);await page.waitForTimeout(3500);page.off('request',countRequest);assert.equal(count,0);await page.evaluate(()=>delete document.hidden);
  });
  offline=true;await check('network outage is visible',()=>page.getByRole('alert').filter({hasText:'Connection lost'}).waitFor({timeout:30000}));offline=false;
  await append(Array.from({length:66},(_,i)=>sample(Date.now()-65000+i*1000,50)));
  streamTimer=setInterval(()=>{streamWork=streamWork.then(()=>append([sample(Date.now(),50)],'monitoring'));},500);
  await check('connection recovers and shows critical alert',()=>page.getByRole('alert').filter({hasText:'Running too long'}).waitFor({timeout:30000}));
  await page.getByRole('link',{name:'View alerts →',exact:true}).click();await page.waitForURL('**/alerts?**');
  await check('live alert link preserves physical device filter',async()=>{await page.getByRole('heading',{name:'Drain running too long',exact:true}).waitFor();assert.equal(await page.getByLabel('Data',{exact:true}).inputValue(),'sensor');assert.equal(await page.getByLabel('Fixture',{exact:true}).inputValue(),fixture);});
  assert.equal(await page.getByRole('heading',{name:'Drain time not measured',exact:true}).count(),0);
  await layout('alerts');await page.getByRole('button',{name:'Acknowledge',exact:true}).first().click();await check('acknowledgment persists after reload',async()=>{await page.reload();await page.getByRole('checkbox',{name:'Show acknowledged'}).check();await page.getByRole('button',{name:'Mark unread',exact:true}).first().waitFor();});
  await page.getByRole('link',{name:'View recording →',exact:true}).first().click();await page.waitForURL('**/live-demo?**');await layout('alert-recording');
  await page.goto(`${origin}/add-unit?fixture=${fixture}`);await check('completed setup resumes without retraining',()=>page.getByRole('heading',{name:`${fixture} is ready`}).waitFor());
  await page.goto(origin+'/dashboard');await page.getByRole('heading',{name:'Dashboard'}).waitFor();await layout('dashboard');
  await page.goto(origin+'/heat-map');await page.getByRole('heading',{name:'Heat map',exact:true}).waitFor();await layout('heat-map');
  await page.goto(origin+'/');await layout('home');
  await page.goto(origin+'/add-unit');await page.getByLabel('Unit ID',{exact:true}).fill(fixture);await page.getByLabel('Location',{exact:true}).fill('Kitchen');await page.getByRole('button',{name:'Add and continue'}).click();
  await check('duplicate registration offers setup recovery',()=>page.getByRole('button',{name:'Continue setup',exact:true}).waitFor());await page.getByRole('button',{name:'Continue setup',exact:true}).click();await page.getByRole('heading',{name:`${fixture} is ready`}).waitFor();
  // WebKit can emit a security diagnostic for a deliberately aborted fetch,
  // even when the rejected promise is handled. Exclude only our exact injected paths.
  const unexpected=errors.filter(message=>!(/due to access control checks/.test(message)&&[...injectedFailurePaths].some(path=>message.includes(path))));
  assert.deepEqual(unexpected,[]);assert.equal(credentialRequests,0);checks.push('no unexpected browser page errors');
  await page.goto(origin+'/reset-password');await page.getByLabel('New password',{exact:true}).fill('updated-password');await page.getByLabel('Repeat new password',{exact:true}).fill('wrong-password');await page.getByRole('button',{name:'Update password',exact:true}).click();await page.getByText('The passwords do not match.',{exact:true}).waitFor();await page.getByLabel('Repeat new password',{exact:true}).fill('updated-password');await page.getByRole('button',{name:'Update password',exact:true}).click();await check('password reset validates confirmation and updates the signed-in account',()=>page.getByText('Password updated.',{exact:false}).waitFor());
  await page.goto(origin+'/login');await page.getByText('Signed in as',{exact:false}).waitFor();assert.equal(await page.getByLabel('Device ID',{exact:true}).count(),0);assert.doesNotMatch(await page.locator('body').innerText(),/device key|firmware|backend token|\.env/i);checks.push('account page has no manual credential setup');
  console.log(`PASS ${profile.name}: ${checks.length} checks`);return {profile:profile.name,passed:true,checks};
 }catch(error){console.log(`FAIL ${profile.name}: ${error.message}`);if(page){await page.screenshot({path:`${output}/${profile.name}-failure.png`,fullPage:true}).catch(()=>{});await writeFile(`${output}/${profile.name}-failure.txt`,await page.locator('body').innerText().catch(()=>''));}return {profile:profile.name,passed:false,checks,error:error.message,pageErrors:errors};}
 finally{clearInterval(streamTimer);await streamWork.catch(()=>{});await context?.close();await browser?.close();}
}
try{
 let ready=false;for(let i=0;i<80;i++){try{if((await fetch(origin+'/add-unit')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}assert.ok(ready,serverLog);
 const selected=process.env.PRODUCT_TEST_PROFILES?profiles.filter(p=>process.env.PRODUCT_TEST_PROFILES.split(',').includes(p.name)):profiles;
 assert.ok(selected.length,'No matching browser profiles');
 for(let i=0;i<selected.length;i+=2)results.push(...await Promise.all(selected.slice(i,i+2).map((p,j)=>journey(p,i+j))));
 await writeFile(output+'/results.json',JSON.stringify(results,null,2)+'\n');
 console.log(`${results.filter(r=>r.passed).length}/${results.length} device/browser journeys passed. Results: ${output}/results.json`);
 if(results.some(r=>!r.passed))process.exitCode=1;
}finally{server.kill('SIGTERM');await app.close();await Promise.all(originals.map(({file,body})=>writeFile(root+'web/'+file,body)));}
