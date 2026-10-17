// The manufacturing advisor: for one part, every way of making it (process
// and the best material for that process and the part's use), checked
// against the part's real geometry, priced at each quantity, and ranked for a
// prototype, a small batch and production. It answers "how should I make
// this, and what changes as the quantity grows", within the processes the
// user can actually use.
//
// Pure: callers gather the facts (mfg/plan reads them from the live design),
// so the same plan feeds the make panel and Claude's plan_manufacturing tool.

import { MATERIAL_DB, materialRecord } from "../library/materialDb";
import { adviseMaterials, money, type BriefFacts, type MaterialOption, type Need, type PartFacts } from "../materials/advise";
import { PROCESSES, PROCESS_IDS } from "./profiles";
import { summarize } from "./report";
import { crossover, estimateCost, fmtDays, logQuantities, type CostEstimate, type CostGeometry } from "./cost";
import { withStats } from "./geometry";
import type { Access, Availability } from "./availability";
import type { ProcessId, ProcessResult } from "./types";

// ---------- what it is told ----------

export interface PlanRequest {
  /** the part block (all its instances) as the material advisor sees it */
  part: PartFacts;
  /** one instance's measurements */
  geometry: CostGeometry;
  brief: BriefFacts | null;
  needs?: Need[];
  access: Availability;
  /** process check results for this part, by process (missing: not checked yet) */
  fits: Partial<Record<ProcessId, ProcessResult>>;
  /** how many of the whole design: one tier each (see defaultTiers) */
  tiers: Tier[];
  /** what an hour of your own hands-on time is worth, $ */
  labour?: number;
  /** limit the plan to these processes */
  only?: ProcessId[];
}

export interface Tier {
  /** how many of the design */
  qty: number;
  label: string;
  /** the brief's own quantity */
  brief?: boolean;
}

/** A prototype, a small batch and production, plus the brief's own quantity when it is something else. */
export function defaultTiers(briefQty?: number): Tier[] {
  const tiers: Tier[] = [
    { qty: 1, label: "Prototype" },
    { qty: 50, label: "Small batch" },
    { qty: 5000, label: "Production" },
  ];
  if (briefQty && briefQty >= 1) {
    const same = tiers.find((t) => t.qty === briefQty);
    if (same) same.brief = true;
    else tiers.push({ qty: briefQty, label: "Your quantity", brief: true });
  }
  return tiers.sort((a, b) => a.qty - b.qty);
}

// ---------- what it answers ----------

export type RouteStatus = "ok" | "needs-changes" | "unavailable" | "no-material";

export interface Route {
  process: ProcessId;
  material: string;
  materialLabel: string;
  /** the material advisor's score for this material made this way, 0..1 */
  materialScore: number;
  materialVerdict: MaterialOption["verdict"] | "none";
  /** the material differs from the part's */
  materialChange: boolean;
  finish: string;
  color: string;
  access: Access;
  /** the geometry checks for this process; null until they have run */
  fit: { fail: number; warn: number; issues: string[] } | null;
  status: RouteStatus;
  /** one per tier, for that tier's number of parts */
  costs: (CostEstimate | null)[];
  /** one per tier, 0..1 (-1: not a candidate) */
  scores: number[];
  tolerance: number;
  /** surface straight off the process, in a few words */
  surface: string;
  /** the part is made this way now */
  current: boolean;
  /** a few words on what makes this route stand out or fall short */
  pros: string[];
  cons: string[];
}

export interface TierPlan extends Tier {
  /** parts needed: the design quantity × copies of the part in one design */
  parts: number;
  recommended?: Route;
  cheapest?: Route;
  best?: Route;
  /** better routes the user cannot use yet, or could use after design changes */
  hints: string[];
}

export interface Band {
  process: ProcessId;
  material: string;
  /** from this many parts (inclusive) */
  from: number;
  /** up to this many parts (inclusive); undefined: and beyond */
  to?: number;
}

export interface ManufacturingPlan {
  part: string;
  label: string;
  /** copies of the part in one design */
  count: number;
  routes: Route[];
  tiers: TierPlan[];
  /** the cheapest usable route at each quantity, as ranges of parts */
  bands: Band[];
  basis: string[];
  /** what the costs were worked out from, to draw cost curves */
  geometry: CostGeometry;
  labour?: number;
}

