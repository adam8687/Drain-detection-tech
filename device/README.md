# ESP32 sensor contract

## Wi-Fi uploads (Arduino Nano ESP32)

**Recommended:** [direct Supabase cloud setup](../supabase/CLOUD-SETUP.md).
The ESP uses verified HTTPS and does not contact a Mac or localhost:8000.
The local-LAN guides below remain optional development alternatives.

Use [the Wi-Fi uploader and setup guide](us100_wifi_upload/README.md) to send
US-100 measurements without a USB-connected computer. The sketch uses the existing
sensor API, which persists readings in Supabase and supplies the dashboard with
backend-computed calibration, drainage times and alerts. No Arduino Supabase
library or additional database table is needed.

For repeatable bench testing with matching ports, generated firmware settings and
real Supabase readback, use the [friend-testing scripts](wifi/README.md).

## USB bench tests (Arduino Nano ESP32)

Start with one sensor and Serial Monitor at **115200 baud**:

- [Trigger/echo test](us100_pulse_test/README.md): rear mode jumper **removed**.
- [UART test](us100_serial_test/README.md): rear mode jumper **installed**.

Both use sensor VCC to **3V3**, GND to **GND**, Trig/TX to **D1/TX**, and
Echo/RX to **D0/RX**. Select **Arduino Nano ESP32** in Arduino IDE. These
standalone sketches print measurements over USB; they do not upload to the API.
If both tests fail, verify wiring and sensor power before changing software.

## Backend uploads

For the Arduino Nano ESP32 USB bench setup, use the
[USB uploader and setup guide](usb-bridge/README.md) with
[`us100_usb_upload.ino`](us100_usb_upload/us100_usb_upload.ino).
It sends structured readings through the existing API and keeps a durable Mac
outbox for retries. The standalone tests above only print human-readable text.

One ESP32 per fixture, with two US-100 measurement locations. Keep sensors separate, trigger sequentially to reduce interference, and validate electrical compatibility, splash protection and timing with your actual components before use.

The active API is now recording-based; old frame/device/session routes are retired. See `backend/README.md` for complete JSON examples.

1. Connect Wi-Fi and synchronize the ESP32 clock. Use one stable fixture ID.
2. With the fixture confirmed empty, create a `calibration` record (`data_source: sensor`, `confirm_empty: true`). The response gives `record_id`.
3. Send paired distance readings to `/api/v1/records/{record_id}/measurements`, roughly twice per second. Generate a UUID `reading_id` once per point, and reuse it and the timestamp on retries.
4. Calibration auto-finishes after stable evidence; save the record acknowledgement before starting drainage or monitoring.
5. Create a `drainage` record before releasing water with the tap off. The backend copies that fixture's latest usable sensor calibration, computes drainage results and confirms completion.
6. Use `monitoring` recordings outside drainage episodes. Finish/start a new window before 5000 points. After a reboot or clock reset, recover the active record ID and pending point IDs, or explicitly finish the interrupted recording before creating a new one.

Each point contains only `reading_id`, UTC `timestamp`, `sensor_a` and `sensor_b`. Each sensor contains `distance_mm` and `status`. Valid distance uses `ok`; failed echoes use a null distance with `timeout` or `out_of_range`. Do not send a Supabase secret to the ESP32, invent zero-distance failures, or send water temperature as distance compensation. For physical uploads, use the fixture sensor key issued to its owner. The signed-in owner starts recordings on the website and provisions the returned record_id to the ESP32; sensor keys cannot list recordings or manage other fixtures. Backend admin tokens are for trusted maintenance/simulation, not browser sign-in.

No hardware implementation or accuracy is claimed by the simulation. Firmware must implement persistent retry/recovery behavior appropriate to the actual board.
