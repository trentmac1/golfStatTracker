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
double swingPeakMs = -1, impactMs = -1, widthMs = 60, busyFrom = -1, busyTo = -1;
static imu::Sink sinkFn; static uint32_t imuN = 0;
void imu::setSink(Sink s){ sinkFn = s; }
uint32_t imu::count(){ return imuN; }
float imu::sampleMs(uint32_t i){ return (float)(i * 1000.0 / IMU_HZ); }
float imu::rateHz(){ return IMU_HZ; }
uint32_t imu::overruns(){ return 0; }
float gyroAt(double t) { // dps; a swing: bump to 900 at swingPeakMs, width ~120 ms
  if (t >= busyFrom && t < busyTo) return 160;   // moving about (walking, handling)
  if (swingPeakMs < 0) return 20;
  double d = (t - swingPeakMs) / widthMs; return 20 + 880 * exp(-d * d);
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
  capture::buttonPress();
  run(9000);
  // practice swing that's under the trigger: nothing
  swingPeakMs = -1; impactMs = -1;
  run(12000);
  // a press with no swing in the last 20 s
  run(40000); capture::buttonPress(); run(40100);
  capture::setSession(false);
  auto rs = records();
  CHECK(rs.size() == 6);   // log start, session start, swing, label, label, session end
  int kinds[6]; for (int i=0;i<6;i++) kinds[i]=rs[i][0];
  CHECK(kinds[0]==1&&kinds[1]==2&&kinds[2]==4&&kinds[3]==5&&kinds[4]==5&&kinds[5]==3);
  const uint8_t* r = rs[2].data(); const uint8_t* b = r + 8;
  CHECK(u16(r+2) == 7040);
  CHECK(store::crc16(r+8, 7032) == u16(r+6));
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
  capture::buttonPress(); run(72000);                                // the jolt of a button press: dropped
  busyFrom = 74000; busyTo = 75500;                                   // moving about until just before the swing
  swingPeakMs = 76000; impactMs = 76020; run(78000);                 // swing-like, loud, but not still first: dropped
  busyFrom = busyTo = -1;
  capture::setSession(false);
  printf("gate: %u kept, %u dropped\n", store::swings() - before, capture::gatedOut());
  CHECK(store::swings() == before + 1);
  CHECK(capture::gatedOut() == 6);    // the moving-about itself also reached the 150 trigger (dropped: silent)
  auto rs2 = records();
  const uint8_t* sess = rs2[rs2.size() - 4].data();      // session start, kept swing, label, session end
  CHECK(sess[0] == 2 && u16(sess + 8 + 22) == capture::ROUND_GATE);
  printf("capture tests passed\n");
}
