// Wear and service life: what wears out on a machine, roughly when, and the
// maintenance that keeps it going. Lives are hours of running at the design's
// loads (motor `load:`, the bearing calculations, sand pressure), and runs of
// the longest simulated job when there is one, using what the simulation
// measured (run time, battery used) over the design's own currents. These are
// catalog-typical figures: brushes, bearings, fans and cells vary a lot from
// maker to maker, so every life says how it was worked out and how far to
// trust it.

import type { CheckItem } from "../core/checks";
import type { EvalPart, Model } from "../core/model";
import type { ShapeRecipe } from "../kernel/recipe";
import { fmtNum } from "../lang/values";
import { materialRecord } from "../library/materialDb";
import { catalogPart } from "./catalog";
import { motorCurrentFor } from "./checks";
import { motorSupplies, supplyFacts } from "./erc";
import type { CalcTrace, MachineComponent } from "./types";
import type { ScenarioDef } from "../sim/scenario";

/** What one simulated run showed, for the lives counted in runs. */
export interface UseFacts {
  /** the scenario's label */
  label: string;
  /** how long the job took, s */
  time: number;
  /** charge the battery gave over the run, mAh */
  batteryUsed?: number;
}

export interface ServiceTask {
  /** hours of running between doing it; 0 for before every run */
  every: number;
  task: string;
}

export interface WearItem {
  id: string;
  /** component or part name in the source */
  name: string;
  label: string;
  /** what wears */
  what: string;
  /** hours of running until it needs replacing; undefined for parts that only need looking after */
  life?: number;
  /** charge cycles, for batteries */
  cycles?: number;
  /** how the life was worked out */
  basis: string;
  confidence: "standard" | "estimate" | "rough";
  tasks: ServiceTask[];
  /** what to replace it with, or how */
  replace?: string;
  parts: string[];
}

