// Optional Next.js proxy. The canonical ingestion route is the backend's
// POST /api/v1/readings. Do not inject Supabase or privileged backend keys here.
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const error = (status: number, code: string, message: string) => Response.json({ error: { code, message, request_id: crypto.randomUUID() } }, { status });
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return error(415, 'unsupported_media_type', 'Send Content-Type: application/json');
  const reader = request.body?.getReader();
  if (!reader) return error(400, 'invalid_json', 'Missing JSON body');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 16384) { await reader.cancel(); return error(413, 'payload_too_large', 'JSON body exceeds 16KB'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const authorization = request.headers.get('authorization');
    const response = await fetch(`${(process.env.BACKEND_URL || 'http://127.0.0.1:8000').replace(/\/$/, '')}/api/v1/readings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) },
      body: bytes, signal: AbortSignal.timeout(10000), redirect: 'error',
    });
    return new Response(response.body, { status: response.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(response.headers.get('x-request-id') ? { 'X-Request-ID': response.headers.get('x-request-id')! } : {}) } });
  } catch { return error(503, 'backend_unavailable', 'Drain backend unavailable'); }
}
