// Electrical rules check: builds the netlist from wire/net statements and
// the catalog pin data, then checks power, logic levels, PWM and ADC pins,
// buses, motor drivers, currents, wire sizes, grounds and connector ports.
// These are rules over datasheet ratings: they catch wiring mistakes that
// would stop a machine working or damage a part, not every analog subtlety.

import type { CheckItem } from "../core/checks";
import type { Span } from "../lang/ast";
import { fmtNum } from "../lang/values";
import { awgAmpacity } from "./calcs";
import { catalogPart } from "./catalog";
import type { CatalogPart, MachineComponent, MachineData, PinDef, PinRef } from "./types";

export interface NetPin {
  key: string;
  comp: string;
  index: number;
  pin: PinDef;
  part: CatalogPart;
  mc: MachineComponent;
}

/** One wire run between two pins: a `wire` hop, or a branch of a `net` statement (a bus from its first pin). */
export interface NetSeg {
  a: NetPin;
  b: NetPin;
  gauge?: number;
  span: Span;
  label?: string;
  /** the `net` statement this branch belongs to: its branches form one bus */
  bus?: number;
}

export interface Net {
  id: number;
  name?: string;
  pins: NetPin[];
  /** the wire runs on this net, each with its own gauge */
  segs: NetSeg[];
  /** the thinnest gauge on the net (largest AWG number) */
  gauge?: number;
  spans: Span[];
  /** volts on the net when something supplies it */
  v?: number;
}

export interface Netlist {
  nets: Net[];
  netOf: Map<string, Net>;
  /** port-to-port cables */
  cables: { a: NetPin; b: NetPin; span: Span }[];
  pinsOf: Map<string, NetPin[]>;
}

const key = (comp: string, index: number, pin: string) => `${comp}[${index}].${pin}`;
const who = (p: NetPin) => `${p.comp}${p.mc.count > 1 ? `[${p.index}]` : ""}.${p.pin.id}`;

