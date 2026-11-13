// The chip's own timers and pin interrupts, as the firmware drives them through its registers or the core's timer
// calls. On the ATmega328P (Uno, Nano): the ports (PORTx, DDRx, PINx), the external and pin-change interrupts
// (EICRA, EIMSK, PCICR, PCMSKn) and timers 0, 1 and 2 in every waveform mode, with their compare, overflow and
// capture-at-TOP interrupts, PWM and square waves on the OCnx pins, and their flags for code that polls them.
// Timer 0 also keeps millis(): a sketch that changes its prescaler or mode changes how fast millis(), micros() and
// delay() run, as it does on the chip. On the ESP32: the hardware timers of the core's timerBegin() calls (core
// 3.x), each running its handler at its alarm.
//
// A timer is not stepped tick by tick: its count is a straight line from the last time the firmware wrote to it,
// so each event (a compare match, an overflow) has a cycle that is worked out when it is needed, and only the
// events with an interrupt enabled wake the simulation.

import type { FnRef, HwTimers, IoRegister } from "../mcu/vm";
import type { SimHal } from "./hal";

/** An interrupt handler waiting to run. */
export interface ChipVector {
  name: string;
  fn: FnRef;
  /** what the handler is called with (timerAttachInterruptArg's argument) */
  args?: unknown[];
  /** cycles from the event to the handler's first statement (vector jump, register saves), and back after it */
  entry: number;
  exit: number;
}

/** What the HAL asks of a chip's timers and pin interrupts. */
export interface ChipTimers {
  /** the next cycle something with an interrupt enabled is due (Infinity when nothing is) */
  next: number;
  /** set the flags of everything due by cyc */
  due(cyc: number): void;
  /** the highest-priority handler that can run now, its flag cleared as it starts */
  take(): ChipVector | null;
  /** a pin may have changed level (pin-change and external interrupts) */
  pinChanged?(pin: number): void;
  register?(name: string): IoRegister | undefined;
  /** analogWrite() on a pin: the core sets the timer's compare register and connects the pin */
  analogWritten?(pin: number, v: number): void;
  /** digitalWrite() on a pin turns its PWM off, as the core does */
  pwmOff?(pin: number): void;
  /** pinMode() changed a pin: a timer output only drives a pin set as an output */
  pinModeChanged?(pin: number): void;
  /** a handler the sketch defines with ISR(): bound by name, false when this chip has no such vector */
  bind?(name: string, fn: FnRef): boolean;
}

// ------------------------------------------------------------------ ATmega328P

/** port bit -> Arduino pin on the Uno and Nano (PB6 and PB7 run the crystal, PC6 is reset) */
const PORT_PINS: Record<"B" | "C" | "D", number[]> = { B: [8, 9, 10, 11, 12, 13, -1, -1], C: [14, 15, 16, 17, 18, 19, -1, -1], D: [0, 1, 2, 3, 4, 5, 6, 7] };
/** pin -> [port, bit] */
const PIN_PORT = new Map<number, ["B" | "C" | "D", number]>();
for (const p of ["B", "C", "D"] as const) PORT_PINS[p].forEach((pin, bit) => pin >= 0 && PIN_PORT.set(pin, [p, bit]));
/** the pin-change group of each port: PCINT0 is port B, PCINT1 port C, PCINT2 port D */
const PC_GROUP = { B: 0, C: 1, D: 2 } as const;

/** the vectors, highest priority first (the order of the datasheet's vector table) */
export const AVR_CHIP_VECTORS = [
  "INT0_vect",
  "INT1_vect",
  "PCINT0_vect",
  "PCINT1_vect",
  "PCINT2_vect",
  "TIMER2_COMPA_vect",
  "TIMER2_COMPB_vect",
  "TIMER2_OVF_vect",
  "TIMER1_CAPT_vect",
  "TIMER1_COMPA_vect",
  "TIMER1_COMPB_vect",
  "TIMER1_OVF_vect",
  "TIMER0_COMPA_vect",
  "TIMER0_COMPB_vect",
  "TIMER0_OVF_vect",
] as const;
type AvrVector = (typeof AVR_CHIP_VECTORS)[number];

/** the registers this file models (registers.ts lists them for the compiler) */
export const AVR_CHIP_REGISTERS: Record<string, 8 | 16> = {
  PORTB: 8,
  DDRB: 8,
  PINB: 8,
  PORTC: 8,
  DDRC: 8,
  PINC: 8,
  PORTD: 8,
  DDRD: 8,
  PIND: 8,
  EICRA: 8,
  EIMSK: 8,
  EIFR: 8,
  PCICR: 8,
  PCIFR: 8,
  PCMSK0: 8,
  PCMSK1: 8,
  PCMSK2: 8,
  TCCR0A: 8,
  TCCR0B: 8,
  TCNT0: 8,
  OCR0A: 8,
  OCR0B: 8,
  TIMSK0: 8,
  TIFR0: 8,
  TCCR1A: 8,
  TCCR1B: 8,
  TCCR1C: 8,
  TCNT1: 16,
  TCNT1L: 8,
  TCNT1H: 8,
  OCR1A: 16,
  OCR1AL: 8,
  OCR1AH: 8,
  OCR1B: 16,
  OCR1BL: 8,
  OCR1BH: 8,
  ICR1: 16,
  ICR1L: 8,
  ICR1H: 8,
  TIMSK1: 8,
  TIFR1: 8,
  TCCR2A: 8,
  TCCR2B: 8,
  TCNT2: 8,
  OCR2A: 8,
  OCR2B: 8,
  TIMSK2: 8,
  TIFR2: 8,
};

