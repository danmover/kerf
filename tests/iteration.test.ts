import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { decisionsFor, paramsDriving, withValues } from "../src/core/decisions";
import { paramChanges, partChanges } from "../src/core/changes";
import { spotText, spotLabel } from "../src/app/spot";

const enclosure = readFileSync(new URL("../src/demos/enclosure.kerf", import.meta.url), "utf8");

describe("what drives a part", () => {
  const m = evaluate(enclosure);
  it("lists the parameters a part is built from, nearest first", () => {
    const ps = paramsDriving(m, "lid", 8);
    expect(ps).toContain("lid_t");
    expect(ps).toContain("width");
    expect(ps).not.toContain("standoff");
    expect(paramsDriving(m, "lid", 2)).toHaveLength(2);
  });
  it("finds the decisions that shape a part", () => {
    const base = m.parts.find((p) => p.name === "base")!;
    expect(decisionsFor(m, base.id).map((d) => d.name)).toContain("wall_thickness");
    const lid = m.parts.find((p) => p.name === "lid")!;
    expect(decisionsFor(m, lid.id).map((d) => d.name)).not.toContain("board_gap");
  });
});

describe("what changed between versions", () => {
  const a = evaluate(enclosure);
  it("names reshaped parts and changed values", () => {
    const b = evaluate(withValues(enclosure, a, { wall: 2.4 }));
    const parts = partChanges(a, b);
    expect(parts.find((p) => p.label === a.parts.find((q) => q.name === "base")!.label)?.kind).toBe("changed");
    expect(parts.every((p) => p.kind !== "added" && p.kind !== "removed")).toBe(true);
    expect(paramChanges(a, b)).toEqual([{ name: "wall", from: 2, to: 2.4 }]);
  });
  it("names added and removed parts", () => {
    const b = evaluate(enclosure + "\npart tab {\n  body box(10, 10, 2)\n}\n");
    expect(partChanges(a, b).filter((p) => p.kind === "added").map((p) => p.id)).toEqual(["tab"]);
    expect(partChanges(b, a).filter((p) => p.kind === "removed").map((p) => p.id)).toEqual(["tab"]);
  });
});

describe("spot descriptions for Claude", () => {
  it("gives coordinates in both frames and the face direction", () => {
    const t = spotText({ partId: "lid", label: "Lid", local: [1, 2, 0], point: [1, 2, 31.6], normal: [0, 0, 1] });
    expect(t).toContain("`lid`");
    expect(t).toContain("(1, 2, 31.6) mm in assembly coordinates");
    expect(t).toContain("(1, 2, 0) mm in the part's own frame");
    expect(t).toContain("(0, 0, 1)");
    expect(spotLabel({ partId: "lid", label: "Lid", point: [1.2, 2, 31.6] })).toBe("Lid · 1, 2, 32");
  });
  it("describes a whole part", () => {
    expect(spotText({ partId: "base", label: "Base" })).toContain("as a whole");
  });
});