// ---------- process qualities ----------

/** What each process leaves and how it compares on looks (0..1), for parts whose looks matter. */
const SURFACE: Record<ProcessId, [string, number]> = {
  fdm: ["visible layer lines", 0.45],
  sla: ["smooth, fine detail", 0.9],
  sls: ["grainy matte", 0.6],
  cnc_mill: ["machined, fine tool marks", 0.85],
  cnc_lathe: ["turned, fine finish", 0.85],
  injection: ["as moulded, any texture", 1],
  die_cast: ["smooth cast skin", 0.8],
  sheet_metal: ["flat sheet with bends", 0.75],
  laser_cut: ["clean cut edges", 0.8],
  sand_cast: ["rough sand texture", 0.3],
  investment_cast: ["smooth cast skin", 0.8],
  vacuum_cast: ["smooth, any colour", 0.9],
  metal_print: ["rough, grainy", 0.45],
};

const surfaceOf = (p: ProcessId): [string, number] => SURFACE[p] ?? ["", 0.6];

/** 1 for ±0.05 mm or better, falling to about 0.2 at ±1 mm. */
const precisionScore = (tol: number) => Math.max(0.15, Math.min(1, 1 - 0.37 * Math.log2(Math.max(tol, 0.05) / 0.05)));

interface Weights {
  cost: number;
  material: number;
  precision: number;
  looks: number;
  speed: number;
}

/** How much each kind of criterion counts, from the brief's priorities (most important first). */
function weights(b: BriefFacts | null): Weights {
  const w: Weights = { cost: 2.5, material: 2.5, precision: 0.5, looks: 0.5, speed: 0.4 };
  const ladder = [3, 2.5, 2, 1.6, 1.3, 1.1];
  (b?.priorities ?? []).forEach((p, i) => {
    const k = p.toLowerCase();
    const v = ladder[i] ?? 1;
    if (/cost|cheap|price/.test(k)) w.cost = Math.max(w.cost, v + 0.5);
    if (/strength|safety|durab|stiff|wear|life/.test(k)) w.material = Math.max(w.material, v + 0.5);
    if (/precision|accura|toleran|fit/.test(k)) w.precision = Math.max(w.precision, v);
    if (/look|appear|finish/.test(k)) w.looks = Math.max(w.looks, v);
    if (/time|speed|fast|quick|lead/.test(k)) w.speed = Math.max(w.speed, v);
  });
  return w;
}

/** How good a part the route makes: the material for the use, precision and surface, weighed as the brief's priorities say. */
function quality(r: Route, w: Weights): number {
  const k = [w.material, Math.max(0.6, w.precision), Math.max(0.6, w.looks)];
  return (k[0] * r.materialScore + k[1] * precisionScore(r.tolerance) + k[2] * surfaceOf(r.process)[1]) / (k[0] + k[1] + k[2]);
}

// ---------- the plan ----------

/** Special materials (flexible, soft, conductive...) only when a need, the part or the brief calls for them, as the material advisor does. */
function wanted(m: (typeof MATERIAL_DB)[number], req: PlanRequest): boolean {
  if (m.name === req.part.material || m.name === req.brief?.material) return true;
  // wood is a choice of look, not a way to save a few cents on a plastic part
  if (m.family === "wood") return /wood|timber|plywood/i.test(`${req.brief?.look ?? ""} ${req.brief?.material ?? ""}`);
  if (!m.special) return true;
  const needs = new Set(req.needs ?? []);
  return (
    (needs.has("soft") && m.mech.E < 100) ||
    (needs.has("flexible") && m.name === "TPU") ||
    ((needs.has("conducts heat") || needs.has("conducts electricity")) && m.electrical === "conductor") ||
    (needs.has("insulates") && m.name === "FR4")
  );
}

