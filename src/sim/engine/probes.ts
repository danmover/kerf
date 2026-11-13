// The logic analyser and scope: what happened on the chip's pins and buses during a run. Every change of a pin's
// drive (a level, a PWM duty and rate, servo pulses, a tone, an outside level on an input), each byte on the
// serial ports with its time on the wire, each I2C and SPI transaction, and each analog reading the firmware took.
// The board reports these as they happen; nothing is sampled, so recording changes nothing in the run.

import type { Board } from "../mcu/board";

export interface SignalSpec {
  /** record at most this many pin changes and bus events (400 000); later ones are dropped and the trace says so */
  maxEvents?: number;
}

/** What a pin was doing from a time on. */
export interface PinSeg {
  /** seconds since power-up */
  t: number;
  /** "l": a steady level (v); "pwm": duty at hz; "servo": pulses us long at 50 Hz; "tone": a square wave at hz; "z": nothing drives it */
  k: "l" | "pwm" | "servo" | "tone" | "z";
  v?: 0 | 1;
  duty?: number;
  hz?: number;
  us?: number;
  /** who drives it: the chip (an output) or something outside (an input) */
  by: "chip" | "outside" | "pull-up" | "none";
}

export interface PinTrace {
  pin: number;
  /** the board's name for it: D3, A0, GPIO26 */
  name: string;
  segs: PinSeg[];
}

export interface UartByte {
  port: number;
  dir: "tx" | "rx";
  /** seconds: when the byte started on the wire, and when it ended */
  t0: number;
  t1: number;
  b: number;
}

export interface I2cTx {
  t0: number;
  t1: number;
  addr: number;
  op: "w" | "r";
  bytes: number[];
  /** the device answered its address */
  ack: boolean;
}

export interface SpiTx {
  t0: number;
  t1: number;
  /** the chip-select pin the firmware had low, -1 when none */
  cs: number;
  out: number[];
  in: number[];
  hz: number;
}

export interface AdcSample {
  pin: number;
  t: number;
  volts: number;
  reading: number;
}

export interface SignalTrace {
  pins: PinTrace[];
  uart: UartByte[];
  i2c: I2cTx[];
  spi: SpiTx[];
  adc: AdcSample[];
  /** seconds the run lasted */
  end: number;
  /** the logic level, V */
  logicV: number;
  /** events were dropped past the cap: the trace stops early there */
  truncatedAt?: number;
}

/** What the board tells the recorder. Times are in chip cycles. */
export interface ProbeHooks {
  pin(pin: number, at: number): void;
  tx(port: number, b: number, end: number, byteCycles: number): void;
  rx(port: number, b: number, at: number, byteCycles: number): void;
  i2c(addr: number, op: "w" | "r", bytes: number[], ack: boolean, t0: number, t1: number): void;
  spi(cs: number, out: number[], inp: number[], hz: number, t0: number, t1: number): void;
  adc(pin: number, at: number, volts: number, reading: number): void;
}

/** The pin state a recorder reads from the board. */
export interface PinState {
  mode: Uint8Array;
  latch: Uint8Array;
  duty: Float64Array;
  ext: Int8Array;
  servoUs: Map<number, number>;
  toneHz: Map<number, number>;
  pwmHz(pin: number): number;
  fcpu: number;
  board: Board;
}

/** A pin's name as the board's pinout prints it. */
export function pinName(board: Board, pin: number): string {
  if (board.arch === "esp32") return `GPIO${pin}`;
  const a = board.analog.indexOf(pin);
  if (a >= 0) return `A${a}`;
  return `D${pin}`;
}

export class SignalRecorder implements ProbeHooks {
  private pins = new Map<number, PinTrace>();
  private uart: UartByte[] = [];
  private i2cTx: I2cTx[] = [];
  private spiTx: SpiTx[] = [];
  private adcS: AdcSample[] = [];
  private events = 0;
  private max: number;
  private truncatedAt?: number;

  constructor(
    private hal: PinState,
    spec: SignalSpec = {},
  ) {
    this.max = Math.max(1000, Math.min(2_000_000, spec.maxEvents ?? 400_000));
  }

