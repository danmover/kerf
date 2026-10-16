import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { unexplainedLiterals } from "../src/ai/review/literals";
import { buildInventory, inventoryDigest, inventoryText } from "../src/ai/review/inventory";
import { ReviewSession, designerReport, verdictOf } from "../src/ai/review/session";
import { isSubstantial } from "../src/ai/review/gate";
import type { Finding, ReviewResult } from "../src/ai/review/types";
import type { PartInspection } from "../src/kernel/inspect";

const ENCLOSURE = readFileSync(new URL("../src/demos/enclosure.kerf", import.meta.url), "utf8");

describe("unexplained dimensions", () => {
  it("flags numbers typed into geometry, not params, scale factors or epsilons", () => {
    const src = `design "t"
param w = 40mm
param wall = 2mm
part plate {
  body box(w, 26, 2 * wall)
  cut hole(M3, at: (w / 2 - 6, 0, 0))
  add cylinder(d: 8, h: 5.01, at: (0, 0, -0.01))
}`;
    const lits = unexplainedLiterals(src);
    const values = lits.map((l) => l.value);
    expect(values).toContain("26");
    expect(values).toContain("6");
    expect(values).toContain("8");
    expect(values).toContain("5.01");
    // 2 * wall and w / 2 are scale factors; -0.01 is an overlap epsilon
    expect(values).not.toContain("2");
    expect(values).not.toContain("0.01");
    const l26 = lits.find((l) => l.value === "26")!;
    expect(l26.part).toBe("plate");
    expect(l26.line).toBe(5);
    expect(l26.context).toBe("body box(w, 26, 2 * wall)");
  });

  it("ignores params, lets and interfaces outside parts", () => {
    const lits = unexplainedLiterals(ENCLOSURE);
    expect(lits.every((l) => l.part)).toBe(true);
    // the board interface and the frozen pcb component are defined with names
    expect(lits.some((l) => l.context.startsWith("param") || l.context.startsWith("let"))).toBe(false);
    // the lid screw insert depth is typed straight in
    expect(lits.some((l) => l.part === "base" && l.value === "7")).toBe(true);
  });
});

describe("the substantial-change gate", () => {
  const base = `design "t"\nparam w = 40mm\npart a {\n  body box(w, 20, 5)\n}\n`;
  it("reviews new designs and added or removed parts", () => {
    expect(isSubstantial("", base)).toBe(true);
    expect(isSubstantial(base, base + `part b {\n  body box(5, 5, 5)\n}\n`)).toBe(true);
    expect(isSubstantial(base, base.replace("part a", "part b"))).toBe(true);
  });
  it("skips a small tweak", () => {
    expect(isSubstantial(base, base.replace("40mm", "45mm"))).toBe(false);
  });
  it("reviews a dozen changed lines", () => {
    const more = base.replace("  body box(w, 20, 5)\n", "  body box(w, 20, 5)\n" + Array.from({ length: 12 }, (_, i) => `  cut hole(M3, at: (${i}, 0, 0))\n`).join(""));
    expect(isSubstantial(base, more)).toBe(true);
  });
});

const finding = (id: string, severity: Finding["severity"], extra: Partial<Finding> = {}): Finding => ({
  id,
  round: 1,
  severity,
  area: "detail",
  title: `Finding ${id}`,
  detail: "why",
  fix: "fillet(1)",
  parts: ["lid"],
  view: "iso",
  needsUser: false,
  status: "open",
  ...extra,
});

const result = (round: number, findings: Finding[], earlier: Finding[] = []): ReviewResult => ({
  round,
  verdict: verdictOf([...earlier, ...findings]),
  summary: "Summary.",
  assumptions: "FDM in PETG.",
  checked: [{ area: "detail", result: findings.length ? "issues" : "ok", note: "" }],
  findings,
  earlier,
  views: [],
  sheet: "",
  inventory: { parts: [], literals: [], missing: [] },
  source: `src ${round}`,
  model: "claude-test",
  usage: { input: 1, output: 1, cacheRead: 0, calls: 1 },
  ms: 1,
});

describe("verdicts", () => {
  it("revises on an open blocker or major, asks on a user decision, passes on minors", () => {
    expect(verdictOf([finding("R1", "major")])).toBe("revise");
    expect(verdictOf([finding("R1", "blocker", { needsUser: true, status: "needs_user" })])).toBe("decide");
    expect(verdictOf([finding("R1", "minor")])).toBe("pass");
    expect(verdictOf([finding("R1", "major", { status: "verified" }), finding("R2", "major", { status: "accepted" })])).toBe("pass");
    expect(verdictOf([finding("R1", "major", { status: "still_open" })])).toBe("revise");
  });
});

