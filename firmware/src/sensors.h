#pragma once
#include <Arduino.h>

// ---- IMU (LSM6DS3TR-C on Wire1) ----
// 208 Hz, ±16 g, ±2000 dps, streamed through the IMU's own 4 KB FIFO (about
// 1.6 s of samples), so a slow flash write or Bluetooth send doesn't lose any.
// Raw sample order handed to the sink: gx, gy, gz, ax, ay, az.
namespace imu {
  const float GYRO_DPS_PER_LSB = 0.070f;     // ±2000 dps
  const float ACC_G_PER_LSB = 0.000488f;     // ±16 g
  typedef void (*Sink)(const int16_t raw[6], uint32_t index);
  bool begin();                 // powers the IMU, checks WHO_AM_I, starts the FIFO
  void setSink(Sink s);         // called for every sample, in order
  void poll();                  // call at least every second; drains the FIFO
  bool ok();
  float takePeakGyro();         // peak |gyro| (deg/s) since the last call
  float lastAccelG();           // |accel| of the latest sample, in g
  uint32_t count();             // samples read since start-up
  float sampleMs(uint32_t index); // estimated millis() when sample `index` was taken
  float rateHz();               // measured output rate (nominally 208)
  uint32_t overruns();          // times the FIFO filled before it was read
  uint32_t realigns();          // times the read had to skip to a sample boundary
}

// ---- PDM microphone ----
// 16 kHz mono. Besides the peak level, keeps a high-passed (about 2 kHz)
// envelope: the peak |sample| of every 16 samples, so about 1000 values a
// second, in a ring of the last 2.5 s.
namespace mic {
  bool begin();
  bool ok();
  uint16_t takePeak();          // peak |sample| since the last call (0-32767)
  uint32_t envCount();          // envelope values produced since start-up
  uint32_t envLastMs();         // millis() at the newest envelope value
  uint16_t envAt(uint32_t index); // 0 if no longer in the ring
  float envRateHz();            // measured envelope rate (about 1000)
  const uint32_t ENV_RING = 2560;
  // Low band (firmware 0.3.3): the same samples band-passed to about
  // 50-370 Hz, peak |y| of each 64 samples (4 envelope values), so a ball's
  // sharp click and a dull thud through fabric can be told apart. Low value
  // k covers envelope values 4k..4k+3.
  const uint32_t LOW_RING = 640, LOW_PER = 4;
  uint32_t lowCount();
  uint16_t lowAt(uint32_t index); // 0 if no longer in the ring
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