class UF {
  parent = new Map<string, string>();
  find(a: string): string {
    let r = a;
    while (this.parent.has(r) && this.parent.get(r) !== r) r = this.parent.get(r)!;
    this.parent.set(a, r);
    return r;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export function buildNetlist(m: MachineData): Netlist {
  const comps = new Map(m.components.map((c) => [c.name, c]));
  const pinsOf = new Map<string, NetPin[]>();
  const all = new Map<string, NetPin>();
  for (const c of m.components) {
    const part = catalogPart(c.catalogId);
    if (!part) continue;
    const list: NetPin[] = [];
    for (let i = 0; i < c.count; i++) {
      for (const pin of part.pins) {
        const np = { key: key(c.name, i, pin.id), comp: c.name, index: i, pin, part, mc: c };
        all.set(np.key, np);
        list.push(np);
      }
    }
    pinsOf.set(c.name, list);
  }
  const resolve = (r: PinRef) => all.get(key(r.comp, r.index ?? 0, r.pin));
  const uf = new UF();
  const touched = new Set<string>();
  const cables: Netlist["cables"] = [];
  const segs: NetSeg[] = [];
  const spans = new Map<string, Span[]>();
  const names = new Map<string, string>();
  // gauges are kept per wire run: a net's runs can differ, and the thinnest one is what can overheat
  const join = (seg: NetSeg) => {
    const { a, b } = seg;
    touched.add(a.key);
    touched.add(b.key);
    if (a.pin.type === "port" || b.pin.type === "port") {
      cables.push({ a, b, span: seg.span });
      return;
    }
    uf.union(a.key, b.key);
    segs.push(seg);
    spans.set(a.key, [...(spans.get(a.key) ?? []), seg.span]);
  };
  for (const w of m.wires) {
    const a = resolve(w.a);
    const b = resolve(w.b);
    if (a && b) join({ a, b, gauge: w.gauge, span: w.span, label: w.label });
  }
  m.nets.forEach((n, bus) => {
    const ps = n.pins.map(resolve).filter((x): x is NetPin => !!x);
    for (const p of ps) touched.add(p.key);
    for (let i = 1; i < ps.length; i++) join({ a: ps[0], b: ps[i], gauge: n.gauge, span: n.span, label: n.name, bus });
    if (ps[0]) names.set(ps[0].key, n.name);
  });
  // passive parts (fuses, switches, connector pairs) conduct between their paired terminals
  for (const np of all.values()) {
    if (np.pin.type === "passive" && np.pin.through && touched.has(np.key)) {
      const other = all.get(key(np.comp, np.index, np.pin.through));
      if (other && touched.has(other.key)) uf.union(np.key, other.key);
    }
  }
  const groups = new Map<string, NetPin[]>();
  for (const np of all.values()) {
    if (!touched.has(np.key) || np.pin.type === "port") continue;
    const r = uf.find(np.key);
    groups.set(r, [...(groups.get(r) ?? []), np]);
  }
  const nets: Net[] = [];
  const netOf = new Map<string, Net>();
  let id = 0;
  for (const pins of groups.values()) {
    const nm = pins.map((p) => names.get(p.key)).find(Boolean);
    const net: Net = { id: id++, name: nm, pins, segs: [], spans: pins.flatMap((p) => spans.get(p.key) ?? []) };
    nets.push(net);
    for (const p of pins) netOf.set(p.key, net);
  }
  for (const sg of segs) netOf.get(sg.a.key)?.segs.push(sg);
  for (const n of nets) {
    const g = Math.max(0, ...n.segs.map((sg) => sg.gauge ?? 0));
    if (g > 0) n.gauge = g;
  }
  void comps;
  return { nets, netOf, cables, pinsOf };
}

/** Human name for a net: its declared name, or its most telling pin. */
export function netLabel(n: Net): string {
  if (n.name) return n.name;
  const src = n.pins.find((p) => p.pin.type === "pwr_out") ?? n.pins.find((p) => p.pin.type === "gnd") ?? n.pins.find((p) => p.pin.type === "io") ?? n.pins[0];
  return src ? who(src) : `net ${n.id}`;
}

interface Ctx {
  nl: Netlist;
  out: CheckItem[];
  m: MachineData;
}

function item(c: Ctx, id: string, status: CheckItem["status"], title: string, detail: string, comps: string[], span?: Span, fix?: string) {
  c.out.push({ id: `erc:${id}`, category: "electrical", status, title, detail, parts: comps, span, basis: "electrical rules", ...(fix ? { fix } : {}) });
}

const supplies = (n: Net) => n.pins.filter((p) => p.pin.type === "pwr_out");
const rails = (n: Net) => n.pins.filter((p) => p.pin.type === "pwr_rail");
const grounds = (n: Net) => n.pins.filter((p) => p.pin.type === "gnd");

/** Effective supply pins on a net: pwr_out, or board rails when nothing else feeds the net. */
function sourcesOf(n: Net): NetPin[] {
  const s = supplies(n);
  return s.length ? s : rails(n);
}

function netVoltage(n: Net): number | undefined {
  const s = sourcesOf(n);
  return s.length ? s[0].pin.v : undefined;
}

/** The net voltage a logic output drives: its own level, or the voltage on its reference pin. */
function driveLevel(c: Ctx, p: NetPin): number | undefined {
  if (p.pin.vref) {
    const ref = c.nl.netOf.get(key(p.comp, p.index, p.pin.vref));
    return ref ? netVoltage(ref) : undefined;
  }
  return p.pin.v;
}

export function electricalChecks(m: MachineData, opts: { motorCurrent?: (comp: string) => number | undefined; motorStall?: (comp: string) => number | undefined } = {}): CheckItem[] {
  const nl = buildNetlist(m);
  const c: Ctx = { nl, out: [], m };
  const electrical = m.components.filter((x) => (catalogPart(x.catalogId)?.pins.length ?? 0) > 0);
  if (!electrical.length) return [];
  if (!m.wires.length && !m.nets.length) {
    item(c, "nowiring", "warn", "Wiring", `${electrical.length} electrical parts but no wiring yet. Add wire and net statements so the pins, power and firmware can be checked.`, electrical.map((x) => x.name));
    return c.out;
  }
  for (const n of nl.nets) n.v = netVoltage(n);

  powerChecks(c);
  logicChecks(c);
  sharedPins(c);
  i2cAddresses(c);
  motorChecks(c, opts.motorCurrent);
  portChecks(c);
  groundChecks(c);
  unconnected(c);
  protection(c);
  budget(c, opts.motorCurrent);
  surge(c, opts.motorCurrent, opts.motorStall);

  if (!c.out.some((i) => i.status === "fail" || i.status === "warn")) {
    item(c, "ok", "pass", "Wiring rules", `${nl.nets.length} nets and ${nl.cables.length} cables checked: power, logic levels, PWM and analog pins, motor drivers, grounds and connectors are consistent.`, []);
  }
  return c.out;
}

function powerChecks(c: Ctx) {
  for (const n of c.nl.nets) {
    const name = netLabel(n);
    const out = supplies(n);
    const gnd = grounds(n);
    const span = n.spans[0];
    if (gnd.length && (out.length || rails(n).length)) {
      const s = [...out, ...rails(n)][0];
      item(c, `short:${n.id}`, "fail", `Short circuit on ${name}`, `${who(s)} (${fmtNum(s.pin.v ?? 0)} V) is connected straight to ground (${who(gnd[0])}).`, [s.comp, gnd[0].comp], span);
      continue;
    }
    if (out.length > 1) {
      const vs = [...new Set(out.map((p) => p.pin.v))];
      item(c, `fight:${n.id}`, vs.length > 1 ? "fail" : "warn", `Two supplies on ${name}`, vs.length > 1 ? `${out.map((p) => `${who(p)} (${fmtNum(p.pin.v ?? 0)} V)`).join(" and ")} are tied together: they will fight.` : `${out.map(who).join(" and ")} are paralleled. Only do this if both are designed to share current.`, out.map((p) => p.comp), span);
    }
    const src = sourcesOf(n)[0];
    // a board rail fed from outside acts as an input at its rated voltage
    if (out.length) {
      for (const r of rails(n)) {
        const v = out[0].pin.v ?? 0;
        const rv = r.pin.v ?? 0;
        if (Math.abs(v - rv) > rv * 0.08) item(c, `rail:${r.key}`, "fail", `${who(r)} fed with ${fmtNum(v)} V`, `${who(r)} is the board's ${fmtNum(rv)} V rail. Feeding it ${fmtNum(v)} V from ${who(out[0])} will damage the board. Use its VIN pin or a regulator.`, [r.comp, out[0].comp], span);
      }
    }
    for (const p of n.pins) {
      if (p.pin.type !== "pwr_in") continue;
      if (!src) {
        if (p.pin.required) item(c, `unpowered:${p.key}`, "fail", `${who(p)} has no power`, `${p.part.name}: ${p.pin.label ?? p.pin.id} is wired to ${name}, but nothing supplies that net.`, [p.comp], span);
        continue;
      }
      const v = src.pin.v ?? 0;
      const vHigh = Math.max(v, src.pin.vmax ?? v);
      const vLow = Math.min(v, src.pin.vmin ?? v);
      if (p.pin.vabs !== undefined && vHigh > p.pin.vabs + 1e-9) {
        item(c, `overv:${p.key}`, "fail", `${who(p)} over its absolute maximum`, `${p.part.name} ${p.pin.label ?? p.pin.id} is rated to ${fmtNum(p.pin.vabs)} V absolute maximum; ${who(src)} supplies up to ${fmtNum(vHigh)} V. It will be damaged.`, [p.comp, src.comp], span);
      } else if (p.pin.vmax !== undefined && vHigh > p.pin.vmax + 1e-9) {
        item(c, `highv:${p.key}`, "warn", `${who(p)} above its recommended range`, `${p.part.name} ${p.pin.label ?? p.pin.id} works up to ${fmtNum(p.pin.vmax)} V; ${who(src)} reaches ${fmtNum(vHigh)} V (a full battery). It survives, but runs hotter.`, [p.comp, src.comp], span);
      }
      if (p.pin.vmin !== undefined && vLow < p.pin.vmin - 1e-9) {
        item(c, `lowv:${p.key}`, vLow < p.pin.vmin * 0.9 ? "fail" : "warn", `${who(p)} supply too low`, `${p.part.name} ${p.pin.label ?? p.pin.id} needs at least ${fmtNum(p.pin.vmin)} V; ${who(src)} gives ${fmtNum(vLow)} V${vLow < v ? " when the battery is low" : ""}.`, [p.comp, src.comp], span);
      }
    }
  }
}

function logicChecks(c: Ctx) {
  for (const n of c.nl.nets) {
    const span = n.spans[0];
    const ios = n.pins.filter((p) => p.pin.type === "io");
    const outs = n.pins.filter((p) => p.pin.type === "out");
    const ins = n.pins.filter((p) => p.pin.type === "in");
    const analog = n.pins.filter((p) => p.pin.type === "analog_out");
    const power = sourcesOf(n);
    for (const i of ins) {
      // inputs may be tied to a supply rail (enable pins)
      const drivers = [...ios.filter((p) => !p.pin.input_only), ...outs];
      const tied = power[0];
      const d = drivers[0];
      const level = d ? driveLevel(c, d) : tied?.pin.v;
      if (!d && !tied) continue;
      const by = d ? who(d) : who(tied!);
      if (level !== undefined && i.pin.vmax !== undefined && level > i.pin.vmax + 0.05) {
        item(c, `logic-high:${i.key}`, "fail", `${who(i)} over-driven`, `${by} drives ${fmtNum(level)} V into ${i.part.name} ${i.pin.id}, which tolerates ${fmtNum(i.pin.vmax)} V. Use a level shifter or a ${fmtNum(i.pin.vmax)} V-tolerant pin.`, [i.comp, (d ?? tied!).comp], span);
      }
      if (level !== undefined && i.pin.vih !== undefined && level < i.pin.vih - 0.05) {
        item(c, `logic-low:${i.key}`, "fail", `${who(i)} may not read high`, `${i.part.name} ${i.pin.id} needs at least ${fmtNum(i.pin.vih)} V for a high; ${by} gives ${fmtNum(level)} V. Power the module's logic from the controller's voltage or use a level shifter.`, [i.comp, (d ?? tied!).comp], span);
      }
      if (i.pin.needs === "pwm" && d && d.pin.type === "io" && !d.pin.pwm) {
        item(c, `pwm:${i.key}`, "fail", `${who(i)} needs a PWM pin`, `${i.part.name} ${i.pin.id} sets the motor speed with PWM, but ${who(d)} has no hardware PWM. Use one of: ${pwmPins(d.part).join(", ")}.`, [i.comp, d.comp], span);
      }
      if (i.pin.bus && d && d.pin.type === "io" && d.pin.bus !== i.pin.bus) {
        item(c, `bus:${i.key}`, "fail", `${who(i)} on the wrong pin`, `${i.part.name} ${i.pin.id} is ${busName(i.pin.bus)}; on ${d.part.name} that is ${busPins(d.part, i.pin.bus).join(" or ") || "not available"}, not ${d.pin.id}.`, [i.comp, d.comp], span);
      }
      if (d && d.pin.input_only) {
        item(c, `inonly:${i.key}`, "fail", `${who(d)} cannot drive`, `${who(d)} is input only.`, [d.comp], span);
      }
    }
    for (const o of outs) {
      const level = driveLevel(c, o);
      for (const g of ios) {
        if (level !== undefined && g.pin.v !== undefined && level > g.pin.v + 0.3) {
          item(c, `into-io:${g.key}`, "fail", `${fmtNum(level)} V into ${who(g)}`, `${who(o)} outputs ${fmtNum(level)} V; ${g.part.name} pins are ${fmtNum(g.pin.v)} V and not tolerant. Power ${o.part.name} from ${fmtNum(g.pin.v)} V or add a divider.`, [o.comp, g.comp], span);
        }
        if (o.pin.bus && g.pin.bus !== o.pin.bus) item(c, `obus:${o.key}`, "fail", `${who(o)} on the wrong pin`, `${o.part.name} ${o.pin.id} is ${busName(o.pin.bus)}; use ${busPins(g.part, o.pin.bus).join(" or ")}.`, [o.comp, g.comp], span);
        if (o.pin.needs === "irq" && !g.pin.irq) item(c, `irq:${o.key}`, "warn", `${who(o)} should use an interrupt pin`, `${o.part.name} ${o.pin.id} pulses fast; ${who(g)} cannot trigger an interrupt, so counts will be missed. Use ${g.part.pins.filter((p) => p.irq).slice(0, 6).map((p) => p.id).join(", ")}.`, [o.comp, g.comp], span);
      }
    }
    for (const a of analog) {
      const g = ios[0];
      if (!g) continue;
      if (!g.pin.adc) item(c, `adc:${a.key}`, "fail", `${who(a)} needs an analog pin`, `${a.part.name} ${a.pin.id} is an analog signal but ${who(g)} cannot read voltages. Use ${g.part.pins.filter((p) => p.adc).slice(0, 6).map((p) => p.id).join(", ")}.`, [a.comp, g.comp], span);
      const level = driveLevel(c, a);
      if (level !== undefined && g.pin.v !== undefined && level > g.pin.v + 0.3) item(c, `adcv:${a.key}`, "warn", `${who(a)} can exceed ${who(g)}`, `${a.part.name} ${a.pin.id} can reach ${fmtNum(level)} V; ${g.part.name} reads up to ${fmtNum(g.pin.v)} V. Add a divider.`, [a.comp, g.comp], span);
    }
    for (const g of ios) {
      if (g.pin.note && /strapping/i.test(g.pin.note) && (ins.length || outs.length)) item(c, `strap:${g.key}`, "warn", `${who(g)} is a boot strapping pin`, `${g.pin.note}. A module holding it at the wrong level stops the board booting. Prefer another pin.`, [g.comp], span);
      if (g.pin.note && /USB serial/i.test(g.pin.note) && (ins.length || outs.length)) item(c, `serial:${g.key}`, "warn", `${who(g)} shares the USB serial port`, `${g.pin.note}. Uploads and the serial console can glitch whatever is on it.`, [g.comp], span);
    }
    // two module outputs on one net fight each other; a controller pin on an output just reads it
    if (outs.length > 1 && new Set(outs.map((d) => d.comp)).size > 1) item(c, `contention:${n.id}`, "fail", `Two outputs on ${netLabel(n)}`, `${outs.map(who).join(", ")} can all drive this net.`, outs.map((d) => d.comp), span);
    const ioDrivers = ios.filter((p) => !p.pin.input_only);
    if (ioDrivers.length > 1 && !ioDrivers.every((p) => p.pin.bus?.startsWith("i2c"))) {
      const comps = new Set(ioDrivers.map((d) => d.comp));
      if (comps.size === 1) item(c, `pinshare:${n.id}`, "warn", "Two controller pins joined", `${ioDrivers.map(who).join(" and ")} are wired together: if both are outputs at different levels they short.`, [ioDrivers[0].comp], span);
      else item(c, `contention:${n.id}`, "warn", `Two controllers drive ${netLabel(n)}`, `${ioDrivers.map(who).join(", ")}: make sure only one of them is an output.`, [...comps], span);
    }
  }
}

function busName(b: string) {
  return { i2c_sda: "the I2C data line (SDA)", i2c_scl: "the I2C clock line (SCL)", uart_tx: "serial TX", uart_rx: "serial RX", spi_mosi: "SPI MOSI", spi_miso: "SPI MISO", spi_sck: "SPI clock" }[b] ?? b;
}
function busPins(p: CatalogPart, b: string) {
  return p.pins.filter((x) => x.bus === b).map((x) => x.id);
}
function pwmPins(p: CatalogPart) {
  return p.pins.filter((x) => x.pwm).map((x) => x.id);
}

function motorChecks(c: Ctx, motorCurrent?: (comp: string) => number | undefined) {
  for (const n of c.nl.nets) {
    const motors = n.pins.filter((p) => p.pin.type === "motor");
    if (!motors.length) continue;
    const drivers = n.pins.filter((p) => p.pin.type === "motor_out");
    const span = n.spans[0];
    const bad = n.pins.filter((p) => p.pin.type === "io" || p.pin.type === "pwr_out" || p.pin.type === "pwr_rail" || p.pin.type === "gnd");
    for (const mp of motors) {
      if (!drivers.length && bad.length) {
        item(c, `direct:${mp.key}`, "fail", `${mp.comp} wired without a driver`, `${who(mp)} is connected to ${who(bad[0])}. Motors need a motor driver between them and the controller or supply.`, [mp.comp, bad[0].comp], span);
      }
    }
    for (const d of drivers) {
      const spec = d.part.specs;
      for (const mp of motors) {
        const ms = mp.part.specs;
        const istall = typeof ms.i_stall === "number" ? ms.i_stall : undefined;
        const iop = motorCurrent?.(mp.comp) ?? (typeof ms.i_free === "number" ? ms.i_free : undefined);
        const imax = d.pin.imax ?? 0;
        const ipeak = d.pin.ipeak ?? imax;
        // the driver's motor supply sets the motor voltage
        const vsup = driverSupply(c, d);
        if (iop !== undefined && iop > imax) item(c, `drv-cont:${mp.key}`, "fail", `${d.comp} too small for ${mp.comp}`, `${mp.comp} draws about ${fmtNum(iop, 1)} A at its load; ${d.part.name} is rated ${fmtNum(imax)} A continuous per channel.`, [d.comp, mp.comp], span);
        if (istall !== undefined && istall > ipeak) item(c, `drv-stall:${mp.key}`, "warn", `${mp.comp} stall current over ${d.comp}'s peak`, `${mp.comp} can draw ${fmtNum(istall, 1)} A when stalled; ${d.part.name} peaks at ${fmtNum(ipeak)} A. The firmware's stall cut-off must stop the motor quickly.`, [d.comp, mp.comp], span);
        if (vsup !== undefined && mp.pin.v !== undefined && vsup > mp.pin.v * 1.25) item(c, `motor-v:${mp.key}`, "warn", `${mp.comp} over-volted`, `${mp.comp} is a ${fmtNum(mp.pin.v)} V motor on a ${fmtNum(vsup)} V supply. Limit the PWM duty in firmware or use a lower voltage.`, [mp.comp, d.comp], span);
        if (typeof spec.v_drop === "number" && vsup !== undefined) item(c, `drop:${mp.key}`, "info", `${d.comp} loses ${fmtNum(spec.v_drop as number)} V`, `${d.part.name} drops about ${fmtNum(spec.v_drop as number)} V, so ${mp.comp} sees about ${fmtNum(vsup - (spec.v_drop as number))} V.`, [d.comp], span);
      }
    }
    // both motor terminals must go to the same driver channel
    for (const mp of motors) {
      const partner = mp.part.pins.find((p) => p.type === "motor" && p.id !== mp.pin.id && p.channel === mp.pin.channel);
      if (!partner) continue;
      const pn = c.nl.netOf.get(key(mp.comp, mp.index, partner.id));
      const d1 = drivers[0];
      const d2 = pn?.pins.find((p) => p.pin.type === "motor_out");
      if (d1 && d2 && (d1.comp !== d2.comp || d1.pin.channel !== d2.pin.channel || d1.index !== d2.index)) {
        item(c, `chan:${mp.key}`, "fail", `${mp.comp} split across driver channels`, `${who(mp)} goes to ${who(d1)} but its other terminal goes to ${who(d2)}. Both terminals belong on one channel's outputs.`, [mp.comp], span);
      }
      if (d1 && d2 && d1.key === d2.key) item(c, `chan-short:${mp.key}`, "fail", `${mp.comp} shorted`, `Both terminals of ${mp.comp} are on ${who(d1)}.`, [mp.comp], span);
    }
  }
}

/** The supply each driven motor sees: its driver's motor-supply voltage, by component name. */
export function motorSupplies(m: MachineData): Map<string, number> {
  const out = new Map<string, number>();
  if (!m.wires.length && !m.nets.length) return out;
  const c: Ctx = { nl: buildNetlist(m), out: [], m };
  for (const n of c.nl.nets) {
    const d = n.pins.find((p) => p.pin.type === "motor_out");
    const v = d && driverSupply(c, d);
    if (v === undefined) continue;
    for (const mp of n.pins) if (mp.pin.type === "motor" && !out.has(mp.comp)) out.set(mp.comp, v);
  }
  return out;
}

function driverSupply(c: Ctx, d: NetPin): number | undefined {
  // the driver's motor-supply input: the pwr_in with the widest range
  const ins = d.part.pins.filter((p) => p.type === "pwr_in").sort((a, b) => (b.vmax ?? 0) - (a.vmax ?? 0));
  for (const p of ins) {
    const n = c.nl.netOf.get(key(d.comp, d.index, p.id));
    const v = n ? netVoltage(n) : undefined;
    if (v !== undefined) return v;
  }
  return undefined;
}

function portChecks(c: Ctx) {
  for (const cab of c.nl.cables) {
    const { a, b, span } = cab;
    if (a.pin.type !== "port" || b.pin.type !== "port") {
      const odd = a.pin.type === "port" ? b : a;
      item(c, `portmix:${a.key}`, "fail", `${who(odd)} wired to a connector`, `${who(a)} and ${who(b)}: a ${a.pin.type === "port" ? a.pin.port : b.pin.port} connector must plug into a matching connector, not a single pin.`, [a.comp, b.comp], span);
      continue;
    }
    if (a.pin.port !== b.pin.port) {
      item(c, `portkind:${a.key}`, "fail", `${who(a)} does not fit ${who(b)}`, `${who(a)} is a ${a.pin.port} connector and ${who(b)} is ${b.pin.port}.`, [a.comp, b.comp], span);
      continue;
    }
    if (a.pin.side === b.pin.side) {
      item(c, `portside:${a.key}`, "fail", `${who(a)} plugged into ${who(b)}`, `Both are ${a.pin.side === "source" ? "board outputs" : "device inputs"}.`, [a.comp, b.comp], span);
      continue;
    }
    const src = a.pin.side === "source" ? a : b;
    const dev = src === a ? b : a;
    const board = src.part;
    const vBoard = boardVoltage(c, src);
    if (dev.pin.need_a !== undefined && src.pin.imax !== undefined) {
      if (src.pin.port === "stepper4") {
        if (dev.pin.need_a * 0.7 > src.pin.imax) item(c, `stepper-i:${dev.key}`, "warn", `${dev.comp} under-driven`, `${dev.part.name} is rated ${fmtNum(dev.pin.need_a)} A; ${who(src)} gives ${fmtNum(src.pin.imax)} A RMS, so it makes about ${fmtNum((src.pin.imax / dev.pin.need_a) * 100, 0)} % of its rated torque. The axis check says if that is enough.`, [dev.comp, src.comp], span);
      } else if (dev.pin.need_a > src.pin.imax) {
        item(c, `port-i:${dev.key}`, "fail", `${who(src)} overloaded`, `${dev.part.name} needs ${fmtNum(dev.pin.need_a)} A; ${who(src)} gives ${fmtNum(src.pin.imax)} A.`, [dev.comp, src.comp], span);
      }
    }
    if (dev.pin.need_w !== undefined && src.pin.imax !== undefined && vBoard !== undefined) {
      const amps = dev.pin.need_w / (dev.pin.v ?? vBoard);
      const realW = dev.pin.v ? dev.pin.need_w * (vBoard / dev.pin.v) ** 2 : dev.pin.need_w;
      const realA = realW / vBoard;
      if (realA > src.pin.imax) item(c, `heater-i:${dev.key}`, "fail", `${who(src)} overloaded by ${dev.comp}`, `${dev.part.name} draws about ${fmtNum(realA, 1)} A at ${fmtNum(vBoard)} V; ${board.name} ${src.pin.label ?? src.pin.id} is rated ${fmtNum(src.pin.imax)} A.`, [dev.comp, src.comp], span);
      else if (realA > src.pin.imax * 0.85) item(c, `heater-close:${dev.key}`, "warn", `${who(src)} near its limit`, `${dev.part.name} draws about ${fmtNum(realA, 1)} A of the ${fmtNum(src.pin.imax)} A rating. Measure the heater resistance before the first heat-up.`, [dev.comp, src.comp], span);
      void amps;
    }
    if (dev.pin.v !== undefined && vBoard !== undefined && (src.pin.port === "heater2" || src.pin.port === "fan2") && Math.abs(dev.pin.v - vBoard) > dev.pin.v * 0.15) {
      item(c, `port-v:${dev.key}`, "fail", `${dev.comp} is a ${fmtNum(dev.pin.v)} V part on a ${fmtNum(vBoard)} V board`, `${who(src)} switches the board's ${fmtNum(vBoard)} V supply. Use a ${fmtNum(vBoard)} V ${dev.part.kind === "fan" ? "fan" : "heater"}.`, [dev.comp, src.comp], span);
    }
  }
}

function boardVoltage(c: Ctx, p: NetPin): number | undefined {
  for (const pin of p.part.pins) {
    if (pin.type !== "pwr_in") continue;
    const n = c.nl.netOf.get(key(p.comp, p.index, pin.id));
    const v = n ? netVoltage(n) : undefined;
    if (v !== undefined) return v;
  }
  return undefined;
}

function groundChecks(c: Ctx) {
  // all ground pins of one part are joined inside it
  const uf = new UF();
  for (const [comp, pins] of c.nl.pinsOf) {
    const gnets = pins.filter((p) => p.pin.type === "gnd").map((p) => c.nl.netOf.get(p.key)).filter((n): n is Net => !!n);
    for (let i = 1; i < gnets.length; i++) uf.union(`net${gnets[0].id}`, `net${gnets[i].id}`);
    void comp;
  }
  const gndGroup = (comp: string, index: number): Set<string> => {
    const out = new Set<string>();
    for (const p of c.nl.pinsOf.get(comp) ?? []) {
      if (p.index !== index || p.pin.type !== "gnd") continue;
      const n = c.nl.netOf.get(p.key);
      if (n) out.add(uf.find(`net${n.id}`));
    }
    return out;
  };
  const reported = new Set<string>();
  for (const n of c.nl.nets) {
    const logic = n.pins.filter((p) => ["io", "in", "out", "analog_out"].includes(p.pin.type));
    if (logic.length < 2) continue;
    const comps = [...new Map(logic.map((p) => [`${p.comp}[${p.index}]`, p])).values()];
    const base = gndGroup(comps[0].comp, comps[0].index);
    for (const p of comps.slice(1)) {
      const g = gndGroup(p.comp, p.index);
      const shared = [...g].some((x) => base.has(x));
      const k = [comps[0].comp, p.comp].sort().join("|");
      if (!shared && !reported.has(k)) {
        reported.add(k);
        item(c, `gnd:${k}`, "fail", `No common ground: ${comps[0].comp} and ${p.comp}`, `${comps[0].comp} and ${p.comp} exchange signals but their grounds are not connected. Signals are measured against ground, so join a GND pin of each.`, [comps[0].comp, p.comp], n.spans[0]);
      }
    }
  }
}

function unconnected(c: Ctx) {
  const used = new Set<string>();
  for (const n of c.nl.nets) for (const p of n.pins) used.add(p.key);
  for (const cab of c.nl.cables) {
    used.add(cab.a.key);
    used.add(cab.b.key);
  }
  for (const [comp, pins] of c.nl.pinsOf) {
    const anyUsed = pins.some((p) => used.has(p.key));
    const mc = pins[0]?.mc;
    for (const p of pins) {
      if (!p.pin.required || used.has(p.key)) continue;
      // a pin whose sibling of the same kind is used counts (e.g. one of two GND pins)
      if (p.pin.type === "gnd" && pins.some((q) => q.index === p.index && q.pin.type === "gnd" && used.has(q.key))) continue;
      item(c, `nc:${p.key}`, anyUsed ? "fail" : "warn", `${who(p)} not connected`, anyUsed ? `${p.part.name} needs ${p.pin.label ?? p.pin.id} connected${p.pin.note ? ` (${p.pin.note})` : ""}.` : `${p.part.name} is not wired at all.`, [comp], mc?.span);
      if (!anyUsed) break;
    }
  }
}

function protection(c: Ctx) {
  const batteries = c.m.components.filter((x) => catalogPart(x.catalogId)?.kind === "battery");
  for (const b of batteries) {
    const pos = c.nl.netOf.get(key(b.name, 0, "POS"));
    if (!pos) continue;
    const fused = pos.pins.some((p) => p.part.kind === "fuse");
    const switched = pos.pins.some((p) => p.part.kind === "switch" || p.part.kind === "connector");
    if (!fused) item(c, `fuse:${b.name}`, "warn", `No fuse on ${b.name}`, `A LiPo can deliver over 100 A into a short. Put a fuse on the positive lead right at the battery.`, [b.name], b.span);
    if (!switched) item(c, `switch:${b.name}`, "info", `No power switch on ${b.name}`, "Add a switch, or a connector on the positive lead that works as a removable link, so the machine can be turned off quickly.", [b.name], b.span);
  }
  for (const p of c.m.components.filter((x) => catalogPart(x.catalogId)?.kind === "psu")) {
    // a sealed plug-in adapter keeps the mains outside the build
    if (catalogPart(p.catalogId)?.external) item(c, `mains:${p.name}`, "pass", `${p.name} keeps mains outside`, "A sealed plug-in adapter: only low voltage comes into the build, so there is no mains wiring to check.", [p.name], p.span);
    else item(c, `mains:${p.name}`, "info", `${p.name} runs from mains`, "Mains wiring: use a fused, switched IEC inlet, earth the frame and the supply, and cover the terminals. Have someone qualified check it.", [p.name], p.span);
  }
}

/**
 * What each net and each powered pin carries: the current budget behind the supply and wire checks. With
 * `peak`, motors and servos draw what they do starting or blocked (`motorCurrent` then gives stall currents),
 * and the parts that do are added to `surging`.
 */
function loadModel(c: Ctx, motorCurrent?: (comp: string) => number | undefined, peak = false, surging?: Set<string>) {
  // a servo or actuator powered straight from a supply draws its stall current as it starts
  const drawOf = (p: NetPin): number => {
    const run = p.pin.draw ?? 0;
    const stall = p.part.specs.i_stall;
    // (a gearmotor's power pins feed its encoder: its motor current comes through its driver)
    if (!peak || p.pin.type !== "pwr_in" || typeof stall !== "number" || stall <= run || !STARTS_HARD.has(p.part.kind) || p.part.pins.some((q) => q.type === "motor")) return run;
    surging?.add(p.comp);
    return stall;
  };
  const memo = new Map<number, number>();
  const visiting = new Set<number>();
  // current drawn out of a net by everything connected to it
  const load = (n: Net): number => {
    if (memo.has(n.id)) return memo.get(n.id)!;
    if (visiting.has(n.id)) return 0;
    visiting.add(n.id);
    let a = 0;
    const hasSupply = supplies(n).length > 0;
    for (const p of n.pins) {
      if (p.pin.type === "pwr_in" || (p.pin.type === "pwr_rail" && hasSupply)) {
        a += drawOf(p);
        a += downstream(p);
      }
    }
    visiting.delete(n.id);
    memo.set(n.id, a);
    return a;
  };
  // A chopper driver draws the coil losses and the mechanical output from the supply, not the phase
  // current: about 2·I²·R for both phases, doubled for the work done at speed, over the supply voltage.
  // Ports that share a step pin (Z A/B headers in parallel) split one driver's current: count them once.
  const counted = new Set<string>();
  const stepperSupply = (q: NetPin, dev: NetPin, vin: number | undefined): number => {
    const step = /step=([^,]+)/.exec(q.pin.mcu ?? "")?.[1];
    if (step) {
      const k = `${q.comp}[${q.index}]:${step}`;
      if (counted.has(k)) return 0;
      counted.add(k);
    }
    const i = Math.min(dev.pin.need_a!, q.pin.imax ?? dev.pin.need_a!);
    const r = Number(dev.part.specs.r_phase ?? 0);
    return r > 0 && vin ? (4 * i * i * r) / (vin * 0.85) : i * 0.7;
  };
  // what a powered part passes on: its outputs and rails (linear or switching), and motors through drivers
  const downstream = (p: NetPin): number => {
    let a = 0;
    const siblings = c.nl.pinsOf.get(p.comp)?.filter((q) => q.index === p.index) ?? [];
    const vin = p.pin.type === "pwr_in" ? netVoltage(c.nl.netOf.get(p.key)!) : p.pin.v;
    const ins = siblings.filter((q) => q.pin.type === "pwr_in");
    // only the widest-range power input carries the downstream load
    const main = [...ins].sort((x, y) => (y.pin.vmax ?? 0) - (x.pin.vmax ?? 0))[0];
    if (p.pin.type === "pwr_in" && main && main.key !== p.key) return 0;
    for (const q of siblings) {
      if (q.key === p.key) continue;
      if ((q.pin.type === "pwr_out" || q.pin.type === "pwr_rail") && !(q.pin.type === "pwr_rail" && supplies(c.nl.netOf.get(q.key) ?? { pins: [] } as unknown as Net).length)) {
        const n = c.nl.netOf.get(q.key);
        if (!n) continue;
        const iout = load(n);
        const switching = p.part.kind === "regulator" && !/linear/i.test(p.part.summary);
        a += switching && vin ? (iout * (q.pin.v ?? vin)) / (vin * 0.85) : iout;
      }
      if (q.pin.type === "motor_out") {
        const n = c.nl.netOf.get(q.key);
        for (const mp of n?.pins.filter((x) => x.pin.type === "motor" && x.pin.id === "M_PLUS") ?? []) {
          a += motorCurrent?.(mp.comp) ?? Number((peak ? mp.part.specs.i_stall : undefined) ?? mp.part.specs.i_free ?? 0.2);
          if (peak) surging?.add(mp.comp);
        }
      }
      if (q.pin.type === "port" && q.pin.side === "source") {
        const cab = c.nl.cables.find((x) => x.a.key === q.key || x.b.key === q.key);
        const dev = cab ? (cab.a.key === q.key ? cab.b : cab.a) : undefined;
        if (dev?.pin.need_a) a += q.pin.port === "stepper4" ? stepperSupply(q, dev, vin) : dev.pin.need_a;
        if (dev?.pin.need_w && vin) a += dev.pin.need_w * (dev.pin.v ? (vin / dev.pin.v) ** 2 : 1) / vin;
      }
    }
    return a;
  };
  return { load, downstream };
}

/** Parts that draw their stall current from the supply each time they start. */
const STARTS_HARD = new Set(["servo", "actuator", "gearmotor", "bldc"]);
const CONTROLLERS = new Set(["controller", "host"]);
const listOf = (xs: string[]) => {
  const a = [...new Set(xs)];
  return a.length <= 3 ? a.join(", ").replace(/, ([^,]*)$/, " and $1") : `${a.slice(0, 3).join(", ")} and ${a.length - 3} more`;
};

/**
 * Motors and servos draw their stall current for a moment every time they start, and all the time they are
 * blocked. A supply sized for their running current then sags: a controller's own regulator browns out and
 * resets the board, and a supply's over-current protection cuts out.
 */
function surge(c: Ctx, motorCurrent?: (comp: string) => number | undefined, motorStall?: (comp: string) => number | undefined) {
  const run = loadModel(c, motorCurrent);
  for (const n of c.nl.nets) {
    const src = sourcesOf(n)[0];
    if (!src || src.pin.imax === undefined) continue;
    if (src.pin.type === "pwr_rail" && supplies(n).length) continue;
    // a model of its own per net, so the parts that surge are the ones behind this supply
    const surging = new Set<string>();
    const pk = loadModel(c, motorStall, true, surging).load(n);
    const a = run.load(n);
    if (pk <= src.pin.imax || pk < a + 0.1 || !surging.size) continue;
    const onBoard = CONTROLLERS.has(src.part.kind);
    const movers = listOf([...surging]);
    const need = Math.ceil(pk);
    item(
      c,
      `surge:${n.id}`,
      onBoard ? "fail" : "warn",
      `${movers} ${surging.size === 1 ? "pulls" : "pull"} ${who(src)} down as ${surging.size === 1 ? "it starts" : "they start"}`,
      `Starting or blocked, ${movers} ${surging.size === 1 ? "draws" : "draw"} about ${fmtNum(pk, 1)} A from ${who(src)}, which gives ${fmtNum(src.pin.imax)} A (about ${fmtNum(a, 2)} A while running). ${onBoard ? `That is the board's own regulator: it sags and ${src.comp} resets every time ${surging.size === 1 ? "it starts" : "they start"}, and it can overheat.` : "The supply sags or its over-current protection cuts out, and a sag can reset the controller."}`,
      [src.comp, ...surging],
      n.spans[0],
      onBoard
        ? `Power ${movers} from a supply of ${surging.size === 1 ? "its" : "their"} own (a 5 to 6 V BEC or buck converter rated for ${need} A or more, fed from the battery or main supply), join its ground to ${src.comp}'s GND, and keep only the signal wires on ${src.comp}.`
        : `Use a supply rated for at least ${need} A, or start the motors one at a time and ramp their PWM up over a few hundred milliseconds in firmware, and give the controller its own regulator so a sag cannot reset it.`,
    );
  }
}

/** The controller pins no net uses yet, of the kind a signal needs, for fix messages. */
function freePins(c: Ctx, ctrl: NetPin, pwm: boolean): string[] {
  const used = new Set((c.nl.pinsOf.get(ctrl.comp) ?? []).filter((p) => p.index === ctrl.index && (c.nl.netOf.has(p.key) || c.nl.cables.some((x) => x.a.key === p.key || x.b.key === p.key))).map((p) => p.pin.id));
  return ctrl.part.pins.filter((p) => p.type === "io" && !p.input_only && !used.has(p.id) && !p.bus && (!pwm || p.pwm) && !/strapping|USB serial/i.test(p.note ?? "")).map((p) => p.id);
}

/**
 * One controller pin wired to two modules' signals: almost always a pin number used twice. A module's output
 * then drives the other module's input directly, and two inputs on one pin always get the same signal.
 * Shared buses (I2C, SPI, serial) and a line every module takes on the same pin name (a common enable) are
 * meant to be shared.
 */
function sharedPins(c: Ctx) {
  for (const n of c.nl.nets) {
    const ctrl = n.pins.find((p) => p.pin.type === "io" && CONTROLLERS.has(p.part.kind));
    if (!ctrl) continue;
    const sig = n.pins.filter((p) => !CONTROLLERS.has(p.part.kind) && !p.pin.bus && (p.pin.type === "in" || p.pin.type === "out" || p.pin.type === "analog_out"));
    if (new Set(sig.map((p) => `${p.comp}[${p.index}]`)).size < 2) continue;
    const pin = who(ctrl);
    const span = n.spans[0];
    const drivers = sig.filter((p) => p.pin.type !== "in");
    const inputs = sig.filter((p) => p.pin.type === "in");
    const driven = inputs.find((i) => drivers.some((d) => d.comp !== i.comp || d.index !== i.index));
    if (drivers.length && driven) {
      const d = drivers.find((x) => x.comp !== driven.comp || x.index !== driven.index)!;
      const free = freePins(c, ctrl, driven.pin.needs === "pwm");
      item(
        c,
        `twice:${n.id}`,
        "fail",
        `${pin} is used for two signals`,
        `${who(d)} and ${who(driven)} are both wired to ${pin}: ${d.comp}'s output drives ${driven.comp}'s input directly, and the firmware cannot work ${driven.comp} on its own.`,
        [ctrl.comp, d.comp, driven.comp],
        span,
        `Give ${who(driven)} a pin of its own on ${ctrl.comp}${free.length ? ` (free${driven.pin.needs === "pwm" ? " PWM" : ""} pins: ${free.slice(0, 5).join(", ")})` : ""} and change its wire.`,
      );
      continue;
    }
    if (inputs.length >= 2 && new Set(inputs.map((p) => p.pin.id)).size > 1) {
      const free = freePins(c, ctrl, inputs.some((p) => p.pin.needs === "pwm"));
      item(
        c,
        `twice:${n.id}`,
        "warn",
        `${pin} drives ${listOf(inputs.map(who))}`,
        `${listOf(inputs.map(who))} all take their signal from ${pin}, so they always get the same one. That is right only for a line they must share; otherwise a pin number was used twice.`,
        [ctrl.comp, ...inputs.map((p) => p.comp)],
        span,
        `Unless they must always switch together, give each its own pin on ${ctrl.comp}${free.length ? ` (free pins: ${free.slice(0, 5).join(", ")})` : ""}.`,
      );
    }
  }
}

/** Two devices answering at the same address on one I2C bus: the controller cannot tell them apart. */
function i2cAddresses(c: Ctx) {
  for (const n of c.nl.nets) {
    const byAddr = new Map<string, NetPin[]>();
    for (const p of n.pins) {
      const addr = p.part.specs.i2c_addr;
      if (p.pin.bus !== "i2c_sda" || CONTROLLERS.has(p.part.kind) || addr === undefined) continue;
      const k = String(addr).toLowerCase();
      byAddr.set(k, [...(byAddr.get(k) ?? []), p]);
    }
    for (const [addr, ds] of byAddr) {
      if (ds.length < 2) continue;
      item(
        c,
        `i2c-addr:${n.id}:${addr}`,
        "fail",
        `Two I2C devices at address ${addr}`,
        `${listOf(ds.map(who))} share ${netLabel(n)} and all answer at ${addr}, so the controller cannot tell them apart and reads come back garbled.`,
        ds.map((p) => p.comp),
        n.spans[0],
        "Put one on the controller's second I2C bus if it has one, use a module whose address can be changed (an address pin or jumper) and set it to another address, or add an I2C multiplexer (TCA9548A) between them.",
      );
    }
  }
}

/**
 * Current out of each part's supply outputs (A) and the volts on its main
 * power input, by component name and instance, from the same budget as the
 * supply and wire checks (for heat: what regulators, supplies and batteries pass).
 */
export function supplyFacts(m: MachineData, motorCurrent?: (comp: string) => number | undefined): { out: (comp: string, index?: number) => number; vin: (comp: string, index?: number) => number | undefined } {
  const c: Ctx = { nl: buildNetlist(m), out: [], m };
  const { load } = loadModel(c, motorCurrent);
  const pins = (comp: string, index: number) => (c.nl.pinsOf.get(comp) ?? []).filter((p) => p.index === index);
  return {
    out: (comp, index = 0) => {
      const seen = new Set<number>();
      let a = 0;
      for (const p of pins(comp, index)) {
        const n = p.pin.type === "pwr_out" ? c.nl.netOf.get(p.key) : undefined;
        if (!n || seen.has(n.id)) continue;
        seen.add(n.id);
        a += load(n);
      }
      return a;
    },
    vin: (comp, index = 0) => {
      const main = pins(comp, index).filter((p) => p.pin.type === "pwr_in").sort((x, y) => (y.pin.vmax ?? 0) - (x.pin.vmax ?? 0))[0];
      const n = main && c.nl.netOf.get(main.key);
      return n ? netVoltage(n) : undefined;
    },
  };
}

function budget(c: Ctx, motorCurrent?: (comp: string) => number | undefined) {
  const { load, downstream } = loadModel(c, motorCurrent);
  for (const n of c.nl.nets) {
    const src = sourcesOf(n)[0];
    if (!src || src.pin.imax === undefined) continue;
    if (src.pin.type === "pwr_rail" && supplies(n).length) continue;
    const a = load(n);
    if (a <= 0) continue;
    const pct = a / src.pin.imax;
    const name = netLabel(n);
    if (pct > 1) item(c, `budget:${n.id}`, "fail", `${who(src)} overloaded`, `Everything on ${name} draws about ${fmtNum(a, 2)} A; ${src.part.name} supplies ${fmtNum(src.pin.imax)} A.`, [src.comp], n.spans[0], `Move the heavy loads (motors, servos, heaters, LED strips) to a supply of their own rated for at least ${fmtNum(Math.ceil(a * 1.25))} A, with its ground joined to this one, or use a bigger supply here.`);
    else item(c, `budget:${n.id}`, pct > 0.8 ? "warn" : "pass", `Power budget: ${name}`, `About ${fmtNum(a, 2)} A of ${fmtNum(src.pin.imax)} A available from ${who(src)} (${fmtNum(pct * 100, 0)} %).`, [src.comp], n.spans[0]);
  }
  wireChecks(c, load, downstream, motorCurrent);
}

const isSupplyPart = (p: NetPin) => p.part.kind === "battery" || p.part.kind === "psu";
const segName = (sg: NetSeg) => (sg.label && !sg.bus ? sg.label : `${sg.label ? `${sg.label}: ` : ""}${who(sg.a)} → ${who(sg.b)}`);

/**
 * Every wire run against the current it carries, and every fuse against the wires it protects. Power,
 * motor and ground nets each have a source side (the supply, the driver output, the battery's negative);
 * a run carries what is on its far side. A `net` statement is a bus: each of its runs carries the bus total.
 */
function wireChecks(c: Ctx, load: (n: Net) => number, downstream: (p: NetPin) => number, motorCurrent?: (comp: string) => number | undefined) {
  // a motor lead carries the motor's working current, and at least what it can draw continuously (half stall)
  const leadA = (mp: NetPin) => Math.max(motorCurrent?.(mp.comp) ?? Number(mp.part.specs.i_free ?? 0.2), 0.5 * Number(mp.part.specs.i_stall ?? 0));
  const wired = (p: NetPin) => c.nl.netOf.has(p.key);
  const siblings = (p: NetPin) => (c.nl.pinsOf.get(p.comp) ?? []).filter((q) => q.index === p.index);
  // what a part draws from its supplies, which its power ground returns
  const supplyOf = (p: NetPin) =>
    siblings(p)
      .filter((q) => wired(q) && (q.pin.type === "pwr_in" || (q.pin.type === "pwr_rail" && supplies(c.nl.netOf.get(q.key)!).length > 0)))
      .reduce((a, q) => a + (q.pin.draw ?? 0) + downstream(q), 0);
  // a part with several grounds returns its supply current through its power ground (GND_PWR, V−), else its first
  const powerGround = (p: NetPin) => {
    const gs = siblings(p).filter((q) => q.pin.type === "gnd" && wired(q));
    return gs.find((q) => /pwr|power|minus|neg|mot/i.test(`${q.pin.id} ${q.pin.label ?? ""}`)) ?? gs[0];
  };
  const pinLoad = (p: NetPin, n: Net): number => {
    switch (p.pin.type) {
      case "pwr_in":
        return (p.pin.draw ?? 0) + downstream(p);
      case "pwr_rail":
        return supplies(n).length ? (p.pin.draw ?? 0) + downstream(p) : 0;
      case "motor":
        return leadA(p);
      case "gnd":
        return !isSupplyPart(p) && powerGround(p)?.key === p.key ? supplyOf(p) : 0;
      default:
        return 0;
    }
  };
  const sourcesFor = (n: Net): NetPin[] => {
    const s = sourcesOf(n);
    if (s.length) return s;
    const outs = n.pins.filter((p) => p.pin.type === "motor_out");
    if (outs.length) return outs;
    return n.pins.filter((p) => p.pin.type === "gnd" && isSupplyPart(p));
  };
  // pins joined through a fuse, switch or mated connector
  const links = (n: Net) =>
    n.pins.flatMap((p) => {
      if (p.pin.type !== "passive" || !p.pin.through) return [];
      const o = c.nl.netOf.get(key(p.comp, p.index, p.pin.through)) === n ? n.pins.find((q) => q.comp === p.comp && q.index === p.index && q.pin.id === p.pin.through) : undefined;
      return o && p.key < o.key ? [{ a: p, b: o }] : [];
    });
  // pins reached from `from` without crossing the skipped run or link
  const reach = (n: Net, from: NetPin[], skip?: { a: NetPin; b: NetPin }) => {
    const same = (e: { a: NetPin; b: NetPin }) => !!skip && e.a.key === skip.a.key && e.b.key === skip.b.key;
    const edges = [...n.segs, ...links(n)].filter((e) => e !== skip && !same(e));
    const seen = new Set(from.map((p) => p.key));
    const todo = [...from];
    while (todo.length) {
      const p = todo.pop()!;
      for (const e of edges) {
        const q = e.a.key === p.key ? e.b : e.b.key === p.key ? e.a : undefined;
        if (q && !seen.has(q.key)) {
          seen.add(q.key);
          todo.push(q);
        }
      }
    }
    return seen;
  };

  for (const n of c.nl.nets) {
    const src = sourcesFor(n);
    if (!src.length) continue;
    const isPower = sourcesOf(n).length > 0;
    const total = isPower ? load(n) : n.pins.reduce((a, p) => a + pinLoad(p, n), 0);
    const srcKeys = new Set(src.map((p) => p.key));
    const busA = new Map<number, number>();
    const current = (sg: NetSeg): number => {
      if (sg.bus !== undefined) {
        if (!busA.has(sg.bus)) {
          const pins = n.segs.filter((x) => x.bus === sg.bus).flatMap((x) => [x.a, x.b]);
          const uniq = [...new Map(pins.map((p) => [p.key, p])).values()];
          busA.set(sg.bus, Math.min(total, uniq.filter((p) => !srcKeys.has(p.key)).reduce((a, p) => a + pinLoad(p, n), 0)));
        }
        return busA.get(sg.bus)!;
      }
      const near = reach(n, src, sg);
      const far = n.pins.filter((p) => !near.has(p.key));
      // in a loop (or with sources on both sides) the run could carry it all
      if (!far.length || far.some((p) => srcKeys.has(p.key))) return total;
      return far.reduce((a, p) => a + pinLoad(p, n), 0);
    };
    let unsized = 0;
    n.segs.forEach((sg, i) => {
      const a = current(sg);
      if (sg.gauge === undefined) {
        if (a > 3) unsized = Math.max(unsized, a);
        return;
      }
      const amp = awgAmpacity(sg.gauge);
      if (a > amp) item(c, `gauge:${n.id}:${i}`, "fail", `${segName(sg)}: wire too thin`, `${fmtNum(sg.gauge)} AWG carries about ${fmtNum(amp)} A; this run carries about ${fmtNum(a, 1)} A${n.pins.some((p) => p.pin.type === "gnd") ? " (the ground return carries what the parts on it draw)" : ""}. Use thicker wire.`, [sg.a.comp, sg.b.comp], sg.span);
    });
    if (unsized) item(c, `gauge:${n.id}`, "warn", `Wire size for ${netLabel(n)}`, `This net carries about ${fmtNum(unsized, 1)} A: give its wires a gauge (gauge: 16) so the parts list and wiring diagram say what wire to use.`, [src[0].comp], n.spans[0]);
  }

  // a fuse must blow before the thinnest wire after it overheats, and must not blow in normal use
  for (const f of c.m.components.filter((x) => catalogPart(x.catalogId)?.kind === "fuse")) {
    const part = catalogPart(f.catalogId)!;
    const rating = f.rating ?? Number(part.specs.rating_a ?? 0);
    for (let i = 0; i < f.count; i++) {
      const pins = c.nl.pinsOf.get(f.name)?.filter((p) => p.index === i && p.pin.type === "passive" && p.pin.through) ?? [];
      const n = pins[0] && c.nl.netOf.get(pins[0].key);
      if (!n || pins.length < 2 || !rating) continue;
      const link = links(n).find((l) => l.a.comp === f.name && l.a.index === i);
      const src = sourcesFor(n);
      const fromSrc = reach(n, src, link);
      // the side the supply doesn't reach without going through the fuse is what it protects
      const out = pins.find((p) => !fromSrc.has(p.key)) ?? pins.find((p) => p.pin.id === "OUT") ?? pins[1];
      const side = reach(n, [out], link);
      const after = n.segs.filter((sg) => side.has(sg.a.key) && side.has(sg.b.key) && sg.gauge !== undefined);
      const fname = `${f.name}${f.count > 1 ? `[${i}]` : ""}`;
      const thinnest = after.sort((x, y) => y.gauge! - x.gauge!)[0];
      const through = n.pins.filter((p) => side.has(p.key)).reduce((a, p) => a + pinLoad(p, n), 0);
      if (thinnest && rating > awgAmpacity(thinnest.gauge!)) {
        const amp = awgAmpacity(thinnest.gauge!);
        item(c, `fuse-wire:${fname}`, "fail", `${fname} too big for its wires`, `The ${fmtNum(rating)} A fuse protects ${segName(thinnest)}, ${fmtNum(thinnest.gauge!)} AWG, which carries about ${fmtNum(amp)} A: a short or a stall could overheat that wire without blowing the fuse. Use a fuse of ${fmtNum(amp)} A or less (rating: ${fmtNum(amp)}A), or thicker wire.`, [f.name, thinnest.a.comp, thinnest.b.comp], f.span);
      } else if (thinnest) {
        item(c, `fuse-wire:${fname}`, "pass", `${fname} sized to its wires`, `The ${fmtNum(rating)} A fuse is no more than the thinnest wire after it can carry (${fmtNum(thinnest.gauge!)} AWG, about ${fmtNum(awgAmpacity(thinnest.gauge!))} A).`, [f.name], f.span);
      }
      // blade fuses carry 110 % of their rating for 100 hours (SAE J1284) and lose a little in a warm box
      if (through > rating) item(c, `fuse-load:${fname}`, "fail", `${fname} blows in normal use`, `About ${fmtNum(through, 1)} A flows through the ${fmtNum(rating)} A fuse when everything runs.`, [f.name], f.span);
      else if (through > rating * 0.9) item(c, `fuse-load:${fname}`, "warn", `${fname} close to its rating`, `About ${fmtNum(through, 1)} A flows through the ${fmtNum(rating)} A fuse when everything runs: in a warm box it may blow on a long run.`, [f.name], f.span);
    }
  }
}
