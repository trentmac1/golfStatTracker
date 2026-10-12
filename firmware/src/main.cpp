// Golf tracker, Phase 2 bring-up: read the IMU, microphone, L76K and battery,
// and publish them over BLE so the web app (in Bluefy) can show them.
//
// Serial monitor (USB, 115200): a status line every second.
//   n  toggle raw NMEA echo      p  re-run the pin check      h  help
#include <Arduino.h>
#include "config.h"
#include "sensors.h"
#include "link.h"

static bool roundActive = false;
static uint8_t buttonPresses = 0;
static uint16_t busyPins = 0;
static bool echoNmea = false;
static uint32_t phoneUnix = 0, phoneUnixAtMs = 0;  // time set by the app
static uint32_t identifyUntil = 0;
static uint32_t flashUntil = 0;       // short solid white: button feedback

// ---------- time ----------
static uint32_t nowUnix() {
  const gnss::Fix& f = gnss::fix();
  if (f.unix) return f.unix + (millis() - f.unixAtMs) / 1000;
  if (phoneUnix) return phoneUnix + (millis() - phoneUnixAtMs) / 1000;
  return 0;
}

// ---------- LEDs (active low) ----------
static void leds(bool r, bool g, bool b) {
  digitalWrite(LED_R, r ? LOW : HIGH);
  digitalWrite(LED_G, g ? LOW : HIGH);
  digitalWrite(LED_B, b ? LOW : HIGH);
}

// Every 2 s: a short flash, green with a GPS fix, yellow while the GPS is
// talking but has no fix, red if nothing is coming from the GPS. Two flashes
// while a round is active. Then a blue flash if the phone is connected.
static void updateLeds() {
  uint32_t now = millis();
  if (now < flashUntil) { leds(true, true, true); return; }
  if (now < identifyUntil) {                 // "find my tracker": fast white blink
    bool on = (now / 125) % 2;
    leds(on, on, on);
    return;
  }
  uint32_t t = now % 2000;
  const gnss::Fix& f = gnss::fix();
  bool fix = f.quality > 0, data = gnss::hasData();
  bool r = !fix, g = fix || data;
  bool flash1 = t < 40;
  bool flash2 = roundActive && t >= 200 && t < 240;
  bool blue = blelink::connected() && t >= 450 && t < 490;
  if (flash1 || flash2) leds(r, g, false);
  else leds(false, false, blue);
}

// ---------- button ----------
// Short press: counted (labels shots in Phase 3). Hold 2 s: start/end round.
static void updateButton() {
  static bool down = false, held = false;
  static uint32_t since = 0;
  static bool last = HIGH;
  static uint32_t lastChange = 0;
  bool raw = digitalRead(BUTTON_PIN);
  uint32_t now = millis();
  if (raw != last) { last = raw; lastChange = now; }
  if (now - lastChange < 25) return;         // debounce
  bool pressed = (raw == LOW);
  if (pressed && !down) { down = true; held = false; since = now; }
  if (pressed && down && !held && now - since > 2000) {
    held = true;
    roundActive = !roundActive;
    flashUntil = now + 600;
  }
  if (!pressed && down) {
    down = false;
    if (!held) { buttonPresses++; flashUntil = now + 120; }
  }
}

static bool buttonDown() { return digitalRead(BUTTON_PIN) == LOW; }

// ---------- control from the app ----------
static void onControl(const uint8_t* d, uint16_t len) {
  switch (d[0]) {
    case OP_START_ROUND: roundActive = true; break;
    case OP_END_ROUND: roundActive = false; break;
    case OP_SET_TIME:
      if (len >= 5) {
        phoneUnix = d[1] | (d[2] << 8) | (d[3] << 16) | ((uint32_t)d[4] << 24);
        phoneUnixAtMs = millis();
      }
      break;
    case OP_IDENTIFY: identifyUntil = millis() + 3000; break;
  }
}

// ---------- serial ----------
static void printBusy() {
  Serial.print("pin check: ");
  if (!busyPins) { Serial.println("no other pins in use"); return; }
  for (uint8_t p : PROBE_PINS) if (busyPins & (1u << p)) { Serial.print('D'); Serial.print(p); Serial.print(' '); }
  Serial.println("are driven by something (don't wire the button there)");
}

