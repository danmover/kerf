#pragma once
#include "Arduino.h"
class TwoWire {
 public:
  void begin();
  void beginTransmission(uint8_t address);
  uint8_t endTransmission(bool sendStop = true);
  uint8_t requestFrom(uint8_t address, uint8_t quantity);
  size_t write(uint8_t);
  int read();
  int available();
};
extern TwoWire Wire;
