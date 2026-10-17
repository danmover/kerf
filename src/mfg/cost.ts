// Rough cost and lead time for making one part by a process, at a quantity:
// one-time costs (programming and setup for the order, and moulds, dies or
// patterns), what each part costs (material, machine time, hands-on work) and
// how long it takes to have the parts in hand. It is for comparing ways of
// making a part and seeing where one overtakes another, not for quoting:
// numbers follow typical 2026 online-service and job-shop prices in US
// dollars, and every estimate carries a range. A real quote wins.
//
// Pure: the caller passes the part's measured geometry (cost/geometry reads
// it from the live build and the process checks) and the user's access.

import { materialRecord, pricePerKg, type CostForm, type MaterialRecord } from "../library/materialDb";
import type { V3 } from "../kernel/recipe";
import type { Access } from "./availability";
import type { ProcessId } from "./types";

export interface CostGeometry {
  /** one part, mm³ */
  volume: number;
  /** one part's surface, mm² */
  area: number;
  /** one part, in its own frame */
  bbox: [V3, V3];
  /** area seen along X, Y and Z, mm² */
  projected?: V3;
  /** typical wall, mm (measured by the moulding checks; otherwise estimated) */
  wall?: number;
  /** sheet or plate thickness, mm */
  sheetT?: number;
  bends?: number;
  holes?: number;
  /** undercuts that need side actions, cores or extra setups */
  undercuts?: number;
  /** machining setups (CNC) */
  setups?: number;
  /** direction moulds open or parts are printed along */
  axis?: V3;
}

export interface CostLine {
  label: string;
  /** dollars: per order for one-time lines, per part otherwise */
  amount: number;
  oneTime?: boolean;
  note?: string;
}

export interface CostEstimate {
  process: ProcessId;
  material: string;
  qty: number;
  access: Access;
  /** one-time: quoting, programming and setting up this order */
  setup: number;
  /** one-time: moulds, dies or patterns for this quantity (more than one when they wear out) */
  tooling: number;
  toolingNote?: string;
  /** each part, before setup and tooling */
  each: number;
  /** each part with its share of setup and tooling */
  unit: number;
  total: number;
  /** likely range of the unit cost */
  range: [number, number];
  /** working days from ordering (or starting) to parts in hand */
  days: [number, number];
  /** machine hours per part */
  hours: number;
  /** hands-on minutes per part, for processes you run yourself */
  handsOn: number;
  lines: CostLine[];
  notes: string[];
}

export interface CostOptions {
  access: Access;
  /** what an hour of your own hands-on time is worth, $ (own processes only) */
  labour?: number;
}

/** What a shop charges for an hour of skilled hands-on work. */
const SHOP_LABOUR = 45;
/** When a material has no price for the form a process buys, by form. */
const FALLBACK_PRICE: Record<CostForm, number> = { filament: 25, resin: 60, powder: 70, pellets: 3, stock: 8, sheet: 4, ingot: 4 };

const size = (b: [V3, V3]): V3 => [b[1][0] - b[0][0], b[1][1] - b[0][1], b[1][2] - b[0][2]];
const axisIndex = (d: V3 | undefined) => (!d ? 2 : Math.abs(d[0]) > 0.9 ? 0 : Math.abs(d[1]) > 0.9 ? 1 : 2);

/** How fast a material cuts relative to aluminium, for machine time. */
export function machinability(m: MaterialRecord | undefined): number {
  if (!m) return 0.6;
  if (m.category === "plastic" || m.family === "wood") return 1.3;
  if (/alumin|alsi/i.test(m.name)) return 1;
  if (/brass|bronze|copper/i.test(m.name)) return 0.8;
  if (/titan/i.test(m.name)) return 0.15;
  if (/stainless/i.test(m.name)) return 0.3;
  if (/cast iron/i.test(m.name)) return 0.5;
  if (/steel/i.test(m.name)) return 0.4;
  if (m.category === "composite") return 0.5;
  return 0.6;
}