/** Alloys made for one process (A380 for die casting, AlSi10Mg for printing) are only offered for processes like it: nobody sells A380 bar to mill. */
const ORIGIN = new Set<string>(["die_cast", "sand_cast", "investment_cast", "metal_print"]);
const offered = (m: (typeof MATERIAL_DB)[number], p: ProcessId) => !ORIGIN.has(m.processes[0]) || ORIGIN.has(p);

/** Materials Kerf would make this way without a caution. */
const materialsFor = (p: ProcessId, req: PlanRequest) => MATERIAL_DB.filter((m) => m.processes.includes(p) && !m.processNotes?.[p] && offered(m, p) && wanted(m, req)).map((m) => m.name);

/**
 * The material advisor's pick for the part made this way. The part's own
 * material, the brief's, and materials of the same kind (plastic for a
 * plastic part) get a small lead, so the plan does not swap a PETG housing
 * for plywood over a few cents.
 */
function pickMaterial(req: PlanRequest, p: ProcessId): MaterialOption | null {
  const candidates = materialsFor(p, req);
  if (!candidates.length) return null;
  const advice = adviseMaterials({
    brief: req.brief,
    part: { ...req.part, process: p, processOwn: true },
    needs: req.needs,
    candidates,
    keepProcess: true,
  });
  const usable = advice.options.filter((o) => o.verdict !== "unsuitable" && !o.otherWay && candidates.includes(o.name));
  if (!usable.length) return null;
  const kind = materialRecord(req.part.material)?.category;
  const lead = (o: MaterialOption) => o.score + (o.name === req.part.material ? 0.12 : 0) + (o.name === req.brief?.material ? 0.05 : 0) + (kind && materialRecord(o.name)?.category === kind ? 0.1 : 0);
  return [...usable].sort((a, b) => lead(b) - lead(a))[0];
}

/**
 * The cost of a route at a quantity. A process you own is made on your
 * machine, unless the batch would tie it up for over a month and a shop with
 * several machines would take less than half as long.
 */
export function routeCost(p: ProcessId, material: string, g: CostGeometry, n: number, access: Access, labour?: number): CostEstimate | null {
  if (access !== "own") return estimateCost(p, material, g, n, { access: "order", labour });
  const mine = estimateCost(p, material, g, n, { access: "own", labour });
  if (!mine || mine.days[1] <= 30) return mine;
  const shop = estimateCost(p, material, g, n, { access: "order", labour });
  return shop && shop.days[1] < mine.days[1] / 2 ? shop : mine;
}

/** Lead times past two months count against a route, more the longer they get. */
const leadPenalty = (days: number) => (days <= 60 ? 1 : Math.max(0.5, 1 - 0.15 * Math.log2(days / 60)));

