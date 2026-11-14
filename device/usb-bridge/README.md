# Arduino USB to Supabase

**Nano ESP32 -> USB -> Mac uploader -> existing backend -> Supabase `drain_records`.**

The installed Connect Arduino-Supabase library is not needed for this path.
Its individual-column insert/update interface does not implement this project's
single-sensor measurements, nested recording array, retry contract or backend analysis.
No schema migration, browser access-rule change, or Supabase key on the board is needed.

## First run

All commands run from the project root with Node.js 24+; no new dependencies.

1. Open `device/us100_usb_upload/us100_usb_upload.ino` in Arduino IDE.
   Select **Arduino Nano ESP32** and Upload. Default is one sensor in
   trigger/echo mode with its rear jumper **removed**: VCC=3V3, GND=GND,
   Trig=D1, Echo=D0. Set `USE_UART = true` only when its jumper is installed.
2. **Close Arduino Serial Monitor and Serial Plotter** so the uploader can use USB.
3. Start the existing backend in one terminal:

   ```bash
   npm start
   ```

4. In another terminal, prepare a hardware monitoring recording and private sensor key:

   ```bash
   npm run device:setup -- usb-bench monitoring
   ```

   Setup uses the backend's local admin token from `backend/.env`, or its existing
   unauthenticated local-prototype mode. For owner sign-in, use `OWNER_TOKEN` in
   the command's local environment instead. It registers the fixture if needed,
   reuses a matching active sensor recording, and saves a fixture-scoped key and
   record ID in ignored `device/usb-bridge/.env`. No key is printed.

5. Start uploading; a single connected USB board is selected automatically:

   ```bash
   npm run device:upload
   ```

   Each `Saved ...` line confirms the backend acknowledged persistence.
   `A=timeout` is an uploaded failure status, not a successful distance.
   If several USB boards are attached, list them with `npm run device:ports`
   and select one using `npm run device:upload -- /dev/cu.usbmodemXXXX`.

6. Run the website (`npm --prefix web run dev`), open `/dashboard`, and select
   fixture **usb-bench** and source **Sensor**. Supabase Table Editor shows its
   `drain_records` row, with points in **measurements**. A normal signed-in account
   will only see fixtures it owns: create the fixture/record on the website and
   configure its key/record ID manually if using that account's fixtures.

If a record already exists on the website, copy `.env.example` to `.env` in
this folder and fill `SENSOR_RECORD_ID`, `SENSOR_KEY` and `API_BASE_URL` instead
of running setup. Sensor keys can append but cannot create/list recordings.
Never put `SUPABASE_SECRET_KEY`, a publishable key, or a browser JWT in `SENSOR_KEY`.

## Exact format

The board receives `READ <uuid>` and responds with its ID and both sensor objects.
The Mac adds UTC acquisition-request time (just before the physical measurement),
validates the response with the same backend validator, and posts:

```json
{
  "reading_id": "1c3b45dd-0994-44ac-a48f-4dd8bc781a53",
  "timestamp": "2026-11-03T12:00:00.000Z",
  "sensor": { "distance_mm": 313, "status": "ok" }
}
```

Destination: `POST /api/v1/records/{record_id}/measurements` using the fixture key.
The backend owns record IDs, `fixture_id`, `record_type`, `data_source`,
`recording_status`, `calibration`, `result`, and `created_at`. No UART bytes,
echo duration, temperatures, extra columns or string units are stored in measurements.
The timestamp is a host acquisition-request time, not an exact sensor echo time;
ensure the Mac clock is correct. The request/response protocol prevents uploading
old buffered text as fresh sensor data. Replies for other request IDs are ignored.

Distances are separate numeric millimeters; valid range is 20-4500. Missing echoes
are `null`/`timeout`, complete invalid readings are `null`/`out_of_range`.
There is no smoothing, cross-sensor averaging or fabricated replacement distance.

## One sensor

The firmware sends only the connected US-100 on D1 (Trig/TX) and D0 (Echo/RX), plus shared 3V3/GND. There is no second-sensor placeholder or enable flag. A missing echo from this sensor is retained as null/timeout. The same one sensor supports calibration, drainage and monitoring.

Finish the monitoring record on the website before starting calibration:

```bash
npm run device:setup -- usb-bench calibration --confirm-empty
npm run device:upload -- /dev/cu.usbmodemXXXX
```

After successful calibration, start a drainage record:

```bash
npm run device:setup -- usb-bench drainage
npm run device:upload -- /dev/cu.usbmodemXXXX
```

Calibration/drainage auto-finish on the backend. Setup refuses to replace an active
record of a different type. With owner authentication, perform these operations
through the website or supply its local `OWNER_TOKEN`.

## Recovery and limits

Readings are saved in ignored `device/usb-bridge/data/outbox.sqlite` before uploading.
Network/server failures retry with the original ID, timestamp and body; the backend
deduplicates a lost acknowledgement. Ctrl+C/restart keeps queued data and resends it
to its **original record ID**, even if the current configuration changes.
Do not delete the outbox to resolve an error without reviewing its pending data.
Only one uploader should run against a board/outbox at a time.

USB disconnection stops acquisition. A measurement interrupted before it reaches
the Mac cannot be recovered; the board does not independently buffer measurements.
At most 5000 points per record are acquired locally, and acquisition pauses at
5000 pending uploads. Existing points uploaded by another writer can reach the
server's limit earlier. Authentication, validation, finished-record and full-record
errors stop uploads while retaining unsaved data for review. Don't move old points
to a new record to work around a conflict. Buffered data after auto-completion can
require review; the uploader never silently discards it.

While the Mac is offline, sampling continues into the outbox until its limit.
After a Mac clock reset, stop acquisition and create a new recording after dealing
with pending data. The board must remain attached and the Mac/backend must run.

## Verification without a working sensor

```bash
node --test backend/tests/usb-bridge.test.js
npm run check:supabase
npm run device:verify
```

`device:verify` uses the actual backend and hosted Supabase, leaving **one finished,
labeled simulation monitoring record** with one sample. It checks exact stored
values and duplicate retries; it does not establish hardware accuracy. The normal
uploader always uses the configured physical-sensor record. Automated tests also
cover key permissions, invalid replies, null failures and durable restart recovery.
On macOS, a pseudo-terminal test also runs the actual uploader against fragmented
device replies and verifies clean shutdown. That emulates USB transport; it does
not establish physical US-100 accuracy or electrical compatibility.

## Automatic guided setup

Configure `API_BASE_URL` and the fixture's `SENSOR_KEY` in `.env`, then run:

```sh
npm run device:upload -- --follow
```

Keep this running while using `/add-unit` or `/add-unit?fixture=YOUR_FIXTURE_ID`. No `SENSOR_RECORD_ID` changes are needed in this mode: the backend exposes only the active physical recording ID/type to that fixture's sensor key, and the uploader waits between completed steps. Readings stay bound to the recording selected when acquired; pending uploads retain their original recording ID. The existing fixed-record mode and durable outbox remain available.

In automatic mode, an owner may end a step while its last USB reading is in flight. If the backend explicitly returns `record_finished`, that reading remains in the local outbox with `rejected_reason=record_finished`; it is neither marked saved nor uploaded to the next step. The uploader continues following the device's active recording. Other rejection types still stop acquisition, and uncertain/network responses are retried normally. Fixed-record mode retains its existing stop-on-finished behavior.

Current single-sensor setup: apply `supabase/migrations/202611120001_single_sensor.sql`, use the matching one-sensor firmware, and save a fresh empty-sink reference. See the root README for upgrade preservation and traffic reductions.
