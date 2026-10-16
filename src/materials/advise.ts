// The material advisor: ranks materials for one part (or for the design as a
// whole) against what the brief says it must survive, the loads it carries,
// how it is made, what it costs and what it weighs. Every number comes from
// the material database, the part's real geometry and its latest strength
// analysis, never from memory, and every ranking says why.
//
// Pure: callers gather the facts (materials/context reads them from the live
// design), so the same ranking feeds the picker, the brief, the checks and
// Claude's compare_materials tool.

import { MATERIAL_DB, materialRecord, pricePerKg, type CostForm, type MaterialRecord } from "../library/materialDb";
import { allowableStress, mechMaterial } from "../analysis/materials";
import { fmtNum } from "../lang/values";
import type { V3 } from "../kernel/recipe";
import type { ProcessId } from "../mfg/types";
import { PROCESSES } from "../mfg/profiles";

// ---------- what the advisor is told ----------

/** Things a part needs that the brief does not say. Claude passes these from what the part is for. */
export const NEEDS = ["flexible", "soft", "clear", "low friction", "wear resistant", "stiff", "strong", "light", "cheap", "tough", "conducts heat", "conducts electricity", "insulates", "food safe", "chemical resistant"] as const;
export type Need = (typeof NEEDS)[number];

/** Needs that rule a material out when it lacks them (a seal must be soft, a window clear). */
const CRITICAL: Need[] = ["soft", "clear", "conducts electricity", "insulates"];

export interface BriefFacts {
  temp?: [number, number];
  outdoor?: boolean;
  exposure: string[];
  /** most important first */
  priorities: string[];
  quantity?: number;
  look?: string;
  /** grams, for the whole design */
  maxMass?: number;
  material?: string;
  /** the brief's process, when Kerf has rules for it */
  process?: ProcessId;
  /** Claude assumed the process rather than the user giving it */
  processAssumed?: boolean;
}

export interface AnalysisFacts {
  label: string;
  /** required safety factor */
  target: number;
  cycles?: number;
  /** the analysis treats FDM parts as weaker between layers */
  printed: boolean;
  /** the material the analysis used for this part */
  material: string;
  /** peak von Mises stress in this part, MPa */
  stress: number;
  /** peak stress across the print layers, MPa (printed analyses) */
  layerStress: number | null;
  /** peak deflection, mm */
  disp: number;
  maxDeflection?: number;
  /** self-weight is part of the load, which also changes with density */
  gravity: boolean;
  /** every solid in the analysis is this part, so the stresses scale exactly with a new material */
  exact: boolean;
}

export interface PartFacts {
  /** block name in the source */
  name: string;
  label: string;
  /** instances of the block (a for loop makes several) */
  count: number;
  material: string;
  finish?: string;
  color: string;
  process?: ProcessId;
  /** the part sets process: itself (the brief's default does not count) */
  processOwn: boolean;
  /** a library component or an imported body: bought, not made */
  bought?: boolean;
  /** mm³, all instances together */
  volume?: number;
  /** one instance, in its own frame */
  bbox?: [V3, V3];
  /** brief uses that load this part */
  loads: { text: string; load: number; cycles?: number }[];
  /** the design has loads that name no part */
  designLoads?: boolean;
  /** grams of everything else in the design, for the brief's mass limit */
  otherMass?: number;
  analysis?: AnalysisFacts;
}

export interface AdviceRequest {
  brief: BriefFacts | null;
  part?: PartFacts;
  needs?: Need[];
  /** limit the comparison to these materials (the current one is always included) */
  candidates?: string[];
  /** never suggest a material the part's own process cannot make */
  keepProcess?: boolean;
}

// ---------- what it answers ----------

export type Grade = "good" | "ok" | "poor" | "fail" | "info";

export interface Criterion {
  key: string;
  /** one or two words: "Heat", "Strength" */
  label: string;
  /** the number, short: "90 °C", "≈ 3.4" */
  value: string;
  grade: Grade;
  /** a sentence with the numbers behind it */
  why: string;
  /** how much it counts in the ranking (0: shown, not counted) */
  weight: number;
  /** 0..1 for continuous criteria; otherwise from the grade */
  score?: number;
}

export interface ProcessChange {
  from?: ProcessId;
  to: ProcessId;
  why: string;
}

export interface MaterialOption {
  name: string;
  label: string;
  /** 0..1, higher is better; -1 for unsuitable */
  score: number;
  verdict: "recommended" | "good" | "possible" | "poor" | "unsuitable";
  current: boolean;
  /** the brief names this material */
  inBrief: boolean;
  criteria: Criterion[];
  pros: string[];
  cons: string[];
  /** one line for a tile or chip */
  summary: string;
  /** how the part would be made in it */
  process?: ProcessId;
  processChange?: ProcessChange;
  /** made a different way from the part's (or the brief's) process: listed after the ones that keep it */
  otherWay?: boolean;
  /** the look to preview and apply */
  finish: string;
  color: string;
  /** grams, all instances */
  mass?: number;
  /** material cost in USD, all instances */
  cost?: number;
  costForm?: CostForm;
  /** from the latest analysis, scaled to this material */
  estimate?: { safety: number; target: number; deflection: number; exact: boolean };
}

export interface Advice {
  /** "the lid" or "the design" */
  subject: string;
  /** what the ranking took into account, in plain words */
  basis: string[];
  /** ranked, best first; unsuitable ones last */
  options: MaterialOption[];
  recommended?: string;
}

// ---------- reading the brief ----------

const PROCESS_LABEL: Record<ProcessId, string> = {
  fdm: "FDM printing",
  sla: "resin printing",
  sls: "SLS printing",
  cnc_mill: "CNC milling",
  cnc_lathe: "CNC turning",
  injection: "injection moulding",
  die_cast: "die casting",
  sheet_metal: "sheet metal",
  laser_cut: "laser cutting",
};
export const processLabel = (id: ProcessId) => PROCESS_LABEL[id];