  private room(at: number): boolean {
    if (this.events < this.max) {
      this.events++;
      return true;
    }
    this.truncatedAt ??= at / this.hal.fcpu;
    return false;
  }

  private state(pin: number, t: number): PinSeg {
    const h = this.hal;
    const mode = h.mode[pin];
    // Servo and tone() make the pin an output themselves
    const tone = h.toneHz.get(pin);
    if (tone) return { t, k: "tone", hz: tone, by: "chip" };
    const us = h.servoUs.get(pin);
    if (us !== undefined) return { t, k: "servo", us, by: "chip" };
    if (mode === 1) {
      const d = h.duty[pin];
      if (d >= 0) return { t, k: "pwm", duty: d, hz: h.pwmHz(pin), by: "chip" };
      return { t, k: "l", v: h.latch[pin] ? 1 : 0, by: "chip" };
    }
    const e = h.ext[pin];
    if (e >= 0) return { t, k: "l", v: e ? 1 : 0, by: "outside" };
    if (mode === 2) return { t, k: "l", v: 1, by: "pull-up" };
    return { t, k: "z", by: "none" };
  }

  pin(pin: number, at: number) {
    if (pin < 0 || pin >= this.hal.mode.length) return;
    const t = at / this.hal.fcpu;
    const s = this.state(pin, t);
    let tr = this.pins.get(pin);
    if (!tr) {
      tr = { pin, name: pinName(this.hal.board, pin), segs: [] };
      this.pins.set(pin, tr);
    }
    const last = tr.segs[tr.segs.length - 1];
    if (last && last.k === s.k && last.v === s.v && last.duty === s.duty && last.hz === s.hz && last.us === s.us && last.by === s.by) return;
    if (!this.room(at)) return;
    // two changes at the same moment: the later one stands
    if (last && last.t === t) tr.segs[tr.segs.length - 1] = s;
    else tr.segs.push(s);
  }

  tx(port: number, b: number, end: number, bc: number) {
    if (!this.room(end)) return;
    const f = this.hal.fcpu;
    this.uart.push({ port, dir: "tx", t0: (end - bc) / f, t1: end / f, b });
  }

  rx(port: number, b: number, at: number, bc: number) {
    if (!this.room(at)) return;
    const f = this.hal.fcpu;
    this.uart.push({ port, dir: "rx", t0: (at - bc) / f, t1: at / f, b });
  }

  i2c(addr: number, op: "w" | "r", bytes: number[], ack: boolean, t0: number, t1: number) {
    if (!this.room(t0)) return;
    const f = this.hal.fcpu;
    this.i2cTx.push({ t0: t0 / f, t1: t1 / f, addr, op, bytes: bytes.slice(0, 64), ack });
  }

  spi(cs: number, out: number[], inp: number[], hz: number, t0: number, t1: number) {
    if (!this.room(t0)) return;
    const f = this.hal.fcpu;
    this.spiTx.push({ t0: t0 / f, t1: t1 / f, cs, out: out.slice(0, 64), in: inp.slice(0, 64), hz });
  }

  adc(pin: number, at: number, volts: number, reading: number) {
    if (!this.room(at)) return;
    this.adcS.push({ pin, t: at / this.hal.fcpu, volts, reading });
  }

  result(endCyc: number): SignalTrace {
    const pins = [...this.pins.values()].filter((p) => p.segs.length > 1 || (p.segs[0] && p.segs[0].k !== "z")).sort((a, b) => a.pin - b.pin);
    return {
      pins,
      uart: this.uart.sort((a, b) => a.t0 - b.t0),
      i2c: this.i2cTx,
      spi: this.spiTx,
      adc: this.adcS,
      end: endCyc / this.hal.fcpu,
      logicV: this.hal.board.logicV,
      ...(this.truncatedAt !== undefined ? { truncatedAt: this.truncatedAt } : {}),
    };
  }
}

// ---------------------------------------------------------------- export

