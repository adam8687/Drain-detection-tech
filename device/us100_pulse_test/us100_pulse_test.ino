// Arduino Nano ESP32 + one US-100, rear mode jumper REMOVED.
// 3V3 -> VCC; GND -> GND; D1 -> Trig; D0 <- Echo.
// Serial Monitor: 115200 baud. No extra libraries required.
#include <Arduino.h>

constexpr int TRIGGER_PIN = D1;
constexpr int ECHO_PIN = D0;

void setup() {
  Serial.begin(115200);
  pinMode(TRIGGER_PIN, OUTPUT);
  digitalWrite(TRIGGER_PIN, LOW);
  pinMode(ECHO_PIN, INPUT);
  delay(1000);
  Serial.println("US-100 PULSE TEST: rear jumper OFF; Trig=D1; Echo=D0");
}

void loop() {
  digitalWrite(TRIGGER_PIN, LOW);
  delayMicroseconds(5);
  digitalWrite(TRIGGER_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIGGER_PIN, LOW);

  const unsigned long echoUs = pulseIn(ECHO_PIN, HIGH, 60000UL);
  if (echoUs == 0) {
    Serial.println("NO ECHO: check 3V3/GND, Trig=D1, Echo=D0, jumper OFF and target.");
  } else {
    // US-100 hardware manual's compensated pulse conversion:
    // distance in meters = pulse duration in seconds * 165.7.
    // https://cdn-learn.adafruit.com/assets/assets/000/122/944/original/ultrasonic-sonar-module-us-100.pdf?1690232313=
    const float distanceMm = echoUs * 0.1657f;
    if (echoUs > 50000UL || distanceMm < 20 || distanceMm > 4500) {
      Serial.print("OUT OF RANGE; echo pulse = ");
      Serial.print(echoUs);
      Serial.println(" us");
    } else {
      Serial.print("Distance: ");
      Serial.print(distanceMm, 0);
      Serial.print(" mm | ");
      Serial.print(distanceMm / 10.0f, 1);
      Serial.println(" cm");
    }
  }
  delay(500);
}
