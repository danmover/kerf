// Checks on sheet() parts made as sheet metal, from what sheet() recorded:
// every flange is long enough for the press brake to grip, no two flanges
// run into each other once bent, the flat pattern does not overlap itself,
// and it fits on a standard sheet. Thickness, bend radius against the
// material and holes near bends are checked on the geometry by the process
// checks (mfg/analyze).

import type { CheckItem } from "./checks";
import type { EvalPart, Model } from "./model";
import type { SheetBox } from "../lang/sheet";
import { fmtNum } from "../lang/values";
import type { V2, V3 } from "../kernel/recipe";

/** Shortest outside flange length a press brake bends reliably, in sheet thicknesses. */
export const MIN_FLANGE_T = 4;
/** A standard full sheet, mm. */
const STOCK: V2 = [2500, 1250];
/** Overlap that counts as a collision, mm. */
const TOL = 0.05;

const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** How far two oriented boxes overlap along their least-overlapping axis (separating axis test); ≤ 0 when apart. */
export function boxOverlap(a: SheetBox, b: SheetBox): number {
  const axes: V3[] = [...a.axes, ...b.axes];
  for (const u of a.axes) for (const v of b.axes) axes.push(cross3(u, v));
  const d: V3 = [b.c[0] - a.c[0], b.c[1] - a.c[1], b.c[2] - a.c[2]];
  let least = Infinity;
  for (const ax of axes) {
    const len = Math.hypot(...ax);
    if (len < 1e-9) continue;
    const n: V3 = [ax[0] / len, ax[1] / len, ax[2] / len];
    const ra = a.axes.reduce((s, u, i) => s + a.half[i] * Math.abs(dot3(u, n)), 0);
    const rb = b.axes.reduce((s, u, i) => s + b.half[i] * Math.abs(dot3(u, n)), 0);
    least = Math.min(least, ra + rb - Math.abs(dot3(d, n)));
    if (least <= 0) return least;
  }
  return least;
}

/** How far two convex outlines overlap (separating axis test); ≤ 0 when apart. */
export function polyOverlap(a: V2[], b: V2[]): number {
  let least = Infinity;
  for (const poly of [a, b])
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len < 1e-9) continue;
      const n: V2 = [-(q[1] - p[1]) / len, (q[0] - p[0]) / len];
      const span = (pts: V2[]) => {
        const v = pts.map((x) => x[0] * n[0] + x[1] * n[1]);
        return [Math.min(...v), Math.max(...v)];
      };
      const [a0, a1] = span(a);
      const [b0, b1] = span(b);
      least = Math.min(least, Math.min(a1, b1) - Math.max(a0, b0));
      if (least <= 0) return least;
    }
  return least;
}

