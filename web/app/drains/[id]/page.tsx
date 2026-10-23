// Minimal valid page; detailed views can use DrainApi.history() and .tests().
export default async function DrainPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <main><h1>Drain {id}</h1><p>Use the home page to select this device and view its readings.</p><a href="/">Back to devices</a></main>;
}