static void printStatus(float gyro, uint16_t micPeak) {
  const gnss::Fix& f = gnss::fix();
  Serial.printf("batt %u mV %u%%%s | gps %s q%u sats %u hdop %.2f | imu %s %4.0f dps %.2f g | mic %s %5u | btn %u%s | ble %s | round %s\n",
    battery::millivolts(), battery::percent(), battery::charging() ? " charging" : "",
    gnss::hasData() ? "ok" : "SILENT", f.quality, f.sats, f.hdop100 == 0xFFFF ? -1.0 : f.hdop100 / 100.0,
    imu::ok() ? "ok" : "FAIL", gyro, imu::lastAccelG(),
    mic::ok() ? "ok" : "FAIL", micPeak,
    buttonPresses, buttonDown() ? " (down)" : "",
    blelink::connected() ? "connected" : "advertising", roundActive ? "on" : "off");
  if (f.quality > 0)
    Serial.printf("      at %.6f, %.6f  alt %.1f m  time %lu\n", f.lat_e7 / 1e7, f.lon_e7 / 1e7, f.alt_dm / 10.0, (unsigned long)nowUnix());
}

static void handleSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == 'n') { echoNmea = !echoNmea; Serial.println(echoNmea ? "NMEA echo on" : "NMEA echo off"); }
    else if (c == 'p') { busyPins = probePins(); pinMode(BUTTON_PIN, INPUT_PULLUP); printBusy(); }
    else if (c == 'h' || c == '?') Serial.println("n: NMEA echo   p: pin check   h: help");
  }
}

// ---------- main ----------
void setup() {
  leds(true, false, false);
  Serial.begin(115200);
  uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 1500) delay(10);   // don't wait without USB

  battery::begin();                     // first: puts VBAT_ENABLE LOW (Seeed's advice)
  gnss::begin();                        // holds the GNSS control lines HIGH
  busyPins = probePins();               // before the button pin gets its pull-up
  pinMode(BUTTON_PIN, INPUT_PULLUP);

  bool imuOk = imu::begin();
  blelink::begin(onControl);
  bool micOk = mic::begin();            // after BLE: PDM asks the SoftDevice for the HF clock

  Serial.printf("\nGolf tracker firmware %d.%d.%d (protocol %d)\n", FW_MAJOR, FW_MINOR, FW_PATCH, PROTOCOL_VERSION);
  Serial.printf("IMU %s, mic %s\n", imuOk ? "ok" : "NOT FOUND", micOk ? "ok" : "FAILED");
  printBusy();
  Serial.println("Type h for commands.");
  leds(false, false, false);
}

void loop() {
  static uint32_t lastSecond = 0, lastBattery = 0;
  imu::poll();
  gnss::poll(echoNmea ? &Serial : nullptr);
  updateButton();
  updateLeds();
  handleSerial();

  uint32_t now = millis();
  if (now - lastBattery >= 5000) { lastBattery = now; battery::update(); }
  if (now - lastSecond >= 1000) {
    lastSecond = now;
    float gyro = imu::takePeakGyro();
    uint16_t micPeak = mic::takePeak();
    const gnss::Fix& f = gnss::fix();

    StatusPacket s = {};
    s.proto = PROTOCOL_VERSION;
    s.batteryPct = battery::percent();
    s.batteryMv = battery::millivolts();
    s.flags = (battery::charging() ? F_CHARGING : 0) | (roundActive ? F_ROUND : 0)
            | (gnss::hasData() ? F_GPS_DATA : 0) | (f.quality > 0 ? F_GPS_FIX : 0)
            | (imu::ok() ? F_IMU_OK : 0) | (mic::ok() ? F_MIC_OK : 0)
            | (nowUnix() ? F_TIME_OK : 0) | (buttonDown() ? F_BUTTON_DOWN : 0);
    s.fixQuality = f.quality;
    s.sats = f.sats;
    s.buttonPresses = buttonPresses;
    s.hdop100 = f.hdop100;
    s.recordCount = 0;                  // shot records arrive in Phase 5
    s.fw[0] = FW_MAJOR; s.fw[1] = FW_MINOR; s.fw[2] = FW_PATCH;
    s.micLevel = micPeak >> 7;          // 0-255
    s.gyroPeak = gyro > 65535 ? 65535 : (uint16_t)gyro;
    s.busyPins = busyPins;

    LivePacket l = {};
    l.unix = nowUnix();
    if (f.quality > 0) { l.lat_e7 = f.lat_e7; l.lon_e7 = f.lon_e7; l.alt_dm = f.alt_dm; l.speed_cms = f.speed_cms; }

    blelink::publish(s, l);
    if (Serial && !echoNmea) printStatus(gyro, micPeak);
  }
  delay(2);                             // let the CPU idle between polls (IMU is 104 Hz)
}