interface Conditions {
  hot?: { c: number; assumed: boolean };
  cold?: number;
  sun: boolean;
  wet: boolean;
  salt: boolean;
  impact: boolean;
  food: boolean;
  oil: boolean;
  chemicals: boolean;
}

function conditions(b: BriefFacts | null, needs: Set<Need>): Conditions {
  const ex = b?.exposure ?? [];
  const has = (re: RegExp) => ex.some((e) => re.test(e));
  const sun = b?.outdoor === true || has(/sun|uv/i);
  // a part left in the sun gets well above the air temperature
  const hot = b?.temp ? { c: b.temp[1], assumed: false } : sun ? { c: 50, assumed: true } : undefined;
  return {
    hot,
    cold: b?.temp?.[0],
    sun,
    wet: b?.outdoor === true || has(/rain|water|humid|wet|salt|sea|marine/i),
    salt: has(/salt|sea|marine/i),
    impact: has(/impact|drop|knock/i) || needs.has("tough"),
    food: has(/food|drink/i) || needs.has("food safe"),
    oil: has(/oil|fuel|grease/i),
    chemicals: has(/chemical|solvent|cleaner|acid|alkali/i) || needs.has("chemical resistant"),
  };
}

/** How much each kind of criterion counts, from the brief's priorities (most important first). */
function priorityWeights(b: BriefFacts | null): Record<"strength" | "stiffness" | "mass" | "cost" | "durability" | "looks" | "precision", number> {
  const w = { strength: 0, stiffness: 0, mass: 0, cost: 0, durability: 0, looks: 0, precision: 0 };
  const ladder = [3, 2.5, 2, 1.6, 1.3, 1.1];
  (b?.priorities ?? []).forEach((p, i) => {
    const k = p.toLowerCase();
    const v = ladder[i] ?? 1;
    if (/strength|safety/.test(k)) w.strength = Math.max(w.strength, v);
    if (/stiff/.test(k)) w.stiffness = Math.max(w.stiffness, v);
    if (/weight|light/.test(k)) w.mass = Math.max(w.mass, v);
    if (/cost|cheap|price/.test(k)) w.cost = Math.max(w.cost, v);
    if (/durab|wear|life/.test(k)) w.durability = Math.max(w.durability, v);
    if (/look|appear|finish/.test(k)) w.looks = Math.max(w.looks, v);
    if (/precision|accura/.test(k)) w.precision = Math.max(w.precision, v);
  });
  return w;
}

/** Needs read from what the part is called; shown as such and never ruling a material out. */
export function needsFromName(name: string): Need[] {
  const n = name.toLowerCase().replace(/[_\-.]+/g, " ");
  const out: Need[] = [];
  if (/\b(hinge|clip|snap|latch|flexure|spring)/.test(n)) out.push("flexible");
  if (/\b(gear|bushing|bush|slider|slide|cam|pulley|roller|sprocket|worm)/.test(n)) out.push("low friction", "wear resistant");
  if (/\b(window|lens|diffuser|light ?pipe|viewport)/.test(n)) out.push("clear");
  if (/\b(seal|gasket|bumper|grip|o ?ring|damper)/.test(n)) out.push("soft");
  if (/\b(heat ?sink|cold ?plate)/.test(n)) out.push("conducts heat");
  return out;
}

// ---------- helpers ----------

const n0 = (v: number) => fmtNum(v, 0);
const n1 = (v: number) => fmtNum(v, Math.abs(v) < 10 ? 1 : 0);
const gpa = (mpa: number) => (mpa >= 1000 ? `${fmtNum(mpa / 1000, mpa >= 10000 ? 0 : 1)} GPa` : `${n0(mpa)} MPa`);
export const money = (usd: number) => (usd >= 100 ? `$${n0(usd)}` : usd >= 1 ? `$${usd.toFixed(2)}` : `${n0(usd * 100)}¢`);
export const grams = (g: number) => (g >= 1000 ? `${fmtNum(g / 1000, 2)} kg` : `${fmtNum(g, g < 10 ? 1 : 0)} g`);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const SCORE: Record<Grade, number> = { good: 1, ok: 0.65, poor: 0.25, fail: 0, info: 0 };
const gradeOf = (s: number): Grade => (s >= 0.7 ? "good" : s >= 0.4 ? "ok" : "poor");
/** 0.5 at the reference, 1 at 4× better, 0 at 4× worse (log scale) */
/** 0.5 at the reference, about 0.27 at twice it and 0.73 at half (for lower-is-better), and never flat, so a 3× heavier metal does not tie a 9× heavier one. */
const relative = (v: number, ref: number, higherBetter: boolean) => (v > 0 && ref > 0 ? 1 / (1 + (higherBetter ? ref / v : v / ref) ** (1 / Math.LN2)) : 0.5);
/** For strength and stiffness without an analysis: falling short costs a lot, but beyond 4× the reference more does not help. */
const enough = (v: number, ref: number) => {
  if (!(v > 0 && ref > 0)) return 0.5;
  const r = v / ref;
  return r >= 1 ? 0.65 + 0.35 * Math.min(1, Math.log2(r) / 2) : 0.65 * r ** 1.2;
};

function median(xs: number[]): number {
  const s = xs.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!s.length) return 0;
  return s[Math.floor(s.length / 2)];
}

/** Can this material be made by this process? */
const suits = (m: MaterialRecord, p: ProcessId) => m.processes.includes(p) && !m.processNotes?.[p];

function plateLike(bbox: [V3, V3] | undefined, m: MaterialRecord): boolean {
  if (!bbox || m.laserMaxT === undefined) return false;
  const d = [0, 1, 2].map((k) => bbox[1][k] - bbox[0][k]).sort((a, b) => a - b);
  return d[0] <= m.laserMaxT && d[0] <= 0.15 * d[1];
}

