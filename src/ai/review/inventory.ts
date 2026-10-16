// The detail inventory: what the kernel measured on each custom part, plus the
// unexplained dimensions in the source, written out for the reviewer.

import type { Model } from "../../core/model";
import type { PartInspection, SupportNote } from "../../kernel/inspect";
import { applyXforms, applyXformsToDir, type V3 } from "../../kernel/recipe";
import { fmtNum } from "../../lang/values";
import { unexplainedLiterals } from "./literals";
import type { DetailInventory, PartDetail } from "./types";

const DIRS: Record<SupportNote["down"], V3> = { "-Z": [0, 0, -1], "+Z": [0, 0, 1], "-X": [-1, 0, 0], "+X": [1, 0, 0], "-Y": [0, -1, 0], "+Y": [0, 1, 0] };

type Inspect = (hashes: string[]) => Promise<Record<string, PartInspection | { error: string }>>;

/** Measure every custom part (library hardware is skipped) and scan the source. */
export async function buildInventory(model: Model, source: string, inspect: Inspect, bboxOf: (hash: string) => [V3, V3] | undefined, scope?: string[]): Promise<DetailInventory> {
  const custom = model.parts.filter((p) => p.kind === "part" && !p.hidden && (!scope?.length || scope.includes(p.name)));
  const byName = new Map<string, typeof custom>();
  for (const p of custom) byName.set(p.name, [...(byName.get(p.name) ?? []), p]);
  const hashes = [...new Set(custom.map((p) => p.hash))];
  let measured: Record<string, PartInspection | { error: string }> = {};
  try {
    measured = hashes.length ? await inspect(hashes) : {};
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    measured = Object.fromEntries(hashes.map((h) => [h, { error: msg }]));
  }
  const parts: PartDetail[] = [];
  const missing: string[] = [];
  for (const [name, list] of byName) {
    const first = list[0];
    const m = measured[first.hash];
    const box = bboxOf(first.hash);
    const toWorld = (p: V3) => applyXforms(p, first.xf);
    let size: V3 = [0, 0, 0];
    if (box) {
      const a = toWorld(box[0]);
      const b = toWorld(box[1]);
      size = [Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), Math.abs(b[2] - a[2])];
    }
    if (!m || "error" in m) {
      missing.push(name);
      parts.push({ name, label: first.label, material: first.material, instances: list.length, size, inspection: null, error: m && "error" in m ? m.error : "not measured", asPlaced: null });
      continue;
    }
    const moved: PartInspection = {
      ...m,
      sharp: { ...m.sharp, top: m.sharp.top.map((e) => ({ ...e, at: toWorld(e.at) })) },
      internal: { ...m.internal, top: m.internal.top.map((e) => ({ ...e, at: toWorld(e.at) })) },
      walls: m.walls ? { ...m.walls, at: toWorld(m.walls.at) } : null,
    };
    // the part direction that points down in the world when the part sits as placed
    let asPlaced: SupportNote["down"] | null = null;
    for (const [k, d] of Object.entries(DIRS) as [SupportNote["down"], V3][]) {
      const w = applyXformsToDir(d, first.xf);
      if (w[2] < -0.999) asPlaced = k;
    }
    parts.push({ name, label: first.label, material: first.material, instances: list.length, size, inspection: moved, asPlaced });
  }
  const literals = unexplainedLiterals(source).filter((l) => !scope?.length || scope.includes(l.part));
  return { parts, literals, missing };
}

const n = (v: number, d = 1) => fmtNum(v, d);
const pt = (p: V3) => `(${p.map((x) => n(x, 1)).join(", ")})`;

