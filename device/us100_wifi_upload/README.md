# US-100 uploads over Wi-Fi (Arduino Nano ESP32)

**Recommended:** use the [scripted friend-testing checklist](../wifi/README.md).
It starts both servers with matching ports, generates secrets.h and verifies new
real readings across the API, Supabase and website. Below is the manual alternative;
do not mix its USB setup helper with the scripted path.

**US-100 → Nano ESP32 → Wi-Fi → existing Node backend → Supabase `drain_records` → dashboard.**

The board no longer needs a USB connection to the computer after programming; it
still needs power. For local testing the Mac must remain awake, with the backend
running and Internet access to Supabase. A deployed HTTPS backend removes that
Mac dependency. The website reads saved data through the backend and refreshes an
active recording approximately every 1.5 seconds. It calculates no sensor results
on the board. The existing backend handles calibration, drainage results, forecasts
and alerts. No database migration is introduced by this sketch.

## Why the Arduino Supabase library is not used here

Connect Arduino-Supabase and ESPSupabase are direct database clients. This project's
database intentionally allows writes only through its trusted backend. A direct
insert/update would bypass backend calibration, validation, duplicate detection
and result calculation. Our sensor key (`dk_...`) authenticates to our API, not to
Supabase. Do not disable database permissions or put a Supabase secret/admin token
on the board to make a direct-insert example work. This sketch uses WiFi,
HTTPClient, WiFiClientSecure, LittleFS and Preferences bundled with the installed
Arduino ESP32 board package; no Library Manager additions are required.

## 1. Start the backend and obtain a recording

From the repository root:

```bash
cd ~/Desktop/Drain-detection-tech
npm run check:supabase
npm start
```

In a second terminal:

```bash
cd ~/Desktop/Drain-detection-tech
npm run device:setup -- wifi-bench monitoring
```

The existing setup helper registers `wifi-bench`, creates/reuses a physical-sensor
monitoring record and privately saves `SENSOR_RECORD_ID` and `SENSOR_KEY` in
`device/usb-bridge/.env`. Its final USB instructions can be ignored for this Wi-Fi
path. **Do not run device:upload**: the board sends readings itself. Setup neither
modifies `backend/.env` nor copies the Supabase secret. Do not share the generated
key. If a different recording is already active for this fixture, finish it first.

Alternatively, register the fixture/start a Sensor recording in the website and
issue its fixture key there. This ensures a signed-in account owns the fixture.
Fixtures created with local admin setup are not automatically owned by whichever
account signs in later. Both the sensor's key and recording must belong to the
same fixture. The owner creates recordings; sensor keys can only append readings.

## 2. Configure and upload in Arduino IDE

1. Open `device/us100_wifi_upload/us100_wifi_upload.ino`.
2. Copy `secrets.example.h` to `secrets.h` in the same folder. This private file
   is ignored by Git. Fill the Wi-Fi name/password, record ID and fixture key.
3. For local testing, set `API_BASE_URL` to `http://YOUR_MAC_LAN_IP:8000` and
   `ALLOW_LOCAL_HTTP = true`. Find the Mac's Wi-Fi IPv4 address in System Settings
   → Wi-Fi → Details → TCP/IP. **localhost/127.0.0.1 on the ESP means the ESP,
   not your Mac.** The sketch restricts HTTP to explicit private IPv4 addresses.
   HTTP exposes the fixture key to that network, so use only a trusted test LAN.
   For a deployed backend use its HTTPS URL, its root CA PEM in `API_ROOT_CA`,
   and leave `ALLOW_LOCAL_HTTP = false`. TLS verification is never disabled.
4. Use a 2.4 GHz network. The ESP and Mac must be able to reach each other;
   guest/campus isolation or the Mac firewall may block port 8000. Confirm
   `http://YOUR_MAC_LAN_IP:8000/health` opens on another device on that network.
5. Select **Arduino Nano ESP32**, its port, then Upload. Keep default board
   partition settings that provide a filesystem. Open Serial Monitor at **115200**.
6. If it reports uninitialized storage on first use, set
   `INITIALIZE_EMPTY_FILESYSTEM = true`, upload once, then restore it to false
   for subsequent uploads. This explicitly permits formatting an unmountable
   LittleFS partition; never enable it when there may be an unsaved reading.

Expected messages:

```text
Connecting to Wi-Fi...
Wi-Fi and UTC clock ready.
Saved measurement in Supabase.
```

