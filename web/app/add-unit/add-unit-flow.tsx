'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import AccountPanel from '../../components/account-panel';
import ProductHeader from '../../components/product-header';
import DesignAsset from '../../components/design-asset';
import OceanWaves from '../../components/ocean-waves';
import { DrainApi, DrainApiError } from '../../lib/api';
import type { Calibration, RecordView } from '../../lib/api';
import { supabase, useSession } from '../../lib/supabase';
import { useRecording } from './use-recording';
import { useLiveMode } from '../../lib/use-live-mode';
import DrainageSetup from './drainage-setup';
import shell from '../live-demo/page.module.css';
import styles from './page.module.css';

type Step = 'add' | 'connect' | 'teach' | 'drain' | 'done';
type Method = 'usb' | 'wifi';

const STEPS: { id: Exclude<Step, 'done'>; label: string }[] = [{ id: 'add', label: 'Add unit' }, { id: 'connect', label: 'Connect' }, { id: 'teach', label: 'Calibrate' }];
const UNIT_PATTERN = '[a-zA-Z0-9_\\-]{1,64}';

const message = (err: unknown, fallback: string) => err instanceof Error ? err.message : fallback;
function connectionFeedback(view: RecordView | null, failed: boolean) {
  if (failed) return { title: 'Connection interrupted', hint: 'The connection test will retry automatically.' };
  switch (view?.computed.setup_signal ?? view?.computed.sensor_connection) {
    case 'connected':
    case 'steady': return { title: 'Sensor connected', hint: 'The sensor is sending steady readings.' };
    case 'checking': return { title: 'Checking for steady readings…', hint: 'Leave the sink empty and keep the sensor still.' };
    case 'problem':
    case 'unstable': return { title: 'Check the sensor', hint: 'Keep the tap off. Make sure the sensor is secure and aimed at the center of the sink with a clear view.' };
    case 'stale': return { title: 'Readings stopped', hint: 'Check that the unit is powered on and connected.' };
    default: return { title: 'Waiting for the device…', hint: 'Keep the unit powered on. If it does not connect, ask your installer to check it.' };
  }
}

const PhoneIcon = () => <DesignAsset file="30eac.svg" className={styles.methodIcon} />;
const ServerIcon = () => <DesignAsset file="d1297.svg" className={styles.methodIcon} />;

function Stepper({ step }: { step: Step }) {
  const current = step === 'done' ? STEPS.length : STEPS.findIndex(s => s.id === (step==='drain'?'teach':step));
  return <ol className={styles.stepper} aria-label="Setup progress">
    {STEPS.map((s, i) => <li key={s.id} className={i <= current ? styles.reached : ''} aria-current={i === current ? 'step' : undefined}>
      <span>{i + 1} {s.label}</span><i />
    </li>)}
  </ol>;
}