export function planManufacturing(req: PlanRequest): ManufacturingPlan {
  const part = req.part;
  const w = weights(req.brief);
  const ids = (req.only?.length ? req.only : PROCESS_IDS).filter((id) => PROCESSES[id]);
  const tierParts = req.tiers.map((t) => t.qty * Math.max(1, part.count));

  const routes: Route[] = [];
  for (const p of ids) {
    const access = req.access[p] ?? "order";
    const option = pickMaterial(req, p);
    const fitResult = req.fits[p];
    const summary = summarize(fitResult);
    const fit = summary ? { fail: summary.fail, warn: summary.warn, issues: summary.issues } : null;
    const material = option?.name ?? req.part.material;
    const g = withStats(req.geometry, fitResult);
    const costs = tierParts.map((n) => (option ? routeCost(p, material, g, n, access, req.labour) : null));
    const [surface] = surfaceOf(p);
    const status: RouteStatus = !option ? "no-material" : access === "none" ? "unavailable" : fit && fit.fail ? "needs-changes" : "ok";
    routes.push({
      process: p,
      material,
      materialLabel: option?.label ?? materialRecord(material)?.label ?? material,
      materialScore: option ? Math.max(0, option.score) : 0,
      materialVerdict: option?.verdict ?? "none",
      materialChange: !!option && option.name !== part.material,
      finish: option?.finish ?? "matte",
      color: option?.color ?? part.color,
      access,
      fit,
      status,
      costs,
      scores: [],
      tolerance: PROCESSES[p].tolerance,
      surface,
      current: part.process === p,
      pros: [],
      cons: [],
    });
  }

  // score every route at every tier against the cheapest usable one there
  const usable = routes.filter((r) => r.status === "ok");
  req.tiers.forEach((_, ti) => {
    const cheapest = Math.min(...usable.map((r) => r.costs[ti]?.unit ?? Infinity));
    for (const r of routes) {
      const c = r.costs[ti];
      if (!c || r.status === "no-material") {
        r.scores[ti] = -1;
        continue;
      }
      const costScore = Number.isFinite(cheapest) ? 1 / (1 + Math.log2(Math.max(1, c.unit / cheapest))) : 0.5;
      const fitScore = r.fit ? (r.fit.fail ? 0 : 1 - 0.08 * Math.min(5, r.fit.warn)) : 0.8;
      const speedScore = 1 / (1 + c.days[1] / 21);
      const parts: [number, number][] = [
        [w.cost, costScore],
        [w.material, r.materialScore],
        [w.precision, precisionScore(r.tolerance)],
        [w.looks, surfaceOf(r.process)[1]],
        [w.speed, speedScore],
        [1, fitScore],
      ];
      const total = parts.reduce((s, [k]) => s + k, 0);
      let score = parts.reduce((s, [k, v]) => s + k * v, 0) / total;
      // your own machine: no shipping, no waiting on a shop
      if (c.access === "own") score += 0.04;
      score *= leadPenalty(c.days[1]);
      r.scores[ti] = Math.max(0, Math.min(1, score));
    }
  });

  for (const r of routes) describe(r, routes, req);

  // only routes checked against the shape are picked, unless none has been checked yet
  const checked = usable.filter((r) => r.fit);
  const pickable = checked.length ? checked : usable;
  const tiers: TierPlan[] = req.tiers.map((t, ti) => {
    const ok = pickable.filter((r) => r.costs[ti]);
    const by = (list: Route[], f: (r: Route) => number) => [...list].sort((a, b) => f(b) - f(a))[0];
    const recommended = by(ok, (r) => r.scores[ti]);
    // the cheapest way that still makes a fair part: a weak material only when nothing else is cheaper
    const fair = ok.filter((r) => r.materialVerdict !== "poor");
    const cheapest = by(fair.length ? fair : ok, (r) => -(r.costs[ti]!.unit));
    // the best part money buys, within reach of the recommended route's cost
    const unit = recommended?.costs[ti]?.unit ?? Infinity;
    const premium = ok.filter((r) => r.costs[ti]!.unit <= Math.max(5 * unit, unit + 50));
    const best = by(premium, (r) => quality(r, w));
    return { ...t, parts: tierParts[ti], recommended, cheapest, best, hints: hints(routes, ti, recommended, tierParts[ti]) };
  });

  const basis: string[] = [];
  basis.push(`${part.count > 1 ? `${part.count} per design, ` : ""}${req.geometry.bbox ? sizeText(req.geometry) : ""}`.replace(/, $/, ""));
  if (req.brief?.priorities.length) basis.push(`priorities: ${req.brief.priorities.slice(0, 3).join(", ")}`);
  const own = ids.filter((id) => req.access[id] === "own");
  const off = ids.filter((id) => req.access[id] === "none");
  if (own.length) basis.push(`you have: ${own.map((id) => PROCESSES[id].short).join(", ")}`);
  if (off.length) basis.push(`not available: ${off.map((id) => PROCESSES[id].short).join(", ")}`);
  const unchecked = routes.filter((r) => !r.fit && r.status !== "no-material").length;
  if (unchecked) basis.push(`${unchecked} process${unchecked > 1 ? "es" : ""} not checked against the shape yet`);

  return { part: part.name, label: part.label, count: Math.max(1, part.count), routes: sortRoutes(routes, req.tiers), tiers, bands: bands(usable, req, Math.max(1, part.count)), basis: basis.filter(Boolean), geometry: req.geometry, labour: req.labour };
}

const sizeText = (g: CostGeometry) => {
  const d = [0, 1, 2].map((k) => g.bbox[1][k] - g.bbox[0][k]);
  return `${d.map((x) => Math.round(x)).join(" × ")} mm, ${Math.round(g.volume / 100) / 10} cm³`;
};

