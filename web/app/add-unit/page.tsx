import type { Metadata } from 'next';
import AddUnitFlow from './add-unit-flow';
import shell from '../live-demo/page.module.css';

export const metadata: Metadata = { title: 'Add a unit | Smart Housing', description: 'Register a sensor, connect it, then teach it what a normal drain looks like.' };

export default function AddUnitPage() {
  return <div className={shell.page}><AddUnitFlow /></div>;
}
