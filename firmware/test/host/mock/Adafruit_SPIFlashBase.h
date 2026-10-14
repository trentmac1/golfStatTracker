#pragma once
#include <stdint.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
struct SPIFlash_Device_t { uint32_t total_size; };
#define P25Q16H { (1u << 21) }
struct Adafruit_FlashTransport_QSPI { bool runCommand(uint8_t) { return true; } };
extern uint8_t FLASH[1u << 21];
extern long badWrites, writes, erases;
extern long failAfterWrites;   // simulate power loss: stop writing after N write calls
struct Adafruit_SPIFlashBase {
  Adafruit_SPIFlashBase(Adafruit_FlashTransport_QSPI*) {}
  bool begin(const SPIFlash_Device_t*, size_t) { return true; }
  uint32_t size() { return 1u << 21; }
  uint32_t readBuffer(uint32_t a, uint8_t* b, uint32_t n) {
    if (a % 4 || a + n > size()) { badWrites++; return 0; }
    memcpy(b, FLASH + a, n); return n; }
  uint32_t writeBuffer(uint32_t a, const uint8_t* b, uint32_t n) {
    if (a % 4 || n % 4 || a + n > size()) { badWrites++; return 0; }
    if (failAfterWrites == 0) return 0;
    if (failAfterWrites > 0) failAfterWrites--;
    writes++;
    for (uint32_t i = 0; i < n; i++) {
      if ((FLASH[a + i] & b[i]) != b[i]) { badWrites++; }
      FLASH[a + i] &= b[i];
    }
    return n; }
  bool eraseSector(uint32_t s) { if (failAfterWrites == 0) return false; erases++; memset(FLASH + s * 4096, 0xFF, 4096); return true; }
};
