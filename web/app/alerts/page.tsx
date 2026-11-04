import type { Metadata } from 'next';
import AlertsList from './alerts-list';

export const metadata: Metadata = { title: 'Alerts | Drain Monitor' };

export default function AlertsPage() {
  return <AlertsList />;
}
