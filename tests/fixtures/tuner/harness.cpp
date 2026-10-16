// Host test harness for Kerf's generated guitar tuner sketch (tests/tuner.test.ts).
//
// It runs the sketch's setup() and loop() against simulated hardware:
//   - an ADC that converts every 104 us (16 MHz / 128 / 13) once the sketch
//     starts it, sets ADCH to the next sample of a signal file and calls the
//     sketch's ADC interrupt;
//   - a clock (millis/micros) driven by simulated time. Time passes in steps
//     of LOOP_US per loop() call, for every I2C byte at the TWBR clock, for
//     delay(), and for the analysis: when the sketch restarts the ADC after a
//     full buffer, the time the AVR would have spent analysing it is added
//     first, from the counted inner-loop work (see --cycles-per-pair);
//   - a button (pressed between the times given with --press);
//   - an EEPROM (optionally loaded from and saved to a file);
//   - a Serial port whose lines are printed with the time they finish;
//   - an SSD1306 OLED: the I2C bytes are decoded (commands, addressing modes)
//     into its 128x64 display RAM, which is dumped at the --snap times.
//
// Build: g++ -std=gnu++17 -O2 -I tests/fixtures/arduino -DKERF_SKETCH='"/path/X.ino"' harness.cpp
// Run:   harness --signal s.u8 --ms 3000 [--channel 0] [--button 2] [--press 1000:1100]...
//                 [--snap 1500]... [--no-oled] [--eeprom-in f] [--eeprom-out f]
//                 [--cycles-per-pair 26] [--overhead-cycles 120000] [--trace]
// Output: "S <ms> <serial line>"       a line the sketch printed
//         "F <ms>" then 64 rows of '#'/'.'   the OLED at a --snap time
//         "I <name> <value>"           facts about the run (I2C overflows, timing, ...)
//         "C <sample>"                 with --trace: a capture starts at this sample of the signal

// System headers first: the mock Arduino.h defines abs() as a macro.
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "Arduino.h"
#include "EEPROM.h"
#include "Wire.h"
#include <avr/interrupt.h>
#include <avr/io.h>
#include <avr/pgmspace.h>

// ---------------------------------------------------------------- simulated time
static uint64_t simUs = 0;                     // time since power-up, microseconds
static const uint64_t CONV_US = 104;           // one ADC conversion: 13 clocks at 125 kHz
static const uint64_t LOOP_US = 20;            // one pass of loop() that does nothing much
static bool interruptsOn = true;
static bool inIsr = false;

// ---------------------------------------------------------------- analysis work
static uint64_t workPairs = 0;                 // sample pairs compared since the last capture
#define TUNER_WORK(pairs) (workPairs += (pairs))
static double cyclesPerPair = 26;              // clang -O2 for AVR: 25-27 cycles a pair
static double overheadCycles = 120000;         // gate scan, YIN divisions, floats: generous
static uint64_t maxPairs = 0, sumPairs = 0, analyses = 0;
static double maxAnalysisMs = 0;

// ---------------------------------------------------------------- registers
static void onAdcsra(KerfReg8 &r, uint8_t before);
KerfReg8 SREG = {0x80, nullptr}, ADCL = {0, nullptr}, ADCH = {0, nullptr}, ADCSRA = {0, onAdcsra}, ADCSRB = {0, nullptr},
         ADMUX = {0, nullptr}, DIDR0 = {0, nullptr}, TWBR = {72, nullptr}, TWSR = {0, nullptr};

// ---------------------------------------------------------------- the ADC
static std::vector<uint8_t> signal8;           // one sample per conversion slot since power-up
static int signalChannel = 0;
static bool adcRunning = false;
static uint64_t nextConvUs = 0;
static bool captureEnded = false;              // the ISR stopped the ADC: a buffer is waiting
static uint64_t captures = 0, wrongSetup = 0;
static bool traceCaptures = false;             // --trace: print where each capture starts

extern "C" void kerf_isr_adc(void);
static void advanceTo(uint64_t t);

