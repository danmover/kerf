// The boards the virtual microcontroller can be: chip, clock, memory, which
// pins do what, and the macros the Arduino core defines for them.

import { ARM, AVR, RISCV, XTENSA, type Abi } from "./ctypes";

/** the core family: which Arduino.h a sketch sees and how the HAL behaves */
export type Arch = "avr" | "esp32" | "rp2040" | "stm32" | "imxrt";

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
  /** pin number of A0, A1, ... (-1 where the board has no such An) */
  analog: number[];
  /** analog pins that cannot be used as digital pins (A6 and A7 on the Nano) */
  analogOnly: number[];
  /** pin -> external interrupt number */
  interrupts: Record<number, number>;
  /** pin -> PWM frequency in Hz (analogWrite) */
  pwm: Record<number, number>;
  /** which timer drives a PWM pin (Servo takes timer 1, tone() timer 2) */
  pwmTimer: Record<number, number>;
  /** the user LED's pin, -1 for none (no LED_BUILTIN) */
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
  arch?: Arch;
  /** ESP32: every GPIO analogRead() takes (its core takes GPIO numbers, so more than the A0.. names) */
  adcPins?: number[];
  /** a pin the board wires to its battery through a divider (the Feather's BATT_MONITOR), and the divider's ratio */
  battMonitor?: { pin: number; ratio: number };
  /** the pins Serial1, Serial2 use when begin() names none (ESP32: any pins can be given) */
  uarts?: ({ rx: number; tx: number } | undefined)[];
  /** the SPI library's pins (SS is the default chip select) */
  spi?: { ss: number; mosi: number; miso: number; sck: number };
  /** AVR: the number A0 has, when it is not analog[0] (the Trinket's A0 is 6, though channel 0 is its RESET pin, #5) */
  analogBase?: number;
  /** numbers that name another pin (the Trinket's A1, 7, is pin #2) */
  alias?: Record<number, number>;
  /** pins the board cannot use, and why (an ESP32 module's flash pins, a crystal's) */
  noPins?: Record<number, string>;
  /** pins that work but have a catch the sketch is told about once */
  pinWarn?: Record<number, string>;
  /** pins that can only be inputs (the ESP32's GPIO34 to 39) */
  inputOnly?: number[];
  /** the timer the Servo library takes, so PWM on that timer's pins stops (AVR) */
  servoTimer?: number;
  /** the timer tone() takes */
  toneTimer?: number;
  /** pins on one PWM channel share its duty: pin -> the channel */
  pwmShare?: Record<number, string>;
  /** interrupts that share a line, so only one of them can be attached: interrupt number (the pin, on the STM32) -> its line (EXTI goes by bit number) */
  irqLine?: Record<number, number>;
  /** pin -> its name on the pinout where plain numbers would not say (PA5 on an STM32) */
  pinNames?: Record<number, string>;
  /** what the pinout puts before a pin number (GPIO, GP, #) */
  pinPrefix?: string;
  /** more macros Arduino.h defines as pin numbers (D0.., PIN_LED, PA0..) */
  pinMacros?: Record<string, number>;
  /** Serial is the chip's own USB port: the baud rate does nothing and bytes go at USB speed */
  usbSerial?: boolean;
  /** the ADC's own resolution, when analogRead() gives adcBits until analogReadResolution() asks for more */
  adcHwBits?: number;
  /** names the board's core does not have, and the error a sketch that uses one gets */
  missing?: Record<string, string>;
  /** CAN ports (CAN1, CAN2, ...): the pins each one's controller drives its transceiver from */
  can?: { tx: number; rx: number }[];
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
  spi: { ss: 10, mosi: 11, miso: 12, sck: 13 },
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
  // the pins marked RX and TX are Serial1; Serial2 is the core's RX2/TX2 (GPIO4 and 25, the A5 and A1 pads)
  uarts: [
    { rx: 7, tx: 8 },
    { rx: 4, tx: 25 },
  ],
  analogOnly: [],
  interrupts: Object.fromEntries([...FEATHER_GPIO, ...FEATHER_INPUTS, 0, 2, 38].map((p) => [p, p])),
  pwm: Object.fromEntries([...FEATHER_GPIO, 0, 2].map((p) => [p, 1000])),
  pwmTimer: {},
  ledBuiltin: 13,
  sda: 22,
  scl: 20,
  spi: { ss: 33, mosi: 19, miso: 21, sck: 5 },
  adcBits: 12,
  adcRefV: 3.3,
  logicV: 3.3,
  serialTx: 256,
  serialRx: 256,
  pinMacros: { NEOPIXEL_I2C_POWER: 2, PIN_NEOPIXEL: 0, BUTTON: 38, BATT_MONITOR: 35, RX: 7, TX: 8 },
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

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const each = <T>(pins: number[], v: (p: number) => T): Record<number, T> => Object.fromEntries(pins.map((p) => [p, v(p)]));
const why = (pins: number[], text: string): Record<number, string> => each(pins, () => text);

