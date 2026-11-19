import type { Metadata } from 'next';
import AlertsList from './alerts-list';

export const metadata: Metadata = { title: 'Alerts | Synk' };

export default function AlertsPage() {
  return <AlertsList />;
}
