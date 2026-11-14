import {ApiError,object,number,uuid,timestamp} from './validation.js';

// Depth change, not volumetric flow: the same depth range is compared within a fixture.
export const DRAIN_CALIBRATION = Object.freeze({version:1,upper:30,lower:10,fillTarget:40,runs:2,maxGapMs:5000,maxWaitMs:600000,instantMaxSeconds:6,dry:8,stable:3,maxRepeatRatio:1.3});
const levels=[30,25,20,15,10];
// Alert policy frozen into each sink's profile when drainage setup completes:
// slow = ratio x this sink's own time + its measured variation/noise; severe is the stronger ratio.
// min_* are predetermined floors for the whole 30->10 mm range. A very healthy drain empties almost at once, so a
// ratio of its own tiny time would flag noise; only a drain slower than the floor counts as a real slowdown.
export const PROFILE_POLICY=Object.freeze({slow_ratio:1.5,severe_ratio:3,repeat_count:2,repeat_window:3,standing_water_margin_seconds:30,min_slow_seconds:6,min_severe_seconds:15});
// A run whose time is no more than twice its sampling uncertainty was only resolved to the sampling interval.
const instantRun=r=>r.duration_seconds<=2*r.uncertainty_seconds;
const round=n=>Math.round(n*1000)/1000;
const issue=(message,status=422,code='invalid_drainage_calibration')=>{throw new ApiError(status,code,message);};
const depth=(p,empty)=>p?.sensor?.status==='ok'&&p.sensor.distance_mm!==null&&empty-p.sensor.distance_mm>=-20?Math.max(0,empty-p.sensor.distance_mm):null;
const sorted=points=>[...points].sort((a,b)=>a.timestamp.localeCompare(b.timestamp)||a.reading_id.localeCompare(b.reading_id)).filter((p,i,all)=>!i||p.timestamp!==all[i-1].timestamp);
const sum=values=>values.reduce((a,b)=>a+b,0);
// Expected time per depth band and the allowance for normal variation and sensor noise, from two
// confirmed tap-off runs on a drain known to be clear. Depth bands, not volume, so it stays per-sink.
export function buildDrainageProfile(runs,bands,duration,policy=PROFILE_POLICY){
 const [a,b]=runs,noise=round(Math.max(...runs.map(r=>r.uncertainty_seconds))),variation=round(Math.abs(a.duration_seconds-b.duration_seconds)),tolerance=round(Math.max(noise,variation));
 return{clear_drain_confirmed:true,resolution:runs.every(instantRun)?'instant':'banded',noise_seconds:noise,variation_seconds:variation,policy:{...policy},
  bands:bands.map((band,i)=>{const spread=round(Math.abs(a.bands[i].duration_seconds-b.bands[i].duration_seconds)),allowance=round(Math.max(noise,spread));return{from_depth_mm:band.from_depth_mm,to_depth_mm:band.to_depth_mm,expected_seconds:band.duration_seconds,variation_seconds:spread,tolerance_seconds:allowance,slow_seconds:round(Math.max(band.duration_seconds*policy.slow_ratio+allowance,policy.min_slow_seconds/4))};}),
  total:{expected_seconds:duration,tolerance_seconds:tolerance,slow_seconds:round(Math.max(duration*policy.slow_ratio+tolerance,policy.min_slow_seconds)),severe_seconds:round(Math.max(duration*policy.severe_ratio+tolerance,policy.min_severe_seconds)),standing_water_seconds:round(Math.max(duration*policy.severe_ratio,duration+policy.standing_water_margin_seconds)+tolerance)}};
}
function profileShape(value){
 object(value,['clear_drain_confirmed','resolution','noise_seconds','variation_seconds','policy','bands','total']);
 if(!['banded','instant'].includes(value.resolution))issue('Invalid drainage profile resolution');
 if(value.clear_drain_confirmed!==true)issue('The profile must come from a drain confirmed clear');
 const p=object(value.policy,['slow_ratio','severe_ratio','repeat_count','repeat_window','standing_water_margin_seconds','min_slow_seconds','min_severe_seconds']);
 const policy={slow_ratio:number(p.slow_ratio,'slow_ratio',1.1,5),severe_ratio:number(p.severe_ratio,'severe_ratio',1.1,10),repeat_count:number(p.repeat_count,'repeat_count',2,5,true),repeat_window:number(p.repeat_window,'repeat_window',2,10,true),standing_water_margin_seconds:number(p.standing_water_margin_seconds,'standing_water_margin_seconds',0,3600),min_slow_seconds:number(p.min_slow_seconds,'min_slow_seconds',1,300),min_severe_seconds:number(p.min_severe_seconds,'min_severe_seconds',1,900)};
 if(policy.severe_ratio<policy.slow_ratio||policy.repeat_window<policy.repeat_count||policy.min_severe_seconds<policy.min_slow_seconds)issue('Invalid drainage alert policy');
 if(!Array.isArray(value.bands)||value.bands.length!==4)issue('Invalid drainage profile bands');
 const bands=value.bands.map((b,i)=>{object(b,['from_depth_mm','to_depth_mm','expected_seconds','variation_seconds','tolerance_seconds','slow_seconds']);if(b.from_depth_mm!==levels[i]||b.to_depth_mm!==levels[i+1])issue('Invalid drainage profile band');return{from_depth_mm:b.from_depth_mm,to_depth_mm:b.to_depth_mm,expected_seconds:number(b.expected_seconds,'expected_seconds',.001,86400),variation_seconds:number(b.variation_seconds,'variation_seconds',0,86400),tolerance_seconds:number(b.tolerance_seconds,'tolerance_seconds',0,86400),slow_seconds:number(b.slow_seconds,'slow_seconds',.001,432000)};});
 const t=object(value.total,['expected_seconds','tolerance_seconds','slow_seconds','severe_seconds','standing_water_seconds']);
 const total={expected_seconds:number(t.expected_seconds,'expected_seconds',.001,86400),tolerance_seconds:number(t.tolerance_seconds,'tolerance_seconds',0,86400),slow_seconds:number(t.slow_seconds,'slow_seconds',.001,432000),severe_seconds:number(t.severe_seconds,'severe_seconds',.001,432000),standing_water_seconds:number(t.standing_water_seconds,'standing_water_seconds',.001,432000)};
 if(total.slow_seconds<=total.expected_seconds||total.severe_seconds<total.slow_seconds)issue('Drainage thresholds must rise above the expected time');
 return{clear_drain_confirmed:true,resolution:value.resolution,noise_seconds:number(value.noise_seconds,'noise_seconds',0,10),variation_seconds:number(value.variation_seconds,'variation_seconds',0,86400),policy,bands,total};
}
// Ready profile for a sink. Version 1 setups saved before profiles existed derive the same values from their stored runs.
export function drainageProfileOf(drainage){
 if(!drainage||drainage.status!=='ready')return null;
 return drainage.profile??buildDrainageProfile(drainage.runs,drainage.bands,drainage.baseline_duration_seconds);
}
// Time spent in each profile depth band by a later drain; null where that depth range was not fully observed.
export function matchedBands(measurements,empty){
 const points=sorted(measurements).map(p=>({t:Date.parse(p.timestamp),d:depth(p,empty)}));
 const cross=levels.map(level=>{for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i];if(a.d===null||b.d===null||b.t-a.t>DRAIN_CALIBRATION.maxGapMs)continue;if(a.d>=level&&b.d<=level&&a.d>b.d)return{i,t:a.t+(a.d-level)/(a.d-b.d)*(b.t-a.t)};}return null;});
 return levels.slice(0,4).map((_,k)=>{const top=cross[k],bottom=cross[k+1];if(!top||!bottom||bottom.t<=top.t)return null;const between=points.slice(top.i-1,bottom.i+1);if(between.some((p,i)=>p.d===null||i&&(p.t-between[i-1].t>DRAIN_CALIBRATION.maxGapMs||p.d>between[i-1].d+4)))return null;return round((bottom.t-top.t)/1000);});
}
// Seconds from the top of the water plateau to the first dry reading, or null if it never dried or readings broke.
export function fallSeconds(measurements,empty){
 const pts=sorted(measurements).map(p=>({t:Date.parse(p.timestamp),d:depth(p,empty)}));
 const top=Math.max(...pts.map(p=>p.d??0));let start=-1,end=-1;
 for(let i=0;i<pts.length;i++){if(pts[i].d!==null&&pts[i].d>=top-4)start=i;}
 if(start<0||top<12)return null;
 for(let i=start+1;i<pts.length;i++){if(pts[i].d===null||pts[i].t-pts[i-1].t>DRAIN_CALIBRATION.maxGapMs)return null;if(pts[i].d<=DRAIN_CALIBRATION.dry){end=i;break;}}
 return end<0?null:round((pts[end].t-pts[start].t)/1000);
}
// Compare a drain with the sink's own profile at matching depths. Slow once it exceeds expected x ratio plus the
// allowance for variation and noise; only the depth bands the drain actually covered count.
export function judgeDrainage(measurements,empty,profile){
 const seconds=matchedBands(measurements,empty),covered=seconds.map((s,i)=>s===null?null:i).filter(i=>i!==null);
 if(!covered.length){
  // Too quick (or too shallow) to time per band: judge the whole fall against the sink's overall limits.
  const fall=fallSeconds(measurements,empty);if(fall===null)return null;
  return{observed_seconds:fall,expected_seconds:profile.total.expected_seconds,tolerance_seconds:profile.total.tolerance_seconds,slow_seconds:profile.total.slow_seconds,severe_seconds:profile.total.severe_seconds,slow:fall>=profile.total.slow_seconds,severe:fall>=profile.total.severe_seconds,bands:[]};
 }
 const used=covered.map(i=>profile.bands[i]),observed=round(sum(covered.map(i=>seconds[i]))),expected=round(sum(used.map(b=>b.expected_seconds))),tolerance=round(Math.max(profile.noise_seconds,sum(used.map(b=>b.variation_seconds)))),share=covered.length/4,slow=round(Math.max(expected*profile.policy.slow_ratio+tolerance,profile.policy.min_slow_seconds*share)),severe=round(Math.max(expected*profile.policy.severe_ratio+tolerance,profile.policy.min_severe_seconds*share));
 return{observed_seconds:observed,expected_seconds:expected,tolerance_seconds:tolerance,slow_seconds:slow,severe_seconds:severe,slow:observed>=slow,severe:observed>=severe,bands:covered.map(i=>({from_depth_mm:profile.bands[i].from_depth_mm,to_depth_mm:profile.bands[i].to_depth_mm,observed_seconds:seconds[i],expected_seconds:profile.bands[i].expected_seconds,slow_seconds:profile.bands[i].slow_seconds}))};
}
function bandShape(bands,ready){
 if(!Array.isArray(bands)||bands.length!==(ready?4:0))issue('Invalid drainage depth bands');
 return bands.map((b,i)=>{object(b,['from_depth_mm','to_depth_mm','duration_seconds']);if(b.from_depth_mm!==levels[i]||b.to_depth_mm!==levels[i+1])issue('Invalid drainage depth band');return{from_depth_mm:b.from_depth_mm,to_depth_mm:b.to_depth_mm,duration_seconds:number(b.duration_seconds,'band duration',.001,86400)};});
}
export function validateDrainageCalibration(value){
 object(value,['version','method','status','upper_depth_mm','lower_depth_mm','runs','active_capture','baseline_duration_seconds','baseline_recession_mm_per_second','bands','repeatability_ratio','measured_at','last_issue','profile']);
 if(![1,2].includes(value.version)||value.method!=='tap_off_drawdown'||!['collecting','ready'].includes(value.status)||value.upper_depth_mm!==30||value.lower_depth_mm!==10)issue('Invalid drainage calibration method');
 if(!Array.isArray(value.runs)||value.runs.length>2)issue('Invalid drainage calibration runs');
 const runs=value.runs.map(run=>{
  object(run,['capture_id','recording_id','from_reading_id','to_reading_id','confirmed_at','ended_at','duration_seconds','recession_mm_per_second','uncertainty_seconds','sample_count','bands']);
  const result={capture_id:uuid(run.capture_id,'capture_id'),recording_id:uuid(run.recording_id,'recording_id'),from_reading_id:uuid(run.from_reading_id,'from_reading_id'),to_reading_id:uuid(run.to_reading_id,'to_reading_id'),confirmed_at:timestamp(run.confirmed_at,'confirmed_at'),ended_at:timestamp(run.ended_at,'ended_at'),duration_seconds:number(run.duration_seconds,'duration_seconds',.001,86400),recession_mm_per_second:number(run.recession_mm_per_second,'recession_mm_per_second',.001,20000),uncertainty_seconds:number(run.uncertainty_seconds,'uncertainty_seconds',0,10),sample_count:number(run.sample_count,'sample_count',3,5000),bands:bandShape(run.bands,true)};
  if(!Number.isInteger(result.sample_count)||result.ended_at<result.confirmed_at)issue('Invalid drainage sampling evidence');return result;
 });
 if(new Set(runs.map(r=>r.capture_id)).size!==runs.length)issue('Drainage runs must be distinct');
 let capture=null;
 if(value.active_capture!==null){const c=value.active_capture;object(c,['capture_id','recording_id','from_reading_id','confirmed_at','tap_off_confirmed','clear_drain_confirmed']);if(c.tap_off_confirmed!==true||c.clear_drain_confirmed!==true)issue('Confirm the tap is off and the drain is clear');capture={capture_id:uuid(c.capture_id,'capture_id'),recording_id:uuid(c.recording_id,'recording_id'),from_reading_id:uuid(c.from_reading_id,'from_reading_id'),confirmed_at:timestamp(c.confirmed_at,'confirmed_at'),tap_off_confirmed:true,clear_drain_confirmed:true};}
 const ready=value.status==='ready';
 if(ready&&(runs.length!==2||capture!==null)||!ready&&runs.length>=2)issue('Drainage calibration is not complete');
 const duration=ready?number(value.baseline_duration_seconds,'baseline_duration_seconds',.001,86400):null;
 const rate=ready?number(value.baseline_recession_mm_per_second,'baseline_recession_mm_per_second',.001,20000):null;
 const ratio=ready?number(value.repeatability_ratio,'repeatability_ratio',1,3.001):null;
 const measured=ready?timestamp(value.measured_at,'measured_at'):null;
 if(!ready&&[value.baseline_duration_seconds,value.baseline_recession_mm_per_second,value.repeatability_ratio,value.measured_at].some(v=>v!==null))issue('Incomplete drainage calibration cannot have baseline metrics');
 if(value.last_issue!==null&&(typeof value.last_issue!=='string'||value.last_issue.length>250))issue('Invalid drainage calibration message');
 // Version 1 predates profiles. Version 2 stores the sink profile once two clear-drain runs agree.
 if(value.version===1&&value.profile!==undefined||value.version===2&&(value.profile===undefined||ready!==(value.profile!==null)))issue('Invalid drainage profile');
 const profile=value.version===2&&ready?profileShape(value.profile):null;
 return{version:value.version,method:'tap_off_drawdown',status:value.status,upper_depth_mm:30,lower_depth_mm:10,runs,active_capture:capture,baseline_duration_seconds:duration,baseline_recession_mm_per_second:rate,bands:bandShape(value.bands,ready),repeatability_ratio:ratio,measured_at:measured,last_issue:value.last_issue,...(value.version===2?{profile}:{})};
}
export function emptyDrainageCalibration(){return{version:2,method:'tap_off_drawdown',status:'collecting',upper_depth_mm:30,lower_depth_mm:10,runs:[],active_capture:null,baseline_duration_seconds:null,baseline_recession_mm_per_second:null,bands:[],repeatability_ratio:null,measured_at:null,last_issue:null,profile:null};}
export function validateDrainageAction(input){
 object(input,['action','recording_id','capture_id','confirm_tap_off','confirm_clear']);
 if(!['start','complete','cancel'].includes(input.action))issue('Choose start, complete or cancel');
 if(input.action==='start'){if(input.capture_id!==undefined)issue('A capture ID is generated by the server');if(input.confirm_tap_off!==true||input.confirm_clear!==true)issue('Confirm the tap is off, the plug is in and the drain is known to be clear');return{action:'start',recording_id:uuid(input.recording_id,'recording_id'),confirm_tap_off:true,confirm_clear:true};}
 if(['recording_id','confirm_tap_off','confirm_clear'].some(k=>input[k]!==undefined))issue('Only the capture ID is required');
 return{action:input.action,capture_id:uuid(input.capture_id,'capture_id')};
}
// Ordinary sensor noise must not ruin a capture. Timeouts and out-of-range readings are dropped, an isolated stray
// echo (a reading far from both neighbours that agree with each other) is dropped, and the rest is smoothed with a
// 3-point median, which keeps a real step (a drain that empties between readings) intact.
export const CAPTURE_NOISE=Object.freeze({echoMm:15,riseMm:6,maxDroppedShare:.2});
function cleanReadings(points,empty){
 const valid=points.map(p=>({p,t:Date.parse(p.timestamp),d:depth(p,empty)})).filter(r=>r.d!==null);
 const kept=valid.filter((r,i)=>{const a=valid[i-1],b=valid[i+1],T=CAPTURE_NOISE.echoMm;return!(a&&b&&Math.abs(r.d-a.d)>T&&Math.abs(r.d-b.d)>T&&Math.abs(a.d-b.d)<=T);});
 return kept.map((r,i)=>({...r,s:[kept[i-1]?.d??r.d,r.d,kept[i+1]?.d??r.d].sort((x,y)=>x-y)[1]}));
}
export function measureDrawdown(record,capture,empty,now=Date.now()){
 const points=sorted(record.measurements),index=points.findIndex(p=>p.reading_id===capture.from_reading_id);
 if(index<0)return{issue:'The start reading is unavailable. Please restart the drainage check.'};
 const window=points.slice(index),kept=cleanReadings(window,empty);let dry=0,end=-1;
 for(let i=0;i<kept.length;i++){dry=kept[i].s<=DRAIN_CALIBRATION.dry?dry+1:0;if(dry>=3){end=i;break;}}
 if(end<0)return{waiting:true};
 const samples=kept.slice(0,end+1),last=samples.at(-1);
 if(last.t>now)return{waiting:true};
 const total=window.filter(p=>Date.parse(p.timestamp)<=last.t).length,dropped=total-samples.length;
 if(dropped>Math.max(2,Math.ceil(total*CAPTURE_NOISE.maxDroppedShare)))return{issue:'Too many readings were unreliable. Keep the sensor still, clear of the water spray, and repeat this drainage check.'};
 if(samples.some((x,i)=>i&&x.t-samples[i-1].t>DRAIN_CALIBRATION.maxGapMs))return{issue:'Readings were interrupted. Keep the sensor still and repeat this drainage check.'};
 if(samples[0].s<35)return{issue:'There was not enough water at the start. Repeat using the fill indicator, safely below the rim.'};
 const crossings=[];
 for(const level of levels){let found=null;for(let i=1;i<samples.length;i++){const before=samples[i-1].s,after=samples[i].s;if(before>=level&&after<=level&&before>after){const a=samples[i-1].t,b=samples[i].t;found={time:a+(before-level)/(before-after)*(b-a),span:(b-a)/1000};break;}}if(!found)return{issue:'The complete drainage range was not observed. Please repeat the check.'};crossings.push(found);}
 // The crossing time is only known to within one sampling interval, so allow for that before calling it early.
 if(crossings[0].time+crossings[0].span*1000<Date.parse(capture.confirmed_at))return{issue:'Water started draining before the check began. Keep the plug in until the app asks you to release it.'};
 const within=samples.filter(x=>x.t>=crossings[0].time&&x.t<=crossings.at(-1).time);
 // Refilling or a tap left on would confound the tap-off measurement: smoothed level rising above its running minimum.
 let low=Infinity;for(const x of within){if(x.s>low+CAPTURE_NOISE.riseMm)return{issue:'The water level rose during the check. Turn the tap off and repeat the drainage check.'};low=Math.min(low,x.s);}
 const seconds=(crossings.at(-1).time-crossings[0].time)/1000,uncertainty=crossings[0].span+crossings.at(-1).span;
 // A healthy drain can empty between two readings. Accept it as an upper bound (time plus sampling interval) instead
 // of rejecting it: the profile is then marked instant and judged by the predetermined floors.
 const tooFast=within.length<3||seconds<=0||uncertainty>Math.max(1,seconds*.5);
 const bound=seconds+uncertainty;
 if(tooFast&&bound>DRAIN_CALIBRATION.instantMaxSeconds)return{issue:within.length<3?'This drain was faster than the available readings can measure reliably. Ask your installer to check the measurement setup.':'The readings are too widely spaced for a reliable drainage measurement. Ask your installer to check the measurement setup.'};
 const duration=tooFast?bound:seconds,bandSeconds=tooFast?levels.slice(0,-1).map(()=>bound/4):levels.slice(0,-1).map((level,i)=>(crossings[i+1].time-crossings[i].time)/1000);
 return{run:{capture_id:capture.capture_id,recording_id:record.record_id,from_reading_id:capture.from_reading_id,to_reading_id:last.p.reading_id,confirmed_at:capture.confirmed_at,ended_at:last.p.timestamp,duration_seconds:round(duration),recession_mm_per_second:round(20/duration),uncertainty_seconds:round(uncertainty),sample_count:samples.length,bands:levels.slice(0,-1).map((level,i)=>({from_depth_mm:level,to_depth_mm:levels[i+1],duration_seconds:Math.max(.001,round(bandSeconds[i]))}))}};
}
// This only updates the calibration JSON. It never edits observations, changes a
// recording's status, or alters sensor ingestion/broadcasting or alert policy.
export function updateDrainageCalibration(calibrationRecord,observation,input,captureId,now=Date.now()){
 if(calibrationRecord.record_type!=='calibration'||calibrationRecord.recording_status!=='finished'||calibrationRecord.schema_version===1||!calibrationRecord.calibration)issue('Save a fresh empty-sink reference first',409,'calibration_required');
 const stored=calibrationRecord.calibration.drainage??emptyDrainageCalibration(),current=stored.status==='ready'?stored:{...stored,version:2,profile:null};
 if(input.action!=='start'&&current.runs.some(r=>r.capture_id===input.capture_id))return calibrationRecord;
 if(input.action==='cancel'){
  if(!current.active_capture)return calibrationRecord;
  if(current.active_capture.capture_id!==input.capture_id)issue('This check has already changed. Refresh setup to continue.',409,'capture_changed');
  return{...calibrationRecord,calibration:{...calibrationRecord.calibration,drainage:{...current,active_capture:null,last_issue:null}}};
 }
 if(!observation||observation.fixture_id!==calibrationRecord.fixture_id||observation.data_source!==calibrationRecord.data_source||observation.record_type!=='monitoring'||!observation.calibration||observation.calibration.empty_distance_mm!==calibrationRecord.calibration.empty_distance_mm)issue('Use this unit’s live readings with the current empty reference',409,'calibration_record_mismatch');
 if(input.action==='start'){
  if(current.status==='ready')issue('Drainage calibration is already complete',409,'calibration_complete');
  if(current.active_capture){if(current.active_capture.recording_id!==observation.record_id)issue('Another drainage check is active',409,'capture_changed');return calibrationRecord;}
  // A timeout or invalid reading right at the start must not block it: use the latest valid reading of the last three.
  // (A stray echo that slips through is dropped by the capture cleaning and the check can simply be repeated.)
  const recent=sorted(observation.measurements).slice(-3),latest=recent.filter(p=>depth(p,calibrationRecord.calibration.empty_distance_mm)!==null).at(-1),newest=recent.at(-1);
  const level=latest?depth(latest,calibrationRecord.calibration.empty_distance_mm):null;
  if(observation.recording_status!=='recording'||!latest||Date.parse(newest.timestamp)>now||now-Date.parse(newest.timestamp)>5000||level===null||level<40)issue('Wait for connected readings and enough water, safely below the rim',409,'water_not_ready');
  const active_capture={capture_id:captureId,recording_id:observation.record_id,from_reading_id:latest.reading_id,confirmed_at:new Date(now).toISOString(),tap_off_confirmed:true,clear_drain_confirmed:true};
  return{...calibrationRecord,calibration:{...calibrationRecord.calibration,drainage:{...current,active_capture,last_issue:null}}};
 }
 if(!current.active_capture||current.active_capture.capture_id!==input.capture_id)issue('This drainage check is no longer active',409,'capture_changed');
 let result=measureDrawdown(observation,current.active_capture,calibrationRecord.calibration.empty_distance_mm,now);
 // A capture that never reaches an empty basin (tap dripping, plug closed, residual water) must not wait forever.
 if(result.waiting&&now-Date.parse(current.active_capture.confirmed_at)>DRAIN_CALIBRATION.maxWaitMs)result={issue:'The sink did not finish emptying within 10 minutes. Check the tap is off and the drain is open, then repeat this check.'};
 if(result.waiting)issue('Waiting for the sink to finish draining',409,'drainage_pending');
 let next={...current,active_capture:null,last_issue:result.issue??null};
 if(result.run){
  const runs=[...current.runs,result.run],durations=runs.map(r=>r.duration_seconds),rawRatio=Math.max(...durations)/Math.min(...durations),instantPair=runs.length===2&&runs.every(instantRun),ratio=instantPair?1:rawRatio;
  // Runs agree when within 30%, or (up to 3x) when their gap is no bigger than their own sampling uncertainty.
  const gap=runs.length===2?Math.abs(runs[0].duration_seconds-runs[1].duration_seconds):0,agree=instantPair||rawRatio<=1.3||(rawRatio<=3&&gap<=runs[0].uncertainty_seconds+runs[1]?.uncertainty_seconds);
  if(runs.length===2&&!agree)next.last_issue='The two checks differed too much. Use the same fill level with the tap off and repeat this check.';
  else{next.runs=runs;if(runs.length===2){const average=values=>round(values.reduce((a,b)=>a+b,0)/values.length),duration=average(durations);next={...next,version:2,status:'ready',baseline_duration_seconds:duration,baseline_recession_mm_per_second:round(20/duration),bands:levels.slice(0,-1).map((level,i)=>({from_depth_mm:level,to_depth_mm:levels[i+1],duration_seconds:average(runs.map(r=>r.bands[i].duration_seconds))})),repeatability_ratio:round(ratio),measured_at:new Date(now).toISOString()};next.profile=buildDrainageProfile(runs,next.bands,duration);}}
 }
 return{...calibrationRecord,calibration:{...calibrationRecord.calibration,drainage:validateDrainageCalibration(next)}};
}
