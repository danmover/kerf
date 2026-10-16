// Text edits for sketches. The sketch editor, the assistant and the code
// editor all change sketches through the design source, so every edit here
// takes source text and returns new source text. Edits are small and keep
// what people wrote: formulas stay formulas, only plain numbers are
// rewritten with solved positions.

import type { Span } from "../lang/ast";
import { fmtNum } from "../lang/values";
import { lex } from "../lang/lexer";
import { evaluate } from "../lang/evaluator";
import type { Model } from "../core/model";
import type { V2 } from "../kernel/recipe";
import { SKETCH_RESERVED } from "./evaluate";
import type { EvalSketch, SkConstraint, SkCurve, SkPoint } from "./types";

export const fmt = (v: number) => fmtNum(v, 3);
export const fmtPt = (p: V2) => `(${fmt(p[0])}, ${fmt(p[1])})`;

interface Change {
  from: number;
  to: number;
  insert: string;
}

function apply(src: string, changes: Change[]): string {
  const sorted = [...changes].sort((a, b) => b.from - a.from || b.to - a.to);
  let out = src;
  let guard = Infinity;
  for (const c of sorted) {
    // overlapping edits: keep the earlier-listed outer one
    if (c.to > guard) continue;
    out = out.slice(0, c.from) + c.insert + out.slice(c.to);
    guard = c.from;
  }
  return out;
}

