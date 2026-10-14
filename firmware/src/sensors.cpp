#include "sensors.h"
#include "config.h"
#include <Wire.h>
#include <PDM.h>

// ===================== IMU =====================
// Registers from ST's LSM6DS3TR-C driver (STMicroelectronics/lsm6ds3tr-c-pid,
// lsm6ds3tr-c_reg.h): FIFO_CTRL3 0x08 (dec_fifo_xl bits 0-2, dec_fifo_gyro
// bits 3-5, 1 = no decimation); FIFO_CTRL5 0x0A (fifo_mode bits 0-2, 6 =
// continuous; odr_fifo bits 3-6, 5 = 208 Hz); FIFO_STATUS1/2 0x3A/0x3B
// (diff_fifo 11 bits = unread 16-bit words, bit 4 of STATUS2 empty, bit 6
// overrun); FIFO_STATUS3/4 0x3C/0x3D (fifo_pattern 10 bits = which word is
// next); FIFO_DATA_OUT 0x3E/0x3F. ODR code 5 = 208 Hz for CTRL1_XL/CTRL2_G.
namespace {
  const uint8_t IMU_ADDR = 0x6A;
  const uint8_t WHO_AM_I = 0x0F, FIFO_CTRL3 = 0x08, FIFO_CTRL5 = 0x0A,
                CTRL1_XL = 0x10, CTRL2_G = 0x11, CTRL3_C = 0x12,
                FIFO_STATUS1 = 0x3A, FIFO_STATUS3 = 0x3C, FIFO_DATA_OUT_L = 0x3E;
  const float NOMINAL_HZ = 208.0f;

  bool imuOk = false;
  float peakGyro = 0, accelG = 0;
  imu::Sink sink = nullptr;
  uint32_t total = 0, nOverrun = 0, nRealign = 0;
  // Timing: the newest sample read so far and when it was taken.
  uint32_t newestIndex = 0;
  float newestMs = 0, periodMs = 1000.0f / NOMINAL_HZ;
  uint32_t rateT0 = 0, rateC0 = 0;
  float measuredHz = NOMINAL_HZ;
  // Burst reads of FIFO_DATA_OUT should wrap back to 0x3E (ST's driver reads
  // many bytes at once). Checked on the first reads; if not, read 2 bytes at
  // a time.
  bool burstOk = true;
  uint8_t burstChecks = 0;
  // Which half of each 6-word set is gyro is checked against gravity at
  // start-up (accel ≈ 1 g at rest), rather than assumed.
  int8_t order = -1;            // -1 deciding, 0 gyro first, 1 accel first
  float sumFirst = 0, sumSecond = 0;
  uint16_t nOrder = 0, orderTries = 0;

  bool imuWrite(uint8_t reg, uint8_t v) {
    Wire1.beginTransmission(IMU_ADDR);
    Wire1.write(reg); Wire1.write(v);
    return Wire1.endTransmission() == 0;
  }
  bool imuRead(uint8_t reg, uint8_t* out, uint8_t n) {
    Wire1.beginTransmission(IMU_ADDR);
    Wire1.write(reg);
    if (Wire1.endTransmission(false) != 0) return false;
    if (Wire1.requestFrom(IMU_ADDR, n) != n) return false;
    for (uint8_t i = 0; i < n; i++) out[i] = Wire1.read();
    return true;
  }
  bool readPattern(uint16_t* p) {
    uint8_t b[2];
    if (!imuRead(FIFO_STATUS3, b, 2)) return false;
    *p = b[0] | ((b[1] & 0x03) << 8);
    return true;
  }
  float mag3(const int16_t* v, float scale) {
    float x = v[0] * scale, y = v[1] * scale, z = v[2] * scale;
    return sqrtf(x * x + y * y + z * z);
  }

