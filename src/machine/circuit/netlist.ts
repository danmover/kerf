// The design's circuit for the solver: every part with a `sim` model becomes
// solver elements, joined at the nodes the design's copper (net) and cables
// (wire) make. Switches and jacks conduct like closed contacts; a part that
// conducts for the wiring rules but has its own model (a protection diode)
// is simulated, not shorted. Pots are split at the wiper by their knob
// setting and taper. Parts that only draw current (a controller, a display,
// the power amp's supply) are current sinks of their rated draw.

import { catalogPart } from "../catalog";
import { taperCurve } from "../catalog/values";
import type { CatalogPart, MachineComponent, MachineData } from "../types";
import type { Circuit, Element, Node } from "./types";

/** Knob positions 0..1 (fully counter-clockwise .. fully clockwise), by component name. */
export type KnobSettings = Record<string, number>;

export interface DesignCircuit {
  circuit: Circuit;
  /** solver node of a component pin: `${comp}.${pin}` */
  nodeOf: Map<string, Node>;
  /** the guitar source's element id, its jack's signal node, and the node its source drives */
  input?: { id: string; node: Node; comp: string };
  /** the load the preamp drives (a power amp's input), or the speaker */
  output?: { comp: string; node: Node; ref: Node; kind: "amplifier" | "speaker" };
  /** element id of each part, for reading currents and power back */
  elementOf: Map<string, string[]>;
  pots: { comp: string; taper: "A" | "B"; ohms: number; label: string }[];
  /** op-amp channels: element id, the component and the channel letter */
  opamps: { id: string; comp: string; channel: string; part: CatalogPart }[];
  /** supply element ids */
  supplies: string[];
  warnings: string[];
}