/** Laser cutting speed, mm/min, for a material and thickness (fibre laser for metal, CO2 for the rest). */
function laserSpeed(m: MaterialRecord | undefined, t: number): number {
  const tt = Math.max(0.5, t);
  if (m && m.category === "metal") {
    const k = /stainless|titan/i.test(m.name) ? 0.7 : /copper|brass|bronze/i.test(m.name) ? 0.5 : 1;
    return (9000 * k) / tt ** 1.1;
  }
  return 4000 / tt ** 1.2;
}

/** Each process's typical uncertainty: how far a real quote may land below and above the estimate. */
const SPREAD: Record<ProcessId, [number, number]> = {
  fdm: [0.6, 1.6],
  sla: [0.6, 1.8],
  sls: [0.6, 1.7],
  cnc_mill: [0.6, 1.9],
  cnc_lathe: [0.6, 1.8],
  injection: [0.6, 2],
  die_cast: [0.6, 2],
  sheet_metal: [0.6, 1.8],
  laser_cut: [0.6, 1.8],
  sand_cast: [0.6, 2],
  investment_cast: [0.6, 2],
  vacuum_cast: [0.6, 1.8],
  metal_print: [0.6, 1.8],
};

/** Printers and furnaces run unattended through the night; machines you stand at do not. */
const UNATTENDED = new Set<string>(["fdm", "sla", "sls", "metal_print"]);

interface Make {
  setup: number;
  tooling?: { cost: number; note: string; days: [number, number] };
  /** machine hours per part and the rate */
  hours: number;
  rate: number;
  /** hands-on minutes per part (finishing, support removal, deburring, moulding sand) */
  handsOn: number;
  /** kg of material bought per part, in the form the process buys */
  kg: number;
  /** other per-part costs: consumables, heat treatment share, packing */
  extra?: { label: string; amount: number };
  /** the cheapest a shop will make one part for */
  minEach?: number;
  days: [number, number];
  notes?: string[];
}