// The Arduino Mega 2560 (ATmega2560): 54 digital pins and 16 analog, four UARTs, six external interrupts. analogWrite
// runs on timers 0 (4, 13 at 980 Hz) and 1, 2, 3, 4, 5 (490 Hz); Servo takes timer 5 for its first 12 servos (44 to
// 46 lose PWM) and tone() timer 2 (9 and 10), by the core's variants/mega/pins_arduino.h and Servo's ServoTimers.h.
const MEGA_PWM = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 44, 45, 46];
const MEGA_TIMER: Record<number, number> = { 4: 0, 13: 0, 11: 1, 12: 1, 9: 2, 10: 2, 2: 3, 3: 3, 5: 3, 6: 4, 7: 4, 8: 4, 44: 5, 45: 5, 46: 5 };
export const MEGA: Board = {
  parts: ["arduino_mega"],
  name: "Arduino Mega 2560",
  mcu: "ATmega2560",
  fcpu: 16_000_000,
  abi: AVR,
  ramBytes: 8192,
  flashBytes: 262144 - 8192,
  eepromBytes: 4096,
  digitalPins: 69,
  analog: range(54, 69),
  analogOnly: [],
  interrupts: { 2: 0, 3: 1, 18: 5, 19: 4, 20: 3, 21: 2 },
  pwm: each(MEGA_PWM, (p) => (p === 4 || p === 13 ? 980 : 490)),
  pwmTimer: MEGA_TIMER,
  servoTimer: 5,
  toneTimer: 2,
  ledBuiltin: 13,
  sda: 20,
  scl: 21,
  spi: { ss: 53, mosi: 51, miso: 50, sck: 52 },
  uarts: [
    { rx: 19, tx: 18 },
    { rx: 17, tx: 16 },
    { rx: 15, tx: 14 },
  ],
  adcBits: 10,
  adcRefV: 5,
  logicV: 5,
  serialTx: 64,
  serialRx: 64,
  defines: { ARDUINO: "10819", ARDUINO_ARCH_AVR: "1", ARDUINO_AVR_MEGA2560: "1", __AVR__: "1", __AVR_ATmega2560__: "1", F_CPU: "16000000L", __KERF_SIM__: "1" },
  arch: "avr",
};

// The ESP32 family on the Arduino ESP32 core 3.x: GPIO numbers are the pin numbers, every output does PWM (LEDC,
// 1 kHz and 8 bits for analogWrite) and takes interrupts. Serial1 and Serial2 default to the core's RX1/TX1 and
// RX2/TX2 for the chip (HardwareSerial.h), on any pins begin() names instead.
const espDefines = (board: string, target: string | null, mhz: number): Record<string, string> => ({
  ARDUINO: "10812",
  ARDUINO_ARCH_ESP32: "1",
  ESP32: "1",
  ...(target ? { [`CONFIG_IDF_TARGET_${target}`]: "1", ARDUINO_USB_CDC_ON_BOOT: "1" } : { CONFIG_IDF_TARGET_ESP32: "1" }),
  [board]: "1",
  ESP_ARDUINO_VERSION_MAJOR: "3",
  F_CPU: `${mhz}000000L`,
  __KERF_SIM__: "1",
});

