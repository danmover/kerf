// More controller boards, each one the firmware simulator runs as it is (src/sim/mcu/board.ts has their chips,
// pin maps and core quirks): the Seeed Studio XIAO ESP32S3 and XIAO ESP32C3, the STM32F411 Black Pill and the
// Adafruit Trinket 5V (ATtiny85). Pinouts are the makers' and the boards' Arduino core variant files; sizes are
// the makers'. Prices in Australia were read on 13 Nov 2026: XIAO ESP32S3 AU$16.10 and XIAO ESP32C3 AU$11.65 at
// Core Electronics, the DFRobot Black Pill AU$28.00 there, the Trinket 5V AU$13.95 at Little Bird Electronics.

import type { CatalogPart, PinDef } from "../types";
import { gnd, input, pwrIn, pwrOut, rail } from "./pins";

interface Pad {
  id: string;
  label?: string;
  /** the number (or name) the board's Arduino core gives the pin */
  mcu: string;
  adc?: boolean;
  pwm?: boolean;
  irq?: boolean;
  bus?: PinDef["bus"];
  imax?: number;
  note?: string;
}

const io = (v: number, p: Pad): PinDef => ({
  id: p.id,
  label: p.label,
  type: "io",
  v,
  imax: p.imax ?? 0.02,
  pwm: p.pwm ?? true,
  irq: p.irq ?? true,
  adc: p.adc || undefined,
  mcu: p.mcu,
  bus: p.bus,
  note: p.note,
});

// ---------------- Seeed Studio XIAO ----------------

// The XIAO's 14 pads, seen from the top with the USB-C end at -x: D0 to D6 along -y from the USB end, then 5V,
// GND, 3V3 and D10 down to D7 along +y. The board draws its pads as pin headers soldered underneath, in that order.
function xiaoPins(row1: Pad[], row2: Pad[], opts: { v3: number; v5Draw: number }): PinDef[] {
  return [
    ...row1.map((p) => io(3.3, p)),
    rail("V5", 5, 0.5, opts.v5Draw, { label: "5V", note: "USB's 5 V while it is plugged in; or feed a regulated 5 V in here (through a Schottky diode if USB may be plugged in at the same time)" }),
    gnd(),
    pwrOut("V3V3", 3.3, opts.v3, { label: "3V3", note: "The board's 3.3 V regulator output, with Wi-Fi's peaks on top" }),
    ...row2.map((p) => io(3.3, p)),
  ];
}

const xiaoGeom = (chip: { kind: "module" | "chip"; w: number; d: number; h: number }): CatalogPart["geom"] => ({
  g: "board",
  dims: { w: 21, d: 17.8, t: 1.2 },
  features: [
    { kind: "usb", x: -8.4, y: 0, w: 7.4, d: 9, h: 3.2 },
    { kind: chip.kind, x: 3.2, y: 0, w: chip.w, d: chip.d, h: chip.h },
  ],
  color: "#2b2d30",
});

