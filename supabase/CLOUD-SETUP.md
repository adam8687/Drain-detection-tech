# ESP → Supabase → frontend

The ESP sends single-sensor measurements over **verified HTTPS** to the project's
`drain-api` Edge Function. It authenticates and validates the point, runs the
existing calibration/drainage logic and atomically saves to `drain_records`.
The frontend retrieves records, forecasts and alerts from the same function.
The Mac's port 8000 and Wi-Fi network are no longer in the upload path.
No separate hosting provider is required.

The ESP still needs Internet and power. If powered from a Mac USB port, it
still depends on that power. Use a suitable independent supply for standalone
operation. Campus registration of the ESP remains necessary; the Mac can stay
on `utexas`.

## Existing installation and deployment

Apply `migrations/202611120001_single_sensor.sql` before deploying this version. Keep drain_records, dm_devices,
dm_device_members and dm_device_keys. Calibration, drainage, forecast and alert
modules now live in functions/_shared; existing Node modules re-export those
same functions for compatibility and local tests. The Node API and USB workflow
remain available as development alternatives.

Maintainer setup: Node.js 24+, configured backend/.env and Supabase CLI signed
in with access to the existing project.

```bash
npm run cloud:deploy
npm run cloud:configure -- friend-sink
npm run cloud:check
```

Deploy sets private function credentials and deploys only drain-api. It does not
execute SQL, alter tables, commit or push. Existing backend/.env and web/.env.local
are preserved. Another checkout cannot silently rotate the deployed admin token
when it lacks that project's existing private setup.

Configure preserves Wi-Fi credentials/mode, verifies the cloud recording/fixture
key, obtains a matching root CA from a verified TLS connection, and generates the
ignored firmware header. It also generates a read-only one-fixture bench viewer
for the frontend. It is not a sensor or admin credential.

Private ignored files:

- supabase/.env.cloud: privileged deployment/admin settings. Do not share.
- device/wifi/.env: Wi-Fi credentials and cloud URL.
- device/wifi/data/state.json: fixture key and current recording.
- device/wifi/data/supabase-root-ca.pem: verified public trust anchor.
- device/us100_wifi_upload/secrets.h: Wi-Fi, fixture key, recording, TLS settings.
- web/.env.cloud.local: cloud URL and restricted server-side bench viewer key.

Upload device/us100_wifi_upload/us100_wifi_upload.ino with **Arduino Nano ESP32**,
**With FAT partition (default)**, existing sensor mode/pins. Serial Monitor is
115200. No Supabase service key or admin token is placed on the ESP.

## Recover a pending point from the old Mac endpoint

Finish recovery of old two-sensor payloads before applying the single-sensor migration. New firmware/API rejects the old payload shape; preserve any unresolved journal for review.

Configure can retain the active recording ID and a specific previous endpoint
in the header. It first verifies that the same recording/fixture and sensor key
exist in the same Supabase project. The board retries its pending point at the
hosted endpoint with the exact original ID, timestamp and body. Its original
journal stays intact until acknowledgement. A point never moves to a different
record to bypass a conflict.

After recovery, restart protection deliberately stops new sampling. Close Serial
Monitor, then:

```bash
npm run wifi:finish
npm run wifi:prepare -- friend-sink monitoring
```

Upload the regenerated recording configuration again. For a new install without
an old pending point, configure can create the initial monitoring record directly.

## View and verify

```bash
# Terminal 1: website only; no local backend
npm run cloud:start
# Terminal 2: compare a NEW actual ESP point in cloud API, DB and frontend
npm run wifi:watch
```

Open http://localhost:3000/dashboard, or the configured WEB_PORT. Generated bench
settings default to that fixture and physical sensor data. Signed-out reads use
a server-side viewer token restricted to the fixture. Anonymous function requests
are rejected. Writes require an authorized owner session or maintainer admin token;
the frontend proxy never injects admin credentials. Existing Supabase sign-in
works when its original public Auth configuration is supplied. Add Unit/recording
controls still require owner/admin authorization.

The frontend can be hosted separately with SUPABASE_FUNCTION_URL and normal Auth
settings. A local frontend is needed only to view a local website, never for ESP
collection. The live migration test stops the local port-8000 backend before
verifying the board's cloud upload.

## Calibration and further recordings

Stop after the latest Saved acknowledgement and finish monitoring. Both real
sensors must work. Set SECOND_SENSOR_ENABLED=true in device/wifi/.env, and match
USE_UART to the physical jumpers.

```bash
npm run wifi:prepare -- friend-sink calibration --confirm-empty
# Upload; wait for stable empty-baseline completion.
npm run wifi:prepare -- friend-sink drainage
# Upload; start with water present, tap off, then release drain.
```

Commands now contact Supabase, not localhost:8000. Successful empty calibration
is reused. Drainage setup (two tap-off runs on a drain you confirm is clear) saves a
per-sink profile that now sets the slow-drain status, alert and email limits. Sinks
without a profile keep the earlier learn-from-first-three-drains rules.

Before testing on hardware: apply `migrations/202611130001_drainage_profile.sql`
(`supabase db push` or the SQL editor), then `npm run cloud:deploy` so the hosted
function includes the profile logic. Without the migration, saving a completed
profile is rejected by the database.

Limits remain unchanged: two working sensor locations for calibration/drainage,
5000 points per record, one pending board point with acquisition paused offline,
and manual record provisioning after reboot/completion. Successful timeout uploads
prove transport, not valid distances/calibration. Per-sample flash writes are for
bench tests; sustained deployment needs endurance planning. TLS verification stays
enabled. Reconfigure its CA if the service trust chain changes. Local Node SSE
remains available; cloud uses the frontend's existing REST polling workflow.

## Checks

```bash
npm run check
npm --prefix web run build
npx --yes deno check --node-modules-dir=auto supabase/functions/drain-api/index.ts
npm run cloud:check
```

Isolated tests cover auth/fixture/source isolation, retries, conflicts, atomic
updates, calibration/drainage/replay parity, body limits, TLS settings and the
prefixed frontend proxy. Live wifi:watch never injects fabricated measurements.
Hardware accuracy and sensor connections must be verified physically.