// ESP32-DevKitC V4 (ESP32-WROOM-32E): variants/esp32/pins_arduino.h. No user LED, so no LED_BUILTIN; A1 and A2 do
// not exist. GPIO6 to 11 run the module's flash; 34 to 39 are inputs only; ADC2 (0, 2, 4, 12 to 15, 25 to 27) stops
// reading while Wi-Fi is on.
const DEVKITC_IO = [0, 1, 2, 3, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33];
const DEVKITC_IN = [34, 35, 36, 39];
export const ESP32_DEVKITC: Board = {
  parts: ["esp32_devkitc"],
  name: "ESP32-DevKitC",
  mcu: "ESP32",
  fcpu: 240_000_000,
  abi: XTENSA,
  ramBytes: 320 * 1024,
  flashBytes: 1_310_720,
  eepromBytes: 4096,
  digitalPins: 39,
  analog: [36, -1, -1, 39, 32, 33, 34, 35, -1, -1, 4, 0, 2, 15, 13, 12, 14, 27, 25, 26],
  adcPins: [36, 39, 32, 33, 34, 35, 4, 0, 2, 15, 13, 12, 14, 27, 25, 26],
  analogOnly: [],
  inputOnly: DEVKITC_IN,
  noPins: {
    ...why(range(6, 11), "GPIO6 to 11 run the ESP32 module's flash chip: using one crashes the board"),
    ...why([20, 24, 28, 29, 30, 31], "the ESP32 has no such GPIO"),
    ...why([37, 38], "the WROOM module does not bring GPIO37 and 38 out"),
  },
  pinWarn: {
    0: "GPIO0 is a strapping pin (the BOOT button): held low at reset, the board waits for an upload instead of running the sketch",
    2: "GPIO2 is a strapping pin: it must be low or floating at reset for uploads to work",
    12: "GPIO12 is a strapping pin that sets the flash voltage: pulled high at reset, the board will not boot",
    1: "GPIO1 is TX0, the USB serial port's transmit line: driving it garbles the serial monitor",
    3: "GPIO3 is RX0, the USB serial port's receive line",
  },
  interrupts: each([...DEVKITC_IO, ...DEVKITC_IN], (p) => p),
  pwm: each(DEVKITC_IO, () => 1000),
  pwmTimer: {},
  ledBuiltin: -1,
  sda: 21,
  scl: 22,
  spi: { ss: 5, mosi: 23, miso: 19, sck: 18 },
  uarts: [
    { rx: 26, tx: 27 },
    { rx: 4, tx: 25 },
  ],
  adcBits: 12,
  adcRefV: 3.3,
  logicV: 3.3,
  serialTx: 256,
  serialRx: 256,
  pinMacros: { RX: 3, TX: 1, ...Object.fromEntries([4, 0, 2, 15, 13, 12, 14, 27, 33, 32].map((p, i) => [`T${i}`, p])), DAC1: 25, DAC2: 26 },
  pinPrefix: "GPIO",
  defines: espDefines("ARDUINO_ESP32_DEV", null, 240),
  arch: "esp32",
};

