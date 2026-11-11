// The system headers the virtual microcontroller provides. Arduino.h holds
// the core's macros exactly as the AVR core writes them (abs, min, max and
// round are macros there, with the same double-evaluation pitfalls); the
// functions behind them live in lib.ts.

import type { Board } from "./board";
import { AVR_INTERRUPT_H, AVR_IO_H } from "./registers";

export function systemHeaders(b: Board): Record<string, string> {
  const analog = b.analog.map((p, i) => `#define A${i} ${p}`).join("\n");
  const irq = Object.entries(b.interrupts)
    .map(([pin, n]) => `((p) == ${pin} ? ${n} : `)
    .join("");
  const irqClose = ")".repeat(Object.keys(b.interrupts).length);
  const esp = b.arch === "esp32";
  const arduino = `#pragma once
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
${esp ? "#include <pgmspace.h>\n#define IRAM_ATTR\n#define DRAM_ATTR\n#define ESP_OK 0\n#define portTICK_PERIOD_MS 1\n#define SERIAL_8N1 0x800001c" : "#include <avr/pgmspace.h>\n#include <avr/io.h>\n#include <avr/interrupt.h>"}

#define HIGH 0x1
#define LOW  0x0
#define INPUT 0x0
#define OUTPUT 0x1
#define INPUT_PULLUP 0x2

#define PI 3.1415926535897932384626433832795
#define HALF_PI 1.5707963267948966192313216916398
#define TWO_PI 6.283185307179586476925286766559
#define DEG_TO_RAD 0.017453292519943295769236907684886
#define RAD_TO_DEG 57.295779513082320876798154814105
#define EULER 2.718281828459045235360287471352

#define SERIAL  0x0
#define DISPLAY 0x1
#define LSBFIRST 0
#define MSBFIRST 1
#define CHANGE 1
#define FALLING 2
#define RISING 3
#define DEFAULT 1
#define EXTERNAL 0
#define INTERNAL 3
#define INTERNAL1V1 2
#define NOT_AN_INTERRUPT -1
#define DEC 10
#define HEX 16
#define OCT 8
#define BIN 2

#define min(a,b) ((a)<(b)?(a):(b))
#define max(a,b) ((a)>(b)?(a):(b))
#define abs(x) ((x)>0?(x):-(x))
#define constrain(amt,low,high) ((amt)<(low)?(low):((amt)>(high)?(high):(amt)))
#define round(x)     ((x)>=0?(long)((x)+0.5):(long)((x)-0.5))
#define radians(deg) ((deg)*DEG_TO_RAD)
#define degrees(rad) ((rad)*RAD_TO_DEG)
#define sq(x) ((x)*(x))

#define interrupts() sei()
#define noInterrupts() cli()
${esp ? "#define NEOPIXEL_I2C_POWER 2\n#define PIN_NEOPIXEL 0\n#define BUTTON 38\n#define BATT_MONITOR 35" : ""}

#define clockCyclesPerMicrosecond() ( F_CPU / 1000000L )
#define clockCyclesToMicroseconds(a) ( (a) / clockCyclesPerMicrosecond() )
#define microsecondsToClockCycles(a) ( (a) * clockCyclesPerMicrosecond() )

#define lowByte(w) ((uint8_t) ((w) & 0xff))
#define highByte(w) ((uint8_t) ((w) >> 8))
#define bitRead(value, bit) (((value) >> (bit)) & 0x01)
#define bitSet(value, bit) ((value) |= (1UL << (bit)))
#define bitClear(value, bit) ((value) &= ~(1UL << (bit)))
#define bitToggle(value, bit) ((value) ^= (1UL << (bit)))
#define bitWrite(value, bit, bitvalue) ((bitvalue) ? bitSet(value, bit) : bitClear(value, bit))
#define bit(b) (1UL << (b))

#define F(string_literal) __flash_str(string_literal)

#define LED_BUILTIN ${b.ledBuiltin}
${analog}
#define SDA ${b.sda}
#define SCL ${b.scl}
${esp ? "#define SS 33\n#define MOSI 19\n#define MISO 21\n#define SCK 5\n#define RX 7\n#define TX 8" : "#define SS 10\n#define MOSI 11\n#define MISO 12\n#define SCK 13"}
#define NUM_DIGITAL_PINS ${b.digitalPins + 1}
#define NUM_ANALOG_INPUTS ${b.analog.length}
#define digitalPinToInterrupt(p) ${irq}NOT_AN_INTERRUPT${irqClose}
#define digitalPinHasPWM(p) (${Object.keys(b.pwm)
    .map((p) => `(p) == ${p}`)
    .join(" || ")})
`;
  const pgm = `#pragma once
#define PROGMEM
#define PGM_P const char *
#define PSTR(s) (s)
#define pgm_read_byte(addr) (*(const uint8_t *)(addr))
#define pgm_read_word(addr) (*(const uint16_t *)(addr))
#define pgm_read_dword(addr) (*(const uint32_t *)(addr))
#define pgm_read_float(addr) (*(const float *)(addr))
#define pgm_read_ptr(addr) (*(addr))
#define pgm_read_byte_near(addr) pgm_read_byte(addr)
#define pgm_read_word_near(addr) pgm_read_word(addr)
#define strcpy_P strcpy
#define strncpy_P strncpy
#define strcmp_P strcmp
#define strncmp_P strncmp
#define strlen_P strlen
#define memcpy_P memcpy
#define sprintf_P sprintf
#define snprintf_P snprintf
#define printf_P printf
`;
  const empty = "#pragma once\n";
  return {
    "Arduino.h": arduino,
    "avr/pgmspace.h": pgm,
    "pgmspace.h": pgm,
    "stdint.h": empty,
    "stdlib.h": empty,
    "string.h": empty,
    "math.h": empty,
    "stdio.h": empty,
    "stdbool.h": empty,
    "ctype.h": empty,
    "limits.h": `#pragma once
#define CHAR_BIT 8
#define SCHAR_MIN (-128)
#define SCHAR_MAX 127
#define UCHAR_MAX 255
${b.abi.intBits === 32 ? "#define INT_MIN (-2147483647-1)\n#define INT_MAX 2147483647\n#define UINT_MAX 4294967295U" : "#define INT_MIN (-32767-1)\n#define INT_MAX 32767\n#define UINT_MAX 65535U"}
#define LONG_MIN (-2147483647L-1)
#define LONG_MAX 2147483647L
#define ULONG_MAX 4294967295UL
`,
    "avr/interrupt.h": AVR_INTERRUPT_H,
    "avr/io.h": AVR_IO_H,
    "avr/cpufunc.h": `#pragma once
#define _NOP() __asm__ __volatile__("nop")
#define _MemoryBarrier() __asm__ __volatile__("" ::: "memory")
`,
    "util/atomic.h": `#pragma once
#define ATOMIC_RESTORESTATE 1
#define ATOMIC_FORCEON 1
#define ATOMIC_BLOCK(type) for (uint8_t __kerf_atomic = (cli(), 1); __kerf_atomic; __kerf_atomic = (sei(), 0))
`,
    "Wire.h": empty,
    "EEPROM.h": empty,
    "Servo.h": empty,
    // the ESP32Servo library (Kevin Harrington, John K. Bennett): Servo on the LEDC timers, any output pin
    "ESP32Servo.h": empty,
    "Preferences.h": empty,
    "Adafruit_NeoPixel.h": `#pragma once
#define NEO_RGB ((0 << 6) | (0 << 4) | (1 << 2) | (2))
#define NEO_RBG ((0 << 6) | (0 << 4) | (2 << 2) | (1))
#define NEO_GRB ((1 << 6) | (1 << 4) | (0 << 2) | (2))
#define NEO_GBR ((2 << 6) | (2 << 4) | (0 << 2) | (1))
#define NEO_BRG ((1 << 6) | (1 << 4) | (2 << 2) | (0))
#define NEO_BGR ((2 << 6) | (2 << 4) | (1 << 2) | (0))
#define NEO_RGBW ((3 << 6) | (0 << 4) | (1 << 2) | (2))
#define NEO_GRBW ((3 << 6) | (1 << 4) | (0 << 2) | (2))
#define NEO_KHZ800 0x0000
#define NEO_KHZ400 0x0100
`,
  };
}

/** Macros every sketch sees before its first line (the board's own defines, plus limits). */
export function predefines(b: Board): Record<string, string> {
  return {
    ...b.defines,
    INT8_MAX: "127",
    INT8_MIN: "(-128)",
    UINT8_MAX: "255",
    INT16_MAX: "32767",
    INT16_MIN: "(-32767-1)",
    UINT16_MAX: "65535U",
    INT32_MAX: "2147483647L",
    INT32_MIN: "(-2147483647L-1)",
    UINT32_MAX: "4294967295UL",
    RAND_MAX: "0x7FFF",
    RANDOM_MAX: "0x7FFFFFFF",
    EOF: "(-1)",
  };
}
