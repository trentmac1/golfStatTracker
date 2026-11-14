// Golf tracker. Phase 2 bring-up (IMU, microphone, L76K, battery over BLE)
// plus Phase 3 capture mode: while a round is on, every swing candidate is
// saved to flash as a 2 s snippet, short button presses label real shots, and
// the app syncs the log over BLE.
//
// Sleep (0.5.0): after an hour with no phone connected and no round on, the
// tracker switches everything off and a button press wakes it (goToSleep()).
//
// Serial monitor (USB, 115200): a status line every second.
//   n  toggle raw NMEA echo   p  re-run the pin check   c  capture on/off
//   l  capture log summary    h  help
#include <Arduino.h>
#include "config.h"
#include "sensors.h"
#include "link.h"
#include "store.h"
#include "capture.h"
#include "motion.h"
#include <InternalFileSystem.h>
using namespace Adafruit_LittleFS_Namespace;

static bool roundActive = false;
// Locked by the app during a tracker round: the 2 s hold no longer starts
// or ends the round (the leg can hold the button down while walking). Kept
// across a restart, with the round, until the app ends the round.
static bool roundLocked = false;
static volatile bool stateChanged = false;
static uint8_t buttonPresses = 0;
static uint16_t busyPins = 0;
static bool echoNmea = false;
static uint32_t phoneUnix = 0, phoneUnixAtMs = 0;  // time set by the app
static uint32_t identifyUntil = 0;
static uint32_t flashUntil = 0;       // short solid flash: button / swing feedback
static uint32_t lastActive = 0;       // millis() of the last connection, press or swing (for sleep)
static bool wokeFromSleep = false;
static bool flashR = true, flashG = true, flashB = true;

// Requests from the app arrive on the Bluetooth task; the loop acts on them.
static volatile uint8_t roundRequest = 0;       // 1 start, 2 end
static volatile uint8_t lockRequest = 0;        // 1 lock, 2 unlock
static volatile int32_t syncRequest = -1;       // seq to sync from
static volatile bool stopSyncRequest = false;
static volatile bool eraseRequest = false;
static volatile uint8_t recordRequest = 0;      // 0.6.0: 1 start, 2 stop a practice recording
static volatile bool sleepRequest = false;     // 0.5.0: the app's "sleep now"
static volatile uint32_t eraseLogId = 0;
static volatile uint16_t lastAck = 0;

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
static void flash(uint16_t ms, bool r, bool g, bool b) {
  flashUntil = millis() + ms; flashR = r; flashG = g; flashB = b;
}

static void setRound(bool on) {
  if (on == roundActive) return;
  roundActive = on;
  capture::setSession(on);
  stateChanged = true;
}

static void updateLeds() {
  uint32_t now = millis();
  if (now < flashUntil) { leds(flashR, flashG, flashB); return; }
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
  bool flash3 = motion::recording() && t >= 320 && t < 360;   // three flashes: practice recording
  bool blue = blelink::connected() && t >= 450 && t < 490;
  if (flash1 || flash2 || flash3) leds(r, g, false);
  else leds(false, false, blue);
}

// ---------- button ----------
// Short press: counted, and labels the last swing while a round is on.
// Hold 2 s: start/end round.
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
  if (pressed) lastActive = now;
  if (pressed && !down) { down = true; held = false; since = now; }
  if (pressed && down && !held && now - since > 2000) {
    held = true;
    if (roundLocked) flash(300, true, false, false);   // red: the app owns the round
    else { setRound(!roundActive); flash(600, true, true, true); }
  }
  if (!pressed && down) {
    down = false;
    if (!held) { buttonPresses++; flash(120, true, true, true); capture::buttonPress(now); }
  }
}

static bool buttonDown() { return digitalRead(BUTTON_PIN) == LOW; }

// ---------- sleep ----------
static bool onUsb() { return NRF_POWER->USBREGSTATUS & POWER_USBREGSTATUS_VBUSDETECT_Msk; }

static void saveSettings();
static void goToSleep(const char* why);