/** Usable routes first, best at the brief's tier (or the middle one) first. */
function sortRoutes(routes: Route[], tiers: Tier[]): Route[] {
  const ti = Math.max(0, tiers.findIndex((t) => t.brief) >= 0 ? tiers.findIndex((t) => t.brief) : Math.floor((tiers.length - 1) / 2));
  const rank = (r: Route) => (r.status === "ok" ? 0 : r.status === "needs-changes" ? 1 : r.status === "unavailable" ? 2 : 3);
  return [...routes].sort((a, b) => rank(a) - rank(b) || (b.scores[ti] ?? -1) - (a.scores[ti] ?? -1));
}

/** Short pros and cons for a route card. */
function describe(r: Route, all: Route[], req: PlanRequest) {
  const pros: string[] = [];
  const cons: string[] = [];
  if (r.access === "own") pros.push("on your own machine");
  if (r.status === "unavailable") cons.push("not in your processes");
  if (r.status === "no-material") cons.push("no material suits this part made this way");
  if (r.fit?.fail) cons.push(`${r.fit.fail} check${r.fit.fail > 1 ? "s" : ""} fail${r.fit.fail > 1 ? "" : "s"}: ${r.fit.issues[0]?.toLowerCase() ?? "the shape needs changes"}`);
  else if (r.fit?.warn) cons.push(`${r.fit.warn} warning${r.fit.warn > 1 ? "s" : ""}`);
  else if (r.fit) pros.push("the shape suits it");
  if (r.materialVerdict === "recommended" || r.materialVerdict === "good") pros.push(`${r.materialLabel} suits the use`);
  else if (r.materialVerdict === "poor") cons.push(`${r.materialLabel} is a weak fit for the use`);
  const tooling = r.costs.find((c) => c && c.tooling > 0);
  if (tooling) cons.push(`${money(tooling.tooling)} tooling`);
  else pros.push("no tooling");
  if (r.tolerance <= 0.1) pros.push(`±${r.tolerance} mm`);
  const [surface, look] = surfaceOf(r.process);
  if (look >= 0.85) pros.push(surface);
  else if (look < 0.5) cons.push(surface);
  r.pros = pros.slice(0, 4);
  r.cons = cons.slice(0, 4);
  void all;
  void req;
}

/** Why the pick is not better: a cheaper way the user cannot use, or one that needs the shape changed first. */
function hints(routes: Route[], ti: number, picked: Route | undefined, parts: number): string[] {
  const out: string[] = [];
  const unit = picked?.costs[ti]?.unit ?? Infinity;
  const cheaper = (r: Route) => (r.costs[ti]?.unit ?? Infinity) < unit * 0.7;
  const blocked = routes.filter((r) => r.status === "unavailable" && r.materialVerdict !== "none" && !(r.fit?.fail) && cheaper(r)).sort((a, b) => a.costs[ti]!.unit - b.costs[ti]!.unit)[0];
  if (blocked) out.push(`${PROCESSES[blocked.process].label} would be about ${money(blocked.costs[ti]!.unit)} each for ${parts.toLocaleString("en-US")}, but it is not in your processes.`);
  const redesign = routes.filter((r) => r.status === "needs-changes" && cheaper(r)).sort((a, b) => a.costs[ti]!.unit - b.costs[ti]!.unit)[0];
  if (redesign) out.push(`${PROCESSES[redesign.process].label} would be about ${money(redesign.costs[ti]!.unit)} each, once ${redesign.fit!.fail === 1 ? "one failing check is" : `${redesign.fit!.fail} failing checks are`} fixed: ${redesign.fit!.issues.slice(0, 2).join("; ").toLowerCase()}.`);
  return out;
}

