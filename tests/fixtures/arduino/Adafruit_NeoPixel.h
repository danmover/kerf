// Minimal stand-in for Adafruit's NeoPixel library, used only to compile-check generated sketches in Kerf's tests.
// Declarations only, with the library's own signatures.
#pragma once
#include <stdint.h>

#define NEO_RGB ((0 << 6) | (0 << 4) | (1 << 2) | (2))
#define NEO_GRB ((1 << 6) | (1 << 4) | (0 << 2) | (2))
#define NEO_GRBW ((3 << 6) | (1 << 4) | (0 << 2) | (2))
#define NEO_KHZ800 0x0000
#define NEO_KHZ400 0x0100

typedef uint16_t neoPixelType;

class Adafruit_NeoPixel {
 public:
  Adafruit_NeoPixel(uint16_t n, int16_t pin = 6, neoPixelType type = NEO_GRB + NEO_KHZ800);
  void begin(void);
  void show(void);
  void clear(void);
  void setBrightness(uint8_t b);
  void setPixelColor(uint16_t n, uint32_t c);
  void setPixelColor(uint16_t n, uint8_t r, uint8_t g, uint8_t b);
  uint32_t getPixelColor(uint16_t n) const;
  uint16_t numPixels(void) const;
  static uint32_t Color(uint8_t r, uint8_t g, uint8_t b);
  static uint32_t ColorHSV(uint16_t hue, uint8_t sat = 255, uint8_t val = 255);
  static uint8_t sine8(uint8_t x);
  static uint8_t gamma8(uint8_t x);
  static uint32_t gamma32(uint32_t x);
};
