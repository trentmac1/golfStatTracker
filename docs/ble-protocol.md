# BLE protocol (version 1)

The tracker and the web app both follow this file. In the app, only `webapp/js/transport.js` speaks it; in the firmware, `firmware/src/link.h` / `link.cpp`. All multi-byte values are little-endian.

## Service

Advertised name "Golf Tracker" (in the scan response). The advert carries the service UUID, so the app filters on it.

Base UUID `7a1e0000-3c5b-4f0e-9a52-6b8d2f4c1e90`; the third and fourth hex digits pick the item.

| UUID | Name | Access | Since |
|---|---|---|---|
| `7a1e0001-…` | Service | | Phase 2 |
| `7a1e0002-…` | Status | read, notify (1 Hz) | Phase 2 |
| `7a1e0003-…` | Control | write | Phase 2 |
| `7a1e0004-…` | Data | notify | Phase 3/5 |
| `7a1e0005-…` | Ack | write | Phase 5 |
| `7a1e0006-…` | Live | read, notify (1 Hz) | Phase 2 |

The standard Device Information service (0x180A) also reports the firmware version.

## Status (20 bytes)

Fits in one default-MTU notification.

| Offset | Field | Type | Notes |
|---|---|---|---|
| 0 | proto | uint8 | protocol version, 1 |
| 1 | battery_pct | uint8 | 0–100, from resting LiPo voltage |
| 2 | battery_mv | uint16 | |
| 4 | flags | uint8 | bit0 charging, bit1 round active, bit2 GPS sending data, bit3 GPS fix, bit4 IMU ok, bit5 mic ok, bit6 clock set, bit7 button held down |
| 5 | fix_quality | uint8 | NMEA GGA quality: 0 none, 1 GPS, 2 DGPS |
| 6 | sats | uint8 | satellites used |
| 7 | button_presses | uint8 | short presses since power-on, wraps at 256 |
| 8 | hdop | uint16 | × 100; 0xFFFF unknown |
| 10 | record_count | uint16 | shot records stored (0 until Phase 5) |
| 12 | fw_major, fw_minor, fw_patch | uint8 × 3 | |
| 15 | mic_level | uint8 | peak microphone level over the last second, 0–255 |
| 16 | gyro_peak | uint16 | peak rotation over the last second, deg/s |
| 18 | busy_pins | uint16 | bit n set: XIAO pin Dn is driven by something (boot-time pin check of D1, D3, D4, D5, D8, D9, D10) |

## Live (16 bytes)

| Offset | Field | Type | Notes |
|---|---|---|---|
| 0 | time | uint32 | Unix seconds (GPS time, or the time the app set); 0 unknown |
| 4 | lat | int32 | degrees × 1e7; 0 with lon 0 = no fix |
| 8 | lon | int32 | degrees × 1e7 |
| 12 | altitude | int16 | decimetres |
| 14 | speed | uint16 | cm/s |

## Control (write, first byte is the op)

| Op | Name | Payload | |
|---|---|---|---|
| 0x01 | start round | – | Phase 2 (flag only; recording comes later) |
| 0x02 | end round | – | Phase 2 |
| 0x03 | set time | uint32 Unix seconds | Phase 2; the app sends it on every connect. GPS time wins once known |
| 0x04 | identify | – | Phase 2; LEDs blink white for 3 s |
| 0x10 | sync from seq | uint16 seq | Phase 5 |
| 0x11 | erase round | – | Phase 5 |
| 0x20 | set detector thresholds | TBD | Phase 5 |

Unknown ops are ignored, so an older tracker doesn't break a newer app.

## Shot record (28 bytes) — Phase 5

The plan's fields total 27 bytes, so one reserved byte pads the record to 28 and keeps `seq` 2-byte aligned. Records are sent in Data notifications, as many whole records as fit the MTU, then an end-of-sync marker (a notification of a single 0xFF byte).

| Offset | Field | Type | Notes |
|---|---|---|---|
| 0 | timestamp | uint32 | Unix seconds |
| 4 | lat | int32 | degrees × 1e7 (median of stationary fixes before the swing) |
| 8 | lon | int32 | degrees × 1e7 |
| 12 | hdop | uint16 | × 100 |
| 14 | sats | uint8 | |
| 15 | flags | uint8 | bit0 impact heard, bit1 label button, bit2 low battery |
| 16 | peak_gyro | uint16 | deg/s |
| 18 | downswing_ms | uint16 | transition to peak rotation |
| 20 | impact_amp | uint16 | peak of the high-passed audio envelope |
| 22 | impact_offset_ms | int16 | impact time − peak-rotation time |
| 24 | confidence | uint8 | 0–255 |
| 25 | reserved | uint8 | 0 |
| 26 | seq | uint16 | per record, for resumable sync |

Ack (write): uint16, the last seq the app has stored. A sync after a dropped connection starts from there.
