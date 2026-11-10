#pragma once
constexpr bool USE_UART = false; // false = rear jumper removed; true = installed.
constexpr bool SECOND_SENSOR_ENABLED = false;
// Copy this file to secrets.h in this folder. secrets.h is ignored by Git.
constexpr char WIFI_SSID[] = "YOUR_2_4_GHZ_WIFI";
constexpr char WIFI_PASSWORD[] = "YOUR_WIFI_PASSWORD";
// Use your Mac's LAN IP, NOT localhost, for a local backend. No trailing slash.
constexpr char API_BASE_URL[] = "http://192.168.1.100:8000";
constexpr char SENSOR_RECORD_ID[] = "PASTE_RECORD_UUID";
constexpr char SENSOR_KEY[] = "dk_PASTE_FIXTURE_KEY";
// Enable only for a trusted local Wi-Fi test. HTTP sends the key unencrypted.
constexpr bool ALLOW_LOCAL_HTTP = false;
// First use only, if Serial Monitor reports uninitialized storage. This erases
// the LittleFS partition. Leave false whenever there could be a pending point.
constexpr bool INITIALIZE_EMPTY_FILESYSTEM = false;
// For a deployed HTTPS backend, supply its trusted root CA PEM here.
// Never use setInsecure(), a Supabase secret, or the backend admin API_KEY.
constexpr char API_ROOT_CA[] = R"PEM()PEM";
