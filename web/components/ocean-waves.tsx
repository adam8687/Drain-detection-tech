import DesignAsset from './design-asset';
import styles from './ocean-waves.module.css';
export default function OceanWaves({bottom=false,setup=false}:{bottom?:boolean;setup?:boolean}) {
 return <><div className={styles.top} aria-hidden="true"><DesignAsset file="758a5.svg"/><DesignAsset file="b3d3c.svg"/><DesignAsset file="8e921.svg"/></div>{setup&&<div className={styles.setupBottom} aria-hidden="true"><DesignAsset file="56700.svg"/></div>}{bottom&&<div className={styles.bottom} aria-hidden="true"><DesignAsset file="e999d.svg"/><DesignAsset file="53326.svg"/><DesignAsset file="68c5b.svg"/></div>}</>;
}
