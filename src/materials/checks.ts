// Material checks that need more than the brief: different metals touching
// in a wet design (galvanic corrosion), plastic parts creeping under a load
// that stays on, and machine-screw threads cut straight into printed plastic.
// Pure builders; materials/runtime adds them to the report.

import type { CheckItem } from "../core/checks";
import type { Brief, EvalPart, Model } from "../core/model";
import { applyXforms, type PartOp, type ShapeRecipe, type V3, type Xform } from "../kernel/recipe";
import { materialRecord, type MaterialRecord } from "../library/materialDb";
import { isPrinted, resolveFinish } from "../library/materials";
import { fmtNum } from "../lang/values";
import { adviseMaterials, type AnalysisFacts } from "./advise";
import { briefFacts } from "./brief";

// ---------- galvanic corrosion ----------

/** Finishes that keep the metal itself out of the circuit while they are intact. */
const INSULATING = ["anodized", "powder-coated", "solder-mask"];
const ZINC = 1.25;

/** The metal a part shows to the world: zinc for zinc-plated steel, nothing for coated parts and non-metals. */
function surfaceIndex(p: EvalPart): number | undefined {
  const r = materialRecord(p.material);
  if (r?.anodic === undefined) return undefined;
  const f = resolveFinish(p.material, p.finish);
  if (INSULATING.includes(f)) return undefined;
  return f === "zinc-plated" ? ZINC : r.anodic;
}

/** The largest safe difference in anodic index for where the design lives (MIL-STD-889 practice), or null when it stays dry. */
export function galvanicLimit(b: Brief | null | undefined): { volts: number; where: string } | null {
  if (!b) return null;
  const ex = b.exposure.join(" ");
  if (/salt|sea|marine/i.test(ex)) return { volts: 0.15, where: "near salt water" };
  if (b.outdoor) return { volts: 0.15, where: "outdoors" };
  if (/rain|water|humid|wet|damp|condens/i.test(ex)) return { volts: 0.25, where: "in the damp" };
  return null;
}

export interface MetalPair {
  a: EvalPart;
  b: EvalPart;
  /** the more active metal, which corrodes */
  anode: EvalPart;
  va: number;
  vb: number;
}

/** A part's box in assembly coordinates. */
export function placedBox(local: [V3, V3], xf: Xform[]): [V3, V3] {
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const c: V3 = [local[i & 1 ? 1 : 0][0], local[i & 2 ? 1 : 0][1], local[i & 4 ? 1 : 0][2]];
    const w = applyXforms(c, xf);
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], w[k]);
      hi[k] = Math.max(hi[k], w[k]);
    }
  }
  return [lo, hi];
}

const overlaps = (x: [V3, V3], y: [V3, V3], tol: number) => [0, 1, 2].every((k) => x[0][k] - tol <= y[1][k] && y[0][k] - tol <= x[1][k]);

/**
 * Pairs of different metals whose boxes meet, with a potential difference above
 * the limit. Zinc on steel or aluminium is left out: the zinc is there to be
 * sacrificed. The caller confirms contact on the real geometry.
 */
export function metalPairs(model: Model, box: (p: EvalPart) => [V3, V3] | null, limit: number, max = 60): MetalPair[] {
  const metals = model.parts
    .filter((p) => !p.hidden)
    .map((p) => ({ p, v: surfaceIndex(p), b: box(p) }))
    .filter((m): m is { p: EvalPart; v: number; b: [V3, V3] } => m.v !== undefined && !!m.b);
  const out: MetalPair[] = [];
  for (let i = 0; i < metals.length && out.length < max; i++)
    for (let j = i + 1; j < metals.length && out.length < max; j++) {
      const x = metals[i];
      const y = metals[j];
      if (x.p.name === y.p.name) continue;
      if (Math.abs(x.v - y.v) <= limit + 1e-9) continue;
      const [hi, lo] = x.v > y.v ? [x, y] : [y, x];
      if (hi.v === ZINC && lo.v >= 0.75) continue;
      if (!overlaps(x.b, y.b, 0.2)) continue;
      out.push({ a: x.p, b: y.p, anode: hi.p, va: x.v, vb: y.v });
    }
  return out;
}

