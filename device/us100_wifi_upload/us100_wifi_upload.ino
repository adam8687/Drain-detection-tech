// Arduino Nano ESP32 -> Wi-Fi -> Drain Monitor API -> Supabase.
// See README.md before uploading. No external Arduino libraries required.
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <FFat.h>
#include <Preferences.h>
#include <esp_system.h>
#include <esp_timer.h>
#include <sys/time.h>
#include <time.h>
#include "secrets.h"
#include "drain_activity.h"
#include "live_mode.h"
#include <atomic>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>

// Serial output costs time: a USB serial print can block once its buffer fills with nothing reading it, and set-up
// waits for a monitor to attach. The build is therefore silent and the messages below compile to nothing. For a
// diagnostic build add `#define DEBUG_SERIAL 1` here, or compile with -DDEBUG_SERIAL=1.
#ifndef DEBUG_SERIAL
#define DEBUG_SERIAL 0
#endif
#if DEBUG_SERIAL
#define LOG_LINE(text) Serial.println(text)
#define LOG_F(...) Serial.printf(__VA_ARGS__)
#else
#define LOG_LINE(text) do {} while (0)
#define LOG_F(...) do {} while (0)
#endif

// Sensor mode is defined in secrets.h. Wi-Fi setup
// scripts generate it from device/wifi/.env using the same bench pin mapping.
HardwareSerial uartA(1);
Preferences state;
String pendingUrl, pendingBody, pendingJournal;
String recordId = SENSOR_RECORD_ID, blockedRecordId;
bool selectRecording = true;
uint32_t lastDiscovery = 0;
DrainActivity activity;  // decides when a finished drain should be uploaded at once
LiveMode liveMode;
QueueHandle_t samples = nullptr;
std::atomic<bool> samplingEnabled{false}, samplingRunning{false}, sampleOverflow{false};
bool stopped = false, recoveredRun = false;
int64_t epochMs = 0, startUs = 0;
uint32_t lastAttempt = 0;
// Readings are journaled one by one, then uploaded together (server limit: 20 per upload).
// 10 readings x 0.5 s = one upload about every 5 s, which keeps the number of requests low.
uint32_t lastPostMs = 100000;
// Kept for the life of the sketch so the TLS connection can be reused (keep-alive).
WiFiClient plainClient; WiFiClientSecure secureClient; HTTPClient http;
bool caSet = false;
constexpr uint32_t SAMPLE_INTERVAL_MS = 500;
int batchCount = 0;
bool batchReady = false;
uint32_t lastStatus = 0;
String stopReason;

struct Reading { int distanceMm; const char* status; };
struct Sample { char id[37]; char time[32]; Reading reading; bool drainEnded; };

void stop(const String& reason) {
  samplingEnabled.store(false);
  stopReason = reason;
  LOG_LINE(reason);
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
    // Match the repository's standalone UART test response window exactly.
    while (uart.available() < 2 && uint32_t(millis() - start) < 500) delay(1);
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

// Sampling runs independently of TLS, HTTP and flash writes. The bounded queue
// holds about one minute; an overrun is explicit instead of silently losing points.
void sampleTask(void*) {
  samplingRunning.store(true);
  TickType_t wake = xTaskGetTickCount();
  while (samplingEnabled.load()) {
    Sample sample;
    timestamp().toCharArray(sample.time, sizeof(sample.time));
    sample.reading = readSensor(D1, D0, uartA);
    newId().toCharArray(sample.id, sizeof(sample.id));
    sample.drainEnded = activity.update(sample.reading.distanceMm);
    if (xQueueSend(samples, &sample, 0) != pdTRUE) { sampleOverflow.store(true); samplingEnabled.store(false); break; }
    vTaskDelayUntil(&wake, pdMS_TO_TICKS(SAMPLE_INTERVAL_MS));
  }
  samplingRunning.store(false);
  vTaskDelete(nullptr);
}

bool beginRequest(const String& url) {
  if (url.startsWith("https://") && !caSet) { secureClient.setCACert(API_ROOT_CA); caSet = true; }
  http.setReuse(true);
  const bool ready = url.startsWith("https://") ? http.begin(secureClient,url) : http.begin(plainClient,url);
  if (!ready) return false;
  http.setConnectTimeout(5000); http.setTimeout(5000);
  http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + SENSOR_KEY);
  http.addHeader("X-Drain-Live-Capability", "1");
  http.addHeader("X-Drain-Live-Active", liveMode.active(millis()) ? "1" : "0");
  const char* headers[] = {"X-Drain-Live-For-Ms"}; http.collectHeaders(headers,1);
  return true;
}