// flag and enable bits shared by TIMSKn and TIFRn
const TOV = 1;
const OCFA = 2;
const OCFB = 4;
const ICF = 0x20;

/** a timer's waveform: how its count moves and what its TOP is */
interface Shape {
  kind: "normal" | "ctc" | "fast" | "pc";
  top: number;
  /** what sets TOP: a fixed value, OCRnA or ICR1 */
  by: "fixed" | "ocrA" | "icr";
}

/** below this many cycles between interrupts the handler cannot keep up, and the simulation stops trying */
const MIN_IRQ_GAP = 64;

class AvrTimer {
  a: number;
  b: number;
  ocrA = 0;
  ocrB = 0;
  icr = 0;
  timsk: number;
  tifr = 0;
  /** the counter: count (single slope) or position along the up-down period (dual slope) c0 at cycle t0 */
  t0 = 0;
  c0 = 0;
  /** flags are set for everything up to this cycle */
  synced = 0;
  /** the firmware wrote this timer's control registers, so its PWM comes from them, not the board's defaults */
  touched = false;
  /** the AVR's TEMP register, for the byte halves of a 16-bit register */
  temp = 0;
  /** the period below which a fault was already reported */
  saidFast = false;
  constructor(
    readonly n: 0 | 1 | 2,
    readonly bits: 8 | 16,
    /** OCnA, OCnB */
    readonly pins: [number, number],
    /** prescaler by clock-select bits: 0 stopped, -1 an external clock */
    private presc: number[],
    a: number,
    b: number,
    timsk: number,
  ) {
    this.a = a;
    this.b = b;
    this.timsk = timsk;
  }

  get max() {
    return this.bits === 8 ? 0xff : 0xffff;
  }
  get prescale() {
    return this.presc[this.b & 7];
  }
  get wgm() {
    return this.bits === 8 ? (((this.b >> 3) & 1) << 2) | (this.a & 3) : (((this.b >> 3) & 3) << 2) | (this.a & 3);
  }

  shape(): Shape {
    const w = this.wgm;
    if (this.bits === 8) {
      switch (w) {
        case 1:
          return { kind: "pc", top: 0xff, by: "fixed" };
        case 2:
          return { kind: "ctc", top: this.ocrA, by: "ocrA" };
        case 3:
          return { kind: "fast", top: 0xff, by: "fixed" };
        case 5:
          return { kind: "pc", top: this.ocrA, by: "ocrA" };
        case 7:
          return { kind: "fast", top: this.ocrA, by: "ocrA" };
        default:
          return { kind: "normal", top: 0xff, by: "fixed" };
      }
    }
    switch (w) {
      case 1:
        return { kind: "pc", top: 0xff, by: "fixed" };
      case 2:
        return { kind: "pc", top: 0x1ff, by: "fixed" };
      case 3:
        return { kind: "pc", top: 0x3ff, by: "fixed" };
      case 4:
        return { kind: "ctc", top: this.ocrA, by: "ocrA" };
      case 5:
        return { kind: "fast", top: 0xff, by: "fixed" };
      case 6:
        return { kind: "fast", top: 0x1ff, by: "fixed" };
      case 7:
        return { kind: "fast", top: 0x3ff, by: "fixed" };
      // phase and frequency correct counts the same way as phase correct; only when it takes a new TOP differs
      case 8:
      case 10:
        return { kind: "pc", top: this.icr, by: "icr" };
      case 9:
      case 11:
        return { kind: "pc", top: this.ocrA, by: "ocrA" };
      case 12:
        return { kind: "ctc", top: this.icr, by: "icr" };
      case 14:
        return { kind: "fast", top: this.icr, by: "icr" };
      case 15:
        return { kind: "fast", top: this.ocrA, by: "ocrA" };
      default:
        return { kind: "normal", top: 0xffff, by: "fixed" };
    }
  }

  /** ticks of the counter since t0, at cycle c */
  private ticks(c: number) {
    const p = this.prescale;
    return p > 0 ? Math.floor((c - this.t0) / p) : 0;
  }

  /** the count at cycle c */
  count(c: number): number {
    const s = this.shape();
    const k = this.ticks(c);
    if (s.kind === "pc") {
      const per = Math.max(1, 2 * s.top);
      const p = (this.c0 + k) % per;
      return p <= s.top ? p : per - p;
    }
    const top = s.kind === "normal" ? this.max : s.top;
    const L = top + 1;
    if (this.c0 <= top) return (this.c0 + k) % L;
    // above a TOP lowered under it, the count runs on to MAX and wraps before it can match
    const k1 = this.max + 1 - this.c0;
    return k < k1 ? this.c0 + k : (k - k1) % L;
  }

  /** start counting again from where the counter is now (before its waveform changes) */
  anchor(c: number) {
    const now = this.count(c);
    this.t0 = c;
    this.c0 = now;
  }

  /** after the waveform changed: the counter's state in the new one */
  settle() {
    const s = this.shape();
    // a dual-slope counter keeps its position on the way up
    if (s.kind === "pc") this.c0 = Math.min(this.c0, s.top);
  }

