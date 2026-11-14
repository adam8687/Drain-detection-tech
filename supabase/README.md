# Supabase recording data and service metadata

For ESP uploads without a Mac backend, follow [cloud setup](CLOUD-SETUP.md).
It reuses this schema and shared calculations; the single-sensor migration below is required.

Run `migrations/202610270001_drain_records.sql` in your project's SQL Editor. Then apply `migrations/202610270002_records_access.sql` for the retained sign-in/device-access metadata. Then apply `migrations/202611120001_single_sensor.sql`. New projects need all three files. Existing projects may run it alongside the old schema; it does not modify or delete any `dm_*` table. It creates `drain_records`, indexes, Row Level Security, and the server-only atomic update function.

Then use `npm run check:supabase`, optionally `npm run migrate:records` for legacy data, and `npm run seed:practice`. Keep all old writers stopped during conversion. The importer verifies each destination row, resumes unchanged partial copies and refuses conflicting overwrites. Keep legacy tables until you have reviewed the migration. They are backups, not part of the new application's storage path.

The Data API secret cannot execute schema SQL. Applying this migration is a manual SQL Editor step; do not assume a successful local build created the hosted table. `check:supabase` confirms table access; the optional `verify:supabase` also confirms the atomic update function through real write/read flows and leaves labeled simulation records.

Columns: `record_id`, `fixture_id`, `record_type`, `data_source`, `recording_status`, `calibration` (JSON), `measurements` (JSON array), `result` (JSON), and server ordering metadata `created_at`. The JSON contract is in `drain_records.schema.json`.

The backend validates nested measurements, checks duplicate reading IDs, calculates results and forecasts, and appends through a POST-based compare-and-set SQL function. The function updates only mutable recording fields and returns only record ID/revision on success, or no row if another writer changed them. It is SECURITY INVOKER and executable only by `service_role`; anonymous and browser-authenticated table access is revoked. Supabase secrets stay exclusively in the backend.

Readings contain exactly one `sensor: {distance_mm, status}` and a timestamp. The empty reference is `{empty_distance_mm}`. `schema_version` marks historical converted rows; `revision` supports small cache-validation reads. Source is `sensor` or `simulation`. Fixed analysis settings live in the backend. A finished calibration recording with a non-null baseline is the setup source for later recordings of the same fixture/source. Those recordings retain a baseline snapshot. A failed/abandoned calibration does not replace the last usable one.


## Sign-in and sensor authorization

Upstream sign-in, fixture ownership/viewer roles and hashed sensor keys are retained. Recording data uses `drain_records`; `dm_devices`, `dm_device_members` and `dm_device_keys` remain access-control metadata. Apply `supabase/migrations/202610270002_records_access.sql` after the drain_records migration, including on new projects. Existing ownership/key rows are retained. Enable browser sign-in with `NEXT_PUBLIC_SUPABASE_URL` and a publishable `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`; never expose the server secret. Registered users see only their fixtures and may manage them only as owners. Sensor keys can only append to physical-sensor recordings for their fixture; owners initiate recordings. The existing unauthenticated local-prototype mode remains only when API_KEY is unset. Do not expose that mode publicly.

## Single-sensor migration and traffic

Apply `202611120001_single_sensor.sql` with old uploaders stopped. It archives original dual-channel rows in the private `drain_records_two_sensor_backup`, selects A explicitly for historical display, preserves finished results, and closes old active recordings. Complete a new empty-sink calibration before resuming. Do not erase queued old-format readings to bypass validation; retain them for review. New firmware sends only `sensor`.

The backend uses revision-only history checks with bounded worker caching and the service-only `update_drain_record_compact` RPC. This removes full histories from write acknowledgments and avoids repeat downloads for unchanged records. The frontend uses bounded live graph responses and pauses hidden-tab polling. This limits future traffic after deployment; it does not reset current usage or impose an organization-wide hard quota.

## Drainage profile (per-sink alert thresholds)

Two calibrations with different jobs, both stored in `drain_records.calibration` (no new table):

- **Empty reference** (`empty_distance_mm`) fixes water depth only.
- **Drainage profile** (`calibration.drainage.profile`, drainage version 2) fixes expected performance and alert thresholds. It is captured from two tap-off runs that were each confirmed on a drain known to be clear, and only if the runs agree within 1.3x, so an existing blockage is not learned as normal. A new empty reference starts a fresh profile.

The profile stores, for the 30→25, 25→20, 20→15 and 15→10 mm depth bands, the expected seconds, the observed variation between the two runs, and the sensor noise carried over from sampling. `slow = expected × 1.5 + max(variation, noise)`; `severe` uses ×3. Later drains are compared at matching depth bands only (a drain that starts lower is judged on the bands it covered). One severe slowdown raises a critical alert; milder slowdowns warn once `repeat_count` (2) of the last `repeat_window` (3) comparable drains are slow. Sinks without a profile keep the earlier learn-from-first-three-drains behavior. Version 1 setups saved earlier stay valid and derive an equivalent profile at read time.