  void handleSample(const uint8_t* b) {
    int16_t w[6];
    for (int i = 0; i < 6; i++) w[i] = (int16_t)(b[2 * i] | (b[2 * i + 1] << 8));
    if (order < 0) {
      // Half a second of samples: whichever half reads near 1 g is the accel.
      sumFirst += mag3(w, imu::ACC_G_PER_LSB);
      sumSecond += mag3(w + 3, imu::ACC_G_PER_LSB);
      if (++nOrder >= 104) {
        float a = sumFirst / nOrder, c = sumSecond / nOrder;
        if (c > 0.6f && c < 1.6f) order = 0;
        else if (a > 0.6f && a < 1.6f) order = 1;
        else if (++orderTries >= 10) order = 0;      // moving the whole time: use the datasheet order
        sumFirst = sumSecond = 0; nOrder = 0;
        if (order >= 0 && Serial) Serial.printf("imu: FIFO order %s\n", order ? "accel first (unexpected)" : "gyro first");
      }
      return;
    }
    int16_t v[6];
    const int16_t* g = order ? w + 3 : w;
    const int16_t* a = order ? w : w + 3;
    for (int i = 0; i < 3; i++) { v[i] = g[i]; v[3 + i] = a[i]; }
    float gm = mag3(v, imu::GYRO_DPS_PER_LSB);
    if (gm > peakGyro) peakGyro = gm;
    accelG = mag3(v + 3, imu::ACC_G_PER_LSB);
    uint32_t idx = total++;
    if (sink) sink(v, idx);
  }
}

bool imu::begin() {
  // The IMU (and its I2C pull-ups) run off this pin: high drive, as Seeed's
  // own IMU library does.
  pinMode(PIN_LSM6DS3TR_C_POWER, OUTPUT_H0H1);
  digitalWrite(PIN_LSM6DS3TR_C_POWER, HIGH);
  delay(50);
  // The nRF52 I2C driver waits forever on a stuck bus, so check both lines
  // are pulled high before using it.
  pinMode(PIN_WIRE1_SDA, INPUT); pinMode(PIN_WIRE1_SCL, INPUT);
  delayMicroseconds(50);
  if (digitalRead(PIN_WIRE1_SDA) == LOW || digitalRead(PIN_WIRE1_SCL) == LOW) { imuOk = false; return false; }
  Wire1.begin();
  Wire1.setClock(400000);
  uint8_t id = 0;
  if (!imuRead(WHO_AM_I, &id, 1) || id != 0x6A) { imuOk = false; return false; }
  imuOk = imuWrite(CTRL3_C, 0x44)        // block data update, auto-increment
       && imuWrite(CTRL1_XL, 0x54)       // accel 208 Hz, ±16 g
       && imuWrite(CTRL2_G, 0x5C)        // gyro 208 Hz, ±2000 dps
       && imuWrite(FIFO_CTRL5, 0x00)     // bypass: clears the FIFO
       && imuWrite(FIFO_CTRL3, 0x09)     // gyro and accel into the FIFO, no decimation
       && imuWrite(FIFO_CTRL5, (5 << 3) | 6);  // FIFO at 208 Hz, continuous
  rateT0 = millis(); rateC0 = 0;
  return imuOk;
}

void imu::setSink(Sink s) { sink = s; }

