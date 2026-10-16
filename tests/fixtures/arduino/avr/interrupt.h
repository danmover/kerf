// Minimal stand-in for avr-libc's <avr/interrupt.h>, used only by Kerf's tests.
// With clang --target=avr, ISR() declares a real interrupt handler for the
// ATmega328P vector. On the host it declares a plain C function the test
// harness calls when its simulated ADC finishes a conversion.
#pragma once
#include <avr/io.h>

#if defined(__AVR__)
#define ADC_vect __vector_21
#define ISR(vector, ...)                                                    \
  extern "C" void vector(void) __attribute__((signal, used)) __VA_ARGS__; \
  void vector(void)
#define sei() __asm__ __volatile__("sei" ::: "memory")
#define cli() __asm__ __volatile__("cli" ::: "memory")
#else
#define ADC_vect kerf_isr_adc
#define ISR(vector, ...) extern "C" void vector(void)
void kerf_sei(void);
void kerf_cli(void);
#define sei() kerf_sei()
#define cli() kerf_cli()
#endif
