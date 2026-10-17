#include "capture.h"
#include "sensors.h"
#include "store.h"

namespace {
  capture::Clock unixClock = nullptr;
  bool isEnabled = true;          // Phase 3 build: capture is on by default
  bool session = false;
  uint16_t triggerDps = 150;
  uint16_t gateLevel = 0;
  uint16_t nGated = 0;
  volatile bool settingsChanged = false;

  // Last 512 IMU samples (about 2.5 s).
  const uint16_t RING = 512;
  int16_t ring[RING][6];

  struct Candidate {
    bool active = false;
    uint32_t peakIdx = 0;
    float peak = 0;
    uint32_t overruns = 0;
    uint32_t foundMs = 0;
    uint32_t pressMs = 0;         // a button press while this candidate was open (0 none)
  } cand;
  uint32_t cooldownUntil = 0;     // sample index

  // The latest snippet, so a button press can point at it.
  bool haveLast = false;
  uint16_t lastSeq = 0;
  uint32_t lastPeakMs = 0, lastSavedAt = 0;
  bool labelWaiting = false;      // pressed while a candidate was still being finished
  uint32_t labelWaitingMs = 0;

  const uint32_t LABEL_WINDOW_MS = 20000;
  const uint16_t BUILDUP_SAMPLES = 62;        // 0.3 s at 208 Hz   // a press labels the snippet before it, up to 20 s

  // Record body: context (20 bytes) + swing fields (20) + IMU + envelope.
  const uint32_t CTX = 20, SWING_FIELDS = 20;
  const uint32_t BODY = CTX + SWING_FIELDS + capture::COUNT * 12 + capture::ENV_COUNT;
  uint8_t body[BODY] __attribute__((aligned(4)));

  void put16(uint8_t* p, uint16_t v) { p[0] = v; p[1] = v >> 8; }
  void put32(uint8_t* p, uint32_t v) { p[0] = v; p[1] = v >> 8; p[2] = v >> 16; p[3] = v >> 24; }

  void context(uint8_t* p, uint32_t atMs) {
    const gnss::Fix& f = gnss::fix();
    uint32_t now = unixClock ? unixClock() : 0;
    uint32_t back = (millis() - atMs) / 1000;
    put32(p, now > back ? now - back : 0);
    put32(p + 4, atMs);
    bool fix = f.quality > 0;
    put32(p + 8, fix ? (uint32_t)f.lat_e7 : 0);
    put32(p + 12, fix ? (uint32_t)f.lon_e7 : 0);
    put16(p + 16, f.hdop100);
    p[18] = f.sats;
    p[19] = (fix ? 1 : 0) | (f.unix ? 2 : 0) | (battery::percent() < 15 ? 4 : 0) | (session ? 8 : 0);
  }

  uint8_t isqrt16(uint32_t v) {     // floor(sqrt(v)), capped at 255
    uint32_t r = (uint32_t)sqrtf((float)v);
    while (r * r > v) r--;
    while ((r + 1) * (r + 1) <= v) r++;
    return r > 255 ? 255 : (uint8_t)r;
  }

  void onSample(const int16_t raw[6], uint32_t idx) {
    memcpy(ring[idx % RING], raw, 12);
    if (!session || !isEnabled) { cand.active = false; return; }
    float gx = raw[0] * imu::GYRO_DPS_PER_LSB, gy = raw[1] * imu::GYRO_DPS_PER_LSB, gz = raw[2] * imu::GYRO_DPS_PER_LSB;
    float g = sqrtf(gx * gx + gy * gy + gz * gz);
    if (cand.active) {
      // Keep following the rotation until it has been past its peak for 0.5 s.
      if (idx <= cand.peakIdx + capture::POST && g > cand.peak) { cand.peak = g; cand.peakIdx = idx; }
    } else if (g >= triggerDps && idx >= cooldownUntil && idx >= capture::PRE) {
      cand.active = true; cand.peak = g; cand.peakIdx = idx;
      cand.overruns = imu::overruns(); cand.foundMs = millis(); cand.pressMs = 0;
    }
  }

