export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export function fail(message, status = 422, code = 'validation_error') { throw new ApiError(status, code, message); }
export function object(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected a JSON object');
  const unknown = Object.keys(value).filter(k => !fields.includes(k));
  if (unknown.length) fail(`Unknown fields: ${unknown.join(', ')}`);
  return value;
}
export function text(value, name, max = 100) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${name} must be a nonempty string of at most ${max} characters`);
  return value.trim();
}
export function deviceId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value)) fail('device_id must contain 1–64 letters, digits, underscores or hyphens');
  return value;
}
export function uuid(value, name = 'event_id') {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) fail(`${name} must be a UUID`);
  return value.toLowerCase();
}
export function number(value, name, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail(`${name} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}`);
  return value;
}
export function source(value) {
  if (!['mock', 'hardware'].includes(value)) fail('source must be mock or hardware');
  return value;
}
export function timestamp(value, name = 'captured_at') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail(`${name} must be an ISO timestamp with timezone`);
  return new Date(value).toISOString();
}
export function validateDevice(body) {
  object(body, ['device_id', 'name']);
  return { device_id: deviceId(body.device_id), name: text(body.name, 'name') };
}
export function validateCalibration(body) {
  object(body, ['empty_distance_mm', 'wet_threshold_mm', 'dry_threshold_mm', 'stable_samples', 'max_gap_ms']);
  object(body.empty_distance_mm, ['a', 'b']);
  const result = {
    empty_distance_mm: { a: number(body.empty_distance_mm.a, 'empty_distance_mm.a', 20, 4500), b: number(body.empty_distance_mm.b, 'empty_distance_mm.b', 20, 4500) },
    wet_threshold_mm: number(body.wet_threshold_mm ?? 20, 'wet_threshold_mm', 5, 1000),
    dry_threshold_mm: number(body.dry_threshold_mm ?? 8, 'dry_threshold_mm', 0, 1000),
    stable_samples: number(body.stable_samples ?? 3, 'stable_samples', 2, 20, true),
    max_gap_ms: number(body.max_gap_ms ?? 5000, 'max_gap_ms', 100, 60000, true),
  };
  if (result.dry_threshold_mm >= result.wet_threshold_mm) fail('dry_threshold_mm must be smaller than wet_threshold_mm');
  return result;
}
export function validateFrame(body, now = Date.now()) {
  object(body, ['event_id', 'device_id', 'boot_id', 'sequence', 'captured_at', 'source', 'temperature_c', 'readings']);
  const captured = body.captured_at == null ? null : timestamp(body.captured_at);
  if (captured && Date.parse(captured) > now + 120000) fail('captured_at is more than two minutes in the future');
  const temperature = body.temperature_c == null ? null : number(body.temperature_c, 'temperature_c', -20, 70);
  if (!Array.isArray(body.readings) || body.readings.length !== 2) fail('readings must contain exactly sensors a and b');
  const readings = body.readings.map(r => {
    object(r, ['sensor_id', 'status', 'distance_mm', 'echo_us']);
    if (!['a', 'b'].includes(r.sensor_id)) fail('sensor_id must be a or b');
    if (!['ok', 'timeout', 'out_of_range'].includes(r.status)) fail('status must be ok, timeout or out_of_range');
    const hasDistance = r.distance_mm != null, hasEcho = r.echo_us != null;
    if (r.status !== 'ok') {
      if (hasDistance || hasEcho) fail('Failed readings must omit distance_mm and echo_us, or set them to null');
      return { sensor_id: r.sensor_id, status: r.status, distance_mm: null, echo_us: null };
    }
    if (hasDistance === hasEcho) fail('Each ok reading requires exactly one of distance_mm or echo_us');
    if (hasDistance) number(r.distance_mm, 'distance_mm', 20, 4500);
    if (hasEcho) {
      number(r.echo_us, 'echo_us', 1, 40000);
      const distance = r.echo_us * (331.3 + 0.606 * (temperature ?? 20)) / 2000;
      if (distance < 20 || distance > 4500) fail('echo_us converts to a distance outside the US-100 20–4500mm range; use out_of_range');
    }
    return { sensor_id: r.sensor_id, status: r.status, distance_mm: hasDistance ? r.distance_mm : null, echo_us: hasEcho ? r.echo_us : null };
  }).sort((a, b) => a.sensor_id.localeCompare(b.sensor_id));
  if (readings[0].sensor_id === readings[1].sensor_id) fail('Duplicate sensor_id');
  return {
    event_id: uuid(body.event_id), device_id: deviceId(body.device_id),
    boot_id: uuid(body.boot_id, 'boot_id'), sequence: number(body.sequence, 'sequence', 0, 2147483647, true),
    captured_at: captured, source: source(body.source), temperature_c: temperature, readings,
  };
}
