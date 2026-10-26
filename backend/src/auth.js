// Supabase auth user verification

import { createHash, randomBytes } from 'node:crypto';

export const DEVICE_KEY_PREFIX = 'dk_';
export function hashDeviceKey(key) { return createHash('sha256').update(key).digest('hex'); }
export function newDeviceKey() { return `${DEVICE_KEY_PREFIX}${randomBytes(32).toString('base64url')}`; }

export function supabaseUserVerifier(url, key, fetcher = fetch, ttlMs = 30000) {
  const cache = new Map();
  return async token => {
    const id = hashDeviceKey(token);
    const hit = cache.get(id);
    if (hit && hit.expires > Date.now()) return hit.userId;
    let response;
    try {
      response = await fetcher(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(8000) });
    } catch { return null; }
    const userId = response.ok ? (await response.json().catch(() => null))?.id ?? null : null;
    if (cache.size > 1000) cache.clear();
    if (userId) cache.set(id, { userId, expires: Date.now() + ttlMs });
    return userId;
  };
}
