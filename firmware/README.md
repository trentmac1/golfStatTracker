# Firmware

PlatformIO project for the XIAO nRF52840 Sense + L76K tracker, on Seeed's non-mbed (Adafruit Bluefruit) core.

- `src/config.h`: pins, with where each one was checked
- `src/sensors.*`: IMU (LSM6DS3TR-C on Wire1, read by register), PDM mic, battery, L76K NMEA parser, boot-time pin check
- `src/link.*`: BLE service ([docs/ble-protocol.md](../docs/ble-protocol.md))
- `src/main.cpp`: LEDs, button, control ops, serial log

**Building:** the *Build tracker firmware* workflow runs on every push that touches `firmware/`. It compiles with PlatformIO, converts the hex to `golf-tracker.uf2` (Adafruit UF2 family 0xADA52840, app at 0x27000), and attaches it to the [`firmware` release](https://github.com/trentmac1/golfStatTracker/releases/tag/firmware). The build log is pushed to the `firmware-log` branch.

To build locally: `pip install platformio`, then `pio run -d firmware`. Flashing with `pio run -t upload` also works over USB.

Flashing and wiring: [docs/tracker-build.md](../docs/tracker-build.md).

Hardware facts not yet confirmed from a schematic: what D0 and D2 do on the GNSS board. Seeed's example holds both HIGH, and so does the firmware. The pin check reports any other pins the board drives. Using the L76K's standby mode for power saving (Phase 6) needs that pin confirmed.
