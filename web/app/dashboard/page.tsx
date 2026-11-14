'use client';
import {useEffect,useState} from 'react';
import ProductHeader from '../../components/product-header';
import OceanWaves from '../../components/ocean-waves';
import DesignAsset from '../../components/design-asset';
import AccountPanel from '../../components/account-panel';
import RecordingWorkbench from '../../components/recording-workbench';
import {useFleet} from '../../lib/use-fleet';
import type {FleetCategory,FixtureCard} from '../../lib/use-fleet';
import {FleetFilters,FixtureTile,fixtureHref} from '../../components/fleet-parts';
import styles from './page.module.css';
export default function DashboardPage(){
 const data=useFleet();const[hover,setHover]=useState<FixtureCard|null>(null),[query,setQuery]=useState(''),[filter,setFilter]=useState<'all'|FleetCategory>('all'),[expanded,setExpanded]=useState(false),[workbench,setWorkbench]=useState(false);
 useEffect(()=>setQuery(new URLSearchParams(window.location.search).get('q')||''),[]);
 const visible=data.fixtures.filter(f=>(filter==='all'||f.category===filter)&&`${f.id} ${f.name}`.toLowerCase().includes(query.toLowerCase()));
 const attention=visible.filter(f=>['high','moderate','offline'].includes(f.category)),baseline=visible.filter(f=>f.category==='baseline'),good=visible.filter(f=>f.category==='good');
 const count=data.fixtures.filter(f=>['high','moderate','offline'].includes(f.category)).length;
 return <><ProductHeader active="fleet" query={query} onQuery={setQuery}/><main className={styles.shell}><OceanWaves/>
  <div className={styles.heading}><h1>Dashboard</h1><p>{data.fixtures.length} {data.fixtures.length===1?'unit':'units'} · {data.source==='sensor'?'Physical sensors':'Simulation recordings'}</p></div>
  <div className={styles.tools}><label>Data <select aria-label="Data" value={data.source} onChange={e=>data.setSource(e.target.value as 'sensor'|'simulation')}><option value="sensor">Physical sensors</option><option value="simulation">Simulation</option></select></label><button onClick={data.refresh} disabled={data.loading}>Refresh</button><details><summary>Account</summary><AccountPanel/></details></div>
  {data.error&&<div role="alert" className={styles.notice}><p>{data.error}</p>{data.needsAuth&&<><a href="/login">Sign in to your account</a></>}</div>}
  <section className={styles.summary} aria-label="Fleet overview"><div className={styles.summaryTop}><div className={styles.summaryIcon}><DesignAsset file="d7111.svg"/></div><strong className={styles.total}>{count}</strong><p><span>of {data.fixtures.length} units</span><strong>need attention</strong></p><a className={styles.secondary} href={`/alerts?source=${data.source}`}>{data.alerts.length} alerts</a></div><FleetFilters fixtures={data.fixtures} value={filter} onChange={setFilter}/><div className={styles.pipeStrip} aria-label="Units ordered by urgency">{data.fixtures.map(f=><a key={f.id} className={styles[f.category]} href={fixtureHref(f,data.source)} title={`${f.id}: ${f.name} · ${f.status}`} aria-label={`${f.name}: ${f.status}`} onMouseEnter={()=>setHover(f)} onMouseLeave={()=>setHover(null)} onFocus={()=>setHover(f)} onBlur={()=>setHover(null)}/>)}</div><div className={styles.stripCaption}><span aria-live="polite">{hover?`${hover.id}, ${hover.name}: ${hover.status}${hover.seconds!=null?`, last drain ${hover.seconds.toFixed(hover.seconds>=100?0:1)} s`:''}`:data.loading?'Updating fleet…':data.fixtures.length?'':'Add your first unit to begin.'}</span><span>Every block is one unit, most urgent on the left. Hover to identify, click to open.</span></div></section>
  {!data.loading&&!visible.length&&<section className={styles.notice}><h2>{data.fixtures.length?'No units match this filter':'Connect your first unit'}</h2><p>Connect the sensor and record a short empty-sink reference.</p><a className={styles.primary} href="/add-unit">Add unit</a></section>}
  {attention.length>0&&<section className={styles.section}><h2>Needs attention <small>{attention.length}</small></h2><div className={styles.cardGrid}>{attention.slice(0,expanded?undefined:8).map(f=><FixtureTile key={f.id} fixture={f} source={data.source}/>)}</div>{attention.length>8&&!expanded&&<button className={styles.secondary} onClick={()=>setExpanded(true)}>Show {attention.length-8} more</button>}</section>}
  {baseline.length>0&&<section className={styles.section}><h2>Needs baseline <small>{baseline.length}</small></h2><div className={styles.cardGrid}>{baseline.map(f=><FixtureTile key={f.id} fixture={f} source={data.source}/>)}</div></section>}
  {good.length>0&&<section className={styles.section}><h2>Looks good <small>{good.length}</small></h2><div className={styles.goodGrid}>{good.map(f=><FixtureTile key={f.id} fixture={f} source={data.source} compact/>)}</div></section>}
  <section className={styles.recordingTools}><button className={styles.secondary} aria-expanded={workbench} onClick={()=>setWorkbench(v=>!v)}>Installer tools</button>{workbench&&<RecordingWorkbench/>}</section>
 </main></>;
}
