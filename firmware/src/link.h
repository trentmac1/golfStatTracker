#pragma once
#include <Arduino.h>

// BLE GATT service (docs/ble-protocol.md): Status, Live and Control since
// Phase 2; Data, Ack and Capture for syncing the capture log (Phase 3).
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

struct CapturePacket {         // 20 bytes, little-endian
  uint8_t version;             // 1
  uint8_t flags;               // CaptureFlag
  uint16_t triggerDps;
  uint32_t logId;
  uint16_t nextSeq;
  uint16_t swings;
  uint16_t labels;
  uint16_t usedKb;
  uint16_t totalKb;
  uint16_t imuOverruns;
} __attribute__((packed));
static_assert(sizeof(CapturePacket) == 20, "capture is 20 bytes");

enum CaptureFlag : uint8_t {
  C_ENABLED = 1 << 0, C_SESSION = 1 << 1, C_FULL = 1 << 2, C_SYNCING = 1 << 3, C_FLASH_OK = 1 << 4,
};

enum ControlOp : uint8_t {
  OP_START_ROUND = 0x01, OP_END_ROUND = 0x02, OP_SET_TIME = 0x03, OP_IDENTIFY = 0x04,
  OP_SET_CAPTURE = 0x05,
  OP_SYNC_FROM = 0x10, OP_ERASE_LOG = 0x11, OP_STOP_SYNC = 0x12,
  OP_SET_TRIGGER = 0x20,
};

typedef void (*ControlHandler)(const uint8_t* data, uint16_t len);
typedef void (*AckHandler)(uint16_t seq);

namespace blelink {
  void begin(ControlHandler onControl, AckHandler onAck);
  bool connected();
  void publish(const StatusPacket& s, const LivePacket& l);  // set values, notify if subscribed
  void publishCapture(const CapturePacket& c);
  bool dataSubscribed();       // connected, with Data notifications on
  uint16_t dataPayload();      // bytes per Data notification (MTU − 3)
  bool sendData(const uint8_t* d, uint16_t len);   // false if the queue is full; try again later
}