  /**
   * The first cycle after `after` at which an event happens: a compare match (A, B), the overflow flag (OVF) or
   * TOP when ICR1 sets it (CAPT). Infinity when it never does.
   */
  nextAt(after: number, what: "A" | "B" | "OVF" | "CAPT"): number {
    const P = this.prescale;
    if (P <= 0) return Infinity;
    const s = this.shape();
    const kmin = Math.max(1, Math.floor((after - this.t0) / P) + 1);
    const at = (k: number) => (k === Infinity ? Infinity : this.t0 + k * P);
    // the first k >= kmin with k = r (mod L)
    const kAt = (r: number, L: number, from = kmin) => from + ((((r - from) % L) + L) % L);
    if (what === "CAPT" && s.by !== "icr") return Infinity;
    if (s.kind === "pc") {
      const per = Math.max(1, 2 * s.top);
      const hits: number[] = [];
      if (what === "OVF") hits.push(0);
      else if (what === "CAPT") hits.push(s.top);
      else {
        const x = what === "A" ? this.ocrA : this.ocrB;
        if (x > s.top) return Infinity;
        if (x === 0 || x === s.top) hits.push(x);
        else hits.push(x, per - x);
      }
      return at(Math.min(...hits.map((h) => kAt(h - this.c0, per))));
    }
    const top = s.kind === "normal" ? this.max : s.top;
    const L = top + 1;
    // the count it reaches, for this event: TOV is at MAX → 0 in normal and CTC modes, at TOP in fast PWM
    let target: number;
    if (what === "OVF") target = s.kind === "fast" ? top : 0;
    else if (what === "CAPT") target = top;
    else target = what === "A" ? this.ocrA : this.ocrB;
    const ctcOvf = what === "OVF" && s.kind === "ctc";
    if (this.c0 <= top) {
      if (ctcOvf) return top === this.max ? at(kAt(0 - this.c0, L)) : Infinity;
      if (target > top) return Infinity;
      return at(kAt(target - this.c0, L));
    }
    // above TOP: the run up to MAX, the wrap (the overflow), then the period from 0
    const k1 = this.max + 1 - this.c0;
    const run = (k: number) => (k >= kmin ? k : Infinity);
    let first = Infinity;
    if (what === "OVF" && (ctcOvf || s.kind === "normal")) first = run(k1);
    else if (what !== "OVF" && target > this.c0 && target <= this.max) first = run(target - this.c0);
    if (first < Infinity) return at(first);
    if (ctcOvf) return top === this.max ? at(kAt(k1, L, Math.max(kmin, k1 + 1))) : Infinity;
    if (target > top) return Infinity;
    // in the period after the wrap the count is (k - k1) mod L
    return at(kAt(k1 + target, L, Math.max(kmin, k1 + (target === 0 ? 0 : 1))));
  }

  /** cycles between two of the same event, for the check that a handler can keep up */
  period(): number {
    const s = this.shape();
    const P = this.prescale;
    if (P <= 0) return Infinity;
    return P * (s.kind === "pc" ? 2 * Math.max(1, s.top) : (s.kind === "normal" ? this.max : s.top) + 1);
  }

  /** set the flags of every event up to cycle c */
  sync(c: number) {
    if (c <= this.synced) return;
    const from = this.synced;
    if (this.nextAt(from, "A") <= c) this.tifr |= OCFA;
    if (this.nextAt(from, "B") <= c) this.tifr |= OCFB;
    if (this.nextAt(from, "OVF") <= c) this.tifr |= TOV;
    if (this.bits === 16 && this.nextAt(from, "CAPT") <= c) this.tifr |= ICF;
    this.synced = c;
  }

  /** what an output compare pin does: a PWM duty at a rate, a square wave, a fixed level, or nothing (disconnected) */
  output(ch: 0 | 1, fcpu: number): { duty: number; hz: number } | { level: 0 | 1 } | null {
    const com = (this.a >> (ch === 0 ? 6 : 4)) & 3;
    if (!com) return null;
    const s = this.shape();
    const P = this.prescale;
    if (P <= 0) return { level: 0 };
    const ocr = ch === 0 ? this.ocrA : this.ocrB;
    const toggleOk = ch === 0 && s.by === "ocrA";
    if (s.kind === "normal" || s.kind === "ctc") {
      const top = s.kind === "normal" ? this.max : s.top;
      if (com === 1) return ocr <= top ? { duty: 0.5, hz: fcpu / (2 * P * (top + 1)) } : { level: 0 };
      // clear or set on the first match, then it stays
      return { level: com === 3 ? 1 : 0 };
    }
    if (s.kind === "fast") {
      const hz = fcpu / (P * (s.top + 1));
      if (com === 1) return toggleOk ? { duty: 0.5, hz: hz / 2 } : null;
      const on = ocr >= s.top ? 1 : (ocr + 1) / (s.top + 1);
      return { duty: com === 2 ? on : 1 - on, hz };
    }
    const top = Math.max(1, s.top);
    const hz = fcpu / (P * 2 * top);
    if (com === 1) return toggleOk ? { duty: 0.5, hz: hz / 2 } : null;
    const on = Math.min(1, ocr / top);
    return { duty: com === 2 ? on : 1 - on, hz };
  }
}

/** Arduino's init(): timer 0 fast PWM at /64 with its overflow interrupt (millis), timers 1 and 2 phase-correct at /64 */
function arduinoTimers(): AvrTimer[] {
  return [
    new AvrTimer(0, 8, [6, 5], [0, 1, 8, 64, 256, 1024, -1, -1], 0x03, 0x03, TOV),
    new AvrTimer(1, 16, [9, 10], [0, 1, 8, 64, 256, 1024, -1, -1], 0x01, 0x03, 0),
    new AvrTimer(2, 8, [11, 3], [0, 1, 8, 32, 64, 128, 256, 1024], 0x01, 0x04, 0),
  ];
}

