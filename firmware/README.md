# Firmware

PlatformIO project for the XIAO nRF52840 Sense + L76K tracker, on Seeed's non-mbed (Adafruit Bluefruit) core.

- `src/config.h`: pins, with where each one was checked
- `src/sensors.*`: IMU (LSM6DS3TR-C on Wire1, read by register), PDM mic, battery, L76K NMEA parser, boot-time pin check
- `src/link.*`: BLE service ([docs/ble-protocol.md](../docs/ble-protocol.md))
- `src/store.*`: append-only capture log on the 2 MB QSPI flash (Adafruit SPIFlash, raw access)
- `src/capture.*`: Phase 3 capture mode: swing trigger, 2 s snippets (IMU FIFO + microphone envelope), button labels
- `src/main.cpp`: LEDs, button, control ops, log sync, serial log
- `test/host/`: the log and capture code compiled for the PC against a simulated flash and sensors (`sh test/host/run.sh`; also run by the build workflow)

**Building:** the *Build tracker firmware* workflow runs on every push that touches `firmware/`. It compiles with PlatformIO, converts the hex to `golf-tracker.uf2` (Adafruit UF2 family 0xADA52840, app at 0x27000), and attaches it to the [`firmware` release](https://github.com/trentmac1/golfStatTracker/releases/tag/firmware). The build log is pushed to the `firmware-log` branch.

To build locally: `pip install platformio`, then `pio run -d firmware`. Flashing with `pio run -t upload` also works over USB.

Flashing and wiring: [docs/tracker-build.md](../docs/tracker-build.md).

Hardware facts not yet confirmed from a schematic: what D0 and D2 do on the GNSS board. Seeed's example holds both HIGH, and so does the firmware. The pin check reports any other pins the board drives. Using the L76K's standby mode for power saving (Phase 6) needs that pin confirmed.