export const XIAO_ESP32S3_PART: CatalogPart = {
  id: "esp32s3_xiao",
  kind: "controller",
  name: "Seeed Studio XIAO ESP32S3",
  maker: "Seeed Studio",
  mpn: "113991114",
  summary: "ESP32-S3 (dual-core 240 MHz, Wi-Fi and Bluetooth LE, 8 MB flash, 8 MB PSRAM) on a 21 × 17.8 mm board: 11 pins, 9 of them analog, all PWM, 3.3 V logic, USB-C and a LiPo charger. For small wireless gadgets.",
  specs: { mcu: "ESP32-S3", logic_v: 3.3, clock_mhz: 240, flash_kb: 8192, psram_kb: 8192, digital: 11, pwm: 11, analog: 9, wifi: true, bluetooth: true, platform: "arduino-esp32", fqbn: "esp32:esp32:XIAO_ESP32S3", pio_board: "seeed_xiao_esp32s3", mass_g: 3 },
  pins: xiaoPins(
    [
      { id: "D0", label: "D0/A0", mcu: "1", adc: true },
      { id: "D1", label: "D1/A1", mcu: "2", adc: true },
      { id: "D2", label: "D2/A2", mcu: "3", adc: true },
      { id: "D3", label: "D3/A3", mcu: "4", adc: true },
      { id: "D4", label: "D4/SDA", mcu: "5", adc: true, bus: "i2c_sda" },
      { id: "D5", label: "D5/SCL", mcu: "6", adc: true, bus: "i2c_scl" },
      { id: "D6", label: "D6/TX", mcu: "43", bus: "uart_tx", note: "GPIO43, UART0's TX: give it to Serial1.begin(baud, SERIAL_8N1, D7, D6)" },
    ],
    [
      { id: "D10", label: "D10/MOSI", mcu: "9", adc: true, bus: "spi_mosi" },
      { id: "D9", label: "D9/MISO", mcu: "8", adc: true, bus: "spi_miso" },
      { id: "D8", label: "D8/SCK", mcu: "7", adc: true, bus: "spi_sck" },
      { id: "D7", label: "D7/RX", mcu: "44", bus: "uart_rx", note: "GPIO44, UART0's RX" },
    ],
    { v3: 0.3, v5Draw: 0.1 },
  ),
  geom: xiaoGeom({ kind: "module", w: 11, d: 11.5, h: 2.2 }),
  price_usd: 7.49,
  buy: [
    { vendor: "Core Electronics (AU)", url: "https://core-electronics.com.au/seeed-studio-xiao-esp32s3.html" },
    { vendor: "Marketplace", search: "Seeed Studio XIAO ESP32S3" },
  ],
  source: "https://wiki.seeedstudio.com/xiao_esp32s3_getting_started/",
  notes: [
    "3.3 V logic: its pins are not 5 V tolerant.",
    "Serial is the USB-C port itself. Serial1.begin(baud) with no pins uses GPIO15 and 16, which no pad brings out: give it the RX and TX pads, Serial1.begin(115200, SERIAL_8N1, D7, D6).",
    "D0 to D5 and D8 to D10 are ADC1 inputs, which still read with Wi-Fi on. The user LED is GPIO21 (LED_BUILTIN), lit when LOW.",
    "A single-cell LiPo solders to the BAT+ and BAT- pads underneath; the board charges it from USB.",
    "No mounting holes: hold it by its edges or in a socket made of two 1 × 7 female headers, 15.24 mm apart.",
  ],
};

export const XIAO_ESP32C3_PART: CatalogPart = {
  id: "esp32c3_xiao",
  kind: "controller",
  name: "Seeed Studio XIAO ESP32C3",
  maker: "Seeed Studio",
  mpn: "113991054",
  summary: "ESP32-C3 (RISC-V 160 MHz, Wi-Fi and Bluetooth LE, 4 MB flash) on a 21 × 17.8 mm board: 11 pins, 3 analog, all PWM, 3.3 V logic, USB-C, a LiPo charger and an external antenna. The cheapest Wi-Fi board here.",
  specs: { mcu: "ESP32-C3", logic_v: 3.3, clock_mhz: 160, flash_kb: 4096, digital: 11, pwm: 11, analog: 3, wifi: true, bluetooth: true, platform: "arduino-esp32", fqbn: "esp32:esp32:XIAO_ESP32C3", pio_board: "seeed_xiao_esp32c3", mass_g: 3 },
  pins: xiaoPins(
    [
      { id: "D0", label: "D0/A0", mcu: "2", adc: true, note: "GPIO2, a strapping pin: nothing may hold it low at power-up" },
      { id: "D1", label: "D1/A1", mcu: "3", adc: true },
      { id: "D2", label: "D2/A2", mcu: "4", adc: true },
      { id: "D3", label: "D3", mcu: "5", note: "GPIO5: its ADC2 channel reads unreliably, so it is digital only here" },
      { id: "D4", label: "D4/SDA", mcu: "6", bus: "i2c_sda" },
      { id: "D5", label: "D5/SCL", mcu: "7", bus: "i2c_scl" },
      { id: "D6", label: "D6/TX", mcu: "21", bus: "uart_tx", note: "GPIO21, the TX pad: give it to Serial1.begin(baud, SERIAL_8N1, D7, D6)" },
    ],
    [
      { id: "D10", label: "D10/MOSI", mcu: "10", bus: "spi_mosi" },
      { id: "D9", label: "D9/MISO", mcu: "9", bus: "spi_miso", note: "GPIO9 is also the BOOT button: held low at power-up the board waits for an upload" },
      { id: "D8", label: "D8/SCK", mcu: "8", bus: "spi_sck", note: "GPIO8, a strapping pin: nothing may hold it low at power-up" },
      { id: "D7", label: "D7/RX", mcu: "20", bus: "uart_rx", note: "GPIO20, the RX pad" },
    ],
    { v3: 0.3, v5Draw: 0.08 },
  ),
  geom: xiaoGeom({ kind: "chip", w: 5, d: 5, h: 0.9 }),
  price_usd: 4.99,
  buy: [
    { vendor: "Core Electronics (AU)", url: "https://core-electronics.com.au/seeed-studio-xiao-esp32c3-tiny-mcu-board-with-wi-fi-and-ble-battery-charge-supported-power-efficiency-and-rich-interface.html" },
    { vendor: "Marketplace", search: "Seeed Studio XIAO ESP32C3" },
  ],
  source: "https://wiki.seeedstudio.com/XIAO_ESP32C3_Getting_Started/",
  notes: [
    "3.3 V logic: its pins are not 5 V tolerant. It has no user LED.",
    "Serial is the USB-C port itself. Serial1.begin(baud) with no pins puts UART1 on GPIO18 and 19, the USB port's own data lines, and the USB serial port drops: give it the RX and TX pads, Serial1.begin(115200, SERIAL_8N1, D7, D6). The C3 has no Serial2.",
    "Wi-Fi needs the stick-on antenna that comes with it, plugged into the U.FL socket: the board has none of its own.",
    "A single-cell LiPo solders to the BAT+ and BAT- pads underneath; the board charges it from USB.",
    "No mounting holes: hold it by its edges or in a socket made of two 1 × 7 female headers, 15.24 mm apart.",
  ],
};

