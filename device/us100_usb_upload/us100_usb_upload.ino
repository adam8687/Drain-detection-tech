// Nano ESP32: request/response USB readings for the project's Mac uploader.
// Default: one US-100 in trigger/echo mode (rear jumper removed).
// A: 3V3 -> VCC, GND -> GND, D1 -> Trig, D0 <- Echo.
// Optional B: shared 3V3/GND, D3 -> Trig, D2 <- Echo.
#include <Arduino.h>

constexpr bool USE_UART = false;            // true requires rear jumper(s) ON
constexpr bool SECOND_SENSOR_ENABLED = false;
HardwareSerial uartA(1);
HardwareSerial uartB(2);
String command;

struct Reading {
  int distanceMm;
  const char* status;
};

Reading readSensor(int trigger, int echo, HardwareSerial& uart) {
  if (USE_UART) {
    while (uart.available()) uart.read();
    uart.write(uint8_t(0x55));
    const uint32_t start = millis();
    while (uart.available() < 2 && uint32_t(millis() - start) < 250) delay(1);
    if (uart.available() < 2) return {-1, "timeout"};
    const int high = uart.read();
    const int low = uart.read();
    const int mm = high * 256 + low;
    return mm >= 20 && mm <= 4500 ? Reading{mm, "ok"} : Reading{-1, "out_of_range"};
  }
  digitalWrite(trigger, LOW);
  delayMicroseconds(5);
  digitalWrite(trigger, HIGH);
  delayMicroseconds(10);
  digitalWrite(trigger, LOW);
  const unsigned long us = pulseIn(echo, HIGH, 60000UL);
  if (!us) return {-1, "timeout"};
  // US-100 manual's compensated pulse conversion, in millimeters.
  const int mm = int(us * 0.1657f + 0.5f);
  return us <= 50000UL && mm >= 20 && mm <= 4500
    ? Reading{mm, "ok"} : Reading{-1, "out_of_range"};
}

void printReading(const Reading& reading) {
  Serial.print("{\"distance_mm\":");
  if (reading.distanceMm < 0) Serial.print("null");
  else Serial.print(reading.distanceMm);
  Serial.print(",\"status\":\"");
  Serial.print(reading.status);
  Serial.print("\"}");
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

void setup() {
  Serial.begin(115200);
  if (USE_UART) {
    uartA.begin(9600, SERIAL_8N1, D0, D1);
    if (SECOND_SENSOR_ENABLED) uartB.begin(9600, SERIAL_8N1, D2, D3);
  } else {
    pinMode(D1, OUTPUT); digitalWrite(D1, LOW); pinMode(D0, INPUT);
    if (SECOND_SENSOR_ENABLED) {
      pinMode(D3, OUTPUT); digitalWrite(D3, LOW); pinMode(D2, INPUT);
    }
  }
  command.reserve(48);
}

void loop() {
  while (Serial.available()) {
    const char c = char(Serial.read());
    if (c == '\r') continue;
    if (c != '\n') {
      if (command.length() < 80) command += c;
      else command = "";
      continue;
    }
    if (command.startsWith("READ ") && validId(command.substring(5))) {
      const String id = command.substring(5);
      const Reading a = readSensor(D1, D0, uartA);
      Reading b = {-1, "timeout"};
      if (SECOND_SENSOR_ENABLED) {
        delay(70);  // Separate acoustic measurements; verify spacing physically.
        b = readSensor(D3, D2, uartB);
      }
      Serial.print("{\"reading_id\":\""); Serial.print(id);
      Serial.print("\",\"sensor_a\":"); printReading(a);
      Serial.print(",\"sensor_b\":"); printReading(b);
      Serial.println("}");
    }
    command = "";
  }
  delay(1);
}
