#pragma once
#include <stdint.h>
#include <string.h>
#include <stdio.h>
#include <math.h>
#include <algorithm>
using std::min; using std::max;
uint32_t millis(); uint32_t micros(); void delay(uint32_t);
struct FICR_t { uint32_t DEVICEADDR[2]; }; extern FICR_t ficr; 
#define NRF_FICR (&ficr)
struct RTC_t { uint32_t COUNTER; }; extern RTC_t rtc1;
#define NRF_RTC1 (&rtc1)
#define LED_RED 11
#define LED_GREEN 13
#define LED_BLUE 12
struct Stream {};