/** The pin's waveform as edges in [t0, t1): PWM, servo pulses and tones drawn out, at most maxEdges. */
export function edges(p: PinTrace, t0: number, t1: number, maxEdges = 2_000_000): { t: number; v: 0 | 1 | -1 }[] {
  const out: { t: number; v: 0 | 1 | -1 }[] = [];
  for (let i = 0; i < p.segs.length && out.length < maxEdges; i++) {
    const s = p.segs[i];
    const a = Math.max(t0, s.t);
    const b = Math.min(t1, p.segs[i + 1]?.t ?? t1);
    if (b <= a) continue;
    if (s.k === "l") out.push({ t: a, v: s.v! });
    else if (s.k === "z") out.push({ t: a, v: -1 });
    else {
      const hz = s.k === "servo" ? 50 : s.hz!;
      const high = s.k === "pwm" ? s.duty! / hz : s.k === "servo" ? s.us! / 1e6 : 0.5 / hz;
      const period = 1 / hz;
      // periods line up with power-up, as the chip's timers do
      for (let c = Math.floor(a / period) * period; c < b && out.length < maxEdges; c += period) {
        if (c + high > a) out.push({ t: Math.max(a, c), v: 1 });
        if (c + high < b && c + high >= a) out.push({ t: c + high, v: 0 });
      }
    }
  }
  return out;
}

/** Value Change Dump of a time window, for PulseView, GTKWave or sigrok. */
export function toVcd(tr: SignalTrace, t0: number, t1: number, opts: { names?: Map<number, string>; design?: string } = {}): string {
  const ids: string[] = [];
  const id = (i: number) => {
    let s = "";
    let n = i;
    do {
      s += String.fromCharCode(33 + (n % 94));
      n = Math.floor(n / 94);
    } while (n > 0);
    return s;
  };
  const head: string[] = [`$date ${new Date().toUTCString()} $end`, `$version Kerf simulation${opts.design ? ` of ${opts.design}` : ""} $end`, "$timescale 1 ns $end", "$scope module chip $end"];
  const ev: { t: number; s: string }[] = [];
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_.]/g, "_");
  tr.pins.forEach((p, i) => {
    const k = id(i);
    ids.push(k);
    head.push(`$var wire 1 ${k} ${clean(opts.names?.get(p.pin) ? `${p.name}_${opts.names.get(p.pin)}` : p.name)} $end`);
    for (const e of edges(p, t0, t1)) ev.push({ t: e.t, s: `${e.v < 0 ? "z" : e.v}${k}` });
  });
  let n = tr.pins.length;
  const ports = [...new Set(tr.uart.map((u) => `${u.port}:${u.dir}`))];
  for (const pd of ports) {
    const k = id(n++);
    const [port, dir] = pd.split(":");
    head.push(`$var reg 8 ${k} Serial${port === "0" ? "" : port}_${dir} $end`);
    for (const u of tr.uart) if (`${u.port}:${u.dir}` === pd && u.t1 >= t0 && u.t0 < t1) ev.push({ t: u.t1, s: `b${u.b.toString(2)} ${k}` });
  }
  const adcPins = [...new Set(tr.adc.map((a) => a.pin))];
  for (const pin of adcPins) {
    const k = id(n++);
    const p = tr.pins.find((x) => x.pin === pin);
    head.push(`$var real 64 ${k} ${clean(`${p?.name ?? `pin${pin}`}_volts`)} $end`);
    for (const a of tr.adc) if (a.pin === pin && a.t >= t0 && a.t < t1) ev.push({ t: a.t, s: `r${a.volts.toPrecision(6)} ${k}` });
  }
  if (tr.i2c.length) {
    const k = id(n++);
    head.push(`$var reg 8 ${k} I2C_address $end`);
    for (const x of tr.i2c) if (x.t0 >= t0 && x.t0 < t1) ev.push({ t: x.t0, s: `b${((x.addr << 1) | (x.op === "r" ? 1 : 0)).toString(2)} ${k}` });
  }
  head.push("$upscope $end", "$enddefinitions $end");
  ev.sort((a, b) => a.t - b.t);
  const out = [...head];
  let last = -1;
  for (const e of ev) {
    const ns = Math.max(0, Math.round((e.t - t0) * 1e9));
    if (ns !== last) {
      out.push(`#${ns}`);
      last = ns;
    }
    out.push(e.s);
  }
  out.push(`#${Math.round((t1 - t0) * 1e9)}`);
  return out.join("\n") + "\n";
}
