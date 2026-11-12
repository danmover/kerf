// Trim and extend in the sketch editor: what they write, and that the sketch still solves with the cut ends tied
// to the curves they were cut at. Also the chain an offset follows and the side the cursor puts it on.

import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { chainFrom, extendAt, offsetFor, offsetStatement, patternStatement, pieceAt, trimAt } from "../src/sketch/modify";
import type { EvalSketch } from "../src/sketch/types";

const doc = (body: string) => `design "t"\n${body}\n`;
const sketchIn = (src: string): EvalSketch => {
  const m = evaluate(src);
  expect(m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  return m.sketches[0];
};
const at = (sk: EvalSketch, id: string) => {
  const p = sk.points.find((q) => q.id === id || sk.aliases[id] === q.id);
  if (!p) throw new Error(`no point ${id}`);
  return [Math.round(p.x * 1000) / 1000, Math.round(p.y * 1000) / 1000];
};
const apply = (src: string, r: { src: string; message: string } | { error: string }) => {
  if ("error" in r) throw new Error(r.error);
  return r.src;
};

// a cross: l1 along x, l2 up through it at x = 10
const CROSS = doc(`sketch s {
  line l1 = (0, 0) -> (30, 0)
  line l2 = (10, -10) -> (10, 10)
  horizontal l1
  vertical l2
  length l1 = 30
}`);

describe("trim", () => {
  it("cuts an end back to the crossing, ties it there and drops the length it no longer has", () => {
    const sk = sketchIn(CROSS);
    expect(pieceAt(sk, "l1", [25, 0])!.kind).toBe("end");
    const out = apply(CROSS, trimAt(CROSS, sk, "l1", [25, 0]));
    expect(out).toContain("line l1 = (0, 0) -> (10, 0)");
    expect(out).toContain("coincident l1.end, l2");
    expect(out).not.toContain("length l1");
    const after = sketchIn(out);
    expect(after.solved).toBe(true);
    expect(at(after, "l1.end")).toEqual([10, 0]);
  });

  it("cuts a piece out of the middle into two curves kept in line", () => {
    const src = doc(`sketch s {
  line l1 = (0, 0) -> (30, 0)
  line l2 = (10, -10) -> (10, 10)
  line l3 = (20, -10) -> (20, 10)
  line l4 = l1.end -> (30, 10)
}`);
    const sk = sketchIn(src);
    const p = pieceAt(sk, "l1", [15, 0])!;
    expect(p.kind).toBe("middle");
    const out = apply(src, trimAt(src, sk, "l1", [15, 0]));
    expect(out).toContain("line l5 = (20, 0) -> (30, 0)");
    // l4 started at l1's old end: it now starts on the new piece
    expect(out).toContain("line l4 = l5.end -> (30, 10)");
    expect(out).toContain("coincident l1.end, l2");
    expect(out).toContain("coincident l5.start, l3");
    expect(out).toContain("collinear l1, l5");
    const after = sketchIn(out);
    expect(after.solved).toBe(true);
    expect(at(after, "l1.end")).toEqual([10, 0]);
    expect(at(after, "l4.start")).toEqual([30, 0]);
  });

  it("turns a circle into the arc left between two crossings", () => {
    const src = doc(`sketch s {
  circle c1 = (0, 0), r: 10
  line l1 = (-20, 0) -> (20, 0)
  radius c1 = 10
}`);
    const sk = sketchIn(src);
    // click the top half: the bottom half stays, from (-10, 0) round to (10, 0)
    const out = apply(src, trimAt(src, sk, "c1", [0, 10]));
    expect(out).toContain("arc c1 = (-10, 0) -> (10, 0), center: (0, 0)");
    expect(out).toContain("radius c1 = 10");
    const after = sketchIn(out);
    expect(after.solved).toBe(true);
    expect(after.curves.find((c) => c.id === "c1")!.kind).toBe("arc");
  });

  it("deletes a curve nothing crosses, and leaves copies and projected lines alone", () => {
    const src = doc(`sketch s {
  line l1 = (0, 0) -> (30, 0)
  line l2 = (0, 5) -> (30, 5)
  mirror l1, about: y_axis
}`);
    const sk = sketchIn(src);
    const out = apply(src, trimAt(src, sk, "l2", [5, 5]));
    expect(out).not.toContain("line l2");
    const r = trimAt(src, sk, "l1_m", [-5, 0]);
    expect("error" in r && r.error).toMatch(/copy made by a mirror/);
  });

  it("keeps a corner that met the trimmed end", () => {
    // l1 runs past l3 to a corner with l2; trimming that piece leaves l2 where it was
    const src = doc(`sketch s {
  line l1 = (0, 0) -> (30, 0)
  line l2 = l1.end -> (30, 20)
  line l3 = (20, -10) -> (20, 10)
}`);
    const sk = sketchIn(src);
    const out = apply(src, trimAt(src, sk, "l1", [25, 0]));
    expect(out).toContain("line l1 = (0, 0) -> (20, 0)");
    expect(out).toContain("line l2 = (30, 0) -> (30, 20)");
    const after = sketchIn(out);
    expect(at(after, "l2.start")).toEqual([30, 0]);
  });
});

describe("extend", () => {
  it("runs a loose end on to the next curve", () => {
    const src = doc(`sketch s {
  line l1 = (0, 0) -> (5, 0)
  line l2 = (10, -10) -> (10, 10)
  line l3 = (20, -10) -> (20, 10)
  horizontal l1
}`);
    const sk = sketchIn(src);
    const out = apply(src, extendAt(src, sk, "l1", [5, 0]));
    expect(out).toContain("line l1 = (0, 0) -> (10, 0)");
    expect(out).toContain("coincident l1.end, l2");
    const after = sketchIn(out);
    expect(at(after, "l1.end")).toEqual([10, 0]);
    expect("error" in extendAt(src, sk, "l1", [0, 0]) && (extendAt(src, sk, "l1", [0, 0]) as { error: string }).error).toMatch(/Nothing is in the way/);
  });

  it("will not pull a corner apart", () => {
    const src = doc(`sketch s {
  line l1 = (0, 0) -> (5, 0)
  line l2 = l1.end -> (5, 5)
  line l3 = (10, -10) -> (10, 10)
}`);
    const r = extendAt(src, sketchIn(src), "l1", [5, 0]);
    expect("error" in r && r.error).toMatch(/only a loose end/);
  });
});

describe("offset and pattern from the editor", () => {
  const RECT = doc(`sketch s {
  line l1 = (0, 0) -> (40, 0)
  line l2 = l1.end -> (40, 20)
  line l3 = l2.end -> (0, 20)
  line l4 = l3.end -> l1.start
}`);

  it("finds the chain from the curve clicked, and the side from the cursor", () => {
    const sk = sketchIn(RECT);
    expect(chainFrom(sk, "l3")).toEqual(["l3", "l4", "l1", "l2"]);
    const ids = chainFrom(sk, "l1");
    // below the bottom edge is outside the loop: a positive offset
    const out = offsetFor(sk, ids, [20, -3])!;
    expect(out.by).toBeCloseTo(3, 6);
    expect(offsetFor(sk, ids, [20, 2])!.by).toBeCloseTo(-2, 6);
    const src = RECT.replace("\n}\n", `\n  ${offsetStatement(ids, out.by)}\n}\n`);
    const after = sketchIn(src);
    expect(at(after, "l1_o.start")).toEqual([-3, -3]);
  });

  it("writes row, grid and ring patterns the language reads", () => {
    expect(patternStatement(["c1"], { count: 4, step: [12, 0] })).toBe("pattern c1, count: 4, step: (12, 0)");
    expect(patternStatement(["c1"], { count: 3, step: [12, 0], count2: 2, step2: [0, 8] })).toBe("pattern c1, count: 3, step: (12, 0), count2: 2, step2: (0, 8)");
    expect(patternStatement(["c1", "l2"], { count: 6, around: "origin", angle: 360 })).toBe("pattern c1, l2, count: 6, around: origin");
    expect(patternStatement(["c1"], { count: 3, around: "c0", angle: 90 })).toBe("pattern c1, count: 3, around: c0, angle: 90");
  });
});
