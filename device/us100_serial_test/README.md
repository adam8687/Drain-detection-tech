# US-100 USB distance test

Open `us100_serial_test.ino` in Arduino IDE and upload it to an Arduino Nano ESP32.
No additional sensor library,
Wi-Fi, backend, or Supabase configuration is needed.

## Wire one sensor

Disconnect USB power while wiring. Install the jumper across the US-100's
rear mode-select pins to select UART mode before powering it up.

| ESP32 pin | US-100 pin |
| --- | --- |
| 3V3 | VCC |
| GND | GND (one of the module's ground pins) |
| D1/TX (ESP32 transmit) | Trig/TX (sensor command input) |
| D0/RX (ESP32 receive) | Echo/RX (sensor response output) |

Use the printed GPIO and sensor pin labels, not a left-to-right guess.
The US-100's Trig/TX and Echo/RX labels are unusual: follow this table rather
than the usual TX-to-RX naming rule. Power the sensor from 3V3 for this test.
The sketch uses the named D1/D0 pins for the Nano ESP32. Check all connections
against the table before powering the circuit.

## Run

1. Connect the ESP32 to the computer with a USB data cable.
2. In Arduino IDE's Boards Manager, install **Arduino ESP32 Boards** by Arduino
   if it is not already installed.
3. Select **Arduino Nano ESP32**, and select its USB serial port under **Tools > Port**.
4. Open this folder's `.ino` file and click **Upload**. If the IDE waits
   for the board, double-press RESET, select the newly appearing port and upload again.
5. Open **Serial Monitor** and select **115200 baud**. Press EN/RESET if you
   want to see the startup messages again.
6. Point the sensor straight at a flat book or wall, initially around
   20-50 cm away. Move it and compare against a ruler.

Example output (illustrative, not a hardware test result):

```text
Distance: 313 mm  |  31.3 cm
Distance: 314 mm  |  31.4 cm
```

The sensor link uses **9600 baud**; the computer's Serial Monitor uses
**115200 baud**. They are separate connections. The sketch requests a
measurement with binary command `0x55`, waits up to 500 ms for two bytes,
and decodes `high_byte * 256 + low_byte` millimeters. It pauses 500 ms after
each attempt. Timeout and out-of-range readings are printed as errors.
This basic protocol has no checksum, so an in-range reading is not proof
of physical accuracy. Test one module at a time with this sketch.

## Sources and verification

- [US-100 hardware manual hosted by Adafruit](https://cdn-learn.adafruit.com/assets/assets/000/122/944/original/ultrasonic-sonar-module-us-100.pdf?1690232313=)
  describes the hardware and trigger/echo mode; it does not specify the UART protocol.
- [Adafruit US-100 guide](https://learn.adafruit.com/ultrasonic-sonar-distance-sensors?view=all)
  supplies the UART mode, wiring, baud rate and measurement command.
- [Espressif Arduino UART API](https://docs.espressif.com/projects/arduino-esp32/en/latest/api/serial.html)
  documents HardwareSerial and explicit RX/TX pin configuration.

The Amazon listing advertises UART support but omits protocol details.
The sketch follows the standard US-100 protocol documented above; the
purchased module still needs a physical check. The initial user-run test
printed timeouts; valid physical measurements have not yet been verified.
