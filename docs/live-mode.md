# Temporary live updates

The live unit page has an owner-controlled **Live demo** switch. Setup requests
live mode automatically during connection testing, empty calibration and the two
controlled drainage checks. Calibration controls wait for device confirmation.
Normal monitoring retains ten-point batches and the existing drain-end flush.
Sampling stays at 500 ms in both modes; calibration, measured durations, alert
thresholds and lifetime health history are unchanged.

## Behavior

- A visible page renews its own 120-second session every 30 seconds. Multiple
  sessions are independent: turning off a demo cannot interrupt another person's
  calibration. Hidden pages stop renewing, stop fast polling, and release their
  session. Navigation uses a small keepalive release request; expiry is the
  fallback when a release cannot be delivered. Normal batching resumes after the
  last session ends and the board receives the off command, or its local timer
  expires. A page left visible intentionally continues live mode.
- The server requests faster delivery, and the device reports applying it. The
  UI shows “Starting”/“Waiting” until confirmation; a device with old firmware
  does not falsely appear live. A stalled status request removes the confirmed
  indication after four seconds. Data arrival times and sensor freshness remain
  separate from this mode acknowledgment.
- In normal monitoring, activation waits for the next upload (about five seconds
  at the nominal cadence). Live delivery sends each reading without waiting to
  fill a batch, and the app polls the bounded graph every 750 ms. Network and
  sensor delays still apply; no physical end-to-end latency has been certified.
- The command is delivered in the `X-Drain-Live-For-Ms` response header. Supported
  devices announce `X-Drain-Live-Capability: 1` and report
  `X-Drain-Live-Active: 0|1`. Command processing is optional: an error returns zero
  and does not reject a committed measurement. Old JSON acknowledgments and
  measurement payloads remain unchanged. Backlogged measurements cannot confirm
  fresh live delivery. Idle record-discovery requests can confirm mode readiness
  before a calibration recording is created.

## Wi-Fi firmware

The Nano ESP32 now samples on a separate task while networking and flash writes
run in the upload loop. A 128-point RAM queue buffers about one minute at the
nominal rate. When the queue fills the device stops explicitly; it does not
invent missing measurements or overwrite the pending journal. The saved upload
batch remains recoverable. RAM readings still do not survive power loss, and a
long outage or flash failure can interrupt a capture. Physical timing, queue
endurance and flash wear need board testing.

The board discovers its own active physical recording with its scoped sensor
key. It follows setup steps without reflashing a recording UUID for each step.
When an owner ends a recording, or calibration finishes automatically, queued
extra readings/rejected uploads are archived locally as
`/unsent-RECORD_UUID.txt` with their original destination and IDs. They are never
reassigned to the next step or represented as successfully stored. Pending
journals retain their original recording across restart; the existing restart
policy still requires a new recording after recovery unless the installer has
explicitly enabled resume. An installer can inspect archives when diagnosing
an interrupted setup. The USB bridge already uploads individual points and now
reports that capability; use its existing `--follow` mode for setup transitions.

## Deployment

1. Apply `supabase/migrations/202611150003_live_mode.sql` after the existing access
   migration. It creates only temporary live-session/device-state metadata, with
   no updates or deletion of recorded measurements or calibration data.
2. Deploy the matching Node backend or Supabase Edge Function and frontend.
3. Install the updated Wi-Fi firmware, or update the USB bridge. Private installer
   configuration remains outside customer screens.

SQLite creates the two metadata tables automatically. Supabase uses the
service-only `drain_live_mode` function; owners control sessions through
`GET/POST /api/v1/devices/DEVICE_ID/live-mode`. POST requires
`{session_id: UUID, enabled: boolean, reason: "demo"|"calibration"}`. Device keys
cannot control sessions or read owner settings. A device can only discover its
own recording and receive its own command. Missing hosted SQL prevents live
setup from claiming readiness, while ordinary sensor persistence remains usable.
Installing server updates does not install the board firmware. Keep the private
configuration and firmware files out of Git; physical installation and verification
are separate from the server-side deployment.

## Validation

Backend tests cover both API runtimes, owner/viewer/sensor boundaries, independent
sessions, expiry, fresh acknowledgment, absent schema and unchanged raw uploads.
Native C++ tests cover lease bounds and timer wraparound. PostgreSQL regression:

```sh
PGLITE_MODULE_PATH=/path/to/@electric-sql/pglite/dist/index.js node supabase/tests/live-mode.mjs
```

The browser product journey simulates a capable device, runs real local API/UI
flows, and checks automatic calibration, manual demo activation, hidden-page
release, normal-mode restoration, alert behavior and narrow-screen layouts.
Firmware compilation establishes compatibility; simulated journeys do not
establish actual Wi-Fi performance or sensor accuracy.