void imu::poll() {
  if (!imuOk) return;
  uint8_t st[4];
  if (!imuRead(FIFO_STATUS1, st, 4)) return;
  uint32_t now = millis();
  uint16_t words = st[0] | ((st[1] & 0x07) << 8);
  if (st[1] & 0x40) nOverrun++;
  if (st[1] & 0x10 || words == 0) return;            // empty
  uint16_t pattern = st[2] | ((st[3] & 0x03) << 8);
  if (pattern >= 6) pattern = 0;                      // only gyro + accel are in the FIFO
  if (pattern) {                                      // start on a whole sample
    nRealign++;
    uint8_t d[2];
    while (pattern && words) {
      if (!imuRead(FIFO_DATA_OUT_L, d, 2)) return;
      words--; pattern = (pattern + 1) % 6;
    }
  }
  uint16_t n = words / 6;
  if (!n) return;
  if (n > 120) n = 120;                               // the rest next time
  // The newest unread sample was taken about now; earlier ones a period apart.
  uint16_t left = words / 6 - n;                      // samples still in the FIFO after this read
  for (uint16_t i = 0; i < n; ) {
    uint8_t b[24];
    uint16_t k = (n - i >= 2) ? 2 : 1;
    if (burstOk) {
      if (!imuRead(FIFO_DATA_OUT_L, b, 12 * k)) return;
      if (burstChecks < 20) {                         // confirm the address wrapped
        burstChecks++;
        uint16_t p;
        if (readPattern(&p) && p != 0) {
          burstOk = false; nRealign++;
          if (Serial) Serial.println("imu: FIFO burst reads don't wrap; reading 2 bytes at a time");
          return;                                     // this chunk is misaligned: drop it, realign next poll
        }
      }
    } else {
      for (uint8_t j = 0; j < 6 * k; j++) if (!imuRead(FIFO_DATA_OUT_L, b + 2 * j, 2)) return;
    }
    for (uint16_t j = 0; j < k; j++) handleSample(b + 12 * j);
    i += k;
  }
  newestIndex = total ? total - 1 : 0;
  newestMs = now - left * periodMs;
  if (now - rateT0 >= 10000) {
    if (total > rateC0) {
      measuredHz = (total - rateC0) * 1000.0f / (now - rateT0);
      if (measuredHz > 150 && measuredHz < 260) periodMs = 1000.0f / measuredHz;
    }
    rateT0 = now; rateC0 = total;
  }
}

bool imu::ok() { return imuOk; }
float imu::takePeakGyro() { float p = peakGyro; peakGyro = 0; return p; }
float imu::lastAccelG() { return accelG; }
uint32_t imu::count() { return total; }
float imu::sampleMs(uint32_t index) { return newestMs - (float)(int32_t)(newestIndex - index) * periodMs; }
float imu::rateHz() { return measuredHz; }
uint32_t imu::overruns() { return nOverrun; }
uint32_t imu::realigns() { return nRealign; }

// ===================== Microphone =====================
namespace {
  int16_t pdmBuf[256];
  volatile uint16_t micPeak = 0;
  volatile uint32_t micBlocks = 0;
  bool micOk = false;
  // Envelope: first-order high-pass, y = a(y + x - x_prev) with a = 143/256
  // (cut-off about 2 kHz at 16 kHz), then the peak |y| of each 16 samples.
  uint16_t env[mic::ENV_RING];
  volatile uint32_t envN = 0, envMs = 0;
  int32_t hpY = 0, hpX = 0;
  uint16_t envAcc = 0;
  uint8_t envSub = 0;
  uint32_t envT0 = 0, envC0 = 0;
  float envHz = 1000.0f;

  void onPdm() {
    int n = PDM.available();
    if (n > (int)sizeof(pdmBuf)) n = sizeof(pdmBuf);
    PDM.read(pdmBuf, n);
    uint16_t p = micPeak;
    uint32_t c = envN;
    for (int i = 0; i < n / 2; i++) {
      int32_t s = pdmBuf[i];
      uint16_t a = (uint16_t)(s < 0 ? -s : s);
      if (a > p) p = a;
      int32_t y = ((hpY + s - hpX) * 143) >> 8;
      hpX = s; hpY = y;
      uint32_t ay = (uint32_t)(y < 0 ? -y : y);
      if (ay > 65535) ay = 65535;
      if (ay > envAcc) envAcc = (uint16_t)ay;
      if (++envSub == 16) { env[c % mic::ENV_RING] = envAcc; c++; envAcc = 0; envSub = 0; }
    }
    envN = c;
    envMs = millis();
    micPeak = p;
    micBlocks++;
  }
}