// Called every loop. Never while on USB (charging or the serial monitor) or
// while a sync is running.
static void sleepCheck(bool syncing) {
  uint32_t now = millis();
  if (blelink::connected() || syncing || onUsb()) { lastActive = now; return; }
  uint32_t idle = now - lastActive;
  if (!roundActive && idle >= SLEEP_IDLE_MS) goToSleep("no phone connected for an hour");
  else if (roundActive && idle >= SLEEP_ROUND_IDLE_MS) {
    // Two hours with no swing, press or connection: the round is over (the
    // app ended it out of range, or it was left on). End it here too.
    roundLocked = false;
    setRound(false);
    goToSleep("round left on for two hours with nothing happening");
  }
}

// Everything off, then System OFF. The button (pull-up, sense low) wakes the
// nRF52, which starts again from reset: setup() runs as at power-on, the GPS
// leaves standby with its backup cell's data (a hot start) and the phone can
// connect again. Charging still works while asleep (the charger is hardware).
// Asleep: the nRF52 a few µA, GPS standby about 20 µA, flash about 1 µA.
static void goToSleep(const char* why) {
  if (Serial) { Serial.print("sleep: "); Serial.println(why); Serial.flush(); }
  if (roundActive) setRound(false);            // writes the session-end record
  saveSettings();
  for (int i = 0; i < 3; i++) {                // three slow purple flashes
    leds(true, false, true); delay(150);
    leds(false, false, false); delay(350);
  }
  blelink::stop();
  mic::end();
  imu::end();
  gnss::standby();
  store::sleep();
  // Release the QSPI pins and hold the flash's chip-select high (deselected),
  // so the chip stays in deep power-down through System OFF.
  NRF_QSPI->TASKS_DEACTIVATE = 1;
  delay(2);
  NRF_QSPI->ENABLE = 0;
  pinMode(PIN_QSPI_CS, OUTPUT);
  digitalWrite(PIN_QSPI_CS, HIGH);
  leds(false, false, false);
  delay(20);
  systemOff(BUTTON_PIN, LOW);                  // doesn't return
}

// ---------- control from the app ----------
static uint16_t u16(const uint8_t* p) { return p[0] | (p[1] << 8); }
static uint32_t u32(const uint8_t* p) { return p[0] | (p[1] << 8) | (p[2] << 16) | ((uint32_t)p[3] << 24); }

static void onControl(const uint8_t* d, uint16_t len) {
  switch (d[0]) {
    case OP_START_ROUND: roundRequest = 1; break;
    case OP_END_ROUND: roundRequest = 2; break;
    case OP_LOCK_ROUND: if (len >= 2) lockRequest = d[1] ? 1 : 2; break;
    case OP_SET_CAPTURE: if (len >= 2) capture::setEnabled(d[1] != 0); break;
    case OP_SYNC_FROM: syncRequest = len >= 3 ? u16(d + 1) : 0; break;
    case OP_STOP_SYNC: stopSyncRequest = true; break;
    case OP_ERASE_LOG: if (len >= 5) { eraseLogId = u32(d + 1); eraseRequest = true; } break;
    case OP_SET_TRIGGER: if (len >= 3) capture::setTrigger(u16(d + 1)); break;
    case OP_SET_SOUND_GATE: if (len >= 3) capture::setSoundGate(u16(d + 1)); break;
    case OP_SET_TIME:
      if (len >= 5) {
        phoneUnix = d[1] | (d[2] << 8) | (d[3] << 16) | ((uint32_t)d[4] << 24);
        phoneUnixAtMs = millis();
      }
      break;
    case OP_IDENTIFY: identifyUntil = millis() + 3000; break;
    case OP_SLEEP: sleepRequest = true; break;
    case OP_SET_RECORDING: if (len >= 2) recordRequest = d[1] ? 1 : 2; break;
  }
}

static void onAck(uint16_t seq) { lastAck = seq; }

// ---------- sync ----------
// Streams log records from a seq onwards as Data notifications:
// [seq u16][offset u16][record bytes], then a single 0xFF byte at the end.
static struct {
  bool active = false, haveHeader = false;
  uint32_t addr = 0, end = 0;
  uint16_t off = 0;
  store::Header h;
} syncState;

