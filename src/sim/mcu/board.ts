// The boards the virtual microcontroller can be: chip, clock, memory, which
// pins do what, and the macros the Arduino core defines for them.

import { AVR, XTENSA, type Abi } from "./ctypes";

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
  /** the core family: which Arduino.h the board's sketches see */
  arch?: "avr" | "esp32";
  /** ESP32: every GPIO analogRead() takes (its core takes GPIO numbers, so more than the A0.. names) */
  adcPins?: number[];
  /** a pin the board wires to its battery through a divider (the Feather's BATT_MONITOR), and the divider's ratio */
  battMonitor?: { pin: number; ratio: number };
  /** the pins Serial1, Serial2 use when begin() names none (ESP32: any pins can be given) */
  uarts?: ({ rx: number; tx: number } | undefined)[];
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

export const NANO = atmega328p("Arduino Nano", ["arduino_nano", "arduino_nano_clone"], "ARDUINO_AVR_NANO", [14, 15, 16, 17, 18, 19, 20, 21], [20, 21]);
export const UNO = atmega328p("Arduino Uno", ["arduino_uno"], "ARDUINO_AVR_UNO", [14, 15, 16, 17, 18, 19], []);

// The Adafruit ESP32 Feather V2 (ESP32-PICO-MINI-02): every output GPIO does PWM (LEDC) and takes interrupts;
// Wire runs on SDA 22 / SCL 20 (the STEMMA QT socket) by default. analogRead() takes any ADC GPIO: ADC1 is 32 to 39
// (35 is BATT_MONITOR, the LiPo through a 1:2 divider on the board), ADC2 is 4, 12 to 15 and 25 to 27.
const FEATHER_GPIO = [4, 5, 7, 8, 12, 13, 14, 15, 19, 20, 21, 22, 25, 26, 27, 32, 33];
const FEATHER_INPUTS = [34, 36, 37, 39];
export const FEATHER_ESP32_V2: Board = {
  parts: ["feather_esp32_v2"],
  name: "ESP32 Feather V2",
  mcu: "ESP32",
  fcpu: 240_000_000,
  abi: XTENSA,
  // what the sketch gets of the 520 KB SRAM once Wi-Fi and the core have theirs
  ramBytes: 320 * 1024,
  flashBytes: 1_310_720,
  eepromBytes: 4096,
  digitalPins: 39,
  analog: [26, 25, 34, 39, 36, 4],
  adcPins: [26, 25, 34, 39, 36, 4, 12, 13, 14, 15, 27, 32, 33, 35, 37],
  battMonitor: { pin: 35, ratio: 2 },
  // the pins marked RX and TX are Serial1
  uarts: [{ rx: 7, tx: 8 }],
  analogOnly: [],
  interrupts: Object.fromEntries([...FEATHER_GPIO, ...FEATHER_INPUTS, 0, 2, 38].map((p) => [p, p])),
  pwm: Object.fromEntries([...FEATHER_GPIO, 0, 2].map((p) => [p, 1000])),
  pwmTimer: {},
  ledBuiltin: 13,
  sda: 22,
  scl: 20,
  adcBits: 12,
  adcRefV: 3.3,
  logicV: 3.3,
  serialTx: 256,
  serialRx: 256,
  defines: {
    ARDUINO: "10812",
    ARDUINO_ARCH_ESP32: "1",
    ESP32: "1",
    ARDUINO_ADAFRUIT_FEATHER_ESP32_V2: "1",
    ESP_ARDUINO_VERSION_MAJOR: "3",
    F_CPU: "240000000L",
    __KERF_SIM__: "1",
  },
  arch: "esp32",
};

export const BOARDS: Board[] = [NANO, UNO, FEATHER_ESP32_V2];

export function boardFor(partId: string | undefined): Board | undefined {
  return BOARDS.find((b) => partId && b.parts.includes(partId));
}