bool mic::begin() {
  PDM.onReceive(onPdm);
  micOk = PDM.begin(1, 16000) == 1;
  envT0 = millis();
  return micOk;
}
bool mic::ok() { return micOk && micBlocks > 0; }
uint16_t mic::takePeak() {
  noInterrupts(); uint16_t p = micPeak; micPeak = 0; interrupts();
  // Measure the real envelope rate every 10 s (the PDM clock isn't exactly 16 kHz).
  uint32_t now = millis();
  if (now - envT0 >= 10000) {
    uint32_t c = envCount();
    if (c > envC0) {
      float hz = (c - envC0) * 1000.0f / (now - envT0);
      if (hz > 800 && hz < 1200) envHz = hz;
    }
    envT0 = now; envC0 = c;
  }
  return p;
}
uint32_t mic::envCount() { noInterrupts(); uint32_t c = envN; interrupts(); return c; }
uint32_t mic::envLastMs() { noInterrupts(); uint32_t m = envMs; interrupts(); return m; }
uint16_t mic::envAt(uint32_t index) {
  uint32_t c = envCount();
  if (index >= c || c - index > ENV_RING - 32) return 0;   // keep clear of the slot being written
  return env[index % ENV_RING];
}
float mic::envRateHz() { return envHz; }

// ===================== Battery =====================
namespace {
  uint16_t vbatMv = 0;

  // Resting LiPo voltage to charge left (approximate; under load reads lower).
  const uint16_t CURVE[][2] = {
    {4200, 100}, {4100, 90}, {4000, 79}, {3900, 66}, {3800, 50},
    {3750, 40}, {3700, 30}, {3650, 20}, {3600, 12}, {3500, 5}, {3300, 0},
  };
}

void battery::begin() {
  // initVariant() leaves VBAT_ENABLE HIGH; Seeed says keep it LOW (P0.31 is
  // only safe with the divider enabled, and never HIGH while charging).
  pinMode(VBAT_ENABLE, OUTPUT);
  digitalWrite(VBAT_ENABLE, LOW);
  pinMode(PIN_CHG, INPUT);
  // Charge at 100 mA (LOW) rather than 50 mA, so an 1100 mAh cell fills
  // overnight. 100 mA is at most 0.25 C for the 400 mAh cell later on.
  pinMode(PIN_CHARGING_CURRENT, OUTPUT);
  digitalWrite(PIN_CHARGING_CURRENT, LOW);
  analogReference(AR_INTERNAL_3_0);
  analogReadResolution(12);
  delay(2);
  update();
}

void battery::update() {
  uint32_t sum = 0;
  for (int i = 0; i < 8; i++) sum += analogRead(PIN_VBAT);
  vbatMv = (uint16_t)(sum / 8.0f * VBAT_SCALE);
}

uint16_t battery::millivolts() { return vbatMv; }

uint8_t battery::percent() {
  const int n = sizeof(CURVE) / sizeof(CURVE[0]);
  if (vbatMv >= CURVE[0][0]) return 100;
  if (vbatMv <= CURVE[n - 1][0]) return 0;
  for (int i = 1; i < n; i++) {
    if (vbatMv >= CURVE[i][0]) {
      float t = (float)(vbatMv - CURVE[i][0]) / (CURVE[i - 1][0] - CURVE[i][0]);
      return (uint8_t)(CURVE[i][1] + t * (CURVE[i - 1][1] - CURVE[i][1]) + 0.5f);
    }
  }
  return 0;
}

bool battery::charging() { return digitalRead(PIN_CHG) == LOW; }

// ===================== GNSS =====================
namespace {
  gnss::Fix fx;
  char line[128];
  uint8_t len = 0;

  int hexVal(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
  }

  // Split in place on commas; empty fields are kept.
  int split(char* s, char** f, int max) {
    int n = 0;
    f[n++] = s;
    for (char* p = s; *p && n < max; p++) if (*p == ',') { *p = 0; f[n++] = p + 1; }
    return n;
  }

  // ddmm.mmmm + hemisphere -> degrees × 1e7
  bool coord(const char* v, const char* h, int32_t* out) {
    if (!*v || !*h) return false;
    double x = atof(v);
    int deg = (int)(x / 100);
    double d = deg + (x - deg * 100) / 60.0;
    if (*h == 'S' || *h == 'W') d = -d;
    *out = (int32_t)lround(d * 1e7);
    return true;
  }

  // days since 1970-01-01 (Howard Hinnant's days_from_civil)
  int32_t daysFromCivil(int y, unsigned m, unsigned d) {
    y -= m <= 2;
    const int era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = (unsigned)(y - era * 400);
    const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + (int32_t)doe - 719468;
  }