export default function AddUnitFlow() {
  const session = useSession();
  const api=useMemo(()=>new DrainApi('/api/backend',session?.access_token||''),[session?.access_token]);
  const [step,setStep]=useState<Step>('add');
  const [unit,setUnit]=useState(''),[location,setLocation]=useState('');
  const [method,setMethod]=useState<Method>('wifi');
  const [existing,setExisting]=useState(false),[empty,setEmpty]=useState(false);
  const [calibrationId,setCalibrationId]=useState<string|null>(null),[initialObservationId,setInitialObservationId]=useState<string|null>(null);
  const [reference,setReference]=useState<Calibration|null>(null);
  const [recordId,setRecordId]=useState<string|null>(null);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [resumeFixture,setResumeFixture]=useState(''),[restoring,setRestoring]=useState(false),[restoreFailed,setRestoreFailed]=useState(false),[retry,setRetry]=useState(0);
  const recording=useRecording(api,recordId);
  const signal = recording.view?.computed.setup_signal ?? recording.view?.computed.sensor_connection;
  const connected = recording.view?.record.recording_status === 'recording' && !recording.error && (signal === 'steady' || signal === 'connected');
  const connectionEnded = recording.view?.record.recording_status === 'finished';
  const connection = connectionFeedback(recording.view, Boolean(recording.error));
  const authBlocked=Boolean(supabase)&&!session;
  const ready=reference?.drainage?.status==='ready';
  const liveEnabled=!authBlocked&&!restoring&&!restoreFailed&&Boolean(unit)&&['connect','teach','drain'].includes(step);
  const live=useLiveMode(api,unit,liveEnabled,'calibration');
  function fail(err:unknown,fallback:string){setError(err instanceof DrainApiError&&err.status===401?'Please sign in again to continue setup.':err instanceof DrainApiError&&err.status>=500?'We could not connect right now. Try again, or contact your installer.':message(err,fallback));}
  async function run(task:()=>Promise<void>,fallback:string){setBusy(true);setError('');try{await task();}catch(err){fail(err,fallback);}finally{setBusy(false);}}
  useEffect(()=>{const fixture=new URLSearchParams(window.location.search).get('fixture');if(fixture&&/^[a-zA-Z0-9_-]{1,64}$/.test(fixture)){setUnit(fixture);setStep('connect');setResumeFixture(fixture);}},[]);
  useEffect(()=>{document.getElementById('setup-title')?.focus();},[step]);
  useEffect(()=>{
    if(!resumeFixture||authBlocked)return;
    const controller=new AbortController();setRestoring(true);setRestoreFailed(false);
    void (async()=>{
      try{
        const[{records},{records:calibrations}]=await Promise.all([api.records(resumeFixture,'sensor',controller.signal),api.calibrationRecords(resumeFixture,'sensor',controller.signal)]);
        if(controller.signal.aborted)return;
        const active=records.find(r=>r.recording_status==='recording');
        const saved=calibrations.find(r=>r.schema_version!==1&&r.calibration);
        if(active?.record_type==='calibration'){setEmpty(true);setRecordId(active.record_id);setStep('teach');}
        else if(saved?.calibration){setCalibrationId(saved.record_id);setReference(saved.calibration);setRecordId(null);setInitialObservationId(saved.calibration.drainage?.active_capture?.recording_id??(active?.record_type==='monitoring'?active.record_id:null));setStep(saved.calibration.drainage?.status==='ready'?'done':'drain');}
        else{setReference(null);setRecordId(active?.record_type==='monitoring'?active.record_id:null);setStep('connect');}
        setError('');
        const registry=await api.devices(controller.signal);if(!controller.signal.aborted)setLocation(registry.devices.find(d=>d.device_id===resumeFixture)?.name??'');
      }catch(err){if(!controller.signal.aborted){setRestoreFailed(true);fail(err,'Could not recover setup.');}}
      finally{if(!controller.signal.aborted)setRestoring(false);}
    })();return()=>controller.abort();
  },[api,resumeFixture,retry,authBlocked]);
  useEffect(()=>{
    const view=recording.view;if(!view)return;
    if(view.record.record_type!=='calibration'||view.record.recording_status!=='finished')return;
    setRecordId(null);
    if(view.record.calibration){setReference(view.record.calibration);setCalibrationId(view.record.record_id);setInitialObservationId(null);setStep('drain');}
    else setError('The empty readings were not stable yet. Keep the sink empty and the sensor still, then try again.');
  },[recording.view]);
  async function addUnit(event:FormEvent){event.preventDefault();await run(async()=>{
    try{await api.register(unit,location);}catch(err){if(!(err instanceof DrainApiError&&err.status===409))throw err;const owned=(await api.devices()).devices.some(d=>d.device_id===unit);setExisting(owned);throw Error(owned?'This unit is already yours. Resume its saved setup below.':'That unit is already registered to another account, or your installer set it up for you. Check the ID printed on it, or ask your installer to link it to your account.');}
    window.history.replaceState(null,'',`/add-unit?fixture=${encodeURIComponent(unit)}`);
    setStep('connect');
  },'Could not add the unit.');}
  async function startConnection() {
    if (recordId && !connectionEnded) await api.finish(recordId);
    setRecordId(null);
    const next = await api.start(unit, 'sensor', 'monitoring');
    setRecordId(next.record_id);
  }
  async function finishConnection(){if(recordId)await api.finish(recordId);setRecordId(null);setStep('teach');}
  return <>
    <ProductHeader active="add"/>
    <main className={styles.layout}><OceanWaves setup/>
      <section className={styles.panel} aria-labelledby="setup-title">
        <Stepper step={step}/>
        {authBlocked?<><h1 id="setup-title" tabIndex={-1}>Add a unit</h1><p className={styles.lead}>Sign in to register sensors to your account. Your saved setup will be here when you return.</p><AccountPanel/></>:<>
        {(restoring||restoreFailed)&&<h1 id="setup-title" tabIndex={-1}>Resume unit setup</h1>}{restoring&&<p role="status">Recovering saved setup…</p>}
        {restoreFailed&&<button className={shell.secondary} disabled={restoring} onClick={()=>setRetry(n=>n+1)}>Retry saved setup</button>}
        {liveEnabled&&<div className={styles.note} role="status"><strong>Live setup updates</strong><p>{live.message}</p></div>}
        {step==='add'&&!restoring&&!restoreFailed&&<form className={styles.form} onSubmit={addUnit}>
          <div><h1 id="setup-title" tabIndex={-1}>Add a unit</h1><p className={styles.lead}>Connect your sensor, record the empty sink, then measure normal drainage.</p></div>
          <label className={styles.field}><span>Unit ID</span><div className={styles.inputWrap}><input aria-label="Unit ID" aria-describedby="unit-hint" required pattern={UNIT_PATTERN} maxLength={64} placeholder="DR-4851" value={unit} onChange={e=>{setUnit(e.target.value.trim());setExisting(false);setError('');}}/><small id="unit-hint">Printed on the sensor</small></div></label>
          <label className={styles.field}><span>Location</span><input required maxLength={100} placeholder="Floor 3, Room 304" value={location} onChange={e=>setLocation(e.target.value)}/></label>
          <fieldset className={styles.methods}><legend>How will it connect?</legend>{([['wifi','Wi-Fi unit','Connected to your network'],['usb','USB unit','Connected by your installer']]as const).map(([value,title,hint])=><label key={value} className={method===value?styles.selected:''}><input type="radio" name="method" checked={method===value} onChange={()=>setMethod(value)}/>{value==='wifi'?<PhoneIcon/>:<ServerIcon/>}<strong>{title}</strong><small>{hint}</small></label>)}</fieldset>
          <p className={styles.note}>{method==='usb'?'Leave the unit connected as your installer set it up.':'Your installer connects the unit to your network. You do not need to enter any connection settings here.'}</p>
          <div className={styles.actions}>{existing?<button type="button" className={shell.primary} disabled={busy} onClick={()=>{setResumeFixture(unit);setRetry(n=>n+1);}}>Continue setup</button>:<button className={shell.primary} disabled={busy}>{busy?'Adding…':'Add and continue'}</button>}<a href="/dashboard" className={styles.cancel}>Cancel</a></div>
        </form>}
        {step==='connect'&&!restoring&&!restoreFailed&&<div className={styles.form}>
          <div><h1 id="setup-title" tabIndex={-1}>Connect {unit}</h1><p className={styles.lead}>Keep the unit powered on and connected to its configured network. USB units also need the installer’s bridge running. We’ll check for steady readings before recording the empty sink.</p></div>
          {(!recordId||connectionEnded)?<button className={`${shell.primary} ${styles.big}`} disabled={busy} onClick={()=>void run(startConnection,'Could not check the connection.')}>{connectionEnded?'Restart connection test':'Start connection test'}</button>:<div className={`${styles.live} ${connected?styles.ok:''}`} role="status"><strong>{connection.title}</strong><span>{connection.hint}</span>{!connected&&<button className={shell.secondary} disabled={busy} onClick={()=>void run(startConnection,'Could not restart the connection test.')}>Restart connection test</button>}</div>}
          <div className={styles.actions}><button className={shell.primary} disabled={!connected||busy||!recordId||Boolean(recording.error)} onClick={()=>void run(finishConnection,'Could not finish the connection check.')}>Continue</button><button className={styles.cancel} disabled={busy} onClick={()=>void run(async()=>{if(recordId)await api.finish(recordId);setRecordId(null);setStep('done');},'Could not save setup.')}>Finish later</button></div>
        </div>}
        {step==='teach'&&!restoring&&!restoreFailed&&<div className={styles.form}>
          <div><h1 id="setup-title" tabIndex={-1}>Record the empty sink</h1><p className={styles.lead}>That is the baseline: the distance from the sensor to the sink with no water in it.</p></div>
          <div className={styles.enrollment} role="status" aria-live="polite"><div className={styles.scanRing} style={{'--progress':`${(recording.view?.computed.calibration_progress??0)*100}%`}as CSSProperties}><span>{Math.round((recording.view?.computed.calibration_progress??0)*100)}%</span></div><strong>{recordId?'Keep the sink empty and still':'One quick empty-sink check'}</strong><p>Usually 8–10 seconds once the sensor is connected. Next, two guided drainage checks will measure this sink’s normal speed.</p></div>
          <label className={styles.check}><input type="checkbox" checked={empty} disabled={Boolean(recordId)} onChange={e=>setEmpty(e.target.checked)}/>The sink is empty, the tap is off and the sensor is fixed in place.</label>
          {!recordId?<button className={`${shell.primary} ${styles.big}`} disabled={!empty||busy} onClick={()=>void run(async()=>setRecordId((await api.start(unit,'sensor','calibration',true)).record_id),'Could not record the empty sink.')}>Record empty sink</button>:<><progress max={1} value={recording.view?.computed.calibration_progress??0} aria-label="Empty baseline progress"/><p className={styles.note}>{recording.view?.computed.calibration_message??'Waiting for the sensor readings.'}</p><button className={shell.secondary} disabled={busy} onClick={()=>void run(async()=>{await api.finish(recordId);setRecordId(null);},'Could not stop the empty-sink check.')}>Stop and try again</button></>}
        </div>}
        {step==='drain'&&!restoring&&!restoreFailed&&reference&&calibrationId&&<DrainageSetup api={api} fixture={unit} calibrationId={calibrationId} calibration={reference} initialObservationId={initialObservationId} onRedoBaseline={()=>{setRecordId(null);setEmpty(false);setStep('teach');}} onSaved={value=>{setReference(value);if(value.drainage?.status==='ready')setStep('done');}}/>}
        {step==='done'&&!restoring&&!restoreFailed&&<div className={styles.form}>
          <div><h1 id="setup-title" tabIndex={-1}>{ready?`${unit} is ready`:`${unit} added`}</h1><p className={styles.lead}>{ready?'Empty reference and normal drainage speed saved. You can start monitoring now.':'Your progress is saved. Finish calibration when you are ready.'}</p></div>
          {ready&&<div className={`${styles.live} ${styles.ok}`}><strong>Empty baseline</strong><span>Empty distance: {reference?.empty_distance_mm} mm</span>{reference?.drainage?.profile?.resolution==='instant'?<span>Very fast drain: the water empties almost instantly (under {Math.ceil(reference.drainage.baseline_duration_seconds??1)} s). You will be warned if it ever takes longer than {reference.drainage.profile.total.slow_seconds.toFixed(0)} s.</span>:<><span>Normal drainage: {reference?.drainage?.baseline_duration_seconds?.toFixed(2)} seconds from 30 mm to 10 mm</span><span>Level recession: {reference?.drainage?.baseline_recession_mm_per_second?.toFixed(2)} mm/s</span></>}<p>Two consistent tap-off checks are saved in this unit’s calibration for later alert comparisons.</p></div>}
          <dl className={styles.summary}><div><dt>Unit ID</dt><dd>{unit}</dd></div><div><dt>Location</dt><dd>{location||'—'}</dd></div><div><dt>Empty sink</dt><dd>{reference?'Baseline saved':'Not recorded yet'}</dd></div></dl>
          <div className={styles.actions}>{ready?<button className={shell.primary} disabled={busy} onClick={()=>void run(async()=>{const{records}=await api.records(unit,'sensor');const active=records.find(r=>r.recording_status==='recording');if(active&&active.record_type!=='monitoring')throw Error('Finish the active recording before starting monitoring.');let next:{record_id:string;calibration:Calibration|null}|undefined=active;if(next&&reference?.drainage?.runs.some(r=>r.recording_id===next!.record_id)){await api.finish(next.record_id);next=undefined;}next??=await api.start(unit,'sensor','monitoring');window.location.assign(`/live-demo?fixture=${encodeURIComponent(unit)}&source=sensor&record=${next.record_id}`);},'Could not start monitoring.')}>{busy?'Starting…':'Start monitoring'}</button>:<a className={shell.primary} href={`/add-unit?fixture=${encodeURIComponent(unit)}`}>Resume setup</a>}<a className={shell.secondary} href="/add-unit">Add another unit</a></div>
        </div>}
        {(error||recording.error)&&<p className={styles.error} role="alert">{error||recording.error}</p>}
        {unit&&step!=='add'&&<div className={styles.actions}><a href={`/add-unit?fixture=${encodeURIComponent(unit)}`}>Save this setup link</a></div>}
        </>}
      </section>
      <aside className={styles.art} aria-hidden="true"><div className={styles.artCanvas}><picture><source media="(prefers-reduced-motion: reduce)" srcSet="/images/design/71e2d.svg"/><DesignAsset file="71e2d-animated.svg" className={styles.sinkScene}/></picture><div className={styles.phoneArt}><DesignAsset file="26625.svg"/></div><span className={`${styles.callout} ${styles.calloutUnit}`}>{unit||'DR-4851'} is printed on the sensor</span><span className={`${styles.callout} ${styles.calloutPhone}`}>{step==='drain'?'Learn this sink’s normal drainage':step==='teach'?'Record the empty sink':'Connect, then calibrate'}</span></div></aside>
    </main>
  </>;
}
