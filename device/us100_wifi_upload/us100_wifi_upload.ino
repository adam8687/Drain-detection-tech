// Arduino Nano ESP32 -> Wi-Fi -> Drain Monitor API -> Supabase.
// See README.md before uploading. No external Arduino libraries required.
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <esp_system.h>
#include <esp_timer.h>
#include <sys/time.h>
#include <time.h>
#include "secrets.h"

// Sensor mode and sensor B availability are defined in secrets.h. Wi-Fi setup
// scripts generate them from device/wifi/.env using the same bench pin mapping.
HardwareSerial uartA(1), uartB(2);
Preferences state;
String pendingUrl, pendingBody;
bool stopped = false, recoveredRun = false;
int64_t epochMs = 0, startUs = 0;
uint32_t lastAttempt = 0;

struct Reading { int distanceMm; const char* status; };

void stop(const char* reason) {
  Serial.println(reason);
  stopped = true;
}

bool validId(const String& id) {
  if (id.length() != 36) return false;
  for (int i = 0; i < 36; i++) {
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (id[i] != '-') return false;
    } else if (!isxdigit(static_cast<unsigned char>(id[i]))) return false;
  }
  return true;
}

Reading readSensor(int trigger, int echo, HardwareSerial& uart) {
  if (USE_UART) {
    while (uart.available()) uart.read();
    uart.write(uint8_t(0x55));
    const uint32_t start = millis();
    while (uart.available() < 2 && uint32_t(millis() - start) < 250) delay(1);
    if (uart.available() < 2) return {-1, "timeout"};
    const int high = uart.read(), low = uart.read();
    const int mm = high * 256 + low;
    return mm >= 20 && mm <= 4500 ? Reading{mm, "ok"} : Reading{-1, "out_of_range"};
  }
  digitalWrite(trigger, LOW); delayMicroseconds(5);
  digitalWrite(trigger, HIGH); delayMicroseconds(10); digitalWrite(trigger, LOW);
  const unsigned long us = pulseIn(echo, HIGH, 60000UL);
  if (!us) return {-1, "timeout"};
  const int mm = int(us * 0.1657f + 0.5f);
  return us <= 50000UL && mm >= 20 && mm <= 4500
    ? Reading{mm, "ok"} : Reading{-1, "out_of_range"};
}

String sensorJson(const Reading& reading) {
  return String("{\"distance_mm\":") + (reading.distanceMm < 0 ? String("null") : String(reading.distanceMm))
    + ",\"status\":\"" + reading.status + "\"}";
}

String newId() {
  uint8_t bytes[16]; esp_fill_random(bytes, sizeof(bytes));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  char text[37];
  snprintf(text, sizeof(text), "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
    bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
    bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]);
  return String(text);
}

String timestamp() {
  // Anchor once to NTP, then advance monotonically: later NTP adjustments cannot
  // reorder a running recording's samples. Resets require a new recording.
  const int64_t ms = epochMs + (esp_timer_get_time() - startUs) / 1000;
  const time_t seconds = ms / 1000;
  struct tm utc; gmtime_r(&seconds, &utc);
  char base[24], out[32]; strftime(base, sizeof(base), "%Y-%m-%dT%H:%M:%S", &utc);
  snprintf(out, sizeof(out), "%s.%03dZ", base, int(ms % 1000));
  return String(out);
}

bool savePending() {
  File file = LittleFS.open("/pending.tmp", "w");
  if (!file) return false;
  const String data = pendingUrl + "\n" + pendingBody;
  const bool written = file.print(data) == data.length();
  file.flush(); file.close();
  return written && LittleFS.rename("/pending.tmp", "/pending.txt");
}

void setup() {
  Serial.begin(115200); delay(1500);
  if (!validId(SENSOR_RECORD_ID) || !String(SENSOR_KEY).startsWith("dk_") || String(SENSOR_KEY).indexOf("PASTE") >= 0) {
    stop("Fill secrets.h with the recording UUID and its fixture sensor key."); return;
  }
  const String base = API_BASE_URL;
  if (base.endsWith("/") || base.indexOf('\n') >= 0 || base.indexOf('\r') >= 0 || base.indexOf('@') >= 0) {
    stop("Use a backend URL without trailing slash or embedded credentials."); return;
  }
  // Plain HTTP is restricted to explicit private IPv4 addresses.
  if (base.startsWith("http://")) {
    String host = base.substring(7); const int colon = host.indexOf(':');
    if (colon >= 0) host = host.substring(0, colon);
    IPAddress ip;
    if (!ALLOW_LOCAL_HTTP || !ip.fromString(host) || !(ip[0] == 10 || (ip[0] == 192 && ip[1] == 168) || (ip[0] == 172 && ip[1] >= 16 && ip[1] <= 31))) {
      stop("HTTP requires ALLOW_LOCAL_HTTP and a private LAN IP. Otherwise use HTTPS."); return;
    }
  } else if (!base.startsWith("https://") || !strlen(API_ROOT_CA)) {
    stop("HTTPS requires the backend's trusted root CA in API_ROOT_CA."); return;
  }
  // Formatting requires the explicit first-use opt-in in secrets.h.
  if (!LittleFS.begin(INITIALIZE_EMPTY_FILESYSTEM) || !state.begin("drain-wifi", false)) {
    stop("Storage unavailable. See README for first-time filesystem initialization."); return;
  }
  recoveredRun = state.getString("started", "") == SENSOR_RECORD_ID;
  if (LittleFS.exists("/pending.txt")) {
    File file = LittleFS.open("/pending.txt", "r");
    pendingUrl = file.readStringUntil('\n'); pendingBody = file.readString(); file.close();
    const String expected = base + "/api/v1/records/" + SENSOR_RECORD_ID + "/measurements";
    if (pendingUrl != expected || !pendingBody.startsWith("{\"reading_id\":") || !pendingBody.endsWith("}")) {
      stop("Pending point belongs to another destination or is damaged. Restore original configuration; do not erase it."); return;
    }
    Serial.println("Recovering saved point with its original ID and timestamp.");
  }
  if (USE_UART) {
    uartA.begin(9600, SERIAL_8N1, D0, D1);
    if (SECOND_SENSOR_ENABLED) uartB.begin(9600, SERIAL_8N1, D2, D3);
  } else {
    pinMode(D1, OUTPUT); digitalWrite(D1, LOW); pinMode(D0, INPUT);
    if (SECOND_SENSOR_ENABLED) { pinMode(D3, OUTPUT); digitalWrite(D3, LOW); pinMode(D2, INPUT); }
  }
  WiFi.mode(WIFI_STA); WiFi.setAutoReconnect(true); WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.println("Connecting to Wi-Fi...");
}

