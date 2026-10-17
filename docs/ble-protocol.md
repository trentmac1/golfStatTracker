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
| `7a1e0004-…` | Data | notify | Phase 3 |
| `7a1e0005-…` | Ack | write | Phase 3 |
| `7a1e0006-…` | Live | read, notify (1 Hz) | Phase 2 |
| `7a1e0007-…` | Capture | read, notify (1 Hz) | Phase 3 |

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
| 10 | record_count | uint16 | Phase 3: swing snippets in the capture log; Phase 5: shot records |
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
| 0x05 | set capture | uint8, 0 off / 1 on | Phase 3; on by default |
| 0x10 | sync from seq | uint16 seq | Phase 3; streams the capture log from that seq (see Sync) |
| 0x11 | erase log | uint32 log_id | Phase 3; only if log_id matches the tracker's current log |
| 0x12 | stop sync | – | Phase 3 |
| 0x20 | set trigger | uint16 deg/s | Phase 3; gyro magnitude that starts a swing candidate, 30–2000, default 150. Phase 5 may add fields |
| 0x21 | set sound gate | uint16 level | Firmware 0.3.0; 0 off (range mode). Otherwise (round mode, 1000) a candidate is saved only if the envelope (0–65535) reaches this level within −400…+250 ms of the peak rotation, the mean rotation over the 0.3 s before the peak is at least 110 deg/s (firmware 0.3.1; rules out knocks), and no button press came within 0.6 s of the peak (0.3.1; rules out the jolt of reaching for the button) |

Trigger, sound gate and capture on/off are kept on the tracker's internal flash across restarts (firmware 0.3.0).

Unknown ops are ignored, so an older tracker doesn't break a newer app.

## Capture (24 bytes; 20 before firmware 0.3.0) — Phase 3

| Offset | Field | Type | Notes |
|---|---|---|---|
| 0 | version | uint8 | 1 |
| 1 | flags | uint8 | bit0 capture enabled, bit1 session (round) active, bit2 log full, bit3 syncing, bit4 flash ok |
| 2 | trigger | uint16 | deg/s |
| 4 | log_id | uint32 | changes every time the log is erased |
| 8 | next_seq | uint16 | seq the next record will get |
| 10 | swings | uint16 | swing snippets in the log |
| 12 | labels | uint16 | button labels in the log |
| 14 | used_kb | uint16 | |
| 16 | total_kb | uint16 | 2048 |
| 18 | imu_overruns | uint16 | times the IMU FIFO filled before it was read (should stay 0) |
| 20 | sound_gate | uint16 | 0 off; firmware 0.3.0 |
| 22 | gated_out | uint16 | candidates dropped by the sound gate since start-up |

## Capture log — Phase 3

While a round (session) is active and capture is on, the tracker appends records to the 2 MB QSPI flash. Nothing is overwritten: when it's full, swings stop being saved until the app erases the log. About 290 swings fit.

Every record starts with an 8-byte header and is a whole number of 4-byte words long (padding is 0xFF):

| Offset | Field | Type | Notes |
|---|---|---|---|
| 0 | kind | uint8 | 1 log start, 2 session start, 3 session end, 4 swing, 5 label (0xFE filler, never sent) |
| 1 | version | uint8 | 1 |
| 2 | len | uint16 | whole record, header included |
| 4 | seq | uint16 | 0 for log start, then +1 per record |
| 6 | crc | uint16 | CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) of bytes 8 to len |

**Log start** (kind 1, 20 bytes): log_id uint32, created uint32 (Unix seconds, 0 unknown), firmware major, minor, patch, protocol (uint8 × 4).

**Context** (20 bytes), first in every other record:

| Offset | Field | Type | Notes |
|---|---|---|---|
| 0 | time | uint32 | Unix seconds, 0 unknown |
| 4 | device_ms | uint32 | tracker millis() |
| 8 | lat, lon | int32 × 2 | degrees × 1e7, latest fix; 0 without a fix |
| 16 | hdop | uint16 | × 100, 0xFFFF unknown |
| 18 | sats | uint8 | |
| 19 | flags | uint8 | bit0 GPS fix, bit1 GPS time known, bit2 battery under 15%, bit3 session active |

**Session start / end** (kinds 2, 3; 32 bytes): context, trigger uint16, sound_gate uint16 (0 before firmware 0.3.0).

**Label** (kind 5, 32 bytes), one per short button press during a session: context (time of the press), ref_seq uint16 (the swing saved before the press, if its peak was at most 20 s earlier; 0xFFFF none), gap_ms uint16 (that swing's peak to the press; 0xFFFF none). A label with no ref is a shot the trigger missed.

**Swing** (kind 4, 7040 bytes): a candidate is any rotation whose gyro magnitude reaches the trigger; the window is centred on its peak (the highest rotation up to 0.5 s after it).

| Offset (after header) | Field | Type | Notes |
|---|---|---|---|
| 0 | context | 20 bytes | time and device_ms of the peak |
| 20 | peak_gyro | uint16 | deg/s |
| 22 | trigger | uint16 | deg/s at the time |
| 24 | imu_count | uint16 | 416 |
| 26 | imu_peak_index | uint16 | 312 (1.5 s before, 0.5 s after) |
| 28 | imu_rate | uint16 | measured, Hz × 100 (nominal 20800) |
| 30 | env_count | uint16 | 2000 |
| 32 | env_start_ms | int16 | time of the first envelope value relative to the peak (about −1500) |
| 34 | env_rate | uint16 | measured, Hz × 10 (about 10000) |
| 36 | flags | uint8 | bit0 IMU FIFO overrun in the window, bit1 some audio missing (zeros), bit2 some IMU samples missing (zeros) |
| 37 | impact | uint8 | √ of the loudest envelope value within −400…+250 ms of the peak (firmware 0.3.0; 0 before) |
| 38 | audio_peak | uint16 | highest envelope value in the window, before companding |
| 40 | imu | int16 × 6 × imu_count | gx, gy, gz (× 0.070 deg/s), ax, ay, az (× 0.000488 g), in sensor axes |
| 5032 | envelope | uint8 × env_count | √ of the high-passed (about 2 kHz) peak level per 16 microphone samples; square it to get back to 0–65535 |

## Sync — Phase 3

1. The app reads Capture. If log_id isn't the one it last synced, it starts from seq 0; otherwise from the seq after the last one it stored.
2. It writes **sync from seq** and listens on Data. Each notification is `seq uint16, offset uint16`, then up to MTU − 7 bytes of the record (a multiple of 4), starting at that offset. Records arrive whole and in order; filler records are skipped.
3. A notification of the single byte 0xFF ends the sync. Records added during a sync come in the next one.
4. The app checks each record's CRC, stores it, and may write the last stored seq to Ack (informational for now). A dropped connection simply means syncing again from the last stored seq.
5. After the data is safely exported, **erase log** with the current log_id starts a new, empty log.

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
