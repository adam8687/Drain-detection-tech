'use client';
import DesignAsset from './design-asset';
import type {DataSource} from '../lib/api';
import type {FixtureCard,FleetCategory} from '../lib/use-fleet';
import styles from '../app/dashboard/page.module.css';
export const categories:{id:'all'|FleetCategory;label:string}[]=[{id:'all',label:'All'},{id:'high',label:'High'},{id:'moderate',label:'Moderate'},{id:'offline',label:'Offline'},{id:'baseline',label:'Needs baseline'},{id:'good',label:'Good'}];
export const fixtureHref=(f:FixtureCard,source:DataSource)=>`/live-demo?fixture=${encodeURIComponent(f.id)}&source=${source}${f.record?`&record=${f.record.record_id}`:''}`;
export function ago(iso:string|null,now=Date.now()){
 if(!iso)return null;const s=Math.max(0,(now-Date.parse(iso))/1000);
 if(s<45)return 'just now';if(s<3600)return `${Math.round(s/60)} min ago`;if(s<86400)return `${Math.round(s/3600)} hr ago`;return `${Math.round(s/86400)} d ago`;
}
export function FleetFilters({fixtures,value,onChange}:{fixtures:FixtureCard[];value:string;onChange:(v:'all'|FleetCategory)=>void}){
 return <div className={styles.chips} role="group" aria-label="Filter units by status">{categories.map(c=><button key={c.id} className={styles.chip} aria-pressed={value===c.id} onClick={()=>onChange(c.id)}>{c.id!=='all'&&<i className={styles[c.id]}/>}<span>{c.label}</span><small>{c.id==='all'?fixtures.length:fixtures.filter(f=>f.category===c.id).length}</small></button>)}</div>;
}
export function FleetSparkline({fixture,large=false}:{fixture:FixtureCard;large?:boolean}){
 const values=fixture.history.filter(r=>r.result?.outcome==='completed'&&r.result.drainage_time_seconds!=null).slice(0,12).reverse().map(r=>r.result!.drainage_time_seconds!);
 if(values.length<2)return <span className={styles.historyNote}>History building</span>;
 const low=Math.min(...values)*.85,span=Math.max(1,Math.max(...values)-low);
 return <svg viewBox="0 0 110 30" width={large?312:110} height={large?85:30} role="img" aria-label={`Recent drain times: ${values.map(v=>v.toFixed(1)).join(', ')} seconds`}><polyline points={values.map((v,i)=>`${i/(values.length-1)*108+1},${28-(v-low)/span*24}`).join(' ')} fill="none" stroke={fixture.category==='high'?'#e8702a':'#2563ae'} strokeWidth="2"/></svg>;
}
export function FixtureTile({fixture,source,compact=false}:{fixture:FixtureCard;source:DataSource;compact?:boolean}){
 const f=fixture;
 if(compact)return <a className={styles.goodTile} href={fixtureHref(f,source)}><DesignAsset file="fbc19.svg"/><div><strong>{f.id}</strong><span>{f.name}</span></div><FleetSparkline fixture={f}/></a>;
 const art=f.category==='high'?'1c1e6.svg':f.category==='moderate'?'862d6.svg':f.category==='baseline'?'8808a.svg':'10982.svg';
 const mark=f.category==='high'?'4212a.svg':'565c4.svg';
 return <article className={`${styles.fixtureTile} ${styles[`tile_${f.category}`]}`}>
  <a className={styles.illustration} href={fixtureHref(f,source)} aria-label={`Open ${f.name}`}><div className={styles.paperInset}/><div className={styles.sink}><DesignAsset file={art}/></div><div className={styles.statusBadge}><DesignAsset file={mark}/><div className={styles.badgeGlyph}><DesignAsset file={f.category==='baseline'?'67015.svg':f.status==='Running too long'?'7465d.svg':f.category==='high'?'b0645.svg':'8c473.svg'}/></div></div></a>
  <div className={styles.tileBody}><div className={styles.tileMeta}><span className={styles.status} title={f.reason??undefined}>{f.status}</span>{f.category!=='baseline'&&f.at&&<time dateTime={f.at}>{ago(f.at)}</time>}</div><a href={fixtureHref(f,source)} className={styles.fixtureName}>{f.name}</a><span className={styles.fixtureId}>{f.id}</span>
  {f.category==='baseline'?<><p>Not taught yet. Record a flush and a drain to start monitoring.</p><a className={styles.secondary} href={`/add-unit?fixture=${encodeURIComponent(f.id)}`}>Teach baseline</a></>:<div className={styles.tileValue}><strong>{f.seconds==null?'—':f.seconds.toFixed(f.seconds>=100?0:1)}<small>s</small></strong><div><FleetSparkline fixture={f}/><span>{f.seconds!=null&&f.usual!=null?`${f.seconds-f.usual>=0?'+':''}${(f.seconds-f.usual).toFixed(1)} s vs baseline`:'Baseline learning'}</span></div></div>}
  </div>
 </article>;
}