// ---------------- STM32F411 Black Pill ----------------

// WeAct's Black Pill (DFRobot DFR0864, Adafruit 4877): two 20-pin rows 15.24 mm apart, the USB-C end at -x. Along
// +y from that end: B12 ... B9, then 5V, GND, 3V3; along -y: VB, C13, C14, C15, R, A0 ... B10, then 3V3, GND, 5V
// (stm32-base.org's header tables). Each power pin is on both rows; the wiring uses the +y ones.
const BP_PWM = new Set(["PA0", "PA1", "PA2", "PA3", "PA5", "PA6", "PA7", "PA8", "PA9", "PA10", "PA11", "PA15", "PB0", "PB1", "PB3", "PB4", "PB5", "PB6", "PB7", "PB8", "PB9", "PB10", "PB13", "PB14", "PB15"]);
const BP_ADC = new Set(["PA0", "PA1", "PA2", "PA3", "PA4", "PA5", "PA6", "PA7", "PB0", "PB1"]);
const BP_BUS: Record<string, PinDef["bus"]> = { PB7: "i2c_sda", PB6: "i2c_scl", PA9: "uart_tx", PA10: "uart_rx", PA7: "spi_mosi", PA6: "spi_miso", PA5: "spi_sck" };
const BP_NOTE: Record<string, string> = {
  PA0: "Also the KEY button, which pulls it to GND when pressed",
  PA11: "Also the USB port's D-: using it drops the USB serial port",
  PA12: "Also the USB port's D+: using it drops the USB serial port",
  PB2: "BOOT1: keep it low at reset",
  PC13: "Also the blue LED, lit when LOW: it sinks only about 3 mA, so keep loads on it light",
  PC14: "Wired to the 32.768 kHz clock crystal: avoid",
  PC15: "Wired to the 32.768 kHz clock crystal: avoid",
};
const bpPin = (name: string): PinDef =>
  io(3.3, {
    id: name,
    label: name.slice(1),
    mcu: name,
    adc: BP_ADC.has(name),
    pwm: BP_PWM.has(name),
    bus: BP_BUS[name],
    imax: name.startsWith("PC") ? 0.003 : 0.02,
    note: BP_NOTE[name],
  });

