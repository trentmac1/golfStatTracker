#pragma once
#include <Arduino.h>

// Append-only record log on the XIAO's 2 MB QSPI flash (Puya P25Q16H).
// Format: docs/ble-protocol.md, "Capture log". Every record starts with an
// 8-byte header and is a multiple of 4 bytes long (the nRF52 QSPI reads and
// writes whole words). A record's body is written before its header, so a
// record cut off by a reset never has a header and is skipped at the next
// start-up.
namespace store {
  enum Kind : uint8_t {
    K_LOG_START = 1, K_SESSION_START = 2, K_SESSION_END = 3, K_SWING = 4, K_LABEL = 5,
    K_PAD = 0xFE,                // filler after a cut-off write; never synced
  };

  struct Header {                // 8 bytes, little-endian
    uint8_t kind;
    uint8_t version;             // 1
    uint16_t len;                // whole record including this header, multiple of 4
    uint16_t seq;                // 0 for the log-start record, then +1 per record
    uint16_t crc;                // CRC-16/CCITT-FALSE of the bytes after the header
  } __attribute__((packed));
  static_assert(sizeof(Header) == 8, "header is 8 bytes");

  const uint32_t MAX_RECORD = 8192;

  bool begin(uint32_t unixNow);  // start the flash and find the end of the log
  bool ok();
  uint32_t logId();
  uint16_t nextSeq();
  uint16_t records();            // records after the log-start record
  uint16_t swings();
  uint16_t labels();
  uint32_t used();               // bytes
  uint32_t total();              // bytes
  bool hasRoom(uint32_t len);

  // body: the bytes after the header (len need not be a multiple of 4).
  bool append(uint8_t kind, const uint8_t* body, uint32_t len, uint16_t* seqOut = nullptr);
  bool eraseAll(uint32_t unixNow); // a new, empty log with a new id

  // Reading, for sync. `addr` 0 is the log-start record.
  uint32_t endAddr();
  bool header(uint32_t addr, Header* h);    // false at the end of the log
  bool read(uint32_t addr, uint8_t* buf, uint32_t len);  // addr and len multiples of 4
  uint32_t findSeq(uint16_t seq);           // first record with seq >= `seq`, or endAddr()

  uint16_t crc16(const uint8_t* d, uint32_t n, uint16_t crc = 0xFFFF);
}
