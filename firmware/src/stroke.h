#pragma once
#include <stdint.h>

// Chip and putt candidates (firmware 0.7.0). Found from the 26 Nov practice
// recording (26 putts, 12 chips): from the pocket a stroke is a stand-still,
// then one smooth turn of the hips about the vertical towards the target
// (putts 20-56 deg/s at the peak, about 10-25 degrees; chips 46-95 deg/s,
// 18-38 degrees), lasting 0.3-1.2 s. Chips also make a strike sound.
//
// This module works on the IMU at a quarter rate (the mean of 4 samples,
// about 52 Hz), as in the recording, and writes a candidate for every turn
// that could be a stroke. The app decides which ones are strokes (thresholds
// and the green), so it can be retuned without a reflash. About 9 a minute
// while moving about; under 100 KB for a round.
//
// Pure C++ with no Arduino calls, so the host tests can feed it recorded data.
namespace stroke {
  struct Candidate {
    float tMs;          // time of the peak (device ms)
    float peak;         // deg/s, smoothed turn about the vertical (positive: towards a right-hander's target)
    float area;         // degrees turned while over half the peak
    float durMs;        // time over half the peak
    float pre, post;    // median |gyro| deg/s in the 1.2 s before the turn and after it (stillness)
    float other;        // deg/s rms of rotation not about the vertical during the turn
    float neg;          // deg/s, biggest turn the other way within 0.6 s
    uint8_t high, low;  // √ of the loudest sound in each band during the turn (±0.1 s)
    int8_t grav[3];     // which way up the tracker was (g × 100)
  };
  typedef void (*Output)(const Candidate&);

  // Written only if peak ≥ MIN_PEAK, area ≥ MIN_AREA, pre ≤ MAX_PRE and the
  // duration is in range; the app's own thresholds are tighter.
  const float MIN_PEAK = 12, MIN_AREA = 5, MAX_PRE = 15, MIN_DUR_MS = 200, MAX_DUR_MS = 1500;

  void reset(float hz);   // start again (a new session); hz: the rate of the samples fed in
  void setOutput(Output o);
  // One sample: raw counts gx gy gz ax ay az (the mean of 4 IMU samples), √
  // of the loudest high and low band sound during it, and its time.
  void feed(const int16_t s[6], uint8_t high, uint8_t low, float tMs);
  uint32_t candidates();  // written since reset
}
