import type { Metadata } from 'next';
import Image from 'next/image';
import AccountPanel from '../../components/account-panel';
import styles from './page.module.css';

export const metadata: Metadata = { title: 'Sign in | Synk' };

export default function LoginPage() {
  return <main className={styles.page}>
    <header className={styles.header}>
      <a className={styles.brand} href="/" aria-label="Synk home">
        <Image className={styles.logo} src="/images/brand/synk-logo-transparent.png" alt="Synk" width={282} height={132} priority />
      </a>
      <a className={styles.back} href="/">← Back to home</a>
    </header>
    <div className={styles.wrap}>
      <p className={styles.tagline}><strong>Catch the slow drain before it becomes a clog.</strong><br />
      Sign in to register your building&apos;s sinks and watch every drain.</p>
      <AccountPanel />
    </div>
  </main>;
}
