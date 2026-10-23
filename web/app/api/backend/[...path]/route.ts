// Read-only same-origin gateway. Supabase credentials stay on the backend.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await context.params;
  const route = path.join('/');
  if (!/^api\/v1\/devices(?:\/[a-zA-Z0-9_-]+(?:\/(?:readings|sessions))?)?$/.test(route)) return Response.json({ error: { code: 'not_found', message: 'Unsupported read route' } }, { status: 404 });
  const target = new URL(`/${route}`, process.env.BACKEND_URL || 'http://127.0.0.1:8000');
  target.search = new URL(request.url).search;
  const authorization = request.headers.get('authorization');
  try {
    const response = await fetch(target, { cache: 'no-store', redirect: 'error', signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]), headers: { Accept: 'application/json', ...(authorization ? { Authorization: authorization } : {}) } });
    return new Response(response.body, { status: response.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ error: { code: 'backend_unavailable', message: 'Start the backend with npm start to read Supabase data.' } }, { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
}