/** The cheapest usable route as the number of parts grows, as bands with the quantity where each takes over. */
function bands(usable: Route[], req: PlanRequest, count: number): Band[] {
  if (!usable.length) return [];
  const unitOf = (r: Route) => {
    const g = withStats(req.geometry, req.fits[r.process]);
    return (n: number) => routeCost(r.process, r.material, g, n, r.access, req.labour)?.unit ?? Infinity;
  };
  const fns = new Map(usable.map((r) => [r, unitOf(r)]));
  const lo = 1;
  const hi = Math.max(100000, count * 10000);
  const cheapestAt = (n: number) => usable.reduce((best, r) => (fns.get(r)!(n) < fns.get(best)!(n) ? r : best), usable[0]);
  const out: Band[] = [];
  let cur = cheapestAt(lo);
  let from = lo;
  for (const n of logQuantities(lo, hi, 10)) {
    const next = cheapestAt(n);
    if (next === cur) continue;
    // the exact quantity where the new route takes over
    const at = crossover(fns.get(cur)!, fns.get(next)!, from, n) ?? n;
    out.push({ process: cur.process, material: cur.material, from, to: at - 1 });
    cur = next;
    from = at;
  }
  out.push({ process: cur.process, material: cur.material, from });
  return out;
}

// ---------- for Claude ----------

const parts$ = (n: number) => n.toLocaleString("en-US");

/** The plan as text: picks per tier with costs and lead times, the bands, and the routes worth knowing about. */
export function planText(plan: ManufacturingPlan): string {
  const lines: string[] = [];
  lines.push(`How to make ${plan.label}${plan.count > 1 ? ` (${plan.count} per design)` : ""}: ${plan.basis.join("; ")}.`);
  lines.push("By quantity (cost per part includes its share of setup and tooling; rough estimates for comparing, not quotes):");
  for (const t of plan.tiers) {
    const pick = (r: Route | undefined, tag: string) => {
      if (!r) return null;
      const ti = plan.tiers.indexOf(t);
      const c = r.costs[ti]!;
      return `${tag}: ${PROCESSES[r.process].label} in ${r.materialLabel}${c.access === "own" ? " (your own machine)" : r.access === "own" ? " (ordered: too many for your own machine)" : ""} ≈ ${money(c.unit)} each (${money(c.range[0])}–${money(c.range[1])}), ${money(c.total)} total${c.tooling ? ` incl. ${money(c.tooling)} tooling` : ""}, ${fmtDays(c.days)}`;
    };
    const picks = [pick(t.recommended, "recommended")];
    if (t.cheapest && t.cheapest !== t.recommended) picks.push(pick(t.cheapest, "cheapest"));
    if (t.best && t.best !== t.recommended && t.best !== t.cheapest) picks.push(pick(t.best, "best quality"));
    lines.push(`- ${t.label}, ${parts$(t.qty)} design${t.qty > 1 ? "s" : ""}${t.parts !== t.qty ? ` = ${parts$(t.parts)} parts` : ""}${t.brief ? " [brief]" : ""}:${picks.filter(Boolean).length ? "" : " no usable route"}`);
    for (const p of picks) if (p) lines.push(`    ${p}`);
    for (const h of t.hints) lines.push(`    note: ${h}`);
  }
  if (plan.bands.length) lines.push(`Cheapest usable way as the number of parts grows: ${plan.bands.map((b) => `${PROCESSES[b.process].short} ${b.to !== undefined ? `${parts$(b.from)}–${parts$(b.to)}` : `${parts$(b.from)}+`}`).join(", ")}.`);
  lines.push("Every route (status, material, checks, cost per part at each tier):");
  for (const r of plan.routes) {
    const cost = r.costs.map((c, i) => (c ? `${parts$(plan.tiers[i].parts)}: ${money(c.unit)}` : "")).filter(Boolean).join(", ");
    const fit = r.fit ? (r.fit.fail || r.fit.warn ? `${r.fit.fail} fail, ${r.fit.warn} warn (${r.fit.issues.slice(0, 3).join("; ")})` : "checks pass") : "not checked yet";
    lines.push(`- ${r.process}${r.current ? " [current]" : ""} [${r.status}${r.access !== "order" ? `, ${r.access}` : ""}]: ${r.materialLabel}${r.materialChange ? " (a change)" : ""}; ${fit}; ${cost}`);
  }
  lines.push("Costs are typical 2026 online-service and job-shop prices in US dollars; a real quote can land 0.6–2× from them. Ask the user before switching a part to a process or material that changes its cost, look or strength.");
  return lines.join("\n");
}