// Seeed Studio XIAO ESP32S3 (ESP32-S3R8: 8 MB flash, 8 MB octal PSRAM): variants/XIAO_ESP32S3/pins_arduino.h. Pads
// D0 to D10 are GPIO1 to 9, 43 and 44; the user LED is GPIO21. Serial is the chip's own USB port. The octal PSRAM
// takes GPIO33 to 37 and the flash 26 to 32; GPIO19 and 20 are the USB port's D- and D+.
const S3_IO = [...range(0, 21), ...range(38, 48)];
export const XIAO_ESP32S3: Board = {
  parts: ["esp32s3_xiao"],
  name: "XIAO ESP32S3",
  mcu: "ESP32-S3",
  fcpu: 240_000_000,
  abi: XTENSA,
  ramBytes: 320 * 1024,
  flashBytes: 3_342_336,
  eepromBytes: 4096,
  digitalPins: 48,
  analog: [1, 2, 3, 4, 5, 6, -1, -1, 7, 8, 9],
  adcPins: range(1, 20),
  analogOnly: [],
  noPins: {
    ...why(range(22, 25), "the ESP32-S3 has no GPIO22 to 25"),
    ...why(range(26, 32), "GPIO26 to 32 run the ESP32-S3's flash and PSRAM: using one crashes the board"),
    ...why(range(33, 37), "GPIO33 to 37 run the XIAO ESP32S3's octal PSRAM: using one crashes the board"),
  },
  pinWarn: {
    19: "GPIO19 is the USB port's D-: using it as a pin drops the USB serial port",
    20: "GPIO20 is the USB port's D+: using it as a pin drops the USB serial port",
    0: "GPIO0 is the BOOT button's strapping pin: held low at reset, the board waits for an upload",
  },
  interrupts: each(S3_IO, (p) => p),
  pwm: each(S3_IO, () => 1000),
  pwmTimer: {},
  ledBuiltin: 21,
  sda: 5,
  scl: 6,
  spi: { ss: 44, mosi: 9, miso: 8, sck: 7 },
  uarts: [
    { rx: 15, tx: 16 },
    { rx: 19, tx: 20 },
  ],
  adcBits: 12,
  // the S3's ADC reads to about 3.1 V at its widest attenuation
  adcRefV: 3.1,
  logicV: 3.3,
  serialTx: 256,
  serialRx: 256,
  usbSerial: true,
  pinMacros: { ...Object.fromEntries([1, 2, 3, 4, 5, 6, 43, 44, 7, 8, 9].map((p, i) => [`D${i}`, p])), RX: 44, TX: 43, BUILTIN_LED: 21 },
  pinPrefix: "GPIO",
  defines: espDefines("ARDUINO_XIAO_ESP32S3", "ESP32S3", 240),
  arch: "esp32",
};

// Seeed Studio XIAO ESP32C3 (ESP32-C3, RISC-V, 4 MB flash): variants/XIAO_ESP32C3/pins_arduino.h. Pads D0 to D10 are
// GPIO2 to 10, 20 and 21; A0 to A2 are GPIO2 to 4. No user LED. Serial is the chip's own USB port (GPIO18 and 19).
// GPIO2, 8 and 9 are strapping pins (9 is the BOOT button). The C3 has two UARTs, so Serial1 and no Serial2.
const C3_IO = [...range(0, 10), ...range(18, 21)];
export const XIAO_ESP32C3: Board = {
  parts: ["esp32c3_xiao"],
  name: "XIAO ESP32C3",
  mcu: "ESP32-C3",
  fcpu: 160_000_000,
  abi: RISCV,
  ramBytes: 256 * 1024,
  flashBytes: 1_310_720,
  eepromBytes: 4096,
  digitalPins: 21,
  analog: [2, 3, 4],
  adcPins: range(0, 5),
  analogOnly: [],
  noPins: why(range(11, 17), "GPIO11 to 17 run the ESP32-C3's flash chip: using one crashes the board"),
  pinWarn: {
    18: "GPIO18 is the USB port's D-: using it as a pin drops the USB serial port",
    19: "GPIO19 is the USB port's D+: using it as a pin drops the USB serial port",
    9: "GPIO9 (D9) is the BOOT button's strapping pin: held low at reset, the board waits for an upload",
    8: "GPIO8 (D8) is a strapping pin: it must not be held low at reset",
    2: "GPIO2 (D0) is a strapping pin: it must not be held low at reset",
  },
  interrupts: each(C3_IO, (p) => p),
  pwm: each(C3_IO, () => 1000),
  pwmTimer: {},
  ledBuiltin: -1,
  sda: 6,
  scl: 7,
  spi: { ss: 20, mosi: 10, miso: 9, sck: 8 },
  uarts: [{ rx: 18, tx: 19 }],
  adcBits: 12,
  // the C3's ADC reads to about 2.5 V at its widest attenuation
  adcRefV: 2.5,
  logicV: 3.3,
  serialTx: 256,
  serialRx: 256,
  usbSerial: true,
  pinMacros: { ...Object.fromEntries([2, 3, 4, 5, 6, 7, 21, 20, 8, 9, 10].map((p, i) => [`D${i}`, p])), RX: 20, TX: 21 },
  pinPrefix: "GPIO",
  defines: espDefines("ARDUINO_XIAO_ESP32C3", "ESP32C3", 160),
  arch: "esp32",
};