**Very healthy drains.** A drain can empty between two readings, so it cannot be timed per depth band. Setup accepts it as an upper bound (time plus sampling interval, up to 6 s), marks the profile `resolution: instant`, and relies on predetermined floors in the profile policy: warn only above `min_slow_seconds` (6) and treat as severe above `min_severe_seconds` (15), measured over the 30→10 mm range. The floors apply to every profile so a ~1 s baseline never warns at noise level. Two runs also agree if they differ by no more than their own sampling uncertainty (repeatability up to 3×, 1 when both are instant). A later drain too quick to band is judged by its whole fall time against the same limits. These values are engineering defaults, not published standards.

Apply `202611130001_drainage_profile.sql` then `202611140001_drainage_instant.sql` after `202611120003_drainage_calibration.sql`. It only replaces check functions and the `calibration_shape` constraint, so no rows are rewritten. Regression: `PGLITE_MODULE_PATH=… node supabase/tests/drainage-profile.mjs`.

A local PostgreSQL regression script is in `tests/single-sensor.mjs`. It uses PGlite without connecting to hosted Supabase:

```sh
npm install --prefix /tmp/drain-sql-test @electric-sql/pglite
PGLITE_MODULE_PATH=/tmp/drain-sql-test/node_modules/@electric-sql/pglite/dist/index.js node supabase/tests/single-sensor.mjs
```

## Authentication and email service setup

Apply `migrations/202611120002_email_notifications.sql` after the single-sensor migration. The notification preference, compact timing-reference and email-outbox tables are private; customer access uses owner-authenticated API routes. Sensor measurements and queued email events commit in one transaction. This migration does not enable a sender or send email.

Use `npm run auth:setup` to review the production Auth settings for `https://drain-detection-tech.vercel.app`. With authorized project-management access in private operator configuration, `npm run auth:setup -- --apply` updates only the application URL, required redirects and email-confirmation settings, preserving other allowed redirect URLs. A database service key cannot change hosted Auth settings. The existing project already has email/password enabled and requires confirmation; local browser credentials were connected without exposing a server key. Vercel production environment variables and hosted redirect settings still need deployment/operator access.

Supabase's default email server is for limited team testing, not customer registrations. When a sender domain is available, verify it with Resend, configure `DRAIN_EMAIL_FROM`, and put `RESEND_API_KEY` only in server settings. Configure Supabase Auth SMTP with `smtp.resend.com`, port `465`, username `resend`, and the Resend credential as password. `npm run auth:setup -- --apply --smtp` can configure this through the Management API once the private sender/credential settings exist. The same provider then supports confirmation/password reset through SMTP and drainage warnings through its API. See [Supabase SMTP](https://supabase.com/docs/guides/auth/auth-smtp) and [Resend's Supabase guide](https://resend.com/docs/send-with-supabase-smtp).

Set `DRAIN_EMAIL_ENABLED=true` only after migration, sender verification and deployment. Customers sign in and enable **Email alerts** for their unit; no customer handles a credential. Messages go only to the current owner's verified account email, never to an arbitrary request-supplied address. Viewers, sensor credentials and the bench viewer cannot change notification preferences.

Email evaluation runs during sensor ingestion, even when no browser is open. A worker sends queued messages using stable provider idempotency keys and immutable payloads. Jobs have atomic leases, five attempts, a 23-hour retry deadline, one event/owner message, and an hour cooldown per owner/unit. Revoked ownership, opt-out or email changes cancel delivery. Provider acceptance is recorded as sent; this is not an inbox-delivery guarantee. A sender/provider failure does not silently mark a job sent.

For retries after a worker shutdown or upload outage, configure the optional `operations/schedule-email-delivery.sql` job. It uses the purpose-scoped `DRAIN_EMAIL_WORKER_TOKEN` from Vault and calls the protected `/api/v1/internal/email-deliveries` endpoint only when jobs are due; it does not scan sensor histories or invoke the function for an empty queue. The worker credential cannot access recordings or account settings. `npm run email:retry` is an operator-only one-shot alternative. Sender configuration, Vault secrets and the retry schedule have not been activated on the hosted project.

### Email timing policy and sources

The empty-sink reference remains the only onboarding baseline. A single distance sensor cannot identify tap-off or prove a blockage. [EPA's faucet guidance](https://www.epa.gov/watersense/bathroom-faucets) documents materially different faucet flow rates; it does not supply a universal seconds-to-drain limit. The first email limit is therefore a **provisional engineering default of 120 seconds** of valid continuously observed water, or a completed drainage event taking that long. The existing 30/60-second in-app thresholds remain separate.

After ten earlier comparable completed uses at a starting depth within 25%, email timing uses the maximum of 60 seconds, 3× median duration, median+30 seconds, and `median + 3.5 × MAD / 0.6745`. The robust term follows [NIST's modified z-score outlier guidance](https://www.itl.nist.gov/div898/handbook/eda/section3/eda35h.htm). Ten samples, depth tolerance, floors, multipliers and the learning fallback are application engineering choices, not NIST plumbing recommendations. Uses lasting 120 seconds or longer are excluded from learning so obviously slow history cannot train the initial email limit. The earliest 50 compact completed-use references persist across recording windows; full histories are not re-downloaded to learn an email threshold. Validate these settings on actual fixtures before treating them as operational limits.

Simulation, historical dual-sensor captures, stale readings, missing echoes and sampling gaps cannot generate a live standing-water email. The email asks the owner to check the tap, plug and drain; it does not assert that a clog has been diagnosed.
