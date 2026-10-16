// Numbers that sum up a design: its overall size, mass, what is made and
// what is bought, the materials, and how far it meets its brief. Shared by
// the overview board and the design report.

import type { EvalPart, Model } from "../core/model";
import type { CheckItem, CheckReport } from "../core/checks";
import { briefData, openAssumptions, type BriefData } from "../core/brief";
import { xformMatrix } from "../kernel/recipe";
import { materialDensity } from "../library/standards";
import { isPrinted, materialDef } from "../library/materials";

type V3 = [number, number, number];
export interface MeshInfo {
  volume: number;
  bbox: [V3, V3];
}
export type MeshLookup = (hash: string) => MeshInfo | undefined;

/** A part's box in assembly coordinates, from its mesh box and placement. */
export function placedBox(p: EvalPart, info: MeshInfo): [V3, V3] {
  const m = xformMatrix(p.xf);
  const [a, b] = info.bbox;
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? b[0] : a[0];
    const y = i & 2 ? b[1] : a[1];
    const z = i & 4 ? b[2] : a[2];
    const w: V3 = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], w[k]);
      max[k] = Math.max(max[k], w[k]);
    }
  }
  return [min, max];
}

export interface DesignStats {
  /** overall size along X, Y and Z in mm; null until geometry exists */
  size: V3 | null;
  /** grams, from mesh volumes and material densities */
  mass: number;
  printedMass: number;
  /** solids still building (their mass and size are missing) */
  pending: number;
  /** instances to make and to buy (multi-solid components count once) */
  make: number;
  buy: number;
  /** distinct materials, heaviest first */
  materials: { name: string; label: string; color: string; mass: number; count: number }[];
}

export function designStats(model: Model | null, mesh: MeshLookup, only?: (p: EvalPart) => boolean): DesignStats {
  const out: DesignStats = { size: null, mass: 0, printedMass: 0, pending: 0, make: 0, buy: 0, materials: [] };
  if (!model) return out;
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  const mats = new Map<string, { name: string; label: string; color: string; mass: number; count: number }>();
  const instances = new Set<string>();
  let any = false;
  for (const p of model.parts) {
    if (p.hidden || (only && !only(p))) continue;
    const instance = p.kind === "component" ? p.id.split(".")[0] : p.id;
    if (!instances.has(instance)) {
      instances.add(instance);
      if (p.kind === "part") out.make++;
      else out.buy++;
    }
    const info = mesh(p.hash);
    const mat = mats.get(p.material) ?? { name: p.material, label: materialDef(p.material)?.label ?? p.material, color: p.color, mass: 0, count: 0 };
    mat.count++;
    mats.set(p.material, mat);
    if (!info) {
      out.pending++;
      continue;
    }
    const g = (info.volume / 1000) * materialDensity(p.material);
    out.mass += g;
    mat.mass += g;
    if (p.kind === "part" && isPrinted(p.material)) out.printedMass += g;
    const [a, b] = placedBox(p, info);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], a[k]);
      max[k] = Math.max(max[k], b[k]);
    }
    any = true;
  }
  if (any) out.size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  out.materials = [...mats.values()].sort((a, b) => b.mass - a.mass || b.count - a.count);
  return out;
}

export type UseStatus = "pass" | "fail" | "warn" | "unchecked";

export interface BriefSummary {
  data: BriefData;
  uses: { id: string; text: string; status: UseStatus; assumed: boolean }[];
  /** assumptions Claude made that are waiting for the user */
  toConfirm: number;
  /** failing brief checks other than uses (temperature, size, mass…) */
  fails: CheckItem[];
}

/** The brief with each use's check status, or null when the design has no brief. */
export function briefSummary(model: Model | null, report: CheckReport | null): BriefSummary | null {
  const data = briefData(model?.brief);
  if (!data) return null;
  const items = new Map((report?.items ?? []).map((i) => [i.id, i]));
  const uses = data.uses.map((u) => {
    const s = items.get(`use:${u.id}`)?.status;
    const status: UseStatus = s === "pass" ? "pass" : s === "fail" ? "fail" : s === "warn" ? "warn" : "unchecked";
    return { id: u.id, text: u.text, status, assumed: u.assumed };
  });
  const fails = (report?.items ?? []).filter((i) => i.category === "brief" && !i.id.startsWith("use:") && i.status === "fail");
  return { data, uses, toConfirm: openAssumptions(data).length, fails };
}

const ORDER: Record<string, number> = { fail: 0, warn: 1, pending: 2, info: 3, pass: 4 };

/** Checks that need attention, worst first: failures, then warnings. */
export function attention(report: CheckReport | null, limit = 4): CheckItem[] {
  return (report?.items ?? [])
    .filter((i) => i.status === "fail" || i.status === "warn")
    .sort((a, b) => ORDER[a.status] - ORDER[b.status] || (a.level === "soft" ? 1 : 0) - (b.level === "soft" ? 1 : 0))
    .slice(0, limit);
}

const SCOPE: Record<string, string> = {
  brief: "the brief",
  requirement: "requirements",
  interference: "interference",
  access: "tool access",
  motion: "motion",
  gears: "gears",
  analysis: "strength",
  simulation: "simulations",
  process: "manufacturing",
  electrical: "wiring",
  engineering: "calculations",
};

/** What the checks cover, from the categories that ran: "Requirements, interference and tool access". */
export function checkScope(report: CheckReport | null, limit = 4): string {
  const present = new Set((report?.items ?? []).map((i) => i.category));
  const names = Object.keys(SCOPE)
    .filter((c) => present.has(c as CheckItem["category"]))
    .map((c) => SCOPE[c]);
  if (!names.length) return "";
  const shown = names.length > limit ? [...names.slice(0, limit), `${names.length - limit} more`] : names;
  const text = shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}` : shown[0];
  return text[0].toUpperCase() + text.slice(1);
}

/** "92 × 70 × 34" with sensible precision. */
export function sizeText(size: V3 | null): string {
  if (!size) return "—";
  return size.map((v) => (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10).toString()).join(" × ");
}

/** "48 g", "1.32 kg". */
export function massText(g: number): string {
  if (!(g > 0)) return "—";
  if (g >= 1000) return `${(g / 1000).toFixed(g >= 10000 ? 1 : 2)} kg`;
  return g >= 10 ? `${Math.round(g)} g` : `${g.toFixed(1)} g`;
}