// Raspberry Pi Pico (RP2040) on Earle Philhower's arduino-pico core: variants/rpipico/pins_arduino.h and boards.txt
// (200 MHz is the core's default). GP numbers are the pin numbers; every GPIO does PWM (1 kHz, 0 to 255 for
// analogWrite) and takes interrupts. A pin and the one 16 above it share a PWM slice's channel, so one duty. A0 to A2
// are GP26 to 28; A3 (GP29) reads VSYS through a 1:3 divider. analogRead() gives 10 bits until analogReadResolution().
// Serial is the chip's own USB port; Serial1 is GP0/GP1 and Serial2 GP8/GP9.
const PICO_IO = range(0, 29);
export const PICO: Board = {
  parts: ["rpi_pico"],
  name: "Raspberry Pi Pico",
  mcu: "RP2040",
  fcpu: 200_000_000,
  abi: ARM,
  ramBytes: 256 * 1024,
  flashBytes: 2_093_056,
  eepromBytes: 4096,
  digitalPins: 29,
  analog: [26, 27, 28, 29],
  adcPins: [26, 27, 28, 29],
  battMonitor: { pin: 29, ratio: 3 },
  analogOnly: [],
  pinWarn: {
    23: "GP23 sets the Pico's regulator mode: high for lower ripple, low (the default) for efficiency at light load",
    24: "GP24 reads whether USB power (VBUS) is there; it is not on a pin",
  },
  interrupts: each(PICO_IO, (p) => p),
  pwm: each(PICO_IO, () => 1000),
  pwmShare: each(PICO_IO, (p) => `PWM slice ${(p >> 1) & 7} channel ${p & 1 ? "B" : "A"}`),
  pwmTimer: {},
  ledBuiltin: 25,
  sda: 4,
  scl: 5,
  spi: { ss: 17, mosi: 19, miso: 16, sck: 18 },
  uarts: [
    { rx: 1, tx: 0 },
    { rx: 9, tx: 8 },
  ],
  adcBits: 10,
  adcHwBits: 12,
  adcRefV: 3.3,
  logicV: 3.3,
  serialTx: 256,
  serialRx: 256,
  usbSerial: true,
  pinMacros: { PIN_LED: 25, PIN_SERIAL1_TX: 0, PIN_SERIAL1_RX: 1, PIN_SERIAL2_TX: 8, PIN_SERIAL2_RX: 9, PIN_WIRE0_SDA: 4, PIN_WIRE0_SCL: 5, PIN_SPI0_MISO: 16, PIN_SPI0_MOSI: 19, PIN_SPI0_SCK: 18, PIN_SPI0_SS: 17 },
  pinPrefix: "GP",
  defines: { ARDUINO: "10607", ARDUINO_ARCH_RP2040: "1", ARDUINO_RASPBERRY_PI_PICO: "1", PICO_RP2040: "1", F_CPU: "200000000L", __KERF_SIM__: "1" },
  arch: "rp2040",
};

