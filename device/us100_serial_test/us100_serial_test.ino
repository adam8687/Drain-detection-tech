// One US-100 in UART mode, connected to an Arduino Nano ESP32.
// Install the sensor's rear mode jumper BEFORE applying power.
// ESP32 3V3 -> VCC; GND -> GND; D1/TX -> Trig/TX; D0/RX <- Echo/RX.
// Open the computer's Serial Monitor at 115200 baud.
// US-100 protocol: https://learn.adafruit.com/ultrasonic-sonar-distance-sensors?view=all

#include <Arduino.h>

constexpr int SENSOR_TX_PIN = D1;  // ESP32 output -> US-100 Trig/TX input
constexpr int SENSOR_RX_PIN = D0;  // ESP32 input <- US-100 Echo/RX output
constexpr uint32_t RESPONSE_TIMEOUT_MS = 200;
constexpr uint32_t BETWEEN_READINGS_MS = 400;

HardwareSerial sensorSerial(1);  // Keep USB/programming Serial separate.
bool pinsSwapped = false;

// Open the UART fresh for each request; a continuously held port can stop
// receiving on some boards. Returns the distance, or -1 on timeout.
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
  Serial.println("US-100 UART distance test (one sensor)");
  Serial.println("Jumper ON; VCC=3V3; Trig/TX=D1/TX; Echo/RX=D0/RX");
}

void loop() {
  int distanceMm = requestDistanceMm(pinsSwapped ? SENSOR_RX_PIN : SENSOR_TX_PIN,
                                     pinsSwapped ? SENSOR_TX_PIN : SENSOR_RX_PIN);
  if (distanceMm < 0) {
    // No answer: also try the opposite orientation in case Trig/TX and
    // Echo/RX are crossed, and say so rather than failing silently.
    pinsSwapped = !pinsSwapped;
    distanceMm = requestDistanceMm(pinsSwapped ? SENSOR_RX_PIN : SENSOR_TX_PIN,
                                   pinsSwapped ? SENSOR_TX_PIN : SENSOR_RX_PIN);
    if (distanceMm < 0) {
      pinsSwapped = false;
      Serial.println("TIMEOUT: check power, common ground, pins and mode jumper.");
      delay(BETWEEN_READINGS_MS);
      return;
    }
  }

  if (pinsSwapped) Serial.print("WIRES CROSSED (swap Trig/TX and Echo/RX) | ");
  if (distanceMm < 20 || distanceMm > 4500) {
    Serial.print("OUT OF RANGE: returned value = ");
    Serial.print(distanceMm);
    Serial.println(" mm (expected 20-4500)");
  } else {
    Serial.print("Distance: ");
    Serial.print(distanceMm);
    Serial.print(" mm  |  ");
    Serial.print(distanceMm / 10.0f, 1);
    Serial.println(" cm");
  }
  delay(BETWEEN_READINGS_MS);
}
