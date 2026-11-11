// The simulated board the firmware runs on. Time is the chip's cycle count:
// every statement the firmware runs advances it, and when it reaches the next
// event the world catches up: the plant steps 1 ms at a time (ahead of the
// firmware, so encoder edges and other pin changes arrive at their own
// moment and interrupt handlers see the pin levels of that instant).

import type { Board } from "../mcu/board";
import { Halt, type FnRef, type Hal, type IoRegister } from "../mcu/vm";
import { MODELLED_VECTORS } from "../mcu/registers";

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

/** What hangs on a hardware UART other than the console (a servo bus adapter). */
export interface UartPeer {
  /** a byte from the chip, complete at t (seconds); when it ends a request, the answer and how long after t it starts (seconds) */
  byte(b: number, t: number): { after: number; bytes: number[] } | null;
}

interface Uart {
  baud: number;
  rx: number;
  tx: number;
  txEnds: number[];
  txHead: number;
  rxQueue: { t: number; b: number }[];
  rxBuf: number[];
  overflowed: boolean;
}

/** pin modes as the AVR has them */
const Mode = { INPUT: 0, OUTPUT: 1, PULLUP: 2 } as const;

// ADCSRA bits
const ADEN = 0x80;
const ADSC = 0x40;
const ADATE = 0x20;
const ADIF = 0x10;
const ADIE = 0x08;
const ADC_PRESCALE = [2, 2, 4, 8, 16, 32, 64, 128];
/** an interrupt handler running longer than this (seconds of chip time) is taken to be stuck */
const ISR_HANG_S = 0.1;

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
  /** when the running interrupt handler started, and how long it may run before it counts as hung */
  private isrStart = 0;
  private get isrHang() {
    return Math.round(this.fcpu * ISR_HANG_S);
  }
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
  /** Serial1, Serial2: each on its own pins, with whatever the design wires to them */
  private uarts = new Map<number, Uart>();
  private uartLinks: { tx: number; rx: number; peer: UartPeer }[] = [];
  /** bytes sent on Serial1 and Serial2 */
  uartBytes = 0;

  // I2C
  private wireOn = false;
  private wireHz = 100_000;
  /** TWBR and TWSR's prescaler bits, which set the I2C clock as on the chip: SCL = F_CPU / (16 + 2 × TWBR × 4^TWPS) */
  private twi = { twbr: 72, twps: 0 };

  eeprom: Uint8Array;
  eepromWrites = 0;

  faults: SimFault[] = [];
  stackPeak = 0;
  /** cycles spent waiting (delay, and the loop pacing the engine adds) */
  idleCycles = 0;
  private events = new PinEvents();
  private rng: () => number;
  private analogRef = 1;

  /** interrupt handlers the firmware defines with ISR(), by vector name */
  vectors = new Map<string, FnRef>();
  // the ADC as its registers drive it: `done` is the cycle the conversion under way completes
  private adc = { admux: 0, adcsra: 0, adcsrb: 0, adcl: 0, adch: 0, didr0: 0, done: Infinity, first: true, pending: false };
  private regs = new Map<string, IoRegister>();
  /** conversions the ADC finished through its registers */
  adcConversions = 0;

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
    if (this.inIsr && this.cyc >= this.isrStart + this.isrHang) {
      this.fault(`An interrupt handler ran for ${ISR_HANG_S * 1000} ms without returning, so on the chip nothing else would run. A loop in it is probably waiting for something only the main loop or another interrupt changes`, "firmware", 0);
      throw new Halt("an interrupt handler never returned");
    }
    if (this.servicing) {
      // an interrupt handler is running inside service(): the world waits for it, but not for ever
      this.nextEvt = this.inIsr ? this.isrStart + this.isrHang : Infinity;
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
        const ta = this.adc.done;
        if (ta <= this.cyc && ta <= this.nextStep && ta <= te) {
          this.adcComplete();
          continue;
        }
        if (this.cyc >= this.nextStep) {
          const t0 = this.nextStep;
          this.nextStep += this.stepCycles;
          this.plant?.step(t0, this.nextStep);
          this.deliverSerial();
          continue;
        }
        // console bytes that have arrived: into the receive buffer now, or the wait for them never ends
        if (this.rxQueue.length && this.rxQueue[0].t <= this.cyc) {
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
          if (this.adc.pending) {
            this.adc.pending = false;
            this.runAdcVector();
            continue;
          }
        }
        break;
      }
    } finally {
      this.servicing = false;
    }
    this.nextEvt = Math.min(this.nextStep, this.events.peekT(), this.adc.done, this.endCyc, this.rxQueue.length ? this.rxQueue[0].t : Infinity, this.inIsr ? this.isrStart + this.isrHang : Infinity);
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
    this.isrStart = c0;
    this.nextEvt = Math.min(this.nextEvt, c0 + this.isrHang);
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
    if (this.adc.done < Infinity && this.adc.adcsra & ADATE)
      this.fault("analogRead() while the ADC runs free from its registers: on the chip it rewrites ADMUX under the interrupt, and both get the wrong channel's readings", "firmware", 0);
    // the ESP32 core takes GPIO numbers (A0 is GPIO26 on the Feather, BATT_MONITOR 35); the AVR core takes A0.. or 0..
    const esp = this.board.arch === "esp32";
    const p = esp ? ((this.board.adcPins ?? this.board.analog).includes(pin) ? pin : undefined) : this.board.analog[pin >= this.board.analog[0] ? pin - this.board.analog[0] : pin];
    if (p === undefined) {
      this.fault(
        esp
          ? `analogRead(${pin}): GPIO${pin} is not an ADC pin on the ${this.board.name} (it reads ${(this.board.adcPins ?? this.board.analog).join(", ")})`
          : `analogRead(${pin}): the ${this.board.name} has no analog input ${pin}`,
        "firmware",
        0,
      );
      return 0;
    }
    // the ESP32's ADC measures against its own reference, not its supply
    const vref = this.analogRef === 3 ? 1.1 : esp ? this.board.adcRefV : (this.plant?.vref() ?? this.board.adcRefV);
    const v = this.plant?.analogVolts(p, this.cyc);
    const max = (1 << this.board.adcBits) - 1;
    if (v === undefined) {
      // a floating input reads whatever charge is left on the sample capacitor
      return Math.floor(200 + this.rng() * 300);
    }
    const noise = (this.rng() + this.rng() - 1) * 0.7;
    return Math.max(0, Math.min(max, Math.round((v / vref) * max + noise)));
  }

  /** the ESP32 core's analogReadMilliVolts(): the reading in millivolts, through the chip's calibration */
  analogMilliVolts(pin: number): number {
    const max = (1 << this.board.adcBits) - 1;
    return Math.round((this.analogRead(pin) / max) * this.board.adcRefV * 1000);
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
    if (n < 0 || !Object.values(this.board.interrupts).includes(n)) {
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
    if (on && !this.inIsr && (this.irqPending.some(Boolean) || this.adc.pending)) this.nextEvt = this.cyc;
  }

  // ---------- I/O registers: the ADC and SREG ----------

  /** Take the firmware's ISR() handlers: the ones this board runs, and a fault for each it never would. */
  bindVectors(fw: { fnNames: string[]; call(name: string): unknown }) {
    for (const n of fw.fnNames.filter((x) => /_vect$/.test(x))) {
      if (MODELLED_VECTORS.includes(n)) this.vectors.set(n, { fnName: n, call: () => fw.call(n) });
      else this.fault(`ISR(${n}) never runs: the simulator runs ISR(ADC_vect) and attachInterrupt() handlers, not ${n.slice(0, -5).replace(/_/g, " ")} interrupts yet`, "firmware", 0);
    }
  }

  register(name: string): IoRegister | undefined {
    const known = this.regs.get(name);
    if (known) return known;
    const a = this.adc;
    const r8 = (read: () => number, write: (v: number) => void): IoRegister => ({ bits: 8, read, write });
    const word = () => a.adcl | (a.adch << 8);
    let r: IoRegister | undefined;
    switch (name) {
      case "ADMUX":
        r = r8(
          () => a.admux,
          (v) => (a.admux = v & 0xef),
        );
        break;
      case "ADCSRA":
        r = r8(
          () => a.adcsra,
          (v) => this.writeAdcsra(v),
        );
        break;
      case "ADCSRB":
        r = r8(
          () => a.adcsrb,
          (v) => (a.adcsrb = v & 0x47),
        );
        break;
      // the data registers are read-only: writes do nothing, as on the chip
      case "ADCL":
        r = r8(
          () => a.adcl,
          () => undefined,
        );
        break;
      case "ADCH":
        r = r8(
          () => a.adch,
          () => undefined,
        );
        break;
      case "ADC":
      case "ADCW":
        r = { bits: 16, read: word, write: () => undefined };
        break;
      case "DIDR0":
        r = r8(
          () => a.didr0,
          (v) => (a.didr0 = v & 0x3f),
        );
        break;
      case "TWBR":
        r = r8(
          () => this.twi.twbr,
          (v) => {
            this.twi.twbr = v & 0xff;
            this.twiClock();
          },
        );
        break;
      // TWSR: the prescaler bits; the status bits read "no state" (0xF8), as between transfers
      case "TWSR":
        r = r8(
          () => 0xf8 | this.twi.twps,
          (v) => {
            this.twi.twps = v & 3;
            this.twiClock();
          },
        );
        break;
      case "SREG":
        // only the global interrupt flag (bit 7) means anything here
        r = r8(
          () => (this.intEnabled ? 0x80 : 0),
          (v) => this.setInterrupts((v & 0x80) !== 0),
        );
        break;
    }
    if (r) this.regs.set(name, r);
    return r;
  }

  private writeAdcsra(v: number) {
    const a = this.adc;
    const was = a.adcsra;
    // writing a one to ADIF clears it; writing a zero leaves it as it is
    let nv = (v & ~(ADIF | ADSC)) | (was & ADIF);
    if (v & ADIF) nv &= ~ADIF;
    if (!(nv & ADEN)) {
      // turning the ADC off stops a conversion under way
      a.done = Infinity;
      a.first = true;
    } else if (v & ADSC && a.done === Infinity) {
      if ((nv & ADATE) && (a.adcsrb & 7) !== 0)
        this.fault(`ADCSRB selects auto-trigger source ${a.adcsrb & 7}: the simulator runs the ADC free running (ADTS = 0) or one conversion at a time, not triggered by timers or the comparator`, "firmware", 0);
      const ps = ADC_PRESCALE[nv & 7];
      if (this.fcpu / ps > 1_000_000) this.fault(`The ADC clock is ${Math.round(this.fcpu / ps / 1000)} kHz (prescaler ${ps}): above 1 MHz its readings are unreliable; the datasheet wants 50–200 kHz for full resolution`, "firmware", 0);
      // the first conversion after the ADC is turned on takes 25 ADC clocks, the rest 13
      a.done = this.cyc + (a.first ? 25 : 13) * ps;
      a.first = false;
      if (a.done < this.nextEvt) this.nextEvt = a.done;
    }
    if (a.done < Infinity) nv |= ADSC;
    a.adcsra = nv;
    if (nv & ADIF && nv & ADIE && !(was & ADIE)) this.raiseAdc();
  }

  /** a conversion finishes: the sample taken 1.5 ADC clocks after it started goes into ADCH:ADCL */
  private adcComplete() {
    const a = this.adc;
    const ps = ADC_PRESCALE[a.adcsra & 7];
    const at = a.done - 11.5 * ps;
    a.adcl = 0;
    a.adch = 0;
    const counts = this.convert(a.admux & 0x0f, (a.admux >> 6) & 3, at);
    if (a.admux & 0x20) {
      a.adch = counts >> 2;
      a.adcl = (counts & 3) << 6;
    } else {
      a.adcl = counts & 0xff;
      a.adch = counts >> 8;
    }
    a.adcsra |= ADIF;
    this.adcConversions++;
    // free running: the next conversion starts as this one ends
    if (a.adcsra & ADATE && (a.adcsrb & 7) === 0 && a.adcsra & ADEN) a.done += 13 * ps;
    else {
      a.done = Infinity;
      a.adcsra &= ~ADSC;
    }
    if (a.adcsra & ADIE) this.raiseAdc();
  }

  private raiseAdc() {
    if (!this.vectors.has("ADC_vect")) {
      this.fault("ADIE is set but there is no ISR(ADC_vect): on the chip the first finished conversion jumps to the reset vector", "firmware", 0);
      return;
    }
    this.adc.pending = true;
  }

  private convert(mux: number, refs: number, at: number): number {
    const max = (1 << this.board.adcBits) - 1;
    const avcc = this.plant?.vref() ?? this.board.adcRefV;
    if (refs === 0) this.fault("ADMUX selects the AREF pin as the ADC reference (REFS1:0 = 00), and nothing drives AREF: set REFS0 to measure against AVcc", "firmware", 0);
    if (refs === 2) this.fault("ADMUX sets REFS1:0 = 10, which is reserved on the ATmega328P", "firmware", 0);
    const vref = refs === 3 ? 1.1 : avcc;
    let v: number | undefined;
    if (mux === 14) v = 1.1;
    else if (mux === 15) v = 0;
    else if (mux === 8) v = 0.314;
    else if (mux < this.board.analog.length) v = this.plant?.analogVolts(this.board.analog[mux], at);
    else {
      this.fault(`ADMUX selects ADC channel ${mux}, which the ${this.board.name} does not have`, "firmware", 0);
      v = 0;
    }
    if (v === undefined) return Math.floor(200 + this.rng() * 300);
    const noise = (this.rng() + this.rng() - 1) * 0.7;
    return Math.max(0, Math.min(max, Math.round((v / vref) * max + noise)));
  }

  /** ISR(ADC_vect): the hardware clears ADIF as the handler starts */
  private runAdcVector() {
    const fn = this.vectors.get("ADC_vect");
    if (!fn) return;
    this.adc.adcsra &= ~ADIF;
    const c0 = this.cyc;
    this.inIsr = true;
    this.isrStart = c0;
    this.nextEvt = Math.min(this.nextEvt, c0 + this.isrHang);
    const was = this.intEnabled;
    this.intEnabled = false;
    // the vector jump and the handler's register saves; then the restores and reti
    this.cyc += 24;
    try {
      fn.call([]);
    } finally {
      this.cyc += 20;
      this.inIsr = false;
      this.intEnabled = was;
      this.isrCount++;
      this.isrCycles += this.cyc - c0;
    }
  }

  millis(): number {
    return Math.floor((this.cyc * 1000) / this.fcpu) >>> 0;
  }

  micros(): number {
    // the AVR core counts in 4 µs steps (timer 0 at 64 cycles a tick on 16 MHz); the ESP32's timer in 1 µs ones
    if (this.board.arch === "esp32") return Math.floor(this.cyc / (this.fcpu / 1e6)) >>> 0;
    return (Math.floor(this.cyc / (this.fcpu / 250000)) * 4) >>> 0;
  }

  tone(pin: number, freq: number): void {
    this.toneHz.set(pin, freq);
  }

  noTone(pin: number): void {
    this.toneHz.delete(pin);
  }

  // ---------- serial ----------

  serialBegin(_port: number, baud: number, rx = -1, tx = -1): void {
    if (_port) return this.uartBegin(_port, baud, rx, tx);
    this.baud = baud;
  }

  private byteCycles() {
    return Math.round((10 * this.fcpu) / (this.baud || 115200));
  }

  serialWrite(_port: number, bytes: number[]): number {
    if (_port) return this.uartWrite(_port, bytes);
    if (!this.baud) {
      this.fault("Serial is used before Serial.begin(): nothing goes out", "firmware", 0);
      return 0;
    }
    const bc = this.byteCycles();
    const cap = this.board.serialTx;
    for (const b of bytes) {
      // drop bytes already sent
      while (this.txHead < this.txEnds.length && this.txEnds[this.txHead] <= this.cyc) this.txHead++;
      // the transmit buffer is full: Serial.write waits for a byte to leave
      while (this.txEnds.length - this.txHead >= cap) {
        this.spend(this.txEnds[this.txHead] - this.cyc);
        while (this.txHead < this.txEnds.length && this.txEnds[this.txHead] <= this.cyc) this.txHead++;
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

  /** every line the firmware prints, including those past the log's cap */
  onLine?: (text: string) => void;

  private pushLine() {
    const text = String.fromCharCode(...this.outLine);
    if (this.serial.length < 20000) this.serial.push({ t: this.outLineT, dir: "out", text });
    this.outLine = [];
    this.onLine?.(text);
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

  serialAvailable(port = 0): number {
    if (port) return this.uartRx(port).length;
    this.deliverSerial();
    return this.rxBuf.length;
  }

  serialRead(port = 0): number {
    if (port) return this.uartRx(port).shift() ?? -1;
    this.deliverSerial();
    return this.rxBuf.length ? this.rxBuf.shift()! : -1;
  }

  serialPeek(port = 0): number {
    if (port) return this.uartRx(port)[0] ?? -1;
    this.deliverSerial();
    return this.rxBuf.length ? this.rxBuf[0] : -1;
  }

  serialFlush(port = 0): void {
    const u = port ? this.uarts.get(port) : undefined;
    if (port && !u) return;
    const ends = u ? u.txEnds : this.txEnds;
    const head = u ? u.txHead : this.txHead;
    const last = ends.length > head ? ends[ends.length - 1] : this.cyc;
    if (last > this.cyc) this.spend(last - this.cyc);
  }

  // ---------- Serial1, Serial2: a peer on the pins instead of the console ----------

  /** put something on a pair of UART pins (a servo bus adapter): it sees what the chip sends on tx and answers on rx */
  attachUart(tx: number, rx: number, peer: UartPeer) {
    this.uartLinks.push({ tx, rx, peer });
  }

  private uartBegin(port: number, baud: number, rx: number, tx: number) {
    if (this.board.arch !== "esp32") {
      this.fault(`Serial${port} does not exist on the ${this.board.name}: it has one UART, Serial`, "firmware", 0);
      return;
    }
    const d = this.board.uarts?.[port - 1];
    this.uarts.set(port, { baud: baud || 115200, rx: rx >= 0 ? rx : (d?.rx ?? -1), tx: tx >= 0 ? tx : (d?.tx ?? -1), txEnds: [], txHead: 0, rxQueue: [], rxBuf: [], overflowed: false });
  }

  private uartWrite(port: number, bytes: number[]): number {
    const u = this.uarts.get(port);
    if (!u) {
      this.fault(`Serial${port} is used before Serial${port}.begin(): nothing goes out`, "firmware", 0);
      return 0;
    }
    const bc = Math.round((10 * this.fcpu) / u.baud);
    const cap = this.board.serialTx;
    const link = this.uartLinks.find((l) => l.tx === u.tx);
    for (const b of bytes) {
      while (u.txHead < u.txEnds.length && u.txEnds[u.txHead] <= this.cyc) u.txHead++;
      while (u.txEnds.length - u.txHead >= cap) {
        this.spend(u.txEnds[u.txHead] - this.cyc);
        while (u.txHead < u.txEnds.length && u.txEnds[u.txHead] <= this.cyc) u.txHead++;
      }
      const last = u.txEnds.length > u.txHead ? u.txEnds[u.txEnds.length - 1] : this.cyc;
      const end = Math.max(last, this.cyc) + bc;
      u.txEnds.push(end);
      if (u.txHead > 4096) {
        u.txEnds = u.txEnds.slice(u.txHead);
        u.txHead = 0;
      }
      this.uartBytes++;
      const ans = link?.peer.byte(b & 255, end / this.fcpu);
      if (ans && link && link.rx === u.rx) {
        // the answer comes back a byte at a time, after whatever is already on its way
        let t = Math.max(end + Math.round(ans.after * this.fcpu), u.rxQueue.length ? u.rxQueue[u.rxQueue.length - 1].t : 0);
        for (const r of ans.bytes) u.rxQueue.push({ t: (t += bc), b: r });
      }
    }
    return bytes.length;
  }

  /** a port's receive buffer, with every byte that has arrived by now */
  private uartRx(port: number): number[] {
    const u = this.uarts.get(port);
    if (!u) return [];
    while (u.rxQueue.length && u.rxQueue[0].t <= this.cyc) {
      const { b } = u.rxQueue.shift()!;
      if (u.rxBuf.length < this.board.serialRx) u.rxBuf.push(b);
      else if (!u.overflowed) {
        u.overflowed = true;
        this.fault(`Serial${port} receive buffer overflowed (${this.board.serialRx} bytes): read it more often`, "firmware", 0);
      }
    }
    return u.rxBuf;
  }

  /** wait until n bytes have come in on a port or ms have passed, and say how many are there: chip time goes by, nothing is polled */
  serialWait(port: number, n: number, ms: number): number {
    const end = this.cyc + Math.round((ms / 1000) * this.fcpu);
    for (;;) {
      const have = this.serialAvailable(port);
      if (have >= n || this.cyc >= end) return have;
      const q = port ? this.uarts.get(port)?.rxQueue : this.rxQueue;
      const next = q && q.length ? q[0].t : end;
      this.spend(Math.max(1, Math.min(next, end) - this.cyc));
    }
  }

  // ---------- I2C ----------

  wireBegin(): void {
    this.wireOn = true;
  }

  wireSetClock(hz: number): void {
    this.wireHz = Math.max(10_000, Math.min(1_000_000, hz));
    // Wire.setClock() writes TWBR as the AVR core does
    this.twi = { twbr: Math.max(0, Math.min(255, Math.floor((this.fcpu / this.wireHz - 16) / 2))), twps: 0 };
  }

  private twiClock() {
    this.wireHz = Math.min(1_000_000, this.fcpu / (16 + 2 * this.twi.twbr * 4 ** this.twi.twps));
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

  /** the latest NeoPixel frame sent down each data pin, numbered so the plant takes each one once */
  pixelFrames = new Map<number, { colours: number[]; type: number; seq: number }>();
  private pixelSeq = 0;

  pixels(pin: number, colours: number[], type: number): void {
    this.pixelFrames.set(pin, { colours, type, seq: ++this.pixelSeq });
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
