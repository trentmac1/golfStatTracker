#include "capture.h"
#include "sensors.h"
#include "store.h"
#include <vector>
uint8_t FLASH[1u << 21]; long badWrites=0, writes=0, erases=0, failAfterWrites=-1;
FICR_t ficr={{0x12345678,0}}; RTC_t rtc1={7};
double nowMs = 0;
uint32_t millis(){ return (uint32_t)nowMs; } uint32_t micros(){ return (uint32_t)(nowMs*1000); } void delay(uint32_t){}
#define CHECK(c) do{ if(!(c)){ printf("FAIL line %d: %s\n", __LINE__, #c); exit(1);} }while(0)

// ---- mocks ----
const double IMU_HZ = 207.3, ENV_HZ = 1007.8;   // deliberately not nominal
double swingPeakMs = -1, impactMs = -1, widthMs = 60, busyFrom = -1, busyTo = -1, backAmp = 0;
static imu::Sink sinkFn; static uint32_t imuN = 0;
void imu::setSink(Sink s){ sinkFn = s; }
uint32_t imu::count(){ return imuN; }
float imu::sampleMs(uint32_t i){ return (float)(i * 1000.0 / IMU_HZ); }
float imu::rateHz(){ return IMU_HZ; }
uint32_t imu::overruns(){ return 0; }
float gyroAt(double t) { // dps; a swing: bump to 900 at swingPeakMs, width ~120 ms
  if (t >= busyFrom && t < busyTo) return 160;   // moving about (walking, handling)
  if (swingPeakMs < 0) return 20;
  double d = (t - swingPeakMs) / widthMs, e = (t - swingPeakMs + 900) / 120.0;
  return 20 + 880 * exp(-d * d) + backAmp * exp(-e * e);   // optional backswing 0.9 s before
}
void pumpImu() { // deliver all samples with time <= now
  while (imuN * 1000.0 / IMU_HZ <= nowMs) {
    double t = imuN * 1000.0 / IMU_HZ;
    int16_t raw[6] = { (int16_t)(gyroAt(t) / imu::GYRO_DPS_PER_LSB), 0, 0, 0, 0, (int16_t)(1.0 / imu::ACC_G_PER_LSB) };
    raw[1] = (int16_t)(imuN & 0xFF);   // tag sample index in gy to check alignment
    uint32_t i = imuN++;
    sinkFn(raw, i);
  }
}
uint32_t envN = 0;
uint16_t envVal(uint32_t i) { double t = i * 1000.0 / ENV_HZ; return (impactMs >= 0 && fabs(t - impactMs) < 0.5) ? 40000 : 100; }
uint32_t mic::envCount(){ return (uint32_t)(nowMs * ENV_HZ / 1000.0); }
uint32_t mic::envLastMs(){ uint32_t c = mic::envCount(); return c ? (uint32_t)((c - 1) * 1000.0 / ENV_HZ) : 0; }
uint16_t mic::envAt(uint32_t i){ return envVal(i); }
// Low band: value k covers envelope values 4k..4k+3; loud (a thud) around the impact.
uint32_t mic::lowCount(){ return mic::envCount() / 4; }
uint16_t mic::lowAt(uint32_t k){ double t = (4 * k + 1.5) * 1000.0 / ENV_HZ; return (impactMs >= 0 && fabs(t - impactMs) < 3) ? 3000 : 50; }
float mic::envRateHz(){ return ENV_HZ; }
bool mic::ok(){ return true; }
gnss::Fix fx; const gnss::Fix& gnss::fix(){ return fx; }
uint8_t battery::percent(){ return 80; }
uint32_t clk(){ return 1790000000u + millis() / 1000; }

void run(double untilMs) { while (nowMs < untilMs) { nowMs += 1; pumpImu(); if ((int)nowMs % 10 == 0) capture::poll(); } }

std::vector<std::vector<uint8_t>> records() {
  std::vector<std::vector<uint8_t>> out; store::Header h; uint32_t a = 0;
  while (store::header(a, &h)) { std::vector<uint8_t> r(h.len); store::read(a, r.data(), h.len); out.push_back(r); a += h.len; }
  return out;
}
int16_t s16(const uint8_t* p){ return (int16_t)(p[0] | p[1] << 8); }
uint16_t u16(const uint8_t* p){ return p[0] | p[1] << 8; }

