#pragma once
#include <Arduino.h>

// Short-game capture (firmware 0.6.0). Chips and putts don't reach the swing
// trigger, so nothing about them was kept. While a session (round) is on,
// every second of motion and sound is now kept, in one of two forms:
//
// - Track (kind 8), in every round: a 12-byte summary of each second (how
//   much the tracker turned and shook, which way up it was, how loud it
//   was), 8 seconds to a record with the position. About 240 KB for a
//   4-hour round. With the putts entered in the app it shows what a green
//   looks like to the tracker.
// - Recording (kind 7), for practice sessions (control op 0x08): the IMU
//   itself at a quarter rate (about 52 Hz) with the sound levels 50 times a
//   second, a record every second. About 45 minutes fills the 2 MB log.
//   Button presses label the strokes: one press after a putt, a double
//   press after a chip.
//
// Record layouts: docs/ble-protocol.md, "Capture log".
namespace motion {
  void onSample(const int16_t raw[6], uint32_t idx);   // every IMU sample, in order
  void poll();                       // from loop(): writes finished seconds
  void sessionChanged(bool active);  // from capture::setSession (before the session-end record)
  void setRecording(bool on);        // takes effect while a session is on; ends with it
  bool recording();
  uint16_t blocks();                 // recording records written since start-up
  uint16_t tracks();                 // track records written since start-up

  const uint8_t DECIM = 4;           // IMU samples averaged into one recorded sample
  const uint8_t BLOCK = 52;          // recorded samples per record (208 IMU samples, about 1 s)
  const uint8_t BINS = 50;           // sound levels per record
  const uint8_t TRACK_ENTRIES = 8, ENTRY = 12;
  const uint32_t STREAM_BODY = 20 + 12 + BLOCK * 12 + 2 * BINS;      // 756
  const uint32_t TRACK_BODY = 20 + 8 + TRACK_ENTRIES * ENTRY;         // 124
  const uint32_t TRACK_RESERVE = 65536;  // the track stops here, leaving the last of the log to swings
}
