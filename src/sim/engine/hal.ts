// The simulated board the firmware runs on. Time is the chip's cycle count:
// every statement the firmware runs advances it, and when it reaches the next
// event the world catches up: the plant steps 1 ms at a time (ahead of the
// firmware, so encoder edges and other pin changes arrive at their own
// moment and interrupt handlers see the pin levels of that instant).

import type { Board } from "../mcu/board";
import { Halt, type FnRef, type Hal } from "../mcu/vm";

/** What the board needs from the electrical plant around it. */
export interface PlantPort {
  /** advance the plant from cycle t0 to t1; it schedules pin changes inside that span */
  step(t0: number, t1: number): void;
  /** volts on an analog pin at cycle t, or undefined when nothing drives it */
  analogVolts(pin: number, t: number): number | undefined;
  /** the ADC reference (the 5 V rail) */
  vref(): number;
  /** I2C device at an address, if one is wired to SDA/SCL and powered */
  i2c(addr: number): I2CDevice | undefined;
}

export interface I2CDevice {
  write(bytes: number[], t: number): void;
  read(n: number, t: number): number[];
}

export interface SimFault {
  t: number;
  msg: string;
  file: string;
  line: number;
  count: number;
}

export interface SerialLine {
  t: number;
  dir: "out" | "in";
  text: string;
}

/** pin modes as the AVR has them */
const Mode = { INPUT: 0, OUTPUT: 1, PULLUP: 2 } as const;

/** A binary heap of pin changes ordered by time. */
class PinEvents {
  t: number[] = [];
  pin: number[] = [];
  level: number[] = [];
  get size() {
    return this.t.length;
  }
  peekT() {
    return this.t.length ? this.t[0] : Infinity;
  }
  push(t: number, pin: number, level: number) {
    const a = this.t;
    let i = a.length;
    a.push(t);
    this.pin.push(pin);
    this.level.push(level);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p] <= t) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): [number, number, number] {
    const r: [number, number, number] = [this.t[0], this.pin[0], this.level[0]];
    const last = this.t.length - 1;
    this.swap(0, last);
    this.t.pop();
    this.pin.pop();
    this.level.pop();
    let i = 0;
    const n = this.t.length;
    for (;;) {
      const l = 2 * i + 1;
      const rr = l + 1;
      let m = i;
      if (l < n && this.t[l] < this.t[m]) m = l;
      if (rr < n && this.t[rr] < this.t[m]) m = rr;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
    return r;
  }
  private swap(i: number, j: number) {
    [this.t[i], this.t[j]] = [this.t[j], this.t[i]];
    [this.pin[i], this.pin[j]] = [this.pin[j], this.pin[i]];
    [this.level[i], this.level[j]] = [this.level[j], this.level[i]];
  }
}

export class SimHal implements Hal {
  fcpu: number;
  cyc = 0;
  nextEvt = 0;
  /** cycles per plant step (1 ms) */
  stepCycles: number;
  nextStep = 0;
  /** stop the run here */
  endCyc = Infinity;
  /** set by the plant: the chip lost power or browned out */
  powerFail: string | null = null;

  plant: PlantPort | null = null;

  // pins
  mode: Uint8Array;
  latch: Uint8Array;
  duty: Float64Array;
  /** level driven onto the pin from outside, -1 when nothing drives it */
  ext: Int8Array;
  servoUs = new Map<number, number>();
  /** called when the firmware writes a pin a module watches (ultrasonic trigger) */
  onWrite = new Map<number, (level: number, t: number) => void>();
  toneHz = new Map<number, number>();

  // interrupts
  private irqFn: (FnRef | null)[] = [];
  private irqMode: number[] = [];
  private irqPending: boolean[] = [];
  private irqOfPin = new Map<number, number>();
  intEnabled = true;
  private inIsr = false;
  private servicing = false;
  isrCount = 0;
  isrCycles = 0;

  // serial
  private baud = 0;
  private txEnds: number[] = [];
  private txHead = 0;
  private rxQueue: { t: number; b: number }[] = [];
  private rxBuf: number[] = [];
  private outLine: number[] = [];
  private outLineT = 0;
  serial: SerialLine[] = [];
  serialBytes = 0;

