// Minimal stand-in for avr-libc's <avr/pgmspace.h>, used only by Kerf's tests.
// On the AVR, PROGMEM data stays in flash (avr-libc's progmem attribute puts it
// in .progmem.data; clang spells that as a section). On the host it is
// ordinary constant data and the pgm_read_* macros are plain reads.
#pragma once
#include <stdint.h>

#if defined(__AVR__)
#define PROGMEM __attribute__((section(".progmem.data")))
#else
#define PROGMEM
#endif

#define PGM_P const char *
#define PSTR(s) (s)
#define pgm_read_byte(addr) (*(const uint8_t *)(addr))
#define pgm_read_word(addr) (*(const uint16_t *)(addr))
