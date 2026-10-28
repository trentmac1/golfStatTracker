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
  } cand;
  uint32_t cooldownUntil = 0;     // sample index

  // The latest snippet, so a button press can point at it.
  bool haveLast = false;
  uint16_t lastSeq = 0;
  uint32_t lastPeakMs = 0, lastSavedAt = 0;
  // Raw presses (release times), oldest first; decided PRESS_WAIT_MS later.
  const uint8_t PRESSES = 16;
  uint32_t pressAt[PRESSES];
  bool pressDone[PRESSES];
  uint8_t nPress = 0;
  uint16_t nIgnored = 0, nRejects = 0;

  const uint32_t LABEL_WINDOW_MS = 20000;
  const uint16_t BUILDUP_SAMPLES = 62;        // 0.3 s at 208 Hz
  const uint16_t STILL_SAMPLES = 104;         // 0.5 s at 208 Hz, from 1.5 s before the peak
  const uint32_t REJECT_BODY = 40;

  // Record body: context (20 bytes) + swing fields (20) + IMU + envelope.
  const uint32_t CTX = 20, SWING_FIELDS = 20;
  const uint32_t LOW_FIELDS = 8;   // firmware 0.3.3: low band after the envelope
  const uint32_t BODY = CTX + SWING_FIELDS + capture::COUNT * 12 + capture::ENV_COUNT + LOW_FIELDS + capture::LOW_COUNT;
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
      cand.overruns = imu::overruns(); cand.foundMs = millis();
    }
  }

  void writeLabel(uint32_t pressMs, bool isDouble = false) {
    uint8_t b[CTX + 4];
    context(b, pressMs);
    if (isDouble) b[19] |= 16;          // context flag bit 4: double press
    bool ref = haveLast && pressMs >= lastPeakMs && pressMs - lastPeakMs <= LABEL_WINDOW_MS;
    uint16_t gap = 0xFFFF;              // ms from the snippet's peak to the press
    if (ref) { uint32_t g = pressMs - lastPeakMs; gap = g > 0xFFFE ? 0xFFFE : g; }
    put16(b + CTX, ref ? lastSeq : 0xFFFF);
    put16(b + CTX + 2, gap);
    store::append(store::K_LABEL, b, sizeof(b));
  }

  // Biggest change in acceleration between samples (g) within 3 samples of
  // the moment `ms` after the peak: a knock jolts the tracker as it sounds.
  float joltAt(uint32_t peakIdx, float ms) {
    uint32_t count = imu::count();
    int32_t c = (int32_t)peakIdx + (int32_t)lroundf(ms * imu::rateHz() / 1000.0f);
    float best = 0;
    for (int32_t i = c - 3; i <= c + 3; i++) {
      if (i < 1 || (uint32_t)i >= count || count - (uint32_t)(i - 1) > RING) continue;
      const int16_t* a = ring[i % RING] + 3;
      const int16_t* b = ring[(i - 1) % RING] + 3;
      float dx = (a[0] - b[0]) * imu::ACC_G_PER_LSB, dy = (a[1] - b[1]) * imu::ACC_G_PER_LSB, dz = (a[2] - b[2]) * imu::ACC_G_PER_LSB;
      float d = sqrtf(dx * dx + dy * dy + dz * dz);
      if (d > best) best = d;
    }
    return best;
  }

  void writeReject(float peakMs, uint8_t reason, uint16_t impact, uint16_t lowImpact, uint16_t audioPeak,
                   float build, float still, float impactMs, uint8_t flags) {
    uint8_t b[REJECT_BODY];
    memset(b, 0, sizeof(b));
    context(b, (uint32_t)peakMs);
    uint8_t* x = b + CTX;
    auto clamp16 = [](float v) -> uint16_t { return v < 0 ? 0 : v > 65535 ? 65535 : (uint16_t)lroundf(v); };
    put16(x, clamp16(cand.peak));
    put16(x + 2, impact);
    put16(x + 4, lowImpact);
    put16(x + 6, audioPeak);
    put16(x + 8, clamp16(build));
    put16(x + 10, clamp16(still));
    put16(x + 12, clamp16(joltAt(cand.peakIdx, impactMs) * 100));
    put16(x + 14, (uint16_t)(int16_t)lroundf(impactMs));
    x[16] = reason;
    x[17] = flags;
    put16(x + 18, triggerDps);
    if (store::append(store::K_REJECT, b, sizeof(b)) && nRejects < 65535) nRejects++;
  }

  // Decide presses older than PRESS_WAIT_MS (all of them if `all`, at the
  // end of a session). Only then can every neighbour within the wait have
  // arrived.
  uint32_t gapMs(uint8_t i, uint8_t j) { return pressAt[i] > pressAt[j] ? pressAt[i] - pressAt[j] : pressAt[j] - pressAt[i]; }
  uint8_t nearCount(uint8_t i, uint8_t* only) {
    uint8_t n = 0;
    for (uint8_t j = 0; j < nPress; j++) if (j != i && gapMs(i, j) < capture::PRESS_WAIT_MS) { n++; *only = j; }
    return n;
  }
  void resolvePresses(bool all) {
    uint32_t now = millis();
    auto old = [&](uint8_t i) { return all || now - pressAt[i] >= capture::PRESS_WAIT_MS; };
    for (uint8_t i = 0; i < nPress; i++) {
      if (pressDone[i] || !old(i)) continue;
      uint8_t j = 0xFF, k = 0xFF;
      uint8_t n = nearCount(i, &j);
      if (n == 0) {
        pressDone[i] = true;
        if (session && isEnabled) writeLabel(pressAt[i]);
      } else if (n == 1 && gapMs(i, j) <= capture::DOUBLE_MS && nearCount(j, &k) == 1) {
        if (!old(j)) continue;                 // wait until nothing can follow the pair
        pressDone[i] = pressDone[j] = true;
        if (session && isEnabled) writeLabel(pressAt[i] < pressAt[j] ? pressAt[i] : pressAt[j], true);
      } else {
        pressDone[i] = true;
        if (nIgnored < 65535) nIgnored++;
      }
    }
    // Keep decided presses a while as neighbours for newer ones.
    uint8_t m = 0;
    for (uint8_t i = 0; i < nPress; i++) {
      if (pressDone[i] && (all || now - pressAt[i] > 2 * capture::PRESS_WAIT_MS)) continue;
      pressAt[m] = pressAt[i]; pressDone[m] = pressDone[i]; m++;
    }
    nPress = m;
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
    float impactMs = 0;
    for (uint16_t j = 0; j < capture::ENV_COUNT; j++) {
      int32_t idx = i0 + j;
      uint16_t v = 0;
      if (idx < 0 || (uint32_t)idx >= envN) flags |= 2;
      else v = mic::envAt(idx);
      if (v > audioPeak) audioPeak = v;
      float tRel = envStartMs + j * 1000.0f / rate;
      if (tRel >= capture::IMPACT_FROM && tRel <= capture::IMPACT_TO && v > impact) { impact = v; impactMs = tRel; }
      *p++ = isqrt16(v);
    }
    // A button press near the peak: kept, but flagged (bit 3). Since 0.4.0
    // a press no longer drops a swing: the leg can push the button mid-swing.
    for (uint8_t i = 0; i < nPress; i++) if (fabsf((float)pressAt[i] - peakMs) < 600) flags |= 8;

    // Low band (about 50-370 Hz), one value per 4 envelope values, over the
    // same 2 s. Value k covers envelope values 4k..4k+3; its time is taken as
    // the middle of those.
    int32_t k0 = i0 >= 0 ? (i0 + 3) / 4 : -((-i0) / 4);
    int16_t lowStartMs = (int16_t)lroundf(envStartMs + (4 * k0 + 1.5f - i0) * 1000.0f / rate);
    uint32_t lowN = mic::lowCount();
    uint16_t lowImpact = 0;
    uint8_t* lf = p;
    p += LOW_FIELDS;
    for (uint16_t j = 0; j < capture::LOW_COUNT; j++) {
      int32_t k = k0 + j;
      uint16_t v = (k < 0 || (uint32_t)k >= lowN) ? 0 : mic::lowAt(k);
      float tRel = lowStartMs + j * 4000.0f / rate;
      if (tRel >= capture::IMPACT_FROM && tRel <= capture::IMPACT_TO && v > lowImpact) lowImpact = v;
      *p++ = isqrt16(v);
    }
    put16(lf, capture::LOW_COUNT);
    put16(lf + 2, (uint16_t)lowStartMs);
    put16(lf + 4, (uint16_t)lroundf(rate / 4 * 10));   // Hz × 10
    put16(lf + 6, lowImpact);

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
      // - standing still first: the mean rotation 1.5-1.0 s before the peak
      //   (address, before the backswing) at most STILL_MAX. In the 15-17 Oct
      //   data full shots were at most 58 deg/s here; knocks and handling
      //   that got past the build-up check were mostly 82-360.
      float still = 0;
      uint16_t ns = 0;
      if (peakIdx >= capture::PRE) {
        uint32_t start = peakIdx - capture::PRE;
        for (uint32_t i = start; i < start + STILL_SAMPLES; i++) {
          if (count - i > RING) continue;
          const int16_t* v = ring[i % RING];
          float gx = v[0] * imu::GYRO_DPS_PER_LSB, gy = v[1] * imu::GYRO_DPS_PER_LSB, gz = v[2] * imu::GYRO_DPS_PER_LSB;
          still += sqrtf(gx * gx + gy * gy + gz * gz); ns++;
        }
      }
      if (ns) still /= ns;
      uint8_t reason = (impact < gateLevel ? capture::R_NO_IMPACT : 0)
                     | (build < capture::BUILDUP_MIN ? capture::R_NO_BUILDUP : 0)
                     | (ns && still > capture::STILL_MAX ? capture::R_MOVING : 0);
      if (reason) {
        if (nGated < 65535) nGated++;
        writeReject(peakMs, reason, impact, lowImpact, audioPeak, build, still, impactMs, flags);
        // No cooldown after a reject: a backswing that reaches the trigger
        // (about 150 deg/s on most of Trent's swings, up to 650) would
        // otherwise hold off the downswing 0.8-1 s later and lose the shot.
        cooldownUntil = imu::count();
        return;                         // not saved as a swing
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
  if (nPress) resolvePresses(false);
}

void capture::setSession(bool active) {
  if (active == session) return;
  if (!active) {                  // ending mid-candidate: drop the candidate, decide any presses now
    cand.active = false;
    resolvePresses(true);
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

void capture::buttonPress(uint32_t ms) {
  if (!session || !isEnabled) return;
  if (nPress == PRESSES) {        // a burst: the oldest can only be walking
    if (!pressDone[0] && nIgnored < 65535) nIgnored++;
    memmove(pressAt, pressAt + 1, (PRESSES - 1) * sizeof(pressAt[0]));
    memmove(pressDone, pressDone + 1, PRESSES - 1);
    nPress--;
  }
  pressAt[nPress] = ms; pressDone[nPress] = false; nPress++;
}

uint16_t capture::ignoredPresses() { return nIgnored; }
uint16_t capture::rejects() { return nRejects; }

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
