import { isDeepStrictEqual } from 'node:util';
import { ALERT_SETTINGS, buildAlerts } from './alerts.js';
import { drainStatuses, fail, withDrainageProfile } from './records-domain.js';
import { deviceId } from './validation.js';
import { withMonitoringCarry } from './rollover.js';

export async function fleetPage(store, accessStore, who, query) {
  if (who.deviceId) fail('Sensor keys cannot open the fleet dashboard',403,'forbidden');
  const source=query.get('data_source')??'sensor';
  if (!['sensor','simulation'].includes(source)) fail('Invalid data_source');
  const after=query.get('after')??'';
  if (after) deviceId(after);
  const search=(query.get('q')??'').trim();
  if (search.length>100) fail('Search must be at most 100 characters');
  const limit=Number(query.get('limit')??50);
  if (!Number.isInteger(limit)||limit<1||limit>100) fail('limit must be 1–100');
  let rows;
  if (store.fleetPage) rows=await store.fleetPage(who,source,after,search,limit+1);
  else {
    const devices=await accessStore.fleetDevices(who,after,search,limit+1);
    if (who.admin&&source==='simulation'&&store.fleetSimulations) {
      for (const unit of await store.fleetSimulations(after,search,limit+1)) {
        if (!await accessStore.get('devices',unit.device_id)) devices.push(unit);
      }
    }
    rows=(await store.fleetSummaries(devices,source)).slice(0,limit+1);
  }
  const units=rows.slice(0,limit).map(({health,...row})=>{
    const alerts=(health?.alerts??[]).filter(a=>a.type!=='device_silent');
    let alertCount=health?.alert_count??alerts.length;
    const last=row.last_reading_at??row.record?.created_at;
    if (row.record?.recording_status==='recording' && row.record.schema_version!==1 && Date.now()-Date.parse(last)>ALERT_SETTINGS.silentMs) {
      alerts.push({type:'device_silent',severity:'warning'});
      alertCount++;
    }
    return {...row,drain_status:health?.drain_status??null,alerts,alert_count:alertCount};
  });
  return {units,next_cursor:rows.length>limit?units.at(-1).device_id:null};
}

const healthWrites=new WeakMap();
export async function refreshFleetHealth(store, record) {
  if (!store.saveFleetHealth || record.schema_version===1) return;
  let known=healthWrites.get(store);
  if (!known) { known=new Map(); healthWrites.set(store,known); }
  const latest=record.measurements.at(-1), last=known.get(record.record_id);
  const finished=record.recording_status==='finished';
  if (last && (finished ? last.finished : latest && Date.parse(latest.timestamp)-last.at<15000)) return;
  try {
    const observed=await withDrainageProfile(store,await withMonitoringCarry(store,record));
    const status=drainStatuses([observed]).get(record.record_id)??null;
    const currentAlerts=buildAlerts([observed]).filter(a=>a.type!=='device_silent');
    const alerts=[];
    for (const {type,severity} of currentAlerts) if (!alerts.some(alert=>alert.type===type)) alerts.push({type,severity});
    const health={drain_status:status,alerts,alert_count:currentAlerts.length};
    const unchanged=last && last.finished===finished && isDeepStrictEqual(last.health,health);
    if (unchanged || await store.saveFleetHealth(record,health)) {
      known.set(record.record_id,{at:Date.parse(latest?.timestamp??record.created_at),finished,health});
      if (known.size>256) known.delete(known.keys().next().value);
    }
  } catch { /* Keep persisted raw readings available if the fleet projection is temporarily unavailable. */ }
}
