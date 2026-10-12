#include "link.h"
#include <bluefruit.h>

// Base UUID 7a1e0000-3c5b-4f0e-9a52-6b8d2f4c1e90; the 16-bit part picks the
// characteristic. Bluefruit wants the bytes least-significant first and keeps
// a pointer, so these arrays must stay alive.
#define GT_UUID(lo) { 0x90, 0x1e, 0x4c, 0x2f, 0x8d, 0x6b, 0x52, 0x9a, 0x0e, 0x4f, 0x5b, 0x3c, lo, 0x00, 0x1e, 0x7a }
static const uint8_t UUID_SERVICE[16] = GT_UUID(0x01);
static const uint8_t UUID_STATUS[16]  = GT_UUID(0x02);
static const uint8_t UUID_CONTROL[16] = GT_UUID(0x03);
static const uint8_t UUID_LIVE[16]    = GT_UUID(0x06);

static BLEService svc(UUID_SERVICE);
static BLECharacteristic chrStatus(UUID_STATUS);
static BLECharacteristic chrControl(UUID_CONTROL);
static BLECharacteristic chrLive(UUID_LIVE);
static BLEDis dis;
static ControlHandler handler = nullptr;
static volatile bool isConnected = false;

static void onConnect(uint16_t) { isConnected = true; }
static void onDisconnect(uint16_t, uint8_t) { isConnected = false; }
static void onWrite(uint16_t, BLECharacteristic*, uint8_t* data, uint16_t len) {
  if (handler && len) handler(data, len);
}

void blelink::begin(ControlHandler onControl) {
  handler = onControl;
  Bluefruit.autoConnLed(false);          // we drive the LEDs ourselves
  Bluefruit.begin();
  Bluefruit.setTxPower(4);
  Bluefruit.setName("Golf Tracker");
  Bluefruit.Periph.setConnectCallback(onConnect);
  Bluefruit.Periph.setDisconnectCallback(onDisconnect);

  dis.setManufacturer("golfStatTracker");
  dis.setModel("XIAO nRF52840 Sense + L76K");
  static char fw[12];
  snprintf(fw, sizeof(fw), "%d.%d.%d", FW_MAJOR, FW_MINOR, FW_PATCH);
  dis.setFirmwareRev(fw);
  dis.begin();

  svc.begin();
  chrStatus.setProperties(CHR_PROPS_READ | CHR_PROPS_NOTIFY);
  chrStatus.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  chrStatus.setFixedLen(sizeof(StatusPacket));
  chrStatus.begin();

  chrLive.setProperties(CHR_PROPS_READ | CHR_PROPS_NOTIFY);
  chrLive.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  chrLive.setFixedLen(sizeof(LivePacket));
  chrLive.begin();

  chrControl.setProperties(CHR_PROPS_WRITE | CHR_PROPS_WRITE_WO_RESP);
  chrControl.setPermission(SECMODE_NO_ACCESS, SECMODE_OPEN);
  chrControl.setMaxLen(20);
  chrControl.setWriteCallback(onWrite);
  chrControl.begin();

  // The 128-bit service UUID fills most of the 31-byte advert, so the name
  // goes in the scan response.
  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addService(svc);
  Bluefruit.ScanResponse.addName();
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(160, 1600);   // 100 ms fast, then 1 s (0.625 ms units)
  Bluefruit.Advertising.setFastTimeout(30);
  Bluefruit.Advertising.start(0);
}

bool blelink::connected() { return isConnected; }

void blelink::publish(const StatusPacket& s, const LivePacket& l) {
  chrStatus.write(&s, sizeof(s));
  chrLive.write(&l, sizeof(l));
  if (!isConnected) return;
  if (chrStatus.notifyEnabled()) chrStatus.notify(&s, sizeof(s));
  if (chrLive.notifyEnabled()) chrLive.notify(&l, sizeof(l));
}
