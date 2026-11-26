#include "stroke.h"
#include <math.h>
#include <string.h>
#include <algorithm>

// The same steps as the 27 Nov analysis (analysis/shortgame), in a pipeline
// that runs about 2.8 s behind the newest sample so every window is centred:
//  1. a median of 3 on each axis (drops single-sample glitches);
//  2. gravity: the mean acceleration over about 1 s centred on the sample;
//  3. v: the gyro along gravity (turn about the vertical), gm: |gyro|;
//  4. vs: v smoothed over 5 samples (about 0.1 s);
//  5. a peak of vs that's the highest within 0.4 s either side, its span
//     over half the peak, and the stillness before and after.
namespace {
  const float GYRO = 0.07f;       // deg/s per count (±2000 dps)
  const float ACC = 0.000488f;    // g per count (±16 g)
  const uint32_t N = 512;         // ring (about 9.7 s at 52 Hz)

  // Window lengths in samples at 52.7 Hz, as the analysis used.
  const int BOX_HALF = 26;        // gravity: 52 samples (m-26 .. m+25)
  const int DIST = 21;            // peaks at least 0.4 s apart
  const int SPAN_MAX = 78;        // a turn's half-peak edge at most 1.5 s from its peak
  const int WIN = 63, GAP = 7;    // stillness: 1.2 s, ending/starting 0.15 s from the turn
  const int NEG = 31;             // 0.6 s
  const int SND = 5;              // 0.1 s
  const int LAG = SPAN_MAX + GAP + WIN + 2;   // how far behind vs the peak is judged

  float hz = 52.7f;
  stroke::Output out = nullptr;
  uint32_t nCand = 0;

  int16_t last[3][6];             // the newest raw samples, for the median
  uint8_t lastHigh[3], lastLow[3];
  float lastT[3];
  uint32_t k = 0;                 // samples fed

  int16_t C[N][6];                // cleaned
  uint8_t sh[N], sl[N];
  float tm[N], v[N], gm[N], vs[N];
  int8_t gr[N][3];
  int64_t accSum[3];
  bool haveC = false;
  uint32_t c0 = 0, cN = 0;        // cleaned samples: first index and count written so far (indices c0 .. cN-1)

  inline uint32_t I(uint32_t i) { return i % N; }

  uint8_t pack(float x, float scale) { float y = x * scale; return y < 0 ? 0 : y > 255 ? 255 : (uint8_t)lroundf(y); }

  float median(uint32_t from, uint32_t to) {     // gm over [from, to)
    static float buf[80];
    uint32_t n = 0;
    for (uint32_t i = from; i < to && n < 80; i++) buf[n++] = gm[I(i)];
    if (!n) return 99;
    // numpy's median: mean of the two middle values for an even count
    std::nth_element(buf, buf + n / 2, buf + n);
    float hi = buf[n / 2];
    if (n % 2) return hi;
    float lo = *std::max_element(buf, buf + n / 2);
    return (lo + hi) / 2;
  }

  void judge(uint32_t p) {
    float h = vs[I(p)];
    if (h < stroke::MIN_PEAK) return;
    if (!(h > vs[I(p - 1)] && h >= vs[I(p + 1)])) return;
    for (int d = 1; d <= DIST; d++) if (vs[I(p - d)] > h || vs[I(p + d)] > h) return;
    float half = h / 2;
    uint32_t a = p, b = p;
    while (a > p - SPAN_MAX && vs[I(a)] > half) a--;
    while (b < p + SPAN_MAX && vs[I(b)] > half) b++;
    float dur = (b - a) * 1000.0f / hz;
    if (dur < stroke::MIN_DUR_MS || dur > stroke::MAX_DUR_MS) return;
    float area = 0, g2 = 0, v2 = 0;
    for (uint32_t i = a; i < b; i++) { area += v[I(i)]; g2 += gm[I(i)] * gm[I(i)]; v2 += v[I(i)] * v[I(i)]; }
    area /= hz;
    if (area < stroke::MIN_AREA) return;
    float pre = median(a - WIN, a - GAP);
    if (pre > stroke::MAX_PRE) return;
    stroke::Candidate c;
    c.tMs = tm[I(p)];
    c.peak = h; c.area = area; c.durMs = dur; c.pre = pre;
    c.post = median(b + GAP, b + WIN);
    float o = (g2 - v2) / (b - a);
    c.other = o > 0 ? sqrtf(o) : 0;
    float mn = 0;
    for (uint32_t i = a - NEG; i <= b + NEG; i++) mn = std::min(mn, vs[I(i)]);
    c.neg = -mn;
    uint8_t hi = 0, lo = 0;
    for (uint32_t i = a - SND; i <= b + SND; i++) { hi = std::max(hi, sh[I(i)]); lo = std::max(lo, sl[I(i)]); }
    c.high = hi; c.low = lo;
    memcpy(c.grav, gr[I(p)], 3);
    nCand++;
    if (out) out(c);
  }
}

