export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function forward(request: Request, context: { params: Promise<{ path: string[] }> }, method: 'GET' | 'POST') {
  const route = (await context.params).path.join('/');
  const list = route === 'api/v1/records';
  const devices = route === 'api/v1/devices';
  const alerts = route === 'api/v1/alerts';
  const sensorActive = route === 'api/v1/sensor/active-record';
  const keyCreation = /^api\/v1\/devices\/[a-zA-Z0-9_-]+\/keys$/.test(route);
  const notifications=/^api\/v1\/devices\/[a-zA-Z0-9_-]+\/notifications$/.test(route);
  const detail = /^api\/v1\/records\/[0-9a-f-]+$/i.test(route);
  const mutation = /^api\/v1\/records\/[0-9a-f-]+\/(measurements|finish|drainage-calibration)$/i.test(route);
  if (!(method === 'GET' ? list || detail || devices || alerts || sensorActive || notifications : list || mutation || devices || keyCreation || notifications)) return Response.json({ error: { code: 'not_found', message: 'Unsupported record route' } }, { status: 404 });
  let bytes: Uint8Array | undefined;
  if (method === 'POST' && !route.endsWith('/finish')) {
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return Response.json({ error: { message: 'Send Content-Type: application/json' } }, { status: 415 });
    const reader = request.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    if (reader) while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 16384) { await reader.cancel(); return Response.json({ error: { message: 'Request exceeds 16KB' } }, { status: 413 }); } chunks.push(next.value); }
    bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  }
  const cloud = process.env.SUPABASE_FUNCTION_URL;
  const base = (cloud || process.env.BACKEND_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
  const target = new URL(`${base}/${route}`); target.search = new URL(request.url).search;
  try {
    // Optional bench viewer can only read its one fixture. Never inject an admin
    // or sensor credential; browser writes still require the user's own session.
    const supplied = request.headers.get('authorization');
    const viewer = process.env.DRAIN_ENABLE_BENCH_VIEWER==='true' && cloud && method === 'GET' ? process.env.DRAIN_VIEWER_TOKEN : '';
    const auth = supplied || (viewer ? `Bearer ${viewer}` : null);
    const response = await fetch(target, { method, cache: 'no-store', redirect: 'error', signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]), headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, ...(bytes ? { body: bytes as BodyInit } : {}) });
    return new Response(response.body, { status: response.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ error: { code: 'backend_unavailable', message: cloud ? 'Supabase function unavailable. Check cloud deployment and network access.' : process.env.VERCEL ? 'The hosted API is not configured. Set SUPABASE_FUNCTION_URL in the Vercel project environment variables and redeploy.' : 'Start the backend with npm start and apply the drain_records migration.' } }, { status: 503 }); }
}
export const GET = (request: Request, context: { params: Promise<{ path: string[] }> }) => forward(request, context, 'GET');
export const POST = (request: Request, context: { params: Promise<{ path: string[] }> }) => forward(request, context, 'POST');
