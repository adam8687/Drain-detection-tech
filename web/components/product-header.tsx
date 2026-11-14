'use client';
import MobileMenu from './mobile-menu';
import DesignAsset from './design-asset';
import styles from './product-header.module.css';
export default function ProductHeader({active,query,onQuery,marketing=false}:{active?:'fleet'|'heatmap'|'add'|'live'|'alerts';query?:string;onQuery?:(value:string)=>void;marketing?:boolean}) {
  const links=marketing?<><a href="/#how-it-works">How it works</a><a href="/#for-hotels">For hotels</a><a href="/live-demo">Live demo</a><a href="/#demo">Get started</a></>:<><a href="/dashboard" aria-current={active==='fleet'?'page':undefined}>{active==='fleet'?'Dashboard':'Fleet'}</a>{active==='heatmap'&&<a href="/alerts">Alerts</a>}<a href="/heat-map" aria-current={active==='heatmap'?'page':undefined}>Heat map</a></>;
  return <header className={styles.header}>
    <a className={styles.brand} href="/" aria-label="Synk home"><DesignAsset file="10c6a.svg"/><span>Synk</span></a>
    <nav className={styles.navigation} aria-label="Main navigation">{links}</nav>
    {!marketing&&<form className={styles.search} action="/dashboard"><DesignAsset file="54f07.svg"/><input aria-label="Search units" name="q" placeholder={active==='fleet'?'Search by location':'Search units'} value={query} onChange={onQuery?e=>onQuery(e.target.value):undefined}/></form>}
    {marketing?<><a href="/login" className={styles.login}>Log in</a><a href="/add-unit" className={styles.primary}>Get started</a></>:<><a className={`${styles.primary} ${styles.add}`} href="/add-unit" aria-current={active==='add'?'page':undefined}>Add unit</a><a className={styles.avatar} href="/login" aria-label="Your account"><DesignAsset file="00808.svg"/></a></>}
    <MobileMenu>{links}<a href="/alerts">Alerts</a><a href="/add-unit">Add unit</a><a href="/login">Account</a></MobileMenu>
  </header>;
}
