'use client';
import {useMemo,useState} from 'react';
import ProductHeader from '../../components/product-header';
import OceanWaves from '../../components/ocean-waves';
import DesignAsset from '../../components/design-asset';
import {FleetFilters,FleetSparkline,fixtureHref} from '../../components/fleet-parts';
import {useFleet} from '../../lib/use-fleet';
import type {FleetCategory} from '../../lib/use-fleet';
import fleetStyles from '../dashboard/page.module.css';
import styles from './page.module.css';
export default function HeatMapPage(){
 const data=useFleet(),[query,setQuery]=useState(''),[filter,setFilter]=useState<'all'|FleetCategory>('all'),[selected,setSelected]=useState('');
 const visible=data.fixtures.filter(f=>(filter==='all'||f.category===filter)&&`${f.name} ${f.id}`.toLowerCase().includes(query.toLowerCase()));
 const groups=useMemo(()=>{
  const map=new Map<string,typeof visible>();
  for(const f of visible){const match=f.name.match(/\bfloor\s*(\d+)\b/i);const label=match?`Floor ${match[1]}`:'Other locations';if(!map.has(label))map.set(label,[]);map.get(label)!.push(f);}
  return [...map].sort(([a],[b])=>b.localeCompare(a,undefined,{numeric:true}));
 },[visible]);
 const current=visible.find(f=>f.id===selected)??visible[0];
 return <><ProductHeader active="heatmap" query={query} onQuery={setQuery}/><main className={fleetStyles.shell}><OceanWaves/>
  <div className={fleetStyles.heading}><h1>Heat map</h1><p>Every connected drain, marked by its current status.</p></div>
  <div className={fleetStyles.tools}><label>Data<select aria-label="Data" value={data.source} onChange={e=>data.setSource(e.target.value as 'sensor'|'simulation')}><option value="sensor">Physical sensors</option><option value="simulation">Simulation</option></select></label><button onClick={data.refresh}>Refresh</button></div>
  <FleetFilters fixtures={data.fixtures} value={filter} onChange={setFilter}/>
  {data.error&&<p role="alert" className={fleetStyles.notice}>{data.error} {data.needsAuth&&<a href="/login">Sign in</a>}</p>}
  <div className={styles.columns}><section className={styles.building} aria-labelledby="building-title"><div className={styles.buildingHeading}><h2 id="building-title">Your connected locations</h2><span>{visible.length} units</span></div>
    <div className={styles.buildingScroll} tabIndex={0} aria-label="Connected fixtures by location; scroll horizontally on smaller screens"><div className={styles.buildingCanvas}>
      <div className={styles.roof}><DesignAsset file="9e4c6.svg"/></div>
      {groups.length?groups.map(([floor,fixtures],i)=><div key={floor} className={styles.floorRow}><DesignAsset file={i===0?'910a6.svg':'71ec9.svg'}/><div className={styles.floorBody}><div className={styles.floorLabel}><strong>{floor}</strong><span>{fixtures.filter(f=>f.category==='high'||f.category==='moderate').length} need attention</span></div><div className={styles.rooms}>{fixtures.map(f=><button key={f.id} className={`${styles.room} ${styles[f.category]}`} aria-pressed={current?.id===f.id} aria-label={`${f.name}: ${f.status}`} onClick={()=>setSelected(f.id)} title={`${f.name} · ${f.id} · ${f.status}`}>{f.name.match(/\broom\s*(\d+)\b/i)?.[1]??f.name}</button>)}</div></div></div>):<p className={styles.noRooms}>{data.loading?'Loading your locations…':'No fixtures are mapped yet. Add a unit and give it a location.'}</p>}
      <DesignAsset file="27356.svg"/>
    </div></div>
    <p className={styles.caption}>Locations come from your unit names. Select a unit to see its readings and history.</p>
  </section>
  <aside className={styles.detail} aria-label="Selected fixture">{current?<><div className={styles.fixtureArt}><DesignAsset file="52cde.svg"/></div><div className={styles.detailTitle}><h2>{current.name}</h2><span className={fleetStyles.status}>{current.status}</span></div><strong>{current.id}</strong><div className={styles.measurement}><strong>{current.seconds?.toFixed(1)??'—'}</strong><span>s</span></div><FleetSparkline fixture={current} large/><dl><div><dt>Usual drain time</dt><dd>{current.usual==null?'Learning':`${current.usual.toFixed(1)} s`}</dd></div><div><dt>Empty reference</dt><dd>{current.emptyReady?'Saved':'Not recorded'}</dd></div><div><dt>Saved recordings</dt><dd>{current.history.length}</dd></div></dl><a className={fleetStyles.primary} href={fixtureHref(current,data.source)}>Open live view</a><a className={fleetStyles.secondary} href={`/add-unit?fixture=${encodeURIComponent(current.id)}`}>Device setup</a></>:<><h2>Select a unit</h2><p>Connected fixtures will appear here after setup.</p><a className={fleetStyles.primary} href="/add-unit">Add unit</a></>}</aside></div>
 </main></>;
}