static void convert() {
  uint8_t admux = ADMUX.v;
  uint64_t k = simUs / CONV_US;
  uint8_t s = k < signal8.size() ? signal8[k] : 128;
  bool ok = (admux & 0x0F) == signalChannel && (admux & 0xC0) == 0x40;   // the signal pin, AVcc reference
  if (!ok) wrongSetup++;
  uint16_t v10 = ok ? (uint16_t)(s << 2 | 2) : 0;
  if (admux & _BV(ADLAR)) {
    ADCH.v = v10 >> 2;
    ADCL.v = (uint8_t)(v10 << 6);
  } else {
    ADCH.v = v10 >> 8;
    ADCL.v = v10 & 0xFF;
  }
  if (!(ADCSRA.v & _BV(ADATE))) adcRunning = false;   // single conversion done
  if ((ADCSRA.v & _BV(ADIE)) && interruptsOn && !inIsr) {
    inIsr = true;
    kerf_isr_adc();
    inIsr = false;
  } else {
    ADCSRA.v |= _BV(ADIF);
  }
}

static void onAdcsra(KerfReg8 &r, uint8_t before) {
  uint8_t v = r.v;
  if (v & _BV(ADIF)) r.v = v = (uint8_t)(v & ~_BV(ADIF));   // writing 1 clears the flag
  if (!(v & _BV(ADEN))) {
    adcRunning = false;
    return;
  }
  if (adcRunning && !(v & _BV(ADATE))) {        // free running switched off
    adcRunning = false;
    if (inIsr) {
      captureEnded = true;
      captures++;
    }
    return;
  }
  if ((v & _BV(ADSC)) && !adcRunning) {
    if (captureEnded) {
      // The sketch analysed the buffer before restarting: charge the AVR time for it.
      captureEnded = false;
      double cycles = workPairs * cyclesPerPair + overheadCycles;
      double ms = cycles / 16000.0;
      analyses++;
      sumPairs += workPairs;
      if (workPairs > maxPairs) maxPairs = workPairs;
      if (ms > maxAnalysisMs) maxAnalysisMs = ms;
      workPairs = 0;
      r.v = before;                             // the ADC stays off meanwhile
      advanceTo(simUs + (uint64_t)(ms * 1000.0));
      r.v = v;
    }
    workPairs = 0;
    adcRunning = true;
    nextConvUs = (simUs / CONV_US + 1) * CONV_US;
    if (traceCaptures) printf("C %llu\n", (unsigned long long)(nextConvUs / CONV_US));   // first sample's index
  }
  (void)before;
}

// ---------------------------------------------------------------- the OLED
static bool oledPresent = true;
static uint8_t oledAddr = 0x3C;
struct Ssd1306 {
  uint8_t ram[8][128];
  uint8_t mode = 2;                             // page addressing after reset
  uint8_t colStart = 0, colEnd = 127, pageStart = 0, pageEnd = 7, col = 0, page = 0;
  bool on = false, inverse = false, remap = false, comFlip = false, pump = false;
  int need = 0;                                 // argument bytes still expected
  uint8_t cmd = 0, args[8];
  int nargs = 0;
  uint64_t commands = 0, dataBytes = 0;

  static int argCount(uint8_t c) {
    switch (c) {
      case 0x20: case 0x81: case 0x8D: case 0xA8: case 0xD3: case 0xD5: case 0xD9: case 0xDA: case 0xDB: return 1;
      case 0x21: case 0x22: case 0xA3: return 2;
      case 0x29: case 0x2A: return 5;
      case 0x26: case 0x27: return 6;
      default: return 0;
    }
  }
  void command(uint8_t c) {
    commands++;
    if (need) {
      args[nargs++] = c;
      if (--need) return;
      apply();
      return;
    }
    cmd = c;
    nargs = 0;
    need = argCount(c);
    if (!need) apply();
  }
  void apply() {
    uint8_t c = cmd;
    if (c == 0x20) mode = args[0] & 3;
    else if (c == 0x21) { colStart = args[0] & 127; colEnd = args[1] & 127; col = colStart; }
    else if (c == 0x22) { pageStart = args[0] & 7; pageEnd = args[1] & 7; page = pageStart; }
    else if (c == 0x8D) pump = (args[0] & 0x04) != 0;
    else if (c <= 0x0F) col = (uint8_t)((col & 0xF0) | c);
    else if (c <= 0x1F) col = (uint8_t)((col & 0x0F) | ((c & 0x07) << 4));
    else if (c >= 0xB0 && c <= 0xB7) page = c & 7;
    else if (c == 0xA6) inverse = false;
    else if (c == 0xA7) inverse = true;
    else if (c == 0xAE) on = false;
    else if (c == 0xAF) on = true;
    else if (c == 0xA0) remap = false;
    else if (c == 0xA1) remap = true;
    else if (c == 0xC0) comFlip = false;
    else if (c == 0xC8) comFlip = true;
  }
  void data(uint8_t d) {
    dataBytes++;
    ram[page][col] = d;
    if (mode == 0 || mode == 1) {
      if (mode == 0) {
        if (col >= colEnd) { col = colStart; page = page >= pageEnd ? pageStart : page + 1; }
        else col++;
      } else {
        if (page >= pageEnd) { page = pageStart; col = col >= colEnd ? colStart : col + 1; }
        else page++;
      }
    } else {
      col = col >= 127 ? 0 : col + 1;
    }
  }
  // One I2C transmission to the display: control byte(s), then commands or data.
  void transmission(const uint8_t *b, int n) {
    int i = 0;
    while (i < n) {
      uint8_t control = b[i++];
      bool cont = control & 0x80, isData = control & 0x40;
      if (cont) {
        if (i < n) { if (isData) data(b[i]); else command(b[i]); i++; }
      } else {
        for (; i < n; i++) { if (isData) data(b[i]); else command(b[i]); }
      }
    }
  }
  bool pixel(int x, int y) const { return ((ram[y >> 3][x] >> (y & 7)) & 1) != inverse; }
};
static Ssd1306 oled;

