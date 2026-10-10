# BLE protocol and shot record (draft)

Draft from the build plan. Finalised in Phase 2, before the firmware and the app's sync code are written. The app's fake-tracker mode will implement this exactly.

## Shot record (24 bytes, little-endian)

| Offset | Field | Type | Notes |
|---|---|---|---|
| 0 | timestamp | uint32 | Unix seconds (GPS time or phone time sync) |
| 4 | lat | int32 | degrees × 1e7 |
| 8 | lon | int32 | degrees × 1e7 |
| 12 | hdop | uint16 | × 100 |
| 14 | sats | uint8 | |
| 15 | flags | uint8 | bit0 impact heard, bit1 label button, bit2 low battery |
| 16 | peak_gyro | uint16 | deg/s |
| 18 | downswing_ms | uint16 | transition to peak rotation |
| 20 | impact_amp | uint16 | peak of high-passed audio envelope |
| 22 | impact_offset_ms | int16 | impact time − peak-rotation time |
| 24 | confidence | uint8 | 0–255 |
| 25 | seq | uint16 | per record, for resumable sync |

Note: the plan's fields add up to 27 bytes, not 24. Phase 2 will either pad to 28 for alignment or trim fields; decide before writing firmware.

## GATT service (custom 128-bit UUIDs, to be assigned)

- **Status** (read, notify): battery %, GPS fix state, satellites, round active, record count, firmware version.
- **Control** (write): start round, end round, set time, sync from seq N, erase round, set detector thresholds.
- **Data** (notify): records in MTU-sized chunks, then an end-of-sync marker.
- **Ack** (write): last seq received, so an interrupted sync resumes.
