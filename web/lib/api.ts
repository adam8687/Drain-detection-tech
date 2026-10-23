export type Source = 'mock' | 'hardware';
export type SensorId = 'a' | 'b';
export type SensorInput = { sensor_id: SensorId } & (
  | { status: 'ok'; distance_mm: number; echo_us?: null }
  | { status: 'ok'; echo_us: number; distance_mm?: null }
  | { status: 'timeout' | 'out_of_range'; distance_mm?: null; echo_us?: null }
);
export interface FrameInput {
  event_id: string;
  device_id: string;
  boot_id: string;
  sequence: number;
  source: Source;
  captured_at?: string | null;
  temperature_c?: number | null;
  readings: [SensorInput, SensorInput];
}
export interface Level {
  sensor_id: SensorId;
  status: 'ok' | 'timeout' | 'out_of_range';
  distance_mm: number | null;
  depth_mm: number | null;
  quality: string;
}
export interface Frame extends FrameInput {
  received_at: string;
  measured_at: string;
  time_basis: 'device_clock' | 'server_received';
  calibration_id: string | null;
  levels: Level[];
}
export interface CalibrationInput {
  empty_distance_mm: { a: number; b: number };
  wet_threshold_mm?: number;
  dry_threshold_mm?: number;
  stable_samples?: number;
  max_gap_ms?: number;
}
export interface Calibration extends CalibrationInput { id: string; device_id: string; created_at: string }
export interface Device { device_id: string; name: string; created_at: string }
export interface Analysis {
  outcome: 'completed' | 'incomplete' | 'inconclusive';
  reason: string;
  drain_duration_ms: number | null;
  wet_at?: string | null;
  dry_at?: string | null;
  completed_at?: string | null;
  frame_count?: number;
  invalid_frames?: number;
  timing_basis?: string[];
}
export interface DrainTest {
  id: string;
  device_id: string;
  name: string;
  source: Source;
  status: 'active' | 'finished';
  started_at: string;
  finished_at: string | null;
  calibration_id: string;
  analysis?: Analysis;
}
export class DrainApiError extends Error {
  status: number;
  code: string;
  requestId?: string;
  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message); this.name = 'DrainApiError'; this.status = status; this.code = code; this.requestId = requestId;
  }
}
export class DrainApi {
  baseUrl: string;
  token: string;
  fetcher: typeof fetch;
  constructor(baseUrl: string, token = '', fetcher: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); this.token = token;
    // Browser fetch requires the Window/global receiver. Calling an unbound
    // native fetch as this.fetcher(...) would pass the DrainApi instance instead.
    this.fetcher = fetcher.bind(globalThis);
  }
  private async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}/api/v1${path}`, {
      method, cache: 'no-store', headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
    });
    const value = await response.json();
    if (!response.ok) throw new DrainApiError(response.status, value.error?.code || 'request_failed', value.error?.message || 'Request failed', value.error?.request_id);
    return value as T;
  }
  devices() { return this.request<{ devices: Device[] }>('/devices'); }
  register(device_id: string, name: string) { return this.request<Device>('/devices', 'POST', { device_id, name }); }
  device(id: string, source: Source = 'hardware') {
    return this.request<Device & { source: Source; calibration: Calibration | null; latest: Frame | null; stale: boolean }>(`/devices/${encodeURIComponent(id)}?source=${source}`);
  }
  calibrate(id: string, calibration: CalibrationInput) { return this.request<Calibration>(`/devices/${encodeURIComponent(id)}/calibrations`, 'POST', calibration); }
  ingest(frame: FrameInput) { return this.request<{ duplicate: boolean; reading: Frame }>('/readings', 'POST', frame); }
  history(id: string, source: Source = 'hardware', limit = 100) {
    return this.request<{ readings: Frame[]; order: 'newest_first'; limit: number }>(`/devices/${encodeURIComponent(id)}/readings?source=${source}&limit=${limit}`);
  }
  startTest(id: string, source: Source, name = 'Drainage test') { return this.request<DrainTest>(`/devices/${encodeURIComponent(id)}/sessions`, 'POST', { source, name }); }
  tests(id: string) { return this.request<{ sessions: DrainTest[] }>(`/devices/${encodeURIComponent(id)}/sessions`); }
  test(id: string) { return this.request<DrainTest>(`/sessions/${encodeURIComponent(id)}`); }
  finishTest(id: string) { return this.request<DrainTest>(`/sessions/${encodeURIComponent(id)}/finish`, 'POST'); }
}
