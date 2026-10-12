#pragma once
#include <Arduino.h>

// BLE GATT service (docs/ble-protocol.md). Phase 2 has Status, Live and
// Control; Data and Ack arrive with shot sync.
struct StatusPacket {          // 20 bytes, little-endian
  uint8_t proto;
  uint8_t batteryPct;
  uint16_t batteryMv;
  uint8_t flags;
  uint8_t fixQuality;
  uint8_t sats;
  uint8_t buttonPresses;
  uint16_t hdop100;
  uint16_t recordCount;
  uint8_t fw[3];
  uint8_t micLevel;
  uint16_t gyroPeak;
  uint16_t busyPins;
} __attribute__((packed));
static_assert(sizeof(StatusPacket) == 20, "status is 20 bytes");

struct LivePacket {            // 16 bytes, little-endian
  uint32_t unix;
  int32_t lat_e7;
  int32_t lon_e7;
  int16_t alt_dm;
  uint16_t speed_cms;
} __attribute__((packed));
static_assert(sizeof(LivePacket) == 16, "live is 16 bytes");

enum StatusFlag : uint8_t {
  F_CHARGING = 1 << 0, F_ROUND = 1 << 1, F_GPS_DATA = 1 << 2, F_GPS_FIX = 1 << 3,
  F_IMU_OK = 1 << 4, F_MIC_OK = 1 << 5, F_TIME_OK = 1 << 6, F_BUTTON_DOWN = 1 << 7,
};

enum ControlOp : uint8_t {
  OP_START_ROUND = 0x01, OP_END_ROUND = 0x02, OP_SET_TIME = 0x03, OP_IDENTIFY = 0x04,
};

typedef void (*ControlHandler)(const uint8_t* data, uint16_t len);

namespace blelink {
  void begin(ControlHandler onControl);
  bool connected();
  void publish(const StatusPacket& s, const LivePacket& l);  // set values, notify if subscribed
}
