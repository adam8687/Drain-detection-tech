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

## Onboard a unit and test it on hardware

One US-100 per unit. The app records the empty sink, then two tap-off drains, and saves that
unit's own alert thresholds (a drainage profile). Apply every migration in `supabase/migrations`
and run `npm run cloud:deploy` first; without the migrations a finished profile is rejected by the
database.

Check before powering up: with `USE_UART=true` in `device/wifi/.env` the US-100 rear jumper must be
installed (9600 baud, Trig/TX on D1, Echo/RX on D0, 3V3 and GND); with `false` it must be removed.
Mount the sensor fixed, pointing down, clear of faucet spray and above the highest water level. The
US-100 is not waterproof. Fill only to the app's indicator (at least 40 mm, safely below the rim).

1. **Create the unit in the app first.** `npm run cloud:start`, sign in, Add unit with the ID printed
   on the sensor. Units created from the command line have no owner and cannot be claimed in the app
   (the app then says the unit is registered to another account).
2. **Provision the board.** `npm run cloud:configure -- DR-4851` uses the unit you just created, issues the
   sensor key, creates the monitoring recording and writes the ignored `secrets.h`. For a unit set up by an
   installer first, link it to the customer at the same time:
   `npm run cloud:configure -- DR-4851 --owner-email customer@example.com` (the customer must have signed
   up). If the saved recording in `device/wifi/data/state.json` no longer exists, for example after a
   migration, it creates a new one instead of failing.
3. **Flash.** Arduino IDE, **Arduino Nano ESP32**, **With FAT partition (default)**, Upload, Serial Monitor
   115200. Wait for "Saved measurement in Supabase". If it stops with "Pending point belongs to another
   destination or is damaged" or "Upload stopped (HTTP 4xx)" the board holds a reading from older firmware:
   set `INITIALIZE_EMPTY_FILESYSTEM=true`, rerun step 2, upload once, then set it back to `false` and rerun
   step 2. Only do this when nothing pending is still needed.
4. **Verify transport.** `npm run wifi:watch` waits for a new real reading and compares the API, Supabase and
   website.
5. **Check the sensor.** With the sink empty, readings should stay within about 3 mm with under 2%
   timeouts. Compare one reading with a ruler.
6. **Onboard in the app.** Open `/add-unit?fixture=DR-4851`: connect, record the empty sink (8 to 10 stable
   seconds), then two tap-off drains (plug in, fill to the indicator, tap off, release when asked). The
   result shows the measured time, or "Very fast drain" when the sink empties between readings. The
   thresholds are the 1.5x and 3x ratios of that unit's own time plus its variation, never below the
   6 s and 15 s floors.
7. **Try real alerts.** Normal drains read normal. A partly blocked drain at about twice the time warns
   (repeated slowdowns warn again); a heavy blockage or standing water reports Severe or Running too long;
   leaving shallow water under the sensor for 30 s reports "Re-check empty level"; covering or unplugging
   the sensor reports "Check readings".

Limits: 5000 points per recording, one pending board point with acquisition paused offline, and manual
record provisioning after a reboot or completion. Successful timeout uploads prove transport, not valid
distances. Per-sample flash writes are for bench tests; sustained deployment needs endurance planning. TLS
verification stays enabled. Reconfigure its CA if the service trust chain changes. Local Node SSE remains
available; cloud uses the frontend's REST polling.

## Egress and scale

Egress is what the database returns, so it is driven by viewers re-reading recordings, not by the board. Three
protections keep it small, none needing a reflash:

- **Idle thinning.** While the sink is idle only one reading per 8 s is stored. Every reading is kept during
  use and for 30 s afterwards, so drain timing and setup are unaffected. Skipped readings are acknowledged
  normally and cause no database write.
- **Rolling window.** A monitoring recording keeps its newest 2000 readings instead of stopping at 5000
  (previously about 42 minutes of continuous sampling), so a unit can run for months.
- **Incremental reads.** Apply `202611140002_drain_record_delta.sql`. A worker that already has a copy fetches
  only newer readings and verifies the count, falling back to a full read if anything differs or the function is
  missing.

Measure it with `HOURS=1 UNITS=1 npm run egress:simulate` (a local model, no network; `NO_DELTA=1` shows the
cost without incremental reads). One unit with a live view and a fleet dashboard on separate cold workers, per
hour: about 455 MB before these changes, about 0.7 MB after. Remaining limits: the board still makes one HTTPS
request every 2 s (about 1.3 million function invocations per unit per month, so watch the invocation quota
before deploying many units), and a freshly started worker reads each recording in full once.

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