  // I2C
  private wireOn = false;
  private wireHz = 100_000;

  eeprom: Uint8Array;
  eepromWrites = 0;

  faults: SimFault[] = [];
  stackPeak = 0;
  /** cycles spent waiting (delay, and the loop pacing the engine adds) */
  idleCycles = 0;
  private events = new PinEvents();
  private rng: () => number;
  private analogRef = 1;

  constructor(
    public board: Board,
    opts: { seed?: number; eeprom?: Uint8Array } = {},
  ) {
    this.fcpu = board.fcpu;
    this.stepCycles = Math.round(board.fcpu / 1000);
    const n = board.digitalPins + 3;
    this.mode = new Uint8Array(n);
    this.latch = new Uint8Array(n);
    this.duty = new Float64Array(n).fill(-1);
    this.ext = new Int8Array(n).fill(-1);
    this.eeprom = opts.eeprom ?? new Uint8Array(board.eepromBytes).fill(0xff);
    for (const [pin, irq] of Object.entries(board.interrupts)) this.irqOfPin.set(+pin, irq);
    let s = (opts.seed ?? 1) >>> 0 || 1;
    this.rng = () => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return (s >>> 0) / 4294967296;
    };
  }

  /** seconds since power-up */
  get time() {
    return this.cyc / this.fcpu;
  }

  // ---------- the world's turn ----------

  service(): void {
    if (this.servicing) {
      // an interrupt handler is running inside service(): the world waits for it
      this.nextEvt = Infinity;
      return;
    }
    this.servicing = true;
    this.nextEvt = Infinity;
    try {
      for (;;) {
        if (this.powerFail) throw new Halt(this.powerFail);
        if (this.cyc >= this.endCyc) throw new Halt("end");
        // whatever is due first: a pin change, or the plant's next step
        const te = this.events.peekT();
        if (te <= this.cyc && te <= this.nextStep) {
          const [, pin, level] = this.events.pop();
          this.applyPin(pin, level);
          continue;
        }
        if (this.cyc >= this.nextStep) {
          const t0 = this.nextStep;
          this.nextStep += this.stepCycles;
          this.plant?.step(t0, this.nextStep);
          this.deliverSerial();
          continue;
        }
        if (this.intEnabled && !this.inIsr) {
          const k = this.irqPending.indexOf(true);
          if (k >= 0) {
            this.irqPending[k] = false;
            this.runIsr(k);
            continue;
          }
        }
        break;
      }
    } finally {
      this.servicing = false;
    }
    this.nextEvt = Math.min(this.nextStep, this.events.peekT(), this.endCyc, this.rxQueue.length ? this.rxQueue[0].t : Infinity);
  }

  spend(cycles: number): void {
    const end = this.cyc + Math.max(0, Math.round(cycles));
    if (this.inIsr && cycles > this.fcpu / 1000) this.fault("delay() inside an interrupt handler: on the chip millis() stops and the handler can hang", "firmware", 0);
    while (this.cyc < end) {
      const to = Math.min(end, this.nextEvt);
      this.idleCycles += to - this.cyc;
      this.cyc = to;
      if (this.cyc >= this.nextEvt) this.service();
    }
  }

  /** an external pin change at cycle t (encoder edge, echo pulse, switch) */
  schedulePin(t: number, pin: number, level: number) {
    this.events.push(t, pin, level);
    if (t < this.nextEvt) this.nextEvt = t;
  }

  /** a pin driven from outside right now (no interrupt timing needed) */
  setExternal(pin: number, level: number) {
    if (this.ext[pin] === level) return;
    this.applyPin(pin, level);
  }

  private applyPin(pin: number, level: number) {
    const before = this.level(pin);
    this.ext[pin] = level;
    const after = this.level(pin);
    if (before === after) return;
    const irq = this.irqOfPin.get(pin);
    if (irq === undefined || !this.irqFn[irq]) return;
    const m = this.irqMode[irq];
    const fire = m === 1 || (m === 3 && after === 1) || (m === 2 && after === 0) || (m === 0 && after === 0);
    if (!fire) return;
    if (this.intEnabled && !this.inIsr) this.runIsr(irq);
    else this.irqPending[irq] = true;
  }

  private runIsr(irq: number) {
    const fn = this.irqFn[irq];
    if (!fn) return;
    const c0 = this.cyc;
    this.inIsr = true;
    const was = this.intEnabled;
    this.intEnabled = false;
    // entry: vector, register saves and the core's dispatch through the attached pointer
    this.cyc += 66;
    try {
      fn.call([]);
    } finally {
      this.cyc += 34;
      this.inIsr = false;
      this.intEnabled = was;
      this.isrCount++;
      this.isrCycles += this.cyc - c0;
    }
  }

  // ---------- pins ----------

  /** The level a pin reads: an output reads its own latch, an input what drives it. */
  level(pin: number): number {
    if (this.mode[pin] === Mode.OUTPUT) return this.duty[pin] >= 0 ? this.pwmLevel(pin, this.cyc) : this.latch[pin];
    const e = this.ext[pin];
    if (e >= 0) return e;
    return this.mode[pin] === Mode.PULLUP ? 1 : 0;
  }

  pwmLevel(pin: number, t: number): number {
    const d = this.duty[pin];
    if (d < 0) return this.latch[pin];
    const f = this.board.pwm[pin] ?? 490;
    const phase = ((t * f) / this.fcpu) % 1;
    return phase < d ? 1 : 0;
  }

  /** What an MCU pin drives into a module input: 0..1 (PWM duty), or -1 when it drives nothing. */
  drive(pin: number): number {
    if (pin < 0 || pin >= this.mode.length) return -1;
    const m = this.mode[pin];
    if (m === Mode.OUTPUT) return this.duty[pin] >= 0 ? this.duty[pin] : this.latch[pin];
    if (m === Mode.PULLUP) return 1;
    return -1;
  }

  private validPin(pin: number, what: string): boolean {
    if (pin >= 0 && pin <= this.board.digitalPins + 2 && pin < this.mode.length) return true;
    this.fault(`${what}(${pin}): the ${this.board.name} has no pin ${pin}`, "firmware", 0);
    return false;
  }

  pinMode(pin: number, mode: number): void {
    if (!this.validPin(pin, "pinMode")) return;
    this.mode[pin] = mode === 1 ? Mode.OUTPUT : mode === 2 ? Mode.PULLUP : Mode.INPUT;
    if (mode !== 1) this.duty[pin] = -1;
  }

  digitalWrite(pin: number, v: number): void {
    if (pin < 0 || pin >= this.mode.length) return;
    if (this.board.analogOnly.includes(pin)) return;
    this.duty[pin] = -1;
    if (this.mode[pin] === Mode.OUTPUT) {
      this.latch[pin] = v ? 1 : 0;
      this.onWrite.get(pin)?.(v ? 1 : 0, this.cyc);
    }
    // writing HIGH to an input turns its pull-up on, as on the AVR
    else this.mode[pin] = v ? Mode.PULLUP : Mode.INPUT;
  }

  digitalRead(pin: number): number {
    if (pin < 0 || pin >= this.mode.length) return 0;
    if (this.board.analogOnly.includes(pin)) {
      this.fault(`digitalRead(A${pin - this.board.analog[0]}): A6 and A7 are analog-only on the ${this.board.name}, so this always reads LOW`, "firmware", 0);
      return 0;
    }
    return this.level(pin);
  }

  analogRead(pin: number): number {
    const ch = pin >= this.board.analog[0] ? pin - this.board.analog[0] : pin;
    const p = this.board.analog[ch];
    if (p === undefined) {
      this.fault(`analogRead(${pin}): the ${this.board.name} has no analog input ${pin}`, "firmware", 0);
      return 0;
    }
    const vref = this.analogRef === 3 ? 1.1 : (this.plant?.vref() ?? this.board.adcRefV);
    const v = this.plant?.analogVolts(p, this.cyc);
    const max = (1 << this.board.adcBits) - 1;
    if (v === undefined) {
      // a floating input reads whatever charge is left on the sample capacitor
      return Math.floor(200 + this.rng() * 300);
    }
    const noise = (this.rng() + this.rng() - 1) * 0.7;
    return Math.max(0, Math.min(max, Math.round((v / vref) * max + noise)));
  }

  analogWrite(pin: number, v: number): void {
    if (!this.validPin(pin, "analogWrite")) return;
    this.mode[pin] = Mode.OUTPUT;
    const timer = this.board.pwmTimer[pin];
    const blocked = (timer === 1 && this.servoUs.size > 0) || (timer === 2 && this.toneHz.size > 0);
    if (blocked) this.fault(`analogWrite(${pin}) while ${timer === 1 ? "Servo" : "tone()"} uses timer ${timer}: that stops PWM on pin ${pin}`, "firmware", 0);
    if (!(pin in this.board.pwm) || blocked) {
      this.duty[pin] = -1;
      this.latch[pin] = v >= 128 ? 1 : 0;
      if (!(pin in this.board.pwm)) this.fault(`analogWrite(${pin}): pin ${pin} has no PWM on the ${this.board.name}, so it just switches fully on or off`, "firmware", 0);
      return;
    }
    if (v <= 0) {
      this.duty[pin] = -1;
      this.latch[pin] = 0;
    } else if (v >= 255) {
      this.duty[pin] = -1;
      this.latch[pin] = 1;
    } else this.duty[pin] = v / 255;
  }

  analogReference(mode: number): void {
    this.analogRef = mode;
  }

  attachInterrupt(n: number, fn: FnRef, mode: number): void {
    if (n < 0 || n >= Object.keys(this.board.interrupts).length) {
      this.fault(`attachInterrupt(${n === 255 ? "NOT_AN_INTERRUPT" : n}): that pin has no external interrupt on the ${this.board.name} (only ${Object.keys(this.board.interrupts).join(" and ")}), so the handler never runs`, "firmware", 0);
      return;
    }
    this.irqFn[n] = fn;
    this.irqMode[n] = mode;
    this.irqPending[n] = false;
  }

  detachInterrupt(n: number): void {
    this.irqFn[n] = null;
  }

  digitalPinToInterrupt(pin: number): number {
    return this.irqOfPin.get(pin) ?? -1;
  }

  setInterrupts(on: boolean): void {
    this.intEnabled = on;
    if (on && !this.inIsr && this.irqPending.some(Boolean)) this.nextEvt = this.cyc;
  }

  millis(): number {
    return Math.floor((this.cyc * 1000) / this.fcpu) >>> 0;
  }

  micros(): number {
    return (Math.floor(this.cyc / 64) * 4) >>> 0;
  }

  tone(pin: number, freq: number): void {
    this.toneHz.set(pin, freq);
  }

  noTone(pin: number): void {
    this.toneHz.delete(pin);
  }

  // ---------- serial ----------

  serialBegin(_port: number, baud: number): void {
    this.baud = baud;
  }

  private byteCycles() {
    return Math.round((10 * this.fcpu) / (this.baud || 115200));
  }

  serialWrite(_port: number, bytes: number[]): number {
    if (!this.baud) {
      this.fault("Serial is used before Serial.begin(): nothing goes out", "firmware", 0);
      return 0;
    }
    const bc = this.byteCycles();
    const cap = this.board.serialTx;
    for (const b of bytes) {
      // drop bytes already sent
      while (this.txHead < this.txEnds.length && this.txEnds[this.txHead] <= this.cyc) this.txHead++;
      if (this.txEnds.length - this.txHead >= cap) {
        // the transmit buffer is full: Serial.write waits for a byte to leave
        this.spend(this.txEnds[this.txHead] - this.cyc);
        continue;
      }
      const last = this.txEnds.length > this.txHead ? this.txEnds[this.txEnds.length - 1] : this.cyc;
      this.txEnds.push(Math.max(last, this.cyc) + bc);
      if (this.txHead > 4096) {
        this.txEnds = this.txEnds.slice(this.txHead);
        this.txHead = 0;
      }
      this.emit(b & 255);
    }
    return bytes.length;
  }

  private emit(b: number) {
    this.serialBytes++;
    if (!this.outLine.length) this.outLineT = this.time;
    if (b === 10) {
      this.pushLine();
      return;
    }
    if (b !== 13) this.outLine.push(b);
    if (this.outLine.length > 400) this.pushLine();
  }

  private pushLine() {
    if (this.serial.length < 20000) this.serial.push({ t: this.outLineT, dir: "out", text: String.fromCharCode(...this.outLine) });
    this.outLine = [];
  }

  /** flush a partial last line into the log */
  finishSerial() {
    if (this.outLine.length) this.pushLine();
  }

  /** type text into the serial console at a time (seconds) */
  typeAt(seconds: number, text: string) {
    const bc = this.byteCycles();
    let t = Math.round(seconds * this.fcpu);
    for (const ch of text) this.rxQueue.push({ t: (t += bc), b: ch.charCodeAt(0) & 255 });
    this.rxQueue.sort((a, b) => a.t - b.t);
    this.serial.push({ t: seconds, dir: "in", text: text.replace(/\r?\n$/, "") });
    this.serial.sort((a, b) => a.t - b.t);
    this.nextEvt = Math.min(this.nextEvt, this.rxQueue[0].t);
  }

  private deliverSerial() {
    while (this.rxQueue.length && this.rxQueue[0].t <= this.cyc) {
      const { b } = this.rxQueue.shift()!;
      if (this.rxBuf.length < this.board.serialRx) this.rxBuf.push(b);
      else this.fault("Serial receive buffer overflowed (64 bytes): read Serial more often", "firmware", 0);
    }
  }

  serialAvailable(): number {
    this.deliverSerial();
    return this.rxBuf.length;
  }

  serialRead(): number {
    this.deliverSerial();
    return this.rxBuf.length ? this.rxBuf.shift()! : -1;
  }

  serialPeek(): number {
    this.deliverSerial();
    return this.rxBuf.length ? this.rxBuf[0] : -1;
  }

  serialFlush(): void {
    const last = this.txEnds.length > this.txHead ? this.txEnds[this.txEnds.length - 1] : this.cyc;
    if (last > this.cyc) this.spend(last - this.cyc);
  }

  // ---------- I2C ----------

  wireBegin(): void {
    this.wireOn = true;
  }

  wireSetClock(hz: number): void {
    this.wireHz = Math.max(10_000, Math.min(1_000_000, hz));
  }

  private wireTime(bytes: number) {
    // start, address, the bytes and stop: 9 clocks a byte
    this.spend(((bytes + 1) * 9 + 2) * (this.fcpu / this.wireHz));
  }

  wireWrite(addr: number, bytes: number[]): number {
    if (!this.wireOn) {
      this.fault("Wire is used before Wire.begin()", "firmware", 0);
      return 4;
    }
    const dev = this.plant?.i2c(addr);
    this.wireTime(dev ? bytes.length : 0);
    if (!dev) return 2;
    dev.write(bytes, this.cyc);
    return 0;
  }

  wireRead(addr: number, n: number): number[] {
    if (!this.wireOn) {
      this.fault("Wire is used before Wire.begin()", "firmware", 0);
      return [];
    }
    const dev = this.plant?.i2c(addr);
    this.wireTime(dev ? n : 0);
    return dev ? dev.read(n, this.cyc) : [];
  }

  // ---------- EEPROM, servos, faults ----------

  eepromWrite(addr: number, v: number): void {
    this.eeprom[addr] = v;
    this.eepromWrites++;
    this.spend(this.fcpu * 0.0033);
  }

  servoPulse(pin: number, us: number | null): void {
    if (us === null) this.servoUs.delete(pin);
    else this.servoUs.set(pin, us);
  }

  fault(msg: string, file: string, line: number): void {
    const f = this.faults.find((x) => x.msg === msg && x.line === line && x.file === file);
    if (f) {
      f.count++;
      return;
    }
    if (this.faults.length < 60) this.faults.push({ t: this.time, msg, file, line, count: 1 });
  }

  stack(bytes: number): void {
    if (bytes > this.stackPeak) this.stackPeak = bytes;
  }
}