const TOOLED: ProcessId[] = ["injection", "die_cast"];
/** Moulds and dies pay for themselves from about this many parts. */
const TOOLING_QTY = 500;

/** The process the part (or the design) is meant to be made by. */
const homeProcess = (part: PartFacts | undefined, brief: BriefFacts | null): ProcessId | undefined => (part?.bought ? undefined : (part?.process ?? brief?.process));

/** How a part would usually be made in this material: cut from sheet only when it is a plate, moulded only by the thousand, else the material's usual way. A process with a caution is used only when nothing clean can make the shape. */
function naturalProcess(m: MaterialRecord, part: PartFacts | undefined, brief: BriefFacts | null): ProcessId | undefined {
  const clean = m.processes.filter((p) => !m.processNotes?.[p]);
  const plate = plateLike(part?.bbox, m);
  if (plate && clean.includes("laser_cut")) return "laser_cut";
  const fits = (p: ProcessId) => plate || (p !== "laser_cut" && p !== "sheet_metal");
  const pool = [clean.filter(fits), m.processes.filter(fits), clean, m.processes].find((l) => l.length) ?? [];
  const volume = (brief?.quantity ?? 1) >= TOOLING_QTY;
  const tooled = pool.filter((p) => TOOLED.includes(p));
  const untooled = pool.filter((p) => !TOOLED.includes(p));
  return volume ? (tooled[0] ?? untooled[0]) : (untooled[0] ?? tooled[0]);
}

/** The process the part would be made by in this material, and whether that is a change. */
function processFor(m: MaterialRecord, part: PartFacts | undefined, brief: BriefFacts | null): { process?: ProcessId; change?: ProcessChange; blocked?: string } {
  if (part?.bought) return {};
  const now = homeProcess(part, brief);
  if (now && suits(m, now)) return { process: now };
  const to = naturalProcess(m, part, brief);
  if (!to) return {};
  if (!now || to === now) return { process: to };
  const change: ProcessChange = { from: now, to, why: m.processNotes?.[now] ?? `${PROCESS_LABEL[now]} cannot make ${m.label}` };
  if (part?.processOwn) return { process: to, change, blocked: `${part.label} is set to be made by ${PROCESS_LABEL[now]}, which cannot make ${m.label}` };
  return { process: to, change };
}

const PRINTING: ProcessId[] = ["fdm", "sla", "sls"];

/** The surface each process usually leaves, best first. */
const PROCESS_FINISH: Partial<Record<ProcessId, string[]>> = {
  fdm: ["printed", "matte"],
  sla: ["matte", "gloss"],
  sls: ["matte"],
  injection: ["gloss", "satin", "matte", "textured"],
  die_cast: ["bead-blasted", "powder-coated"],
  cnc_mill: ["machined", "bead-blasted", "brushed"],
  cnc_lathe: ["machined", "polished", "brushed"],
  sheet_metal: ["brushed", "bead-blasted", "powder-coated"],
};

/** The finish a material would get here: the current one when unchanged, a protective one when wet, a clear one when the look asks, else what the process leaves. */
function finishFor(m: MaterialRecord, part: PartFacts | undefined, c: Conditions, process: ProcessId | undefined, look: string): string {
  if (part && part.material === m.name && part.finish && m.finishes.includes(part.finish)) return part.finish;
  if (c.wet && m.category === "metal") {
    if (/Aluminum/.test(m.name) && m.finishes.includes("anodized")) return "anodized";
    if (m.wet && m.finishes.includes("powder-coated")) return "powder-coated";
    if (m.wet && m.finishes.includes("zinc-plated")) return "zinc-plated";
  }
  if (/clear|transparent|see.through/.test(look) && m.finishes.includes("clear") && process !== "fdm") return "clear";
  const pref = process ? PROCESS_FINISH[process]?.find((f) => m.finishes.includes(f)) : undefined;
  if (pref) return pref;
  return (process === "fdm" ? undefined : m.finishes.find((f) => f !== "printed")) ?? m.finishes[0];
}

/** Colour a material is shown in: the part's own colour carries over between plastics, metals keep their real tone. */
export function colorFor(m: MaterialRecord, current: { material: string; color: string } | undefined): string {
  if (!current) return m.color;
  if (m.name === current.material) return current.color;
  const from = materialRecord(current.material);
  if (m.category === "plastic" && from?.category === "plastic" && !m.finishes.includes("clear") && m.palette.length > 2) return current.color;
  return m.color;
}

/** Material actually bought for the part: printed parts use what they weigh, machined ones the stock block, cut ones the sheet, moulded ones a little extra for runners. */
function boughtVolume(part: PartFacts, process: ProcessId | undefined): number | undefined {
  if (part.volume === undefined) return undefined;
  if (!part.bbox || !process) return part.volume;
  const d = [0, 1, 2].map((k) => part.bbox![1][k] - part.bbox![0][k]);
  switch (process) {
    case "cnc_mill":
    case "cnc_lathe":
      return (d[0] + 5) * (d[1] + 5) * (d[2] + 5) * part.count;
    case "sheet_metal":
    case "laser_cut":
      return d[0] * d[1] * d[2] * 1.2 * part.count;
    case "injection":
    case "die_cast":
      return part.volume * 1.1;
    default:
      return part.volume;
  }
}

/** What the material for a made part costs, bought in the form its process uses (filament, bar stock, sheet...); material only. */
export function stockCost(m: MaterialRecord, part: PartFacts, brief: BriefFacts | null): { cost: number; form: CostForm; perKg: number; process?: ProcessId } | null {
  if (part.bought) return null;
  const process = processFor(m, part, brief).process;
  const price = pricePerKg(m, process);
  const v = boughtVolume(part, process);
  if (!price || v === undefined) return null;
  return { cost: (v / 1e6) * m.density * price.price, form: price.form, perKg: price.price, process };
}

// ---------- one material ----------

