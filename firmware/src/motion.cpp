#include "motion.h"
#include "capture.h"
#include "sensors.h"
#include "store.h"

namespace {
  const uint16_t SPAN = motion::DECIM * motion::BLOCK;   // IMU samples per second-long block (208)

  bool active = false;       // a session is on
  bool wantRecording = false, isRecording = false;
  uint16_t nBlocks = 0, nTracks = 0;

  // The second being filled, and the one waiting for its sound.
  struct Second {
    int16_t imu[motion::BLOCK][6];
    uint32_t firstIdx = 0;
    uint32_t overruns = 0;
    bool overrun = false;
    float peak = 0, sumMag = 0;          // gyro, deg/s
    float sumG[3] = {0, 0, 0};           // gyro, deg/s
    float sumA[3] = {0, 0, 0};           // accel, g
    float sumAm = 0, sumAm2 = 0;         // |accel|, g
    uint8_t jolts = 0;
  };
  Second bufA, bufB;
  Second* cur = &bufA;
  Second* pend = nullptr;
  uint32_t pendAt = 0;
  uint16_t filled = 0;                   // IMU samples in `cur`
  int32_t dsum[6];
  bool joltHigh = false;
  uint16_t dropped = 0;

  // Track record being built.
  uint8_t trackBody[motion::TRACK_BODY] __attribute__((aligned(4)));
  uint8_t trackN = 0;
  uint8_t streamBody[motion::STREAM_BODY] __attribute__((aligned(4)));

  void put16(uint8_t* p, uint16_t v) { p[0] = v; p[1] = v >> 8; }
  void put32(uint8_t* p, uint32_t v) { p[0] = v; p[1] = v >> 8; p[2] = v >> 16; p[3] = v >> 24; }
  uint8_t sq8(uint16_t v) {              // floor(sqrt(v)), as the swing envelope is stored
    uint32_t r = (uint32_t)sqrtf((float)v);
    while (r * r > v) r--;
    while ((r + 1) * (r + 1) <= v) r++;
    return r > 255 ? 255 : (uint8_t)r;
  }
  int8_t clamp8(float v) { long r = lroundf(v); return r < -127 ? -127 : r > 127 ? 127 : (int8_t)r; }
  uint8_t clampU8(float v) { long r = lroundf(v); return r < 0 ? 0 : r > 255 ? 255 : (uint8_t)r; }
  uint16_t clampU16(float v) { long r = lroundf(v); return r < 0 ? 0 : r > 65535 ? 65535 : (uint16_t)r; }

  void startSecond(uint32_t idx) {
    cur->firstIdx = idx; cur->overruns = imu::overruns(); cur->overrun = false;
    cur->peak = cur->sumMag = cur->sumAm = cur->sumAm2 = 0;
    for (uint8_t k = 0; k < 3; k++) cur->sumG[k] = cur->sumA[k] = 0;
    cur->jolts = 0;
    filled = 0;
    for (uint8_t k = 0; k < 6; k++) dsum[k] = 0;
  }

  void flushTrack() {
    if (!trackN) return;
    trackBody[22] = trackN;
    for (uint32_t i = 28 + trackN * motion::ENTRY; i < motion::TRACK_BODY; i++) trackBody[i] = 0;
    if (store::hasRoom(motion::TRACK_RESERVE) && store::append(store::K_TRACK, trackBody, motion::TRACK_BODY) && nTracks < 65535) nTracks++;
    trackN = 0;
  }

  // Sound levels of the second that started at startMs and lasted durMs:
  // BINS peaks of the high band and of the low band (sqrt-companded).
  // Returns false if some of it had already left the microphone's ring.
  bool sound(float startMs, float durMs, uint8_t* high, uint8_t* low) {
    float rate = mic::envRateHz();
    uint32_t envN = mic::envCount(), envMs = mic::envLastMs(), lowN = mic::lowCount();
    bool whole = mic::ok() && envN > 0;
    auto at = [&](float t) { return (int32_t)envN - 1 - (int32_t)lroundf(((float)envMs - t) * rate / 1000.0f); };
    for (uint8_t j = 0; j < motion::BINS; j++) {
      int32_t a = at(startMs + durMs * j / motion::BINS), b = at(startMs + durMs * (j + 1) / motion::BINS);
      if (b <= a) b = a + 1;
      uint16_t hi = 0, lo = 0;
      for (int32_t i = a; i < b; i++) {
        if (i < 0 || (uint32_t)i >= envN || envN - (uint32_t)i > mic::ENV_RING) { whole = false; continue; }
        uint16_t v = mic::envAt(i);
        if (v > hi) hi = v;
      }
      for (int32_t k = a / 4; k <= (b - 1) / 4; k++) {
        if (k < 0 || (uint32_t)k >= lowN || lowN - (uint32_t)k > mic::LOW_RING) continue;
        uint16_t v = mic::lowAt(k);
        if (v > lo) lo = v;
      }
      high[j] = sq8(hi); low[j] = sq8(lo);
    }
    return whole;
  }

