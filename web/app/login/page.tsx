import type { Metadata } from 'next';
import Image from 'next/image';
import AccountPanel from '../../components/account-panel';
import styles from './page.module.css';

export const metadata: Metadata = { title: 'Sign in | Smart Housing' };

export default function LoginPage() {
  return <main className={styles.page}>
    <header className={styles.header}>
      <a className={styles.brand} href="/">
        <Image src="/images/marketing/logo.png" alt="" width={28} height={28} />
        Company Name
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