static void syncPoll() {
  if (stopSyncRequest) { stopSyncRequest = false; syncState.active = false; }
  if (syncRequest >= 0) {
    uint16_t from = (uint16_t)syncRequest;
    syncRequest = -1;
    syncState.active = true; syncState.haveHeader = false;
    syncState.addr = store::findSeq(from);
    syncState.end = store::endAddr();
  }
  if (!syncState.active) return;
  if (!blelink::connected()) { syncState.active = false; return; }
  if (!blelink::dataSubscribed()) return;
  static uint8_t pkt[248] __attribute__((aligned(4)));
  uint16_t dataMax = (blelink::dataPayload() - 4) & ~3u;
  for (int n = 0; n < 8; n++) {
    if (!syncState.haveHeader) {
      bool more = false;
      while (syncState.addr < syncState.end && store::header(syncState.addr, &syncState.h)) {
        if (syncState.h.kind != store::K_PAD) { more = true; break; }
        syncState.addr += syncState.h.len;
      }
      if (!more) {
        uint8_t endMark = 0xFF;
        if (blelink::sendData(&endMark, 1)) syncState.active = false;
        return;
      }
      syncState.haveHeader = true; syncState.off = 0;
    }
    uint32_t rest = syncState.h.len - syncState.off;
    uint16_t len = rest < dataMax ? rest : dataMax;
    pkt[0] = syncState.h.seq; pkt[1] = syncState.h.seq >> 8;
    pkt[2] = syncState.off; pkt[3] = syncState.off >> 8;
    if (!store::read(syncState.addr + syncState.off, pkt + 4, len)) { syncState.active = false; return; }
    if (!blelink::sendData(pkt, 4 + len)) return;        // queue full: carry on next loop
    syncState.off += len;
    if (syncState.off >= syncState.h.len) { syncState.addr += syncState.h.len; syncState.haveHeader = false; }
  }
}

static void handleRequests() {
  if (sleepRequest) {
    sleepRequest = false;
    if (!roundActive) { delay(300); goToSleep("asked by the app"); }   // let the write's reply go out
  }
  if (recordRequest) {
    motion::setRecording(recordRequest == 1);
    recordRequest = 0;
  }
  if (lockRequest) {
    bool on = lockRequest == 1;
    lockRequest = 0;
    if (on != roundLocked) { roundLocked = on; stateChanged = true; }
  }
  if (roundRequest) {
    bool on = roundRequest == 1;
    roundRequest = 0;
    if (!on && roundLocked) { roundLocked = false; stateChanged = true; }   // the app ended its round
    setRound(on);
  }
  if (eraseRequest) {
    eraseRequest = false;
    // Only the log the app has seen: its id must match.
    if (eraseLogId == store::logId()) {
      syncState.active = false;
      bool was = roundActive;
      if (was) setRound(false);
      store::eraseAll(nowUnix());
      if (was) setRound(true);           // a round in progress carries on in the new log
      Serial.println("capture log erased");
    }
  }
}

static CapturePacket capturePacket() {
  CapturePacket c = {};
  c.version = 1;
  c.flags = (capture::enabled() ? C_ENABLED : 0) | (roundActive ? C_SESSION : 0)
          | (capture::full() ? C_FULL : 0) | (syncState.active ? C_SYNCING : 0) | (store::ok() ? C_FLASH_OK : 0) | (roundLocked ? C_LOCKED : 0)
          | (motion::recording() ? C_RECORDING : 0);
  c.triggerDps = capture::trigger();
  c.logId = store::logId();
  c.nextSeq = store::nextSeq();
  c.swings = store::swings();
  c.labels = store::labels();
  c.usedKb = (store::used() + 1023) / 1024;
  c.totalKb = store::total() / 1024;
  uint32_t ov = imu::overruns();
  c.imuOverruns = ov > 65535 ? 65535 : ov;
  c.soundGate = capture::soundGate();
  c.gatedOut = capture::gatedOut();
  c.ignoredPresses = capture::ignoredPresses();
  c.rejects = capture::rejects();
  return c;
}

