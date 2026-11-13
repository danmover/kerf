// The simulated board the firmware runs on. Time is the chip's cycle count:
// every statement the firmware runs advances it, and when it reaches the next
// event the world catches up: the plant steps 1 ms at a time (ahead of the
// firmware, so encoder edges and other pin changes arrive at their own
// moment and interrupt handlers see the pin levels of that instant).

import { pinLabel, type Arch, type Board } from "../mcu/board";
import { Halt, type FnRef, type Hal, type IoRegister } from "../mcu/vm";
import { MODELLED_VECTORS } from "../mcu/registers";
import type { ProbeHooks } from "./probes";
import { AvrChip, Esp32Timers, type ChipTimers, type ChipVector } from "./timers";
import { SpiBus } from "./spi";

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
  /** the logic analyser, when the run records signals: told of every pin change and bus transfer */
  probe: ProbeHooks | null = null;

  // pins
  mode: Uint8Array;
  latch: Uint8Array;
  duty: Float64Array;
  /** level driven onto the pin from outside, -1 when nothing drives it */
  ext: Int8Array;
  servoUs = new Map<number, number>();
  /** PWM rate (Hz) and resolution (bits) of pins the firmware set up itself (the ESP32's LEDC), in place of the board's */
  pwmSet = new Map<number, { hz: number; bits: number }>();
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
  /** pins whose catch (a strapping or USB pin) the sketch has been told about */
  private warned = new Set<number>();
  /** analogRead()'s resolution, bits: analogReadResolution() changes it on the 32-bit cores */
  private readBits: number;
  /** analogWrite()'s full scale and rate where the core sets them for every pin (the RP2040 and STM32 cores) */
  private writeMax = 255;
  private writeHz = 0;
  /** pins whose last write was analogWrite(): a pin on the same PWM channel takes their duty */
  private pwmOn = new Set<number>();
  /** the board's highest pin number */
  private topPin: number;

  /** interrupt handlers the firmware defines with ISR(), by vector name */
  vectors = new Map<string, FnRef>();
  // the ADC as its registers drive it: `done` is the cycle the conversion under way completes
  private adc = { admux: 0, adcsra: 0, adcsrb: 0, adcl: 0, adch: 0, didr0: 0, done: Infinity, first: true, pending: false };
  private regs = new Map<string, IoRegister>();
  /** conversions the ADC finished through its registers */
  adcConversions = 0;
  /** the ATmega328P's ports, timers and pin interrupts as their registers drive them */
  avr: AvrChip | null = null;
  /** the ESP32's hardware timers (timerBegin) */
  espTimers: Esp32Timers | null = null;
  /** the SPI bus and the devices on its chip-select pins */
  spi: SpiBus;
  private chips: ChipTimers[] = [];
  /** millis() and micros() count timer 0's overflows on the AVR: core cycles, which run at coreRate × the clock */
  private core = { rate: 1, cyc0: 0, at0: 0 };

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
    this.readBits = board.adcBits;
    this.topPin = Math.max(board.digitalPins, ...board.analogOnly);
    for (const [pin, irq] of Object.entries(board.interrupts)) this.irqOfPin.set(+pin, irq);
    if (board.arch === "esp32") this.chips.push((this.espTimers = new Esp32Timers(this)));
    else if (board.mcu === "ATmega328P") this.chips.push((this.avr = new AvrChip(this)));
    this.spi = new SpiBus(this);
    let s = (opts.seed ?? 1) >>> 0 || 1;
    this.rng = () => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return (s >>> 0) / 4294967296;
    };
  }

  get arch(): Arch {
    return this.board.arch ?? "avr";
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
          const [at, pin, level] = this.events.pop();
          this.applyPin(pin, level, at);
          continue;
        }
        const ta = this.adc.done;
        if (ta <= this.cyc && ta <= this.nextStep && ta <= te) {
          this.adcComplete();
          continue;
        }
        const tc = this.chipNext();
        if (tc <= this.cyc && tc <= this.nextStep && tc <= te) {
          for (const c of this.chips) if (c.next <= this.cyc) c.due(this.cyc);
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
          const v = this.takeVector();
          if (v) {
            this.runVector(v);
            continue;
          }
        }
        break;
      }
    } finally {
      this.servicing = false;
    }
    this.nextEvt = Math.min(this.nextStep, this.events.peekT(), this.adc.done, this.chipNext(), this.endCyc, this.rxQueue.length ? this.rxQueue[0].t : Infinity, this.inIsr ? this.isrStart + this.isrHang : Infinity);
  }

  private chipNext(): number {
    let n = Infinity;
    for (const c of this.chips) if (c.next < n) n = c.next;
    return n;
  }

  /** the highest-priority timer or pin-change handler waiting to run */
  private takeVector(): ChipVector | null {
    for (const c of this.chips) {
      const v = c.take();
      if (v) return v;
    }
    return null;
  }

  /** run a timer or pin-change handler, as the chip does: interrupts off inside it, its flag already cleared */
  private runVector(v: ChipVector) {
    const c0 = this.cyc;
    this.inIsr = true;
    this.isrStart = c0;
    this.nextEvt = Math.min(this.nextEvt, c0 + this.isrHang);
    const was = this.intEnabled;
    this.intEnabled = false;
    this.cyc += v.entry;
    try {
      v.fn.call(v.args ?? []);
    } finally {
      this.cyc += v.exit;
      this.inIsr = false;
      this.intEnabled = was;
      this.isrCount++;
      this.isrCycles += this.cyc - c0;
    }
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

  private applyPin(pin: number, level: number, at = this.cyc) {
    const before = this.level(pin);
    this.ext[pin] = level;
    this.probe?.pin(pin, at);
    const after = this.level(pin);
    if (before === after) return;
    this.avr?.pinChanged(pin);
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
    const f = this.pwmHz(pin);
    const phase = ((t * f) / this.fcpu) % 1;
    return phase < d ? 1 : 0;
  }

  /** the PWM rate on a pin, Hz: what the firmware set (LEDC, analogWriteFreq), else the board's own */
  pwmHz(pin: number): number {
    return this.pwmSet.get(pin)?.hz ?? (this.writeHz || this.board.pwm[pin]) ?? 490;
  }

  /** What an MCU pin drives into a module input: 0..1 (PWM duty), or -1 when it drives nothing. */
  drive(pin: number): number {
    if (pin < 0 || pin >= this.mode.length) return -1;
    const m = this.mode[pin];
    if (m === Mode.OUTPUT) return this.duty[pin] >= 0 ? this.duty[pin] : this.latch[pin];
    if (m === Mode.PULLUP) return 1;
    return -1;
  }

  /** A pin the board has (and can drive, for an output): a fault when it lacks it, and its catch the first time it is used. */
  private validPin(pin: number, what: string, out = false): boolean {
    const b = this.board;
    const lacks = b.noPins?.[pin];
    if (pin >= 0 && pin <= this.topPin && pin < this.mode.length && !lacks) {
      const w = b.pinWarn?.[pin];
      if (w && !this.warned.has(pin)) {
        this.warned.add(pin);
        this.fault(`${what}(${pin}): ${w}`, "firmware", 0);
      }
      if (!out || !b.inputOnly?.includes(pin)) return true;
      this.fault(`${what}(${pin}): ${pinLabel(b, pin)} is input-only on the ${b.name}, so it cannot drive anything`, "firmware", 0);
      return false;
    }
    const alias = b.alias?.[pin];
    const msg = lacks
      ? lacks
      : alias !== undefined
        ? `${pin} is A${pin - (b.analogBase ?? 0)} on the ${b.name}, a number only analogRead() takes; ${what}() takes the pin's own number, ${alias} (${pinLabel(b, alias)})`
        : `the ${b.name} has no pin ${pin}`;
    this.fault(`${what}(${pin}): ${msg}`, "firmware", 0);
    return false;
  }

  pinMode(pin: number, mode: number): void {
    if (!this.validPin(pin, "pinMode", mode === 1)) return;
    let m: number = mode === 1 ? Mode.OUTPUT : mode === 2 ? Mode.PULLUP : Mode.INPUT;
    if (mode >= 2 && this.board.inputOnly?.includes(pin)) {
      this.fault(`pinMode(${pin}, ${mode === 2 ? "INPUT_PULLUP" : "INPUT_PULLDOWN"}): ${pinLabel(this.board, pin)} has no internal pull resistors on the ${this.board.name}, so the pin floats; fit a 10 kΩ resistor`, "firmware", 0);
      m = Mode.INPUT;
    }
    // the AVR's PORT bit is an input's pull-up and an output's level (pinMode(INPUT) clears it), so an output starts
    // high after INPUT_PULLUP. The RP2040 core's pinMode() starts every output low; the ESP32 and STM32 keep the last write.
    if (m === Mode.OUTPUT) {
      if (this.arch === "avr" && this.mode[pin] !== Mode.OUTPUT) this.latch[pin] = this.mode[pin] === Mode.PULLUP ? 1 : 0;
      else if (this.arch === "rp2040") this.latch[pin] = 0;
    }
    this.mode[pin] = m;
    if (mode !== 1) {
      this.duty[pin] = -1;
      this.pwmOn.delete(pin);
    }
    this.avr?.pinModeChanged(pin);
    this.probe?.pin(pin, this.cyc);
  }

  digitalWrite(pin: number, v: number): void {
    if (!this.validPin(pin, "digitalWrite", true)) return;
    if (this.board.analogOnly.includes(pin)) return;
    if (this.duty[pin] >= 0 || this.pwmSet.has(pin)) this.avr?.pwmOff(pin);
    this.duty[pin] = -1;
    this.pwmOn.delete(pin);
    if (this.mode[pin] === Mode.OUTPUT) {
      this.latch[pin] = v ? 1 : 0;
      this.onWrite.get(pin)?.(v ? 1 : 0, this.cyc);
    }
    // writing HIGH to an input turns its pull-up on, as on the AVR; the 32-bit cores keep the level for when it is an output
    else if (this.arch === "avr") this.mode[pin] = v ? Mode.PULLUP : Mode.INPUT;
    else this.latch[pin] = v ? 1 : 0;
    this.avr?.pinChanged(pin);
    this.probe?.pin(pin, this.cyc);
  }

  digitalRead(pin: number): number {
    if (!this.validPin(pin, "digitalRead")) return 0;
    if (this.board.analogOnly.includes(pin)) {
      this.fault(`digitalRead(A${pin - this.board.analog[0]}): A6 and A7 are analog-only on the ${this.board.name}, so this always reads LOW`, "firmware", 0);
      return 0;
    }
    return this.level(pin);
  }

  analogRead(pin: number): number {
    if (this.adc.done < Infinity && this.adc.adcsra & ADATE)
      this.fault("analogRead() while the ADC runs free from its registers: on the chip it rewrites ADMUX under the interrupt, and both get the wrong channel's readings", "firmware", 0);
    // the ESP32 and RP2040 cores take GPIO numbers (A0 is GPIO26 on the Feather, BATT_MONITOR 35); STM32duino takes
    // a pin (PA0) or an analog number (8 is A8, PB0); the AVR core takes A0.. or a channel number 0..
    const b = this.board;
    let p: number | undefined;
    if (b.adcPins) p = b.adcPins.includes(pin) ? pin : undefined;
    else if (b.arch === "stm32") p = b.analog.includes(pin) ? pin : b.analog[pin];
    else {
      const base = b.analogBase ?? b.analog[0];
      p = b.analog[pin >= base ? pin - base : pin];
    }
    if (p === undefined || p < 0 || b.noPins?.[p]) {
      this.fault(
        p !== undefined && p >= 0
          ? `analogRead(${pin}): ${b.noPins![p]}`
          : b.adcPins
            ? `analogRead(${pin}): ${pinLabel(b, pin)} is not an ADC pin on the ${b.name} (it reads ${b.adcPins.map((q) => pinLabel(b, q)).join(", ")})`
            : `analogRead(${pin}): the ${b.name} has no analog input ${pin}`,
        "firmware",
        0,
      );
      return 0;
    }
    // the 32-bit chips' ADCs measure against their own 3.3 V reference, not the supply
    const vref = this.arch === "avr" ? this.avrRef() : b.adcRefV;
    const v = this.plant?.analogVolts(p, this.cyc);
    // the ADC's own bits, then what analogReadResolution() asked for (the cores shift the reading up or down)
    const hw = b.adcHwBits ?? b.adcBits;
    const max = (1 << hw) - 1;
    const scale = (r: number) => (this.readBits >= hw ? r * 2 ** (this.readBits - hw) : Math.floor(r / 2 ** (hw - this.readBits)));
    if (v === undefined) {
      // a floating input reads whatever charge is left on the sample capacitor
      const r = scale(Math.floor((200 + this.rng() * 300) * 2 ** (hw - 10)));
      this.probe?.adc(p, this.cyc, NaN, r);
      return r;
    }
    const noise = (this.rng() + this.rng() - 1) * 0.7;
    const r = scale(Math.max(0, Math.min(max, Math.round((v / vref) * max + noise))));
    this.probe?.adc(p, this.cyc, v, r);
    return r;
  }

  /** the AVR's ADC reference: the supply, or the chip's internal band-gap reference that analogReference() picked */
  private avrRef(): number {
    const m = this.analogRef;
    const vcc = this.plant?.vref() ?? this.board.adcRefV;
    // Arduino.h: the ATmega328P's INTERNAL is 3; the ATmega2560 has INTERNAL1V1 (2) and INTERNAL2V56 (3); the ATtiny85 INTERNAL1V1 (2) and INTERNAL2V56 (6, 7), with DEFAULT 0
    switch (this.board.mcu) {
      case "ATmega2560":
        return m === 2 ? 1.1 : m === 3 ? 2.56 : vcc;
      case "ATtiny85":
        return m === 2 ? 1.1 : m === 6 || m === 7 ? 2.56 : vcc;
      default:
        return m === 3 ? 1.1 : vcc;
    }
  }

  /** analogReadResolution(): the bits analogRead() returns, as the 32-bit cores scale the ADC's own (1 to 16) */
  readResolution(bits: number): void {
    if (!(bits >= 1 && bits <= 16)) {
      this.fault(`analogReadResolution(${bits}): the ${this.board.name}'s core takes 1 to 16 bits, so the resolution stays ${this.readBits}`, "firmware", 0);
      return;
    }
    this.readBits = Math.round(bits);
  }

  /** the ESP32 core's analogReadMilliVolts(): the reading in millivolts, through the chip's calibration */
  analogMilliVolts(pin: number): number {
    const max = 2 ** this.readBits - 1;
    return Math.round((this.analogRead(pin) / max) * this.board.adcRefV * 1000);
  }

  analogWrite(pin: number, v: number): void {
    if (!this.validPin(pin, "analogWrite", true)) return;
    const b = this.board;
    this.mode[pin] = Mode.OUTPUT;
    // Servo takes timer 1 on the ATmega328P (timer 5 on the Mega), tone() timer 2: PWM on their pins stops
    const timer = b.pwmTimer[pin];
    const servoT = b.servoTimer ?? 1;
    const blocked = timer !== undefined && ((timer === servoT && this.servoUs.size > 0) || (timer === (b.toneTimer ?? 2) && this.toneHz.size > 0));
    if (blocked) this.fault(`analogWrite(${pin}) while ${timer === servoT ? "Servo" : "tone()"} uses timer ${timer}: that stops PWM on pin ${pin}`, "firmware", 0);
    // 8 bits unless analogWriteResolution() (or the RP2040's analogWriteRange()) set another
    const set = this.pwmSet.get(pin);
    const max = set ? (1 << set.bits) - 1 : this.writeMax;
    this.pwmOn.delete(pin);
    if (!(pin in b.pwm) || blocked) {
      this.duty[pin] = -1;
      this.latch[pin] = v >= (max + 1) / 2 ? 1 : 0;
      this.avr?.pinChanged(pin);
      this.probe?.pin(pin, this.cyc);
      if (!(pin in b.pwm)) this.fault(`analogWrite(${pin}): ${pinLabel(b, pin)} has no PWM on the ${b.name}, so it just switches fully on or off`, "firmware", 0);
      return;
    }
    if (v <= 0) {
      this.duty[pin] = -1;
      this.latch[pin] = 0;
    } else if (v >= max) {
      this.duty[pin] = -1;
      this.latch[pin] = 1;
    } else this.duty[pin] = v / max;
    this.pwmOn.add(pin);
    this.shareDuty(pin);
    // the core sets the pin's timer compare register; a timer the sketch set up itself makes the PWM from it
    this.avr?.analogWritten(pin, v);
    this.probe?.pin(pin, this.cyc);
  }

  /** Pins on one PWM channel (an RP2040 slice's A or B, an STM32 timer channel) carry one duty: the one written last. */
  private shareDuty(pin: number) {
    const b = this.board;
    const ch = b.pwmShare?.[pin];
    if (!ch) return;
    for (const q of this.pwmOn) {
      if (q === pin || b.pwmShare![q] !== ch || this.mode[q] !== Mode.OUTPUT) continue;
      if (this.duty[q] !== this.duty[pin] || this.latch[q] !== this.latch[pin])
        this.fault(`analogWrite(${pin}): ${pinLabel(b, pin)} and ${pinLabel(b, q)} share ${ch} on the ${b.name}, so both carry the duty written last; move one to a pin on another channel`, "firmware", 0);
      this.duty[q] = this.duty[pin];
      this.latch[q] = this.latch[pin];
      this.probe?.pin(q, this.cyc);
    }
  }

  /**
   * analogWriteResolution(bits), analogWriteRange(top) and analogWriteFreq(hz) on the RP2040 and STM32 cores, which
   * set every pin's PWM at once (the ESP32 core's take a pin: pwmAttach).
   */
  pwmGlobal(what: "bits" | "range" | "hz", v: number): void {
    const b = this.board;
    if (what === "hz") {
      // arduino-pico clamps to 100 Hz .. 1 MHz; STM32duino's timers make anything their clock divides to
      const lo = b.arch === "rp2040" ? 100 : 1;
      const hz = Math.max(lo, Math.min(1_000_000, v));
      if (hz !== v) this.fault(`analogWriteFreq(${v}): the ${b.name}'s core takes ${lo} Hz to 1 MHz, so the PWM runs at ${hz} Hz`, "firmware", 0);
      this.writeHz = hz;
      return;
    }
    const top = what === "bits" ? 2 ** Math.round(v) - 1 : Math.round(v);
    const ok = what === "bits" ? v >= (b.arch === "rp2040" ? 4 : 1) && v <= 16 : v >= 15 && v <= 65535;
    if (!ok) {
      this.fault(`${what === "bits" ? `analogWriteResolution(${v})` : `analogWriteRange(${v})`}: the ${b.name}'s core takes ${what === "bits" ? (b.arch === "rp2040" ? "4 to 16 bits" : "1 to 16 bits") : "15 to 65535"}, so analogWrite() keeps 0 to ${this.writeMax}`, "firmware", 0);
      return;
    }
    this.writeMax = top;
  }

  /**
   * The ESP32 core's ledcAttach() (and analogWriteFrequency / analogWriteResolution): a pin's PWM rate and
   * resolution. The LEDC timer divides its 80 MHz clock, so rate × 2^bits cannot pass 80 MHz; false when it does.
   */
  pwmAttach(pin: number, hz: number, bits: number, what = "ledcAttach"): boolean {
    if (this.board.arch !== "esp32") {
      this.fault(`${what}() is part of the ESP32 core: the ${this.board.name} has no such function, so this sketch would not compile for it`, "firmware", 0);
      return false;
    }
    if (!this.validPin(pin, what)) return false;
    // analogWriteFrequency() and analogWriteResolution() each keep the other setting
    if (hz < 0) hz = this.pwmHz(pin);
    if (bits < 0) bits = this.pwmSet.get(pin)?.bits ?? 8;
    if (!(pin in this.board.pwm)) {
      this.fault(`${what}(${pin}): GPIO${pin} cannot be an output on the ${this.board.name}, so it has no PWM`, "firmware", 0);
      return false;
    }
    if (!(hz >= 1) || !(bits >= 1 && bits <= 16) || hz * 2 ** bits > 80e6) {
      const most = Math.max(1, Math.min(16, Math.floor(Math.log2(80e6 / Math.max(1, hz)))));
      this.fault(`${what}(${pin}, ${hz}, ${bits}): the ESP32's PWM timer cannot make ${hz} Hz at ${bits} bits (rate × 2^bits must stay under its 80 MHz clock; at ${hz} Hz that is ${most} bits at most), so the pin gets no PWM`, "firmware", 0);
      return false;
    }
    this.pwmSet.set(pin, { hz, bits: Math.round(bits) });
    this.mode[pin] = Mode.OUTPUT;
    if (this.duty[pin] < 0) this.latch[pin] = 0;
    this.probe?.pin(pin, this.cyc);
    return true;
  }

  /** ledcWrite(): a duty in the pin's own resolution (all bits set means fully on, as the core does it) */
  pwmWrite(pin: number, duty: number): boolean {
    const set = this.pwmSet.get(pin);
    if (!set) {
      this.fault(`ledcWrite(${pin}) before ledcAttach(${pin}, ...): the pin has no PWM channel, so nothing changes`, "firmware", 0);
      return false;
    }
    const full = 2 ** set.bits;
    this.mode[pin] = Mode.OUTPUT;
    if (duty <= 0) {
      this.duty[pin] = -1;
      this.latch[pin] = 0;
    } else if (duty >= full - 1) {
      this.duty[pin] = -1;
      this.latch[pin] = 1;
    } else this.duty[pin] = duty / full;
    this.probe?.pin(pin, this.cyc);
    return true;
  }

  /** the duty last written to a pin, in its own resolution */
  pwmRead(pin: number): number {
    const set = this.pwmSet.get(pin);
    const full = 2 ** (set?.bits ?? 8);
    if (this.mode[pin] !== Mode.OUTPUT) return 0;
    return this.duty[pin] >= 0 ? Math.round(this.duty[pin] * full) : this.latch[pin] ? full - 1 : 0;
  }

  analogReference(mode: number): void {
    this.analogRef = mode;
  }

  attachInterrupt(n: number, fn: FnRef, mode: number): void {
    if (n < 0 || !Object.values(this.board.interrupts).includes(n)) {
      this.fault(`attachInterrupt(${n === 255 ? "NOT_AN_INTERRUPT" : n}): that pin has no external interrupt on the ${this.board.name} (only ${Object.keys(this.board.interrupts).join(" and ")}), so the handler never runs`, "firmware", 0);
      return;
    }
    // the STM32's EXTI lines go by the pin's bit number, so PA0 and PB0 share line 0: the later one takes it
    const line = this.board.irqLine;
    if (line)
      for (let m = 0; m < this.irqFn.length; m++)
        if (m !== n && this.irqFn[m] && line[m] === line[n]) {
          this.fault(`attachInterrupt(${n}): ${pinLabel(this.board, n)} and ${pinLabel(this.board, m)} share interrupt line EXTI${line[n]} on the ${this.board.name}, so ${pinLabel(this.board, m)}'s handler stops; put one on a pin with another number`, "firmware", 0);
          this.irqFn[m] = null;
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
    if (on && !this.inIsr && (this.irqPending.some(Boolean) || this.adc.pending || this.chips.length)) this.nextEvt = this.cyc;
  }

  // ---------- I/O registers: the ADC and SREG ----------

  /** Take the firmware's ISR() handlers: the ones this board runs, and a fault for each it never would. */
  bindVectors(fw: { fnNames: string[]; call(name: string): unknown }) {
    for (const n of fw.fnNames.filter((x) => /_vect$/.test(x))) {
      const ref = { fnName: n, call: () => fw.call(n) };
      if (MODELLED_VECTORS.includes(n)) this.vectors.set(n, ref);
      else if (!this.avr?.bind(n, ref))
        this.fault(`ISR(${n}) never runs: the simulator runs the ADC, timer 0/1/2 compare and overflow, pin-change and INT0/INT1 vectors and attachInterrupt() handlers, not ${n.slice(0, -5).replace(/_/g, " ")} interrupts yet`, "firmware", 0);
    }
    this.avr?.reschedule();
  }

  register(name: string): IoRegister | undefined {
    // the ATmega328P's registers are modelled; other AVRs share only SREG with it here, and the 32-bit chips have none
    if (this.arch !== "avr" || (this.board.mcu !== "ATmega328P" && name !== "SREG")) return undefined;
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
    r ??= this.avr?.register(name);
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
    const r = Math.max(0, Math.min(max, Math.round((v / vref) * max + noise)));
    if (mux < this.board.analog.length) this.probe?.adc(this.board.analog[mux], at, v, r);
    return r;
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

  get hwTimers() {
    return this.espTimers ?? undefined;
  }

  setVector(name: string, fn: FnRef | null) {
    if (!this.avr) return this.fault(`${name.replace(/_vect$/, "")}: the ${this.board.name} has no such interrupt`, "firmware", 0);
    this.avr.setHandler(name as Parameters<AvrChip["setHandler"]>[0], fn);
    this.avr.reschedule();
  }

  /** the cycles millis() and micros() have counted: the clock's own, unless the sketch changed timer 0 */
  private coreCyc(): number {
    const c = this.core;
    return c.rate === 1 && c.at0 === 0 ? this.cyc : c.cyc0 + (this.cyc - c.at0) * c.rate;
  }

  /** timer 0 now overflows at another rate (its prescaler or mode changed): the core's time runs that much faster */
  setCoreRate(rate: number) {
    this.core = { rate, cyc0: this.coreCyc(), at0: this.cyc };
  }

  millis(): number {
    return Math.floor((this.coreCyc() * 1000) / this.fcpu) >>> 0;
  }

  micros(): number {
    // the AVR core counts timer 0's ticks of 64 cycles (4 µs steps at 16 MHz, 8 at 8 MHz); the 32-bit chips' timers count 1 µs ones
    if (this.arch !== "avr") return Math.floor(this.cyc / (this.fcpu / 1e6)) >>> 0;
    return (Math.floor(this.coreCyc() / 64) * (64e6 / this.fcpu)) >>> 0;
  }

  /** delay(): it waits on micros(), so it runs at the core's rate */
  delayMs(ms: number) {
    const r = this.core.rate;
    if (r <= 0) {
      this.fault("delay() never returns: timer 0 no longer overflows with its interrupt on, so the time it waits on stands still", "firmware", 0);
      this.spend(this.endCyc - this.cyc);
      return;
    }
    this.spend((ms * this.fcpu) / 1000 / r);
  }

  tone(pin: number, freq: number): void {
    this.toneHz.set(pin, freq);
    this.probe?.pin(pin, this.cyc);
  }

  noTone(pin: number): void {
    this.toneHz.delete(pin);
    this.probe?.pin(pin, this.cyc);
  }

  // ---------- serial ----------

  serialBegin(_port: number, baud: number, rx = -1, tx = -1): void {
    if (_port) return this.uartBegin(_port, baud, rx, tx);
    this.baud = baud;
  }

  private byteCycles() {
    // a USB serial port (the Pico's, the XIAO's, the Black Pill's) ignores the baud rate and moves about 800 kB/s
    if (this.board.usbSerial) return Math.round(this.fcpu / 800_000);
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
      this.probe?.tx(0, b & 255, this.txEnds[this.txEnds.length - 1], bc);
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
      const { t, b } = this.rxQueue.shift()!;
      this.probe?.rx(0, b, t, this.byteCycles());
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
    const ports = this.board.uarts ?? [];
    if (port > ports.length) {
      this.fault(`Serial${port} does not exist on the ${this.board.name}: it has ${ports.length ? ["Serial", ...ports.map((_, i) => `Serial${i + 1}`)].join(", ") : "one UART, Serial"}`, "firmware", 0);
      return;
    }
    // only the ESP32's UARTs go on whatever pins begin() names
    const b = this.board;
    if ((rx >= 0 || tx >= 0) && this.arch !== "esp32") {
      this.fault(`Serial${port}.begin(baud, config, rx, tx) is the ESP32 core's: on the ${b.name} Serial${port} is fixed to its own pins`, "firmware", 0);
      rx = tx = -1;
    }
    const d = ports[port - 1];
    const u = { baud: baud || 115200, rx: rx >= 0 ? rx : (d?.rx ?? -1), tx: tx >= 0 ? tx : (d?.tx ?? -1), txEnds: [], txHead: 0, rxQueue: [], rxBuf: [], overflowed: false };
    // the port's pins must be ones the board has, and their catch is told once (the XIAO ESP32C3's Serial1 defaults to its USB lines)
    for (const [p, role, given] of [
      [u.rx, "RX", rx >= 0],
      [u.tx, "TX", tx >= 0],
    ] as [number, string, boolean][]) {
      if (p < 0 || this.warned.has(p)) continue;
      const why =
        b.noPins?.[p] ??
        (p > this.topPin ? `the ${b.name} has no pin ${p}` : role === "TX" && b.inputOnly?.includes(p) ? `${pinLabel(b, p)} is input-only, so it cannot send` : b.pinWarn?.[p]);
      if (!why) continue;
      this.warned.add(p);
      const move = this.arch === "esp32" ? `; name other pins with Serial${port}.begin(baud, SERIAL_8N1, rx, tx)` : "";
      this.fault(`Serial${port}.begin(): its ${role} pin is ${pinLabel(b, p)}${given ? "" : ", the core's default"}. ${why}${move}`, "firmware", 0);
    }
    this.uarts.set(port, u);
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
      this.probe?.tx(port, b & 255, end, bc);
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
      const { t, b } = u.rxQueue.shift()!;
      this.probe?.rx(port, b, t, Math.round((10 * this.fcpu) / u.baud));
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
    const t0 = this.cyc;
    this.wireTime(dev ? bytes.length : 0);
    this.probe?.i2c(addr, "w", bytes, !!dev, t0, this.cyc);
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
    const t0 = this.cyc;
    this.wireTime(dev ? n : 0);
    const got = dev ? dev.read(n, this.cyc) : [];
    this.probe?.i2c(addr, "r", got, !!dev, t0, this.cyc);
    return got;
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
    this.probe?.pin(pin, this.cyc);
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