/** cycles of timer 0 between its overflows as the Arduino core sets it up: millis() counts those */
const CORE_OVF = 64 * 256;

export class AvrChip implements ChipTimers {
  next = Infinity;
  timers = arduinoTimers();
  private eicra = 0;
  private eimsk = 0;
  private eifr = 0;
  private pcicr = 0;
  private pcifr = 0;
  private pcmsk = [0, 0, 0];
  /** the level each watched pin had last, for pin-change and external interrupts */
  private last = new Map<number, number>();
  private handlers = new Map<AvrVector, FnRef>();
  private said = new Set<string>();
  /** millis(), micros() and delay() run this many times as fast as the chip's clock says (timer 0's set-up) */
  coreRate = 1;

  constructor(private h: SimHal) {}

  private warn(msg: string) {
    if (this.said.has(msg)) return;
    this.said.add(msg);
    this.h.fault(msg, "firmware", 0);
  }

  bind(name: string, fn: FnRef): boolean {
    if (!(AVR_CHIP_VECTORS as readonly string[]).includes(name)) return false;
    if (name === "TIMER0_OVF_vect") {
      // the core's own millis() handler is that vector: the real build stops with "multiple definition of __vector_16"
      this.warn("ISR(TIMER0_OVF_vect) clashes with the Arduino core, which keeps millis() in that vector: the real build fails with \"multiple definition of __vector_16\". Use TIMER0_COMPA_vect (set OCR0A and OCIE0A) to run code from timer 0, or timer 1 or 2");
      return true;
    }
    this.handlers.set(name as AvrVector, fn);
    if (name === "TIMER1_CAPT_vect") this.warn("ISR(TIMER1_CAPT_vect) runs at TOP when ICR1 sets it (WGM modes 8, 10, 12, 14); capturing edges on the ICP1 pin (D8) is not simulated");
    return true;
  }

  /** a handler set by a library (TimerOne's callback is its TIMER1_OVF_vect) */
  setHandler(name: AvrVector, fn: FnRef | null) {
    if (fn) this.handlers.set(name, fn);
    else this.handlers.delete(name);
  }

  // ---------- events ----------

  due(cyc: number) {
    for (const t of this.timers) t.sync(cyc);
    this.reschedule();
  }

  /** the next event that would raise an interrupt not already waiting */
  reschedule() {
    const c = this.h.cyc;
    let next = Infinity;
    for (const t of this.timers) {
      const want = t.timsk & ~t.tifr;
      if (!want) continue;
      const vec = (k: "A" | "B" | "OVF" | "CAPT") => this.handlers.has(vectorOf(t.n, k));
      let tn = Infinity;
      if (want & OCFA && vec("A")) tn = Math.min(tn, t.nextAt(c, "A"));
      if (want & OCFB && vec("B")) tn = Math.min(tn, t.nextAt(c, "B"));
      if (want & TOV && vec("OVF")) tn = Math.min(tn, t.nextAt(c, "OVF"));
      if (want & ICF && t.n === 1 && vec("CAPT")) tn = Math.min(tn, t.nextAt(c, "CAPT"));
      if (tn === Infinity) continue;
      if (t.period() < MIN_IRQ_GAP) {
        if (!t.saidFast) {
          t.saidFast = true;
          this.warn(`Timer ${t.n} raises its interrupt every ${t.period()} cycles: the handler takes longer than that to enter and leave, so on the chip loop() would never run again. Use a slower prescaler or a bigger TOP`);
        }
        tn = Math.max(tn, c + MIN_IRQ_GAP);
      }
      next = Math.min(next, tn);
    }
    this.next = next;
    if (next < this.h.nextEvt) this.h.nextEvt = next;
  }

  take(): ChipVector | null {
    for (const name of AVR_CHIP_VECTORS) {
      const fn = this.handlers.get(name);
      if (!fn || !this.raised(name)) continue;
      this.clear(name);
      this.reschedule();
      return { name, fn, entry: 24, exit: 20 };
    }
    return null;
  }

  /** the flag is set and its interrupt enabled */
  private raised(v: AvrVector): boolean {
    switch (v) {
      case "INT0_vect":
        return !!(this.eifr & this.eimsk & 1);
      case "INT1_vect":
        return !!(this.eifr & this.eimsk & 2);
      case "PCINT0_vect":
      case "PCINT1_vect":
      case "PCINT2_vect": {
        const g = 1 << Number(v[5]);
        return !!(this.pcifr & this.pcicr & g);
      }
    }
    const t = this.timers[Number(v[5])];
    t.sync(this.h.cyc);
    const bit = v.endsWith("COMPA_vect") ? OCFA : v.endsWith("COMPB_vect") ? OCFB : v.endsWith("OVF_vect") ? TOV : ICF;
    return !!(t.tifr & t.timsk & bit);
  }

  /** the hardware clears the flag as the handler starts */
  private clear(v: AvrVector) {
    if (v === "INT0_vect") this.eifr &= ~1;
    else if (v === "INT1_vect") this.eifr &= ~2;
    else if (v.startsWith("PCINT")) this.pcifr &= ~(1 << Number(v[5]));
    else {
      const t = this.timers[Number(v[5])];
      t.tifr &= ~(v.endsWith("COMPA_vect") ? OCFA : v.endsWith("COMPB_vect") ? OCFB : v.endsWith("OVF_vect") ? TOV : ICF);
    }
  }

