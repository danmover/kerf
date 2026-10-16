#pragma once
#include "Arduino.h"
class Servo {
 public:
  uint8_t attach(int pin);
  void write(int value);
  void writeMicroseconds(int value);
};