// ---------------------------------------------------------------- snapshots
static std::vector<uint64_t> snaps;             // ms
static size_t nextSnap = 0;
static void dumpFrame(uint64_t ms) {
  printf("F %llu\n", (unsigned long long)ms);
  for (int y = 0; y < 64; y++) {
    char row[129];
    for (int x = 0; x < 128; x++) row[x] = (oled.on && oled.pixel(x, y)) ? '#' : '.';
    row[128] = 0;
    printf("%s\n", row);
  }
}

static void advanceTo(uint64_t t) {
  while (adcRunning && nextConvUs <= t) {
    if (nextConvUs > simUs) simUs = nextConvUs;
    nextConvUs += CONV_US;
    convert();
  }
  if (t > simUs) simUs = t;
  while (nextSnap < snaps.size() && snaps[nextSnap] * 1000 <= simUs) dumpFrame(snaps[nextSnap++]);
}
static void advance(uint64_t us) { advanceTo(simUs + us); }

// ---------------------------------------------------------------- Arduino core
static int buttonPin = 2;
static std::vector<std::pair<uint64_t, uint64_t>> presses;   // ms ranges the button is held
static int buttonMode = -1;

void pinMode(uint8_t pin, uint8_t mode) {
  if (pin == buttonPin) buttonMode = mode;
}
void digitalWrite(uint8_t, uint8_t) {}
int digitalRead(uint8_t pin) {
  if (pin != buttonPin) return HIGH;
  uint64_t ms = simUs / 1000;
  for (auto &p : presses)
    if (ms >= p.first && ms < p.second) return LOW;
  return buttonMode == INPUT_PULLUP ? HIGH : LOW;   // no pull-up: the input floats (reads low here)
}
int analogRead(uint8_t) { return 0; }
void analogWrite(uint8_t, int) {}
unsigned long millis(void) { return (unsigned long)(uint32_t)(simUs / 1000); }
unsigned long micros(void) { return (unsigned long)(uint32_t)simUs; }
void delay(unsigned long ms) { advance((uint64_t)ms * 1000); }
void attachInterrupt(uint8_t, void (*)(void), int) {}
void noInterrupts() { interruptsOn = false; }
void interrupts() { interruptsOn = true; }
void kerf_cli(void) { interruptsOn = false; }
void kerf_sei(void) { interruptsOn = true; }

