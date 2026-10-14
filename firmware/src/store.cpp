#include "store.h"
#include "config.h"
#include <Adafruit_SPIFlashBase.h>

// The flash chip isn't in the library's default list, so pass its settings
// (P25Q16H, from the library's flash_devices.h; the variant names this chip
// in EXTERNAL_FLASH_DEVICES and gives the QSPI pins).
static Adafruit_FlashTransport_QSPI transport;   // PIN_QSPI_* from the variant
static Adafruit_SPIFlashBase flash(&transport);
static const SPIFlash_Device_t CHIP = P25Q16H;

static const uint32_t SECTOR = 4096;
static bool good = false;
static uint32_t endA = 0, id = 0;
static uint16_t seqNext = 1, nRecords = 0, nSwings = 0, nLabels = 0;
static uint8_t scratch[256] __attribute__((aligned(4)));

uint16_t store::crc16(const uint8_t* d, uint32_t n, uint16_t crc) {
  while (n--) {
    crc ^= (uint16_t)(*d++) << 8;
    for (int i = 0; i < 8; i++) crc = (crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1;
  }
  return crc;
}

bool store::read(uint32_t addr, uint8_t* buf, uint32_t len) {
  return good && flash.readBuffer(addr, buf, len) == len;
}

static bool writeRaw(uint32_t addr, const uint8_t* buf, uint32_t len) {
  return flash.writeBuffer(addr, buf, len) == len;
}

static bool eraseSectorAt(uint32_t addr) {
  if (addr >= store::total()) return true;
  return flash.eraseSector(addr / SECTOR);
}

bool store::header(uint32_t addr, Header* h) {
  if (!good || addr + sizeof(Header) > total()) return false;
  if (flash.readBuffer(addr, (uint8_t*)h, sizeof(Header)) != sizeof(Header)) return false;
  if (h->kind == 0xFF) return false;
  return h->len >= sizeof(Header) && h->len % 4 == 0 && addr + h->len <= total()
      && h->len <= MAX_RECORD + SECTOR * 2;
}

// Writes header + body at endA, erasing each sector as the log enters it, so
// the byte after the last record is always in an erased sector.
static bool appendAt(uint8_t kind, const uint8_t* body, uint32_t len, uint16_t seq) {
  uint32_t full = (sizeof(store::Header) + len + 3) & ~3u;
  uint32_t a = endA;
  if (a + full > store::total()) return false;
  for (uint32_t s = (a / SECTOR + 1) * SECTOR; s < a + full; s += SECTOR)
    if (!eraseSectorAt(s)) return false;

  store::Header h = { kind, 1, (uint16_t)full, seq, 0 };
  // CRC over the body as stored, including the 0xFF padding to a whole word.
  uint16_t crc = store::crc16(body, len);
  static const uint8_t ff[3] = { 0xFF, 0xFF, 0xFF };
  crc = store::crc16(ff, full - sizeof(h) - len, crc);
  h.crc = crc;

  // Body first (word aligned: copy through scratch), header last.
  uint32_t off = 0;
  while (off < len) {
    uint32_t n = min((uint32_t)sizeof(scratch), len - off);
    uint32_t n4 = (n + 3) & ~3u;
    memcpy(scratch, body + off, n);
    memset(scratch + n, 0xFF, n4 - n);
    if (!writeRaw(a + sizeof(h) + off, scratch, n4)) return false;
    off += n;
  }
  memcpy(scratch, &h, sizeof(h));
  if (!writeRaw(a, scratch, sizeof(h))) return false;
  endA = a + full;
  if (endA % SECTOR == 0) eraseSectorAt(endA);
  return true;
}

static bool writeLogStart(uint32_t unixNow) {
  // A new id each time the log is erased, so the app knows its sync point
  // (the last seq it has) belongs to an older log.
  id = NRF_FICR->DEVICEADDR[0] ^ (micros() * 2654435761u) ^ (unixNow * 40503u) ^ NRF_RTC1->COUNTER;
  if (id == 0 || id == 0xFFFFFFFF) id = 1;
  uint8_t body[12];
  memcpy(body, &id, 4);
  memcpy(body + 4, &unixNow, 4);
  body[8] = FW_MAJOR; body[9] = FW_MINOR; body[10] = FW_PATCH; body[11] = PROTOCOL_VERSION;
  endA = 0;
  seqNext = 1; nRecords = 0; nSwings = 0; nLabels = 0;
  return appendAt(store::K_LOG_START, body, sizeof(body), 0);
}

bool store::eraseAll(uint32_t unixNow) {
  if (!good) return false;
  if (!flash.eraseSector(0)) return false;
  return writeLogStart(unixNow);
}

bool store::begin(uint32_t unixNow) {
  good = flash.begin(&CHIP, 1);
  if (!good) return false;

  // Walk the headers to the end of the log.
  Header h;
  uint32_t a = 0;
  bool started = header(0, &h) && h.kind == K_LOG_START && h.len == 20;
  if (started) {
    uint8_t body[12];
    read(sizeof(Header), body, 12);
    memcpy(&id, body, 4);
    a = h.len;
    while (header(a, &h)) {
      if (h.kind != K_PAD) {
        nRecords++;
        if (h.kind == K_SWING) nSwings++;
        if (h.kind == K_LABEL) nLabels++;
        seqNext = h.seq + 1;
      }
      a += h.len;
    }
  }
  if (!started) return eraseAll(unixNow);

  // A write cut off by a reset leaves body bytes but no header at `a`. Check
  // the rest of this sector; if anything is written there, skip to a fresh
  // sector with a filler record.
  uint32_t sectorEnd = (a / SECTOR + 1) * SECTOR;
  uint32_t dirtyEnd = 0;
  for (uint32_t p = a; p < sectorEnd && p < total(); p += sizeof(scratch)) {
    uint32_t n = min((uint32_t)sizeof(scratch), sectorEnd - p);
    if (!read(p, scratch, n)) break;
    for (uint32_t i = 0; i < n; i++) if (scratch[i] != 0xFF) dirtyEnd = p + i + 1;
  }
  endA = a;
  if (dirtyEnd) {
    uint32_t b = sectorEnd;
    if (b + MAX_RECORD > total()) { endA = total(); return true; }   // treat as full
    eraseSectorAt(b);
    Header pad = { K_PAD, 1, (uint16_t)(b - a), 0xFFFF, 0 };
    memcpy(scratch, &pad, sizeof(pad));
    // The header slot may itself be written; then the log simply ends here.
    uint8_t cur[8] __attribute__((aligned(4)));
    if (read(a, cur, 8)) {
      bool blank = true;
      for (int i = 0; i < 8; i++) if (cur[i] != 0xFF) blank = false;
      if (blank && writeRaw(a, scratch, sizeof(pad))) endA = b;
      else endA = total();
    }
  }
  return true;
}

bool store::ok() { return good; }
uint32_t store::logId() { return id; }
uint16_t store::nextSeq() { return seqNext; }
uint16_t store::records() { return nRecords; }
uint16_t store::swings() { return nSwings; }
uint16_t store::labels() { return nLabels; }
uint32_t store::used() { return endA; }
uint32_t store::total() { return good ? flash.size() : 0; }
uint32_t store::endAddr() { return endA; }
bool store::hasRoom(uint32_t len) { return good && endA + sizeof(Header) + len + 4 <= total(); }

bool store::append(uint8_t kind, const uint8_t* body, uint32_t len, uint16_t* seqOut) {
  if (!good || !hasRoom(len)) return false;
  uint16_t seq = seqNext;
  if (!appendAt(kind, body, len, seq)) return false;
  seqNext++; nRecords++;
  if (kind == K_SWING) nSwings++;
  if (kind == K_LABEL) nLabels++;
  if (seqOut) *seqOut = seq;
  return true;
}

uint32_t store::findSeq(uint16_t seq) {
  Header h;
  uint32_t a = 0;
  while (a < endA && header(a, &h)) {
    if (h.kind != K_PAD && h.seq >= seq) return a;
    a += h.len;
  }
  return endA;
}