/** Plain-text inventory for the reviewer's prompt. */
export function inventoryText(inv: DetailInventory): string {
  const out: string[] = [];
  out.push("Measured on the exact geometry of each custom part (library hardware is not listed). Locations are world coordinates in mm, Z up.");
  for (const p of inv.parts) {
    const head = `Part "${p.name}"${p.label && p.label !== p.name ? ` (${p.label})` : ""}: ${p.material || "no material"}, ${p.size.map((x) => n(x)).join(" × ")} mm${p.instances > 1 ? `, ${p.instances} identical instances` : ""}`;
    out.push("", head);
    const m = p.inspection;
    if (!m) {
      out.push(`  - not measured: ${p.error ?? "unknown"}`);
      continue;
    }
    const outer = m.sharp.count - m.sharp.holeRims - m.sharp.bossRims;
    out.push(
      `  - ${m.faces} faces, ${m.edges} edges. Sharp convex edges: ${m.sharp.count} (${n(m.sharp.length, 0)} mm in total): ${outer} outer edges, ${m.sharp.holeRims} hole rims with no chamfer or countersink, ${m.sharp.bossRims} boss or pin rims. Smooth (filleted or tangent) joins: ${m.blended}.`,
    );
    if (m.sharp.top.length) out.push(`  - Longest sharp edges: ${m.sharp.top.map((e) => `${n(e.length)} mm ${e.kind === "outer" ? "" : e.kind.replace("_", " ") + " "}at ${pt(e.at)}${e.angle !== 90 ? ` (${e.angle}°)` : ""}`).join("; ")}`);
    out.push(`  - Sharp internal corners (no fillet): ${m.internal.count}${m.internal.count ? ` (${n(m.internal.length, 0)} mm in total); longest: ${m.internal.top.slice(0, 5).map((e) => `${n(e.length)} mm at ${pt(e.at)}`).join("; ")}` : ""}`);
    if (m.tiny) out.push(`  - ${m.tiny} edges shorter than 0.1 mm (often modelling slivers from coincident faces)`);
    if (m.walls) out.push(`  - Thinnest wall ≈ ${n(m.walls.min, 2)} mm at ${pt(m.walls.at)}; 5% of the surface is under ${n(m.walls.p5, 2)} mm (ray-cast on the mesh, about ±0.25 mm)`);
    if (m.support.length) {
      const placed = m.support.find((s) => s.down === p.asPlaced);
      const best = [...m.support].sort((a, b) => a.area - b.area)[0];
      const placedText = placed ? `printed as placed in the assembly (part ${placed.down} on the bed): ${n(placed.area, 0)} mm² needs support` : "as placed it does not sit square to the bed";
      out.push(`  - Overhangs past 45°: ${placedText}; least support with part ${best.down} on the bed: ${n(best.area, 0)} mm²`);
    }
    if (m.truncated) out.push("  - (very many edges: only the first 4000 were inspected)");
  }
  if (inv.missing.length) out.push("", `Not measured (not built yet or the kernel was busy): ${inv.missing.join(", ")}`);
  out.push("", `Dimensions typed directly into part geometry (not from a param, let or interface): ${inv.literals.length}${inv.literals.length >= 80 ? "+" : ""}`);
  for (const l of inv.literals.slice(0, 30)) out.push(`  - ${l.part}, line ${l.line}: ${l.value} in \`${l.context}\``);
  if (inv.literals.length > 30) out.push(`  - …and ${inv.literals.length - 30} more`);
  return out.join("\n");
}

/** One-line digest for the review card footer. */
export function inventoryDigest(inv: DetailInventory): string {
  let sharp = 0;
  let rims = 0;
  let internal = 0;
  let thinnest: number | null = null;
  for (const p of inv.parts) {
    const m = p.inspection;
    if (!m) continue;
    sharp += m.sharp.count - m.sharp.holeRims;
    rims += m.sharp.holeRims;
    internal += m.internal.count;
    if (m.walls) thinnest = thinnest === null ? m.walls.min : Math.min(thinnest, m.walls.min);
  }
  const bits = [`${inv.parts.length} part${inv.parts.length === 1 ? "" : "s"} measured`, `${sharp} sharp edges`, `${rims} bare hole rims`, `${internal} sharp inside corners`];
  if (thinnest !== null) bits.push(`thinnest wall ${n(thinnest, 1)} mm`);
  bits.push(`${inv.literals.length} unnamed dimensions`);
  return bits.join(" · ");
}