const FASTENER = /^(screw|nut|bolt|washer|insert|dowel|standoff)/;
const plain = (p: EvalPart) => p.label.replace(/ #\d+$/, "") || p.name;
const metalName = (p: EvalPart) => (resolveFinish(p.material, p.finish) === "zinc-plated" ? `zinc-plated ${p.material.toLowerCase()}` : p.material);

/** One warning per pair of part blocks that touch, from the confirmed contacts. */
export function galvanicItems(pairs: MetalPair[], limit: { volts: number; where: string }): CheckItem[] {
  const byBlocks = new Map<string, MetalPair[]>();
  for (const pr of pairs) {
    const key = [pr.a.name, pr.b.name].sort().join("|");
    byBlocks.set(key, [...(byBlocks.get(key) ?? []), pr]);
  }
  const out: CheckItem[] = [];
  for (const [key, list] of byBlocks) {
    const { a, b, anode, va, vb } = list[0];
    const cathode = anode === a ? b : a;
    const dv = Math.abs(va - vb);
    const hardware = [a, b].find((p) => FASTENER.test(p.libKind ?? ""));
    const ids = [...new Set(list.flatMap((p) => [p.a.id, p.b.id]))];
    const swap = hardware
      ? hardware === anode
        ? `fasteners of the same metal as ${plain(cathode)}, or ones with insulating washers and sleeves`
        : materialRecord(anode.material)?.name.startsWith("Aluminum")
          ? "zinc-plated or aluminium fasteners, or stainless ones with insulating washers and an anti-seize barrier such as Tef-Gel"
          : `fasteners of the same metal as ${plain(anode)}`
      : "a closer pair of metals (see the anodic index of each in the material picker)";
    out.push({
      id: `brief-galvanic:${key}`,
      category: "brief",
      status: "warn",
      title: `${plain(a)} and ${plain(b)} don't corrode each other`,
      detail: `${metalName(a)} (${fmtNum(va, 2)} V) touches ${metalName(b)} (${fmtNum(vb, 2)} V)${list.length > 1 ? ` in ${list.length} places` : ""}: ${fmtNum(dv, 2)} V apart, more than the ${fmtNum(limit.volts, 2)} V that is safe ${limit.where}. With water across the joint the ${metalName(anode)} corrodes, fastest where they touch.`,
      fix: `Keep water out of the joint, isolate the metals (nylon washers and sleeves, sealant or a coating; anodizing or powder coat counts), or use ${swap}.`,
      parts: ids,
      span: (hardware === a ? b : a).span,
      basis: "geometry",
    });
  }
  return out;
}

// ---------- creep under a constant load ----------

/** Loads in the brief that stay on (a shelf, a hanging weight), by the part they act on. */
export function heldLoads(b: Brief | null | undefined): Map<string, { text: string; load: number }[]> {
  const m = new Map<string, { text: string; load: number }[]>();
  for (const u of b?.uses ?? []) if (u.on && u.load !== undefined && (!u.cycles || u.cycles < 1000)) m.set(u.on, [...(m.get(u.on) ?? []), { text: u.text, load: u.load }]);
  return m;
}

/** Long-term stress a plastic takes under a constant load, halved within 25 °C of its softening point. */
export function creepAllowable(r: MaterialRecord, hot?: number): { limit: number; hot: boolean } | null {
  if (r.creepLimit === undefined || r.category === "metal") return null;
  const isHot = hot !== undefined && hot > r.maxC - 25;
  return { limit: r.creepLimit * r.mech.yield * (isHot ? 0.5 : 1), hot: isHot };
}

export function creepItem(model: Model, part: EvalPart, loads: { text: string; load: number }[], a: AnalysisFacts): CheckItem | null {
  const r = materialRecord(a.material);
  if (!r) return null;
  const hot = model.brief?.temp?.[1];
  const allow = creepAllowable(r, hot);
  if (!allow) return null;
  const over = a.stress > allow.limit;
  const close = a.stress > 0.8 * allow.limit;
  let fix: string | undefined;
  if (over || close) {
    const advice = adviseMaterials({ brief: briefFacts(model.brief), candidates: undefined });
    const picks = advice.options
      .filter((o) => !o.otherWay && o.verdict !== "unsuitable" && o.name !== r.name)
      .filter((o) => {
        const q = materialRecord(o.name)!;
        const lim = creepAllowable(q, hot);
        return q.category !== "metal" && lim && lim.limit > 1.3 * a.stress;
      })
      .slice(0, 2)
      .map((o) => o.name);
    fix = `Spread the load where the stress peaks (a thicker section, ribs, a larger fillet)${picks.length ? `, or use a plastic that creeps less here: ${picks.join(" or ")}` : ""}.`;
  }
  return {
    id: `creep:${part.name}`,
    category: "analysis",
    status: over ? "warn" : "pass",
    title: `${plain(part)} holds its load without creeping`,
    detail: `Peak stress ${fmtNum(a.stress, 1)} MPa under "${a.label}" against a long-term limit of about ${fmtNum(allow.limit, 1)} MPa for ${r.label} under a load that stays on (${loads.map((l) => l.text).join("; ")})${allow.hot ? `, halved because ${fmtNum(hot!, 0)} °C is near its ${r.maxC} °C softening point` : ""}.${over ? " It will sag over weeks or months." : close ? " Close: check it after a few weeks of use." : ""}`,
    fix,
    parts: model.parts.filter((p) => p.name === part.name).map((p) => p.id),
    span: part.span,
    margin: allow.limit - a.stress,
    basis: "simulation",
  };
}

// ---------- machine-screw threads in printed plastic ----------

/** Small machine-screw threads a recipe cuts. */
function cutThreads(ops: PartOp[]): { d: number; name?: string }[] {
  const out: { d: number; name?: string }[] = [];
  const walk = (r: ShapeRecipe): void => {
    switch (r.t) {
      case "hole":
        if (r.thread && r.thread.d <= 10) out.push({ d: r.thread.d, name: r.threadName });
        return;
      case "thread":
        if (r.internal && r.spec.form === "iso" && r.spec.d <= 10) out.push({ d: r.spec.d });
        return;
      case "xform":
        return walk(r.shape);
      case "union":
        return r.shapes.forEach(walk);
      case "diff":
        walk(r.a);
        return r.b.forEach(walk);
      default:
        return;
    }
  };
  for (const o of ops) if (o.op === "cut") walk(o.shape);
  return out;
}

export function threadItems(model: Model): CheckItem[] {
  const out: CheckItem[] = [];
  const seen = new Set<string>();
  for (const p of model.parts) {
    if (p.kind !== "part" || p.imported || seen.has(p.name)) continue;
    seen.add(p.name);
    const printed = p.process ? ["fdm", "sla"].includes(p.process.id) : !p.processNone && isPrinted(p.material);
    if (!printed) continue;
    const threads = cutThreads(p.recipe.ops);
    if (!threads.length) continue;
    const sizes = [...new Set(threads.map((t) => t.name ?? `M${fmtNum(t.d, 1)}`))];
    out.push({
      id: `process-threads:${p.name}`,
      category: "process",
      status: "warn",
      title: `${plain(p)}: screws hold in printed plastic`,
      detail: `${threads.length} ${sizes.join(", ")} thread${threads.length > 1 ? "s are" : " is"} cut straight into printed ${p.material}. Printed threads strip after a few tightenings and loosen as the plastic creeps.`,
      fix: `Use heat-set inserts: hole(${sizes[0]}, fit: "insert") with a lib.insert, or screw_boss(), which takes one by default. For a part that is rarely opened, a thread-forming screw into hole(${sizes[0]}, fit: "tap") holds too.`,
      parts: model.parts.filter((q) => q.name === p.name).map((q) => q.id),
      span: p.span,
      basis: "parameters",
    });
  }
  return out;
}
