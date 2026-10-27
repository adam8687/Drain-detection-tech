export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function forward(request: Request, context: { params: Promise<{ path: string[] }> }, method: 'GET' | 'POST') {
  const route = (await context.params).path.join('/');
  const list = route === 'api/v1/records';
  const devices = route === 'api/v1/devices';
  const keyCreation = /^api\/v1\/devices\/[a-zA-Z0-9_-]+\/keys$/.test(route);
  const detail = /^api\/v1\/records\/[0-9a-f-]+$/i.test(route);
  const mutation = /^api\/v1\/records\/[0-9a-f-]+\/(measurements|finish)$/i.test(route);
  if (!(method === 'GET' ? list || detail || devices : list || mutation || devices || keyCreation)) return Response.json({ error: { code: 'not_found', message: 'Unsupported record route' } }, { status: 404 });
  let bytes: Uint8Array | undefined;
  if (method === 'POST' && !route.endsWith('/finish')) {
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return Response.json({ error: { message: 'Send Content-Type: application/json' } }, { status: 415 });
    const reader = request.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    if (reader) while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 16384) { await reader.cancel(); return Response.json({ error: { message: 'Request exceeds 16KB' } }, { status: 413 }); } chunks.push(next.value); }
    bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  }
  const target = new URL(`/${route}`, process.env.BACKEND_URL || 'http://127.0.0.1:8000'); target.search = new URL(request.url).search;
  try {
    const auth = request.headers.get('authorization');
    const response = await fetch(target, { method, cache: 'no-store', redirect: 'error', signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]), headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, ...(bytes ? { body: bytes as BodyInit } : {}) });
    return new Response(response.body, { status: response.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ error: { code: 'backend_unavailable', message: 'Start the backend with npm start and apply the drain_records migration.' } }, { status: 503 }); }
}
export const GET = (request: Request, context: { params: Promise<{ path: string[] }> }) => forward(request, context, 'GET');
export const POST = (request: Request, context: { params: Promise<{ path: string[] }> }) => forward(request, context, 'POST');
