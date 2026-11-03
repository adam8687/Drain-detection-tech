# Quick trigger/echo test

Use this sketch if the US-100's rear mode-select pins have **no jumper**.
It is an alternative to the UART sketch, using the same signal connections.

1. Unplug USB; leave/remove the rear mode jumper so the pins are uncovered.
2. Confirm sensor VCC goes to Nano **3V3**, GND to **GND**, Trig to **D1**,
   and Echo to **D0**. Use the printed pin labels to check each connection.
3. Connect USB and open `us100_pulse_test.ino` in Arduino IDE.
4. Select **Arduino Nano ESP32** and its port, then Upload.
5. Open Serial Monitor at **115200 baud**. Startup should say **US-100 PULSE TEST**.
6. Point the sensor at a flat book about 30 cm away.

The sketch sends a 10-microsecond trigger pulse and measures the echo pulse.
It uses the compensated pulse conversion in the
[US-100 hardware manual](https://cdn-learn.adafruit.com/assets/assets/000/122/944/original/ultrasonic-sonar-module-us-100.pdf?1690232313=).
The [Adafruit guide](https://learn.adafruit.com/ultrasonic-sonar-distance-sensors?view=all)
documents jumper removed = trigger/echo, jumper installed = UART.

This is a one-sensor USB bench test, with no Wi-Fi or Supabase connection.
The initial user-run test printed `NO ECHO`; valid physical measurements
have not yet been verified. If both modes fail, check wiring and sensor power.