// A step can finish with readings in flight. Archive these locally against their
// ORIGINAL recording, never send them into the new calibration/monitoring step.
bool finishStep(bool rejected) {
  samplingEnabled.store(false);
  while (samplingRunning.load()) delay(10);
  const bool queued = samples && uxQueueMessagesWaiting(samples)>0;
  if (rejected || queued) {
    File archive=FFat.open(String("/unsent-")+recordId+".txt","a");
    if(!archive)return false;
    bool good=true;
    if(rejected)good=archive.print(pendingJournal)==pendingJournal.length();
    if(queued){
      const String url=String(API_BASE_URL)+"/api/v1/records/"+recordId+"/measurements\n";
      good=good&&archive.print(url)==url.length();
      Sample sample;
      while(xQueueReceive(samples,&sample,0)==pdTRUE){
        const String point=String("{\"reading_id\":\"")+sample.id+"\",\"timestamp\":\""+sample.time+"\",\"sensor\":"+sensorJson(sample.reading)+"}\n";
        if(archive.print(point)!=point.length()){good=false;break;}
      }
    }
    archive.flush();archive.close();if(!good)return false;
  }
  if(rejected&&FFat.exists("/pending.txt")&&!FFat.remove("/pending.txt"))return false;
  if(samples){vQueueDelete(samples);samples=nullptr;}
  pendingBody="";pendingUrl="";pendingJournal="";batchCount=0;batchReady=false;
  selectRecording=true;lastDiscovery=0;
  return true;
}

bool discoverRecording() {
  if(lastDiscovery && uint32_t(millis()-lastDiscovery)<2000)return false;
  lastDiscovery=millis();
  if(!beginRequest(String(API_BASE_URL)+"/api/v1/sensor/active-record")){stop("Could not check setup recording.");return false;}
  const uint32_t started=millis();const int code=http.GET();
  const String reply=code==200?http.getString():String("");
  const long duration=http.header("X-Drain-Live-For-Ms").toInt();http.end();
  if(code==200)liveMode.apply(duration>0?uint32_t(duration):0,started);
  else if(code==401||code==403){stop("Device access was rejected. Contact your installer.");return false;}
  if(code!=200)return false;
  const String field="\"record_id\":\"";const int start=reply.indexOf(field);
  if(start<0)return false;
  const String next=reply.substring(start+field.length(),start+field.length()+36);
  if(!validId(next.c_str())||next==blockedRecordId)return false;
  if(state.putString("record",next)==0){stop("Could not save the setup recording.");return false;}
  recordId=next;recoveredRun=false;selectRecording=false;
  return true;
}

// Journal format: line 1 = URL, then one measurement JSON per line. The batch is built in memory and written once, when it
// is complete and about to upload: one flash write per batch instead of one per reading. A power loss can lose only the
// readings of the batch still being collected (a few seconds), never a batch that is already queued for upload.
bool writeJournal() {
  File file = FFat.open("/pending.txt", "w");
  if (!file) return false;
  const bool written = file.print(pendingJournal) == pendingJournal.length();
  file.flush(); file.close();
  return written;
}

