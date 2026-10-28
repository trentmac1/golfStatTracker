#pragma once
#include <Arduino.h>

// Phase 3 capture mode: while a session (round) is active, every swing
// candidate is saved to the flash log as a 2 s snippet of IMU data plus the
// microphone envelope, and each short button press is saved as a label.
// Record layouts: docs/ble-protocol.md, "Capture log".
namespace capture {
  typedef uint32_t (*Clock)();     // Unix seconds, 0 if unknown

  void begin(Clock unixNow);       // after store::begin and imu::begin
  void poll();                     // from loop(): finishes snippets, writes records

  void setSession(bool active);    // writes session start / end records
  // A press of the button (on release). Presses are decided PRESS_WAIT_MS
  // later: a press on its own is a label; two within DOUBLE_MS, with nothing
  // else around them, are one label marked as a double press (holed out);
  // anything busier is the button being pushed by the leg while walking
  // and is ignored (28 Oct round: about 1,300 presses at the step rhythm).
  void buttonPress(uint32_t ms);
  uint16_t ignoredPresses();       // since start-up
  const uint32_t PRESS_WAIT_MS = 2500, DOUBLE_MS = 700;

  bool enabled();
  void setEnabled(bool on);
  uint16_t trigger();              // deg/s that starts a candidate
  void setTrigger(uint16_t dps);
  // Round mode: keep a candidate only if the microphone heard an impact near
  // the peak rotation (envelope level, 0-65535, within IMPACT_FROM..IMPACT_TO
  // ms of it). 0 = off: keep every candidate (range mode).
  uint16_t soundGate();
  void setSoundGate(uint16_t level);
  uint16_t gatedOut();             // candidates dropped by the gate since start-up
  bool takeSettingsChanged();      // true once after trigger, gate or enabled changes
  const int16_t IMPACT_FROM = -400, IMPACT_TO = 250;
  const uint16_t ROUND_GATE = 1000, ROUND_TRIGGER = 250;
  const float BUILDUP_MIN = 110;   // deg/s, mean rotation over the 0.3 s before the peak (round mode)
  const float STILL_MAX = 70;      // deg/s, mean rotation 1.5-1.0 s before the peak (round mode: still at address)
  // Round mode: a candidate that isn't saved leaves a small reject record
  // (features and the rules it failed), so missed shots can be traced.
  enum RejectReason : uint8_t { R_NO_IMPACT = 1, R_NO_BUILDUP = 2, R_MOVING = 4 };
  uint16_t rejects();              // reject records written since start-up
  bool full();                     // log has no room for another snippet
  uint32_t lastSavedMs();          // millis() of the last snippet written, 0 if none

  // Window around the peak rotation.
  const uint16_t PRE = 312, POST = 104, COUNT = PRE + POST;   // 1.5 s + 0.5 s at 208 Hz
  const uint16_t ENV_COUNT = 2000;                             // about 2 s
  const int16_t ENV_START_MS = -1500;
  const uint16_t LOW_COUNT = 500;                              // low band, about 2 s at 250 Hz
}