class Sets {
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

const pk = (comp: string, pin: string) => `${comp}.${pin}`;
/** Guitar pickup and cable as the source sees them: a resistance in series. */
export const PICKUP_OHMS = 10e3;
/** Smallest pot half the solver takes (a wiper at the end of the track). */
const POT_MIN = 1e-2;

export function hasCircuit(m: MachineData): boolean {
  return m.components.some((c) => catalogPart(c.catalogId)?.sim);
}

/** Display name of a component in the circuit: its board reference, else its name. */
const idOf = (mc: MachineComponent) => mc.ref ?? mc.name;

export function designCircuit(m: MachineData, knobs: KnobSettings = {}, opts: { source?: boolean } = {}): DesignCircuit {
  const withSource = opts.source !== false;
  const sets = new Sets();
  const parts = new Map<string, { mc: MachineComponent; part: CatalogPart }>();
  for (const mc of m.components) {
    const part = catalogPart(mc.catalogId);
    if (part && mc.count === 1) parts.set(mc.name, { mc, part });
  }
  const touched = new Set<string>();
  const join = (a: string, b: string) => {
    touched.add(a);
    touched.add(b);
    sets.union(a, b);
  };
  for (const w of m.wires) if (!w.a.index && !w.b.index) join(pk(w.a.comp, w.a.pin), pk(w.b.comp, w.b.pin));
  for (const n of m.nets) {
    const ps = n.pins.filter((p) => !p.index).map((p) => pk(p.comp, p.pin));
    for (const p of ps) touched.add(p);
    for (let i = 1; i < ps.length; i++) join(ps[0], ps[i]);
  }
  // closed contacts: switches and connector pairs without a model of their own
  for (const { mc, part } of parts.values()) {
    if (part.sim) continue;
    for (const pin of part.pins) if (pin.type === "passive" && pin.through) join(pk(mc.name, pin.id), pk(mc.name, pin.through));
  }

  // node names: the design's net names where there is one
  const names = new Map<string, string>();
  for (const n of m.nets) {
    const p = n.pins.find((x) => !x.index);
    if (p) {
      const root = sets.find(pk(p.comp, p.pin));
      if (!names.has(root)) names.set(root, n.name);
    }
  }
  // ground: the supply's negative terminal, else the net with the most ground pins
  let groundRoot: string | undefined;
  for (const { mc, part } of parts.values()) {
    if (part.sim?.k === "supply") groundRoot = sets.find(pk(mc.name, part.sim.neg));
  }
  if (!groundRoot) {
    const count = new Map<string, number>();
    for (const { mc, part } of parts.values()) for (const pin of part.pins) if (pin.type === "gnd" && touched.has(pk(mc.name, pin.id))) count.set(sets.find(pk(mc.name, pin.id)), (count.get(sets.find(pk(mc.name, pin.id))) ?? 0) + 1);
    groundRoot = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  }
  const nodeOf = new Map<string, Node>();
  let anon = 0;
  const rootName = new Map<string, Node>();
  const node = (comp: string, pin: string): Node => {
    const k = pk(comp, pin);
    const cached = nodeOf.get(k);
    if (cached) return cached;
    const root = sets.find(k);
    let nm = rootName.get(root);
    if (!nm) {
      nm = root === groundRoot ? "0" : (names.get(root) ?? `${comp}.${pin}#${++anon}`);
      rootName.set(root, nm);
    }
    nodeOf.set(k, nm);
    return nm;
  };

  const els: Element[] = [];
  const elementOf = new Map<string, string[]>();
  const add = (comp: string, e: Element) => {
    els.push(e);
    elementOf.set(comp, [...(elementOf.get(comp) ?? []), e.id]);
  };
  const out: DesignCircuit = { circuit: { elements: els, title: "design" }, nodeOf, elementOf, pots: [], opamps: [], supplies: [], warnings: [] };
  const withModel = new Set<string>();

  for (const { mc, part } of parts.values()) {
    const sim = part.sim;
    const id = idOf(mc);
    const [p0, p1] = part.pins;
    switch (sim?.k) {
      case "R":
        if (mc.value) add(mc.name, { k: "R", id, n: [node(mc.name, p0.id), node(mc.name, p1.id)], r: mc.value });
        break;
      case "C":
        if (mc.value) add(mc.name, { k: "C", id, n: [node(mc.name, p0.id), node(mc.name, p1.id)], c: mc.value });
        break;
      case "pot": {
        if (!mc.value) break;
        const taper = mc.taper ?? "B";
        const x = Math.min(1, Math.max(0, knobs[mc.name] ?? 0.5));
        const f = taperCurve(taper, x);
        const ccw = pk(mc.name, "CCW");
        const cw = pk(mc.name, "CW");
        const w = node(mc.name, "W");
        if (touched.has(ccw) && sets.find(ccw) !== sets.find(pk(mc.name, "W"))) add(mc.name, { k: "R", id: `${id}.a`, n: [node(mc.name, "CCW"), w], r: Math.max(POT_MIN, mc.value * f) });
        if (touched.has(cw) && sets.find(cw) !== sets.find(pk(mc.name, "W"))) add(mc.name, { k: "R", id: `${id}.b`, n: [w, node(mc.name, "CW")], r: Math.max(POT_MIN, mc.value * (1 - f)) });
        out.pots.push({ comp: mc.name, taper, ohms: mc.value, label: mc.role ?? mc.name });
        break;
      }
      case "D":
        add(mc.name, { k: "D", id, n: [node(mc.name, p0.id), node(mc.name, p1.id)], is: sim.is, nf: sim.nf, rs: sim.rs, bv: sim.bv });
        break;
      case "opamp":
        sim.channels.forEach(([ip, im, o], i) => {
          const ch = String.fromCharCode(65 + i);
          const eid = `${id}${ch}`;
          add(mc.name, { k: "OA", id: eid, n: [node(mc.name, ip), node(mc.name, im), node(mc.name, o), node(mc.name, sim.vpos), node(mc.name, sim.vneg)], a0: sim.a0, gbw: sim.gbw, rout: sim.rout, swing: sim.swing, iq: sim.iq });
          out.opamps.push({ id: eid, comp: mc.name, channel: ch, part });
        });
        break;
      case "reg":
        add(mc.name, { k: "REG", id, n: [node(mc.name, sim.in), node(mc.name, sim.gnd), node(mc.name, sim.out)], vout: sim.vout, dropout: sim.dropout, ilim: sim.ilim, iq: sim.iq, rout: 0.02 });
        break;
      case "load": {
        const a = node(mc.name, sim.a);
        const b = node(mc.name, sim.b);
        if (sim.l) {
          const mid = `${id}.l`;
          add(mc.name, { k: "R", id, n: [a, mid], r: sim.r });
          add(mc.name, { k: "L", id: `${id}.L`, n: [mid, b], l: sim.l });
        } else add(mc.name, { k: "R", id, n: [a, b], r: sim.r });
        if (part.kind === "amplifier") out.output = { comp: mc.name, node: a, ref: b, kind: "amplifier" };
        else if (part.kind === "speaker" && !out.output) out.output = { comp: mc.name, node: a, ref: b, kind: "speaker" };
        break;
      }
      case "supply": {
        const mid = `${id}.out`;
        add(mc.name, { k: "V", id, n: [mid, node(mc.name, sim.neg)], dc: sim.v });
        add(mc.name, { k: "R", id: `${id}.r`, n: [mid, node(mc.name, sim.pos)], r: sim.r });
        out.supplies.push(id);
        break;
      }
      case "input": {
        const src = `${id}.src`;
        const sig = node(mc.name, sim.sig);
        // unplugged (for the input impedance): the jack's tip is left open
        if (withSource) {
          add(mc.name, { k: "V", id: "guitar", n: [src, node(mc.name, sim.gnd)], dc: 0, ac: 1 });
          add(mc.name, { k: "R", id: `${id}.pickup`, n: [src, sig], r: PICKUP_OHMS });
        }
        out.input = { id: "guitar", node: sig, comp: mc.name };
        break;
      }
      case "draw":
        add(mc.name, { k: "I", id, n: [node(mc.name, sim.pwr), node(mc.name, sim.gnd)], dc: sim.a });
        break;
      default:
        break;
    }
    if (sim) withModel.add(mc.name);
  }

  // parts with no model that draw power: a current sink from each powered pin to the part's ground
  for (const { mc, part } of parts.values()) {
    if (part.sim?.k === "opamp" || part.sim?.k === "reg" || part.sim?.k === "draw") continue;
    const g = part.pins.find((p) => p.type === "gnd" && touched.has(pk(mc.name, p.id)));
    if (!g) continue;
    for (const pin of part.pins) {
      if ((pin.type !== "pwr_in" && pin.type !== "pwr_rail") || !pin.draw || !touched.has(pk(mc.name, pin.id))) continue;
      // a power amp idles at a fraction of its full-power draw
      const a = part.kind === "amplifier" ? Math.min(pin.draw, 0.03) : pin.draw;
      add(mc.name, { k: "I", id: `${idOf(mc)}.${pin.id}`, n: [node(mc.name, pin.id), node(mc.name, g.id)], dc: a });
      // only the widest-range input carries the part's draw
      break;
    }
  }
  // a power amp's outputs aren't simulated, so the speaker behind it would float
  if (out.output?.kind === "amplifier") {
    for (const { mc, part } of parts.values()) {
      if (part.kind !== "speaker") continue;
      const ids = new Set(elementOf.get(mc.name) ?? []);
      for (let i = els.length - 1; i >= 0; i--) if (ids.has(els[i].id)) els.splice(i, 1);
      elementOf.delete(mc.name);
    }
  }
  // every pin on a node the circuit uses can be probed, a controller's analog input among them
  for (const k of touched) {
    if (nodeOf.has(k)) continue;
    const root = sets.find(k);
    const nm = rootName.get(root);
    if (nm) nodeOf.set(k, nm);
  }
  if (!out.input) out.warnings.push("No guitar input: give the input jack a part with an input model (jack_635_mono).");
  void withModel;
  return out;
}
