// The boards the virtual microcontroller can be: chip, clock, memory, which
// pins do what, and the macros the Arduino core defines for them.

import { AVR, type Abi } from "./ctypes";

export interface Board {
  /** catalog part ids this profile covers */
  parts: string[];
  name: string;
  mcu: string;
  fcpu: number;
  abi: Abi;
  ramBytes: number;
  flashBytes: number;
  eepromBytes: number;
  /** highest digital pin number (analog pins count as digital where they can be) */
  digitalPins: number;
  /** pin number of A0, A1, ... */
  analog: number[];
  /** analog pins that cannot be used as digital pins (A6 and A7 on the Nano) */
  analogOnly: number[];
  /** pin -> external interrupt number */
  interrupts: Record<number, number>;
  /** pin -> PWM frequency in Hz (analogWrite) */
  pwm: Record<number, number>;
  /** which timer drives a PWM pin (Servo takes timer 1, tone() timer 2) */
  pwmTimer: Record<number, number>;
  ledBuiltin: number;
  sda: number;
  scl: number;
  adcBits: number;
  /** ADC reference with analogReference(DEFAULT) */
  adcRefV: number;
  /** I/O pin logic level */
  logicV: number;
  /** serial transmit buffer, bytes */
  serialTx: number;
  serialRx: number;
  defines: Record<string, string>;
}

const atmega328p = (name: string, parts: string[], board: string, analog: number[], analogOnly: number[]): Board => ({
  parts,
  name,
  mcu: "ATmega328P",
  fcpu: 16_000_000,
  abi: AVR,
  ramBytes: 2048,
  flashBytes: 32768 - 2048,
  eepromBytes: 1024,
  digitalPins: 19,
  analog,
  analogOnly,
  interrupts: { 2: 0, 3: 1 },
  pwm: { 3: 490, 5: 980, 6: 980, 9: 490, 10: 490, 11: 490 },
  pwmTimer: { 5: 0, 6: 0, 9: 1, 10: 1, 3: 2, 11: 2 },
  ledBuiltin: 13,
  sda: 18,
  scl: 19,
  adcBits: 10,
  adcRefV: 5,
  logicV: 5,
  serialTx: 64,
  serialRx: 64,
  defines: {
    ARDUINO: "10819",
    ARDUINO_ARCH_AVR: "1",
    [board]: "1",
    __AVR__: "1",
    __AVR_ATmega328P__: "1",
    F_CPU: "16000000L",
    __KERF_SIM__: "1",
  },
});

export const NANO = atmega328p("Arduino Nano", ["arduino_nano"], "ARDUINO_AVR_NANO", [14, 15, 16, 17, 18, 19, 20, 21], [20, 21]);
export const UNO = atmega328p("Arduino Uno", ["arduino_uno"], "ARDUINO_AVR_UNO", [14, 15, 16, 17, 18, 19], []);

export const BOARDS: Board[] = [NANO, UNO];

export function boardFor(partId: string | undefined): Board | undefined {
  return BOARDS.find((b) => partId && b.parts.includes(partId));
}