void setup() {
#if DEBUG_SERIAL
  Serial.begin(115200); delay(1500);
#endif
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
  if (!FFat.begin(INITIALIZE_EMPTY_FILESYSTEM) || !state.begin("drain-wifi", false)) {
    stop("Storage unavailable. See README for first-time filesystem initialization."); return;
  }
  // Keep a dynamically selected recording across power loss so a saved journal
  // can only be recovered to its original destination. Explicit reprovisioning
  // still refuses an old journal belonging to a different configuration.
  if(state.getString("configured","")==SENSOR_RECORD_ID)recordId=state.getString("record",SENSOR_RECORD_ID);
  else if(state.putString("configured",SENSOR_RECORD_ID)==0){stop("Could not save device configuration.");return;}
  recoveredRun = state.getString("started", "") == recordId;
  if(recoveredRun&&!RESUME_AFTER_RESTART)blockedRecordId=recordId;
  if (FFat.exists("/pending.txt")) {
    File file = FFat.open("/pending.txt", "r");
    pendingUrl = file.readStringUntil('\n');
    String lines = file.readString(); file.close();
    pendingJournal = pendingUrl + "\n" + lines;
    if (!pendingJournal.endsWith("\n")) pendingJournal += "\n";
    String points;
    if (lines.indexOf('\n') < 0 && lines.startsWith("{\"reading_id\":") && lines.endsWith("}")) lines += "\n";  // older single-point journal
    while (lines.indexOf('\n') >= 0) {  // complete lines only; a torn final line is dropped
      const int end = lines.indexOf('\n'); const String line = lines.substring(0, end); lines = lines.substring(end + 1);
      if (!line.startsWith("{\"reading_id\":") || !line.endsWith("}")) { points = ""; break; }
      points += (points.isEmpty() ? "" : ",") + line; batchCount++;
    }
    pendingBody = points.isEmpty() ? String("") : String("{\"measurements\":[") + points + "]}";
    const String expected = base + "/api/v1/records/" + recordId + "/measurements";
    if (pendingUrl != expected && strlen(PREVIOUS_API_BASE_URL)) {
      const String original = String(PREVIOUS_API_BASE_URL) + "/api/v1/records/" + recordId + "/measurements";
      if (pendingUrl == original) {
        // Only migrate the endpoint for a verified SAME recording. Keep the old
        // on-disk journal intact until cloud acknowledgement; retries stay exact.
        pendingUrl = expected;
        LOG_LINE("Recovering the original pending point to its verified cloud recording.");
      }
    }
    if (pendingUrl != expected || pendingBody.isEmpty()) {
      stop("Pending point belongs to another destination or is damaged. Restore original configuration; do not erase it."); return;
    }
    batchReady = true;  // a journaled batch is uploaded exactly as saved, never extended
    selectRecording=false;
    LOG_LINE("Recovering saved point(s) with their original IDs and timestamps.");
  }
  if (USE_UART) {
    uartA.begin(9600, SERIAL_8N1, D0, D1);
  } else {
    pinMode(D1, OUTPUT); digitalWrite(D1, LOW); pinMode(D0, INPUT);
  }
  WiFi.mode(WIFI_STA); WiFi.setAutoReconnect(true); WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  LOG_LINE("Connecting to Wi-Fi...");
}

