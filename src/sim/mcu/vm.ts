// What compiled firmware code calls to touch the chip: time, pins, the serial
// port, I2C, EEPROM and servos. The simulation engine implements it; the
// compiler (compile.ts) only charges cycles and calls these.

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

export interface Hal {
  /** CPU clock in Hz */
  fcpu: number;
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
  analogWrite(pin: number, v: number): void;
  analogReference(mode: number): void;
  attachInterrupt(n: number, fn: FnRef, mode: number): void;
  detachInterrupt(n: number): void;
  digitalPinToInterrupt(pin: number): number;
  setInterrupts(on: boolean): void;
  millis(): number;
  micros(): number;
  tone(pin: number, freq: number, ms: number): void;
  noTone(pin: number): void;

  serialBegin(port: number, baud: number): void;
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
  /** an EEPROM byte was programmed (3.3 ms each) */
  eepromWrite(addr: number, v: number): void;

  servoPulse(pin: number, us: number | null): void;

  /** a mistake in the firmware the chip would not report (index out of range, divide by zero) */
  fault(msg: string, file: string, line: number): void;
  /** stack bytes in use changed (for the RAM estimate) */
  stack(bytes: number): void;
}

/** Thrown to stop the firmware (the run is over, or the chip lost power). */
export class Halt extends Error {
  constructor(public reason: string) {
    super(reason);
  }
}