// ---------- capture settings, kept across restarts ----------
// Trigger, sound gate and capture on/off live in a small file on the
// internal flash, so a restart mid-round keeps round mode.
static const char* SETTINGS_FILE = "/capture.cfg";
// Version 2 (firmware 0.4.0) adds the round lock and whether a locked round
// was running, so a restart mid-round carries on with it.
struct Settings { uint8_t version; uint8_t enabled; uint16_t trigger; uint16_t gate; uint8_t locked; uint8_t inRound; uint16_t crc; } __attribute__((packed));

static void loadSettings() {
  if (!InternalFS.begin()) return;
  File f(InternalFS);
  if (!f.open(SETTINGS_FILE, FILE_O_READ)) return;
  Settings st;
  uint32_t n = f.read(&st, sizeof(st));
  f.close();
  if (n == 8) {                    // version 1: no lock fields
    uint8_t* b = (uint8_t*)&st;
    uint16_t crc = b[6] | (b[7] << 8);
    if (st.version != 1 || crc != store::crc16(b, 6)) return;
    st.locked = st.inRound = 0;
  } else if (n != sizeof(st) || st.version != 2 || st.crc != store::crc16((const uint8_t*)&st, sizeof(st) - 2)) return;
  capture::setEnabled(st.enabled);
  capture::setTrigger(st.trigger);
  capture::setSoundGate(st.gate);
  capture::takeSettingsChanged();
  roundLocked = st.locked;
  if (st.locked && st.inRound) setRound(true);   // restarted mid-round
  stateChanged = false;
}

static void saveSettings() {
  Settings st = { 2, (uint8_t)capture::enabled(), capture::trigger(), capture::soundGate(), (uint8_t)roundLocked, (uint8_t)roundActive, 0 };
  st.crc = store::crc16((const uint8_t*)&st, sizeof(st) - 2);
  InternalFS.remove(SETTINGS_FILE);
  File f(InternalFS);
  if (f.open(SETTINGS_FILE, FILE_O_WRITE)) { f.write((const uint8_t*)&st, sizeof(st)); f.close(); }
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
    else if (c == 'c') { capture::setEnabled(!capture::enabled()); Serial.println(capture::enabled() ? "capture on" : "capture off"); }
    else if (c == 'l') {
      Serial.printf("capture log %08lx: %u swings, %u labels, next seq %u, %lu of %lu KB, trigger %u dps, sound gate %u (%u dropped), last ack %u\n",
        (unsigned long)store::logId(), store::swings(), store::labels(), store::nextSeq(),
        (unsigned long)(store::used() / 1024), (unsigned long)(store::total() / 1024), capture::trigger(),
        capture::soundGate(), capture::gatedOut(), lastAck);
      Serial.printf("round %s%s, %u presses ignored as walking, %u reject records\n", roundActive ? "on" : "off",
        roundLocked ? " (locked by the app)" : "", capture::ignoredPresses(), capture::rejects());
      Serial.printf("imu %.1f Hz, %lu overruns, %lu realigns; mic envelope %.1f Hz\n",
        imu::rateHz(), (unsigned long)imu::overruns(), (unsigned long)imu::realigns(), mic::envRateHz());
    }
    else if (c == 'h' || c == '?') Serial.println("n: NMEA echo   p: pin check   c: capture on/off   l: capture log   h: help");
  }
}

// ---------- main ----------
// Start-up shows which step it's on, so a hang can be read off the LED:
//   red     USB serial, battery, GPS lines, pin check
//   green   Bluetooth (needs the SoftDevice from the bootloader)
//   blue    motion sensor (IMU)
//   yellow  microphone
// then the normal 2-second heartbeat. Stuck on one colour = that step hung.
static void stage(bool r, bool g, bool b, const char* what) {
  leds(r, g, b);
  if (Serial) { Serial.print("start: "); Serial.println(what); Serial.flush(); }
}

