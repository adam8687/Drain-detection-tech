// One US-100 in UART mode, streamed over USB as one JSON line per reading.
// Pair with scripts/serial-bridge.mjs, which forwards readings to the backend.
// Wiring and jumper as in us100_serial_test; crossed Trig/Echo wires are detected.
#include <Arduino.h>

constexpr int SENSOR_TX_PIN = D1;  // ESP32 output -> US-100 Trig/TX input
constexpr int SENSOR_RX_PIN = D0;  // ESP32 input <- US-100 Echo/RX output
constexpr uint32_t RESPONSE_TIMEOUT_MS = 200;
constexpr uint32_t BETWEEN_READINGS_MS = 400;

HardwareSerial sensorSerial(1);
bool pinsSwapped = false;

int requestDistanceMm(int txPin, int rxPin) {
  pinMode(txPin, INPUT_PULLUP);
  pinMode(rxPin, INPUT_PULLUP);
  delay(10);
  sensorSerial.begin(9600, SERIAL_8N1, rxPin, txPin);
  delay(3);
  while (sensorSerial.available() > 0) sensorSerial.read();
  sensorSerial.write(uint8_t(0x55));
  const uint32_t started = millis();
  while (sensorSerial.available() < 2 &&
         uint32_t(millis() - started) < RESPONSE_TIMEOUT_MS) {
    delay(1);
  }
  int distanceMm = -1;
  if (sensorSerial.available() >= 2) {
    const uint8_t highByte = uint8_t(sensorSerial.read());
    const uint8_t lowByte = uint8_t(sensorSerial.read());
    distanceMm = (uint16_t(highByte) << 8) | lowByte;
  }
  sensorSerial.end();
  return distanceMm;
}

void setup() {
  Serial.begin(115200);
  delay(1000);
}

void loop() {
  int distanceMm = requestDistanceMm(pinsSwapped ? SENSOR_RX_PIN : SENSOR_TX_PIN,
                                     pinsSwapped ? SENSOR_TX_PIN : SENSOR_RX_PIN);
  if (distanceMm < 0) {
    pinsSwapped = !pinsSwapped;
    distanceMm = requestDistanceMm(pinsSwapped ? SENSOR_RX_PIN : SENSOR_TX_PIN,
                                   pinsSwapped ? SENSOR_TX_PIN : SENSOR_RX_PIN);
    if (distanceMm < 0) pinsSwapped = false;
  }

  if (distanceMm < 0) {
    Serial.println("{\"distance_mm\":null,\"status\":\"timeout\"}");
  } else if (distanceMm < 20 || distanceMm > 4500) {
    Serial.println("{\"distance_mm\":null,\"status\":\"out_of_range\"}");
  } else {
    Serial.print("{\"distance_mm\":");
    Serial.print(distanceMm);
    Serial.println(",\"status\":\"ok\"}");
  }
  delay(BETWEEN_READINGS_MS);
}
