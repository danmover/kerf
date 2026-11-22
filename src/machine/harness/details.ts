// Everything the cable card says about one cable of the harness: where each
// end goes (part, pin, connector, which contact of the housing, what the
// other contacts carry), which way its plug goes in and what holds it, how
// to make the end, the firmware pin at a controller, what the cable carries
// (signal kind, volts, and the current it carries against what its gauge is
// rated for), and its length. Currents come from the same load model as the
// wire-size checks: a run carries what is on its far side from the supply.

import type { Span } from "../../lang/ast";
import { awgAmpacity } from "../calcs";
import { catalogPart } from "../catalog";
import { motorCurrentFor } from "../checks";
import { currentModel, type Net, type NetPin } from "../erc";
import type { BusKind, MachineData, PinDef } from "../types";
import { cutLength, type WireEnd, type WireKind, type WireRow } from "../wiring";
import type { Harness, HarnessWire, PlugEnd } from "./harness";
import { PITCH, PLUG_NAME, type PlugKind } from "./plugs";
import { plugGuide, type PlugGuide } from "./plugGuide";

export interface Contact {
  /** 0 is pin 1 */
  slot: number;
  /** what is wired there: the pin at this end, or the conductor's colour in a cable */
  label: string;
  /** the cable in it, if any */
  wire?: string;
  /** wire colour (hex) */
  color?: string;
  /** this cable's own wire */
  mine: boolean;
}

export interface EndDetails {
  comp: string;
  pin: string;
  label: string;
  part: string;
  partId: string;
  kind: PlugKind;
  /** "JST XH 2.5 mm, 4-way" */
  connector: string;
  ways: number;
  pitch: number;
  /** every contact of the housing, pin 1 first */
  contacts: Contact[];
  /** which way the plug goes in, in the design's own directions: "from above", "from the front" */
  approach: string;
  /** the side the latch is on, for housings with one */
  latch?: string;
  guide: PlugGuide;
  /** the name the firmware uses for the pin, at a controller or host */
  firmware?: string;
  /** what the pin is: "PWM output", "5 V supply", "ground" */
  role: string;
}

export interface CableDetails {
  id: string;
  title: string;
  /** what it carries, for colours and filters: a connector cable by what runs down it (see carriesOf) */
  kind: WireKind;
  net: string;
  /** what the cable carries, in words: "PWM", "I²C data (SDA)", "12 V power", "stepper phases" */
  signal: string;
  volts?: number;
  /** current it carries in normal running, A */
  amps?: number;
  /** what a heater or other device on it takes, W */
  watts?: number;
  /** what its gauge carries, A */
  rating?: number;
  gauge?: number;
  gaugeSuggested: boolean;
  color: string;
  insulation?: string;
  /** conductors, in contact order */
  wires: { name: string; color: string }[];
  /** cut length, mm, and the run along the route plug to plug */
  cut?: number;
  run?: number;
  /** the cut length is from the parts' positions, not the routed cable */
  estimated: boolean;
  /** the part's own lead or a bought cable it runs in */
  lead?: string;
  ties: number;
  ends: [EndDetails, EndDetails];
  /** how to make it, step by step */
  steps: string[];
  /** the wire or net statement it comes from */
  span?: Span;
}

const BUS: Record<BusKind, string> = {
  i2c_sda: "I²C data (SDA)",
  i2c_scl: "I²C clock (SCL)",
  uart_tx: "serial (UART TX)",
  uart_rx: "serial (UART RX)",
  spi_mosi: "SPI data out (MOSI)",
  spi_miso: "SPI data in (MISO)",
  spi_sck: "SPI clock (SCK)",
};

const PORT: Record<string, string> = {
  stepper4: "stepper motor phases",
  fan2: "fan power",
  fan3: "fan power and speed",
  heater2: "heater power",
  therm2: "thermistor (temperature)",
  endstop3: "endstop switch",
  probe5: "bed probe",
};

const bare = (comp: string) => comp.replace(/\[\d+\]$/, "");
const pinKey = (e: WireEnd) => `${bare(e.comp)}[${e.index}].${e.pin}`;

function pinDef(m: MachineData, e: { comp: string; pin: string }): PinDef | undefined {
  const mc = m.components.find((c) => c.name === bare(e.comp));
  return mc ? catalogPart(mc.catalogId)?.pins.find((p) => p.id === e.pin) : undefined;
}

const fmt = (v: number, d = 1) => (Math.abs(v - Math.round(v)) < 1e-6 ? String(Math.round(v)) : v.toFixed(d).replace(/\.0+$/, ""));

