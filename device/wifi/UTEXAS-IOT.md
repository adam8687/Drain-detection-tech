# Connect the Nano ESP32 to utexas-iot

UT's current instructions: [Connecting to utexas-iot Wi-Fi (KB0017215)](https://ut.service-now.com/kb_view.do?sysparm_article=KB0017215).
Registration uses your UT EID; the board connects with the Wi-Fi key from the
portal, not your EID password. Keep the portal key private.

1. If the board is uploading, wait for a Saved acknowledgement, stop it, and
   finish its old record with `npm run wifi:finish` before changing networks.
   If there is an unacknowledged pending point, recover it using its original
   network/configuration first. Do not erase its filesystem.
2. Open `device/wifi_mac_address/wifi_mac_address.ino` in Arduino IDE. Select
   Arduino Nano ESP32 and its USB port, Upload, open Serial Monitor at 115200.
   Copy the station MAC printed every five seconds. This sketch needs no sensor
   wiring, performs no uploads and does not erase pending uploader data.
3. Visit https://network.utexas.edu from an online computer, sign in with your
   UT EID, select Register Wi-Fi Device. Enter the ESP station MAC and a description
   such as Drain Monitor ESP32. Select the Protected profile for the ESP's outbound
   uploads. Register and save the supplied Wi-Fi key privately. If grouped for
   display, remove spaces from the 16/20-digit key; keep all leading zeros.
4. In device/wifi/.env set WIFI_SSID="utexas-iot" and WIFI_PASSWORD to the
   portal key in quotes. Keep backend/Supabase credentials unchanged.
5. Find the backend computer's current Wi-Fi IPv4 address in network settings
   and set WIFI_HOST accordingly. Campus connectivity to a laptop is not proven
   merely by joining the network: inbound policy, routing or the computer's
   firewall may prevent the ESP reaching it. Our local bench scripts accept only
   private IPv4 hosts (10.*, 172.16–31.*, 192.168.*) and opt-in HTTP. If your computer
   has another address, stop here; do not guess or remove the address check.
6. Follow README.md: wifi:start, wifi:check, wifi:prepare, upload the measurement
   sketch (replacing the MAC-only sketch), then wifi:watch. All ports and sensor
   pins stay the same. A network/clock connection message confirms only that
   stage; Saved measurement plus wifi:watch confirms the complete pipeline.

Keep the ESP Protected: it initiates outbound requests and needs no inbound
server. The computer hosting the backend separately needs reachable inbound
TCP 8000 (or its configured port); changing the ESP's profile will not enable
that. Test reachability, and ask UT networking about an approved setup if blocked.
An authenticated HTTPS-hosted backend would avoid laptop inbound connectivity,
but the current scripted workflow is specifically a local LAN bench test.

Do not assume a shared campus network is equivalent to a trusted home LAN.
The local HTTP option exposes the scoped fixture key to the network; use a test
fixture only if this is acceptable, or arrange a verified HTTPS backend instead.
No UT login, registration, profile change, deployment or board upload is performed
by these repository files.
