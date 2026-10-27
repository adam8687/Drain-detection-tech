export type DataSource = 'sensor' | 'simulation';
export type RecordType = 'calibration' | 'drainage' | 'monitoring';
export interface Calibration { sensor_a_empty_mm: number; sensor_b_empty_mm: number }
export interface SensorReading { distance_mm: number | null; status: 'ok' | 'timeout' | 'out_of_range' }
export interface Measurement { reading_id: string; timestamp: string; sensor_a: SensorReading; sensor_b: SensorReading }
export interface DrainResult { drainage_time_seconds: number | null; outcome: 'completed' | 'incomplete' | 'uncertain' }
export interface RecordSummary { record_id: string; fixture_id: string; record_type: RecordType; data_source: DataSource; recording_status: 'recording' | 'finished'; calibration: Calibration | null; result: DrainResult | null; created_at: string; measurement_count: number }
export interface DrainRecord extends Omit<RecordSummary, 'measurement_count'> { measurements: Measurement[] }
export interface RecordView { record: DrainRecord; computed: { forecast: { state: 'forecast' | 'dry' | 'unavailable'; seconds_remaining: number | null; message: string }; timeline: { elapsed_seconds: number; seconds_remaining: number | null }[]; sample_index: number; sample_count: number; elapsed_seconds: number; stale: boolean; calibration_progress: number | null; calibration_message: string | null } }
export class DrainApiError extends Error { status: number; code: string; constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; } }
export class DrainApi {
  baseUrl: string; token: string; fetcher: typeof fetch;
  constructor(baseUrl = '/api/backend', token = '', fetcher: typeof fetch = fetch) { this.baseUrl = baseUrl; this.token = token; this.fetcher = fetcher.bind(globalThis); }
  async request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}/api/v1${path}`, { method, cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    if (!response.ok) throw new DrainApiError(response.status, value.error?.code || 'request_failed', value.error?.message || 'Request failed');
    return value;
  }
  register(device_id: string, name: string) { return this.request<{device_id: string}>('/devices', 'POST', {device_id, name}); }
  createDeviceKey(id: string) { return this.request<{device_id: string; key: string}>(`/devices/${encodeURIComponent(id)}/keys`, 'POST', {}); }
  records(fixture: string, source: DataSource, signal?: AbortSignal) { return this.request<{ records: RecordSummary[] }>(`/records?fixture_id=${encodeURIComponent(fixture)}&data_source=${source}`, 'GET', undefined, signal); }
  record(id: string, sample: number | null = null, signal?: AbortSignal) { return this.request<RecordView>(`/records/${encodeURIComponent(id)}${sample === null ? '' : `?sample=${sample}`}`, 'GET', undefined, signal); }
  start(fixture_id: string, data_source: DataSource, record_type: RecordType, confirm_empty = false) { return this.request<DrainRecord>('/records', 'POST', { fixture_id, data_source, record_type, ...(record_type === 'calibration' ? { confirm_empty } : {}) }); }
  finish(id: string) { return this.request<RecordView>(`/records/${encodeURIComponent(id)}/finish`, 'POST'); }
}
