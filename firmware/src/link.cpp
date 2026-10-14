#include "link.h"
#include <bluefruit.h>

// Base UUID 7a1e0000-3c5b-4f0e-9a52-6b8d2f4c1e90; the 16-bit part picks the
// characteristic. Bluefruit wants the bytes least-significant first and keeps
// a pointer, so these arrays must stay alive.
#define GT_UUID(lo) { 0x90, 0x1e, 0x4c, 0x2f, 0x8d, 0x6b, 0x52, 0x9a, 0x0e, 0x4f, 0x5b, 0x3c, lo, 0x00, 0x1e, 0x7a }
static const uint8_t UUID_SERVICE[16] = GT_UUID(0x01);
static const uint8_t UUID_STATUS[16]  = GT_UUID(0x02);
static const uint8_t UUID_CONTROL[16] = GT_UUID(0x03);
static const uint8_t UUID_DATA[16]    = GT_UUID(0x04);
static const uint8_t UUID_ACK[16]     = GT_UUID(0x05);
static const uint8_t UUID_LIVE[16]    = GT_UUID(0x06);
static const uint8_t UUID_CAPTURE[16] = GT_UUID(0x07);

static BLEService svc(UUID_SERVICE);
static BLECharacteristic chrStatus(UUID_STATUS);
static BLECharacteristic chrControl(UUID_CONTROL);
static BLECharacteristic chrLive(UUID_LIVE);
static BLECharacteristic chrData(UUID_DATA);
static BLECharacteristic chrAck(UUID_ACK);
static BLECharacteristic chrCapture(UUID_CAPTURE);
static BLEDis dis;
static ControlHandler handler = nullptr;
static AckHandler ackHandler = nullptr;
static volatile bool isConnected = false;
static volatile uint16_t connHandle = BLE_CONN_HANDLE_INVALID;

static void onConnect(uint16_t h) { isConnected = true; connHandle = h; }
static void onDisconnect(uint16_t, uint8_t) { isConnected = false; connHandle = BLE_CONN_HANDLE_INVALID; }
static void onWrite(uint16_t, BLECharacteristic*, uint8_t* data, uint16_t len) {
  if (handler && len) handler(data, len);
}
static void onAckWrite(uint16_t, BLECharacteristic*, uint8_t* data, uint16_t len) {
  if (ackHandler && len >= 2) ackHandler(data[0] | (data[1] << 8));
}

void blelink::begin(ControlHandler onControl, AckHandler onAck) {
  handler = onControl;
  ackHandler = onAck;
  Bluefruit.autoConnLed(false);          // we drive the LEDs ourselves
  // Bigger MTU and more queued notifications, for syncing the capture log.
  Bluefruit.configPrphBandwidth(BANDWIDTH_MAX);
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

  chrData.setProperties(CHR_PROPS_NOTIFY);
  chrData.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  chrData.setMaxLen(244);
  chrData.begin();

  chrAck.setProperties(CHR_PROPS_WRITE | CHR_PROPS_WRITE_WO_RESP);
  chrAck.setPermission(SECMODE_NO_ACCESS, SECMODE_OPEN);
  chrAck.setMaxLen(4);
  chrAck.setWriteCallback(onAckWrite);
  chrAck.begin();

  chrCapture.setProperties(CHR_PROPS_READ | CHR_PROPS_NOTIFY);
  chrCapture.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  chrCapture.setFixedLen(sizeof(CapturePacket));
  chrCapture.begin();

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

void blelink::publishCapture(const CapturePacket& c) {
  chrCapture.write(&c, sizeof(c));
  if (isConnected && chrCapture.notifyEnabled()) chrCapture.notify(&c, sizeof(c));
}

bool blelink::dataSubscribed() { return isConnected && chrData.notifyEnabled(); }

uint16_t blelink::dataPayload() {
  BLEConnection* c = isConnected ? Bluefruit.Connection(connHandle) : nullptr;
  uint16_t mtu = c ? c->getMtu() : 23;
  uint16_t n = mtu > 3 ? mtu - 3 : 20;
  return n > 244 ? 244 : n;
}

bool blelink::sendData(const uint8_t* d, uint16_t len) {
  if (!dataSubscribed()) return false;
  return chrData.notify(d, len);
}