describe("review sessions", () => {
  it("numbers findings, records responses and carries what is not settled", () => {
    const s = new ReviewSession(2);
    expect(s.canReview).toBe(true);
    expect(s.nextId).toBe(1);
    s.add(result(1, [finding("R1", "major"), finding("R2", "minor"), finding("R3", "major", { needsUser: true, status: "needs_user" })]));
    expect(s.round).toBe(1);
    expect(s.roundsLeft).toBe(1);
    expect(s.nextId).toBe(4);
    expect(s.lastSource).toBe("src 1");

    const unknown = s.respond([
      { id: "r1", status: "fixed", note: "Added a 1 mm fillet" },
      { id: "R9", status: "fixed", note: "" },
    ]);
    expect(unknown).toEqual(["R9"]);
    expect(s.findings.find((f) => f.id === "R1")!.status).toBe("fixed");
    expect(s.findings.find((f) => f.id === "R1")!.response).toBe("Added a 1 mm fillet");
    expect(s.carried().map((f) => f.id)).toEqual(["R1", "R2", "R3"]);

    s.add(result(2, [finding("R4", "minor", { round: 2 })], [finding("R1", "major", { status: "verified" })]));
    expect(s.canReview).toBe(false);
    expect(s.carried().map((f) => f.id)).toEqual(["R2", "R3", "R4"]);
  });

  it("tells the designer what to fix and what to put to the user", () => {
    const r = result(1, [finding("R2", "minor"), finding("R1", "blocker"), finding("R3", "major", { needsUser: true, status: "needs_user" })]);
    const text = designerReport(r, 1, true);
    expect(text).toMatch(/Automatic self-review round 1/);
    expect(text).toMatch(/Verdict: changes needed/);
    // most severe first
    expect(text.indexOf("R1 [blocker")).toBeLessThan(text.indexOf("R2 [minor"));
    expect(text).toMatch(/needs the user/);
    expect(text).toMatch(/ask_user/);
    expect(text).toMatch(/call review_design again/);
    expect(text).toMatch(/already visible to the user/);

    const last = designerReport(result(2, [finding("R4", "major")]), 0, false);
    expect(last).toMatch(/last review round/);
    expect(last).not.toMatch(/call review_design again/);

    const clean = designerReport(result(1, []), 1, false);
    expect(clean).toMatch(/Verdict: passes/);
    expect(clean).toMatch(/Nothing to fix/);
  });
});

describe("the detail inventory", () => {
  const inspection: PartInspection = {
    faces: 40,
    edges: 96,
    sharp: { count: 30, length: 900, holeRims: 6, bossRims: 2, top: [{ kind: "outer", at: [10, 0, 5], length: 80, angle: 90 }] },
    internal: { count: 4, length: 120, top: [{ kind: "internal", at: [0, 0, 2], length: 30, angle: 90 }] },
    blended: 12,
    tiny: 0,
    support: [
      { down: "-Z", area: 0 },
      { down: "+Z", area: 5400 },
      { down: "-X", area: 300 },
      { down: "+X", area: 300 },
      { down: "-Y", area: 200 },
      { down: "+Y", area: 200 },
    ],
    walls: { min: 0.7, p5: 1.9, at: [1, 2, 3], samples: 600 },
    truncated: false,
    ms: 12,
  };

  it("measures each custom part once, in world space, and skips library hardware", async () => {
    const model = evaluate(ENCLOSURE);
    const asked: string[][] = [];
    const inv = await buildInventory(
      model,
      ENCLOSURE,
      async (hashes) => {
        asked.push(hashes);
        return Object.fromEntries(hashes.map((h) => [h, inspection]));
      },
      () => [
        [-45, -35, 0],
        [45, 35, 31.6],
      ],
    );
    const custom = new Set(model.parts.filter((p) => p.kind === "part").map((p) => p.name));
    expect(inv.parts.map((p) => p.name).sort()).toEqual([...custom].sort());
    expect(asked).toHaveLength(1);
    expect(inv.missing).toEqual([]);
    const base = inv.parts.find((p) => p.name === "base")!;
    expect(base.material).toBe("PETG");
    expect(base.size[0]).toBeCloseTo(90);
    expect(base.asPlaced).toBe("-Z");

    const text = inventoryText(inv);
    expect(text).toMatch(/Part "base"/);
    expect(text).toMatch(/6 hole rims with no chamfer/);
    expect(text).toMatch(/Thinnest wall ≈ 0\.7 mm/);
    expect(text).toMatch(/part -Z on the bed\): 0 mm² needs support/);
    expect(inventoryDigest(inv)).toMatch(/thinnest wall 0\.7 mm/);
  });

  it("lists parts the kernel could not measure", async () => {
    const model = evaluate(ENCLOSURE);
    const inv = await buildInventory(model, ENCLOSURE, async () => {
      throw new Error("kernel busy");
    }, () => undefined);
    expect(inv.missing.length).toBeGreaterThan(0);
    expect(inventoryText(inv)).toMatch(/not measured: kernel busy/);
  });
});

describe("unexplained dimensions in the inventory", () => {
  it("lists each number once per line, grouped by line", async () => {
    const src = `design "t"\nparam w = 40mm\npart a {\n  body box(w - 0.4, w - 0.4, 26)\n  add box(3, 3, 3)\n}\n`;
    const lits = unexplainedLiterals(src);
    expect(lits.filter((l) => l.line === 4).map((l) => l.value)).toEqual(["0.4", "26"]);
    const text = inventoryText({ parts: [], literals: lits, missing: [] });
    expect(text).toMatch(/a, line 4: 0\.4, 26 in `body box\(w - 0\.4, w - 0\.4, 26\)`/);
    expect(text).toMatch(/a, line 5: 3 in/);
  });
});