interface Shared {
  req: AdviceRequest;
  c: Conditions;
  needs: Set<Need>;
  inferred: Set<Need>;
  w: ReturnType<typeof priorityWeights>;
  /** reference values the relative criteria compare against */
  ref: { allow: number; E: number; mass: number; cost: number };
  loaded: boolean;
}

function allowableFor(m: MaterialRecord, cycles: number | undefined, printed: boolean): { value: number; text: string } {
  const a = allowableStress(mechMaterial(m.name), cycles);
  const lf = printed ? m.mech.layerFactor : 1;
  const text = `${a.basis === "fatigue" ? `fatigue strength ${n0(a.value)} MPa` : `yield ${n0(a.value)} MPa`}${lf < 1 ? `, ${n0(a.value * lf)} MPa between layers` : ""}`;
  return { value: a.value * lf, text };
}

function evaluateOne(m: MaterialRecord, s: Shared): MaterialOption {
  const { req, c, needs, w } = s;
  const part = req.part;
  const brief = req.brief;
  const crit: Criterion[] = [];
  const add = (k: Criterion) => crit.push(k);
  const made = processFor(m, part, brief);
  const printed = made.process === "fdm";
  const finish = finishFor(m, part, c, made.process, brief?.look?.toLowerCase() ?? "");
  const cycles = part?.loads.reduce<number | undefined>((mx, l) => (l.cycles && (!mx || l.cycles > mx) ? l.cycles : mx), undefined) ?? part?.analysis?.cycles;

  // ---- heat and cold ----
  if (c.hot) {
    const margin = m.maxC - c.hot.c;
    const grade: Grade = margin < 0 ? "fail" : margin < 10 ? "poor" : margin < 25 ? "ok" : "good";
    const where = c.hot.assumed ? `${n0(c.hot.c)} °C (assumed for a part in the sun)` : `the ${n0(c.hot.c)} °C in the brief`;
    add({
      key: "heat",
      label: "Heat",
      value: `${n0(m.maxC)} °C`,
      grade: c.hot.assumed && grade === "fail" ? "poor" : grade,
      why: margin < 0 ? `${m.label} softens around ${n0(m.maxC)} °C, below ${where}` : `${m.label} holds its shape to about ${n0(m.maxC)} °C, ${n0(margin)} °C above ${where}`,
      weight: c.hot.assumed ? 2 : 3,
    });
  } else add({ key: "heat", label: "Heat", value: `${n0(m.maxC)} °C`, grade: "info", why: `${m.label} holds its shape to about ${n0(m.maxC)} °C`, weight: 0 });
  if (c.cold !== undefined && c.cold < m.minC) add({ key: "cold", label: "Cold", value: `${n0(m.minC)} °C`, grade: "poor", why: `${m.label} turns brittle below about ${n0(m.minC)} °C, and the brief goes down to ${n0(c.cold)} °C`, weight: 2 });

  // ---- where it lives ----
  if (c.sun) {
    const g: Grade = m.sunlight === "good" ? "good" : m.sunlight === "fair" ? "ok" : "poor";
    add({ key: "sun", label: "Sunlight", value: m.sunlight === "good" ? "UV-stable" : m.sunlight === "fair" ? "fades" : "degrades", grade: g, why: g === "good" ? `${m.label} resists sunlight` : g === "ok" ? `${m.label} fades slowly in sunlight; a UV-stable or dark colour lasts longer` : `${m.label} fades and turns brittle in sunlight`, weight: 2.5 });
  }
  if (c.wet) {
    const coated = ["anodized", "powder-coated", "zinc-plated"].includes(finish);
    const g: Grade = !m.wet ? "good" : coated ? "ok" : "poor";
    add({ key: "wet", label: "Water", value: !m.wet ? "fine wet" : coated ? `${finish.replace("-", " ")}` : "suffers", grade: g, why: !m.wet ? `${m.label} copes with getting wet` : coated ? `${m.wet}; the ${finish.replace("-", " ")} finish protects it while it is intact` : m.wet, weight: 2 });
  }
  if (c.salt) add({ key: "salt", label: "Salt water", value: m.salt, grade: m.salt === "good" ? "good" : m.salt === "fair" ? "ok" : "poor", why: m.salt === "good" ? `${m.label} resists salt water` : m.salt === "fair" ? `${m.label} pits or stains in salt water over time${m.name === "Stainless 304" ? "; 316 is the marine grade" : ""}` : `${m.label} corrodes in salt water`, weight: 3 });
  if (c.oil) add({ key: "oil", label: "Oil", value: m.oil, grade: m.oil === "good" ? "good" : m.oil === "fair" ? "ok" : "poor", why: `${m.label} ${m.oil === "good" ? "is unaffected by oil and grease" : m.oil === "fair" ? "swells or stains slowly in oil" : "is attacked by oil"}`, weight: 2 });
  if (c.chemicals) add({ key: "chemicals", label: "Chemicals", value: m.solvents, grade: m.solvents === "good" ? "good" : m.solvents === "fair" ? "ok" : "poor", why: `${m.label} ${m.solvents === "good" ? "resists most solvents and cleaners" : m.solvents === "fair" ? "resists mild cleaners, not strong solvents" : "is attacked or cracked by solvents"}`, weight: needs.has("chemical resistant") ? 3 : 2 });
  if (c.food) {
    const g: Grade = m.food === "good" ? (printed ? "ok" : "good") : m.food === "fair" ? "ok" : "poor";
    add({ key: "food", label: "Food", value: m.food === "good" ? "food grades" : m.food, grade: g, why: `${m.foodNote ?? (m.food === "good" ? `Food-safe grades of ${m.label} are common` : m.food === "fair" ? `Only some grades of ${m.label} are food safe` : `${m.label} is not used for food contact`)}${printed && m.food !== "poor" ? "; printed layer lines still trap food" : ""}`, weight: 3 });
  }
  if (c.impact || w.durability || s.loaded) {
    const g: Grade = m.toughness === "tough" ? "good" : m.toughness === "fair" ? "ok" : "poor";
    // a loaded part that cracks without warning is worse than one that bends first
    add({ key: "impact", label: "Toughness", value: m.toughness, grade: g, why: m.impact ?? `${m.label} is ${m.toughness === "tough" ? "tough and takes knocks" : "fairly tough"}`, weight: Math.max(c.impact ? 2.5 : 0, w.durability, s.loaded ? 1 : 0) });
  }

  // ---- strength and stiffness ----
  const loaded = s.loaded;
  const a = part?.analysis;
  let estimate: MaterialOption["estimate"];
  if (a) {
    const allow = allowableStress(mechMaterial(m.name), a.cycles ?? cycles);
    const layerOk = printed && a.printed && m.mech.layerFactor < 1 && a.layerStress !== null && a.layerStress > 0;
    const sfVm = a.stress > 0 ? allow.value / a.stress : Infinity;
    const sfL = layerOk ? (allow.value * m.mech.layerFactor) / a.layerStress! : Infinity;
    const sf = Math.min(sfVm, sfL);
    const E0 = mechMaterial(a.material).E;
    const defl = a.disp * (E0 / m.mech.E);
    estimate = { safety: sf, target: a.target, deflection: defl, exact: a.exact && !a.gravity };
    const g: Grade = sf < 1 ? "fail" : sf < 0.85 * a.target ? "poor" : sf < a.target ? "ok" : "good";
    const approx = a.exact && !a.gravity ? "" : " (approximate: the analysis has other parts or self-weight)";
    add({
      key: "strength",
      label: "Strength",
      value: `SF ≈ ${sf >= 100 ? "100+" : fmtNum(sf, sf < 10 ? 1 : 0)}`,
      grade: g,
      why: `Scaled from "${a.label}": safety factor about ${fmtNum(sf, 2)} against a target of ${fmtNum(a.target, 1)}${sfL < sfVm ? ", limited by the bond between print layers" : ""}${approx}`,
      weight: Math.max(3, w.strength),
      score: g === "fail" ? 0 : clamp01(0.35 + 0.65 * Math.min(1, sf / (1.5 * a.target))),
    });
    const limit = a.maxDeflection;
    const gd: Grade = limit === undefined ? gradeOf(relative(1 / defl, 1 / (a.disp * (E0 / s.ref.E)), true)) : defl > limit ? "poor" : defl > 0.8 * limit ? "ok" : "good";
    add({
      key: "stiffness",
      label: "Deflection",
      value: `${fmtNum(defl, defl < 1 ? 2 : 1)} mm`,
      grade: gd,
      why: `Deflects about ${fmtNum(defl, 3)} mm under "${a.label}"${limit !== undefined ? `, limit ${fmtNum(limit, 2)} mm` : ""} (stiffness ${gpa(m.mech.E)})`,
      weight: Math.max(limit !== undefined ? 2.5 : 1, w.stiffness, needs.has("stiff") ? 2.5 : 0),
    });
  } else {
    const al = allowableFor(m, cycles, printed);
    const sw = Math.max(w.strength, loaded ? 1.5 : 0, needs.has("strong") ? 2.5 : 0);
    const sc = enough(al.value, s.ref.allow);
    add({ key: "strength", label: "Strength", value: `${n0(al.value)} MPa`, grade: sw ? gradeOf(sc) : "info", why: `${m.label}: ${al.text}${loaded ? ". Run an analysis to see the safety factor in each material" : ""}`, weight: sw, score: sc });
    const kw = Math.max(w.stiffness, w.precision * 0.6, loaded ? 0.8 : 0, needs.has("stiff") ? 2.5 : 0);
    const ks = enough(m.mech.E, s.ref.E);
    add({ key: "stiffness", label: "Stiffness", value: gpa(m.mech.E), grade: kw ? gradeOf(ks) : "info", why: `${m.label} has a stiffness (Young's modulus) of ${gpa(m.mech.E)}`, weight: kw, score: ks });
  }

  // ---- creep under a load that stays on ----
  const held = part?.loads.some((l) => !l.cycles || l.cycles < 1000);
  if (held && m.category !== "metal") {
    let g: Grade = m.creep === "high" ? "poor" : m.creep === "some" ? "ok" : "good";
    let why = `${m.label} ${m.creep === "high" ? "creeps under a load held for months" : m.creep === "some" ? "creeps a little under a load held for months" : "resists creep well"}`;
    if (a && m.creepLimit) {
      const sigma = a.stress;
      const lim = m.creepLimit * m.mech.yield;
      g = sigma > lim ? "poor" : sigma > 0.7 * lim ? "ok" : "good";
      why = `Peak stress ${n1(sigma)} MPa against a long-term limit of about ${n1(lim)} MPa for ${m.label}`;
    }
    if (c.hot && c.hot.c > m.maxC - 25 && g !== "poor") {
      g = "poor";
      why += `, and it creeps faster near ${n0(c.hot.c)} °C`;
    }
    add({ key: "creep", label: "Creep", value: m.creep, grade: g, why, weight: 2 });
  }

  // ---- mass and cost ----
  let mass: number | undefined;
  let cost: number | undefined;
  let costForm: CostForm | undefined;
  if (part?.volume !== undefined) {
    mass = (part.volume / 1000) * m.density;
    const mw = Math.max(w.mass, needs.has("light") ? 2.5 : 0, 0.5);
    let grade = gradeOf(relative(mass, s.ref.mass, false));
    let why = `${grams(mass)}${part.count > 1 ? ` for all ${part.count}` : ""} at ${fmtNum(m.density, 2)} g/cm³`;
    if (brief?.maxMass && part.otherMass !== undefined && part.otherMass + mass > brief.maxMass) {
      grade = "fail";
      why += `, which takes the design to ${grams(part.otherMass + mass)}, over its ${grams(brief.maxMass)} limit`;
    }
    add({ key: "mass", label: "Mass", value: grams(mass), grade, why, weight: brief?.maxMass ? Math.max(mw, 2) : mw, score: grade === "fail" ? 0 : relative(mass, s.ref.mass, false) });
    const price = part.bought ? null : pricePerKg(m, made.process);
    const bought = boughtVolume(part, made.process);
    if (price && bought !== undefined) {
      costForm = price.form;
      cost = (bought / 1e6) * m.density * price.price;
      const cw = Math.max(w.cost, needs.has("cheap") ? 2.5 : 0, 1);
      const qty = brief?.quantity && brief.quantity > 1 ? brief.quantity : 1;
      add({
        key: "cost",
        label: "Material",
        value: money(cost),
        grade: gradeOf(relative(cost, s.ref.cost, false)),
        why: `About ${money(cost)} of ${price.form === "stock" ? "bar or plate stock" : price.form} at ${money(price.price)}/kg${qty > 1 ? `, ${money(cost * qty)} for ${qty}` : ""}; material only, not machine time or tooling`,
        weight: cw,
        score: relative(cost, s.ref.cost, false),
      });
    }
  }

  // ---- making it ----
  if (made.process) {
    let g: Grade = "good";
    let why = `Made by ${PROCESS_LABEL[made.process]}`;
    let weight = 2;
    if (made.blocked && req.keepProcess !== false) {
      g = "fail";
      why = made.blocked;
    } else if (made.change) {
      g = "ok";
      weight = 4;
      why = `Made by ${PROCESS_LABEL[made.change.to]} instead: ${made.change.why}`;
      // leaving the user's own printer for a machine shop, or a mould for one-offs, is a big step
      const from = made.change.from;
      if (from && PRINTING.includes(from) !== PRINTING.includes(made.change.to)) g = "poor";
      if (from && TOOLED.includes(from) && !TOOLED.includes(made.change.to) && (brief?.quantity ?? 1) >= TOOLING_QTY) g = "poor";
    }
    const caveat = m.processNotes?.[made.process];
    if (caveat && g !== "fail") {
      g = "poor";
      why += `. ${caveat}`;
    }
    if (printed && m.printNote) {
      why += `. ${m.printNote}`;
      if (g === "good" && /needs|warp|hard|slow|dry|harden|fumes/i.test(m.printNote)) g = /hard to print|warps/i.test(m.printNote) && !/enclosed/i.test(m.printNote) ? "poor" : "ok";
    }
    // a material that warps even in an enclosure fails more prints than one that only needs the enclosure
    // and one the process struggles with (gummy to machine, cracks when bent) ranks below one it makes cleanly
    const score = caveat && g === "poor" ? 0.1 : g === "ok" && printed && /warps/i.test(m.printNote ?? "") ? 0.5 : undefined;
    add({ key: "making", label: "Made by", value: PROCESSES[made.process].short, grade: g, why, weight, score });
  }

  // ---- what the part needs ----
  const needRow = (need: Need, ok: Grade, why: string) => {
    const critical = CRITICAL.includes(need) && !s.inferred.has(need);
    add({ key: `need:${need}`, label: need.charAt(0).toUpperCase() + need.slice(1), value: ok === "good" ? "yes" : ok === "ok" ? "partly" : "no", grade: ok === "poor" && critical ? "fail" : ok, why, weight: s.inferred.has(need) ? 1.5 : 3 });
  };
  for (const need of needs) {
    switch (need) {
      case "flexible":
        needRow(need, m.snapStrain >= 0.04 ? "good" : m.snapStrain >= 0.025 ? "ok" : "poor", `${m.label} bends to about ${fmtNum(m.snapStrain * 100, 1)} % strain in a clip or hinge without breaking`);
        break;
      case "soft":
        needRow(need, m.mech.E < 100 ? "good" : "poor", m.mech.E < 100 ? `${m.label} is soft and rubbery` : `${m.label} is rigid (${gpa(m.mech.E)}), not soft`);
        break;
      case "clear":
        needRow(need, m.finishes.includes("clear") ? "good" : m.finishes.includes("frosted") ? "ok" : "poor", m.finishes.includes("clear") ? `${m.label} can be clear` : `${m.label} is not transparent`);
        break;
      case "low friction":
        needRow(need, m.friction === "low" ? "good" : m.friction === "normal" ? "ok" : "poor", `${m.label} ${m.friction === "low" ? "is slippery: it runs against itself and metal without grease" : m.friction === "normal" ? "has ordinary friction" : "is grippy"}`);
        break;
      case "wear resistant":
        needRow(need, m.wear === "good" ? "good" : m.wear === "fair" ? "ok" : "poor", `${m.label} ${m.wear === "good" ? "resists wear" : m.wear === "fair" ? "wears moderately" : "wears or galls when it rubs"}`);
        break;
      case "conducts heat":
        needRow(need, m.conductivity >= 100 ? "good" : m.conductivity >= 15 ? "ok" : "poor", `${m.label} conducts heat at ${fmtNum(m.conductivity, m.conductivity < 1 ? 2 : 0)} W/(m·K)`);
        break;
      case "conducts electricity":
        needRow(need, m.electrical === "conductor" ? "good" : "poor", `${m.label} ${m.electrical === "conductor" ? "conducts electricity" : "is an insulator"}`);
        break;
      case "insulates":
        needRow(need, m.electrical === "insulator" ? "good" : "poor", `${m.label} ${m.electrical === "insulator" ? "insulates" : "conducts electricity"}`);
        break;
      default:
        // stiff, strong, light, cheap, tough, food safe and chemical resistant weigh the criteria above
        break;
    }
  }

  // ---- the look the brief asks for ----
  const look = brief?.look?.toLowerCase() ?? "";
  if (look) {
    let g: Grade | null = null;
    let why = "";
    if (/clear|transparent|see.through/.test(look)) [g, why] = m.finishes.includes("clear") ? ["good", `${m.label} can be clear, as the brief's look asks`] : ["poor", `The brief asks for a clear look; ${m.label} is not transparent`];
    else if (/metal|alumin|steel|brass|chrome|anodi/.test(look)) [g, why] = m.category === "metal" ? ["good", `A real ${m.label} finish, as the brief's look asks`] : ["ok", `The brief's look is metallic; ${m.label} would only imitate it`];
    else if (/wood/.test(look)) [g, why] = m.family === "wood" ? ["good", "Real wood, as the brief's look asks"] : ["ok", "The brief's look is wood"];
    if (g) add({ key: "look", label: "Look", value: g === "good" ? "matches" : "differs", grade: g, why, weight: Math.max(1.5, w.looks) });
  }

  // ---- score ----
  const counted = crit.filter((k) => k.weight > 0 && k.grade !== "info");
  const fail = counted.some((k) => k.grade === "fail");
  const total = counted.reduce((t, k) => t + k.weight, 0);
  const score = fail ? -1 : total ? counted.reduce((t, k) => t + k.weight * (k.score ?? SCORE[k.grade]), 0) / total : 0.5;
  const ordered = [...counted].sort((x, y) => y.weight - x.weight);
  const pros = ordered.filter((k) => k.grade === "good").slice(0, 3).map((k) => short(k, m));
  const cons = ordered.filter((k) => k.grade === "poor" || k.grade === "fail").map((k) => short(k, m));
  const current = part?.material === m.name;
  return {
    name: m.name,
    label: m.label,
    score,
    verdict: fail ? "unsuitable" : score >= 0.7 ? "good" : score >= 0.5 ? "possible" : "poor",
    current,
    inBrief: brief?.material === m.name,
    criteria: crit,
    pros,
    cons,
    summary: summaryLine(pros, cons, made.change),
    process: made.process,
    processChange: made.change,
    otherWay: !!made.change,
    finish,
    color: colorFor(m, part ? { material: part.material, color: part.color } : undefined),
    mass,
    cost,
    costForm,
    estimate,
  };
}

