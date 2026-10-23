// Streamlined tubes laid along a path, the UCI's tube rules, one-piece
// carbon moulding (mould halves, slides, split cores and the laminate), and
// the aero road bike template passing every check.

import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Shape3D } from "replicad";
import { evaluate } from "../src/lang/evaluator";
import { buildPart, solidVolume } from "../src/kernel/build";
import { uciChecks } from "../src/core/uciChecks";
import { analysisMesh } from "../src/mfg/brep";
import { analyzeSolid, prepareSolid } from "../src/mfg/analyze";
import { resolveRules } from "../src/mfg/profiles";
import { processFromText } from "../src/mfg/spec";
import { estimateCost } from "../src/mfg/cost";
import type { ProcessSpec } from "../src/mfg/types";
import type { V3 } from "../src/kernel/recipe";
import { fullCheck } from "./helpers/fullcheck";
import { initKernel } from "./helpers/kernel";

beforeAll(() => initKernel(), 60_000);

const part = (src: string, name?: string) => {
  const m = evaluate(src);
  expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const p = name ? m.parts.find((q) => q.name === name)! : m.parts[0];
  return buildPart(p.recipe) as Shape3D;
};
const bounds = (s: Shape3D) => s.boundingBox.bounds as [V3, V3];

describe("aero_path", () => {
  const tube = (on: string) =>
    part(`design "Tube"
part tube { body aero_path([(0, 0, 0), (0, 0, 100), (0, 0, 200)], chord: 60, thickness: 20, tail: 0.7, on: "${on}") }`);

  it("lays the leading or trailing edge along its points", () => {
    // the nose turns into the wind (X)
    const nose = bounds(tube("nose"));
    expect(nose[1][0]).toBeCloseTo(0, 0);
    expect(nose[0][0]).toBeCloseTo(-60, 0);
    const tail = bounds(tube("tail"));
    expect(tail[0][0]).toBeCloseTo(0, 0);
    expect(tail[1][0]).toBeCloseTo(60, 0);
    // by default the points run through the widest part of the section
    expect(bounds(tube("middle"))[1][0]).toBeCloseTo((0.3 * 60) / 0.7, 0);
  });

  it("skins a smooth solid through sections that change along it", () => {
    const s = part(`design "Tube"
part tube { body aero_path([(0, 0, 0), (0, 0, 120), (40, 0, 240), (40, 0, 360)], chord: [90, 60, 50, 80], thickness: [40, 24, 20, 36], tail: 0.65) }`);
    expect(solidVolume(s)).toBeGreaterThan(200_000);
  });
});

describe("UCI tube sections", () => {
  const tubes = (body: string) => {
    const m = evaluate(`design "Tubes"
part frame { body ${body} }
part front_tyre { body cylinder(d: 680, h: 28, at: (600, -14, 340), dir: Y) }
part rear_tyre { body cylinder(d: 680, h: 28, at: (-400, -14, 340), dir: Y) }
part saddle { body box(260, 140, 40, at: (-200, 0, 980), center: true) }
part handlebar { body cylinder(d: 30, h: 420, at: (450, -210, 1000), dir: Y) }
analysis "UCI" {
  uci: "road"
  bottom_bracket: (0, 0, 270)
  wheels: [front_tyre, rear_tyre]
  saddle: saddle
  bars: handlebar
}`);
    expect(m.diagnostics).toEqual([]);
    return uciChecks(m, undefined, () => undefined).find((i) => i.id === "uci:UCI:tubes")!;
  };

  it("leaves the joints at a path's ends free", () => {
    // 120 mm deep at both ends, where it meets the next tubes, 70 mm between
    expect(tubes(`aero_path([(0, 0, 0), (0, 0, 100), (0, 0, 200), (0, 0, 300)], chord: [120, 70, 60, 120], thickness: [30, 25, 20, 30], tail: 0.65)`).status).toBe("pass");
    expect(tubes(`aero_path([(0, 0, 0), (0, 0, 100), (0, 0, 200), (0, 0, 300)], chord: [120, 90, 60, 120], thickness: [30, 25, 20, 30], tail: 0.65)`).status).toBe("fail");
  });

  it("allows the head tube 160 mm and holds every element to 10 mm thick", () => {
    expect(tubes(`aero_tube((0, 0, 0), (0, 0, 150), 140, 50, tail: 0.65, role: "head")`).status).toBe("pass");
    expect(tubes(`aero_tube((0, 0, 0), (0, 0, 150), 140, 50, tail: 0.65)`).status).toBe("fail");
    const thin = tubes(`aero_tube((0, 0, 0), (0, 0, 300), 40, 8, tail: 0.7, role: "stay")`);
    expect(thin.status).toBe("fail");
    expect(thin.detail).toMatch(/8 mm thick \(at least 10\)/);
  });
});