void loop() {
  if (stopped) { delay(1000); return; }
  if (WiFi.status() != WL_CONNECTED) { delay(500); return; }
  if (!epochMs) {
    configTime(0, 0, "pool.ntp.org", "time.google.com");
    struct timeval now;
    for (int i = 0; i < 100; i++) {
      gettimeofday(&now, nullptr);
      if (now.tv_sec >= 1767225600) break;
      delay(100);
    }
    if (now.tv_sec < 1767225600) { Serial.println("Waiting for an accurate UTC clock..."); return; }
    epochMs = int64_t(now.tv_sec) * 1000 + now.tv_usec / 1000;
    startUs = esp_timer_get_time();
    Serial.println("Wi-Fi and UTC clock ready.");
  }
  if (pendingBody.isEmpty()) {
    if (recoveredRun) {
      stop("Restart detected. Pending point recovered. Finish the old recording and configure a NEW record ID before sampling."); return;
    }
    if (state.getString("started", "") != SENSOR_RECORD_ID && state.putString("started", SENSOR_RECORD_ID) == 0) {
      stop("Could not save recording state."); return;
    }
    const String time = timestamp();
    const Reading a = readSensor(D1, D0, uartA);
    Reading b = {-1, "timeout"};
    if (SECOND_SENSOR_ENABLED) { delay(70); b = readSensor(D3, D2, uartB); }
    pendingUrl = String(API_BASE_URL) + "/api/v1/records/" + SENSOR_RECORD_ID + "/measurements";
    pendingBody = String("{\"reading_id\":\"") + newId() + "\",\"timestamp\":\"" + time
      + "\",\"sensor_a\":" + sensorJson(a) + ",\"sensor_b\":" + sensorJson(b) + "}";
    if (!savePending()) { stop("Could not persist the point; upload stopped."); return; }
  }
  const uint32_t elapsed = millis() - lastAttempt;
  if (elapsed < 500) { delay(500 - elapsed); }
  lastAttempt = millis();
  WiFiClient plain; WiFiClientSecure secure; HTTPClient http;
  if (pendingUrl.startsWith("https://")) secure.setCACert(API_ROOT_CA);
  const bool ready = pendingUrl.startsWith("https://") ? http.begin(secure, pendingUrl) : http.begin(plain, pendingUrl);
  if (!ready) { stop("Invalid backend URL; saved point retained."); return; }
  http.setConnectTimeout(5000); http.setTimeout(5000);
  http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + SENSOR_KEY);
  const int code = http.POST(pendingBody);
  // Current API returns a small canonical JSON acknowledgement, never the array.
  // Unexpected acknowledgements retain the point and stop instead of losing it.
  const String reply = (code == 200 || code == 201) ? http.getString() : String("");
  http.end();
  if (code == 200 || code == 201) {
    const String recordField = String("\"record_id\":\"") + SENSOR_RECORD_ID + "\"";
    const bool finished = reply.indexOf("\"recording_status\":\"finished\"") >= 0;
    if (reply.indexOf(recordField) < 0 || (!finished && reply.indexOf("\"recording_status\":\"recording\"") < 0)) {
      stop("Unexpected acknowledgement; saved point retained for review."); return;
    }
    if (!LittleFS.remove("/pending.txt")) { stop("Could not clear acknowledged point. Restart to retry safely."); return; }
    pendingBody = ""; pendingUrl = "";
    Serial.println("Saved measurement in Supabase.");
    if (finished) stop("Recording finished. Create the next recording and update SENSOR_RECORD_ID.");
  } else if (code <= 0 || code == 408 || code == 429 || code >= 500) {
    Serial.printf("Connection/server unavailable (%d). Retrying saved point; sampling paused.\n", code);
    delay(2000);
  } else {
    Serial.printf("Upload stopped (HTTP %d). Check recording, fixture key and backend. Saved point retained.\n", code);
    stopped = true;
  }
}