// ---------- the whole design ----------

export interface DesignTier extends Tier {
  /** made parts, each on its recommended route, per design */
  made: number;
  /** made parts the way they are made now (their current process), per design; null when a part has no process or no price */
  asIs: number | null;
  /** bought parts per design */
  bought: number;
  /** hand assembly per design */
  assembly: number;
  /** everything per design */
  each: number;
  /** everything for the whole quantity */
  total: number;
  /** moulds, dies and patterns for the recommended routes */
  tooling: number;
  /** the slowest part's lead time */
  days: [number, number];
  /** parts with no usable route at this quantity */
  missing: string[];
}

export interface DesignExtras {
  /** bought parts for one design, $ */
  bought: number;
  /** estimated hand assembly time for one design, seconds */
  assemblySeconds?: number;
  /** $ per hour of assembly */
  labour: number;
}

/** Practice and jigs make assembly faster: 90% each time the quantity doubles, down to 40%. */
export const assemblyLearning = (qty: number) => Math.max(0.4, Math.pow(Math.max(1, qty), Math.log2(0.9)));

/** What one design costs at each tier: its made parts on their recommended routes, the bought parts and the assembly. */
export function designTotals(plans: ManufacturingPlan[], tiers: Tier[], extras: DesignExtras): DesignTier[] {
  return tiers.map((t) => {
    let made = 0;
    let asIs: number | null = 0;
    let tooling = 0;
    let days: [number, number] = [0, 0];
    const missing: string[] = [];
    for (const plan of plans) {
      const ti = plan.tiers.findIndex((x) => x.qty === t.qty);
      const pick = ti >= 0 ? plan.tiers[ti].recommended : undefined;
      const c = pick?.costs[ti];
      if (!c) {
        missing.push(plan.label);
        continue;
      }
      made += c.total / t.qty;
      tooling += c.tooling;
      days = [Math.max(days[0], c.days[0]), Math.max(days[1], c.days[1])];
      const now = plan.routes.find((r) => r.current)?.costs[ti];
      asIs = asIs === null || !now ? null : asIs + now.total / t.qty;
    }
    const assembly = ((extras.assemblySeconds ?? 0) / 3600) * extras.labour * assemblyLearning(t.qty);
    const each = made + extras.bought + assembly;
    return { ...t, made, asIs, bought: extras.bought, assembly, each, total: each * t.qty, tooling, days, missing };
  });
}

/** The design's cost at each tier, as text for Claude. */
export function designText(plans: ManufacturingPlan[], totals: DesignTier[], extras: DesignExtras): string {
  const lines = [`Making the whole design (${plans.length} made part${plans.length === 1 ? "" : "s"}${extras.bought ? `, ${money(extras.bought)} of bought parts per design` : ""}${extras.assemblySeconds ? `, about ${Math.round(extras.assemblySeconds / 60)} min hand assembly at ${money(extras.labour)}/h` : ""}):`];
  for (const t of totals) {
    lines.push(`- ${t.label}, ${parts$(t.qty)}${t.brief ? " [brief]" : ""}: ${money(t.each)} per design (made ${money(t.made)}${t.asIs !== null && Math.abs(t.asIs - t.made) > 0.005 ? `, ${money(t.asIs)} made the way they are set now` : ""}; bought ${money(t.bought)}; assembly ${money(t.assembly)}), ${money(t.total)} in all${t.tooling ? ` incl. ${money(t.tooling)} tooling` : ""}, ${fmtDays(t.days)}${t.missing.length ? `; no usable route for ${t.missing.join(", ")}` : ""}`);
    const picks = plans
      .map((p) => {
        const ti = p.tiers.findIndex((x) => x.qty === t.qty);
        const r = ti >= 0 ? p.tiers[ti].recommended : undefined;
        return r ? `${p.part}: ${PROCESSES[r.process].short}, ${r.materialLabel}${r.current ? "" : " (a change)"}` : null;
      })
      .filter(Boolean);
    if (picks.length) lines.push(`    ${picks.join("; ")}`);
  }
  return lines.join("\n");
}
