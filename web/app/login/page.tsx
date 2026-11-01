import type { Metadata } from 'next';
import AccountPanel from '../../components/account-panel';
import styles from './page.module.css';

export const metadata: Metadata = { title: 'Log in | Drain Monitor' };

export default function LoginPage() {
  return <main className={styles.page}>
    <a href="/">← Back to home</a>
    <AccountPanel />
    <a href="/dashboard">Open dashboard →</a>
  </main>;
}