// Serial: collects characters, prints whole lines with their time.
HardwareSerial Serial;
static std::string serialLine;
static unsigned long serialBaud = 0;
static size_t emit(const char *s) {
  size_t n = 0;
  for (; *s; s++, n++) {
    if (*s == '\n') {
      printf("S %llu %s\n", (unsigned long long)(simUs / 1000), serialLine.c_str());
      serialLine.clear();
    } else if (*s != '\r') {
      serialLine += *s;
    }
  }
  return n;
}
static size_t emitNum(unsigned long long v, bool neg, int base) {
  char b[72];
  int i = 70;
  b[71] = 0;
  if (base < 2) base = 10;
  do { b[i--] = "0123456789ABCDEF"[v % base]; v /= base; } while (v);
  if (neg) b[i--] = '-';
  return emit(b + i + 1);
}
static size_t emitFloat(double v, int digits) {
  // as Arduino's Print::printFloat
  size_t n = 0;
  if (v < 0) { n += emit("-"); v = -v; }
  double r = 0.5;
  for (int i = 0; i < digits; i++) r /= 10.0;
  v += r;
  unsigned long long whole = (unsigned long long)v;
  double rem = v - (double)whole;
  n += emitNum(whole, false, 10);
  if (digits > 0) n += emit(".");
  while (digits-- > 0) { rem *= 10.0; int d = (int)rem; char c[2] = {(char)('0' + d), 0}; n += emit(c); rem -= d; }
  return n;
}
void HardwareSerial::begin(unsigned long baud) { serialBaud = baud; }
int HardwareSerial::available() { return 0; }
int HardwareSerial::read() { return -1; }
size_t HardwareSerial::print(const __FlashStringHelper *s) { return emit(reinterpret_cast<const char *>(s)); }
size_t HardwareSerial::print(const char *s) { return emit(s); }
size_t HardwareSerial::print(char c) { char b[2] = {c, 0}; return emit(b); }
size_t HardwareSerial::print(int v, int base) { return emitNum(v < 0 ? -(long long)v : v, v < 0, base); }
size_t HardwareSerial::print(unsigned int v, int base) { return emitNum(v, false, base); }
size_t HardwareSerial::print(long v, int base) { return emitNum(v < 0 ? -(long long)v : v, v < 0, base); }
size_t HardwareSerial::print(unsigned long v, int base) { return emitNum(v, false, base); }
size_t HardwareSerial::print(double v, int digits) { return emitFloat(v, digits); }
size_t HardwareSerial::println(void) { return emit("\n"); }
size_t HardwareSerial::println(const __FlashStringHelper *s) { return print(s) + println(); }
size_t HardwareSerial::println(const char *s) { return print(s) + println(); }
size_t HardwareSerial::println(char c) { return print(c) + println(); }
size_t HardwareSerial::println(int v, int base) { return print(v, base) + println(); }
size_t HardwareSerial::println(unsigned int v, int base) { return print(v, base) + println(); }
size_t HardwareSerial::println(long v, int base) { return print(v, base) + println(); }
size_t HardwareSerial::println(unsigned long v, int base) { return print(v, base) + println(); }
size_t HardwareSerial::println(double v, int digits) { return print(v, digits) + println(); }
HardwareSerial::operator bool() { return true; }

// Wire: a 32-byte transmit buffer like the AVR library; writing more is an error the test checks.
TwoWire Wire;
static uint8_t txAddr = 0, txBuf[64];
static int txLen = 0;
static bool wireBegun = false;
static uint64_t wireOverflows = 0, wireBytes = 0, wireTransmissions = 0;
void TwoWire::begin() { wireBegun = true; }
void TwoWire::beginTransmission(uint8_t address) { txAddr = address; txLen = 0; }
size_t TwoWire::write(uint8_t b) {
  if (txLen >= 32) { wireOverflows++; return 0; }
  txBuf[txLen++] = b;
  return 1;
}
uint8_t TwoWire::endTransmission(bool) {
  wireTransmissions++;
  // SCL = F_CPU / (16 + 2 * TWBR * prescaler); 9 clocks a byte, plus start and stop
  int prescale = 1 << (2 * (TWSR.v & 3));
  double scl = 16e6 / (16 + 2.0 * TWBR.v * prescale);
  bool ack = wireBegun && oledPresent && txAddr == oledAddr;
  int bytes = 1 + (ack ? txLen : 0);
  advance((uint64_t)((bytes * 9 + 2) * 1e6 / scl + 0.5));
  if (!ack) return 2;                           // address not acknowledged
  wireBytes += txLen;
  oled.transmission(txBuf, txLen);
  return 0;
}
uint8_t TwoWire::requestFrom(uint8_t, uint8_t) { return 0; }
int TwoWire::read() { return -1; }
int TwoWire::available() { return 0; }

// EEPROM: 1 KB, erased (0xFF) unless loaded from a file.
EEPROMClass EEPROM;
static uint8_t eeprom[1024];
static uint64_t eepromWrites = 0;
uint8_t EEPROMClass::read(int i) { return (i >= 0 && i < 1024) ? eeprom[i] : 0xFF; }
void EEPROMClass::write(int i, uint8_t v) {
  if (i >= 0 && i < 1024) { eeprom[i] = v; eepromWrites++; }
}
void EEPROMClass::update(int i, uint8_t v) {
  if (i >= 0 && i < 1024 && eeprom[i] != v) write(i, v);
}
uint16_t EEPROMClass::length() { return 1024; }