export const BLACKPILL_F411_PART: CatalogPart = {
  id: "blackpill_f411",
  kind: "controller",
  name: "STM32F411 Black Pill (WeAct, STM32F411CEU6)",
  maker: "WeAct Studio",
  mpn: "DFR0864",
  summary: "STM32F411 (Cortex-M4F with an FPU, 100 MHz, 512 KB flash, 128 KB RAM) on a 53 × 21 mm board: 32 pins, 10 analog, 25 PWM, every pin an interrupt, 3.3 V logic, USB-C. Fast maths and timers for control loops.",
  specs: { mcu: "STM32F411CEU6", logic_v: 3.3, clock_mhz: 100, flash_kb: 512, ram_kb: 128, digital: 32, pwm: 25, analog: 10, platform: "stm32duino", fqbn: "STMicroelectronics:stm32:GenF4:pnum=BLACKPILL_F411CE,usb=CDCgen", pio_board: "blackpill_f411ce", mass_g: 5 },
  pins: [
    ...["PB12", "PB13", "PB14", "PB15", "PA8", "PA9", "PA10", "PA11", "PA12", "PA15", "PB3", "PB4", "PB5", "PB6", "PB7", "PB8", "PB9"].map(bpPin),
    pwrIn("VBAT", 1.65, 3.6, { label: "VB", required: false, draw: 0, vabs: 4, note: "The real-time clock's backup supply: a coin cell here keeps the clock running with the power off" }),
    ...["PC13", "PC14", "PC15"].map(bpPin),
    input("NRST", 3.6, 2.0, { label: "R", note: "Pull to GND to reset" }),
    ...["PA0", "PA1", "PA2", "PA3", "PA4", "PA5", "PA6", "PA7", "PB0", "PB1", "PB2", "PB10"].map(bpPin),
    rail("V5", 5, 0.5, 0.04, { label: "5V", note: "USB-C's 5 V; or feed a regulated 5 V in here (through a Schottky diode if USB may be plugged in at the same time)" }),
    gnd(),
    pwrOut("V3V3", 3.3, 0.25, { label: "3V3", note: "The AP7343 regulator's output (300 mA, about 250 mA to spare)" }),
  ],
  geom: {
    g: "board",
    dims: { w: 52.81, d: 20.78, t: 1.6 },
    features: [
      { kind: "usb", x: -23.7, y: 0, w: 7.4, d: 9, h: 3.2 },
      { kind: "chip", x: 2, y: 0, w: 7, d: 7, h: 0.6 },
    ],
    color: "#16181b",
  },
  price_usd: 14.95,
  buy: [
    { vendor: "Core Electronics (AU)", url: "https://core-electronics.com.au/stm32f411-blackpill-development-board-49034.html" },
    { vendor: "Core Electronics (AU), Adafruit's", url: "https://core-electronics.com.au/stm32f411-blackpill-development-board.html" },
    { vendor: "Marketplace", search: "WeAct STM32F411CEU6 Black Pill V3.0" },
  ],
  source: "https://stm32-base.org/boards/STM32F411CEU6-WeAct-Black-Pill-V2.0.html",
  notes: [
    "3.3 V logic: put a level shifter between it and 5 V signals.",
    "In the Arduino IDE pick Generic STM32F4, board part number BlackPill F411CE, and USB support CDC (generic Serial supersede U(S)ART): then Serial is the USB-C port and Serial1 is USART1 on A9 (TX) and A10 (RX). With USB support off, Serial is USART1 instead.",
    "To upload over USB, hold BOOT0, tap NRST and let go of BOOT0 (the DFU bootloader), then upload with STM32CubeProgrammer; or use an ST-Link on the 4-pin SWD header at the far end.",
    "Pins with the same number (PA0 and PB0, PA5 and PB5 ...) share one interrupt line, so only one of them can have attachInterrupt() at a time. PA0, PA5 and PA15 share one PWM channel (TIM2_CH1), and so do others: give PWM outputs pins on different channels.",
    "No mounting holes: hold it in two 1 × 20 female headers 15.24 mm apart, or by its edges.",
  ],
};

// ---------------- Adafruit Trinket 5V ----------------