describe("carbon layup", () => {
  // a fork-like U: two legs under a bridge, open at the bottom
  const U = `design "U"
part u {
  material: "Carbon fiber"
  body box(20, 80, 10, at: (0, 0, 95), center: true)
  add box(20, 10, 100, at: (0, 35, 50), center: true)
  add box(20, 10, 100, at: (0, -35, 50), center: true)
}`;
  const check = (settings: ProcessSpec["settings"]) => {
    const s = part(U);
    const ctx = prepareSolid(analysisMesh(s, s.mesh({ tolerance: 0.05, angularTolerance: 10 })), { tolerance: 0.05 });
    const { findings, stats } = analyzeSolid(ctx, resolveRules({ id: "carbon_layup", settings }, "Carbon fiber"));
    const f = (rule: string) => findings.filter((x) => x.rule === rule);
    return { f, stats };
  };

  it("reads as a process from words", () => {
    expect(processFromText("carbon fibre layup")).toBe("carbon_layup");
    expect(processFromText("bladder moulded carbon")).toBe("carbon_layup");
  });

  it("fails faces neither mould half reaches, unless a slide or split cores free them", () => {
    const halves = check({ pull: [0, 1, 0] });
    const under = halves.f("undercut")[0];
    expect(under.status).toBe("fail");
    // the legs' inner faces and the bridge's underside, 2 × 20 × 90 + 20 × 60
    expect(under.marks!.length / 9).toBeGreaterThan(0);
    expect(under.detail).toMatch(/^4[78]\d\d mm²/);
    expect(check({ pull: [0, 1, 0], cores: true }).f("undercut")[0].status).toBe("info");

    const slid = check({ pull: [0, 1, 0], slides: [[0, 0, -1], [1, 0, 0]] });
    expect(slid.f("undercut")[0].status).toBe("pass");
    expect(slid.f("slides").map((x) => x.status).sort()).toEqual(["info", "warn"]);
    expect(slid.f("slides").find((x) => x.status === "warn")!.title).toMatch(/along X is not needed/);
  });

  it("weighs the laminate over the outer surface", () => {
    const { f, stats } = check({ pull: [0, 1, 0], slides: [[0, 0, -1]], wall: 1.2 });
    const layup = f("layup")[0];
    // the U's surface: 2 × 2600 mm² of ends and its 540 mm outline × 20 mm
    expect(layup.value!).toBeCloseTo((16_000 * 1.2 * 1.55) / 1000, 0);
    expect(layup.detail).toMatch(/about 10 plies/);
    expect(stats.nominalWall).toBe(1.2);
  });

  it("is costed with a steel mould and hand layup", () => {
    const est = estimateCost("carbon_layup", "Carbon fiber", { volume: 900_000, area: 460_000, bbox: [[-450, -80, 0], [450, 80, 600]], wall: 1.1, axis: [0, 1, 0] }, 100, { access: "order" })!;
    expect(est.tooling).toBeGreaterThan(10_000);
    expect(est.each).toBeGreaterThan(200);
  });
});

describe("the aero road bike template", () => {
  it("passes every check, the UCI rules included", async () => {
    const src = readFileSync("src/demos/aero-road-bike.kerf", "utf8");
    const r = await fullCheck(src);
    expect(r.model.diagnostics).toEqual([]);
    expect([...r.buildErrors]).toEqual([]);
    expect(r.report.items.filter((i) => i.status === "fail" || i.status === "warn").map((i) => `${i.id}: ${i.title}`)).toEqual([]);
    const uci = r.report.items.filter((i) => i.id.startsWith("uci:"));
    expect(uci.filter((i) => i.status === "pass").length).toBeGreaterThan(10);
    // the frame and fork are moulded carbon, released by slides and split cores
    expect(r.report.items.some((i) => i.id === "mfg:frame:slides" && i.status === "info")).toBe(true);
  }, 600_000);
});
