import { ApiError } from './validation.js';

const specs = {
  devices: ['device_id', 'created_at'],
  device_members: ['id', 'device_id', 'user_id', 'role', 'created_at'],
  device_keys: ['key_hash', 'device_id', 'created_at'],
};
export class SupabaseAccessStore {
  constructor(url, key, fetcher = fetch) { this.url = url; this.key = key; this.fetcher = fetcher; }
  async request(table, query, options = {}) {
    if (!specs[table]) throw Error('Unknown access table');
    let response;
    try { response = await this.fetcher(`${this.url}/rest/v1/dm_${table}${query ? '?' + query : ''}`, {
      ...options, signal: AbortSignal.timeout(10000), headers: { apikey: this.key,
        ...(this.key.startsWith('eyJ') ? { Authorization: `Bearer ${this.key}` } : {}),
        'Content-Type': 'application/json', Prefer: 'return=representation' },
    }); } catch { throw new ApiError(503, 'storage_unavailable', 'Fixture access storage is unavailable'); }
    if (response.status === 409) throw new ApiError(409, 'conflict', 'Fixture or key already exists');
    if (!response.ok) throw new ApiError(503, 'storage_unavailable', 'Apply the fixture-access migration and check cloud configuration');
    return response.json();
  }
  async get(table, id) {
    const key = specs[table]?.[0];
    return (await this.request(table, new URLSearchParams({ select: 'payload', [key]: `eq.${id}`, limit: '1' })))[0]?.payload ?? null;
  }
  async list(table, filters = {}, limit = 100) {
    const query = new URLSearchParams({ select: 'payload', limit: String(limit), order: 'created_at.desc' });
    for (const [key, value] of Object.entries(filters)) {
      if (!specs[table]?.includes(key)) throw Error('Unknown access filter');
      query.set(key, `eq.${value}`);
    }
    return (await this.request(table, query)).map(row => row.payload);
  }
  async insert(table, payload) {
    const row = Object.fromEntries(specs[table].map(column => [column, payload[column]]));
    const result = await this.request(table, '', { method: 'POST', body: JSON.stringify({ ...row, payload }) });
    return result[0].payload;
  }
}