/** What a pin is, in a few words. */
function roleOf(p: PinDef | undefined): string {
  if (!p) return "pin";
  switch (p.type) {
    case "gnd":
      return "ground";
    case "pwr_in":
      return p.vmin !== undefined && p.vmax !== undefined ? `power in (${fmt(p.vmin)}–${fmt(p.vmax)} V)` : "power in";
    case "pwr_out":
      return p.v !== undefined ? `${fmt(p.v)} V supply${p.imax ? `, ${fmt(p.imax)} A` : ""}` : "supply";
    case "pwr_rail":
      return p.v !== undefined ? `${fmt(p.v)} V rail` : "rail";
    case "io":
      return p.bus ? BUS[p.bus] : `${p.pwm ? "PWM-capable " : ""}${p.adc ? "analog-capable " : ""}I/O${p.v ? ` (${fmt(p.v)} V logic)` : ""}`;
    case "in":
      return p.bus ? BUS[p.bus] : p.needs === "pwm" ? "PWM input" : "logic input";
    case "out":
      return p.bus ? BUS[p.bus] : `logic output${p.v ? ` (${fmt(p.v)} V)` : ""}`;
    case "analog_out":
      return "analog output";
    case "motor_out":
      return `motor output${p.imax ? `, ${fmt(p.imax)} A` : ""}`;
    case "motor":
      return "motor terminal";
    case "passive":
      return p.through ? "switch or fuse contact" : "contact";
    case "port":
      return p.port ? (PORT[p.port] ?? `${p.port} port`) : "port";
    case "term":
      return "terminal";
  }
}

/**
 * What a cable carries, for colouring and filtering the harness. A wire is classed by its net already; a
 * cable between connector ports (stepper, fan, heater, thermistor, endstop, probe, USB) by what runs down it,
 * so a stepper cable reads as motor current and a heater lead as power.
 */
export function carriesOf(r: WireRow): WireKind {
  if (r.kind !== "cable") return r.kind;
  const c = r.cable ?? "";
  if (/stepper|motor/i.test(c)) return "motor";
  if (/heater|fan|power/i.test(c)) return "power";
  if (/thermistor|endstop|probe|usb|sensor|signal/i.test(c)) return "signal";
  return "cable";
}

/** What runs down the cable, in words. */
function signalOf(r: WireRow, a?: PinDef, b?: PinDef, volts?: number): string {
  if (r.cable || a?.port || b?.port) {
    const port = a?.port ?? b?.port;
    return (port && PORT[port]) ?? r.cable ?? "cable";
  }
  if (r.kind === "ground") return "ground return";
  if (r.kind === "power") return volts !== undefined ? `${fmt(volts)} V power` : "power";
  if (r.kind === "motor") return "motor current";
  const bus = a?.bus ?? b?.bus;
  if (bus) return BUS[bus];
  if (a?.type === "analog_out" || b?.type === "analog_out") return "analog signal";
  if (a?.needs === "pwm" || b?.needs === "pwm") return "PWM signal";
  if (a?.needs === "irq" || b?.needs === "irq") return "encoder or pulse signal (interrupt pin)";
  if (a?.type === "term" || b?.type === "term") return "audio or analog signal";
  const lv = a?.v ?? b?.v;
  return lv ? `${fmt(lv)} V logic signal` : "logic signal";
}

/** A pin's firmware name as written in the catalog ("step=PB13,dir=!PB12", "^PC0") in words. */
export function firmwareText(mcu: string): string {
  const one = (v: string) => {
    const flags: string[] = [];
    let t = v.trim();
    while (/^[!^~]/.test(t)) {
      flags.push(t[0] === "!" ? "inverted" : t[0] === "^" ? "pull-up" : "pull-down");
      t = t.slice(1);
    }
    return flags.length ? `${t} (${flags.join(", ")})` : t;
  };
  if (!mcu.includes("=")) return one(mcu);
  return mcu
    .split(",")
    .map((kv) => {
      const [k, v = ""] = kv.split("=");
      return `${k.trim() === "uart" || k.trim() === "tx" ? k.trim().toUpperCase() : k.trim()} ${one(v)}`;
    })
    .join(" · ");
}

/** The world directions the design is drawn in: Z up, -Y the front. */
function facing(v: [number, number, number]): string {
  const names: [number, number, string][] = [
    [2, 1, "above"],
    [2, -1, "below"],
    [1, -1, "the front"],
    [1, 1, "the back"],
    [0, -1, "the left"],
    [0, 1, "the right"],
  ];
  let best = names[0];
  let bv = -Infinity;
  for (const n of names) {
    const d = v[n[0]] * n[1];
    if (d > bv) {
      bv = d;
      best = n;
    }
  }
  return bv > 0.7 ? best[2] : `${best[2]}, at an angle`;
}