  /** something may want to run now: wake the board */
  private poke() {
    this.h.nextEvt = Math.min(this.h.nextEvt, this.h.cyc);
  }

  // ---------- pins ----------

  pinChanged(pin: number) {
    const pp = PIN_PORT.get(pin);
    if (!pp) return;
    const before = this.last.get(pin);
    if (before === undefined) return;
    const now = this.h.level(pin);
    if (now === before) return;
    this.last.set(pin, now);
    const [port, bit] = pp;
    const g = PC_GROUP[port];
    if ((this.pcmsk[g] >> bit) & 1) {
      this.pcifr |= 1 << g;
      if (this.pcicr & (1 << g)) this.poke();
    }
    const n = pin === 2 ? 0 : pin === 3 ? 1 : -1;
    if (n >= 0 && this.eimsk & (1 << n)) {
      const isc = (this.eicra >> (2 * n)) & 3;
      if (isc === 1 || (isc === 2 && now === 0) || (isc === 3 && now === 1) || (isc === 0 && now === 0)) {
        this.eifr |= 1 << n;
        this.poke();
      }
    }
  }

  /** start watching the pins a mask or enable now covers, from their level now */
  private watch() {
    for (const [pin, [port, bit]] of PIN_PORT) {
      const g = PC_GROUP[port];
      const on = (this.pcmsk[g] >> bit) & 1 || ((pin === 2 || pin === 3) && this.eimsk & (pin === 2 ? 1 : 2));
      if (on && !this.last.has(pin)) this.last.set(pin, this.h.level(pin));
      if (!on) this.last.delete(pin);
    }
  }

  private portRead(port: "B" | "C" | "D", what: "PORT" | "DDR" | "PIN"): number {
    const h = this.h;
    let v = 0;
    PORT_PINS[port].forEach((pin, bit) => {
      if (pin < 0) return;
      const m = h.mode[pin];
      const set = what === "DDR" ? m === 1 : what === "PORT" ? (m === 1 ? h.latch[pin] === 1 : m === 2) : h.level(pin) === 1;
      if (set) v |= 1 << bit;
    });
    return v;
  }

  private portWrite(port: "B" | "C" | "D", what: "PORT" | "DDR" | "PIN", v: number) {
    const h = this.h;
    const old = this.portRead(port, "PORT");
    PORT_PINS[port].forEach((pin, bit) => {
      if (pin < 0) return;
      const b = (v >> bit) & 1;
      const out = h.mode[pin] === 1;
      if (what === "DDR") {
        // the PORT bit stays: an input with it set has its pull-up on, an output drives it
        const latch = (old >> bit) & 1;
        if (b && !out) {
          h.pinMode(pin, 1);
          h.digitalWrite(pin, latch);
        } else if (!b && out) h.pinMode(pin, latch ? 2 : 0);
        return;
      }
      // writing a one to PINx toggles the PORT bit
      const nb = what === "PIN" ? ((old >> bit) & 1) ^ b : b;
      if (what === "PIN" && !b) return;
      if (((old >> bit) & 1) === nb) return;
      if (out) h.digitalWrite(pin, nb);
      else h.pinMode(pin, nb ? 2 : 0);
    });
  }

  // ---------- timers and PWM ----------

  private timerOfPin(pin: number): [AvrTimer, 0 | 1] | null {
    for (const t of this.timers) {
      if (t.pins[0] === pin) return [t, 0];
      if (t.pins[1] === pin) return [t, 1];
    }
    return null;
  }

  /** drive the timer's output pins from its registers (once the firmware has set the timer up itself) */
  private outputs(t: AvrTimer) {
    if (!t.touched) return;
    for (const ch of [0, 1] as const) this.drive(t, ch);
  }

  private drive(t: AvrTimer, ch: 0 | 1) {
    const h = this.h;
    const pin = t.pins[ch];
    const o = t.output(ch, h.fcpu);
    const was = h.pwmSet.has(pin) || h.duty[pin] >= 0;
    if (!o) {
      if (was) {
        h.duty[pin] = -1;
        h.pwmSet.delete(pin);
        h.probe?.pin(pin, h.cyc);
      }
      return;
    }
    // the compare unit drives the pin only when it is an output
    if (h.mode[pin] !== 1) return;
    if ("level" in o) {
      h.duty[pin] = -1;
      h.pwmSet.delete(pin);
      h.latch[pin] = o.level;
    } else if (o.duty <= 0 || o.duty >= 1) {
      h.duty[pin] = -1;
      h.pwmSet.set(pin, { hz: o.hz, bits: 8 });
      h.latch[pin] = o.duty >= 1 ? 1 : 0;
    } else {
      h.duty[pin] = o.duty;
      h.pwmSet.set(pin, { hz: o.hz, bits: 8 });
    }
    h.probe?.pin(pin, h.cyc);
  }

  pinModeChanged(pin: number) {
    const tc = this.timerOfPin(pin);
    if (tc && tc[0].touched) this.drive(tc[0], tc[1]);
    if (this.last.has(pin)) this.pinChanged(pin);
  }

