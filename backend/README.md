# Backend: drain_records

Node.js 24+, no dependency install. `npm start` from the root loads `backend/.env`, uses Supabase by default, and fails startup if `drain_records` cannot be read. There is no silent SQLite fallback. Apply `supabase/migrations/202610270001_drain_records.sql` before starting. Run `npm run migrate:records` to copy legacy Supabase records while older writers are stopped. See the root README for the complete upgrade/run/push sequence.

## Canonical routes

All `/api/v1` requests require `Authorization: Bearer <API_KEY>` when configured. Never use the Supabase secret as the prototype API token. `/health`, `/ready` and `/openapi.json` are public and reveal no credentials.

### Start a record

`POST /api/v1/records`, JSON:

```json
{"fixture_id":"kitchen-sink","record_type":"calibration","data_source":"sensor","confirm_empty":true}
```

Use `record_type: "drainage"` after successful calibration, or `monitoring` to record outside an event. `confirm_empty: true` is required for calibration only. One recording may be active per fixture and source. Signed-in users register fixtures in the retained ownership registry before creating recordings. Returns 201 with `record_id` and the new row.

### Append one measurement

`POST /api/v1/records/{record_id}/measurements`, JSON:

```json
{
  "reading_id":"1c3b45dd-0994-44ac-a48f-4dd8bc781a53",
  "timestamp":"2026-10-27T12:00:00.000Z",
  "sensor_a":{"distance_mm":313,"status":"ok"},
  "sensor_b":{"distance_mm":null,"status":"timeout"}
}
```

The ESP32 generates a new UUID per paired sample and reuses the exact body on retry. Timestamp must include a timezone; synchronize its clock before recording. Normalize to UTC, keep the clock continuous, and start a new recording after a clock reset. There is no boot ID, sample number, temperature or echo-time input in this distance-only API. Failed readings use a null distance and `timeout` or `out_of_range` status. Distance limits are 20–4500 mm; validate actual purchased hardware separately.

201 means persistence succeeded. 200 means an identical point was already stored. Conflicting IDs, new measurements on a finished record, or full recordings return 409. The backend uses atomic compare-and-set retries to avoid losing concurrent appends. Raw measurement requests are limited to 16KB and recordings to 5000 points. Close and start a new monitoring window at that limit.

Empty calibration auto-finishes after at least 20 valid stable paired samples spanning eight seconds. Drainage auto-finishes only after water has been observed and both sensors confirm dry for consecutive samples. Results are calculated and saved on the backend. Finishing an incomplete drainage record stores an incomplete/uncertain result; a failed calibration can be finished but is not selected as a usable baseline. New recordings copy the latest usable calibration for the same fixture and data source, so recalibration does not change old baseline snapshots.

### Retrieve, replay and finish

- `GET /api/v1/records`: summary list, optional `fixture_id`, `data_source`, `record_type`, `recording_status`, `limit` (1–200).
- `GET /api/v1/records/{id}`: `{ record, computed }`. `computed` contains backend forecast, countdown timeline, sample count, staleness and calibration progress.
- Add `?sample=20` to replay only the observations available through that sample. No future measurements are used for its estimate.
- `POST /api/v1/records/{id}/finish`: finish and persist the result; safe to repeat.
- `GET /api/v1/records/{id}/stream`: authenticated fetch SSE, with connected/snapshot/unavailable events and heartbeats. It polls persistent storage and sees external writers. The frontend currently uses REST polling for active recordings.

Current detector settings and forecast limits are documented in the root README. Neither forecasts nor drainage time diagnose a blockage or pipe corrosion.

## Legacy data

The importer preserves legacy raw values, timestamps, fixture IDs, baseline snapshots, source labels and already completed durations. Unassigned readings become finished monitoring records, split at 5000 points. Missing baselines or conflicting destination rows abort rather than discard data. All old tables remain unchanged. Names, old sensor echo/temperature metadata, hash/boot/sequence fields and custom threshold settings remain available only in those legacy backups. Converted fixed-schema measurements use distance in millimeters; existing saved outcomes remain frozen.

The old `src/storage.js`, `src/domain.js`, fixture-calibration helper and older migrations are retained for legacy reference, not the active server's storage path. Older console assets are not served. Do not run an old backend against the new deployment.


## Sign-in and sensor authorization

Upstream sign-in, fixture ownership/viewer roles and hashed sensor keys are retained. Recording data uses `drain_records`; `dm_devices`, `dm_device_members` and `dm_device_keys` remain access-control metadata. Apply `supabase/migrations/202610270002_records_access.sql` after the drain_records migration, including on new projects. Existing ownership/key rows are retained. Enable browser sign-in with `NEXT_PUBLIC_SUPABASE_URL` and a publishable `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`; never expose the server secret. Registered users see only their fixtures and may manage them only as owners. Sensor keys can only append to physical-sensor recordings for their fixture; owners initiate recordings. The existing unauthenticated local-prototype mode remains only when API_KEY is unset. Do not expose that mode publicly.