export interface ServicePlan {
  /** the run lives are counted in, when the design has a simulation */
  use?: { label: string; hours: number; measured: boolean };
  /** sand, dust or water around the machine: seals and abrasion matter */
  dirty: boolean;
  items: WearItem[];
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const named = (mc: MachineComponent) => (mc.role ? `${mc.name} (${mc.role})` : mc.name);

function hasFlight(s: ShapeRecipe | null | undefined): Extract<ShapeRecipe, { t: "flight" }> | undefined {
  if (!s) return undefined;
  if (s.t === "flight") return s;
  if (s.t === "xform") return hasFlight(s.shape);
  if (s.t === "union") for (const x of s.shapes) if (hasFlight(x)) return hasFlight(x);
  return undefined;
}

function flightOf(p: EvalPart) {
  return hasFlight(p.recipe.base) ?? p.recipe.ops.map((o) => ("shape" in o && o.op === "add" ? hasFlight(o.shape) : undefined)).find(Boolean);
}

const calcOut = (c: CalcTrace, re: RegExp) => c.outputs.find((o) => re.test(o.label))?.value;

/** Specific wear rate against dry sand (three-body abrasion), mm³ per N·m slid. Rough handbook values. */
function abrasion(material: string): number {
  if (/TPU|rubber|urethane/i.test(material)) return 1e-4;
  const r = materialRecord(material);
  if (r?.category === "metal") return /alumin/i.test(r.name) ? 1e-4 : 2e-5;
  return 5e-4;
}

function isDirty(model: Model): boolean {
  const b = model.brief;
  const sandWorld = (model.scenarios ?? []).some((s) => s.spec.world?.kind === "sand_pit");
  if (sandWorld) return true;
  if (!b) return false;
  return !!b.outdoor || /\b(sand|soil|dust|dirt|mud|buried|underground)\b/i.test([b.setting, b.purpose, ...b.exposure].join(" "));
}

/** Everything that wears on the machine, with its life and upkeep. */
export function servicePlan(model: Model, use?: UseFacts): ServicePlan {
  const m = model.machine;
  const dirty = isDirty(model);
  if (!m?.components.length) return { dirty, items: [] };
  const supplies = motorSupplies(m);
  const current = motorCurrentFor(m, supplies);
  const supply = supplyFacts(m, current);
  const job = mainScenario(model);
  const scenarioHours = (job?.spec.duration ?? 0) / 3600;
  const runH = use ? use.time / 3600 : scenarioHours || undefined;
  const items: WearItem[] = [];
  const add = (x: WearItem) => items.push(x);

  for (const mc of m.components) {
    const part = catalogPart(mc.catalogId);
    if (!part) continue;
    const s = part.specs;
    const base = { id: `wear:${mc.name}`, name: mc.name, label: named(mc), parts: [mc.name] };
    const count = mc.count > 1 ? ` (all ${mc.count})` : "";
    switch (part.kind) {
      case "gearmotor": {
        const v = supplies.get(mc.name) ?? num(s.v_rated) ?? 12;
        const ts = (num(s.t_stall) ?? 0) * (v / (num(s.v_rated) ?? v));
        const frac = mc.load !== undefined && ts > 0 ? mc.load / ts : undefined;
        // brushed motors: about 2,000 h at a quarter of stall, shorter the harder they work
        const life = 2000 * Math.min(2, Math.max(0.4, 0.25 / Math.max(frac ?? 0.3, 0.02)));
        add({
          ...base,
          what: "brushes and gearbox",
          life,
          basis: `brushed gearmotor at ${fmtNum((frac ?? 0.3) * 100, 0)} % of stall torque${frac === undefined ? " (no load: given, assumed)" : ""}: about 2,000 h at a quarter of stall, less when it works harder`,
          confidence: "rough",
          tasks: [
            { every: 50, task: `${mc.name}: listen for grinding and feel for play at the output shaft; check its mounting screws are tight` },
            ...(dirty ? [{ every: 10, task: `${mc.name}: brush sand and dust off the motor can and its vents` }] : []),
          ],
          replace: `the same motor (${part.name})`,
        });
        break;
      }
      case "stepper":
        add({ ...base, what: "bearings", life: 20000, basis: "stepper motors have no brushes: their ball bearings set the life, about 20,000 h", confidence: "estimate", tasks: [{ every: 200, task: `${mc.name}: check the pulley or coupler grub screw is tight on the flat` }] });
        break;
      case "fan": {
        const vital = /hotend|heatsink/i.test(mc.role ?? "");
        add({
          ...base,
          what: "sleeve bearing",
          life: 20000,
          basis: "small sleeve-bearing fans last about 20,000 h at 40 °C, less when hot or dusty",
          confidence: "estimate",
          tasks: [
            { every: dirty ? 50 : 300, task: `${mc.name}: blow the dust out of it${dirty ? " and its vents" : ""}` },
            ...(vital ? [{ every: 0, task: `${mc.name}: check it spins: if the hotend fan stops, the hotend jams` }] : []),
          ],
          replace: `the same size fan (${fmtNum(num(s.size) ?? 40)} mm, ${fmtNum(num(s.v) ?? 12)} V)`,
        });
        break;
      }
      case "battery": {
        const cap = num(s.capacity_mah) ?? 2000;
        const measured = use?.batteryUsed;
        const designUsed = runH !== undefined ? supply.out(mc.name) * runH * 1000 : undefined;
        const used = measured ?? designUsed;
        const dod = used !== undefined ? Math.min(1, Math.max(0.05, used / cap)) : 0.8;
        // LiPo: about 300 cycles to 80 % capacity at full depth, more when shallower
        const cycles = Math.min(1500, 300 * Math.pow(1 / dod, 1.2));
        const life = runH !== undefined ? cycles * runH : undefined;
        add({
          ...base,
          what: "cells (capacity fades)",
          cycles,
          life,
          basis: `LiPo: about 300 charge cycles to 80 % capacity at full depth; ${measured !== undefined ? `each "${use!.label}" run used ${fmtNum(dod * 100, 0)} % in simulation` : designUsed !== undefined ? `each run uses up to ${fmtNum(dod * 100, 0)} % at the design's full working current (the simulation gives the real figure once it has run)` : `each charge given ${fmtNum(dod * 100, 0)} % deep (assumed)`}, and one charge a run, so about ${fmtNum(cycles, 0)} charges`,
          confidence: "estimate",
          tasks: [
            { every: 0, task: `${mc.name}: check it is not puffed or dented; balance-charge it` },
            { every: 0, task: `${mc.name}: put it on storage charge (3.8 V a cell) if it will sit for more than a few days` },
          ],
          replace: `a new pack of the same size and connector (${part.name})`,
        });
        break;
      }
      case "seal": {
        const life = dirty ? 200 : 5000;
        add({
          ...base,
          what: "lips",
          life,
          basis: dirty ? "rubber lip seals running in sand or dust wear their lips in a few hundred hours" : "lip seals in clean conditions last thousands of hours",
          confidence: "rough",
          tasks: [{ every: dirty ? 10 : 200, task: `${mc.name}${count}: wipe the lip clean and re-grease it; replace it if sand gets past` }],
          replace: `the same seal (${part.name})`,
        });
        break;
      }
      case "hotend":
        add({ ...base, what: "brass nozzle", life: 500, basis: "brass nozzles last about 500 h with PLA and PETG, far less with glow-in-the-dark or fibre-filled filament", confidence: "rough", tasks: [{ every: 100, task: `${mc.name}: clean the nozzle and check for leaks around it` }], replace: "a new nozzle of the same size (hardened steel for abrasive filament)" });
        break;
      case "extruder":
        add({ ...base, what: "drive gears", basis: "the gears last years; filament dust clogs them", confidence: "estimate", tasks: [{ every: 100, task: `${mc.name}: brush filament dust out of the drive gears` }] });
        break;
      case "lead_screw":
        add({ ...base, what: "nut and thread", basis: "lead screws wear their nut when run dry", confidence: "estimate", tasks: [{ every: 100, task: `${mc.name}${count}: wipe clean and put on a thin film of PTFE or lithium grease` }] });
        break;
      case "rod":
      case "rail":
      case "linear_bearing":
        add({ ...base, what: part.kind === "linear_bearing" ? "balls" : "running surface", basis: "dry or dirty runners wear and rattle", confidence: "estimate", tasks: [{ every: 100, task: `${mc.name}${count}: wipe clean and oil lightly` }] });
        break;
      case "pulley":
        add({ ...base, what: "belt and teeth", basis: "belts stretch in their first hours and slowly after", confidence: "estimate", tasks: [{ every: 100, task: `${mc.name}${count}: check the grub screws and the belt tension` }] });
        break;
      case "actuator":
      case "servo":
        add({ ...base, what: "gears", basis: "small plastic or metal gear trains wear play into them", confidence: "estimate", tasks: [{ every: 20, task: `${mc.name}: check for play at the ${part.kind === "actuator" ? "rod end" : "horn"} and that it holds position` }] });
        break;
    }
  }

  // bearings the design calculated: L10 life at their load and speed
  for (const c of m.calcs) {
    if (c.fn !== "bearing_life") continue;
    const l10 = calcOut(c, /L10/);
    if (l10 === undefined) continue;
    const code = /Bearing ([^\s:]+)/.exec(c.title)?.[1] ?? c.name;
    const life = dirty ? Math.min(l10, 500) : l10;
    add({
      id: `wear:${c.name}`,
      name: c.name,
      label: `Bearing ${code}`,
      what: "races and balls",
      life,
      basis: `L10 life from calc.bearing_life: ${hrs(l10)} at its load and speed${dirty && l10 > 500 ? ", but in sand the seals in front of it decide: given 500 h" : ""}`,
      confidence: dirty ? "rough" : "standard",
      tasks: [{ every: dirty ? 20 : 500, task: `bearing ${code}: turn it by hand; replace it if it feels gritty or rough` }],
      replace: `a ${code}${dirty ? "-2RS (sealed both sides)" : ""} bearing`,
      parts: [],
    });
  }

  // screw flights scraping through sand: three-body abrasion at the tip (Archard)
  if (dirty) {
    const sand = m.calcs.find((c) => c.fn === "sand_stress");
    const kpa = sand ? Math.max(calcOut(sand, /Horizontal stress/) ?? 0, calcOut(sand, /Vertical stress/) ?? 0) : 8;
    for (const p of model.parts) {
      if (p.kind !== "part") continue;
      const f = flightOf(p);
      if (!f) continue;
      const motor = pickMotor(model, p);
      const rpm = motor?.rpm ?? 100;
      const v = (rpm / 60) * Math.PI * (f.d / 1000); // m/s at the tip
      const k = abrasion(p.material);
      const mmPerH = k * (kpa / 1000) * v * 3600;
      const allow = 2;
      add({
        id: `wear:${p.name}`,
        name: p.name,
        label: p.label,
        what: "flight edges",
        life: allow / Math.max(mmPerH, 1e-9),
        basis: `sand scraping the ${fmtNum(f.d)} mm flights at ${fmtNum(v, 2)} m/s under about ${fmtNum(kpa, 0)} kPa: about ${fmtNum(mmPerH * 1000, 0)} µm an hour off the edge in ${p.material} (Archard, ${k} mm³/N·m)${motor ? `, turned by ${motor.name} at ${fmtNum(rpm, 0)} rpm` : ", 100 rpm assumed"}; replace at ${allow} mm worn`,
        confidence: "rough",
        tasks: [{ every: 5, task: `${p.name}: measure the flight diameter; reprint it once it is ${fmtNum(f.d - 2 * allow)} mm or less` }],
        replace: `a reprint of ${p.name}${k > 2e-4 ? " (TPU or a harder material wears slower)" : ""}`,
        parts: [p.id],
      });
    }
  }

  items.sort((a, b) => (a.life ?? Infinity) - (b.life ?? Infinity));
  return { use: runH !== undefined ? { label: use?.label ?? job?.label ?? "run", hours: runH, measured: !!use } : undefined, dirty, items };
}

/** The machine's job: the first simulation that starts on a full charge with nothing going wrong. */
export function mainScenario(model: Model): ScenarioDef | undefined {
  return (model.scenarios ?? []).find((s) => !s.spec.faults?.length && s.spec.charge >= 0.99);
}

/** The gearmotor that turns a part: one whose role or name shares a word with the part ("front screw" for front_screw), else the first. */
function pickMotor(model: Model, p: EvalPart): { name: string; rpm: number } | undefined {
  const m = model.machine!;
  const words = p.name.toLowerCase().split(/[_\s]+/).filter((w) => w.length > 2);
  const motors = m.components.filter((c) => c.kind === "gearmotor");
  const score = (c: MachineComponent) => words.filter((w) => `${c.role ?? ""} ${c.name}`.toLowerCase().includes(w)).length;
  const mc = [...motors].sort((a, b) => score(b) - score(a))[0];
  const part = mc && catalogPart(mc.catalogId);
  if (!mc || !part) return undefined;
  const s = part.specs;
  const v = motorSupplies(m).get(mc.name) ?? num(s.v_rated) ?? 12;
  const k = v / (num(s.v_rated) ?? v);
  const ts = (num(s.t_stall) ?? 0) * k;
  const nf = (num(s.rpm_free) ?? 0) * k;
  const frac = mc.load !== undefined && ts > 0 ? Math.min(1, mc.load / ts) : 0.3;
  return { name: mc.name, rpm: nf * (1 - frac) };
}

// ---------------------------------------------------------------- text

const hrs = (h: number) => (h >= 1e6 ? `${fmtNum(h / 1e6, 0)} million h` : h >= 10000 ? `${fmtNum(h / 1000, 0)},000 h` : h >= 100 ? `${fmtNum(Math.round(h / 10) * 10, 0)} h` : `${fmtNum(h, h < 10 ? 1 : 0)} h`);

/** A life in hours and, with a simulated run, in runs. */
export function lifeText(plan: ServicePlan, x: WearItem): string {
  if (x.life === undefined) return x.cycles !== undefined ? `about ${fmtNum(x.cycles, 0)} charges` : "looked after, not replaced";
  const runs = plan.use ? x.life / plan.use.hours : undefined;
  const r = runs !== undefined ? ` (${runs >= 1000 ? `${fmtNum(runs / 1000, 1)}k` : fmtNum(runs, 0)} runs)` : "";
  return `about ${hrs(x.life)}${r}${x.cycles !== undefined ? `, ${fmtNum(x.cycles, 0)} charges` : ""}`;
}

/** Maintenance grouped by interval, shortest first. */
export function schedule(plan: ServicePlan): { every: number; tasks: string[] }[] {
  const by = new Map<number, string[]>();
  for (const x of plan.items) for (const t of x.tasks) by.set(t.every, [...(by.get(t.every) ?? []), t.task]);
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([every, tasks]) => ({ every, tasks }));
}