void stroke::reset(float rate) {
  hz = rate > 10 ? rate : 52.7f;
  k = 0; cN = 0; c0 = 0; haveC = false; nCand = 0;
  accSum[0] = accSum[1] = accSum[2] = 0;
}

void stroke::setOutput(Output o) { out = o; }
uint32_t stroke::candidates() { return nCand; }

void stroke::feed(const int16_t s[6], uint8_t high, uint8_t low, float tMs) {
  // 1. median of 3 (the middle of the last three samples becomes cleaned sample k-1)
  memmove(last[0], last[1], sizeof(last[0]) * 2);
  memcpy(last[2], s, sizeof(last[2]));
  lastHigh[0] = lastHigh[1]; lastHigh[1] = lastHigh[2]; lastHigh[2] = high;
  lastLow[0] = lastLow[1]; lastLow[1] = lastLow[2]; lastLow[2] = low;
  lastT[0] = lastT[1]; lastT[1] = lastT[2]; lastT[2] = tMs;
  k++;
  if (k < 3) return;
  uint32_t c = cN++;              // cleaned index
  int16_t* row = C[I(c)];
  for (int ax = 0; ax < 6; ax++) {
    int16_t x = last[0][ax], y = last[1][ax], z = last[2][ax];
    row[ax] = std::max(std::min(x, y), std::min(std::max(x, y), z));
  }
  sh[I(c)] = lastHigh[1]; sl[I(c)] = lastLow[1]; tm[I(c)] = lastT[1];

  // 2. gravity box: add the newest, drop the one that left (52 samples)
  for (int ax = 0; ax < 3; ax++) accSum[ax] += row[3 + ax];
  if (c >= 2 * BOX_HALF) for (int ax = 0; ax < 3; ax++) accSum[ax] -= C[I(c - 2 * BOX_HALF)][3 + ax];
  if (c < 2 * BOX_HALF - 1) return;
  uint32_t m = c - (BOX_HALF - 1);      // centre: box covers m-26 .. m+25
  float g[3] = { (float)accSum[0], (float)accSum[1], (float)accSum[2] };
  float L = sqrtf(g[0] * g[0] + g[1] * g[1] + g[2] * g[2]);
  if (L <= 0) L = 1;
  const int16_t* r = C[I(m)];
  float gx = r[0] * GYRO, gy = r[1] * GYRO, gz = r[2] * GYRO;
  v[I(m)] = (gx * g[0] + gy * g[1] + gz * g[2]) / L;
  gm[I(m)] = sqrtf(gx * gx + gy * gy + gz * gz);
  float n = 2.0f * BOX_HALF;            // mean acceleration in g ×100
  for (int ax = 0; ax < 3; ax++) {
    float x = g[ax] / n * ACC * 100;
    gr[I(m)][ax] = (int8_t)(x < -127 ? -127 : x > 127 ? 127 : lroundf(x));
  }
  // 3. smoothed turn, centred on m-2
  uint32_t first = BOX_HALF - 1;        // first m with a value
  if (m < first + 4) return;
  uint32_t q = m - 2;
  vs[I(q)] = (v[I(q - 2)] + v[I(q - 1)] + v[I(q)] + v[I(q + 1)] + v[I(q + 2)]) / 5;
  // 4. judge the peak LAG samples back, once everything around it is filled
  if (q < first + 2 + LAG + SPAN_MAX + WIN + 2) return;
  judge(q - LAG);
}