/** Currents per wire-list row, for one machine (the load model is built once). */
const memo = new WeakMap<MachineData, Map<string, { amps?: number; volts?: number; span?: Span }>>();

function rowCurrents(m: MachineData, rows: WireRow[]): Map<string, { amps?: number; volts?: number; span?: Span }> {
  const hit = memo.get(m);
  if (hit) return hit;
  const out = new Map<string, { amps?: number; volts?: number; span?: Span }>();
  memo.set(m, out);
  let cm: ReturnType<typeof currentModel>;
  try {
    cm = currentModel(m, motorCurrentFor(m));
  } catch {
    return out;
  }
  const { nl } = cm;
  const byNet = new Map<Net, WireRow[]>();
  for (const r of rows) {
    const n = nl.netOf.get(pinKey(r.from)) ?? nl.netOf.get(pinKey(r.to));
    if (!n) continue;
    byNet.set(n, [...(byNet.get(n) ?? []), r]);
  }
  for (const [n, list] of byNet) {
    const pin = new Map(n.pins.map((p) => [p.key, p]));
    const src = cm.sources(n);
    const srcKeys = new Set(src.map((p) => p.key));
    const isPower = src.some((p) => p.pin.type === "pwr_out" || p.pin.type === "pwr_rail");
    const total = isPower ? cm.load(n) : n.pins.reduce((a, p) => a + cm.pinLoad(p, n), 0);
    // what joins the net's pins: its wires, switches and fuses, a circuit board's copper and a stack connector
    const edges = [...list.map((r) => ({ a: pinKey(r.from), b: pinKey(r.to), r })), ...cm.links(n).map((l) => ({ a: l.a.key, b: l.b.key, r: undefined as WireRow | undefined }))];
    const joined = (p: NetPin, q: NetPin) => (!!p.mc.pcb && p.mc.pcb.board === q.mc.pcb?.board) || (!!p.pin.stack && p.pin.stack === q.pin.stack);
    n.pins.forEach((p, i) => n.pins.slice(i + 1).forEach((q) => joined(p, q) && edges.push({ a: p.key, b: q.key, r: undefined })));
    const reach = (from: string[], skip: WireRow) => {
      const seen = new Set(from);
      const todo = [...from];
      while (todo.length) {
        const k = todo.pop()!;
        for (const e of edges) {
          if (e.r === skip) continue;
          const q = e.a === k ? e.b : e.b === k ? e.a : undefined;
          if (q && !seen.has(q)) {
            seen.add(q);
            todo.push(q);
          }
        }
      }
      return seen;
    };
    const volts = n.v ?? n.pins.find((p) => p.pin.type === "io" || p.pin.type === "out")?.pin.v;
    for (const r of list) {
      const seg = n.segs.find((s) => (s.a.key === pinKey(r.from) && s.b.key === pinKey(r.to)) || (s.b.key === pinKey(r.from) && s.a.key === pinKey(r.to)));
      const span = seg?.span ?? n.spans[0];
      if (!src.length) {
        // a signal net: what the pins on it draw (nothing worth sizing a wire for)
        out.set(r.id, { amps: total, volts, span });
        continue;
      }
      // the run carries what is on its far side from the supply, as the wire-size checks have it
      const near = reach([...srcKeys], r);
      const a = pinKey(r.from);
      const b = pinKey(r.to);
      if (near.has(a) === near.has(b)) {
        out.set(r.id, { amps: total, volts, span });
        continue;
      }
      const far = reach([near.has(a) ? b : a], r);
      const sum = (ks: Iterable<string>) => [...ks].reduce((s, k) => s + (pin.get(k) ? cm.pinLoad(pin.get(k) as NetPin, n) : 0), 0);
      const amps = [...far].some((k) => srcKeys.has(k)) ? total : sum(far);
      out.set(r.id, { amps: Math.max(0, amps), volts, span });
    }
  }
  return out;
}

function connectorName(e: PlugEnd, n: number): string {
  const ways = Math.max(e.spec.ways ?? n, n);
  const name = PLUG_NAME[e.spec.kind];
  if (["lead", "solder", "lug", "barrel", "xt60", "usb_c", "usb_micro", "usb_a", "ufl"].includes(e.spec.kind)) return name;
  return ways > 1 ? `${name}, ${ways}-way` : name;
}

