#pragma once
#include <Arduino.h>

// ---- IMU (LSM6DS3TR-C on Wire1) ----
namespace imu {
  bool begin();                 // powers the IMU, checks WHO_AM_I, 104 Hz, ±16 g, ±2000 dps
  void poll();                  // call often; reads new samples
  bool ok();
  float takePeakGyro();         // peak |gyro| (deg/s) since the last call
  float lastAccelG();           // |accel| of the latest sample, in g
}

// ---- PDM microphone ----
namespace mic {
  bool begin();                 // 16 kHz mono
  bool ok();
  uint16_t takePeak();          // peak |sample| since the last call (0-32767)
}

// ---- Battery ----
namespace battery {
  void begin();
  void update();                // averages a few readings; call every few seconds
  uint16_t millivolts();
  uint8_t percent();
  bool charging();
}

// ---- L76K GNSS (NMEA over Serial1) ----
namespace gnss {
  struct Fix {
    uint8_t quality = 0;        // GGA fix quality: 0 none, 1 GPS, 2 DGPS
    uint8_t sats = 0;           // satellites used
    uint16_t hdop100 = 0xFFFF;  // HDOP × 100, 0xFFFF unknown
    int32_t lat_e7 = 0, lon_e7 = 0;
    int16_t alt_dm = 0;         // altitude, decimetres
    uint16_t speed_cms = 0;     // ground speed from RMC, cm/s
    uint32_t unix = 0;          // UTC seconds from RMC, 0 until known
    uint32_t unixAtMs = 0;      // millis() when `unix` was read
    uint32_t lastSentenceMs = 0;
    uint32_t sentences = 0, badChecksums = 0;
  };
  void begin();
  void poll(Stream* echo);      // read and parse; echo raw NMEA if non-null
  const Fix& fix();
  bool hasData();               // valid NMEA in the last 3 s
}

// ---- Pin check ----
// Each pin is read with the internal pull-up and then pull-down, several
// times. A floating pin follows the pull; a pin driven by something else
// reads the same both ways. Returns a mask with bit n set for Dn busy.
uint16_t probePins();
