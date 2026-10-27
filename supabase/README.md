# Supabase: one active table

Run `migrations/202610270001_drain_records.sql` in your project's SQL Editor. Then apply `migrations/202610270002_records_access.sql` for the retained sign-in/device-access metadata. New projects need these two files. Existing projects may run it alongside the old schema; it does not modify or delete any `dm_*` table. It creates `drain_records`, indexes, Row Level Security, and the server-only atomic update function.

Then use `npm run check:supabase`, optionally `npm run migrate:records` for legacy data, and `npm run seed:practice`. Keep all old writers stopped during conversion. The importer verifies each destination row, resumes unchanged partial copies and refuses conflicting overwrites. Keep legacy tables until you have reviewed the migration. They are backups, not part of the new application's storage path.

The Data API secret cannot execute schema SQL. Applying this migration is a manual SQL Editor step; do not assume a successful local build created the hosted table. `check:supabase` confirms table access; the optional `verify:supabase` also confirms the atomic update function through real write/read flows and leaves labeled simulation records.

Columns: `record_id`, `fixture_id`, `record_type`, `data_source`, `recording_status`, `calibration` (JSON), `measurements` (JSON array), `result` (JSON), and server ordering metadata `created_at`. The JSON contract is in `drain_records.schema.json`.

The backend validates nested measurements, checks duplicate reading IDs, calculates results and forecasts, and appends through a POST-based compare-and-set SQL function. The function updates only mutable recording fields and returns no row if another writer changed them. It is SECURITY INVOKER and executable only by `service_role`; anonymous and browser-authenticated table access is revoked. Supabase secrets stay exclusively in the backend.

Readings are timestamped paired A/B distances. Source is `sensor` or `simulation`. Fixed analysis settings live in the backend. A finished calibration recording with a non-null baseline is the setup source for later recordings of the same fixture/source. Those recordings retain a baseline snapshot. A failed/abandoned calibration does not replace the last usable one.


## Sign-in and sensor authorization

Upstream sign-in, fixture ownership/viewer roles and hashed sensor keys are retained. Recording data uses `drain_records`; `dm_devices`, `dm_device_members` and `dm_device_keys` remain access-control metadata. Apply `supabase/migrations/202610270002_records_access.sql` after the drain_records migration, including on new projects. Existing ownership/key rows are retained. Enable browser sign-in with `NEXT_PUBLIC_SUPABASE_URL` and a publishable `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`; never expose the server secret. Registered users see only their fixtures and may manage them only as owners. Sensor keys can only append to physical-sensor recordings for their fixture; owners initiate recordings. The existing unauthenticated local-prototype mode remains only when API_KEY is unset. Do not expose that mode publicly.