  void writeLabel(uint32_t pressMs) {
    uint8_t b[CTX + 4];
    context(b, pressMs);
    bool ref = haveLast && pressMs >= lastPeakMs && pressMs - lastPeakMs <= LABEL_WINDOW_MS;
    uint16_t gap = 0xFFFF;              // ms from the snippet's peak to the press
    if (ref) { uint32_t g = pressMs - lastPeakMs; gap = g > 0xFFFE ? 0xFFFE : g; }
    put16(b + CTX, ref ? lastSeq : 0xFFFF);
    put16(b + CTX + 2, gap);
    store::append(store::K_LABEL, b, sizeof(b));
  }

  void finishSnippet() {
    uint32_t peakIdx = cand.peakIdx;
    float peakMs = imu::sampleMs(peakIdx);
    uint32_t count = imu::count();
    uint8_t flags = 0;
    if (imu::overruns() != cand.overruns) flags |= 1;

    // IMU window
    uint8_t* p = body + CTX + SWING_FIELDS;
    uint32_t first = peakIdx - capture::PRE;
    for (uint16_t i = 0; i < capture::COUNT; i++) {
      uint32_t idx = first + i;
      if (idx >= count || count - idx > RING) { memset(p, 0, 12); flags |= 4; }
      else memcpy(p, ring[idx % RING], 12);
      p += 12;
    }

    // Envelope window: ENV_COUNT consecutive values starting about 1.5 s
    // before the peak. Their exact start time is stored, with the real rate.
    float rate = mic::envRateHz();
    uint32_t envN = mic::envCount(), envMs = mic::envLastMs();
    float startBack = (envMs - (peakMs + capture::ENV_START_MS)) * rate / 1000.0f;   // values before the newest
    int32_t i0 = (int32_t)envN - 1 - (int32_t)lroundf(startBack);
    int16_t envStartMs = (int16_t)lroundf((envMs - ((int32_t)envN - 1 - i0) * 1000.0f / rate) - peakMs);
    uint16_t audioPeak = 0, impact = 0;
    for (uint16_t j = 0; j < capture::ENV_COUNT; j++) {
      int32_t idx = i0 + j;
      uint16_t v = 0;
      if (idx < 0 || (uint32_t)idx >= envN) flags |= 2;
      else v = mic::envAt(idx);
      if (v > audioPeak) audioPeak = v;
      float tRel = envStartMs + j * 1000.0f / rate;
      if (tRel >= capture::IMPACT_FROM && tRel <= capture::IMPACT_TO && v > impact) impact = v;
      *p++ = isqrt16(v);
    }

    cooldownUntil = peakIdx + 208;    // 1 s after the peak
    cand.active = false;
    if (gateLevel) {
      // Round mode keeps a candidate only if it looks like a swing:
      // - an impact heard near the peak rotation;
      // - rotation built up over the downswing: the average over the 0.3 s
      //   before the peak at least BUILDUP_MIN. Knocks and the jolt of
      //   reaching for the button go from nearly still to the peak in a few
      //   milliseconds (at most 94 deg/s on this measure in the 15-17 Oct
      //   data); every full shot had at least 128;
      // - not the jolt of a button press (a press within 0.6 s of the peak).
      float build = 0;
      uint16_t nb = 0;
      for (uint32_t i = peakIdx >= BUILDUP_SAMPLES ? peakIdx - BUILDUP_SAMPLES : 0; i < peakIdx; i++) {
        if (count - i > RING) continue;
        const int16_t* v = ring[i % RING];
        float gx = v[0] * imu::GYRO_DPS_PER_LSB, gy = v[1] * imu::GYRO_DPS_PER_LSB, gz = v[2] * imu::GYRO_DPS_PER_LSB;
        build += sqrtf(gx * gx + gy * gy + gz * gz); nb++;
      }
      if (nb) build /= nb;
      bool byButton = cand.pressMs && fabsf((float)cand.pressMs - peakMs) < 600;
      if (impact < gateLevel || build < capture::BUILDUP_MIN || byButton) {
        if (nGated < 65535) nGated++;
        return;                         // not saved
      }
    }

    context(body, (uint32_t)peakMs);
    uint8_t* s = body + CTX;
    put16(s, cand.peak > 65535 ? 65535 : (uint16_t)cand.peak);
    put16(s + 2, triggerDps);
    put16(s + 4, capture::COUNT);
    put16(s + 6, capture::PRE);
    put16(s + 8, (uint16_t)lroundf(imu::rateHz() * 100));
    put16(s + 10, capture::ENV_COUNT);
    put16(s + 12, (uint16_t)envStartMs);
    put16(s + 14, (uint16_t)lroundf(rate * 10));
    s[16] = flags;
    s[17] = isqrt16(impact);          // loudest moment near the peak, companded like the envelope
    put16(s + 18, audioPeak);

    uint16_t seq;
    if (store::append(store::K_SWING, body, BODY, &seq)) {
      haveLast = true; lastSeq = seq; lastPeakMs = (uint32_t)peakMs; lastSavedAt = millis();
    }
  }
}

