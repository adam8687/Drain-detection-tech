# Drain Monitor

A two-US-100 / one-ESP32-per-fixture prototype. Sensor distances are persisted in Supabase and displayed as drainage times. The active schema is now **one table: `drain_records`**. Calibration recordings establish empty references; drainage and monitoring recordings retain baseline snapshots and arrays of measurements. Results, calibration validation and experimental forecasts are computed by the backend.

## Upgrade this checkout

1. Stop your old backend and frontend terminals with Ctrl+C. Do not overwrite existing `.env` files.
2. In your Supabase project's **SQL Editor**, run **`supabase/migrations/202610270001_drain_records.sql`**. This creates the recording table and its atomic-update function. Then apply `supabase/migrations/202610270002_records_access.sql` to retain user ownership and sensor-key metadata. It leaves every old `dm_*` table untouched. For a new project, these two files are sufficient; do not run the older migrations first.
3. From the repository root, using Node.js 24+:

```sh
npm run setup
npm --prefix web ci
npm run check:supabase
npm run migrate:records
npm run seed:practice
npm run check
npm --prefix web run typecheck
npm --prefix web run build
```

`setup` only creates missing environment files. The existing Supabase credentials remain in `backend/.env`. `migrate:records` is for existing data; new projects can skip it. It copies, reads back and verifies converted rows without modifying legacy tables. Stop all old writers first. Conflicting destination rows abort rather than overwrite. Partial copies can be resumed. Existing completed drainage durations are preserved. Legacy custom thresholds are not carried into the minimal schema; new analysis uses documented fixed defaults. Keep the legacy tables as a backup until you have reviewed the copied results. Existing offline SQLite databases are not automatically converted by this hosted-data migration.

`seed:practice` saves seven repeatable, clearly labeled simulation records (one calibration and six drainage examples). It never overwrites conflicting records or touches physical sensor data. Old practice data remains in the legacy tables until explicitly migrated.

## Run

Terminal 1, repository root:

```sh
npm start
```

Terminal 2:

```sh
npm --prefix web run dev
```

Open **http://localhost:3000** for the Smart Housing landing page, or **http://localhost:3000/insights** for the dashboard. Default fixture: `practice-sink-v2`, data source: Simulation. Select a recording and use Replay. Both normal and unreliable-data scenarios are available. The browser reads through a same-origin gateway; set server-side `BACKEND_URL` in `web/.env.local` if the backend runs elsewhere. The old `NEXT_PUBLIC_BACKEND_URL` is no longer used.

If backend `API_KEY` is set, enter that separate prototype token in the site's token form. Supabase server secrets belong only in the backend. `NODE_ENV=production` requires Supabase, an API token of at least 32 characters and explicit CORS origins. This remains a shared-token prototype, with owner/viewer access when using Supabase sign-in.

## Stream sensor-like simulation

With the backend running, use a third terminal:

```sh
npm run simulate -- empty
npm run simulate -- normal
```

Select fixture `live-simulation` / Simulation on the website, then Refresh. The empty command collects stable paired samples and saves calibration. Normal sends one measurement at a time at approximately 2 Hz. Other scenarios: `slow`, `pooling`, `timeout`, `gap`, `shallow`. Set `MOCK_FIXTURE_ID` and `API_BASE_URL` in the backend environment if needed. Interrupted recordings can be finished from Recording controls. The sender resumes a compatible active recording; failed requests retry identical reading IDs.

The simulation uses integer-millimeter values, deterministic noise, slight timing variation, changing drainage slopes, sensor disagreement and explicit failures. It is an engineering test fixture, not a validated fluid model or an accuracy claim about physical hardware.

## Active data model

See `supabase/README.md` and `supabase/drain_records.schema.json`. There is no separate readings, sessions or calibration data table. The upstream fixture ownership and sensor-key registry is retained separately for authorization.