  analogWritten(pin: number, v: number) {
    const tc = this.timerOfPin(pin);
    if (!tc) return;
    const [t, ch] = tc;
    const bit = ch === 0 ? 0x80 : 0x20;
    // analogWrite(pin, 0) and (pin, 255) are digitalWrite() in the core, which turns the compare output off
    if (v <= 0 || v >= 255) t.a &= ~(bit | (bit >> 1));
    else {
      t.a = (t.a & ~(bit >> 1)) | bit;
      if (ch === 0) t.ocrA = v & 0xff;
      else t.ocrB = v & 0xff;
    }
    if (t.touched) this.drive(t, ch);
  }

  pwmOff(pin: number) {
    const tc = this.timerOfPin(pin);
    if (!tc) return;
    const [t, ch] = tc;
    const bit = ch === 0 ? 0x80 : 0x20;
    t.a &= ~(bit | (bit >> 1));
    if (t.touched) this.h.pwmSet.delete(pin);
  }

  /** the PWM rate on a timer's pin, when the firmware set the timer up itself */
  pwmHz(pin: number): number | undefined {
    const tc = this.timerOfPin(pin);
    if (!tc || !tc[0].touched) return undefined;
    const o = tc[0].output(tc[1], this.h.fcpu);
    return o && "hz" in o ? o.hz : undefined;
  }

  /** the firmware set a timer's waveform or clock: check what else on the chip needs it */
  private configured(t: AvrTimer) {
    const h = this.h;
    t.touched = true;
    if (t.n === 1 && h.servoUs.size) this.warn("The sketch sets timer 1's registers while the Servo library uses timer 1: on the chip one undoes the other, and the servo pulses go wrong");
    if (t.n === 2 && h.toneHz.size) this.warn("The sketch sets timer 2's registers while tone() uses timer 2: on the chip one undoes the other");
    if (t.prescale < 0) this.warn(`Timer ${t.n} is set to count an external clock on its T${t.n} pin, which the simulation does not have, so it stands still`);
    if (t.bits === 8 && (t.wgm === 4 || t.wgm === 6)) this.warn(`TCCR${t.n}A/B select waveform mode ${t.wgm}, which is reserved on the ATmega328P`);
    if (t.bits === 16 && t.wgm === 13) this.warn("TCCR1A/B select waveform mode 13, which is reserved on the ATmega328P");
    if (t.n === 0) this.coreClock();
    this.outputs(t);
  }

  /** how fast timer 0 now overflows, against the core's set-up: millis(), micros() and delay() count its overflows */
  private coreClock() {
    const t = this.timers[0];
    const s = t.shape();
    const P = t.prescale;
    let ovf: number;
    if (P <= 0 || !(t.timsk & TOV)) ovf = Infinity;
    else if (s.kind === "pc") ovf = P * 2 * Math.max(1, s.top);
    else if (s.kind === "ctc") ovf = s.top === 0xff ? P * 256 : Infinity;
    else ovf = P * ((s.kind === "normal" ? 0xff : s.top) + 1);
    const rate = ovf === Infinity ? 0 : CORE_OVF / ovf;
    if (rate === this.coreRate) return;
    this.h.setCoreRate(rate);
    this.coreRate = rate;
    if (rate === 0) this.warn("Timer 0 no longer overflows with its interrupt on, so millis() and micros() stand still and delay() never returns, as on the chip: the Arduino core counts time with timer 0's overflow");
    else if (Math.abs(rate - 1) > 1e-9)
      this.warn(`Timer 0 now overflows every ${Math.round(ovf)} cycles instead of the core's ${CORE_OVF}: millis(), micros() and delay() run ${rate > 1 ? `${+rate.toFixed(2)} times fast` : `${+(1 / rate).toFixed(2)} times slow`}, as on the chip (the core counts time with timer 0)`);
  }

  // ---------- registers ----------

