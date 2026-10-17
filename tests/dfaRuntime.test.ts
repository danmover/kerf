import { beforeEach, describe, expect, it, vi } from "vitest";
import type { V3 } from "../src/kernel/recipe";

// the engine's mesh cache and the kernel worker, stood in for
const h = vi.hoisted(() => ({
  meshes: new Map<string, { bbox: [V3, V3]; volume: number }>(),
  refresh: vi.fn(),
  measure: vi.fn(async () => ({ distance: 0, a: [0, 0, 0], b: [0, 0, 0] })),
}));
vi.mock("../src/core/engine", () => ({ meshes: h.meshes, refreshReport: h.refresh }));
vi.mock("../src/kernel/client", () => ({ kernel: { measure: h.measure } }));

import { evaluate } from "../src/lang/evaluator";
import { composeReport, type ReportContext } from "../src/core/reportPasses";
import type { CheckReport } from "../src/core/checks";
import type { Model } from "../src/core/model";
import { dfaFor, latestDfa, startAssemblyChecks, useDfa } from "../src/mfg/dfaRuntime";

const SRC = `design "t"
part plate { material: "PETG" body box(60, 40, 5) }
part block { material: "PETG" body box(20, 20, 15, at: (0, 0, 5)) }
`;

function built(src = SRC): Model {
  const m = evaluate(src);
  for (const p of m.parts) {
    const b = p.recipe.base;
    if (b?.t !== "box") continue;
    h.meshes.set(p.hash, {
      bbox: [
        [b.at[0] - b.w / 2, b.at[1] - b.d / 2, b.at[2]],
        [b.at[0] + b.w / 2, b.at[1] + b.d / 2, b.at[2] + b.h],
      ],
      volume: b.w * b.d * b.h,
    });
  }
  return m;
}

const empty = (): CheckReport => ({ items: [], counts: { pass: 0, fail: 0, warn: 0, pending: 0, info: 0 }, ms: 0 });
const ctx = (model: Model, live: boolean, rev = 1): ReportContext => ({ model, live, rev, buildErrors: new Map(), process: null });
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("assembly checks in the report", () => {
  beforeEach(() => {
    h.meshes.clear();
    h.refresh.mockClear();
    h.measure.mockClear();
  });

  it("adds the assembly items, measures box contacts for the live design, then confirms them", async () => {
    startAssemblyChecks();
    const model = built();
    const first = composeReport(empty(), ctx(model, true));
    const merge = first.items.find((i) => i.id === "dfa:merge:block:plate");
    // judged from boxes until the kernel answers
    expect(merge?.status).toBe("info");
    expect(first.items.find((i) => i.id === "dfa:summary")?.category).toBe("assembly");
    expect(latestDfa()?.merges[0].contact).toBe("boxes");
    expect(useDfa.getState().rev).toBe(1);

    await settle();
    expect(h.measure).toHaveBeenCalledTimes(1);
    expect(h.refresh).toHaveBeenCalled();

    const again = composeReport(empty(), ctx(model, true));
    expect(again.items.find((i) => i.id === "dfa:merge:block:plate")?.status).toBe("warn");
    expect(latestDfa()?.merges[0].contact).toBe("confirmed");
    expect(useDfa.getState().measuring).toBe(0);
    // the same placement is not measured twice
    await settle();
    expect(h.measure).toHaveBeenCalledTimes(1);
    // tools read the same numbers without composing a report
    expect(dfaFor(model).merges[0].contact).toBe("confirmed");
  });

  it("does no kernel work and leaves the shared report alone for an isolated build", async () => {
    startAssemblyChecks();
    // touching again, at a placement not measured before
    const model = built(SRC.replace("at: (0, 0, 5)", "at: (10, 0, 5)"));
    const before = latestDfa();
    const r = composeReport(empty(), ctx(model, false, 0));
    expect(r.items.find((i) => i.id === "dfa:merge:block:plate")?.status).toBe("info");
    await settle();
    expect(h.measure).not.toHaveBeenCalled();
    expect(latestDfa()).toBe(before);
  });
});