/** What it takes to make one part this way, before quantity effects. */
function makeIt(process: ProcessId, g: CostGeometry, m: MaterialRecord | undefined, qty: number, own: boolean): Make | null {
  const d = size(g.bbox);
  const V = Math.max(1, g.volume);
  const A = Math.max(1, g.area);
  const cm3 = V / 1000;
  const boxCm3 = (d[0] * d[1] * d[2]) / 1000;
  const rho = m?.density ?? 1.2;
  const kgOf = (mm3: number) => (mm3 / 1000) * rho / 1000;
  const ax = axisIndex(g.axis);
  const proj = (g.projected?.[ax] ?? (d[(ax + 1) % 3] * d[(ax + 2) % 3]) * 0.8) / 100; // cm²
  const depth = d[ax];
  const wall = g.wall && g.wall > 0 ? g.wall : Math.min(8, Math.max(0.8, (2 * V) / A));
  const mach = machinability(m);
  const undercuts = g.undercuts ?? 0;
  switch (process) {
    case "fdm": {
      // three perimeters of a 0.4 mm nozzle all round, 20 % infill inside, a little support
      const shell = Math.min(V, A * 1.2);
      const printed = (shell + 0.2 * (V - shell)) * 1.1;
      return {
        setup: own ? 0 : 10,
        hours: 0.15 + printed / (8 * 3600),
        rate: own ? 0.5 : 4,
        handsOn: 5,
        kg: kgOf(printed),
        minEach: own ? 0 : 3,
        days: own ? [0, 1] : [3, 7],
      };
    }
    case "sla":
      return {
        setup: own ? 0 : 15,
        hours: 0.2 + Math.max(0.25, cm3 / 12),
        rate: own ? 1 : 7,
        handsOn: 15,
        kg: kgOf(V * 1.15),
        minEach: own ? 0 : 5,
        days: own ? [0, 2] : [3, 8],
        notes: ["Includes washing, curing and support removal."],
      };
    case "sls":
      // priced by the part and by the space it takes in the powder bed
      return {
        setup: own ? 0 : 15,
        hours: 0.05 + cm3 * 0.01 + boxCm3 * 0.004,
        rate: own ? 10 : 30,
        handsOn: 5,
        kg: kgOf(V),
        extra: { label: "Build space", amount: own ? 0 : 1 + cm3 * 0.15 + boxCm3 * 0.012 },
        minEach: own ? 0 : 6,
        days: own ? [1, 3] : [4, 9],
      };
    case "cnc_mill": {
      const setups = Math.max(1, g.setups ?? 2) + undercuts;
      const stock = (d[0] + 5) * (d[1] + 5) * (d[2] + 5);
      const minutes = (stock - V) / 1000 / (8 * mach) + A / 100 / (15 * mach) + (g.holes ?? 0) * 0.4 + setups * 3;
      return {
        setup: own ? 0 : 40 + 30 * setups + Math.min(150, (A / 100) * 0.4),
        hours: minutes / 60,
        rate: own ? 12 : 75,
        handsOn: 4,
        kg: kgOf(stock),
        minEach: own ? 0 : 8,
        days: own ? [1, 3] : [5, 12],
        notes: setups > 2 ? [`${setups} setups: every side the tool has to reach adds one.`] : [],
      };
    }
    case "cnc_lathe": {
      const sorted = [...d].sort((a, b) => b - a);
      const len = sorted[0];
      const dia = sorted[1];
      const stock = (Math.PI / 4) * (dia + 3) ** 2 * (len + 5);
      const minutes = (stock - V) / 1000 / (12 * mach) + A / 100 / (20 * mach) + (g.holes ?? 0) * 0.4 + 4;
      return {
        setup: own ? 0 : 60 + Math.min(80, (A / 100) * 0.3),
        hours: minutes / 60,
        rate: own ? 10 : 60,
        handsOn: 3,
        kg: kgOf(stock),
        minEach: own ? 0 : 6,
        days: own ? [1, 3] : [5, 10],
      };
    }
    case "injection": {
      // aluminium moulds for up to about 10,000 shots, hardened steel beyond; more cavities for big runs
      const steel = qty > 10000;
      const cav = qty > 200000 ? 4 : qty > 50000 ? 2 : 1;
      const life = steel ? 500000 : 10000;
      const one = (3500 + 25 * proj + 8 * depth + 1500 * undercuts) * (steel ? 2.6 : 1) * (1 + 0.6 * (cav - 1));
      const tools = Math.max(1, Math.ceil(qty / (life * cav)));
      const shot = Math.min(120, 12 + 2.2 * wall * wall);
      const cycle = shot / cav;
      return {
        setup: own ? 150 : 450,
        tooling: {
          cost: one * tools,
          note: `${tools > 1 ? `${tools} × ` : ""}${steel ? "hardened steel" : "aluminium"} mould${cav > 1 ? ` with ${cav} cavities` : ""}${undercuts ? `, ${undercuts} side action${undercuts > 1 ? "s" : ""}` : ""}, good for about ${(life * cav).toLocaleString("en-US")} parts`,
          days: steel ? [35, 60] : [15, 30],
        },
        hours: cycle / 3600,
        rate: (own ? 35 : 45) + 0.25 * proj,
        handsOn: 0.2,
        kg: kgOf(V * 1.08),
        extra: { label: "Inspection and packing", amount: 0.06 },
        days: [3, 7],
        notes: [`About ${Math.round(shot)} s per shot for a ${wall.toFixed(1)} mm wall.`],
      };
    }
    case "die_cast": {
      const zinc = !!m && /zamak|zinc/i.test(m.name);
      const life = zinc ? 500000 : 80000;
      const one = 9000 + 70 * proj + 15 * depth + 3000 * undercuts;
      const tools = Math.max(1, Math.ceil(qty / life));
      return {
        setup: own ? 300 : 700,
        tooling: { cost: one * tools, note: `${tools > 1 ? `${tools} × ` : ""}steel die, good for about ${life.toLocaleString("en-US")} parts`, days: [35, 60] },
        hours: Math.min(90, 20 + 1.5 * wall * wall) / 3600,
        rate: (own ? 60 : 85) + 0.3 * proj,
        handsOn: 0.5,
        kg: kgOf(V * 1.35),
        extra: { label: "Trimming", amount: 0.35 },
        days: [5, 10],
        notes: ["Faces that seal, locate or carry bearings are usually machined afterwards (not included)."],
      };
    }
    case "sheet_metal":
    case "laser_cut": {
      const t = g.sheetT && g.sheetT > 0 ? g.sheetT : Math.max(0.5, Math.min(...d));
      const cut = Math.max(0, (A - (2 * V) / t) / t);
      const pierces = (g.holes ?? 0) + 1;
      const bends = process === "sheet_metal" ? (g.bends ?? 0) : 0;
      const cutMin = cut / laserSpeed(m, t) + (pierces * 2) / 60;
      const bendMin = bends * 0.4;
      return {
        setup: own ? 0 : process === "sheet_metal" ? 15 + 6 * Math.min(bends, 6) : 15,
        hours: (cutMin + bendMin) / 60,
        rate: own ? (m?.category === "metal" ? 20 : 3) : 85,
        handsOn: process === "sheet_metal" ? 2 : 1,
        kg: kgOf((V / t) * 1.25 * t),
        minEach: own ? 0 : process === "sheet_metal" ? 3 : 1.5,
        days: own ? [0, 2] : [4, 10],
        notes: bends ? [`${bends} bend${bends > 1 ? "s" : ""} on a press brake.`] : [],
      };
    }
    case "sand_cast": {
      // a wooden or printed pattern lasts a few hundred moulds; a metal match plate thousands, on a moulding machine
      const plate = qty > 300;
      const life = plate ? 5000 : 300;
      const one = (350 + 0.4 * boxCm3 + 250 * undercuts) * (plate ? 2.5 : 1);
      const tools = Math.max(1, Math.ceil(qty / life));
      const poured = kgOf(V * 1.7);
      return {
        setup: own ? 50 : 120,
        tooling: { cost: one * tools, note: `${tools > 1 ? `${tools} × ` : ""}${plate ? "metal match-plate pattern" : "wood or printed pattern"}${undercuts ? ` with ${undercuts} sand core box${undercuts > 1 ? "es" : ""}` : ""}`, days: [5, 10] },
        hours: 0.05,
        rate: 40,
        // ramming a mould by hand, or a machine-moulded flask
        handsOn: plate ? 3 + 0.0005 * boxCm3 : 12 + 0.002 * boxCm3,
        // risers and gates: about 60 % of the metal poured ends up in the part
        kg: poured,
        extra: { label: "Melting and fettling", amount: 2 + poured * 2 + (A / 100) * 0.005 },
        minEach: own || plate ? 0 : 15,
        days: [10, 20],
        notes: ["Rough sand surface, about ±1 mm. Faces that seal, locate or carry bearings need machining afterwards (not included)."],
      };
    }
    case "investment_cast": {
      // a wax-injection die pays off from a few hundred parts; below that, printed patterns
      const die = 2500 + 25 * proj + 1200 * undercuts;
      const printed = 12 + cm3 * 0.6;
      const useDie = die < printed * qty;
      return {
        setup: own ? 80 : 200,
        tooling: useDie ? { cost: die, note: "aluminium wax-injection die", days: [20, 30] } : undefined,
        hours: 0.05,
        rate: 40,
        // gating wax trees and cutting parts off them; a die makes the waxes quicker to handle
        handsOn: useDie ? 6 + cm3 * 0.03 : 12 + cm3 * 0.06,
        kg: kgOf(V * 1.5),
        extra: { label: useDie ? "Ceramic shell and finishing" : "Printed pattern, shell and finishing", amount: (useDie ? 0 : printed) + 6 + (A / 100) * 0.004 },
        minEach: own ? 0 : 20,
        days: [15, 30],
        notes: useDie ? [] : ["Each part starts as a 3D-printed pattern, so there is no die to pay for."],
      };
    }
    case "vacuum_cast": {
      // an SLA master, then silicone moulds that make about 20 parts each
      const moulds = Math.max(1, Math.ceil(qty / 20));
      const master = 80 + cm3 * 0.6;
      const mould = 220 + boxCm3 * 0.35;
      return {
        setup: own ? 20 : 60,
        tooling: { cost: master + moulds * mould, note: `printed master and ${moulds} silicone mould${moulds > 1 ? "s" : ""} (about 20 parts each)`, days: [4, 7] },
        hours: 0.05,
        rate: 30,
        handsOn: 21 + cm3 * 0.05,
        kg: kgOf(V * 1.15),
        extra: { label: "Finishing", amount: 4 },
        minEach: own ? 0 : 8,
        days: [7, 14],
      };
    }
    case "metal_print": {
      const support = 0.25 * V;
      // cm³ an hour per part, with a build plate shared by several parts: aluminium melts quickest
      const speed = /alum|alsi/i.test(m?.name ?? "") ? 25 : /titan/i.test(m?.name ?? "") ? 10 : 12;
      return {
        setup: own ? 60 : 180,
        hours: 0.2 + (V + support) / 1000 / speed + depth / 600,
        rate: own ? 40 : 70,
        handsOn: 30,
        kg: kgOf((V + support) * 1.05),
        extra: { label: "Stress relief", amount: 4 },
        minEach: own ? 0 : 40,
        days: own ? [2, 5] : [7, 14],
        notes: ["Includes support removal and bead blasting. Holes and faces that must be precise are usually machined afterwards (not included)."],
      };
    }
  }
  return null;
}