  register(name: string): IoRegister | undefined {
    const r8 = (read: () => number, write: (v: number) => void): IoRegister => ({ bits: 8, read, write });
    const h = this.h;
    const port = /^(PORT|DDR|PIN)([BCD])$/.exec(name);
    if (port) {
      const what = port[1] as "PORT" | "DDR" | "PIN";
      const p = port[2] as "B" | "C" | "D";
      return r8(
        () => this.portRead(p, what),
        (v) => this.portWrite(p, what, v),
      );
    }
    switch (name) {
      case "EICRA":
        return r8(
          () => this.eicra,
          (v) => (this.eicra = v & 0x0f),
        );
      case "EIMSK":
        return r8(
          () => this.eimsk,
          (v) => {
            this.eimsk = v & 3;
            this.watch();
            if (this.eifr & this.eimsk) this.poke();
          },
        );
      case "EIFR":
        return r8(
          () => this.eifr,
          (v) => (this.eifr &= ~v),
        );
      case "PCICR":
        return r8(
          () => this.pcicr,
          (v) => {
            this.pcicr = v & 7;
            if (this.pcifr & this.pcicr) this.poke();
          },
        );
      case "PCIFR":
        return r8(
          () => this.pcifr,
          (v) => (this.pcifr &= ~v),
        );
      case "PCMSK0":
      case "PCMSK1":
      case "PCMSK2": {
        const g = Number(name[5]);
        return r8(
          () => this.pcmsk[g],
          (v) => {
            this.pcmsk[g] = v & (g === 1 ? 0x7f : 0xff);
            this.watch();
          },
        );
      }
    }
    const m = /^(TCCR|TCNT|OCR|ICR|TIMSK|TIFR)([012])([ABC]?)([LH]?)$/.exec(name);
    if (!m) return undefined;
    const t = this.timers[Number(m[2])];
    const [, kind, , sub, half] = m;
    const now = () => h.cyc;
    // a 16-bit register's halves go through TEMP: the high byte is written first and read second
    const wide = (get: () => number, set: (v: number) => void): IoRegister => {
      if (!half) return { bits: t.bits, read: get, write: set };
      if (half === "H")
        return r8(
          () => t.temp,
          (v) => (t.temp = v & 0xff),
        );
      return r8(
        () => {
          const v = get();
          t.temp = (v >> 8) & 0xff;
          return v & 0xff;
        },
        (v) => set((t.temp << 8) | (v & 0xff)),
      );
    };
    const change = (fn: () => void, waveform: boolean) => {
      t.sync(now());
      t.anchor(now());
      fn();
      t.settle();
      if (waveform) this.configured(t);
      else this.outputs(t);
      this.reschedule();
    };
    switch (kind) {
      case "TCCR":
        if (sub === "A")
          return r8(
            () => t.a,
            (v) => change(() => (t.a = v & 0xf3), true),
          );
        if (sub === "B")
          return r8(
            () => t.b & (t.bits === 8 ? 0x0f : 0xdf),
            (v) => change(() => (t.b = v & (t.bits === 8 ? 0x0f : 0xdf)), true),
          );
        if (sub === "C" && t.n === 1)
          return r8(
            () => 0,
            () => this.warn("TCCR1C forces a compare match (FOC1A, FOC1B), which the simulation does not do"),
          );
        return undefined;
      case "TCNT":
        return wide(
          () => t.count(now()),
          (v) => {
            t.sync(now());
            t.t0 = now();
            t.c0 = v & t.max;
            t.settle();
            this.reschedule();
          },
        );
      case "OCR":
        if (sub !== "A" && sub !== "B") return undefined;
        return wide(
          () => (sub === "A" ? t.ocrA : t.ocrB),
          (v) =>
            change(() => {
              if (sub === "A") t.ocrA = v & t.max;
              else t.ocrB = v & t.max;
            }, false),
        );
      case "ICR":
        if (t.n !== 1) return undefined;
        return wide(
          () => t.icr,
          (v) => change(() => (t.icr = v & 0xffff), false),
        );
      case "TIMSK":
        return r8(
          () => t.timsk,
          (v) => {
            t.sync(now());
            t.timsk = v & (t.n === 1 ? 0x27 : 0x07);
            if (t.n === 1 && t.timsk & ICF && t.shape().by !== "icr") this.warn("TIMSK1 enables the input capture interrupt (ICIE1): capturing edges on ICP1 (D8) is not simulated, so it only runs at TOP in the modes where ICR1 sets TOP");
            if (t.n === 0) this.coreClock();
            this.reschedule();
            if (t.tifr & t.timsk) this.poke();
          },
        );
      case "TIFR":
        return r8(
          () => {
            t.sync(now());
            return t.tifr;
          },
          (v) => {
            t.sync(now());
            // writing a one clears a flag
            t.tifr &= ~v;
            this.reschedule();
          },
        );
    }
    return undefined;
  }
}

function vectorOf(n: number, k: "A" | "B" | "OVF" | "CAPT"): AvrVector {
  return `TIMER${n}_${k === "A" ? "COMPA" : k === "B" ? "COMPB" : k}_vect` as AvrVector;
}

// ------------------------------------------------------------------ ESP32

/** One of the ESP32's four general-purpose hardware timers, as the core's timerBegin() hands it out. */
export interface EspTimer {
  kind: "hw_timer";
  id: number;
  /** counts a second: the 80 MHz APB clock over the divider */
  hz: number;
  running: boolean;
  /** the count c0 at cycle t0 (while running) */
  c0: number;
  t0: number;
  alarm: number;
  alarmOn: boolean;
  autoreload: boolean;
  /** the count the timer goes back to at each alarm, when it reloads */
  reload: number;
  fn: FnRef | null;
  /** timerAttachInterruptArg()'s argument for the handler */
  arg?: unknown;
  /** the alarm went off and the handler has not run yet */
  fired: boolean;
}

/** below this many cycles between alarms the handler cannot keep up (entering and leaving it takes about 2 µs) */
const ESP_MIN_ALARM = 400;

/**
 * The ESP32 core's timers (core 3.x, over ESP-IDF's gptimer): up to four, each counting up at its own rate from the
 * 80 MHz APB clock, with an alarm that runs the attached handler and, with autoreload, puts the count back.
 */
export class Esp32Timers implements ChipTimers, HwTimers {
  next = Infinity;
  list: EspTimer[] = [];
  private said = new Set<string>();
  private made = 0;
  constructor(private h: SimHal) {}

  private warn(msg: string) {
    if (this.said.has(msg)) return;
    this.said.add(msg);
    this.h.fault(msg, "firmware", 0);
  }

  begin(hz: number): EspTimer | null {
    if (!(hz > 0)) {
      this.warn(`timerBegin(${hz}): the core divides the 80 MHz clock by the frequency, so 0 divides by zero and the ESP32 crashes`);
      return null;
    }
    if (this.list.length >= 4) {
      this.warn("timerBegin(): the ESP32 has four hardware timers and all are in use, so it returns NULL");
      return null;
    }
    // the core looks for a divider of 2..65536 from the 80 MHz APB clock
    const div = Math.floor(80e6 / hz);
    if (div < 2 || div > 65536) {
      this.warn(`timerBegin(${hz}): a timer counts at 80 MHz divided by 2 to 65536, so about 1221 Hz to 40 MHz; the core logs "Resolution cannot be reached" and returns NULL`);
      return null;
    }
    const t: EspTimer = { kind: "hw_timer", id: this.made++, hz: 80e6 / div, running: true, c0: 0, t0: this.h.cyc, alarm: 0, alarmOn: false, autoreload: false, reload: 0, fn: null, fired: false };
    this.list.push(t);
    return t;
  }