void capture::begin(Clock unixNow) {
  unixClock = unixNow;
  imu::setSink(onSample);
}

void capture::poll() {
  if (cand.active) {
    uint32_t need = cand.peakIdx + POST;
    if (imu::count() > need) {
      // Wait for the microphone to catch up to the end of the window (it
      // arrives in 16 ms blocks), but not forever.
      float peakMs = imu::sampleMs(cand.peakIdx);
      float endMs = peakMs + ENV_START_MS + ENV_COUNT * 1000.0f / mic::envRateHz();
      bool audioReady = !mic::ok() || (float)mic::envLastMs() >= endMs;
      if (audioReady || millis() - cand.foundMs > 4000) {
        if (store::hasRoom(BODY)) finishSnippet();
        else { cooldownUntil = cand.peakIdx + 208; cand.active = false; }
      }
    }
  }
  if (labelWaiting && !cand.active) { labelWaiting = false; writeLabel(labelWaitingMs); }
}

void capture::setSession(bool active) {
  if (active == session) return;
  if (!active) {                  // ending mid-candidate: drop the candidate, keep any press
    cand.active = false;
    if (labelWaiting && isEnabled) writeLabel(labelWaitingMs);
    labelWaiting = false;
  }
  session = active;
  if (!isEnabled) return;
  uint8_t b[CTX + 4];
  context(b, millis());
  put16(b + CTX, triggerDps);
  put16(b + CTX + 2, gateLevel);
  store::append(active ? store::K_SESSION_START : store::K_SESSION_END, b, sizeof(b));
  if (active) { haveLast = false; cooldownUntil = imu::count() + 208; }
}

void capture::buttonPress() {
  if (!session || !isEnabled) return;
  if (cand.active) { labelWaiting = true; labelWaitingMs = millis(); cand.pressMs = millis(); return; }
  writeLabel(millis());
}

bool capture::enabled() { return isEnabled; }
void capture::setEnabled(bool on) { if (on != isEnabled) settingsChanged = true; isEnabled = on; if (!on) cand.active = false; }
uint16_t capture::trigger() { return triggerDps; }
void capture::setTrigger(uint16_t dps) { if (dps >= 30 && dps <= 2000 && dps != triggerDps) { triggerDps = dps; settingsChanged = true; } }
uint16_t capture::soundGate() { return gateLevel; }
void capture::setSoundGate(uint16_t level) { if (level != gateLevel) { gateLevel = level; settingsChanged = true; } }
uint16_t capture::gatedOut() { return nGated; }
bool capture::takeSettingsChanged() { bool c = settingsChanged; settingsChanged = false; return c; }
bool capture::full() { return !store::hasRoom(BODY); }
uint32_t capture::lastSavedMs() { return lastSavedAt; }