export function intervalText(plan: ServicePlan, every: number): string {
  if (every === 0) return "Before every run";
  const runs = plan.use ? every / plan.use.hours : undefined;
  return `Every ${hrs(every)} of running${runs !== undefined && runs >= 1.5 ? ` (about ${fmtNum(runs, 0)} runs)` : ""}`;
}

/** The build pack's service.md. */
export function serviceMd(plan: ServicePlan, name: string): string {
  const L = [`# Service and wear: ${name}`, ""];
  if (!plan.items.length) return [...L, "Nothing on this machine is known to wear out or need upkeep.", ""].join("\n");
  L.push(
    `Lives are hours of running at the design's loads${plan.use ? `, and runs of "${plan.use.label}" (${fmtNum(plan.use.hours * 60, 0)} min each, ${plan.use.measured ? "as simulated" : "the simulation's length"})` : ""}. They are typical figures for these kinds of parts: real ones vary, and ${plan.dirty ? "sand and dust shorten them" : "heat, dust and overloads shorten them"}. Keep a log of hours or runs so you know when each job is due.`,
    "",
    "## What wears",
    "",
    "| Part | What wears | Life | How it was worked out | Replace with |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const x of plan.items) L.push(`| ${x.label} | ${x.what} | ${lifeText(plan, x)} | ${x.basis} (${x.confidence}) | ${x.replace ?? "—"} |`);
  L.push("", "## Maintenance schedule", "");
  for (const g of schedule(plan)) {
    L.push(`### ${intervalText(plan, g.every)}`, "");
    for (const t of g.tasks) L.push(`- [ ] ${t}`);
    L.push("");
  }
  return L.join("\n");
}

/** Checks: a summary of the shortest lives, and a warning for anything that wears out within a few runs. */
export function serviceItems(plan: ServicePlan): CheckItem[] {
  const timed = plan.items.filter((x) => x.life !== undefined);
  if (!plan.items.length) return [];
  const out: CheckItem[] = [];
  const soon = (x: WearItem) => (plan.use ? x.life! / plan.use.hours < 20 : x.life! < 20);
  for (const x of timed.filter(soon)) {
    const once = plan.use ? x.life! < plan.use.hours : false;
    out.push({
      id: `${x.id}`,
      category: "engineering",
      status: once ? "fail" : "warn",
      title: once ? `${x.label} wears out within one run` : `${x.label} wears out soon: ${lifeText(plan, x)}`,
      detail: `${x.what}: ${x.basis}.`,
      parts: x.parts,
      basis: "calculation",
      fix: `Plan for it (${x.tasks[0]?.task ?? "replace it"}), or make it last longer: a harder-wearing material, less load or a slower speed.`,
    });
  }
  const first = timed.slice(0, 3);
  const plan0 = schedule(plan)[0];
  out.push({
    id: "wear:summary",
    category: "engineering",
    status: "info",
    title: first.length ? `Service life: ${first[0].label} wears first, ${lifeText(plan, first[0])}` : "Service: upkeep only",
    detail: `${first.length ? `Shortest lives: ${first.map((x) => `${x.label} ${x.what} ${lifeText(plan, x)}`).join("; ")}. ` : ""}${plan0 ? `First job: ${intervalText(plan, plan0.every).toLowerCase()}: ${plan0.tasks[0]}.` : ""} The full schedule is in the Build tab and the build pack's service.md.`,
    parts: first.flatMap((x) => x.parts),
    basis: "calculation",
  });
  return out;
}