// The STM32F411 Black Pill (WeAct's design; DFRobot DFR0864, Adafruit 4877) on STM32duino:
// variants/STM32F4xx/F411C(C-E)(U-Y)/variant_BLACKPILL_F411CE.h and its PeripheralPins. Pins are numbered PA0..PA15
// = 0..15, PB0.. = 16.. (there is no PB11), PC13 = 31; A0 to A9 are PA0 to PA7, PB0 and PB1. analogWrite is 1 kHz and
// 8 bits on the timer channel each pin has (pins on one channel share its duty: PA0, PA5 and PA15 are all TIM2_CH1);
// a pin's interrupt comes in on the EXTI line of its bit number, which PA0 and PB0 share. The user LED (PC13) lights
// when LOW; the KEY button (PA0) pulls to ground. Serial is the USB port (USB CDC), Serial1 USART1 on PA9 and PA10.
const BP_NAMES: Record<number, string> = {
  ...Object.fromEntries(range(0, 15).map((n) => [n, `PA${n}`])),
  ...Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15].map((n, i) => [16 + i, `PB${n}`])),
  31: "PC13",
  32: "PC14",
  33: "PC15",
  34: "PH0",
  35: "PH1",
};
const BP_TIMER: Record<string, string> = {
  PA0: "TIM2_CH1",
  PA5: "TIM2_CH1",
  PA15: "TIM2_CH1",
  PA1: "TIM2_CH2",
  PB3: "TIM2_CH2",
  PA2: "TIM2_CH3",
  PB10: "TIM2_CH3",
  PA3: "TIM2_CH4",
  PA6: "TIM3_CH1",
  PB4: "TIM3_CH1",
  PB5: "TIM3_CH2",
  PA7: "TIM1_CH1",
  PA8: "TIM1_CH1",
  PB13: "TIM1_CH1",
  PA9: "TIM1_CH2",
  PB0: "TIM1_CH2",
  PB14: "TIM1_CH2",
  PA10: "TIM1_CH3",
  PB1: "TIM1_CH3",
  PB15: "TIM1_CH3",
  PA11: "TIM1_CH4",
  PB6: "TIM4_CH1",
  PB7: "TIM4_CH2",
  PB8: "TIM4_CH3",
  PB9: "TIM4_CH4",
};
const BP_PIN = Object.fromEntries(Object.entries(BP_NAMES).map(([n, name]) => [name, +n])) as Record<string, number>;
const BP_PWM = Object.keys(BP_TIMER).map((name) => BP_PIN[name]);
const BP_IO = range(0, 33);
export const BLACKPILL_F411: Board = {
  parts: ["blackpill_f411"],
  name: "STM32F411 Black Pill",
  mcu: "STM32F411CEU6",
  fcpu: 100_000_000,
  abi: ARM,
  ramBytes: 120 * 1024,
  flashBytes: 524288,
  // EEPROM is emulated in one 16 KB flash page
  eepromBytes: 16384,
  digitalPins: 35,
  analog: [0, 1, 2, 3, 4, 5, 6, 7, 16, 17],
  analogOnly: [],
  noPins: why([34, 35], "PH0 and PH1 run the Black Pill's 25 MHz crystal: the chip's clock stops if they are used"),
  pinWarn: {
    11: "PA11 is the USB port's D-: using it as a pin drops the USB serial port",
    12: "PA12 is the USB port's D+: using it as a pin drops the USB serial port",
    13: "PA13 is SWDIO: using it as a pin cuts off an ST-Link debugger",
    14: "PA14 is SWCLK: using it as a pin cuts off an ST-Link debugger",
    32: "PC14 and PC15 run the 32.768 kHz crystal for the real-time clock",
    33: "PC14 and PC15 run the 32.768 kHz crystal for the real-time clock",
  },
  interrupts: each(BP_IO, (p) => p),
  irqLine: each(BP_IO, (p) => Number(/\d+$/.exec(BP_NAMES[p])![0])),
  pwm: each(BP_PWM, () => 1000),
  pwmShare: each(BP_PWM, (p) => BP_TIMER[BP_NAMES[p]]),
  pwmTimer: {},
  ledBuiltin: 31,
  sda: BP_PIN.PB7,
  scl: BP_PIN.PB6,
  spi: { ss: BP_PIN.PA4, mosi: BP_PIN.PA7, miso: BP_PIN.PA6, sck: BP_PIN.PA5 },
  uarts: [{ rx: BP_PIN.PA10, tx: BP_PIN.PA9 }],
  adcBits: 10,
  adcHwBits: 12,
  adcRefV: 3.3,
  logicV: 3.3,
  serialTx: 256,
  serialRx: 256,
  usbSerial: true,
  pinNames: BP_NAMES,
  pinMacros: { ...BP_PIN, USER_BTN: BP_PIN.PA0 },
  defines: { ARDUINO: "10607", ARDUINO_ARCH_STM32: "1", ARDUINO_BLACKPILL_F411CE: "1", STM32F4xx: "1", STM32F411xE: "1", F_CPU: "100000000L", __KERF_SIM__: "1" },
  arch: "stm32",
};

