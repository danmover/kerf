// Branches and merging: the three-way merge takes each side's changes and stops on places both changed, the merge
// base follows where two branches last met (unless an undo took that back), and a branch's history runs through
// the branch it was made from.

import { describe, expect, it } from "vitest";
import { branchLine, branchNameProblem, cleanBranchName, firstChoice, hasChanges, mainSource, matchLines, merge3, mergeBase, mergedText, nextBranchName } from "../src/core/branches";
import type { BranchRecord, VersionRecord } from "../src/persist/db";

const L = (...lines: string[]) => lines.join("\n");

/** Longest common subsequence length, the slow sure way. */
function lcsLength(a: string[], b: string[]) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  return dp[0][0];
}

describe("matching lines", () => {
  it("finds as many equal lines as there can be, in order", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
    for (let t = 0; t < 300; t++) {
      const a = Array.from({ length: Math.floor(rnd() * 14) }, () => "abcd"[Math.floor(rnd() * 4)]);
      const b = Array.from({ length: Math.floor(rnd() * 14) }, () => "abcd"[Math.floor(rnd() * 4)]);
      const m = matchLines(a, b);
      expect(m.length).toBe(lcsLength(a, b));
      for (let k = 0; k < m.length; k++) {
        expect(a[m[k][0]]).toBe(b[m[k][1]]);
        if (k) expect(m[k][0] > m[k - 1][0] && m[k][1] > m[k - 1][1]).toBe(true);
      }
    }
  });

  it("is quick on a long design changed in a few places", () => {
    const base = Array.from({ length: 6000 }, (_, i) => `  let v${i} = ${i}`);
    const edited = [...base];
    edited[10] = "  let v10 = 99";
    edited[5990] = "  let v5990 = 99";
    edited.splice(3000, 0, "  let added = 1");
    const t0 = performance.now();
    const m = matchLines(base, edited);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(m.length).toBe(5998);
  });
});

