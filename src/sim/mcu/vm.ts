// What compiled firmware code calls to touch the chip: time, pins, the serial
// port, I2C, EEPROM and servos. The simulation engine implements it; the
// compiler (compile.ts) only charges cycles and calls these.

import type { Arch, Board } from "./board";

/** A pointer: an element of a JS array that holds the pointee's memory. */
export interface Ptr {
  m: unknown[];
  i: number;
  /** pointer into read-only memory (a string literal) */
  ro?: boolean;
}

export interface FnRef {
  fnName: string;
  call: (args: unknown[]) => unknown;
}

/** A memory-mapped I/O register: reads and writes go to the peripheral. */
export interface IoRegister {
  bits: 8 | 16;
  read(): number;
  write(v: number): void;
}

export interface Hal {
  /** CPU clock in Hz */
  fcpu: number;
  /** the core family: the AVR (Uno, Nano, Mega, ATtiny85), the ESP32, the RP2040 or the STM32 */
  arch?: Arch;
  /** the board's profile: its pins, ports and what its core lacks */
  board?: Board;
  /** cycles elapsed since reset */
  cyc: number;
  /** when cyc reaches this, call service() */
  nextEvt: number;
  /** catch up the world to the current time and run due interrupts */
  service(): void;
  /** spend cycles (busy waiting, slow library calls) while the world runs on */
  spend(cycles: number): void;

  pinMode(pin: number, mode: number): void;
  digitalWrite(pin: number, v: number): void;
  digitalRead(pin: number): number;
  analogRead(pin: number): number;
  analogMilliVolts(pin: number): number;
  analogWrite(pin: number, v: number): void;
  analogReference(mode: number): void;
  /** ESP32 LEDC: set a pin's PWM rate (Hz) and resolution (bits); false when the timer cannot make them */
  pwmAttach?(pin: number, hz: number, bits: number, what?: string): boolean;
  /** ESP32 LEDC: write a duty in the pin's own resolution */
  pwmWrite?(pin: number, duty: number): boolean;
  pwmRead?(pin: number): number;
  /** the RP2040 and STM32 cores' analogWriteResolution(bits), analogWriteRange(top), analogWriteFreq(hz): every pin at once */
  pwmGlobal?(what: "bits" | "range" | "hz", v: number): void;
  /** analogReadResolution(): the bits analogRead() returns on the 32-bit cores */
  readResolution?(bits: number): void;
  /** the PWM rate on a pin, Hz */
  pwmHz?(pin: number): number;
  attachInterrupt(n: number, fn: FnRef, mode: number): void;
  detachInterrupt(n: number): void;
  digitalPinToInterrupt(pin: number): number;
  setInterrupts(on: boolean): void;
  millis(): number;
  micros(): number;
  /** delay(): the core's time, which runs off timer 0 on the AVR */
  delayMs?(ms: number): void;
  tone(pin: number, freq: number, ms: number): void;
  noTone(pin: number): void;

  serialBegin(port: number, baud: number, rx?: number, tx?: number): void;
  /** wait for n bytes on a port, at most ms: how many are there */
  serialWait?(port: number, n: number, ms: number): number;
  serialWrite(port: number, bytes: number[]): number;
  serialAvailable(port: number): number;
  serialRead(port: number): number;
  serialPeek(port: number): number;
  serialFlush(port: number): void;

  wireBegin(): void;
  wireSetClock(hz: number): void;
  /** write bytes to a device; 0 = acknowledged, 2 = no device at that address */
  wireWrite(addr: number, bytes: number[], stop: boolean): number;
  /** read up to n bytes from a device */
  wireRead(addr: number, n: number, stop: boolean): number[];

  eeprom: Uint8Array;
  /** program an EEPROM byte: store it and spend the 3.3 ms it takes */
  eepromWrite(addr: number, v: number): void;

  servoPulse(pin: number, us: number | null): void;

