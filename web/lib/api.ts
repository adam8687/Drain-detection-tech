export type DataSource = 'sensor' | 'simulation';
export type RecordType = 'calibration' | 'drainage' | 'monitoring';
export interface DrainageCapture {capture_id:string;recording_id:string;from_reading_id:string;confirmed_at:string;tap_off_confirmed:true;clear_drain_confirmed:true}
export interface DrainageBand {from_depth_mm:number;to_depth_mm:number;duration_seconds:number}
export interface DrainageRun {capture_id:string;recording_id:string;from_reading_id:string;to_reading_id:string;confirmed_at:string;ended_at:string;duration_seconds:number;recession_mm_per_second:number;uncertainty_seconds:number;sample_count:number;bands:DrainageBand[]}
export interface DrainageProfile {clear_drain_confirmed:true;resolution:'banded'|'instant';noise_seconds:number;variation_seconds:number;policy:{slow_ratio:number;severe_ratio:number;repeat_count:number;repeat_window:number;standing_water_margin_seconds:number;min_slow_seconds:number;min_severe_seconds:number};bands:{from_depth_mm:number;to_depth_mm:number;expected_seconds:number;variation_seconds:number;tolerance_seconds:number;slow_seconds:number}[];total:{expected_seconds:number;tolerance_seconds:number;slow_seconds:number;severe_seconds:number;standing_water_seconds:number}}
export interface DrainageCalibration {version:1|2;profile?:DrainageProfile|null;method:'tap_off_drawdown';status:'collecting'|'ready';upper_depth_mm:30;lower_depth_mm:10;runs:DrainageRun[];active_capture:DrainageCapture|null;baseline_duration_seconds:number|null;baseline_recession_mm_per_second:number|null;bands:DrainageBand[];repeatability_ratio:number|null;measured_at:string|null;last_issue:string|null}
export interface Calibration { empty_distance_mm: number; drainage?:DrainageCalibration }
export interface SensorReading { distance_mm: number | null; status: 'ok' | 'timeout' | 'out_of_range' }
export interface Measurement { reading_id: string; timestamp: string; sensor: SensorReading }
export interface DrainResult { drainage_time_seconds: number | null; outcome: 'completed' | 'incomplete' | 'uncertain' }
export type DrainStatusLabel = 'learning' | 'unknown' | 'in_progress' | 'normal' | 'slow_drain' | 'running_too_long';
export interface DrainStatus { status: DrainStatusLabel; baseline_seconds: number | null; ratio: number | null; elapsed_seconds: number | null; slow_threshold_seconds: number | null; timeout_threshold_seconds: number | null; baseline_count: number; baseline_record_ids: string[]; baseline_depth_mm: number | null; repeated_slow: boolean; message: string; empty_shift_mm?: number | null; baseline_source?: 'drainage_profile' | 'learned_drains' | null; tolerance_seconds?: number; severe_threshold_seconds?: number; severe?: boolean; matched_bands?: { from_depth_mm: number; to_depth_mm: number; observed_seconds: number; expected_seconds: number; slow_seconds: number }[] }
export interface DrainCycle { cycle_id:string; started_at:string; ended_at:string; drainage_time_seconds:number|null; outcome:'completed'|'incomplete'|'uncertain' }
export interface RecordSummary { schema_version?:1|2; parent_record_id?:string; drain_cycles?:DrainCycle[]; record_id: string; fixture_id: string; record_type: RecordType; data_source: DataSource; recording_status: 'recording' | 'finished'; calibration: Calibration | null; result: DrainResult | null; created_at: string; measurement_count: number; drain_status: DrainStatus | null }
export interface DrainRecord extends Omit<RecordSummary, 'measurement_count' | 'drain_status'> { measurements: Measurement[] }
export interface WaterLevelPoint { elapsed_seconds: number; depth_mm: number | null; gap_before: boolean }
export interface RecordView { record: DrainRecord; computed: { series_mode?:'append'|'replace'; drain_cycles?:DrainCycle[]; monitoring_limits?: {slow_seconds:number; standing_water_seconds:number}; sensor_connection?: 'waiting'|'problem'|'stale'|'connected'; setup_guidance?: {phase:'needs_calibration'|'waiting'|'sensor_problem'|'add_water'|'water_ready'; message:string; water_depth_mm:number|null; target_depth_mm:number}; forecast: { state: 'forecast' | 'dry' | 'unavailable'; seconds_remaining: number | null; message: string }; timeline: { elapsed_seconds: number; seconds_remaining: number | null }[]; water_levels?: WaterLevelPoint[]; sample_index: number; sample_count: number; first_measurement_at?:string|null; elapsed_seconds: number; stale: boolean; calibration_progress: number | null; calibration_message: string | null; drain_status: DrainStatus | null } }
export type AlertSeverity = 'critical' | 'warning' | 'info';
export type AlertType = 'running_too_long' | 'slow_drain' | 'worsening_trend' | 'unreliable_result' | 'sensor_faults' | 'device_silent' | 'empty_level_shift';
export interface DrainAlert { alert_id: string; type: AlertType; severity: AlertSeverity; title: string; message: string; occurred_at: string; fixture_id: string; data_source: DataSource; record_id: string; record_type: RecordType; details: Record<string, unknown> }
export interface AlertSummary { total: number; critical: number; warning: number; info: number }
export interface AlertList { summary: AlertSummary; alerts: DrainAlert[]; generated_at: string }
export class DrainApiError extends Error { status: number; code: string; constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; } }
export class DrainApi {
  baseUrl: string; token: string; fetcher: typeof fetch;
  constructor(baseUrl = '/api/backend', token = '', fetcher: typeof fetch = fetch) { this.baseUrl = baseUrl; this.token = token; this.fetcher = fetcher.bind(globalThis); }
  async request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try { response = await this.fetcher(`${this.baseUrl}/api/v1${path}`, { method, cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new DrainApiError(503, 'connection_lost', 'Connection lost. Check your connection and try again.');
    }
    const value = await response.json();
    if (!response.ok) throw new DrainApiError(response.status, value.error?.code || 'request_failed', value.error?.message || 'Request failed');
    return value;
  }
  register(device_id: string, name: string) { return this.request<{device_id: string}>('/devices', 'POST', {device_id, name}); }
  devices(signal?: AbortSignal) { return this.request<{ devices: { device_id: string; name: string }[] }>('/devices', 'GET', undefined, signal); }
  recordSummaries(source: DataSource, signal?: AbortSignal) { return this.request<{ records: RecordSummary[] }>(`/records?data_source=${source}&limit=200`, 'GET', undefined, signal); }
  createDeviceKey(id: string) { return this.request<{device_id: string; key: string}>(`/devices/${encodeURIComponent(id)}/keys`, 'POST', {}); }
  calibrationRecords(fixture:string,source:DataSource,signal?:AbortSignal){return this.request<{records:RecordSummary[]}>(`/records?fixture_id=${encodeURIComponent(fixture)}&data_source=${source}&record_type=calibration&recording_status=finished&limit=200`,'GET',undefined,signal);}
  records(fixture: string, source: DataSource, signal?: AbortSignal) { return this.request<{ records: RecordSummary[] }>(`/records?fixture_id=${encodeURIComponent(fixture)}&data_source=${source}`, 'GET', undefined, signal); }
  record(id: string, sample: number | null = null, signal?: AbortSignal, window?: number, after?: string) { const query=new URLSearchParams(); if(sample!==null)query.set('sample',String(sample)); if(window)query.set('window',String(window)); if(after)query.set('after',after); return this.request<RecordView>(`/records/${encodeURIComponent(id)}${query.size?'?'+query:''}`, 'GET', undefined, signal); }
  start(fixture_id: string, data_source: DataSource, record_type: RecordType, confirm_empty = false) { return this.request<DrainRecord>('/records', 'POST', { fixture_id, data_source, record_type, ...(record_type === 'calibration' ? { confirm_empty } : {}) }); }
  alerts(filters: { fixture?: string; source?: DataSource; severity?: AlertSeverity; limit?: number } = {}, signal?: AbortSignal) {
    const query = new URLSearchParams();
    if (filters.fixture) query.set('fixture_id', filters.fixture);
    if (filters.source) query.set('data_source', filters.source);
    if (filters.severity) query.set('severity', filters.severity);
    if (filters.limit) query.set('limit', String(filters.limit));
    return this.request<AlertList>(`/alerts${query.size ? `?${query}` : ''}`, 'GET', undefined, signal);
  }
  emailPreference(fixture:string,signal?:AbortSignal){return this.request<{enabled:boolean;threshold_seconds:number|null;provider_configured:boolean;learning_threshold_seconds:number}>(`/devices/${encodeURIComponent(fixture)}/notifications`,'GET',undefined,signal);}
  saveEmailPreference(fixture:string,enabled:boolean,threshold_seconds:number|null){return this.request<{enabled:boolean;threshold_seconds:number|null;provider_configured:boolean;learning_threshold_seconds:number}>(`/devices/${encodeURIComponent(fixture)}/notifications`,'POST',{enabled,threshold_seconds});}
  calibrateDrainage(id:string,input:{action:'start';recording_id:string;confirm_tap_off:true;confirm_clear:true}|{action:'complete'|'cancel';capture_id:string}){return this.request<{record_id:string;calibration:Calibration}>(`/records/${encodeURIComponent(id)}/drainage-calibration`,'POST',input);}
  finish(id: string) { return this.request<RecordView>(`/records/${encodeURIComponent(id)}/finish`, 'POST'); }
}
