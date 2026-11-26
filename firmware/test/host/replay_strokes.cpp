// Feeds a recording (about 52 Hz rows) through stroke.cpp and prints the
// candidates as CSV, to check the firmware detector against the analysis
// (analysis/shortgame/strokes.py writes the rows, builds and runs this).
// Row, 20 bytes little-endian: int16 gx gy gz ax ay az (raw counts), uint8
// high, uint8 low (√ sound), 2 bytes padding, float32 time in ms.
#include "../../src/stroke.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void print(const stroke::Candidate& c) {
  printf("%.1f,%.2f,%.2f,%.0f,%.2f,%.2f,%.2f,%.2f,%u,%u,%d,%d,%d\n", c.tMs, c.peak, c.area, c.durMs, c.pre, c.post,
         c.other, c.neg, c.high, c.low, c.grav[0], c.grav[1], c.grav[2]);
}

int main(int argc, char** argv) {
  if (argc < 3) { fprintf(stderr, "usage: replay_strokes rows.bin hz\n"); return 2; }
  FILE* f = fopen(argv[1], "rb");
  if (!f) { perror(argv[1]); return 1; }
  stroke::reset((float)atof(argv[2]));
  stroke::setOutput(print);
  printf("t_ms,peak,area,dur_ms,pre,post,other,neg,high,low,gx,gy,gz\n");
  unsigned char row[20];
  while (fread(row, 1, 20, f) == 20) {
    int16_t s[6];
    for (int i = 0; i < 6; i++) s[i] = (int16_t)(row[2 * i] | (row[2 * i + 1] << 8));
    float t;
    memcpy(&t, row + 16, 4);
    stroke::feed(s, row[12], row[13], t);
  }
  fclose(f);
  return 0;
}
