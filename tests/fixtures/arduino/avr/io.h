// Minimal stand-in for avr-libc's <avr/io.h> (ATmega328P), used only by Kerf's
// tests. With clang --target=avr the registers are memory mapped at their real
// addresses, as in the real header. On the host (g++ test harness) each
// register is an object, so the harness can see what the sketch writes (for
// example when it starts or stops the ADC) and feed the ADC results back.
#pragma once
#include <stdint.h>

#ifndef F_CPU
#define F_CPU 16000000UL
#endif

#define _BV(bit) (1 << (bit))

#if defined(__AVR__)
#define _MMIO_BYTE(addr) (*(volatile uint8_t *)(addr))
#define _SFR_MEM8(addr) _MMIO_BYTE(addr)
#define _SFR_IO8(addr) _MMIO_BYTE((addr) + 0x20)
#define SREG _SFR_IO8(0x3F)
#define ADCL _SFR_MEM8(0x78)
#define ADCH _SFR_MEM8(0x79)
#define ADCSRA _SFR_MEM8(0x7A)
#define ADCSRB _SFR_MEM8(0x7B)
#define ADMUX _SFR_MEM8(0x7C)
#define DIDR0 _SFR_MEM8(0x7E)
#define TWBR _SFR_MEM8(0xB8)
#define TWSR _SFR_MEM8(0xB9)
#else
// An 8-bit I/O register on the host. Every write calls onWrite (if the
// harness set one) with the value it had before.
struct KerfReg8 {
  volatile uint8_t v;
  void (*onWrite)(KerfReg8 &reg, uint8_t before);
  KerfReg8 &operator=(uint8_t n) {
    uint8_t before = v;
    v = n;
    if (onWrite) onWrite(*this, before);
    return *this;
  }
  KerfReg8 &operator|=(uint8_t n) { return *this = (uint8_t)(v | n); }
  KerfReg8 &operator&=(uint8_t n) { return *this = (uint8_t)(v & n); }
  KerfReg8 &operator^=(uint8_t n) { return *this = (uint8_t)(v ^ n); }
  operator uint8_t() const { return v; }
};
extern KerfReg8 SREG, ADCL, ADCH, ADCSRA, ADCSRB, ADMUX, DIDR0, TWBR, TWSR;
#endif

// ADMUX
#define REFS1 7
#define REFS0 6
#define ADLAR 5
#define MUX3 3
#define MUX2 2
#define MUX1 1
#define MUX0 0
// ADCSRA
#define ADEN 7
#define ADSC 6
#define ADATE 5
#define ADIF 4
#define ADIE 3
#define ADPS2 2
#define ADPS1 1
#define ADPS0 0
// ADCSRB
#define ACME 6
#define ADTS2 2
#define ADTS1 1
#define ADTS0 0
// DIDR0
#define ADC5D 5
#define ADC4D 4
#define ADC3D 3
#define ADC2D 2
#define ADC1D 1
#define ADC0D 0
// TWSR
#define TWPS1 1
#define TWPS0 0
// SREG
#define SREG_I 7
