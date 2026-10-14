#include "store.h"
#include <assert.h>
uint8_t FLASH[1u << 21]; long badWrites=0, writes=0, erases=0, failAfterWrites=-1;
FICR_t ficr={{0x12345678,0}}; RTC_t rtc1={7};
static uint32_t t=1000; uint32_t millis(){return t+=3;} uint32_t micros(){return t*1000+17;} void delay(uint32_t){}
#define CHECK(c) do{ if(!(c)){ printf("FAIL line %d: %s\n", __LINE__, #c); exit(1);} }while(0)

// Re-run begin() as a fresh boot (static state is reset by re-including? no: call begin again).
int countValid(uint32_t* endOut, int* pads) {
  store::Header h; uint32_t a = 0; int n = 0; *pads = 0;
  while (store::header(a, &h)) {
    uint8_t buf[9000];
    store::read(a, buf, h.len);
    uint16_t crc = store::crc16(buf + 8, h.len - 8);
    if (h.kind == store::K_PAD) (*pads)++;
    else { CHECK(crc == h.crc); n++; }
    a += h.len;
  }
  *endOut = a; return n;
}

int main() {
  memset(FLASH, 0x5A, sizeof(FLASH));          // garbage, like an old log
  CHECK(store::begin(0));
  CHECK(store::records() == 0 && store::nextSeq() == 1);
  uint32_t id1 = store::logId();
  uint8_t body[7032]; for (int i=0;i<7032;i++) body[i]=i*7;
  uint8_t lab[24]; memset(lab, 3, 24);
  // Fill with swings and labels until full
  int sw=0, lb=0;
  while (store::hasRoom(7032)) { CHECK(store::append(store::K_SWING, body, 7032)); sw++; if (sw%3==0){ CHECK(store::append(store::K_LABEL, lab, 24)); lb++; } }
  printf("filled: %d swings, %d labels, used %u, badWrites %ld\n", sw, lb, store::used(), badWrites);
  CHECK(badWrites == 0);
  uint32_t end; int pads;
  CHECK(countValid(&end,&pads) == 1 + sw + lb);
  // Reboot: scan finds the same state
  uint16_t ns = store::nextSeq(); uint32_t used = store::used();
  CHECK(store::begin(0));
  CHECK(store::nextSeq() == ns && store::used() == used && store::swings() == sw && store::labels() == lb && store::logId() == id1);
  // findSeq
  store::Header h; uint32_t a = store::findSeq(10); CHECK(store::header(a,&h) && h.seq == 10);
  CHECK(store::findSeq(60000) == store::endAddr());
  // Erase: new id, empty, old data beyond doesn't leak into scan
  CHECK(store::eraseAll(123));
  CHECK(store::logId() != id1 && store::records() == 0 && store::used() == 20);
  CHECK(store::begin(0));
  CHECK(store::records() == 0 && store::used() == 20);
  for (int i=0;i<5;i++) CHECK(store::append(store::K_SWING, body, 7032));
  CHECK(store::begin(0) && store::swings() == 5);
  CHECK(countValid(&end,&pads) == 6 && pads == 0);
  CHECK(badWrites == 0);
  // Power loss in the middle of a swing write (body partly written, no header)
  for (int k = 1; k <= 28; k += 3) {
    failAfterWrites = k;
    store::append(store::K_SWING, body, 7032);
    failAfterWrites = -1;
    CHECK(store::begin(0));
    int before = store::swings();
    CHECK(store::append(store::K_SWING, body, 7032));
    CHECK(store::append(store::K_LABEL, lab, 24));
    CHECK(store::begin(0));
    CHECK(store::swings() == before + 1);
    int n = countValid(&end, &pads);
    CHECK(end == store::used());
  }
  printf("after torn writes: %d swings, %u used, badWrites %ld\n", store::swings(), store::used(), badWrites);
  CHECK(badWrites == 0);
  printf("store tests passed\n");
}