  /** CAN ports (FlexCAN_T4 on the Teensy 4.x), numbered from 1: open one with its receive queue and transmit mailboxes */
  canBegin?(port: number, baud: number, rxSize: number, txMailboxes: number): void;
  canBaud?(port: number, baud: number): void;
  /** queue a frame for the wire: false when every transmit mailbox is still waiting */
  canWrite?(port: number, f: { id: number; len: number; buf: number[] }): boolean;
  /** the oldest frame received by now, with its arrival time in bus bit times (the library's timestamp), or null */
  canRead?(port: number): { id: number; len: number; buf: number[]; ts: number } | null;
  /** Adafruit_NeoPixel show(): a frame of 0xWWRRGGBB colours sent down a data pin, with the library's NEO_* type */
  pixels?(pin: number, colours: number[], type: number): void;
  /** pulseIn(): microseconds the pin stayed at state, 0 on timeout (polled when absent) */
  pulseIn?(pin: number, state: number, timeoutUs: number): number;

  /** an I/O register by name (ADCSRA, SREG), when the board models it */
  register?(name: string): IoRegister | undefined;

  /** a library's interrupt handler on one of the chip's vectors (TimerOne's callback), or null to take it away */
  setVector?(name: string, fn: FnRef | null): void;
  /** the ESP32 core's hardware timers (timerBegin), on a board that has them */
  hwTimers?: HwTimers;
  /** the SPI bus and what is wired to it */
  spi?: SpiPort;

  /** a mistake in the firmware the chip would not report (index out of range, divide by zero) */
  fault(msg: string, file: string, line: number): void;
  /** stack bytes in use changed (for the RAM estimate) */
  stack(bytes: number): void;
}

/** A device on the SPI bus: it answers while its chip-select pin is low. */
export interface SpiDevice {
  name: string;
  /** the fastest clock it takes, Hz */
  maxHz: number;
  /** the SPI modes (0 to 3) it answers in */
  modes: number[];
  /** one byte each way */
  transfer(out: number, t: number): number;
  /** its chip select went low (true) or back high */
  select?(on: boolean, t: number): void;
  /** powered and answering */
  ready?(t: number): boolean;
}

/** The SPI library's view of the bus: the clock it set, transfers, and the devices on chip-select pins. */
export interface SpiPort {
  /** the board's SPI pins */
  pins?: { ss: number; mosi: number; miso: number; sck: number };
  /** the clock the bus runs at now, Hz, its mode and bit order */
  hz: number;
  mode: number;
  msbFirst: boolean;
  begin(): void;
  end(): void;
  /** SPI.beginTransaction(SPISettings(hz, order, mode)): the clock is the fastest the chip makes at or below hz */
  settings(hz: number, msbFirst: boolean, mode: number): void;
  /** SPI.setClockDivider() on the AVR */
  divider(div: number): void;
  /** bytes out, the bytes that came back, with the time they take on the wire */
  transfer(out: number[]): number[];
  /** the device on a chip-select pin */
  device(cs: number): SpiDevice | undefined;
  /** a card's block command on the bus (the SD library works in 512-byte blocks): `bytes` on the wire plus the device's own wait, µs */
  traffic(cs: number, out: number[], inp: number[], bytes: number, waitUs: number): void;
}

/** The ESP32 core's timer calls, on timers handed out by begin(). */
export interface HwTimers {
  begin(hz: number): object | null;
  /** a handler for the timer's alarm, and the argument timerAttachInterruptArg() passes it */
  attach(t: object, fn: FnRef | null, arg?: unknown): void;
  /** no handler, and the alarm off (timerDetachInterrupt) */
  detach(t: object): void;
  /** the alarm at `value` ticks; with autoreload the count goes back to `reload` at each one */
  alarm(t: object, value: number, autoreload: boolean, reload: number): void;
  start(t: object): void;
  stop(t: object): void;
  restart(t: object): void;
  write(t: object, v: number): void;
  read(t: object): number;
  hz(t: object): number;
  end(t: object): void;
}

/** Thrown to stop the firmware (the run is over, or the chip lost power). */
export class Halt extends Error {
  constructor(public reason: string) {
    super(reason);
  }
}
