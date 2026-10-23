import { mkdirSync, writeFileSync } from 'node:fs';
const ref = name => ({ $ref: `#/components/schemas/${name}` });
const str = { type: 'string' }, uuid = { type: 'string', format: 'uuid' }, time = { type: 'string', format: 'date-time' };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const identifier = { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,64}$' };
const source = { type: 'string', enum: ['mock','hardware'] };
const millimeters = { type: 'number', minimum: 20, maximum: 4500 };
const sensorId = { type: 'string', enum: ['a','b'] };
const nullValue = { type: 'null' };
const schemas = {
  RegisterDevice: object({ device_id: identifier, name: { type: 'string', minLength: 1, maxLength: 100 } }),
  CalibrationInput: object({ empty_distance_mm: object({ a: millimeters, b: millimeters }), wet_threshold_mm: { type: 'number', minimum: 5, maximum: 1000, default: 20 }, dry_threshold_mm: { type: 'number', minimum: 0, maximum: 1000, default: 8 }, stable_samples: { type: 'integer', minimum: 2, maximum: 20, default: 3 }, max_gap_ms: { type: 'integer', minimum: 100, maximum: 60000, default: 5000 } }, ['empty_distance_mm']),
  SensorInput: { oneOf: [
    object({ sensor_id: sensorId, status: { const: 'ok' }, distance_mm: millimeters, echo_us: nullValue }, ['sensor_id','status','distance_mm']),
    object({ sensor_id: sensorId, status: { const: 'ok' }, echo_us: { type: 'number', minimum: 1, maximum: 40000 }, distance_mm: nullValue }, ['sensor_id','status','echo_us']),
    object({ sensor_id: sensorId, status: { enum: ['timeout','out_of_range'] }, distance_mm: nullValue, echo_us: nullValue }, ['sensor_id','status']),
  ] },
  FrameInput: object({ event_id: uuid, device_id: identifier, boot_id: uuid, sequence: { type: 'integer', minimum: 0, maximum: 2147483647 }, captured_at: { anyOf: [time, nullValue], description: 'Omit/null before clock synchronization; never more than two minutes in the future.' }, source, temperature_c: { anyOf: [{ type: 'number', minimum: -20, maximum: 70 }, nullValue] }, readings: { type: 'array', minItems: 2, maxItems: 2, items: ref('SensorInput'), description: 'Exactly one sensor a and one b. Converted echo distance must also be within 20–4500mm.' } }, ['event_id','device_id','boot_id','sequence','source','readings']),
  SessionInput: object({ source, name: { type: 'string', minLength: 1, maxLength: 100 } }, ['source']),
  Analysis: { type: 'object', properties: { outcome: { enum: ['completed','incomplete','inconclusive'] }, reason: str, drain_duration_ms: { type: ['number','null'] }, wet_at: { anyOf: [time,nullValue] }, dry_at: { anyOf: [time,nullValue] }, completed_at: { anyOf: [time,nullValue] }, invalid_frames: { type: 'integer' }, frame_count: { type: 'integer' }, timing_basis: { type: 'array', items: { enum: ['device_clock','server_received'] } } } },
  Frame: { type: 'object', properties: { event_id: uuid, device_id: identifier, boot_id: uuid, sequence: { type: 'integer' }, source, measured_at: time, received_at: time, captured_at: { anyOf: [time,nullValue] }, calibration_id: { anyOf: [uuid,nullValue] }, time_basis: { enum: ['device_clock','server_received'] }, readings: { type: 'array', items: { type: 'object' } }, levels: { type: 'array', items: object({ sensor_id: sensorId, status: str, distance_mm: { type: ['number','null'] }, depth_mm: { type: ['number','null'] }, quality: str }) } } },
  Session: { type: 'object', properties: { id: uuid, device_id: identifier, source, name: str, status: { enum: ['active','finished'] }, started_at: time, finished_at: { anyOf: [time,nullValue] }, calibration_id: uuid, analysis: ref('Analysis') } },
  Error: object({ error: object({ code: str, message: str, request_id: uuid }) }),
};
const json = schema => ({ content: { 'application/json': { schema } } });
const id = { name: 'id', in: 'path', required: true, schema: identifier };
const sourceQuery = { name: 'source', in: 'query', schema: { ...source, default: 'hardware' } };
function operation(summary, responseSchema = { type: 'object' }, { body, parameters = [], created = false, security } = {}) {
  return { summary, ...(parameters.length ? { parameters } : {}), ...(body ? { requestBody: { required: true, ...json(ref(body)) } } : {}), ...(security !== undefined ? { security } : {}),
    responses: { [created ? '201' : '200']: { description: 'Success', ...json(responseSchema) }, ...Object.fromEntries([400,401,404,409,413,415,422,429,503].map(code => [String(code), { description: 'Request or storage error; inspect error.code', ...json(ref('Error')) }])) } };
}
const paths = {
  '/health': { get: operation('Liveness and configuration mode', undefined, { security: [] }) },
  '/ready': { get: operation('Database readiness', undefined, { security: [] }) },
  '/api/v1/devices': { get: operation('List at most 100 devices'), post: operation('Register a device', undefined, { body: 'RegisterDevice', created: true }) },
  '/api/v1/devices/{id}': { get: operation('Latest frame, calibration and stale flag', undefined, { parameters: [id, sourceQuery] }) },
  '/api/v1/devices/{id}/calibrations': { get: operation('Latest calibration', undefined, { parameters: [id] }), post: operation('Store an immutable empty-tub calibration', undefined, { body: 'CalibrationInput', parameters: [id], created: true }) },
  '/api/v1/readings': { post: operation('Ingest one two-sensor frame', object({ duplicate: { type: 'boolean' }, reading: ref('Frame') }), { body: 'FrameInput', created: true }) },
  '/api/v1/devices/{id}/readings': { get: operation('Bounded newest-first history', object({ readings: { type: 'array', items: ref('Frame') }, order: { const: 'newest_first' }, limit: { type: 'integer' } }), { parameters: [id,sourceQuery,{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },{ name: 'since', in: 'query', schema: time }] }) },
  '/api/v1/devices/{id}/stream': { get: operation('Live SSE connected/reading events and heartbeat; no replay; both sources', undefined, { parameters: [id] }) },
  '/api/v1/devices/{id}/sessions': { get: operation('List at most 30 tests', undefined, { parameters: [id] }), post: operation('Start a calibrated drainage test', ref('Session'), { body: 'SessionInput', parameters: [id], created: true }) },
  '/api/v1/sessions/{id}': { get: operation('Read test and analysis', ref('Session'), { parameters: [{ ...id, schema: uuid }] }) },
  '/api/v1/sessions/{id}/finish': { post: operation('Close a test and freeze its result; safe to retry', ref('Session'), { parameters: [{ ...id, schema: uuid }] }) },
};
paths['/api/v1/readings'].post.responses['200'] = { description: 'Idempotent retry of an already accepted frame', ...json(object({ duplicate: { const: true }, reading: ref('Frame') })) };
paths['/api/v1/devices/{id}/stream'].get.responses['200'] = { description: 'SSE stream; use fetch to supply Authorization', content: { 'text/event-stream': { schema: str } } };
const document = { openapi: '3.1.0', info: { title: 'Retrofit bathtub drainage monitor', version: '0.1.0', description: 'Two-US-100 prototype API. Bearer auth is required when API_KEY is configured (mandatory in production). Distances are mm, echo times µs, drainage durations ms. See README for experimental limitations.' }, servers: [{ url: '/' }], security: [{ backendToken: [] }], paths, components: { securitySchemes: { backendToken: { type: 'http', scheme: 'bearer', description: 'Backend API_KEY. Never send the Supabase secret to this API.' } }, schemas } };
mkdirSync(new URL('../docs/', import.meta.url), { recursive: true });
writeFileSync(new URL('../docs/openapi.json', import.meta.url), JSON.stringify(document, null, 2) + '\n');
console.log('Generated docs/openapi.json');
