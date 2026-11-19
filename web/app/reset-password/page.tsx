import type { Metadata } from 'next';
import Image from 'next/image';
import AccountPanel from '../../components/account-panel';
import styles from '../login/page.module.css';

export const metadata: Metadata = { title: 'Reset password | Synk' };

export default function ResetPasswordPage(){return <main className={styles.page}>
  <header className={styles.header}>
    <a className={styles.brand} href="/" aria-label="Synk home"><Image className={styles.logo} src="/images/brand/synk-logo-transparent.png" alt="Synk" width={282} height={132} priority /></a>
    <a className={styles.back} href="/login">← Back to sign in</a>
  </header>
  <div className={styles.wrap}><AccountPanel recovery/></div>
</main>;}
