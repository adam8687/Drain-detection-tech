import { redirect } from 'next/navigation';

export default async function DrainPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(/^[a-zA-Z0-9_-]{1,64}$/.test(id) ? `/live-demo?fixture=${encodeURIComponent(id)}` : '/dashboard');
}