- `record_id`, `fixture_id`, `record_type`, `data_source`, `recording_status` identify the recording.
- `calibration` is null or `{ sensor_a_empty_mm, sensor_b_empty_mm }`.
- `measurements` is an array of `{ reading_id, timestamp, sensor_a, sensor_b }`; each sensor has `distance_mm` and `status`.
- `result` is null or `{ drainage_time_seconds, outcome }`.
- `created_at` is one server-assigned ordering field, necessary before an empty recording has its first sample and for choosing the latest calibration.

Fixed backend defaults: wet threshold 20 mm, dry tolerance 8 mm, three consecutive valid paired samples to confirm dry, maximum timing gap 5 seconds, maximum 5000 measurements per record. Calibration needs at least 20 stable paired samples over eight seconds, with at most 4 mm variation per sensor. It requires explicit empty-fixture confirmation. Moving sensors requires recalibration. Startup calibration no longer happens silently; the old `AUTO_CALIBRATE` setting is unused.

Never substitute missing echoes for dry measurements. A sampling gap makes drainage timing uncertain. Completed results are frozen. Forecasts are local linear extrapolations from recent valid readings; they are suppressed for stale, missing, flat or irregular data and are not maintenance predictions. All forecast/replay values are calculated on the backend; the frontend only draws and formats them. Fixed settings should not be changed without an explicit versioning/migration decision for historical replay.

## Backend API

Contract: http://localhost:8000/openapi.json. Details: `backend/README.md`.

- `GET /api/v1/records?fixture_id=...&data_source=sensor|simulation`: summaries.
- `POST /api/v1/records`: start calibration, drainage or monitoring.
- `POST /api/v1/records/{id}/measurements`: append one reading, retry-safe.
- `GET /api/v1/records/{id}?sample=20`: stored row plus backend-computed replay.
- `POST /api/v1/records/{id}/finish`: finish an incomplete recording.
- `GET /api/v1/records/{id}/stream`: authenticated SSE snapshots, including external writers.

The old device/frame/session routes and `/api/events` ingestion contract have been replaced. ESP32 senders must adopt the new contract. The Supabase update function and backend comparison/retry logic protect concurrent appends; measurement lists never travel in query URLs. Future high-volume deployments may need a different physical storage strategy instead of rewriting large JSON arrays.

## Checks and optional live verification

`npm run check` covers the new schema, real API flows, source isolation, calibration, concurrency, retries, frozen results, migration, HTTP gateway, SSE and a mocked PostgREST protocol. These replace the old multi-table tests. `npm run check:supabase` is read-only; `npm run verify:supabase` additionally writes clearly labeled simulation calibration/drainage records and reads them through a separate adapter. A successful local suite does not establish that the hosted SQL migration has been applied or that hardware is accurate.

GitHub Actions runs backend checks and frontend type/build checks. The existing Google fonts need network access at build time. No credentials are included in source.

## Push to GitHub yourself

```sh
git switch -c codex/drain-records-schema
git add -A
git diff --cached --stat
git diff --cached --name-only
# Confirm no real .env or credential file is listed.
git commit -m "Use single-table drain records and backend analysis"
git push -u origin HEAD
```

Do not force-add ignored environment files. A Git push does not apply the Supabase migration. If your hosting auto-deploys this branch, apply the database migration before pushing. This update does not commit or push anything automatically.


## Sign-in and sensor authorization

Upstream sign-in, fixture ownership/viewer roles and hashed sensor keys are retained. Recording data uses `drain_records`; `dm_devices`, `dm_device_members` and `dm_device_keys` remain access-control metadata. Apply `supabase/migrations/202610270002_records_access.sql` after the drain_records migration, including on new projects. Existing ownership/key rows are retained. Enable browser sign-in with `NEXT_PUBLIC_SUPABASE_URL` and a publishable `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`; never expose the server secret. Registered users see only their fixtures and may manage them only as owners. Sensor keys can only append to physical-sensor recordings for their fixture; owners initiate recordings. The existing unauthenticated local-prototype mode remains only when API_KEY is unset. Do not expose that mode publicly.
