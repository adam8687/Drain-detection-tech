import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import LiveView from './live-view';
import styles from './page.module.css';

const inter = Inter({ subsets: ['latin'], display: 'swap' });
export const metadata: Metadata = { title: 'Live View | Smart Housing', description: 'Measured water levels and drainage history from your recordings.' };

export default async function LiveDemoPage({ searchParams }: { searchParams: Promise<{ fixture?: string; record?: string; source?: string }> }) {
  const params = await searchParams;
  return <div className={`${styles.page} ${inter.className}`}><LiveView initialFixture={params.fixture || ''} initialRecord={params.record || ''} initialSource={params.source === 'simulation' ? 'simulation' : 'sensor'} /></div>;
}
