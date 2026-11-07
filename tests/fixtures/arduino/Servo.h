#pragma once
#include "Arduino.h"
class Servo {
 public:
  uint8_t attach(int pin);
  uint8_t attach(int pin, int min, int max);
  void detach();
  void write(int value);
  void writeMicroseconds(int value);
};