int main() {
  memset(FLASH, 0xFF, sizeof FLASH);
  fx.quality = 1; fx.lat_e7 = -273928400; fx.lon_e7 = 1529470790; fx.sats = 12; fx.hdop100 = 110; fx.unix = 1;
  CHECK(store::begin(0));
  capture::begin(clk);
  run(3000);
  capture::setSession(true);
  run(5000);
  swingPeakMs = 6000; impactMs = 6020;
  run(8000);
  // label press 4 s after the swing
  capture::buttonPress(millis());
  run(9000);
  // practice swing that's under the trigger: nothing
  swingPeakMs = -1; impactMs = -1;
  run(12000);
  // a press with no swing in the last 20 s
  run(40000); capture::buttonPress(millis()); run(40100);
  capture::setSession(false);
  auto rs = records();
  CHECK(rs.size() == 6);   // log start, session start, swing, label, label, session end
  int kinds[6]; for (int i=0;i<6;i++) kinds[i]=rs[i][0];
  CHECK(kinds[0]==1&&kinds[1]==2&&kinds[2]==4&&kinds[3]==5&&kinds[4]==5&&kinds[5]==3);
  const uint8_t* r = rs[2].data(); const uint8_t* b = r + 8;
  CHECK(u16(r+2) == 7548);
  CHECK(store::crc16(r+8, 7540) == u16(r+6));
  uint32_t devMs = b[4] | b[5]<<8 | b[6]<<16 | (uint32_t)b[7]<<24;
  printf("peak device_ms %u (true 6000), peak_gyro %u\n", devMs, u16(b+20));
  CHECK(devMs >= 5997 && devMs <= 6003);
  CHECK(u16(b+20) > 880);
  // IMU window: sample at peak_index must be the true peak sample
  uint16_t pk = u16(b+26); CHECK(pk == 312 && u16(b+24) == 416);
  const uint8_t* imu = b + 40;
  int best = 0; int16_t bv = 0;
  for (int i = 0; i < 416; i++) { int16_t g = s16(imu + i*12); if (g > bv) { bv = g; best = i; } }
  CHECK(best == 312);
  // consecutive samples (gy tag increments by 1)
  for (int i = 1; i < 416; i++) CHECK(((uint8_t)s16(imu + i*12 + 2)) == (uint8_t)(s16(imu + (i-1)*12 + 2) + 1));
  // envelope: click at +20 ms from the peak
  int16_t envStart = s16(b+32); double rate = u16(b+34) / 10.0; const uint8_t* env = b + 40 + 4992;
  int jm = 0; for (int j = 0; j < 2000; j++) if (env[j] > env[jm]) jm = j;
  double clickRel = envStart + jm * 1000.0 / rate;
  printf("env start %d ms, rate %.1f, click at %+.1f ms (true +20), value %u, flags %u, audio_peak %u\n", envStart, rate, clickRel, env[jm], b[36], u16(b+38));
  CHECK(fabs(clickRel - 20) <= 3);
  CHECK(b[36] == 0);
  CHECK(env[jm] == 200);    // sqrt(40000)
  // labels
  const uint8_t* l1 = rs[3].data() + 8; CHECK(u16(l1+20) == u16(rs[2].data()+4)); printf("label gap %u ms\n", u16(l1+22));
  CHECK(u16(l1+22) > 1900 && u16(l1+22) < 2100);
  const uint8_t* l2 = rs[4].data() + 8; CHECK(u16(l2+20) == 0xFFFF && u16(l2+22) == 0xFFFF);
  // Save the log as a fixture for the web app's decoder tests.
  if (const char* out = getenv("CAPTURE_FIXTURE")) {
    FILE* f = fopen(out, "wb");
    for (auto& rec : rs) fwrite(rec.data(), 1, rec.size(), f);
    fclose(f);
    printf("wrote %s\n", out);
  }
  // Low band after the envelope: count, start, rate, impact, then values.
  const uint8_t* lowF = b + 40 + 4992 + 2000;
  CHECK(u16(lowF) == 500);
  int16_t lowStart = s16(lowF + 2); double lowRate = u16(lowF + 4) / 10.0;
  CHECK(u16(lowF + 6) == 3000);
  int km = 0; for (int k = 0; k < 500; k++) if (lowF[8 + k] > lowF[8 + km]) km = k;
  double thudRel = lowStart + km * 1000.0 / lowRate;
  printf("low band: start %d ms, rate %.1f, thud at %+.1f ms (true +20)\n", lowStart, lowRate, thudRel);
  CHECK(fabs(lowRate - ENV_HZ / 4) < 0.2);
  CHECK(fabs(thudRel - 20) <= 5);
  CHECK(lowF[8 + km] == 54);    // floor(sqrt(3000))

  // Impact byte: sqrt of the loudest level near the peak.
  CHECK(b[37] == 200);

  // Sound gate (round mode): a swing with an impact is kept, one without isn't.
  capture::setSoundGate(capture::ROUND_GATE);
  CHECK(capture::takeSettingsChanged());
  capture::setSession(true);
  uint16_t before = store::swings();
  swingPeakMs = 46000; impactMs = 46030; run(48000);      // shot: kept
  swingPeakMs = 52000; impactMs = -1;    run(54000);      // walking-like rotation, silent: dropped
  swingPeakMs = 58000; impactMs = 57500; run(60000);      // sound 500 ms before the peak: outside the window, dropped
  widthMs = 6; swingPeakMs = 64000; impactMs = 64005; run(66000);   // knock: loud but no build-up, dropped
  widthMs = 60; swingPeakMs = 70000; impactMs = 70020; run(70150);
  capture::buttonPress(millis()); run(72000);                        // a press right after a real swing: kept since 0.4.0, flagged
  busyFrom = 74000; busyTo = 75500;                                   // moving about until just before the swing
  swingPeakMs = 76000; impactMs = 76020; run(78000);                 // swing-like, loud, but not still first: dropped
  busyFrom = busyTo = -1;
  capture::setSession(false);
  printf("gate: %u kept, %u dropped, %u rejects\n", store::swings() - before, capture::gatedOut(), capture::rejects());
  CHECK(store::swings() == before + 2);
  CHECK(capture::gatedOut() == 6);    // the moving-about itself reached the 150 trigger twice (silent)
  CHECK(capture::rejects() == 4);     // ...and failed two rules (silent and moving): counted, no record
  auto rs2 = records();
  // Every candidate that failed one rule left a reject record with its reason.
  std::vector<uint8_t> reasons;
  for (auto& r : rs2) if (r[0] == store::K_REJECT) { CHECK(r.size() == 48); CHECK(store::crc16(r.data() + 8, 40) == u16(r.data() + 6)); reasons.push_back(r[8 + 36]); }
  CHECK(reasons.size() == 4);
  CHECK(reasons[0] == capture::R_NO_IMPACT);                // silent
  CHECK(reasons[1] == capture::R_NO_IMPACT);                // sound outside the window
  CHECK(reasons[2] == capture::R_NO_BUILDUP);               // knock
  CHECK(reasons[3] == capture::R_MOVING);                   // the swing after moving about: only that
  // The reject's own fields: the moving one has a high "still" value.
  {
    const uint8_t* x = nullptr; int k = 0;
    for (auto& r : rs2) if (r[0] == store::K_REJECT && ++k == 4) x = r.data() + 8 + 20;
    printf("moving reject: peak %u impact %u build %u still %u jolt %.2f at %+d ms\n", u16(x), u16(x + 2), u16(x + 8), u16(x + 10), u16(x + 12) / 100.0, s16(x + 14));
    CHECK(u16(x + 10) > 80 && u16(x) > 800 && u16(x + 2) == 40000 && u16(x + 8) > 110);
  }
  // The swing with a press 150 ms after its peak is saved, flagged bit 3.
  int flagged = 0;
  for (auto& r : rs2) if (r[0] == store::K_SWING && (r[8 + 36] & 8)) flagged++;
  CHECK(flagged == 1);
  const uint8_t* sess = nullptr;
  for (auto& r : rs2) if (r[0] == store::K_SESSION_START) sess = r.data();
  CHECK(sess && u16(sess + 8 + 22) == capture::ROUND_GATE);

  // A backswing that reaches the trigger 0.9 s before the downswing: the
  // backswing is rejected (no impact near it) and the downswing still saved.
  capture::setSession(true);
  uint16_t sw0 = store::swings();
  backAmp = 260; swingPeakMs = 92000; impactMs = 92020; run(95000); backAmp = 0;
  capture::setSession(false);
  printf("backswing case: %u saved\n", store::swings() - sw0);
  CHECK(store::swings() == sw0 + 1);
  capture::setSoundGate(capture::ROUND_GATE);

  // Presses: walking pushes the button at the step rhythm; those are ignored.
  // A press on its own is a label; two within 0.7 s are one double press.
  capture::setSoundGate(0);
  swingPeakMs = -1; impactMs = -1;
  capture::setSession(true);
  uint16_t labels0 = store::labels(), ignored0 = capture::ignoredPresses();
  run(82000);
  for (int i = 0; i < 8; i++) { capture::buttonPress(millis()); run(millis() + 550); }   // walking: every 0.55 s
  run(millis() + 5000);
  CHECK(store::labels() == labels0);
  CHECK(capture::ignoredPresses() == ignored0 + 8);
  capture::buttonPress(millis()); run(millis() + 6000);                                  // a single press
  CHECK(store::labels() == labels0 + 1);
  capture::buttonPress(millis()); run(millis() + 400); capture::buttonPress(millis()); run(millis() + 6000);   // double
  CHECK(store::labels() == labels0 + 2);
  auto rs3 = records();
  const uint8_t* last = nullptr;
  for (auto& r : rs3) if (r[0] == store::K_LABEL) last = r.data();
  CHECK(last && (last[8 + 19] & 16));                       // double-press flag
  capture::buttonPress(millis()); capture::setSession(false);                            // decided at session end
  CHECK(store::labels() == labels0 + 3);
  printf("presses: %u ignored, labels ok\n", capture::ignoredPresses() - ignored0);
  // The whole log (round mode, rejects, presses) for the app's decoder tests.
  if (const char* out = getenv("CAPTURE_FIXTURE_FULL")) {
    FILE* f = fopen(out, "wb");
    for (auto& rec : records()) fwrite(rec.data(), 1, rec.size(), f);
    fclose(f);
  }
  printf("capture tests passed\n");
}