/** A few words for a criterion, for chips and tiles. */
function short(k: Criterion, m: MaterialRecord): string {
  switch (k.key) {
    case "heat":
      return k.grade === "fail" ? `softens at ${n0(m.maxC)} °C` : `holds ${n0(m.maxC)} °C`;
    case "cold":
      return `brittle below ${n0(m.minC)} °C`;
    case "sun":
      return k.grade === "good" ? "UV-stable" : "fades in sunlight";
    case "wet":
      return k.grade === "good" ? "fine wet" : k.grade === "ok" ? "needs its coating" : m.category === "metal" ? "rusts" : "suffers when wet";
    case "salt":
      return k.grade === "good" ? "salt-proof" : "corrodes in salt";
    case "oil":
      return k.grade === "good" ? "oil-proof" : "dislikes oil";
    case "chemicals":
      return k.grade === "good" ? "chemical-proof" : "solvent-sensitive";
    case "food":
      return k.grade === "good" ? "food grades" : "not for food";
    case "impact":
      return k.grade === "good" ? "tough" : "brittle";
    case "strength":
      return k.grade === "fail" ? "too weak" : k.grade === "good" ? (k.value.startsWith("SF") ? `strong (${k.value})` : "strong") : "weaker";
    case "stiffness":
      return k.grade === "good" ? "stiff" : "flexes more";
    case "creep":
      return k.grade === "good" ? "little creep" : "creeps";
    case "mass":
      return k.grade === "fail" ? "too heavy" : k.grade === "good" ? "light" : "heavy";
    case "cost":
      return k.grade === "good" ? `cheap (${k.value})` : `costly (${k.value})`;
    case "making":
      return k.grade === "fail" ? "can't be made this way" : k.grade === "good" ? "easy to make" : /enclosed/i.test(k.why) ? "needs an enclosed printer" : /nozzle/i.test(k.why) ? "needs a hardened nozzle" : /instead/.test(k.why) ? "changes the process" : "harder to make";
    case "look":
      return k.grade === "good" ? "the look asked for" : "a different look";
    default:
      return k.grade === "good" ? k.label.toLowerCase() : `not ${k.label.toLowerCase()}`;
  }
}