describe("three-way merge", () => {
  const base = L("param width = 40", "param height = 20", "", "part arm {", "  box: (width, 10, 4)", "}", "", "part base {", "  box: (60, 60, 5)", "}");

  it("takes each side's changes in different places", () => {
    const ours = base.replace("param width = 40", "param width = 45");
    const theirs = base.replace("box: (60, 60, 5)", "box: (60, 60, 8)");
    const r = merge3(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(mergedText(r, () => "ours")).toBe(base.replace("width = 40", "width = 45").replace("(60, 60, 5)", "(60, 60, 8)"));
    expect([r.fromOurs, r.fromTheirs]).toEqual([1, 1]);
  });

  it("needs nothing settled when both made the same change, or one side changed nothing", () => {
    const both = base.replace("height = 20", "height = 25");
    expect(merge3(base, both, both).conflicts).toEqual([]);
    expect(mergedText(merge3(base, both, both), () => "ours")).toBe(both);
    expect(mergedText(merge3(base, base, both), () => "ours")).toBe(both);
    expect(mergedText(merge3(base, both, base), () => "ours")).toBe(both);
  });

  it("stops on a line both changed differently, says where it is, and settles it as chosen", () => {
    const ours = base.replace("box: (width, 10, 4)", "box: (width, 12, 4)");
    const theirs = base.replace("box: (width, 10, 4)", "box: (width, 10, 6)");
    const r = merge3(base, ours, theirs);
    expect(r.conflicts.length).toBe(1);
    const c = r.conflicts[0];
    expect(c).toMatchObject({ base: ["  box: (width, 10, 4)"], ours: ["  box: (width, 12, 4)"], theirs: ["  box: (width, 10, 6)"], line: 5, where: "part arm" });
    expect(firstChoice(c)).toBeUndefined();
    expect(mergedText(r, () => "ours")).toBe(ours);
    expect(mergedText(r, () => "theirs")).toBe(theirs);
    expect(mergedText(r, () => "both").split("\n").slice(3, 7)).toEqual(["part arm {", "  box: (width, 12, 4)", "  box: (width, 10, 6)", "}"]);
  });

  it("keeps both new parts added at the same spot, to start with", () => {
    const ours = `${base}\n\npart lid {\n  box: (60, 60, 2)\n}`;
    const theirs = `${base}\n\npart foot {\n  cylinder: (5, 3)\n}`;
    const r = merge3(base, ours, theirs);
    expect(r.conflicts.length).toBe(1);
    expect(r.conflicts[0].base).toEqual([]);
    expect(firstChoice(r.conflicts[0])).toBe("both");
    const merged = mergedText(r, (c) => firstChoice(c)!);
    expect(merged).toContain("part lid {");
    expect(merged).toContain("part foot {");
    expect(merged.indexOf("part lid")).toBeLessThan(merged.indexOf("part foot"));
  });

  it("takes a part one side removed, and stops where the other side changed it", () => {
    const removed = base.replace("\npart base {\n  box: (60, 60, 5)\n}", "");
    expect(mergedText(merge3(base, base, removed), () => "ours")).toBe(removed);
    const changed = base.replace("(60, 60, 5)", "(70, 60, 5)");
    const r = merge3(base, changed, removed);
    expect(r.conflicts.length).toBe(1);
    expect(r.conflicts[0].where).toBe("part base");
    expect(r.conflicts[0].theirs).toEqual([]);
  });
});

describe("where two branches last met", () => {
  // main and a branch made from F: main changes the width, the branch the arm, then it goes into main
  const F = L("param width = 40", "param height = 20", "part arm {", "  box: (width, 10, 4)", "}", "part base {", "  box: (60, 60, 5)", "}");
  const M1 = F.replace("width = 40", "width = 45");
  const B1 = F.replace("(width, 10, 4)", "(width, 12, 4)");
  const merged1 = mergedText(merge3(F, M1, B1), () => "ours");
  const branch = (meets: BranchRecord["meets"] = []): BranchRecord => ({ id: "brn_1", name: "longer arm", from: "main", base: F, head: B1, createdAt: 1, updatedAt: 2, meets });

  it("merges again from where the branch last went into main", () => {
    expect(merged1).toBe(F.replace("width = 40", "width = 45").replace("(width, 10, 4)", "(width, 12, 4)"));
    // the branch changes the same line again
    const B2 = B1.replace("(width, 12, 4)", "(width, 14, 4)");
    const b = branch([{ kind: "merged", source: B1, base: F, ts: 3 }]);
    const at = mergeBase(b, merged1, B2);
    expect(at).toBe(B1);
    const r = merge3(at, merged1, B2);
    expect(r.conflicts).toEqual([]);
    expect(mergedText(r, () => "ours")).toBe(merged1.replace("(width, 12, 4)", "(width, 14, 4)"));
    // from the start instead, the same line would be a conflict
    expect(merge3(F, merged1, B2).conflicts.length).toBe(1);
  });

  it("goes back to the start when main took the merge back", () => {
    const B2 = B1.replace("(60, 60, 5)", "(60, 60, 6)");
    const b = branch([{ kind: "merged", source: B1, base: F, ts: 3 }]);
    // undo on main: it has M1 but not the arm
    expect(hasChanges(F, B1, M1)).toBe(false);
    expect(mergeBase(b, M1, B2)).toBe(F);
    expect(mergedText(merge3(F, M1, B2), () => "ours")).toBe(M1.replace("(width, 10, 4)", "(width, 12, 4)").replace("(60, 60, 5)", "(60, 60, 6)"));
  });

  it("goes back one merge when main undid only the last one", () => {
    // the arm went in at 12, then at 14; main undid the second merge and has 12 again
    const B2 = B1.replace("(width, 12, 4)", "(width, 14, 4)");
    const b = branch([
      { kind: "merged", source: B1, base: F, ts: 3 },
      { kind: "merged", source: B2, base: B1, ts: 4 },
    ]);
    const at = mergeBase(b, merged1, B2);
    expect(at).toBe(B1);
    expect(mergedText(merge3(at, merged1, B2), () => "ours")).toBe(merged1.replace("(width, 12, 4)", "(width, 14, 4)"));
  });

  it("counts a line main changed again after the merge as still having it", () => {
    const later = merged1.replace("(width, 12, 4)", "(width, 11, 4)");
    expect(hasChanges(F, B1, later)).toBe(true);
  });

  it("merges into main from where the branch last took main's changes", () => {
    // the branch took M1, then main changed the width again
    const took = mergedText(merge3(F, B1, M1), () => "ours");
    const M2 = M1.replace("width = 45", "width = 50");
    const b = branch([{ kind: "took", source: M1, base: F, ts: 3 }]);
    expect(mergeBase(b, M2, took)).toBe(M1);
    const r = merge3(M1, M2, took);
    expect(r.conflicts).toEqual([]);
    expect(mergedText(r, () => "ours")).toBe(M2.replace("(width, 10, 4)", "(width, 12, 4)"));
    // the branch took it back (undo): main's change is not undone by the merge
    expect(mergeBase(b, M2, B1)).toBe(F);
    expect(mergedText(merge3(F, M2, B1), () => "ours")).toContain("width = 50");
  });
});

describe("branch names and lines", () => {
  it("checks names and finds a free one", () => {
    const list = [{ id: "main", name: "main" }, { id: "b1", name: "idea 1" }, { id: "b2", name: "Lighter arms" }];
    expect(branchNameProblem("main", list)).toMatch(/main/);
    expect(branchNameProblem(" lighter   ARMS ", list)).toMatch(/already/);
    expect(branchNameProblem("Lighter arms", list, "b2")).toBeNull();
    expect(branchNameProblem("Lighter arms", list, "b1")).toMatch(/already/);
    expect(branchNameProblem("---", list)).toMatch(/letter/);
    expect(branchNameProblem("", list)).toMatch(/name/);
    expect(branchNameProblem("three arms", list)).toBeNull();
    expect(cleanBranchName("  three \n arms ")).toBe("three arms");
    expect(nextBranchName(list)).toBe("idea 2");
  });

  it("runs a branch's history through the one it was made from, up to when it was", () => {
    const v = (id: string, ts: number, branch?: string): VersionRecord => ({ id, projectId: "p", ts, author: "you", message: id, source: id, ...(branch ? { branch } : {}) });
    const versions = [v("m1", 1), v("m2", 2), v("x1", 3, "x"), v("y1", 3.5, "y"), v("x2", 4, "x"), v("m3", 5), v("y2", 6, "y")];
    const branches: BranchRecord[] = [
      { id: "main", name: "main", from: "", base: "", head: "m3", createdAt: 0, updatedAt: 5 },
      { id: "x", name: "lighter", from: "main", base: "m2", head: "x2", createdAt: 2.5, updatedAt: 4 },
      { id: "y", name: "lighter still", from: "x", base: "x1", head: "y2", createdAt: 3.2, updatedAt: 6 },
    ];
    expect(branchLine(versions, branches, "main").versions.map((x) => x.id)).toEqual(["m1", "m2", "m3"]);
    expect(branchLine(versions, branches, "x").versions.map((x) => x.id)).toEqual(["m1", "m2", "x1", "x2"]);
    const y = branchLine(versions, branches, "y");
    expect(y.versions.map((x) => x.id)).toEqual(["m1", "m2", "x1", "y1", "y2"]);
    expect(y.forks.map((f) => `${f.branch}<${f.from}`)).toEqual(["y<x", "x<main"]);
    // other designs place a project's main line
    expect(mainSource({ branch: "x", branches, source: "x2" })).toBe("m3");
    expect(mainSource({ source: "m3" })).toBe("m3");
  });
});