/** A span widened to its whole line(s) when nothing else is on them, so removing it leaves no blank line. */
function lineSpan(src: string, span: Span): Span {
  const ls = src.lastIndexOf("\n", span.start - 1) + 1;
  let le = src.indexOf("\n", span.end);
  if (le < 0) le = src.length;
  const before = src.slice(ls, span.start);
  const after = src.slice(span.end, le).replace(/^\s*;?/, "");
  if (/^\s*$/.test(before) && (/^\s*$/.test(after) || /^\s*\/\//.test(after))) return { start: ls === 0 ? 0 : ls - 1, end: le };
  return span;
}

// ---------------- names ----------------

export function takenNames(sk: EvalSketch): Set<string> {
  return new Set([...SKETCH_RESERVED, ...sk.points.map((p) => p.id), ...sk.curves.map((c) => c.id), ...Object.keys(sk.aliases), "area", "plane", "normal", "name", "kind"]);
}

export function nextName(taken: Set<string>, prefix: string): string {
  for (let i = 1; ; i++) {
    const n = `${prefix}${i}`;
    if (!taken.has(n)) {
      taken.add(n);
      return n;
    }
  }
}

export const PREFIX: Record<SkCurve["kind"] | "point", string> = { line: "l", circle: "c", arc: "a", point: "p" };

// ---------------- creating sketches ----------------

/** Add an empty sketch before the first part (parts use sketches, so sketches come first). */
export function addSketch(src: string, model: Model | null, opts: { name?: string; plane: string; offset?: number; origin?: string }): { src: string; name: string } {
  const used = new Set(model?.blocks.map((b) => b.name) ?? []);
  let name = opts.name ?? "";
  if (!name || used.has(name)) for (let i = 1; ; i++) if (!used.has((name = `sketch${i}`))) break;
  const body = [`  plane: ${opts.plane}`];
  if (opts.offset) body.push(`  offset: ${fmt(opts.offset)}`);
  if (opts.origin) body.push(`  origin: ${opts.origin}`);
  const text = `sketch ${name} {\n${body.join("\n")}\n}\n`;
  const firstPart = model?.blocks.filter((b) => b.kind === "part").sort((a, b) => a.span.start - b.span.start)[0];
  if (firstPart) {
    const at = src.lastIndexOf("\n", firstPart.span.start - 1) + 1;
    return { src: src.slice(0, at) + text + "\n" + src.slice(at), name };
  }
  const trimmed = src.replace(/\s*$/, "");
  return { src: (trimmed ? trimmed + "\n\n" : "") + text, name };
}

/** Change a sketch's plane property, adding it when missing. */
export function setPlane(src: string, sk: EvalSketch, plane: string, offset?: number): string {
  const body = src.slice(sk.span.start, sk.bodyEnd);
  const changes: Change[] = [];
  const re = /^([ \t]*)plane:[^\n]*$/m;
  const m = re.exec(body);
  if (m) changes.push({ from: sk.span.start + m.index, to: sk.span.start + m.index + m[0].length, insert: `${m[1]}plane: ${plane}` });
  else changes.push({ from: src.indexOf("{", sk.nameSpan.end) + 1, to: src.indexOf("{", sk.nameSpan.end) + 1, insert: `\n${sk.indent}plane: ${plane}` });
  if (offset !== undefined) {
    const om = /^([ \t]*)offset:[^\n]*$/m.exec(body);
    if (om) changes.push({ from: sk.span.start + om.index, to: sk.span.start + om.index + om[0].length, insert: offset ? `${om[1]}offset: ${fmt(offset)}` : "" });
    else if (offset) {
      const at = m ? sk.span.start + m.index + m[0].length : src.indexOf("{", sk.nameSpan.end) + 1;
      changes.push({ from: at, to: at, insert: `\n${sk.indent}offset: ${fmt(offset)}` });
    }
  }
  return apply(src, changes);
}

// ---------------- adding statements ----------------

function bodyInsertAt(src: string, sk: EvalSketch): number {
  let p = sk.bodyEnd;
  while (p > 0 && /\s/.test(src[p - 1])) p--;
  return p;
}

/** Add geometry after the existing geometry, and constraints at the end of the sketch, in one edit. */
export function addStatements(src: string, sk: EvalSketch, add: { geometry?: string[]; constraints?: string[] }): string {
  const end = bodyInsertAt(src, sk);
  const lines = (ls: string[] = []) => ls.map((l) => `\n${sk.indent}${l}`).join("");
  const gAt = Math.min(sk.entityEnd, end);
  if (gAt === end) return src.slice(0, end) + lines(add.geometry) + lines(add.constraints) + src.slice(end);
  return src.slice(0, gAt) + lines(add.geometry) + src.slice(gAt, end) + lines(add.constraints) + src.slice(end);
}

// ---------------- moving geometry ----------------

const near = (a: V2, b: V2) => Math.abs(a[0] - b[0]) < 5e-4 && Math.abs(a[1] - b[1]) < 5e-4;

/**
 * Write solved (or dragged) positions back into plain-number coordinates so the
 * text matches what is drawn. Coordinates written as formulas are left alone.
 */
export function writePositions(src: string, sk: EvalSketch, positions: Record<string, V2> = {}, radii: Record<string, number> = {}): string {
  const changes: Change[] = [];
  for (const p of sk.points) {
    if (!p.literal || !p.coordSpan || !p.written) continue;
    const target = positions[p.id] ?? [p.x, p.y];
    if (near(target, p.written)) continue;
    changes.push({ from: p.coordSpan.start, to: p.coordSpan.end, insert: fmtPt(target) });
  }
  for (const c of sk.curves) {
    if (c.kind !== "circle" || !c.sizeLiteral || !c.sizeSpan || c.writtenR === undefined) continue;
    const r = radii[c.id] ?? c.r!;
    if (Math.abs(r - c.writtenR) < 5e-4) continue;
    changes.push({ from: c.sizeSpan.start, to: c.sizeSpan.end, insert: fmt(c.sizeWhich === "d" ? 2 * r : r) });
  }
  return apply(src, changes);
}

// ---------------- deleting ----------------

/** Selection ids: geometry ids (l1, c2, p1, l1.end) and constraint indices as "#3". */
export const consId = (c: SkConstraint) => `#${c.index}`;

const LIST_KINDS: Record<string, number> = { fix: 1, parallel: 2, equal: 2, horizontal: 1, vertical: 1, fillet: 1, chamfer: 1 };

export function deleteSelection(src: string, sk: EvalSketch, sel: string[]): string {
  // geometry projected from another sketch is edited there, not here
  const removedCurves = new Set(sel.filter((id) => sk.curves.some((c) => c.id === id && !c.external)));
  const removedCons = new Set(sel.filter((id) => id.startsWith("#")).map((id) => Number(id.slice(1))));
  const removedPoints = new Set<string>();
  for (const id of sel) {
    const p = sk.points.find((q) => q.id === id);
    if (p && !p.implicit) removedPoints.add(p.id);
  }
  for (const c of sk.curves) if (removedCurves.has(c.id)) for (const pid of c.pts) if (pid.startsWith(c.id + ".")) removedPoints.add(pid);
  const removedSpans: Span[] = [];
  const changes: Change[] = [];
  const P = (id: string) => sk.points.find((p) => p.id === id)!;
  const removeStmt = (span: Span) => {
    const s = lineSpan(src, span);
    removedSpans.push(s);
    changes.push({ from: s.start, to: s.end, insert: "" });
  };
  for (const c of sk.curves) if (removedCurves.has(c.id)) removeStmt(c.span);
  for (const p of sk.points) if (removedPoints.has(p.id) && !p.implicit && p.span) removeStmt(p.span);
  // curves that start or end at a removed point keep their position as plain coordinates
  for (const c of sk.curves) {
    if (removedCurves.has(c.id)) continue;
    c.pts.forEach((pid, k) => {
      if (!removedPoints.has(pid) || !c.argSpans[k]) return;
      const p = P(pid);
      changes.push({ from: c.argSpans[k].start, to: c.argSpans[k].end, insert: fmtPt([p.x, p.y]) });
    });
  }
  const gone = (id: string) => removedCurves.has(id) || removedPoints.has(id);
  for (const c of sk.constraints) {
    if (removedCons.has(c.index)) {
      removeStmt(c.span);
      continue;
    }
    const hit = c.ids.map(gone);
    if (!hit.some(Boolean)) continue;
    const min = LIST_KINDS[c.kind];
    const keep = c.args.filter((_, i) => !hit[i]);
    const pointsOnly = (c.kind === "horizontal" || c.kind === "vertical") && c.ids.length === 2 && c.ids.every((id) => sk.points.some((p) => p.id === id));
    const lineFillet = (c.kind === "fillet" || c.kind === "chamfer") && c.ids.every((id) => sk.curves.some((q) => q.id === id));
    if (min !== undefined && keep.length >= min && !pointsOnly && !lineFillet) {
      changes.push({ from: c.span.start, to: c.span.end, insert: `${c.kind} ${keep.join(", ")}${c.valueText !== undefined ? ` = ${c.valueText}` : ""}` });
    } else removeStmt(c.span);
  }
  const inRemoved = (ch: Change) => removedSpans.some((s) => ch.from >= s.start && ch.to <= s.end && !(ch.from === s.start && ch.to === s.end));
  return apply(
    src,
    changes.filter((ch) => !inRemoved(ch)),
  );
}

/** Remove a whole sketch block. */
export function deleteSketch(src: string, sk: EvalSketch): string {
  const s = lineSpan(src, sk.span);
  return src.slice(0, s.start) + src.slice(s.end).replace(/^\n(?=\n)/, "");
}

// ---------------- changing ----------------

export function toggleConstruction(src: string, sk: EvalSketch, ids: string[]): string {
  const changes: Change[] = [];
  const curves = sk.curves.filter((c) => ids.includes(c.id) && !c.external);
  // all become construction unless all already are
  const make = !curves.every((c) => c.construction);
  for (const c of curves) {
    if (make && !c.construction) changes.push({ from: c.span.start, to: c.span.start, insert: "construction " });
    if (!make && c.construction) {
      const m = /^construction\s+/.exec(src.slice(c.span.start, c.span.end));
      if (m) changes.push({ from: c.span.start, to: c.span.start + m[0].length, insert: "" });
    }
  }
  return apply(src, changes);
}

/** Set a dimension's value (a number, or an expression such as "w / 2"). */
export function setConstraintValue(src: string, c: SkConstraint, value: number | string): string {
  if (!c.valueSpan) return src;
  const text = typeof value === "number" ? fmt(value) : value.trim();
  return src.slice(0, c.valueSpan.start) + text + src.slice(c.valueSpan.end);
}

export function setCircleSize(src: string, c: SkCurve, value: number | string, which: "r" | "d" = c.sizeWhich ?? "d"): string {
  if (!c.sizeSpan) return src;
  const text = typeof value === "number" ? fmt(value) : value.trim();
  // the label (r: / d:) sits just before the value
  const head = src.slice(c.span.start, c.sizeSpan.start);
  const m = /\b([rd])\s*:\s*$/.exec(head);
  if (m && m[1] !== which) {
    const labelAt = c.span.start + m.index;
    return src.slice(0, labelAt) + `${which}: ${text}` + src.slice(c.sizeSpan.end);
  }
  return src.slice(0, c.sizeSpan.start) + text + src.slice(c.sizeSpan.end);
}

/** Rename a sketch and every reference to it (not field names that happen to match). */
export function renameSketch(src: string, sk: EvalSketch, name: string): string {
  let toks: ReturnType<typeof lex>;
  try {
    toks = lex(src);
  } catch {
    return src;
  }
  const changes: Change[] = [];
  toks.forEach((t, i) => {
    if (t.kind !== "ident" || t.value !== sk.name) return;
    const prev = toks[i - 1];
    if (prev && prev.kind === "op" && prev.value === ".") return;
    changes.push({ from: t.start, to: t.end, insert: name });
  });
  return apply(src, changes);
}

// ---------------- what can be done with a selection ----------------

export interface Suggestion {
  /** short label for buttons */
  label: string;
  kind: string;
  /** the statement to add */
  stmt: string;
  /** a dimension carries a value */
  dimension: boolean;
  /** keyboard shortcut in the sketch editor */
  key?: string;
}

type Ent = { id: string; type: "point" | "line" | "circle" | "arc"; p?: SkPoint; c?: SkCurve };

export function entitiesOf(sk: EvalSketch, ids: string[]): Ent[] {
  const out: Ent[] = [];
  for (const raw of ids) {
    const id = sk.aliases[raw] ?? raw;
    if (id.startsWith("#")) continue;
    const c = sk.curves.find((q) => q.id === id);
    if (c) {
      out.push({ id, type: c.kind, c });
      continue;
    }
    const p = sk.points.find((q) => q.id === id);
    if (p) out.push({ id, type: "point", p });
    else if (id === "x_axis" || id === "y_axis") out.push({ id, type: "line" });
  }
  return out;
}

function lineEnds(sk: EvalSketch, id: string): [V2, V2] {
  if (id === "x_axis") return [[0, 0], [1, 0]];
  if (id === "y_axis") return [[0, 0], [0, 1]];
  const c = sk.curves.find((q) => q.id === id)!;
  const a = sk.points.find((p) => p.id === c.pts[0])!;
  const b = sk.points.find((p) => p.id === c.pts[1])!;
  return [
    [a.x, a.y],
    [b.x, b.y],
  ];
}
const ptOf = (sk: EvalSketch, id: string): V2 => {
  const p = sk.points.find((q) => q.id === id)!;
  return [p.x, p.y];
};
const centerOf = (sk: EvalSketch, c: SkCurve) => ptOf(sk, c.kind === "circle" ? c.pts[0] : c.pts[2]);
const radiusOf = (sk: EvalSketch, c: SkCurve) => (c.kind === "circle" ? c.r! : Math.hypot(...sub(ptOf(sk, c.pts[0]), centerOf(sk, c))));
const sub = (a: V2, b: V2): [number, number] => [a[0] - b[0], a[1] - b[1]];
const cross = (a: V2, b: V2) => a[0] * b[1] - a[1] * b[0];
const dot = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1];
const unitv = (a: V2): V2 => {
  const l = Math.hypot(a[0], a[1]) || 1;
  return [a[0] / l, a[1] / l];
};
function pointLineDist(p: V2, [a, b]: [V2, V2]) {
  return Math.abs(cross(sub(b, a), sub(p, a))) / (Math.hypot(...sub(b, a)) || 1);
}

/** Lines meeting at a point in the profile (for fillet and chamfer). */
function cornerLines(sk: EvalSketch, pid: string): SkCurve[] {
  const P = ptOf(sk, pid);
  return sk.curves.filter((c) => c.kind === "line" && !c.construction && c.pts.some((q) => near(ptOf(sk, q), P)));
}

const niceRound = (v: number) => {
  if (v <= 0) return 1;
  const steps = [0.5, 1, 2, 3, 5, 8, 10, 15, 20, 25, 50];
  return steps.reduce((best, s) => (Math.abs(s - v) < Math.abs(best - v) ? s : best), steps[0]);
};

/** The relations and dimensions that make sense for a selection, best first. */
export function suggestionsFor(sk: EvalSketch, ids: string[]): Suggestion[] {
  const E = entitiesOf(sk, ids);
  const out: Suggestion[] = [];
  const names = E.map((e) => e.id).join(", ");
  const T = E.map((e) => e.type);
  const all = (t: Ent["type"]) => E.length > 0 && T.every((x) => x === t);
  const count = (t: Ent["type"]) => T.filter((x) => x === t).length;
  const g = (label: string, kind: string, stmt: string, key?: string) => out.push({ label, kind, stmt, dimension: false, key });
  const d = (label: string, kind: string, refs: string, value: number, key?: string) => out.push({ label, kind, stmt: `${kind} ${refs} = ${fmt(value)}`, dimension: true, key });
  if (!E.length) return out;

  if (all("line")) {
    const ends = E.map((e) => lineEnds(sk, e.id));
    const dirs = ends.map(([a, b]) => unitv(sub(b, a)));
    const flatness = dirs.map((u) => Math.abs(u[1]));
    // offer the orientation each line is closest to first
    const hFirst = flatness.reduce((s, f) => s + f, 0) / flatness.length < Math.SQRT1_2;
    const real = E.filter((e) => e.id !== "x_axis" && e.id !== "y_axis");
    if (real.length) {
      const h = () => g("Horizontal", "horizontal", `horizontal ${real.map((e) => e.id).join(", ")}`, "h");
      const v = () => g("Vertical", "vertical", `vertical ${real.map((e) => e.id).join(", ")}`, "v");
      if (hFirst) {
        h();
        v();
      } else {
        v();
        h();
      }
    }
    if (E.length === 1 && real.length) {
      const [a, b] = ends[0];
      d("Length", "length", E[0].id, Math.hypot(...sub(b, a)), "d");
      g("Fix", "fix", `fix ${E[0].id}`, "f");
    }
    if (E.length >= 2) {
      const par = Math.abs(cross(dirs[0], dirs[1])) < 0.05;
      g("Parallel", "parallel", `parallel ${names}`, "p");
      if (E.length === 2) {
        g("Perpendicular", "perpendicular", `perpendicular ${names}`, "l");
        g("Collinear", "collinear", `collinear ${names}`);
      }
      g("Equal", "equal", `equal ${names}`, "e");
      if (E.length === 2) {
        if (par) d("Distance", "distance", names, pointLineDist(ends[1][0], ends[0]), "d");
        let phi = (Math.atan2(cross(dirs[0], dirs[1]), dot(dirs[0], dirs[1])) * 180) / Math.PI;
        const refs = phi < 0 ? `${E[1].id}, ${E[0].id}` : names;
        phi = Math.abs(phi);
        if (!par) d("Angle", "angle", refs, phi, "d");
        const sharesEnd = ends[0].some((p) => ends[1].some((q) => near(p, q)));
        if (sharesEnd) {
          const L = Math.min(...ends.map(([a, b]) => Math.hypot(...sub(b, a))));
          d("Fillet", "fillet", names, niceRound(L * 0.2));
          d("Chamfer", "chamfer", names, niceRound(L * 0.15));
        }
      }
    }
  }

  if (all("point")) {
    const pts = E.map((e) => ptOf(sk, e.id));
    if (E.length === 2) {
      const [a, b] = pts;
      const dd = sub(b, a);
      g("Coincident", "coincident", `coincident ${names}`, "c");
      g(Math.abs(dd[0]) > Math.abs(dd[1]) ? "Level" : "Above each other", Math.abs(dd[0]) > Math.abs(dd[1]) ? "horizontal" : "vertical", `${Math.abs(dd[0]) > Math.abs(dd[1]) ? "horizontal" : "vertical"} ${names}`, Math.abs(dd[0]) > Math.abs(dd[1]) ? "h" : "v");
      d("Distance", "distance", names, Math.hypot(...dd), "d");
      // signed: write them so the value comes out positive
      d("Horizontal distance", "hdistance", dd[0] >= 0 ? names : `${E[1].id}, ${E[0].id}`, Math.abs(dd[0]));
      d("Vertical distance", "vdistance", dd[1] >= 0 ? names : `${E[1].id}, ${E[0].id}`, Math.abs(dd[1]));
    }
    if (E.length === 3) g("Symmetric about the last point", "symmetric", `symmetric ${names}`, "s");
    g("Fix", "fix", `fix ${names}`, "f");
    const corners = E.filter((e) => cornerLines(sk, e.id).length === 2);
    if (corners.length === E.length) {
      const L = Math.min(...corners.flatMap((e) => cornerLines(sk, e.id).map((c) => Math.hypot(...sub(...lineEnds(sk, c.id))))));
      d(E.length > 1 ? "Fillet corners" : "Fillet corner", "fillet", names, niceRound(L * 0.2));
      d(E.length > 1 ? "Chamfer corners" : "Chamfer corner", "chamfer", names, niceRound(L * 0.15));
    }
  }

  if (E.length === 2 && count("point") === 1 && count("line") === 1) {
    const p = E.find((e) => e.type === "point")!;
    const l = E.find((e) => e.type === "line")!;
    g("On line", "coincident", `coincident ${p.id}, ${l.id}`, "c");
    g("Midpoint", "midpoint", `midpoint ${p.id}, ${l.id}`, "m");
    d("Distance", "distance", `${p.id}, ${l.id}`, pointLineDist(ptOf(sk, p.id), lineEnds(sk, l.id)), "d");
  }
  if (E.length === 3 && count("point") === 2 && count("line") === 1 && T[2] === "line") g("Symmetric", "symmetric", `symmetric ${names}`, "s");

  const circ = E.filter((e) => e.type === "circle" || e.type === "arc");
  if (E.length === 2 && circ.length === 1 && count("point") === 1) {
    g("On curve", "coincident", `coincident ${names}`, "c");
  }
  if (E.length === 2 && circ.length === 1 && count("line") === 1) {
    const c = circ[0].c!;
    const l = E.find((e) => e.type === "line")!;
    g("Tangent", "tangent", `tangent ${l.id}, ${c.id}`, "t");
    d("Distance", "distance", `${c.id}, ${l.id}`, pointLineDist(centerOf(sk, c), lineEnds(sk, l.id)), "d");
  }
  if (circ.length === E.length && E.length >= 1) {
    if (E.length === 1) {
      const c = circ[0].c!;
      if (c.kind === "circle") d("Diameter", "diameter", c.id, 2 * radiusOf(sk, c), "d");
      else d("Radius", "radius", c.id, radiusOf(sk, c), "d");
      g("Fix centre", "fix", `fix ${c.id}`, "f");
    }
    if (E.length >= 2) g("Equal", "equal", `equal ${names}`, "e");
    if (E.length === 2) {
      g("Concentric", "concentric", `concentric ${names}`, "o");
      g("Tangent", "tangent", `tangent ${names}`, "t");
      d("Distance", "distance", names, Math.hypot(...sub(centerOf(sk, circ[1].c!), centerOf(sk, circ[0].c!))), "d");
    }
  }
  return out;
}

/** The single best dimension for a selection, used by the dimension tool. */
export function dimensionFor(sk: EvalSketch, ids: string[]): Suggestion | null {
  const s = suggestionsFor(sk, ids).filter((x) => x.dimension && x.kind !== "fillet" && x.kind !== "chamfer");
  return s[0] ?? null;
}

// ---------------- features ----------------

export interface FeatureSpec {
  kind: "extrude" | "revolve";
  /** a new part, or added to / cut from an existing one */
  op: "new" | "add" | "cut";
  part?: string;
  depth?: number;
  reverse?: boolean;
  symmetric?: boolean;
  through?: boolean;
  /** revolve: a line of the sketch */
  axis?: string;
  angle?: number;
  /** keep the depth as a named parameter (shows up as a slider) */
  param?: boolean;
}

function freeName(model: Model, base: string): string {
  const used = new Set(model.blocks.map((b) => b.name));
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}${i}`)) return `${base}${i}`;
}

/** Make a solid from a sketch: a new part, or a boss or cut on an existing part. */
export function addFeature(src: string, sk: EvalSketch, spec: FeatureSpec): { src: string; part: string; param?: string } {
  let out = src;
  let model = evaluate(out);
  const target = spec.op !== "new" ? model.blocks.find((b) => b.kind === "part" && b.name === spec.part) : undefined;
  if (spec.op !== "new" && !target) throw new Error(`There is no part named ${spec.part}`);
  // the sketch must be defined before the part that uses it
  if (target && sk.span.start > target.span.start) {
    const s = lineSpan(out, sk.span);
    const text = out.slice(sk.span.start, sk.span.end);
    out = out.slice(0, s.start) + out.slice(s.end);
    const at = out.lastIndexOf("\n", target.span.start - 1) + 1;
    out = out.slice(0, at) + text + "\n\n" + out.slice(at);
    model = evaluate(out);
  }
  let depthText = spec.depth !== undefined ? fmt(spec.depth) : "10";
  let param: string | undefined;
  if (spec.kind === "extrude" && !spec.through && spec.param && spec.depth !== undefined) {
    param = freeName(model, `${sk.name}_depth`);
    const d = spec.depth;
    const line = `param ${param} = ${fmt(d)} range ${fmt(Math.max(0.1, Math.round((d / 10) * 10) / 10))}..${fmt(Math.max(d * 5, 20))} "${spec.op === "cut" ? "Cut depth" : "Depth"} of ${sk.name}"`;
    const params = model.blocks.filter((b) => b.kind === "param").sort((a, b) => b.span.end - a.span.end);
    const sketchNow = model.sketches.find((s) => s.name === sk.name)!;
    if (params.length) {
      const end = params[0].span.end;
      out = out.slice(0, end) + "\n" + line + out.slice(end);
    } else {
      const at = out.lastIndexOf("\n", sketchNow.span.start - 1) + 1;
      out = out.slice(0, at) + line + "\n\n" + out.slice(at);
    }
    depthText = param;
    model = evaluate(out);
  }
  const extras: string[] = [];
  let expr: string;
  if (spec.kind === "extrude") {
    if (spec.through) expr = `extrude(${sk.name}, through: true)`;
    else {
      if (spec.symmetric) extras.push("symmetric: true");
      else if (spec.reverse) extras.push("reverse: true");
      expr = `extrude(${sk.name}, ${depthText}${extras.map((e) => ", " + e).join("")})`;
    }
  } else {
    if (spec.axis) extras.push(`axis: ${sk.name}.${spec.axis}`);
    if (spec.angle !== undefined && Math.abs(spec.angle - 360) > 1e-9) extras.push(`angle: ${fmt(spec.angle)}`);
    expr = `revolve(${sk.name}${extras.map((e) => ", " + e).join("")})`;
  }
  if (spec.op === "new") {
    const sketchNow = model.sketches.find((s) => s.name === sk.name)!;
    const part = freeName(model, /^sketch\d+$/.test(sk.name) ? sk.name.replace("sketch", "part") : `${sk.name}_part`);
    let at = out.indexOf("\n", sketchNow.span.end);
    if (at < 0) at = out.length;
    out = out.slice(0, at) + `\n\npart ${part} {\n  body ${expr}\n}` + out.slice(at);
    return { src: out, part, param };
  }
  const blk = model.blocks.find((b) => b.kind === "part" && b.name === spec.part)!;
  const close = out.lastIndexOf("}", blk.span.end);
  let p = close;
  while (p > 0 && /\s/.test(out[p - 1])) p--;
  const body = out.slice(blk.span.start, close);
  const indent = /\n([ \t]+)\S/.exec(body)?.[1] ?? "  ";
  out = out.slice(0, p) + `\n${indent}${spec.op} ${expr}` + out.slice(p);
  return { src: out, part: spec.part!, param };
}
