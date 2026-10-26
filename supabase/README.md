# Supabase storage

Apply `migrations/202610220001_drain_monitor.sql` once in the project's SQL Editor, then configure the server's `backend/.env`, run `npm run check:supabase` and `npm run verify:supabase` from the repository root. The second command writes clearly labeled mock verification records and reads them back; it leaves them available for manual inspection.

Implemented tables:

- `dm_devices`: stable IDs and names for monitored tubs.
- `dm_calibrations`: immutable empty-tub distance baselines for each of the two sensors.
- `dm_readings`: raw, idempotent two-sensor frames with device/receipt timestamps and source labels.
- `dm_sessions`: explicit drainage tests and finalized analysis.

Tables enable Row Level Security with no anonymous/authenticated policies. Only the controlled backend uses a server secret through the Data API. Browser and ESP32 clients use the backend URL and its separate prototype token. API keys cannot apply SQL migrations.

The earlier `drains`, `events` and `alerts` names described planned work; no tables existed in this repository. The new migration uses `dm_*` names to avoid colliding with other project tables. Validated slowdown alerts and customer authorization remain future work after real experiments.

Supabase is the default and required in production. Startup fails if cloud access is unavailable; it never falls back to SQLite. Every API read queries Supabase, and a write is acknowledged only after Supabase confirms it. Switching backends does not copy old local records.

Live frontend snapshots use backend SSE with fresh Data API queries every second while connected. They include external database writers and recover the latest state after reconnect. No Supabase Realtime publication or browser database permissions are needed. Storage outages close the stream with an `unavailable` event so the frontend retries rather than silently presenting the connection as healthy.

Automatic empty-fixture calibrations use the existing `dm_calibrations.payload` JSON field for source, method and sample event IDs. No migration is required. They are immutable and source-specific; legacy manual baselines apply to both sources. Keep the fixture empty at startup; stability alone does not establish emptiness. See the root README for sample requirements and `AUTO_CALIBRATE=false`.

## Users and sensor keys

Apply `migrations/202610260001_device_access.sql` after the first migration. It adds:

- `dm_device_members`: which Supabase Auth user owns (`owner`) or can view (`viewer`) each device.
- `dm_device_keys`: SHA-256 hashes of per-sensor keys (`dk_...`). The plaintext key is returned once when created.

The backend accepts three kinds of `Authorization: Bearer` token:

- `API_KEY`: admin access to every device, for scripts such as `simulate` and `seed:practice`.
- A Supabase Auth access token from a signed-in user: only devices that user is a member of. Owners can change a device and create keys; viewers can only read.
- A device key: may only `POST /api/v1/readings` for its own device.

With `API_KEY` empty, requests without a token keep full access for local prototyping, so set `API_KEY` whenever more than one person uses the backend. To enable sign-in in the web app, set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in `web/.env.local`, and turn on the Email provider under Authentication in the Supabase dashboard. Signed-in users add a sensor from the insights page, which registers it with them as owner and shows its key once. Viewers are currently granted by inserting a `dm_device_members` row.

`npm run seed:practice` writes an explicitly labeled, mock-only graph dataset into the existing four `dm_*` tables. The dedicated device ID is `graph-practice-sink-v1`. There are 280 readings and six completed drainage sessions sharing one source-specific calibration. Stable identifiers allow safe reruns and recovery from partial seeds. The script reads every saved frame back and checks completed durations. The `/insights` practice view reads these records through the backend; opening or replaying the page does not write data.