// ---------------------------------------------------------------- the sketch
#include KERF_SKETCH

// ---------------------------------------------------------------- main
static std::vector<uint8_t> readFile(const char *path) {
  std::vector<uint8_t> v;
  FILE *f = fopen(path, "rb");
  if (!f) { fprintf(stderr, "cannot read %s\n", path); exit(2); }
  uint8_t buf[65536];
  size_t n;
  while ((n = fread(buf, 1, sizeof buf, f)) > 0) v.insert(v.end(), buf, buf + n);
  fclose(f);
  return v;
}

int main(int argc, char **argv) {
  const char *signalPath = nullptr, *eeIn = nullptr, *eeOut = nullptr;
  uint64_t endMs = 2000;
  memset(eeprom, 0xFF, sizeof eeprom);
  memset(oled.ram, 0, sizeof oled.ram);
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    const char *v = i + 1 < argc ? argv[i + 1] : "";
    if (a == "--signal") { signalPath = v; i++; }
    else if (a == "--ms") { endMs = strtoull(v, nullptr, 10); i++; }
    else if (a == "--channel") { signalChannel = atoi(v); i++; }
    else if (a == "--button") { buttonPin = atoi(v); i++; }
    else if (a == "--press") {
      unsigned long long s = 0, e = 0;
      if (sscanf(v, "%llu:%llu", &s, &e) == 2) presses.push_back({s, e});
      i++;
    }
    else if (a == "--snap") { snaps.push_back(strtoull(v, nullptr, 10)); i++; }
    else if (a == "--no-oled") oledPresent = false;
    else if (a == "--trace") traceCaptures = true;
    else if (a == "--oled-addr") { oledAddr = (uint8_t)strtol(v, nullptr, 0); i++; }
    else if (a == "--eeprom-in") { eeIn = v; i++; }
    else if (a == "--eeprom-out") { eeOut = v; i++; }
    else if (a == "--cycles-per-pair") { cyclesPerPair = atof(v); i++; }
    else if (a == "--overhead-cycles") { overheadCycles = atof(v); i++; }
    else { fprintf(stderr, "unknown option %s\n", a.c_str()); return 2; }
  }
  std::sort(snaps.begin(), snaps.end());
  if (signalPath) signal8 = readFile(signalPath);
  if (eeIn) {
    std::vector<uint8_t> e = readFile(eeIn);
    memcpy(eeprom, e.data(), e.size() < 1024 ? e.size() : 1024);
  }

  setup();
  while (simUs < endMs * 1000) {
    loop();
    advance(LOOP_US);
  }
  while (nextSnap < snaps.size()) dumpFrame(snaps[nextSnap++]);
  if (!serialLine.empty()) emit("\n");

  printf("I baud %lu\n", serialBaud);
  printf("I button_mode %d\n", buttonMode);
  printf("I adc_wrong_setup %llu\n", (unsigned long long)wrongSetup);
  printf("I didr0 %u\n", (unsigned)DIDR0.v);
  printf("I twbr %u\n", (unsigned)TWBR.v);
  printf("I captures %llu\n", (unsigned long long)captures);
  printf("I analyses %llu\n", (unsigned long long)analyses);
  printf("I max_pairs %llu\n", (unsigned long long)maxPairs);
  printf("I mean_pairs %.0f\n", analyses ? (double)sumPairs / analyses : 0.0);
  printf("I max_analysis_ms %.2f\n", maxAnalysisMs);
  printf("I wire_overflows %llu\n", (unsigned long long)wireOverflows);
  printf("I wire_bytes %llu\n", (unsigned long long)wireBytes);
  printf("I wire_transmissions %llu\n", (unsigned long long)wireTransmissions);
  printf("I oled_on %d remap %d com_flip %d charge_pump %d\n", oled.on, oled.remap, oled.comFlip, oled.pump);
  printf("I eeprom_writes %llu\n", (unsigned long long)eepromWrites);
  if (eeOut) {
    FILE *f = fopen(eeOut, "wb");
    if (f) { fwrite(eeprom, 1, sizeof eeprom, f); fclose(f); }
  }
  return 0;
}
