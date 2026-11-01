export default async function DrainPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <main><h1>Drain {id}</h1><p>Use the dashboard to select this device and view its readings.</p><a href="/dashboard">Back to dashboard</a></main>;
}