void setup() {
  // Woken from sleep by the button? (RESETREAS OFF bit: wake from System
  // OFF by a GPIO.) Read and clear before the SoftDevice starts.
  uint32_t reas = NRF_POWER->RESETREAS;
  NRF_POWER->RESETREAS = reas;
  wokeFromSleep = reas & POWER_RESETREAS_OFF_Msk;
  leds(true, false, false);
  Serial.begin(115200);
  uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 3000) delay(10);   // don't wait without USB
  stage(true, false, false, "battery, GPS lines, pin check");

  battery::begin();                     // first: puts VBAT_ENABLE LOW (Seeed's advice)
  gnss::begin();                        // holds the GNSS control lines HIGH
  busyPins = probePins();               // before the button pin gets its pull-up
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  // The press that woke it isn't a label: wait for it to be let go.
  if (wokeFromSleep) { uint32_t w = millis(); while (buttonDown() && millis() - w < 3000) delay(10); }

  // Bluetooth before the sensors, so the phone can connect even if one fails.
  stage(false, true, false, "Bluetooth");
  blelink::begin(onControl, onAck);

  stage(false, false, true, "motion sensor");
  bool imuOk = imu::begin();

  stage(true, true, false, "microphone");
  bool micOk = mic::begin();            // after BLE: PDM asks the SoftDevice for the HF clock

  stage(true, false, true, "flash storage");
  bool flashOk = store::begin(nowUnix());
  capture::begin(nowUnix);
  loadSettings();

  Serial.printf("\nGolf tracker firmware %d.%d.%d (protocol %d)\n", FW_MAJOR, FW_MINOR, FW_PATCH, PROTOCOL_VERSION);
  Serial.printf("IMU %s, mic %s, flash %s\n", imuOk ? "ok" : "NOT FOUND", micOk ? "ok" : "FAILED", flashOk ? "ok" : "FAILED");
  if (flashOk) Serial.printf("capture log %08lx: %u swings, %u labels, %lu KB used\n",
    (unsigned long)store::logId(), store::swings(), store::labels(), (unsigned long)(store::used() / 1024));
  printBusy();
  if (wokeFromSleep) Serial.println("woke from sleep (button)");
  Serial.println("Type h for commands.");
  leds(false, false, false);
  if (wokeFromSleep) {                         // two green flashes: awake
    for (int i = 0; i < 2; i++) { leds(false, true, false); delay(150); leds(false, false, false); delay(150); }
  }
  lastActive = millis();
}

void loop() {
  static uint32_t lastSecond = 0, lastBattery = 0, lastSaved = 0;
  imu::poll();
  gnss::poll(echoNmea ? &Serial : nullptr);
  handleRequests();
  capture::poll();
  motion::poll();
  syncPoll();
  static uint32_t changedAt = 0;
  if (capture::takeSettingsChanged() || stateChanged) { stateChanged = false; changedAt = millis() | 1; }
  if (changedAt && millis() - changedAt > 2000) { changedAt = 0; saveSettings(); }   // after the taps stop
  if (capture::lastSavedMs() != lastSaved) {      // a swing was saved: short magenta flash
    lastSaved = capture::lastSavedMs();
    lastActive = millis();
    flash(150, true, false, true);
  }
  updateButton();
  updateLeds();
  handleSerial();
  sleepCheck(syncState.active);

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
    s.recordCount = store::swings();    // Phase 3: swing snippets in the capture log
    s.fw[0] = FW_MAJOR; s.fw[1] = FW_MINOR; s.fw[2] = FW_PATCH;
    s.micLevel = micPeak >> 7;          // 0-255
    s.gyroPeak = gyro > 65535 ? 65535 : (uint16_t)gyro;
    s.busyPins = busyPins;

    LivePacket l = {};
    l.unix = nowUnix();
    if (f.quality > 0) { l.lat_e7 = f.lat_e7; l.lon_e7 = f.lon_e7; l.alt_dm = f.alt_dm; l.speed_cms = f.speed_cms; }

    blelink::publish(s, l);
    blelink::publishCapture(capturePacket());
    if (Serial && !echoNmea) printStatus(gyro, micPeak);
  }
  delay(2);                             // let the CPU idle between polls (IMU is 104 Hz)
}
