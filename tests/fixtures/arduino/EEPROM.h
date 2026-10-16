#pragma once
#include "Arduino.h"
struct EEPROMClass {
  uint8_t read(int idx);
  void write(int idx, uint8_t val);
  void update(int idx, uint8_t val);
  uint16_t length();
  template <typename T> T &get(int idx, T &t) { (void)idx; return t; }
  template <typename T> const T &put(int idx, const T &t) { (void)idx; return t; }
};
extern EEPROMClass EEPROM;
