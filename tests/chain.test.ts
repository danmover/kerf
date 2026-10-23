// Roller chains and sprockets: the tooth form, the layout round the
// sprockets, rollers seated in the gaps, the speeds the chain gives, the
// chain built as real links, and the checks.

import { beforeAll, describe, expect, it } from "vitest";
import type { Shape3D } from "replicad";
import { evaluate } from "../src/lang/evaluator";
import { applyXf, buildPart, solidVolume } from "../src/kernel/build";
import { chainRollers, sprocketPd, sprocketTip, seatRadius } from "../src/machine/chains";
import { chainChecks } from "../src/core/chainChecks";
import { initKernel } from "./helpers/kernel";

beforeAll(() => initKernel(), 60_000);

const DRIVE = `design "Chain"
component ring = lib.sprocket(z: 52, chain: "bike_11s") { at: (0, 0, 0), axis: Y, spin: 1 }
component cog = lib.sprocket(z: 15, chain: "bike_11s") { at: (-410, 0, 40), axis: Y, chain: ring }
component chain = lib.chain("bike_11s", path: [ring, cog])
`;

describe("sprockets", () => {
  it("follow ISO 606", () => {
    expect(sprocketPd(12.7, 52)).toBeCloseTo(210.3, 1);
    expect(sprocketTip(12.7, 11, 7.75)).toBeCloseTo(48.2, 1);
    expect(seatRadius(7.75)).toBeCloseTo(4.05, 2);
  });
});

describe("a chain", () => {
  it("lays out round its sprockets and turns the cog", () => {
    const m = evaluate(DRIVE);
    expect(m.diagnostics).toEqual([]);
    const c = m.parts.find((p) => p.name === "chain")!.chain!;
    // whole links, an even number of them, enough to go round
    expect(c.links % 2).toBe(0);
    expect(c.links).toBeGreaterThanOrEqual(c.needLinks);
    expect(m.parts.find((p) => p.name === "cog")!.motion!.ratio).toBeCloseTo(52 / 15, 6);
    expect(chainRollers(c, 0).length).toBe(c.links);
  });

  it("builds as links whose rollers sit in the sprockets' tooth gaps", () => {
    const m = evaluate(DRIVE);
    const chain = buildPart(m.parts.find((p) => p.name === "chain")!.recipe) as Shape3D;
    expect(solidVolume(chain)).toBeGreaterThan(20_000);
    for (const name of ["ring", "cog"]) {
      const p = m.parts.find((q) => q.name === name)!;
      const sp = applyXf(buildPart(p.recipe) as Shape3D, p.xf);
      expect(solidVolume(sp.intersect(chain.clone() as Shape3D) as Shape3D)).toBeLessThan(1);
    }
  }, 60_000);

  it("is checked for its line, grip, length and load", () => {
    const items = chainChecks(evaluate(DRIVE));
    expect(items.length).toBeGreaterThan(3);
    expect(items.filter((i) => i.status === "fail")).toEqual([]);
  });
});
