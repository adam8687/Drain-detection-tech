// Arduino Nano ESP32: read the Wi-Fi station MAC for campus registration.
// No Wi-Fi password, sensor wiring, Supabase or backend needed.
// Does not join Wi-Fi or read/change the uploader's pending files.
#include <Arduino.h>
#include <WiFi.h>

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  delay(1500);
}

void loop() {
  Serial.print("Register this ESP Wi-Fi MAC: ");
  Serial.println(WiFi.macAddress());
  Serial.println("Use this station MAC, not your Mac computer's address.");
  delay(5000);
}