  void finishSecond(Second& s) {
    float rate = imu::rateHz();
    float startMs = imu::sampleMs(s.firstIdx), durMs = SPAN * 1000.0f / rate;
    uint8_t high[motion::BINS], low[motion::BINS];
    bool whole = sound(startMs, durMs, high, low);

    if (isRecording) {
      if (!store::hasRoom(motion::STREAM_BODY)) { isRecording = wantRecording = false; return; }
      capture::writeContext(streamBody, (uint32_t)startMs);
      uint8_t* x = streamBody + 20;
      put32(x, s.firstIdx);
      put16(x + 4, clampU16(rate * 100));
      x[6] = motion::DECIM; x[7] = motion::BLOCK; x[8] = motion::BINS;
      x[9] = (s.overrun ? 1 : 0) | (whole ? 0 : 2);
      put16(x + 10, dropped);
      memcpy(x + 12, s.imu, motion::BLOCK * 12);
      memcpy(x + 12 + motion::BLOCK * 12, high, motion::BINS);
      memcpy(x + 12 + motion::BLOCK * 12 + motion::BINS, low, motion::BINS);
      if (store::append(store::K_STREAM, streamBody, motion::STREAM_BODY) && nBlocks < 65535) nBlocks++;
      return;
    }

    // Track: one 12-byte entry for the second.
    if (!trackN) {
      capture::writeContext(trackBody, (uint32_t)startMs);
      put16(trackBody + 20, gnss::fix().quality > 0 ? gnss::fix().speed_cms : 0xFFFF);
      trackBody[23] = motion::ENTRY;
      put16(trackBody + 24, clampU16(durMs));
      put16(trackBody + 26, 0);
    }
    uint8_t* e = trackBody + 28 + trackN * motion::ENTRY;
    float n = SPAN;
    float meanAm = s.sumAm / n, var = s.sumAm2 / n - meanAm * meanAm;
    float g[3] = { s.sumA[0] / n, s.sumA[1] / n, s.sumA[2] / n };
    float gl = sqrtf(g[0] * g[0] + g[1] * g[1] + g[2] * g[2]);
    // Degrees turned about the vertical over the second (gravity from the
    // second's own mean acceleration), as turnAt() in capture.cpp.
    float turn = gl > 0.3f ? (s.sumG[0] * g[0] + s.sumG[1] * g[1] + s.sumG[2] * g[2]) / gl / rate : 0;
    uint8_t hi = 0, lo = 0;
    for (uint8_t j = 0; j < motion::BINS; j++) { if (high[j] > hi) hi = high[j]; if (low[j] > lo) lo = low[j]; }
    put16(e, clampU16(s.peak));
    put16(e + 2, clampU16(s.sumMag / n * 4));
    e[4] = clampU8(sqrtf(var > 0 ? var : 0) * 100);
    e[5] = s.jolts;
    e[6] = (uint8_t)clamp8(g[0] * 100); e[7] = (uint8_t)clamp8(g[1] * 100); e[8] = (uint8_t)clamp8(g[2] * 100);
    e[9] = (uint8_t)clamp8(turn);
    e[10] = hi; e[11] = lo;
    if (++trackN == motion::TRACK_ENTRIES) flushTrack();
  }
}

void motion::onSample(const int16_t raw[6], uint32_t idx) {
  if (!active || !capture::enabled()) { filled = 0; return; }
  if (!filled) startSecond(idx);
  Second& s = *cur;
  float gx = raw[0] * imu::GYRO_DPS_PER_LSB, gy = raw[1] * imu::GYRO_DPS_PER_LSB, gz = raw[2] * imu::GYRO_DPS_PER_LSB;
  float ax = raw[3] * imu::ACC_G_PER_LSB, ay = raw[4] * imu::ACC_G_PER_LSB, az = raw[5] * imu::ACC_G_PER_LSB;
  float gm = sqrtf(gx * gx + gy * gy + gz * gz), am = sqrtf(ax * ax + ay * ay + az * az);
  if (gm > s.peak) s.peak = gm;
  s.sumMag += gm;
  s.sumG[0] += gx; s.sumG[1] += gy; s.sumG[2] += gz;
  s.sumA[0] += ax; s.sumA[1] += ay; s.sumA[2] += az;
  s.sumAm += am; s.sumAm2 += am * am;
  // Jolts: times the acceleration left 1 g by more than 0.25 g (a step's
  // heel strike; a stroke played standing still has none).
  bool high = fabsf(am - 1.0f) > 0.25f;
  if (high && !joltHigh && s.jolts < 255) s.jolts++;
  joltHigh = high;

  for (uint8_t k = 0; k < 6; k++) dsum[k] += raw[k];
  filled++;
  if (filled % DECIM == 0) {
    int16_t* out = s.imu[filled / DECIM - 1];
    for (uint8_t k = 0; k < 6; k++) { out[k] = (int16_t)(dsum[k] / DECIM); dsum[k] = 0; }
  }
  if (filled == SPAN) {
    s.overrun = imu::overruns() != s.overruns;
    if (pend) { if (dropped < 65535) dropped++; }     // the last second never got written: it's lost
    pend = cur; pendAt = millis();
    cur = (cur == &bufA) ? &bufB : &bufA;
    filled = 0;
  }
}

void motion::poll() {
  if (!pend) return;
  float endMs = imu::sampleMs(pend->firstIdx + SPAN);
  bool ready = !mic::ok() || (float)mic::envLastMs() >= endMs || millis() - pendAt > 400;
  if (!ready) return;
  Second* s = pend;
  pend = nullptr;
  finishSecond(*s);
}

void motion::sessionChanged(bool on) {
  if (on == active) return;
  if (!on) {                 // the second in progress is dropped; what's finished is written
    if (pend) { Second* s = pend; pend = nullptr; finishSecond(*s); }
    flushTrack();
    isRecording = wantRecording = false;
  } else {
    isRecording = wantRecording;
    trackN = 0;
  }
  active = on;
  filled = 0;
}

void motion::setRecording(bool on) {
  wantRecording = on;
  if (!active) return;
  if (on && !isRecording) flushTrack();    // the track gives way to the recording
  isRecording = on;
}

bool motion::recording() { return isRecording; }
uint16_t motion::blocks() { return nBlocks; }
uint16_t motion::tracks() { return nTracks; }