void loop() {
  if (sampleOverflow.load() && !stopped) { stop("Sampling queue full. Saved batch retained; check Wi-Fi and start a new recording."); }
  // USB serial reconnects after reset/upload. Repeat diagnostics so attaching
  // later still reveals the problem, without printing credentials or payloads.
  if (stopped) {
    if (uint32_t(millis() - lastStatus) >= 5000) {
      LOG_LINE(stopReason); lastStatus = millis();
    }
    delay(100); return;
  }
  if (WiFi.status() != WL_CONNECTED) {
    if (uint32_t(millis() - lastStatus) >= 5000) {
      LOG_F("Waiting for Wi-Fi (status %d); station MAC: %s\n", int(WiFi.status()), WiFi.macAddress().c_str());
      lastStatus = millis();
    }
    delay(500); return;
  }
  if (!epochMs) {
    configTime(0, 0, "pool.ntp.org", "time.google.com");
    struct timeval now;
    for (int i = 0; i < 100; i++) {
      gettimeofday(&now, nullptr);
      if (now.tv_sec >= 1767225600) break;
      delay(100);
    }
    if (now.tv_sec < 1767225600) { LOG_LINE("Waiting for an accurate UTC clock..."); return; }
    epochMs = int64_t(now.tv_sec) * 1000 + now.tv_usec / 1000;
    startUs = esp_timer_get_time();
    LOG_F("Wi-Fi and UTC clock ready. ESP IP: %s\n", WiFi.localIP().toString().c_str());
  }
  if (!batchReady) {
    if(selectRecording&&!discoverRecording()){delay(50);return;}
    if (pendingBody.isEmpty() && recoveredRun && !RESUME_AFTER_RESTART) {
      selectRecording=true;return;
    }
    if (state.getString("started", "") != recordId && state.putString("started", recordId) == 0) {
      stop("Could not save recording state."); return;
    }
    if (sampleOverflow.load()) { stop("Sampling queue full after an upload interruption. Saved batch retained; start a new recording."); return; }
    if (!samples) {
      samples = xQueueCreate(128, sizeof(Sample));
      if (!samples) { stop("Sampling queue unavailable."); return; }
      samplingEnabled.store(true);
      if (xTaskCreatePinnedToCore(sampleTask,"drain-sampling",4096,nullptr,2,nullptr,1) != pdPASS) { stop("Sampling task unavailable."); return; }
    }
    Sample sample;
    if (xQueueReceive(samples,&sample,pdMS_TO_TICKS(100)) != pdTRUE) return;
    const bool drainEnded = sample.drainEnded;
    const String point = String("{\"reading_id\":\"") + sample.id + "\",\"timestamp\":\"" + sample.time
      + "\",\"sensor\":" + sensorJson(sample.reading) + "}";
    const bool firstOfBatch = pendingBody.isEmpty();
    if (firstOfBatch) {
      pendingUrl = String(API_BASE_URL) + "/api/v1/records/" + recordId + "/measurements";
      pendingBody = String("{\"measurements\":[") + point + "]}";
    } else {
      pendingBody.remove(pendingBody.length() - 2);  // reopen "]}"
      pendingBody += "," + point + "]}";
    }
    batchCount++;
    if (firstOfBatch) pendingJournal = pendingUrl + "\n" + point + "\n"; else pendingJournal += point + "\n";
    // A batch uploads when it is full, or at once when a drain has just ended (the sink is dry, so pausing to upload
    // loses nothing and the result reaches the app in about a second instead of waiting for the batch to fill).
    if (batchCount < liveMode.batchSize(millis()) && !drainEnded) return;
    if (!writeJournal()) { stop("Could not persist the batch; upload stopped."); return; }
    batchReady = true;
  }
  const uint32_t elapsed = millis() - lastAttempt;
  if (elapsed < 100) { delay(100 - elapsed); }
  lastAttempt = millis();
  const bool ready = beginRequest(pendingUrl);
  if (!ready) { stop("Invalid backend URL; saved point retained."); return; }
  const uint32_t postStart = millis();
  const int code = http.POST(pendingBody);
  const uint32_t postMs = millis() - postStart;
  // Current API returns a small canonical JSON acknowledgement, never the array.
  // Unexpected acknowledgements retain the point and stop instead of losing it.
  const String reply = (code == 200 || code == 201 || code == 409) ? http.getString() : String("");
  const String liveDuration = http.header("X-Drain-Live-For-Ms");
  http.end();
  lastPostMs = code > 0 ? postMs : 100000;
  if (code <= 0) { secureClient.stop(); plainClient.stop(); }
  if (code == 200 || code == 201) {
    const String recordField = String("\"record_id\":\"") + recordId + "\"";
    const bool finished = reply.indexOf("\"recording_status\":\"finished\"") >= 0;
    if (reply.indexOf(recordField) < 0 || (!finished && reply.indexOf("\"recording_status\":\"recording\"") < 0)) {
      stop("Unexpected acknowledgement; saved point retained for review."); return;
    }
    if (sampleOverflow.load()) { stop("Sampling queue full during upload. Saved batch retained for recovery."); return; }
    if (!FFat.remove("/pending.txt")) { stop("Could not clear acknowledged point. Restart to retry safely."); return; }
    // Missing commands (old servers), expired leases and restarts all mean normal.
    long liveMs = liveDuration.toInt();
    liveMode.apply(liveMs > 0 ? uint32_t(liveMs) : 0, postStart);
    pendingBody = ""; pendingUrl = ""; pendingJournal = ""; batchCount = 0; batchReady = false;
    LOG_F("Saved batch in Supabase. (%u ms, RSSI %d dBm)\n", (unsigned)postMs, WiFi.RSSI());
    if (finished&&!finishStep(false))stop("Could not archive remaining readings. Contact your installer.");
  } else if(code==409&&reply.indexOf("\"record_finished\"")>=0) {
    if(!finishStep(true))stop("Could not preserve unsent readings. Saved batch retained.");
  } else if (code <= 0 || code == 408 || code == 429 || code >= 500) {
    LOG_F("Connection/server unavailable (%d) after %u ms, RSSI %d dBm. Retrying saved batch; sampling buffered.\n", code, (unsigned)postMs, WiFi.RSSI());
    delay(2000);
  } else {
    stop(String("Upload stopped (HTTP ") + code + "). Check recording, fixture key and backend. Saved point retained.");
  }
}
