// Pins and constants for the XIAO nRF52840 Sense + L76K GNSS board.
//
// Sources (checked Oct 2026):
// - Seeed non-mbed core, variants/Seeed_XIAO_nRF52840_Sense/variant.h:
//   IMU on Wire1 (SDA 17, SCL 16), IMU power 15, IMU INT1 18;
//   PDM mic power 19, clock 20, data 21; VBAT_ENABLE 14, PIN_VBAT 32;
//   charge-current select 22; ~CHG 23; LEDs red 11, blue 12, green 13
//   (active low: initVariant() turns them off by driving HIGH).
// - Seeed wiki, L76K GNSS for XIAO: NMEA on D6 (to module RX) / D7 (from
//   module TX) at 9600 baud; Seeed's own example drives D0 and D2 HIGH to keep
//   the module running, so both are GNSS control lines and must stay HIGH.
// - Seeed wiki, XIAO nRF52840: keep P0.14 (VBAT_ENABLE) LOW whenever the
//   battery is read and never HIGH while charging. Divider 1510/510.
#pragma once
#include <Arduino.h>

#ifndef FW_MAJOR
#define FW_MAJOR 0
#define FW_MINOR 1
#define FW_PATCH 0
#endif

#define PROTOCOL_VERSION 1

// GNSS board
static const uint8_t GNSS_CTRL_A = 0;   // D0, held HIGH (Seeed example)
static const uint8_t GNSS_CTRL_B = 2;   // D2, held HIGH (Seeed example)
static const uint32_t GNSS_BAUD = 9600;

// Shot / round button: one leg to this pin, the other to GND.
// D3 is free on the XIAO; the pin check at boot confirms nothing on the GNSS
// board drives it (see the serial log or the app's Tracker screen).
static const uint8_t BUTTON_PIN = 3;    // D3

// Pins checked at boot for anything external driving them.
static const uint8_t PROBE_PINS[] = {1, 3, 4, 5, 8, 9, 10};

// On-board
static const uint8_t PIN_CHG = 23;      // ~CHG, LOW while charging
static const uint8_t LED_R = LED_RED, LED_G = LED_GREEN, LED_B = LED_BLUE;

// Battery: ADC with the 3.0 V internal reference, 12-bit.
static const float VBAT_SCALE = 3000.0f / 4096.0f * 1510.0f / 510.0f; // mV per count