// Adafruit Trinket 5V (ATtiny85 at 8 MHz) on Adafruit's AVR boards: the standard Arduino core with the tiny8 variant.
// Pins #0 to #4 are PB0 to PB4 (#5 is RESET). analogRead() takes ADC channels: 1 is #2, 2 is #4, 3 is #3, and A1 to
// A3 are 7 to 9 (channel + 6). PWM on #0, #1 (timer 0) and #4 (timer 1). The chip has no UART, TWI or SPI port, so the
// core has no Serial, Wire or SPI; Servo and tone() need timers it lacks. #3 and #4 double as the USB data lines.
export const TRINKET_5V: Board = {
  parts: ["trinket_5v"],
  name: "Adafruit Trinket 5V",
  mcu: "ATtiny85",
  fcpu: 8_000_000,
  abi: AVR,
  ramBytes: 512,
  flashBytes: 5310,
  eepromBytes: 512,
  digitalPins: 5,
  analog: [5, 2, 4, 3],
  analogBase: 6,
  alias: { 6: 5, 7: 2, 8: 4, 9: 3 },
  analogOnly: [],
  noPins: { 5: "pin #5 is the ATtiny85's RESET line on the Trinket: it cannot be used as a pin" },
  pinWarn: {
    3: "#3 is also USB D-, with a 1.5 kΩ pull-up and a 3.6 V zener on it: fine for inputs and LEDs, but it cannot drive a 5 V signal high",
    4: "#4 is also USB D+, with a 3.6 V zener on it: it cannot drive a 5 V signal fully high",
  },
  interrupts: { 2: 0 },
  pwm: { 0: 490, 1: 490, 4: 490 },
  pwmTimer: { 0: 0, 1: 0, 4: 1 },
  ledBuiltin: 1,
  sda: 0,
  scl: 2,
  adcBits: 10,
  adcRefV: 5,
  logicV: 5,
  serialTx: 0,
  serialRx: 0,
  pinPrefix: "#",
  missing: {
    Serial: "'Serial' was not declared in this scope: the ATtiny85 has no UART, so the Trinket's core has no Serial. Blink the LED on #1 to see what the sketch does, or send with a software serial library to a USB-serial adapter",
    Serial1: "'Serial1' was not declared in this scope: the ATtiny85 has no UART",
    Serial2: "'Serial2' was not declared in this scope: the ATtiny85 has no UART",
    Serial3: "'Serial3' was not declared in this scope: the ATtiny85 has no UART",
    Wire: "'Wire' was not declared in this scope: the ATtiny85 has no TWI port for the Wire library. I2C on the Trinket goes through its USI with Adafruit's TinyWireM library (SDA #0, SCL #2), which the simulator does not run",
    SPI: "'SPI' was not declared in this scope: the ATtiny85 has no SPI port for the SPI library (its USI does SPI through other libraries)",
    Servo: "The Servo library does not build for the ATtiny85: it needs a 16-bit timer the chip lacks. Adafruit_SoftServo drives servos on the Trinket, refreshed from timer 0's interrupt",
    tone: "tone() does not build for the ATtiny85: the core runs it on timer 2, which the chip lacks. Toggle the pin from a loop or from timer 1's interrupt instead",
    noTone: "noTone() does not build for the ATtiny85: the core runs tone() on timer 2, which the chip lacks",
  },
  defines: { ARDUINO: "10819", ARDUINO_ARCH_AVR: "1", ARDUINO_AVR_TRINKET5: "1", __AVR__: "1", __AVR_ATtiny85__: "1", F_CPU: "8000000L", __KERF_SIM__: "1" },
  arch: "avr",
};