const near = (a: [number, number, number], b: [number, number, number]) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 0.05;

/** The contacts of the housing at one end of a cable: what every cable sharing the housing puts in each. */
function contactsAt(h: Harness, w: HarnessWire, k: 0 | 1): Contact[] {
  const e = w.ends[k];
  const ways = Math.max(e.spec.ways ?? w.wires.length, w.wires.length);
  const out: Contact[] = Array.from({ length: ways }, (_, slot) => ({ slot, label: "", mine: false }));
  for (const x of h.wires) {
    for (const xe of x.ends) {
      if (xe.partId !== e.partId || xe.spec.kind !== e.spec.kind || !near(xe.frame.o, e.frame.o)) continue;
      x.wires.forEach((wi, i) => {
        const slot = xe.spec.used?.[i] ?? i;
        const c = out[slot];
        if (!c || (c.wire && c.wire !== x.id && !(x.id === w.id))) return;
        c.wire = x.id;
        c.color = wi.color;
        c.mine = x.id === w.id;
        c.label = x.wires.length > 1 ? wi.name : xe.label;
      });
    }
  }
  return out;
}

function endDetails(m: MachineData, h: Harness, w: HarnessWire, k: 0 | 1): EndDetails {
  const e = w.ends[k];
  const p = pinDef(m, e);
  const mc = m.components.find((c) => c.name === bare(e.comp));
  const ways = Math.max(e.spec.ways ?? w.wires.length, w.wires.length);
  const latchy = e.spec.kind === "xh" || e.spec.kind === "ph" || e.spec.kind === "sh";
  const controller = mc && (mc.kind === "controller" || mc.kind === "host");
  return {
    comp: e.comp,
    pin: e.pin,
    label: e.label,
    part: e.part,
    partId: e.partId,
    kind: e.spec.kind,
    connector: connectorName(e, w.wires.length),
    ways,
    pitch: e.spec.pitch ?? PITCH[e.spec.kind],
    contacts: contactsAt(h, w, k),
    approach: facing(e.frame.z),
    latch: latchy ? facing(e.frame.y) : undefined,
    guide: plugGuide(e.spec.kind, ways, w.row.gauge),
    firmware: controller && p?.mcu ? firmwareText(p.mcu) : undefined,
    role: roleOf(p),
  };
}

type RowCurrent = ReturnType<typeof rowCurrents> extends Map<string, infer C> ? C : never;

/** What a cable carries: its share of the net's current, or for a cable between ports what the device on it needs. */
function currentOf(cur: RowCurrent | undefined, a: PinDef | undefined, b: PinDef | undefined): Partial<RowCurrent> | undefined {
  if (cur) return cur;
  const sink = a?.side === "sink" ? a : b?.side === "sink" ? b : undefined;
  if (!sink || (sink.need_a === undefined && sink.need_w === undefined)) return undefined;
  const v = sink.v ?? (sink === a ? b : a)?.v;
  return { amps: sink.need_a ?? (sink.need_w !== undefined && v ? sink.need_w / v : undefined), volts: v };
}

function titleOf(r: WireRow): string {
  return r.cable ?? (r.label || `${r.kind === "ground" ? "Ground" : r.kind === "power" ? "Power" : r.kind === "motor" ? "Motor" : "Signal"} wire`);
}

