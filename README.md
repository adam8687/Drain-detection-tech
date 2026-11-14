# Drain Monitor

**Recommended physical-sensor setup:** [ESP → Supabase → frontend](supabase/CLOUD-SETUP.md).
The hosted ingestion function runs the existing calculations inside Supabase, so
the ESP no longer needs to reach a Mac or a local port-8000 backend. Use
`npm run cloud:start` to view the local frontend in this mode. The local-backend
instructions below remain available for development and the USB alternative.

A one-US-100 / one-ESP32-per-fixture prototype. Sensor distances are persisted in Supabase and displayed as drainage times. Recording data uses **`drain_records`**, with supporting access-control and email-delivery metadata tables. Calibration recordings establish empty references; drainage and monitoring recordings retain baseline snapshots and arrays of measurements. Results, calibration validation and experimental forecasts are computed by the backend.

## Upgrade this checkout

1. Stop your old backend and frontend terminals with Ctrl+C. Do not overwrite existing `.env` files.
2. In your Supabase project's **SQL Editor**, run **`supabase/migrations/202610270001_drain_records.sql`**. This creates the recording table and its atomic-update function. Then apply `supabase/migrations/202610270002_records_access.sql` to retain user ownership and sensor-key metadata. It leaves every old `dm_*` table untouched. Then apply `supabase/migrations/202611120001_single_sensor.sql` for the single-sensor contract, preserved legacy backups, and compact database acknowledgments. New projects need all three files; do not run the older migrations first.
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

For physical sensors over Wi-Fi, follow the
[scripted friend-testing checklist](device/wifi/README.md) (`wifi:init`,
`wifi:start`, `wifi:check`, `wifi:prepare`, `wifi:watch`, `wifi:finish`).
The board sends readings through the existing backend to Supabase and the dashboard.

Terminal 1, repository root:

```sh
npm start
```

Terminal 2:

```sh
npm --prefix web run dev
```

Open **http://localhost:3000** for the Smart Housing landing page, or **http://localhost:3000/dashboard** for the dashboard. Default fixture: `practice-sink-v2`, data source: Simulation. Select a recording and use Replay. Both normal and unreliable-data scenarios are available. The browser reads through a same-origin gateway; set server-side `BACKEND_URL` in `web/.env.local` if the backend runs elsewhere. The old `NEXT_PUBLIC_BACKEND_URL` is no longer used.

If backend `API_KEY` is set, enter that separate prototype token in the site's token form. Supabase server secrets belong only in the backend. `NODE_ENV=production` requires Supabase, an API token of at least 32 characters and explicit CORS origins. This remains a shared-token prototype, with owner/viewer access when using Supabase sign-in.

## Stream sensor-like simulation

With the backend running, use a third terminal:

```sh
npm run simulate -- empty
npm run simulate -- normal
```

Select fixture `live-simulation` / Simulation on the website, then Refresh. The empty command collects stable sensor samples and saves calibration. Normal sends one measurement at a time at approximately 2 Hz. Other scenarios: `slow`, `pooling`, `timeout`, `gap`, `shallow`. Set `MOCK_FIXTURE_ID` and `API_BASE_URL` in the backend environment if needed. Interrupted recordings can be finished from Recording controls. The sender resumes a compatible active recording; failed requests retry identical reading IDs.

The simulation uses integer-millimeter values, deterministic noise, slight timing variation, changing drainage slopes, sensor disagreement and explicit failures. It is an engineering test fixture, not a validated fluid model or an accuracy claim about physical hardware.

## Active data model

See `supabase/README.md` and `supabase/drain_records.schema.json`. There is no separate readings, sessions or calibration data table. The upstream fixture ownership and sensor-key registry is retained separately for authorization.

- `record_id`, `fixture_id`, `record_type`, `data_source`, `recording_status` identify the recording.
- `calibration` is null or `{ empty_distance_mm }`.
- `measurements` is an array of `{ reading_id, timestamp, sensor }`; each sensor has `distance_mm` and `status`.
- `result` is null or `{ drainage_time_seconds, outcome }`.
- `created_at` is one server-assigned ordering field, necessary before an empty recording has its first sample and for choosing the latest calibration.

Fixed backend defaults: wet threshold 20 mm, dry tolerance 8 mm, three consecutive valid sensor samples to confirm dry, maximum timing gap 5 seconds, maximum 5000 measurements per record. Calibration needs at least 20 stable sensor samples over eight seconds, with at most 4 mm variation for the sensor. It requires explicit empty-fixture confirmation. Moving the sensor requires recalibration. Startup calibration no longer happens silently; the old `AUTO_CALIBRATE` setting is unused.

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

## Guided setup and drainage alerts

Open `/add-unit` for a new device, or `/add-unit?fixture=YOUR_FIXTURE_ID` to resume. Connect the one US-100, leave the sink empty with the tap off, confirm that it is empty, and collect 20 stable readings over at least eight seconds. At 2 Hz this normally takes about ten seconds. That empty distance **is the baseline**. There are no required fill tests or practice drains. The saved empty reference converts later distances to water depth. Moving the sensor requires a fresh empty check. Reloading recovers setup; a failed restore blocks actions until retried.

Status policy v3 works immediately after empty calibration, with an initial slow-drain threshold of **30 seconds** and water-still-present limit of **60 seconds**. These are engineering defaults requiring physical validation, not a certified diagnosis. Running water may keep a sink wet, so a timeout asks the owner to check both continuing water input and a possible blockage.

