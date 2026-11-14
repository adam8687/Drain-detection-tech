'use client';
import {useEffect,useRef,useState} from 'react';
import type{CSSProperties}from'react';
import {DrainApi,DrainApiError}from'../../lib/api';
import type{Calibration}from'../../lib/api';
import {useRecording}from'./use-recording';
import styles from'./page.module.css';
import shell from'../live-demo/page.module.css';

export default function DrainageSetup({api,fixture,calibrationId,calibration,initialObservationId,onSaved}:{api:DrainApi;fixture:string;calibrationId:string;calibration:Calibration;initialObservationId:string|null;onSaved:(value:Calibration)=>void}){
 const [recordId,setRecordId]=useState<string|null>(calibration.drainage?.active_capture?.recording_id??initialObservationId);
 const [clear,setClear]=useState(false),[tapOff,setTapOff]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saveFailed,setSaveFailed]=useState(false);
 const completing=useRef<string|null>(null);const recording=useRecording(api,recordId),capture=calibration.drainage?.active_capture;
 useEffect(()=>{document.getElementById('setup-title')?.focus();},[capture?.capture_id]);
 const count=calibration.drainage?.runs.length??0,latest=recording.view?.record.measurements.at(-1);
 const level=latest?.sensor.status==='ok'&&latest.sensor.distance_mm!==null?Math.max(0,calibration.empty_distance_mm-latest.sensor.distance_mm):null;
 const connected=recording.view?.computed.sensor_connection==='connected';
 const waterReady=connected&&level!==null&&level>=40&&recording.view?.record.recording_status==='recording';
 const progress=level===null?0:Math.min(1,Math.max(0,(30-level)/20));
 const report=(e:unknown)=>setError(e instanceof DrainApiError&&e.status<500?e.message:'We could not save this check. Try again when the connection returns.');
 async function observe(){setBusy(true);setError('');try{const{records}=await api.records(fixture,'sensor');const active=records.find(r=>r.recording_status==='recording');if(active&&(active.record_type!=='monitoring'||active.calibration?.empty_distance_mm!==calibration.empty_distance_mm))throw Error('Another recording is active. Ask your installer to finish it before continuing.');setRecordId((active??await api.start(fixture,'sensor','monitoring')).record_id);}catch(e){setError(e instanceof Error?e.message:'Could not connect. Please try again.');}finally{setBusy(false);}}
 async function finish(id:string){if(completing.current===id)return;completing.current=id;setBusy(true);setSaveFailed(false);setError('');try{const result=await api.calibrateDrainage(calibrationId,{action:'complete',capture_id:id});setTapOff(false);onSaved(result.calibration);}catch(e){if(e instanceof DrainApiError&&e.code==='drainage_pending')completing.current=null;else{report(e);setSaveFailed(true);}}finally{setBusy(false);}}
 useEffect(()=>{if(capture&&recording.view?.computed.forecast.state==='dry')void finish(capture.capture_id);},[recording.view,capture?.capture_id]);
 return <div className={styles.form}>
  <div><h1 id="setup-title" tabIndex={-1}>{capture?'Release the plug':'Measure normal drainage'}</h1><p className={styles.lead}>{capture?'Keep the tap off. The check saves automatically once the sink is empty.':'Two short checks measure how quickly this sink drains. No dimensions or connection settings are needed.'}</p></div>
  <p className={styles.note}>{count} of 2 drainage checks saved · Empty reference saved</p>
  {calibration.drainage?.last_issue&&<p className={styles.error} role="alert">{calibration.drainage.last_issue}</p>}
  {!recordId?<><p>We will use the unit’s existing readings to guide the water check.</p><button className={shell.primary} disabled={busy} onClick={()=>void observe()}>Start water check</button></>:capture?<>
   <div className={styles.enrollment} role="status"><div className={styles.scanRing} style={{'--progress':`${progress*100}%`}as CSSProperties}><span>{Math.round(progress*100)}%</span></div><strong>{!connected?'Waiting for clear readings…':level!==null&&level<=8?'Confirming the sink is empty…':'Measuring the falling water level…'}</strong><p>The sensor measures the fall from 30 mm to 10 mm. Keep the tap off and the sensor still.</p></div>
   {saveFailed&&<button className={shell.primary} disabled={busy} onClick={()=>{completing.current=null;void finish(capture.capture_id);}}>Retry saving check</button>}
   <button className={shell.secondary} disabled={busy} onClick={async()=>{setBusy(true);try{const saved=await api.calibrateDrainage(calibrationId,{action:'cancel',capture_id:capture.capture_id});onSaved(saved.calibration);setTapOff(false);completing.current=null;setSaveFailed(false);setError('');}catch(e){report(e);}finally{setBusy(false);}}}>Stop and try again</button>
  </>:<>
   <ol className={styles.instructions}><li>Put the plug in and fill gently to the indicator. Always stay safely below the rim.</li><li>Turn the tap off and keep the plug in.</li><li>Start the check, then release the plug when the app asks.</li></ol>
   <div className={`${styles.live} ${waterReady?styles.ok:''}`} role="status"><strong>{!connected?'Waiting for the unit…':waterReady?'Enough water. Turn the tap off.':'Fill gently with the plug in.'}</strong><span>{level===null?'Waiting for a clear water-level reading.':`${level.toFixed(0)} mm of water · fill indicator 40 mm`}</span><p>Stop filling if the water approaches the rim. A shallow fixture may need your installer’s help.</p></div>
   <label className={styles.check}><input type="checkbox" checked={clear} onChange={e=>setClear(e.target.checked)}/>This drain is known to be clear and working normally.</label>
   <label className={styles.check}><input type="checkbox" checked={tapOff} onChange={e=>setTapOff(e.target.checked)}/>The tap is off and the plug is still in.</label>
   <button className={shell.primary} disabled={busy||!waterReady||!clear||!tapOff||Boolean(recording.error)} onClick={async()=>{if(!recordId)return;setBusy(true);setError('');try{const saved=await api.calibrateDrainage(calibrationId,{action:'start',recording_id:recordId,confirm_tap_off:true,confirm_clear:true});completing.current=null;onSaved(saved.calibration);}catch(e){report(e);}finally{setBusy(false);}}}>Start drainage check {count+1} of 2</button>
   {recording.view?.record.recording_status==='finished'&&<button className={shell.secondary} disabled={busy} onClick={()=>void observe()}>Reconnect water check</button>}
  </>}
  {(error||recording.error)&&<p className={styles.error} role="alert">{error||recording.error}</p>}
 </div>;
}