function summaryLine(pros: string[], cons: string[], change?: ProcessChange): string {
  const p = pros.slice(0, 2).join(", ");
  const c = cons.slice(0, 2).join(", ");
  const s = [p && p.charAt(0).toUpperCase() + p.slice(1), c && (p ? c : c.charAt(0).toUpperCase() + c.slice(1))].filter(Boolean).join("; ");
  return change && !cons.includes("changes the process") ? `${s}${s ? "; " : ""}made by ${PROCESS_LABEL[change.to]}` : s;
}

// ---------- the ranking ----------

/** Rank materials for a part, or for the design when no part is given. */
export function adviseMaterials(req: AdviceRequest): Advice {
  const part = req.part;
  const inferred = new Set<Need>(part ? needsFromName(part.name).filter((n) => !(req.needs ?? []).includes(n)) : []);
  const needs = new Set<Need>([...(req.needs ?? []), ...inferred]);
  const c = conditions(req.brief, needs);
  const w = priorityWeights(req.brief);
  const loaded = !!part && (part.loads.length > 0 || !!part.analysis || !!part.designLoads);

  // who takes part: everyday materials, plus special ones a need, the brief or the part itself calls for
  const wantSpecial = (m: MaterialRecord) =>
    (needs.has("soft") && m.mech.E < 100) ||
    (needs.has("flexible") && m.name === "TPU") ||
    ((needs.has("conducts heat") || needs.has("conducts electricity")) && m.electrical === "conductor") ||
    (needs.has("insulates") && m.name === "FR4");
  const pool = MATERIAL_DB.filter((m) => {
    if (req.candidates?.length) return req.candidates.includes(m.name) || m.name === part?.material;
    if (m.name === part?.material || m.name === req.brief?.material) return true;
    if (m.special) return wantSpecial(m);
    // castings only for parts made by the thousand, or already cast
    if (m.processes.every((p) => p === "die_cast")) return (req.brief?.quantity ?? 1) >= 500 || part?.process === "die_cast";
    if (m.name === "Aluminum A380") return (req.brief?.quantity ?? 1) >= 500 || part?.process === "die_cast";
    return true;
  });

  // reference values for the relative criteria: the current material, else the middle of the pool
  const cur = materialRecord(part?.material ?? req.brief?.material);
  const proc = (m: MaterialRecord) => processFor(m, part, req.brief).process;
  const cyc = part?.loads.reduce<number | undefined>((mx, l) => (l.cycles && (!mx || l.cycles > mx) ? l.cycles : mx), undefined);
  const allowOf = (m: MaterialRecord) => allowableFor(m, cyc, proc(m) === "fdm").value;
  const massOf = (m: MaterialRecord) => ((part?.volume ?? 0) / 1000) * m.density;
  const costOf = (m: MaterialRecord) => {
    const p = pricePerKg(m, proc(m));
    const v = part ? boughtVolume(part, proc(m)) : undefined;
    return p && v !== undefined ? (v / 1e6) * m.density * p.price : 0;
  };
  const ref = cur
    ? { allow: allowOf(cur), E: cur.mech.E, mass: massOf(cur), cost: costOf(cur) }
    : { allow: median(pool.map(allowOf)), E: median(pool.map((m) => m.mech.E)), mass: median(pool.map(massOf)), cost: median(pool.map(costOf)) };

  const shared: Shared = { req, c, needs, inferred, w, ref, loaded };
  const options = pool.map((m) => evaluateOne(m, shared));
  // materials that keep the part's process come first; the rest are "if made another way"
  const rank = (o: MaterialOption) => (o.verdict === "unsuitable" ? 2 : o.otherWay ? 1 : 0);
  options.sort((a, b) => rank(a) - rank(b) || b.score - a.score || (a.current ? -1 : b.current ? 1 : 0));
  const best = options.find((o) => o.verdict !== "unsuitable");
  if (best) best.verdict = "recommended";

  const basis: string[] = [];
  const b = req.brief;
  if (b?.temp) basis.push(`${n0(b.temp[0])} to ${n0(b.temp[1])} °C`);
  else if (c.hot?.assumed) basis.push("about 50 °C in the sun (assumed)");
  const env = [c.sun && "sunlight", c.wet && (c.salt ? "salt water" : "water"), c.oil && "oil", c.chemicals && "chemicals", c.food && "food contact", c.impact && "impacts"].filter(Boolean);
  if (env.length) basis.push(env.join(", "));
  for (const l of part?.loads ?? []) basis.push(`${n0(l.load)} N: ${l.text}${l.cycles ? `, ${l.cycles.toExponential(0)} cycles` : ""}`);
  if (part?.analysis) basis.push(`analysis "${part.analysis.label}" (safety target ${fmtNum(part.analysis.target, 1)})`);
  const pr = homeProcess(part, b);
  if (pr) basis.push(`${PROCESS_LABEL[pr]}${part?.processOwn ? "" : b?.process === pr ? ` (from the brief${b.processAssumed ? ", assumed" : ""})` : ""}`);
  if (b?.priorities.length) basis.push(`priorities: ${b.priorities.slice(0, 3).join(", ")}`);
  if (needs.size) basis.push(`needs: ${[...needs].map((n) => (inferred.has(n) ? `${n} (from the name)` : n)).join(", ")}`);
  if (b?.quantity && b.quantity > 1) basis.push(`quantity ${b.quantity}`);

  return { subject: part ? part.label : "the design", basis, options, recommended: best?.name };
}