Usual drain time is separate from the empty baseline. It can be learned in the background from the first consistent three completed positive-duration drains, including cycles observed during monitoring. Maximum/minimum duration must be at most 1.30; starting depths must be within 1.25. After learning, the median stays frozen so gradual slowing does not become the new normal. Later depths outside 25% of the usual starting depth are withheld from comparisons.

- Slow threshold after learning: `max(1.5 × usual time, usual time + 10 seconds)`.
- Water-still-present limit after learning: `max(3 × usual time, usual time + 30 seconds)`.
- Two slow runs among the last three completed comparable uses raise a maintenance warning. A completed comparable drain exceeding the upper limit, or fresh continuous evidence that water remains at the limit, raises a critical in-app alert.
- Missing echoes, gaps and stale readings are unknown; they never count as an empty sink or proof of a clog. Sensor failure and device silence have separate alerts.

Installer-only USB preparation: configure the fixture sensor key and API URL once, then run `npm run device:upload -- --follow`. The uploader follows each new recording automatically. Late readings stay in the local outbox against their original record; they are never reassigned. Wi-Fi firmware still uses an explicit recording UUID between steps. After saving the empty reference, choose **Start monitoring**.

Monitoring separates wet-to-dry cycles, follows the initial filling peak and freezes it after three falling readings. Constant water levels cannot indefinitely reset the timeout. The existing 5000-sample recording limit remains: finish/start another monitoring window before it fills (about 42 minutes at 2 Hz). Automatic unattended rotation and hardware endurance validation remain future work. In-app alerts are evaluated on API reads. The new email service evaluates sensor ingestion and uses a durable outbox; it remains disabled until a sender and hosted settings are configured. SMS is not implemented.

### Single-sensor upgrade

Wait for pending old-format uploads to be acknowledged, stop the old uploaders, then apply `supabase/migrations/202611120001_single_sensor.sql`, deploy the matching backend/Edge Function and frontend, then flash the matching single-sensor firmware. Complete a new empty-sink check. The migration privately backs up original dual-sensor rows, explicitly selects the wired A channel for historical display, preserves finished durations, and closes old active recordings as historical. Historical schema-version-1 rows never train the new detector. SQLite performs the same backup/conversion locally. The SQL file has been tested locally; a build does not apply it to hosted Supabase.

### Reducing Supabase egress

The browser requests new graph readings after its cursor, with a maximum 120-point snapshot for recovery. Empty sinks refresh every 15 seconds and active water every three seconds; full stored history and finished-record replay remain available. Fleet summaries refresh every 30 seconds, live-page selectors every 60 seconds. Hidden-page polling pauses. Installer tools mount only when opened and use the same bounded live responses.

The database adapter checks small revision headers before downloading a recording. An unchanged history is reused from a bounded 16 MiB worker cache; external writes increment the database revision and invalidate it. Atomic writes return only record ID/revision through `update_drain_record_compact`, rather than returning the full growing history again. Cache eviction/cold workers still fetch the full row once. Firmware samples one sensor at 2 Hz instead of 10 Hz.

These are traffic reductions, not a guaranteed organization-wide GB cap. Watch the Supabase usage breakdown after deploying; unrelated clients or services can also generate traffic. Existing billed-period usage cannot be undone. See [Supabase egress guidance](https://supabase.com/docs/guides/platform/manage-your-usage/egress).

### Non-technical customer handoff

The customer setup/account screens do not expose keys or connection commands. Sign-in handles account authentication automatically. An installer must provision the current prototype unit before handoff; the customer then names it, checks that it is online, records the empty sink, and starts monitoring. Unprepared devices remain visibly disconnected. Self-service QR claiming / Wi-Fi pairing is not yet implemented. Device credential APIs are retained only for trusted owner/installer tooling, and sensor authentication remains required.

### Egress budget, sign-in and drainage emails

A free 5 GB uncached allowance is approximately 167 MB/day over 30 days. Aim for 130 MB/day (3.9 GB/month) to leave headroom. Already-used egress cannot be removed; it resets with the billing cycle. In Supabase Usage, inspect the daily breakdown by service and include all projects in the organization. Do not repeatedly run full-record cloud verification or leave debugging watchers open. Deleting records does not undo traffic already served.

Live graphs now request only readings after their last saved cursor, preserve their local graph window, and recover with a bounded snapshot if a cursor is missing. Empty calibrated sinks refresh every 15 seconds, wet/uncertain readings every three seconds; hidden pages stop polling. The frozen in-app timing context is briefly cached, diagnostic watch requests are bounded, and learned email timings use compact persisted references. `npm run egress:estimate` runs a local response-size model without touching Supabase. It excludes database/function/auth/upload/header traffic and is not a billing guarantee. Deploy the matching migrations and application before expecting lower hosted usage. See [Supabase's egress guidance](https://supabase.com/docs/guides/platform/manage-your-usage/egress).

Normal client sign-in uses the project's public browser credentials and Supabase account sessions. Anonymous access to the Supabase-backed Node API is refused even when an admin API_KEY is absent. The restricted bench viewer now requires explicit `DRAIN_ENABLE_BENCH_VIEWER=true`; leave this false on the customer site. Signup confirmation, password recovery and password update use the production application routes.

The email service is implemented but stays **disabled until a verified sender domain and server provider configuration exist**. Owners can save an email preference in Live View. No arbitrary recipient address or server key is requested from customers. During learning, email warnings use a provisional two-minute threshold; after ten comparable cleared uses they use a robust fixture-specific limit. This is an engineering policy informed by outlier statistics, not a universal drainage standard. See the Supabase README for the source rationale, sender/SMTP configuration, transactional outbox and retry-worker setup. Production settings, sender verification and the notifications migration still need activation with authorized operator access.
