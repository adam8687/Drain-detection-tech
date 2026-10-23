# Supabase storage

Apply `migrations/202610220001_drain_monitor.sql` once in the project's SQL Editor, then configure the server's `backend/.env`, run `npm run check:supabase` and `npm run verify:supabase` from the repository root. The second command writes clearly labeled mock verification records and reads them back; it leaves them available for manual inspection.

Implemented tables:

- `dm_devices`: stable IDs and names for monitored tubs.
- `dm_calibrations`: immutable empty-tub distance baselines for each of the two sensors.
- `dm_readings`: raw, idempotent two-sensor frames with device/receipt timestamps and source labels.
- `dm_sessions`: explicit drainage tests and finalized analysis.

Tables enable Row Level Security with no anonymous/authenticated policies. Only the controlled backend uses a server secret through the Data API. Browser and ESP32 clients use the backend URL and its separate prototype token. API keys cannot apply SQL migrations.

The earlier `drains`, `events` and `alerts` names described planned work; no tables existed in this repository. The new migration uses `dm_*` names to avoid colliding with other project tables. Validated slowdown alerts and customer authorization remain future work after real experiments.

The migration and adapter are supplied, but live connectivity is unverified: network policy prevented reaching this Supabase project from the build environment. Supabase is the default and required in production. Startup fails if cloud access is unavailable; it never falls back to SQLite. Every API read queries Supabase, and a write is acknowledged only after Supabase confirms it. Switching backends does not copy old local records.

