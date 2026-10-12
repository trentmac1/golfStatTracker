#include "sensors.h"
#include "config.h"
#include <Wire.h>
#include <PDM.h>

// ===================== IMU =====================
namespace {
  const uint8_t IMU_ADDR = 0x6A;
  const uint8_t WHO_AM_I = 0x0F, CTRL1_XL = 0x10, CTRL2_G = 0x11, CTRL3_C = 0x12,
                STATUS_REG = 0x1E, OUTX_L_G = 0x22;
  const float GYRO_DPS_PER_LSB = 0.070f;     // ±2000 dps
  const float ACC_G_PER_LSB = 0.000488f;     // ±16 g

  bool imuOk = false;
  float peakGyro = 0, accelG = 0;

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
}

bool imu::begin() {
  pinMode(PIN_LSM6DS3TR_C_POWER, OUTPUT);
  digitalWrite(PIN_LSM6DS3TR_C_POWER, HIGH);
  delay(20);
  Wire1.begin();
  Wire1.setClock(400000);
  uint8_t id = 0;
  if (!imuRead(WHO_AM_I, &id, 1) || id != 0x6A) { imuOk = false; return false; }
  imuOk = imuWrite(CTRL3_C, 0x44)        // block data update, auto-increment
       && imuWrite(CTRL1_XL, 0x44)       // accel 104 Hz, ±16 g
       && imuWrite(CTRL2_G, 0x4C);       // gyro 104 Hz, ±2000 dps
  return imuOk;
}

void imu::poll() {
  if (!imuOk) return;
  uint8_t st;
  if (!imuRead(STATUS_REG, &st, 1) || !(st & 0x02)) return;  // GDA: new gyro sample
  uint8_t b[12];
  if (!imuRead(OUTX_L_G, b, 12)) return;
  int16_t v[6];
  for (int i = 0; i < 6; i++) v[i] = (int16_t)(b[2 * i] | (b[2 * i + 1] << 8));
  float gx = v[0] * GYRO_DPS_PER_LSB, gy = v[1] * GYRO_DPS_PER_LSB, gz = v[2] * GYRO_DPS_PER_LSB;
  float ax = v[3] * ACC_G_PER_LSB, ay = v[4] * ACC_G_PER_LSB, az = v[5] * ACC_G_PER_LSB;
  float g = sqrtf(gx * gx + gy * gy + gz * gz);
  if (g > peakGyro) peakGyro = g;
  accelG = sqrtf(ax * ax + ay * ay + az * az);
}

bool imu::ok() { return imuOk; }
float imu::takePeakGyro() { float p = peakGyro; peakGyro = 0; return p; }
float imu::lastAccelG() { return accelG; }

// ===================== Microphone =====================
namespace {
  int16_t pdmBuf[256];
  volatile uint16_t micPeak = 0;
  volatile uint32_t micBlocks = 0;
  bool micOk = false;

  void onPdm() {
    int n = PDM.available();
    if (n > (int)sizeof(pdmBuf)) n = sizeof(pdmBuf);
    PDM.read(pdmBuf, n);
    uint16_t p = micPeak;
    for (int i = 0; i < n / 2; i++) {
      int32_t s = pdmBuf[i];
      uint16_t a = (uint16_t)(s < 0 ? -s : s);
      if (a > p) p = a;
    }
    micPeak = p;
    micBlocks++;
  }
}

bool mic::begin() {
  PDM.onReceive(onPdm);
  micOk = PDM.begin(1, 16000) == 1;
  return micOk;
}
bool mic::ok() { return micOk && micBlocks > 0; }
uint16_t mic::takePeak() { noInterrupts(); uint16_t p = micPeak; micPeak = 0; interrupts(); return p; }

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