`Saved` confirms the API acknowledged the write. It does not mean both sensors
worked: a missing sensor is honestly stored as null/timeout. No credentials or
raw server error responses are printed. Changing secrets.h requires another upload.

## 3. Wire and inspect measurements

Disconnect power while wiring. Default sketch mode is trigger/echo, with the
US-100 rear jumper **removed**:

| US-100 | Nano ESP32 |
|---|---|
| VCC | 3V3 |
| GND | GND |
| A Trig/TX | D1 |
| A Echo/RX | D0 |
| Optional B Trig/TX | D3 |
| Optional B Echo/RX | D2 |

Sensor B shares power/GND. Set `SECOND_SENSOR_ENABLED = true` in secrets.h when it is actually
connected. The sensors fire sequentially with a pause; verify interference and
accuracy with your physical setup. For UART, install both mode jumpers and set
`USE_UART = true`; the same pin mapping uses 9600 baud. Distances are numeric
millimeters (20–4500); missing/invalid echoes use null with timeout/out_of_range.
The default one-sensor setup supports transport testing in monitoring mode only.
Calibration and drainage completion require **both** sensors to work.

Run the frontend in another terminal:

```bash
cd ~/Desktop/Drain-detection-tech
npm --prefix web run dev
```

Open http://localhost:3000/dashboard, choose fixture **wifi-bench** and source
**Sensor**, then select the active recording. Supabase Table Editor shows the
matching `drain_records` row and its growing `measurements` array. Monitoring
without a calibration can show raw readings; a reliable drainage-time graph
requires the calibrated drainage workflow below. Use the matching owner account
if the website is signed in. Preserve the existing backend/frontend environment
configuration and apply the documented access migration if using fixture keys.

## 4. Calibrate and measure drainage

1. Stop/power down the board, ensure all acknowledged points were saved, and
   finish its monitoring recording on the website.
2. Mount both sensors in their final positions and confirm the fixture is empty.
3. Run `npm run device:setup -- wifi-bench calibration --confirm-empty` (or
   create that Sensor calibration as the owner on the website).
4. Copy the new record ID into secrets.h, enable B, and upload. The backend needs
   at least 20 valid stable paired readings spanning eight seconds. The board
   stops when the API acknowledges automatic calibration completion.
5. Run `npm run device:setup -- wifi-bench drainage`, copy its new record ID,
   and upload. Start the recording while there is water, then release the drain
   with the tap off. The backend copies the empty calibration and computes the
   drainage time as the readings return to empty. The board stops on completion.
6. Create a new recording for each subsequent drainage test. Calibration is
   reused until you deliberately recalibrate, such as after moving a sensor.

The proof of concept requires an owner/setup tool to start each record and update
the configured ID. It does not automatically detect and start new drainage events
or provision a new record to the board. Those are separate future improvements.

## Recovery and prototype limits

- Each sample is saved to LittleFS before sending. Only one unacknowledged sample
  is kept. A network failure pauses further sampling; it does not provide continuous
  offline collection. The original UUID, timestamp and body are retried unchanged.
  The backend deduplicates a lost response. A measurement interrupted before its
  local file is saved cannot be recovered.
- After a restart, an existing pending sample is retried first. New sampling into
  the same record then stops. Review pending data, finish the old record and
  configure a new record ID. This makes clock/power interruptions explicit.
- Restore the original URL, record ID and appropriate key to recover a pending
  sample; changing configuration never redirects it into another record. Do not
  erase the filesystem to work around authentication/conflict errors. The key
  may be replaced with another valid key for the same fixture if revoked.
- HTTP 200/201 acknowledges a saved/duplicate point. Network errors, 408, 429 and
  server errors retry. Other responses stop while retaining the pending sample.
  Check backend logs for the reason (wrong key, finished/full record, etc.).
- Backend limits remain 5000 points per recording. Close/start monitoring windows
  before that limit. Long network gaps can make drainage timing uncertain; the
  sketch never fabricates readings to fill them. Cadence is roughly 2 Hz at best;
  sensor and HTTP latency can slow it down.
- UTC comes from NTP at startup, then advances on the board's monotonic clock.
  NTP/Internet access is required. This is acquisition-request time before the
  sequential sensor measurements, not simultaneous echo timestamps.
- Per-sample flash writes are suitable for a bench prototype; sustained deployment
  needs a flash endurance/buffering design. Wi-Fi reconnects within a boot are
  automatic; reset/reboot recording recovery remains deliberately manual.
- Compile checks establish firmware compatibility, not physical measurements or
  successful Wi-Fi/TLS connectivity. Verify those on your actual board/network.