/** Hands-on work gets quicker over a batch: about 10 % less by ten parts and 25 % by a hundred. */
const learning = (qty: number) => (qty >= 100 ? 0.75 : qty >= 10 ? 0.9 : 1);

/**
 * The cost and lead time of making `qty` of one part by `process` in
 * `material`. Null when Kerf has no cost model for the process.
 */
export function estimateCost(process: ProcessId, material: string, g: CostGeometry, qty: number, opts: CostOptions): CostEstimate | null {
  const q = Math.max(1, Math.round(qty));
  const own = opts.access === "own";
  const m = materialRecord(material);
  const mk = makeIt(process, g, m, q, own);
  if (!mk) return null;
  const labourRate = own ? (opts.labour ?? 0) : SHOP_LABOUR;
  const price = (m ? pricePerKg(m, process) : null) ?? { price: FALLBACK_PRICE.stock, form: "stock" as CostForm };
  const learn = learning(q);
  const hours = mk.hours * (process === "cnc_mill" || process === "cnc_lathe" ? learn : 1);
  const handsOn = mk.handsOn * learn;

  const lines: CostLine[] = [];
  const material$ = mk.kg * price.price;
  const machine$ = hours * mk.rate;
  const labour$ = (handsOn / 60) * labourRate;
  lines.push({ label: `Material (${fmtKg(mk.kg)} ${price.form === "stock" ? "bar or plate" : price.form})`, amount: material$ });
  if (machine$ > 0.005) lines.push({ label: `Machine time (${fmtHours(hours)})`, amount: machine$ });
  if (labour$ > 0.005) lines.push({ label: own ? `Your time (${Math.round(handsOn)} min)` : `Hands-on work (${Math.round(handsOn)} min)`, amount: labour$ });
  if (mk.extra && mk.extra.amount > 0.005) lines.push({ label: mk.extra.label, amount: mk.extra.amount });
  let each = lines.reduce((s, l) => s + l.amount, 0);
  if (mk.minEach && each < mk.minEach) {
    lines.push({ label: "Shop minimum per part", amount: mk.minEach - each });
    each = mk.minEach;
  }
  const tooling = mk.tooling?.cost ?? 0;
  if (mk.setup > 0) lines.push({ label: own ? "Setting up" : "Order setup and programming", amount: mk.setup, oneTime: true });
  if (tooling > 0) lines.push({ label: cap(mk.tooling!.note), amount: tooling, oneTime: true });
  const total = each * q + mk.setup + tooling;
  const unit = total / q;
  const spread = SPREAD[process] ?? [0.6, 2];

  // a shop spreads a big order over several machines (a print farm over many); your own runs one at a time
  const machines = own ? 1 : Math.min(UNATTENDED.has(process) ? 20 : 4, 1 + Math.floor((q * hours) / 100));
  const machineDays = (q * hours) / (UNATTENDED.has(process) ? 20 : own ? 7 : 16) / machines;
  const handDays = own ? (q * handsOn) / 60 / 7 : 0;
  const prod = Math.ceil(machineDays + handDays);
  const tool = mk.tooling?.days ?? [0, 0];
  const days: [number, number] = [mk.days[0] + tool[0] + prod, mk.days[1] + tool[1] + Math.ceil(prod * 1.3)];

  return {
    process,
    material,
    qty: q,
    access: opts.access,
    setup: mk.setup,
    tooling,
    toolingNote: mk.tooling?.note,
    each,
    unit,
    total,
    range: [unit * spread[0], unit * spread[1]],
    days,
    hours,
    handsOn,
    lines,
    notes: mk.notes ?? [],
  };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const fmtKg = (kg: number) => (kg >= 1 ? `${(Math.round(kg * 100) / 100).toString()} kg` : `${Math.max(1, Math.round(kg * 1000))} g`);
export const fmtHours = (h: number) => (h >= 1 ? `${Math.round(h * 10) / 10} h` : `${Math.max(1, Math.round(h * 60))} min`);
export const fmtDays = (d: [number, number]) => (d[1] <= 1 ? "a day or two" : d[0] === d[1] ? `${d[0]} days` : `${d[0]}–${d[1]} days`);

/** Unit cost at each quantity, for drawing a cost curve. */
export function costCurve(process: ProcessId, material: string, g: CostGeometry, qtys: number[], opts: CostOptions): { qty: number; unit: number }[] {
  const out: { qty: number; unit: number }[] = [];
  for (const q of qtys) {
    const e = estimateCost(process, material, g, q, opts);
    if (e) out.push({ qty: q, unit: e.unit });
  }
  return out;
}

/** Quantities spread evenly on a log scale from lo to hi. */
export function logQuantities(lo = 1, hi = 100000, perDecade = 8): number[] {
  const out: number[] = [];
  const a = Math.log10(lo);
  const b = Math.log10(hi);
  const n = Math.max(1, Math.round((b - a) * perDecade));
  for (let i = 0; i <= n; i++) {
    const q = Math.round(10 ** (a + ((b - a) * i) / n));
    if (!out.includes(q)) out.push(q);
  }
  return out;
}

/**
 * The quantity from which `b` makes each part cheaper than `a`, searched between
 * lo and hi; null when it never does (or always does).
 */
export function crossover(unitA: (q: number) => number, unitB: (q: number) => number, lo = 1, hi = 1000000): number | null {
  const diff = (q: number) => unitB(q) - unitA(q);
  if (diff(lo) <= 0) return null;
  const qs = logQuantities(lo, hi, 12);
  for (let i = 1; i < qs.length; i++) {
    if (diff(qs[i]) <= 0) {
      // the first whole quantity where b wins
      let a = qs[i - 1];
      let b = qs[i];
      while (b - a > 1) {
        const mid = Math.floor((a + b) / 2);
        if (diff(mid) <= 0) b = mid;
        else a = mid;
      }
      return b;
    }
  }
  return null;
}