  void handle(char* s) {
    // s is "$...*hh"
    char* star = strchr(s, '*');
    if (!star || star[1] == 0 || star[2] == 0) { fx.badChecksums++; return; }
    uint8_t sum = 0;
    for (char* p = s + 1; p < star; p++) sum ^= (uint8_t)*p;
    int hi = hexVal(star[1]), lo = hexVal(star[2]);
    if (hi < 0 || lo < 0 || sum != (hi << 4 | lo)) { fx.badChecksums++; return; }
    *star = 0;
    fx.sentences++;
    fx.lastSentenceMs = millis();
    char* f[20];
    int n = split(s + 1, f, 20);
    if (strlen(f[0]) < 5) return;
    const char* type = f[0] + 2;   // skip talker (GP, GN, BD...)
    if (!strcmp(type, "GGA") && n >= 10) {
      fx.quality = (uint8_t)atoi(f[6]);
      fx.sats = (uint8_t)atoi(f[7]);
      fx.hdop100 = *f[8] ? (uint16_t)lround(atof(f[8]) * 100) : 0xFFFF;
      if (fx.quality > 0) {
        coord(f[2], f[3], &fx.lat_e7);
        coord(f[4], f[5], &fx.lon_e7);
        fx.alt_dm = (int16_t)lround(atof(f[9]) * 10);
      }
    } else if (!strcmp(type, "RMC") && n >= 10) {
      if (*f[2] == 'A') fx.speed_cms = (uint16_t)lround(atof(f[7]) * 51.4444);
      // Time and date are valid once the module has them, even before a fix.
      if (strlen(f[1]) >= 6 && strlen(f[9]) == 6) {
        int hh = (f[1][0] - '0') * 10 + (f[1][1] - '0');
        int mi = (f[1][2] - '0') * 10 + (f[1][3] - '0');
        int ss = (f[1][4] - '0') * 10 + (f[1][5] - '0');
        int dd = (f[9][0] - '0') * 10 + (f[9][1] - '0');
        int mo = (f[9][2] - '0') * 10 + (f[9][3] - '0');
        int yy = 2000 + (f[9][4] - '0') * 10 + (f[9][5] - '0');
        if (yy >= 2024 && mo >= 1 && mo <= 12 && dd >= 1) {
          fx.unix = (uint32_t)daysFromCivil(yy, mo, dd) * 86400u + hh * 3600u + mi * 60u + ss;
          fx.unixAtMs = millis();
        }
      }
    }
  }
}

void gnss::begin() {
  pinMode(GNSS_CTRL_A, OUTPUT); digitalWrite(GNSS_CTRL_A, HIGH);
  pinMode(GNSS_CTRL_B, OUTPUT); digitalWrite(GNSS_CTRL_B, HIGH);
  Serial1.begin(GNSS_BAUD);
}

void gnss::poll(Stream* echo) {
  while (Serial1.available()) {
    char c = (char)Serial1.read();
    if (echo) echo->write(c);
    if (c == '$') len = 0;
    if (c == '\r' || c == '\n') {
      if (len > 6 && line[0] == '$') { line[len] = 0; handle(line); }
      len = 0;
    } else if (len < sizeof(line) - 1) {
      line[len++] = c;
    } else {
      len = 0;  // too long: drop
    }
  }
}

const gnss::Fix& gnss::fix() { return fx; }
bool gnss::hasData() { return fx.sentences > 0 && millis() - fx.lastSentenceMs < 3000; }

// ===================== Pin check =====================
uint16_t probePins() {
  uint16_t busy = 0;
  for (int round = 0; round < 10; round++) {
    for (uint8_t p : PROBE_PINS) {
      pinMode(p, INPUT_PULLUP);   delayMicroseconds(200);
      int up = digitalRead(p);
      pinMode(p, INPUT_PULLDOWN); delayMicroseconds(200);
      int down = digitalRead(p);
      if (up == down) busy |= (1u << p);
    }
    delay(100);                   // spread over ~1 s to catch a pulse
  }
  for (uint8_t p : PROBE_PINS) pinMode(p, INPUT);
  return busy;
}