/** A flange and its own lip are one strip of metal. */
const sameFlange = (a: string, b: string) => a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `);

export function sheetChecks(model: Model): CheckItem[] {
  const out: CheckItem[] = [];
  const seen = new Set<string>();
  for (const p of model.parts) {
    if (!p.sheet || p.process?.id !== "sheet_metal" || seen.has(p.name)) continue;
    seen.add(p.name);
    out.push(...partChecks(p));
  }
  return out;
}

function partChecks(p: EvalPart): CheckItem[] {
  const s = p.sheet!;
  const out: CheckItem[] = [];
  const base = { category: "process" as const, parts: [p.id], span: p.span, basis: "geometry" as const };
  const mm = (n: number) => `${fmtNum(n, 1)} mm`;
  const min = MIN_FLANGE_T * s.t;

  // flange lengths
  const strips = s.flanges.flatMap((f) => [
    { name: `${f.name} flange`, h: f.h, flat: f.flat, key: "h" },
    ...(f.lip ? [{ name: `${f.name} lip`, h: f.lip.length, flat: f.lip.flat, key: "lip" }] : []),
  ]);
  const grip = strips.filter((x) => x.flat < s.t);
  const short = strips.filter((x) => x.flat >= s.t && x.h < min - 1e-6);
  if (grip.length)
    out.push({
      ...base,
      id: `sheet:flange:${p.name}`,
      status: "fail",
      title: `${p.label} has flanges too short to bend`,
      detail: `${grip.map((x) => `the ${x.name} (${mm(x.h)}) leaves ${mm(x.flat)} flat beyond its bend`).join("; ")}: the press brake needs at least the sheet's ${mm(s.t)} to grip, and ${mm(min)} outside to bend it cleanly.`,
      fix: `Make ${grip.length === 1 ? "it" : "each"} at least ${mm(min)} long (${MIN_FLANGE_T} × the sheet thickness), or leave it off.`,
    });
  else if (short.length)
    out.push({
      ...base,
      id: `sheet:flange:${p.name}`,
      status: "warn",
      title: `${p.label} has short flanges`,
      detail: `${short.map((x) => `the ${x.name} is ${mm(x.h)}`).join("; ")}: under ${mm(min)} (${MIN_FLANGE_T} × the ${mm(s.t)} sheet) most press brakes cannot bend it without a special die, and it may twist.`,
      fix: `Make ${short.length === 1 ? "it" : "them"} at least ${mm(min)}.`,
    });
  else if (strips.length) out.push({ ...base, id: `sheet:flange:${p.name}`, status: "pass", title: `${p.label}'s flanges are long enough to bend`, detail: `Shortest ${mm(Math.min(...strips.map((x) => x.h)))}, at least ${mm(min)} (${MIN_FLANGE_T} × the sheet thickness)` });

  // flanges that run into each other once bent
  const hits: string[] = [];
  for (let i = 0; i < s.boxes.length; i++)
    for (let j = i + 1; j < s.boxes.length; j++) {
      const a = s.boxes[i];
      const b = s.boxes[j];
      if (sameFlange(a.name, b.name)) continue;
      if (boxOverlap(a, b) > TOL) hits.push(`${a.name} and ${b.name}`);
    }
  if (hits.length)
    out.push({
      ...base,
      id: `sheet:collide:${p.name}`,
      status: "fail",
      title: `${p.label}'s flanges hit each other when bent`,
      detail: `${hits.join("; ")} cross at a corner, so the second bend cannot be made.`,
      fix: "Shorten one of them, give it an inset at that corner, bend one less steeply, or widen the corner gap (gap:).",
    });
  else if (s.boxes.length > 1) out.push({ ...base, id: `sheet:collide:${p.name}`, status: "pass", title: `${p.label}'s flanges clear each other`, detail: `${s.boxes.length} flat regions, none crossing once bent; corner gap ${mm(s.gap)}` });

  // the flat pattern in one piece without overlaps
  const overlaps: string[] = [];
  for (let i = 0; i < s.flatRegions.length; i++)
    for (let j = i + 1; j < s.flatRegions.length; j++) {
      const a = s.flatRegions[i];
      const b = s.flatRegions[j];
      if (a.flange === b.flange) continue;
      if (polyOverlap(a.pts, b.pts) > TOL) overlaps.push(`${a.flange} and ${b.flange}`);
    }
  const w = s.flatBox[1][0] - s.flatBox[0][0];
  const d = s.flatBox[1][1] - s.flatBox[0][1];
  const size = `${fmtNum(w, 0)} × ${fmtNum(d, 0)} mm`;
  if (overlaps.length)
    out.push({
      ...base,
      id: `sheet:flat:${p.name}`,
      status: "fail",
      title: `${p.label}'s flat pattern overlaps itself`,
      detail: `Laid flat, the ${[...new Set(overlaps)].join("; ")} flanges cover the same metal, so the blank cannot be cut in one piece.`,
      fix: "Shorten the flanges at that corner or give one an inset, or make the part from two pieces joined with screws or rivets.",
    });
  else {
    const fits = (w <= STOCK[0] && d <= STOCK[1]) || (w <= STOCK[1] && d <= STOCK[0]);
    out.push({
      ...base,
      id: `sheet:flat:${p.name}`,
      status: fits ? "pass" : "warn",
      title: fits ? `${p.label}'s flat pattern is ${size}` : `${p.label}'s flat pattern is bigger than a standard sheet`,
      detail: fits
        ? `${s.bends.length} bend${s.bends.length === 1 ? "" : "s"}, ${mm(s.t)} sheet, K-factor ${fmtNum(s.k, 2)}; in one piece with nothing overlapping`
        : `${size} laid flat, larger than a ${STOCK[0]} × ${STOCK[1]} mm sheet, so it needs a special order or a welded joint.`,
      ...(fits ? {} : { fix: "Split it into parts joined with screws, rivets or welds, or make the flanges shorter." }),
    });
  }
  return out;
}