  attach(t: EspTimer, fn: FnRef | null, arg?: unknown) {
    t.fn = fn;
    t.arg = arg;
    this.reschedule();
  }

  /** timerDetachInterrupt() removes the handler and turns the alarm off */
  detach(t: EspTimer) {
    t.fn = null;
    t.arg = undefined;
    t.alarmOn = false;
    t.fired = false;
    this.reschedule();
  }

  alarm(t: EspTimer, value: number, autoreload: boolean, reload: number) {
    const a = Math.max(0, Math.floor(value));
    const r = Math.max(0, Math.floor(reload));
    if (autoreload && a === r) {
      this.warn(`timerAlarm(timer, ${a}, true, ${r}): the timer refuses an alarm at the count it reloads to, so no alarm is set (the core logs "Timer Alarm Write failed")`);
      return;
    }
    // the core hands the last argument to the timer as its reload value, not a number of reloads
    if (autoreload && r > 0)
      this.warn(
        r < a
          ? `timerAlarm(timer, ${a}, true, ${r}): the core passes the last argument to the timer as the count it reloads to at each alarm, not as how many times to reload, so after the first alarm it goes off every ${a - r} ticks for ever. Pass 0 to reload to 0`
          : `timerAlarm(timer, ${a}, true, ${r}): the core passes the last argument to the timer as the count it reloads to, and ${r} is past the alarm, so it goes off once and never again. Pass 0 to reload to 0`,
      );
    t.alarm = a;
    t.autoreload = autoreload;
    t.reload = r;
    t.alarmOn = true;
    this.reschedule();
  }

  restart(t: EspTimer) {
    t.c0 = 0;
    t.t0 = this.h.cyc;
    this.reschedule();
  }

  read(t: EspTimer): number {
    return this.count(t);
  }

  hz(t: EspTimer): number {
    return t.hz;
  }

  end(t: EspTimer) {
    t.running = false;
    t.alarmOn = false;
    t.fn = null;
    t.fired = false;
    this.list = this.list.filter((x) => x !== t);
    this.reschedule();
  }

  count(t: EspTimer): number {
    if (!t.running) return t.c0;
    return t.c0 + Math.max(0, Math.floor(((this.h.cyc - t.t0) * t.hz) / this.h.fcpu));
  }

  write(t: EspTimer, v: number) {
    t.c0 = Math.max(0, Math.floor(v));
    t.t0 = this.h.cyc;
    this.reschedule();
  }

  start(t: EspTimer) {
    if (t.running) return;
    t.t0 = this.h.cyc;
    t.running = true;
    this.reschedule();
  }

  stop(t: EspTimer) {
    if (!t.running) return;
    t.c0 = this.count(t);
    t.running = false;
    this.reschedule();
  }

  /** the cycle the timer's alarm next goes off (it goes off as the count reaches the alarm value) */
  private alarmAt(t: EspTimer): number {
    if (!t.running || !t.alarmOn) return Infinity;
    if (this.count(t) > t.alarm) return Infinity;
    return t.t0 + Math.ceil(((t.alarm - t.c0) * this.h.fcpu) / t.hz);
  }

  reschedule() {
    let n = Infinity;
    for (const t of this.list) n = Math.min(n, this.alarmAt(t));
    this.next = n;
    if (n < this.h.nextEvt) this.h.nextEvt = n;
  }

  due(cyc: number) {
    for (const t of this.list) {
      for (let at = this.alarmAt(t); at <= cyc; at = this.alarmAt(t)) {
        // one interrupt waits however many alarms go by before its handler runs
        if (t.fn) t.fired = true;
        else this.warn("A timer's alarm went off with no handler attached: call timerAttachInterrupt(timer, fn) so something runs at the alarm");
        if (!t.autoreload) {
          // the hardware turns the alarm off once it goes off
          t.alarmOn = false;
          break;
        }
        // the hardware puts the count back at the alarm, whenever the handler gets to run
        const period = Math.ceil(((t.alarm - t.reload) * this.h.fcpu) / t.hz);
        if (period > 0 && period < ESP_MIN_ALARM)
          this.warn(`A timer alarm every ${period} cycles is faster than its handler can run on the ESP32 (about 2 µs to enter and leave): the handler falls behind, and the simulation spaces the alarms out`);
        t.c0 = t.reload;
        t.t0 = at + (period > 0 ? Math.max(0, ESP_MIN_ALARM - period) : 0);
      }
    }
    this.reschedule();
  }

  take(): ChipVector | null {
    for (const t of this.list) {
      if (!t.fired || !t.fn) continue;
      t.fired = false;
      // the core's dispatch through ESP-IDF's interrupt allocator and gptimer: a couple of microseconds
      return { name: `timer ${t.id}`, fn: t.fn, args: t.arg === undefined ? [] : [t.arg], entry: Math.round(this.h.fcpu * 1.2e-6), exit: Math.round(this.h.fcpu * 0.6e-6) };
    }
    return null;
  }
}