// PJRC Teensy 4.1 (NXP i.MX RT1062, Cortex-M7 at 600 MHz) on Teensyduino: its pinout card and cores/teensy4. Pins
// 0 to 41; A0 to A17 are pins 14 to 27 and 38 to 41; every pin takes interrupts; PWM on 0 to 15, 18, 19, 22 to 25,
// 28, 29, 33, 36 and 37 (4.482 kHz by default). Serial is the chip's own USB port. CAN1 is CTX1/CRX1 on pins 22/23,
// CAN2 CTX2/CRX2 on 1/0, CAN3 (CAN FD) CTX3/CRX3 on 31/30. Wire is pins 18 (SDA) and 19 (SCL).
const TEENSY_IO = range(0, 41);
const TEENSY_PWM = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 18, 19, 22, 23, 24, 25, 28, 29, 33, 36, 37];
export const TEENSY_41: Board = {
  parts: ["teensy_41"],
  name: "Teensy 4.1",
  mcu: "i.MX RT1062",
  fcpu: 600_000_000,
  abi: ARM,
  ramBytes: 1024 * 1024,
  flashBytes: 8_126_464,
  eepromBytes: 4284,
  digitalPins: 41,
  analog: [14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 38, 39, 40, 41],
  analogOnly: [],
  interrupts: each(TEENSY_IO, (p) => p),
  pwm: Object.fromEntries(TEENSY_PWM.map((p) => [p, 4482])),
  pwmTimer: {},
  ledBuiltin: 13,
  sda: 18,
  scl: 19,
  spi: { ss: 10, mosi: 11, miso: 12, sck: 13 },
  uarts: [
    { rx: 0, tx: 1 },
    { rx: 7, tx: 8 },
    { rx: 15, tx: 14 },
    { rx: 16, tx: 17 },
    { rx: 21, tx: 20 },
    { rx: 25, tx: 24 },
    { rx: 28, tx: 29 },
    { rx: 34, tx: 35 },
  ],
  can: [
    { tx: 22, rx: 23 },
    { tx: 1, rx: 0 },
    { tx: 31, rx: 30 },
  ],
  adcBits: 10,
  adcHwBits: 12,
  adcRefV: 3.3,
  logicV: 3.3,
  serialTx: 64,
  serialRx: 64,
  usbSerial: true,
  defines: { ARDUINO: "10819", TEENSYDUINO: "159", ARDUINO_TEENSY41: "1", __IMXRT1062__: "1", F_CPU: "600000000", __KERF_SIM__: "1" },
  arch: "imxrt",
};

export const BOARDS: Board[] = [NANO, UNO, FEATHER_ESP32_V2, MEGA, ESP32_DEVKITC, XIAO_ESP32S3, XIAO_ESP32C3, PICO, BLACKPILL_F411, TRINKET_5V, TEENSY_41];

/** A pin's name as the board's pinout prints it: D13 and A0 on an AVR, GPIO13, GP13, PA5, #2. */
export function pinLabel(b: Board, pin: number): string {
  const named = b.pinNames?.[pin];
  if (named) return named;
  if (b.pinPrefix) return `${b.pinPrefix}${pin}`;
  if (b.arch === "esp32") return `GPIO${pin}`;
  const a = b.analog.indexOf(pin);
  return a >= 0 ? `A${a}` : `D${pin}`;
}

/** The compiler's error for a name the board's core lacks (the ATtiny85's Serial, Serial1 on an Uno), or undefined. */
export function boardLacks(b: Board, name: string): string | undefined {
  const m = b.missing?.[name];
  if (m) return m;
  const s = /^Serial([1-9])$/.exec(name);
  const n = b.uarts?.length ?? 0;
  if (s && +s[1] > n) return `'${name}' was not declared in this scope: the ${b.name} has ${n ? ["Serial", ...b.uarts!.map((_, i) => `Serial${i + 1}`)].join(", ") : "one hardware serial port, Serial"}`;
  return undefined;
}

/** The pin a catalogue part's `mcu` name is on the board: A0.. by its analog map, a number as itself, or a name its core defines (PA5). */
export function mcuPin(b: Board, mcu: string | undefined): number | undefined {
  if (!mcu) return undefined;
  const a = /^A(\d+)$/.exec(mcu);
  // -1 where the board has no such An (the DevKitC's A1)
  if (a) return (b.analog[+a[1]] ?? -1) >= 0 ? b.analog[+a[1]] : undefined;
  const n = Number(mcu);
  return Number.isInteger(n) ? n : b.pinMacros?.[mcu];
}

/** The pins a sketch can use: every number up to the board's top, less the ones it lacks. */
export function boardPins(b: Board): number[] {
  const top = Math.max(b.digitalPins, ...b.analogOnly);
  return range(0, top).filter((p) => !b.noPins?.[p]);
}

export function boardFor(partId: string | undefined): Board | undefined {
  return BOARDS.find((b) => partId && b.parts.includes(partId));
}
