// Minimal stand-in for the Arduino core, used only to compile-check generated
// sketches in Kerf's tests (host g++ and clang --target=avr). Declarations only.
#pragma once
#include <stdint.h>
#include <stddef.h>

extern "C" {
long strtol(const char *s, char **end, int base);
double atan2(double y, double x);
double sqrt(double x);
double tan(double x);
double fabs(double x);
double sin(double x);
double cos(double x);
double acos(double x);
double atof(const char *s);
int strcmp(const char *a, const char *b);
}
#include <avr/pgmspace.h>

#define HIGH 0x1
#define LOW 0x0
#define INPUT 0x0
#define OUTPUT 0x1
#define INPUT_PULLUP 0x2
#define CHANGE 1
#define RISING 3
#define DEG_TO_RAD 0.017453292519943295
#define RAD_TO_DEG 57.29577951308232
#ifndef ARDUINO_ARCH_AVR
#define ARDUINO_ARCH_AVR 1
#endif
#define LED_BUILTIN 13
static const uint8_t A0 = 14, A1 = 15, A2 = 16, A3 = 17, A4 = 18, A5 = 19, A6 = 20, A7 = 21;

#define constrain(amt, low, high) ((amt) < (low) ? (low) : ((amt) > (high) ? (high) : (amt)))
#define abs(x) ((x) > 0 ? (x) : -(x))

typedef bool boolean;
typedef uint8_t byte;

void pinMode(uint8_t pin, uint8_t mode);
void digitalWrite(uint8_t pin, uint8_t val);
int digitalRead(uint8_t pin);
int analogRead(uint8_t pin);
void analogWrite(uint8_t pin, int val);
unsigned long millis(void);
long random(long howbig);
long random(long howsmall, long howbig);
void randomSeed(unsigned long seed);
unsigned long micros(void);
void delay(unsigned long ms);
void attachInterrupt(uint8_t num, void (*fn)(void), int mode);
#define digitalPinToInterrupt(p) ((p) == 2 ? 0 : ((p) == 3 ? 1 : -1))
void noInterrupts();
void interrupts();

class __FlashStringHelper;
#define F(s) (reinterpret_cast<const __FlashStringHelper *>(s))

class HardwareSerial {
 public:
  void begin(unsigned long baud);
  int available();
  int read();
  size_t print(const __FlashStringHelper *);
  size_t print(const char *);
  size_t print(char);
  size_t print(int, int = 10);
  size_t print(unsigned int, int = 10);
  size_t print(long, int = 10);
  size_t print(unsigned long, int = 10);
  size_t print(double, int = 2);
  size_t println(const __FlashStringHelper *);
  size_t println(const char *);
  size_t println(char);
  size_t println(int, int = 10);
  size_t println(unsigned int, int = 10);
  size_t println(long, int = 10);
  size_t println(unsigned long, int = 10);
  size_t println(double, int = 2);
  size_t println(void);
  operator bool();
};
extern HardwareSerial Serial;