// Adafruit's Trinket 5V (product 1501): two rows of five pins along the long edges, 12.7 mm apart, the USB end at
// -x. Along -y from the USB end: BAT+, GND, #4, #3, RST; along +y: USB+, #0, #1, #2, 5V (Adafruit's pinout: the
// regulator's 5V output is the bottom-right pin, RST the bottom-left).
export const TRINKET_5V_PART: CatalogPart = {
  id: "trinket_5v",
  kind: "controller",
  name: "Adafruit Trinket 5V (ATtiny85)",
  maker: "Adafruit",
  mpn: "1501",
  summary: "ATtiny85 (8 MHz, 8 KB flash with 5.25 KB free, 512 bytes of RAM) on a 31 × 15.5 mm board: 5 pins, 3 PWM, 3 analog, 5 V logic. No serial port, I2C or SPI hardware. For a blinking or buzzing gadget, not for anything that talks.",
  specs: { mcu: "ATtiny85", logic_v: 5, clock_mhz: 8, flash_kb: 8, digital: 5, pwm: 3, analog: 3, vin_min: 5.5, vin_max: 16, platform: "arduino", fqbn: "adafruit:avr:trinket5", pio_board: "trinket5", mass_g: 2 },
  pins: [
    pwrIn("BAT", 5.5, 16, { label: "BAT+", required: false, draw: 0.01, vabs: 16, note: "A battery or adapter, 5.5 to 16 V, through the onboard 150 mA regulator" }),
    gnd(),
    io(5, { id: "D4", label: "#4", mcu: "4", adc: true, irq: false, note: "PB4: A2, PWM; also USB D+ with a 3.6 V zener on it, so it cannot drive a 5 V signal fully high" }),
    io(5, { id: "D3", label: "#3", mcu: "3", adc: true, pwm: false, irq: false, note: "PB3: A3; also USB D- with a 1.5 kΩ pull-up and a 3.6 V zener: fine for LEDs and buttons, poor for analog" }),
    input("RST", 5, 2.5, { label: "RST", note: "Pull to GND to reset (and start the bootloader for 10 s)" }),
    rail("USB", 5, 0.5, 0.01, { label: "USB+", note: "USB's 5 V while it is plugged in, up to 500 mA: power servos and LED strips from here, not from 5V" }),
    io(5, { id: "D0", label: "#0", mcu: "0", irq: false, bus: "i2c_sda", note: "PB0: PWM; SDA for the TinyWireM library" }),
    io(5, { id: "D1", label: "#1", mcu: "1", irq: false, note: "PB1: PWM; also the red LED" }),
    io(5, { id: "D2", label: "#2", mcu: "2", adc: true, pwm: false, bus: "i2c_scl", note: "PB2: A1, INT0 (attachInterrupt(0, ...)); SCL for the TinyWireM library" }),
    pwrOut("V5", 5, 0.15, { label: "5V", note: "The 150 mA regulator's output when BAT+ is powered (or USB's 5 V)" }),
  ],
  geom: {
    g: "board",
    dims: { w: 31, d: 15.5, t: 1.6 },
    features: [
      { kind: "usb", x: -13, y: 0, w: 5.6, d: 8, h: 3 },
      { kind: "chip", x: 6, y: 0, w: 5, d: 6.2, h: 1.7 },
    ],
    color: "#1d4f9c",
  },
  price_usd: 6.95,
  buy: [
    { vendor: "Little Bird Electronics (AU)", url: "https://littlebirdelectronics.com.au/products/adafruit-trinket-5v" },
    { vendor: "Adafruit", url: "https://www.adafruit.com/product/1501" },
  ],
  source: "https://learn.adafruit.com/introducing-trinket/pinouts",
  notes: [
    "Adafruit no longer recommends it for new designs: its bit-banged USB bootloader does not work with many modern computers. If uploads fail, program it through an ISP programmer (a USBasp, or an Uno running Arduino as ISP) on #0, #1, #2 and RST, or use a XIAO ESP32C3 (about the same price).",
    "In the Arduino IDE install Adafruit AVR Boards and pick Adafruit Trinket (ATtiny85 @ 8MHz).",
    "The ATtiny85 has no UART, TWI or SPI port: no Serial, Wire or SPI. TinyWireM does I2C on #0 and #2; debug by blinking the LED on #1.",
    "The pin positions are from Adafruit's pinout drawing: check them against the board before printing a mount.",
  ],
};

export const BOARDS: CatalogPart[] = [XIAO_ESP32S3_PART, XIAO_ESP32C3_PART, BLACKPILL_F411_PART, TRINKET_5V_PART];
