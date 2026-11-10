# Friend's Wi-Fi test checklist

For the recommended Mac-independent path, use [direct Supabase cloud setup](../../supabase/CLOUD-SETUP.md).
This page describes the optional local-LAN backend alternative. In cloud mode,
wifi:prepare/watch/finish use Supabase and cloud:start runs only the website.

For UT Austin campus Wi-Fi, first follow [utexas-iot registration](UTEXAS-IOT.md).

**Nano ESP32 + US-100 → Wi-Fi → backend → Supabase → website.** Requirements:
Node.js 24+, Arduino IDE with Arduino ESP32 Boards, and an authorized backend/.env
on your trusted computer. Share project files, never environment files, generated
secrets.h or fixture keys. Never put the Supabase server secret on the ESP.
All commands run from the repository root.

## Ports and pins

| Connection | Setting |
|---|---|
| ESP → computer API | Computer LAN IPv4 + backend/.env PORT, default **8000** |
| Browser → website | device/wifi/.env WEB_PORT, default **3000** |
| Website → API | Script sets BACKEND_URL to the same API port |
| USB | Arduino IDE upload/diagnostics only; not Wi-Fi data transport |
| Serial Monitor | **115200 baud** |
| US-100 UART, if selected | **9600 baud**, rear jumper installed |
| Sensor A | Trig/TX **D1**, Echo/RX **D0** |
| Optional sensor B | Trig/TX **D3**, Echo/RX **D2** |

Both sensors use 3V3/GND. Disconnect power while wiring. Default is one sensor in
trigger/echo mode, rear jumper **removed**. Missing B uploads null/timeout.
Calibration/drainage need two working sensors. The ESP never uses localhost or
the website port. The launcher refuses occupied ports instead of switching them.
Do not run another backend/frontend or device:upload alongside wifi:start.
Your Mac must stay awake with Internet access for this local setup.

## First run

1. Install frontend dependencies once: `npm --prefix web ci`.
2. Supabase SQL Editor: apply `supabase/migrations/202610270001_drain_records.sql`
   **only if drain_records does not exist**, then apply
   `supabase/migrations/202610270002_records_access.sql`. Scripts report missing
   tables but do not execute SQL or delete data. The access migration creates the
   registry/permissions/key tables required by the current app.
3. `npm run wifi:init`. Edit **device/wifi/.env**: fill your 2.4 GHz Wi-Fi name
   and password, set ALLOW_LOCAL_HTTP=true for a trusted LAN. HTTP exposes the
   fixture key to that network. Leave B disabled. If LAN detection is ambiguous,
   set WIFI_HOST to your Mac's Wi-Fi IPv4: System Settings → Wi-Fi → Details → TCP/IP.
4. Terminal 1: `npm run wifi:start`. Keep running. It checks tables, starts both
   servers and prints exact addresses. Resolve any occupied port before retrying.
5. Terminal 2: `npm run wifi:check`. Checks database, LAN API, website and its
   authenticated proxy without writing readings. Also open the printed API
   /health address from a phone on the same Wi-Fi. If blocked, check computer
   firewall or guest/campus device isolation.
6. `npm run wifi:prepare -- friend-sink monitoring`. Registers the fixture,
   creates/reuses a physical monitoring record, saves a scoped key privately and
   **generates secrets.h** automatically. A manual secrets.h is protected: back
   it up and add --replace-config only to intentionally switch to generated settings.
7. Arduino IDE: open **device/us100_wifi_upload/us100_wifi_upload.ino**, select
   **Arduino Nano ESP32**, select its USB port, keep **Partition Scheme → With FAT
   partition (default)**, Upload. No Supabase library needed.
   Open Serial Monitor at **115200**; wait for Saved measurement in Supabase.
8. `npm run wifi:watch`. Waits up to 60 seconds for a NEW real sensor point and
   compares it exactly across the API, hosted Supabase and website proxy. It never
   injects sample data. PASS proves transport; check reported A/B statuses and
   compare A's physical distance against a ruler separately.
9. Open the printed /dashboard URL. For this admin-managed fixture, sign out if
   signed in, enter **friend-sink**, choose **Physical sensors**, Refresh. If asked
   for Backend token, enter the existing local backend API_KEY there, not the ESP
   key. Expand Sensor readings and calibration. The count should increase.
   An unavailable drain estimate is expected before calibration.

Fresh board reports storage unavailable? Set INITIALIZE_EMPTY_FILESYSTEM=true in
device/wifi/.env, rerun prepare and upload once. Once initialized, restore false
for the **next** generated configuration. Never format with pending board data.
If readings were acquired before a reset, finish the old record and prepare a new one.

## Stop and repeat

Wait for Saved, power down the board, then `npm run wifi:finish`. This finishes
only the prepared record without deleting anything. Prepare monitoring again and
Upload the regenerated configuration for the next test. Preparing while the same
type is active reuses the record; it does not clear points or reset restart protection.

After a reboot the board retries its pending point, then stops new sampling into
its old record. Restore original settings to recover pending data before changing
network/record IDs. Do not erase the filesystem to bypass errors. Issued keys/IDs
are saved privately in ignored **device/wifi/data/state.json**; do not share it.

## Calibration and drainage

1. Stop the board; `npm run wifi:finish` to finish monitoring.
2. Wire B, set SECOND_SENSOR_ENABLED=true in device/wifi/.env, mount both sensors.
   Their rear jumpers must match USE_UART. Empty the fixture and turn off the tap.
3. `npm run wifi:prepare -- friend-sink calibration --confirm-empty`, then Upload.
   Wait for stable paired evidence and the board's Recording finished message.
4. Fill with drain closed, turn off tap. Run
   `npm run wifi:prepare -- friend-sink drainage`, then Upload. When readings are
   saving with water still present, release the drain and watch the dashboard.
5. Backend saves drain time when both sensors confirm empty. Prepare a new
   drainage recording for each test. Successful calibration is reused.

The sketch stores one pending point and pauses sampling offline; it does not
collect continuously offline. Gaps can make timing uncertain. Per-sample flash
writes are for bench testing; long-term use needs an endurance/buffering design.
Automated checks/compilation do not establish physical accuracy or ESP reachability.
See [firmware recovery details](../us100_wifi_upload/README.md).