// ---------- for Claude ----------

/** The advisor's answer as text: ranked options with their numbers, and why the others lose. */
export function adviceText(a: Advice, limit = 5): string {
  const lines: string[] = [];
  lines.push(`Materials for ${a.subject}, ranked against: ${a.basis.join("; ") || "no brief yet (general use)"}.`);
  const usable = a.options.filter((o) => o.verdict !== "unsuitable");
  const same = usable.filter((o) => !o.otherWay).slice(0, limit);
  const other = usable.filter((o) => o.otherWay).slice(0, same.length ? Math.min(3, limit) : limit);
  const shown = [...same, ...other];
  const cur = a.options.find((o) => o.current);
  if (cur && !shown.includes(cur)) shown.push(cur);
  const entry = (o: MaterialOption) => {
    const head = `${o.verdict === "recommended" ? "★ " : ""}${o.label} (${o.name})${o.current ? " [current]" : ""}${o.inBrief ? " [brief]" : ""}: score ${fmtNum(Math.max(0, o.score), 2)}, ${o.verdict}`;
    const facts = o.criteria.filter((k) => k.weight > 0 || k.key === "heat").map((k) => `${k.label} ${k.value} [${k.grade}]: ${k.why}`);
    lines.push(`- ${head}. Finish "${o.finish}"${o.processChange ? `; switches to ${processLabel(o.processChange.to)} (${o.processChange.why})` : ""}.\n    ${facts.join("\n    ")}`);
  };
  same.forEach(entry);
  if (other.length && same.length) lines.push("If made another way:");
  other.forEach(entry);
  if (cur && !same.includes(cur) && !other.includes(cur)) entry(cur);
  const out = a.options.filter((o) => o.verdict === "unsuitable" && !shown.includes(o));
  if (out.length) {
    lines.push("Ruled out:");
    for (const o of out.slice(0, 8)) lines.push(`- ${o.label}: ${o.criteria.filter((k) => k.grade === "fail").map((k) => k.why).join("; ")}`);
  }
  lines.push("Numbers are typical datasheet values for the grade; the cost is material only. Safety factors marked ≈ are the latest analysis scaled to each material; re-run the analysis after switching.");
  return lines.join("\n");
}