/** The cable card's facts for one harness cable. `run` is its routed length plug to plug, when it has been routed. */
export function cableDetails(m: MachineData, h: Harness, w: HarnessWire, run?: number): CableDetails {
  const r = w.row;
  const a = pinDef(m, w.ends[0]);
  const b = pinDef(m, w.ends[1]);
  const cur = currentOf(rowCurrents(m, h.wires.map((x) => x.row)).get(r.id), a, b);
  const sink = a?.side === "sink" ? a : b?.side === "sink" ? b : undefined;
  const ends: [EndDetails, EndDetails] = [endDetails(m, h, w, 0), endDetails(m, h, w, 1)];
  const cut = run !== undefined && r.fixedMm === undefined ? cutLength(run) : r.lengthMm;
  const rating = r.gauge !== undefined ? awgAmpacity(r.gauge, r.insulation) : undefined;
  const steps: string[] = [];
  const g = r.gauge !== undefined ? `${r.gauge} AWG${r.insulation === "silicone" ? " silicone" : ""}` : "";
  if (r.lead) steps.push(`Use ${r.lead}${r.fixedMm ? ` (${r.fixedMm} mm)` : ""}${run !== undefined ? `: it has to cover ${Math.round(run)} mm here` : ""}.`);
  else if (r.cable) steps.push(`Use the ${r.cable}${cut ? `, at least ${cut} mm long` : ""}.`);
  else steps.push(`Cut ${cut ? `${cut} mm of ` : ""}${g ? `${g} ` : ""}${r.color} wire${w.wires.length > 1 ? "s" : ""}.`);
  ends.forEach((e, k) => {
    if (r.own?.includes(k ? "to" : "from") || e.kind === "lead") return;
    const slot = e.contacts.find((c) => c.mine);
    const where = e.ways > 1 && slot && w.wires.length === 1 ? ` (contact ${slot.slot + 1} of ${e.ways})` : "";
    steps.push(`${e.comp} end: ${e.guide.strip ? `strip ${e.guide.strip} mm, ` : ""}fit ${e.guide.make}${where}.`);
  });
  if (r.via?.length) steps.push(`Tie it down at the ${r.via.length === 1 ? "point" : `${r.via.length} points`} the design marks on its way.`);
  return {
    id: r.id,
    title: titleOf(r),
    kind: carriesOf(r),
    net: r.net,
    signal: signalOf(r, a, b, cur?.volts),
    volts: cur?.volts,
    amps: cur?.amps,
    watts: sink?.need_w,
    rating,
    gauge: r.gauge,
    gaugeSuggested: r.gaugeSuggested,
    color: r.color,
    insulation: r.insulation,
    wires: w.wires.map((x) => ({ name: x.name, color: x.color })),
    cut,
    run,
    estimated: run === undefined && !r.lengthRouted,
    lead: r.lead,
    ties: r.via?.length ?? 0,
    ends,
    steps,
    span: cur?.span,
  };
}

/** Volts, amps and the wire's rating for every cable of the harness (amps and volts as the cable card has them). */
export function cableLoads(m: MachineData, h: Harness): Map<string, { volts?: number; amps?: number; rating?: number }> {
  const cur = rowCurrents(m, h.wires.map((x) => x.row));
  const out = new Map<string, { volts?: number; amps?: number; rating?: number }>();
  for (const w of h.wires) {
    const c = currentOf(cur.get(w.id), pinDef(m, w.ends[0]), pinDef(m, w.ends[1]));
    out.set(w.id, { volts: c?.volts, amps: c?.amps, rating: w.row.gauge !== undefined ? awgAmpacity(w.row.gauge, w.row.insulation) : undefined });
  }
  return out;
}

/** Every cable on the same net as this one, and the ground returns of the parts it powers: the circuit from supply to ground. */
export function circuitOf(h: Harness, id: string): string[] {
  const w = h.wires.find((x) => x.id === id);
  if (!w) return [];
  const net = w.row.net;
  const same = h.wires.filter((x) => x.row.net === net).map((x) => x.id);
  if (w.row.kind !== "power" && w.row.kind !== "motor") return same;
  // the parts the net feeds return their current through their grounds
  const comps = new Set(h.wires.filter((x) => x.row.net === net).flatMap((x) => x.ends.map((e) => e.comp)));
  const back = h.wires.filter((x) => x.row.kind === "ground" && x.ends.some((e) => comps.has(e.comp))).map((x) => x.id);
  return [...new Set([...same, ...back])];
}

/** One line per cable for a bench cut list: what to cut, and what goes on each end. */
export function cutListCsv(m: MachineData, h: Harness, runs: Map<string, number> | undefined): string {
  const cell = (v: string | number | undefined) => {
    const t = v === undefined ? "" : String(v);
    const safe = /^[=+\-@\t\r]/.test(t) && t.length > 1 ? `'${t}` : t;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const head = ["Wire", "Net", "Carries", "Gauge (AWG)", "Colour", "Cut (mm)", "From", "From connector", "From end", "From strip (mm)", "To", "To connector", "To end", "To strip (mm)"];
  const lines = [head.join(",")];
  for (const w of h.wires) {
    const d = cableDetails(m, h, w, runs?.get(w.id));
    const e = (x: EndDetails) => [`${x.comp}.${x.pin}${x.label !== x.pin ? ` (${x.label})` : ""}`, x.connector, x.guide.make, x.guide.strip];
    lines.push([d.id, d.net, d.signal, d.gauge, d.wires.map((x) => x.name).join("/"), d.lead ? "" : d.cut, ...e(d.ends[0]), ...e(d.ends[1])].map(cell).join(","));
  }
  return lines.join("\n") + "\n";
}
