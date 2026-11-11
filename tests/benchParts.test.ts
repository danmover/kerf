// Bought parts drawn as the things they are: a desktop power supply with its
// mains inlet and DC lead, a USB endoscope's head, and what hangs under a
// board (a camera board's lead socket on its back).

import { beforeAll, describe, expect, it } from "vitest";
import { bboxOf, buildPart, solidVolume } from "../src/kernel/build";
import { catalogPart } from "../src/machine/catalog";
import { buildGeometry } from "../src/machine/geometry";
import { boardItems } from "../src/machine/boards3d/pins";
import { BOARD_STYLES } from "../src/machine/boards3d/look";
import { plugFor } from "../src/machine/harness/plugs";
import type { CatalogPart } from "../src/machine/types";
import { initKernel } from "./helpers/kernel";

const part = (id: string): CatalogPart => catalogPart(id)!;
const withDims = (p: CatalogPart, dims: Record<string, number>): CatalogPart => ({ ...p, geom: { ...p.geom, dims: { ...p.geom.dims, ...dims } } });

describe("a desktop power supply", () => {
  beforeAll(() => initKernel(), 60_000);

  it("is the listed size, with the mains inlet in one end and the DC lead leaving the other", () => {
    const p = part("psu_jaycar_mp3241");
    const g = buildGeometry(p, {});
    expect(g.solids.map((s) => s.suffix)).toEqual(["", "inlet", "cord", "label", "led", "feet"]);
    const shapes = Object.fromEntries(g.solids.map((s) => [s.suffix, buildPart(s.recipe)]));
    for (const [k, s] of Object.entries(shapes)) expect(solidVolume(s), k).toBeGreaterThan(0.5);
    const [lo, hi] = bboxOf(shapes[""]);
    expect(hi[0] - lo[0]).toBeCloseTo(174, 1);
    expect(hi[1] - lo[1]).toBeCloseTo(72, 1);
    expect(hi[2]).toBeCloseTo(44, 1);
    // the feet reach the surface it lies on; the case starts on top of them
    expect(bboxOf(shapes.feet)[0][2]).toBeCloseTo(0, 2);
    expect(lo[2]).toBeCloseTo(1, 2);
    // the inlet is a recess: the case is lighter than its plain block, and the pins stay inside it
    expect(solidVolume(shapes[""])).toBeLessThan(174 * 72 * 43 - 24 * 16.5 * 16 * 0.8);
    const [plo, phi] = bboxOf(shapes.inlet);
    expect(plo[0]).toBeGreaterThan(-87);
    expect(phi[0]).toBeLessThan(-87 + 16.5);
    // the lead leaves the +X end and stops where the wiring takes over
    const [, chi] = bboxOf(shapes.cord);
    expect(chi[0]).toBeCloseTo(87 - 1 + 60, 1);
    expect(g.fields.points!.cord_end).toEqual([146, 0, 22.5]);
    expect(plugFor(p, "VPOS")).toMatchObject({ kind: "lead", at: [87, 0, 22.5], out: [1, 0, 0] });
  });

  it("draws the barrel plug when the lead is not cut, and a figure-8 inlet when asked", () => {
    const p = withDims(part("psu_jaycar_mp3241"), { plug_l: 10, inlet: 8 });
    const g = buildGeometry(p, {});
    expect(g.solids.map((s) => s.suffix)).toContain("barrel");
    for (const s of g.solids) expect(solidVolume(buildPart(s.recipe)), s.suffix).toBeGreaterThan(0.5);
    const barrel = bboxOf(buildPart(g.solids.find((s) => s.suffix === "barrel")!.recipe));
    expect(barrel[1][0]).toBeCloseTo(g.fields.points!.cord_end[0], 1);
    expect(barrel[1][1] - barrel[0][1]).toBeCloseTo(5.5, 1);
  });
});

describe("a USB endoscope", () => {
  beforeAll(() => initKernel(), 60_000);

  it("is a slim head with its lens in the front and its lead behind", () => {
    for (const id of ["dfrobot_fit0819", "usb_endoscope_8mm"]) {
      const p = part(id);
      const g = buildGeometry(p, {});
      expect(g.placement, id).toBe("axis");
      expect(g.solids.map((s) => s.suffix), id).toEqual(["", "lights", "lens", "lead"]);
      const shapes = Object.fromEntries(g.solids.map((s) => [s.suffix, buildPart(s.recipe)]));
      for (const [k, s] of Object.entries(shapes)) expect(solidVolume(s), `${id} ${k}`).toBeGreaterThan(0.5);
      const [lo, hi] = bboxOf(shapes[""]);
      expect(hi[0] - lo[0], id).toBeCloseTo(p.geom.dims.d, 1);
      expect(lo[2], id).toBeCloseTo(0, 2);
      expect(hi[2], id).toBeCloseTo(p.geom.dims.h, 2);
      // lens and lights stay inside the head's front; the lead runs back from `at`
      expect(bboxOf(shapes.lens)[1][2], id).toBeLessThanOrEqual(p.geom.dims.h);
      expect(bboxOf(shapes.lead)[1][2], id).toBeCloseTo(0, 2);
      expect(bboxOf(shapes.lead)[0][2], id).toBeCloseTo(-p.geom.dims.cable_l, 2);
      expect(g.fields.points!.lens, id).toEqual([0, 0, p.geom.dims.h]);
    }
  });
});

describe("a board with a part on its back", () => {
  beforeAll(() => initKernel(), 60_000);

  it("hangs the camera's lead socket under the board, and keeps it out of the top's layout", () => {
    const p = part("arducam_b0196");
    const g = buildGeometry(p, {});
    const under = g.solids.filter((s) => s.suffix.startsWith("under"));
    expect(under.length).toBe(1);
    const [lo, hi] = bboxOf(buildPart(under[0].recipe));
    expect(hi[2]).toBeCloseTo(0, 2);
    expect(lo[2]).toBeCloseTo(-4.5, 2);
    expect(g.fields.scalars!.below).toBe(4.5);
    // the height other parts are stacked by is the top side's alone
    const tallest = Math.max(...(p.geom.features ?? []).filter((f) => f.side !== "bottom").map((f) => f.h));
    expect(g.fields.scalars!.height).toBeCloseTo(p.geom.dims.t + tallest, 3);
    // every feature has a look, in step with the feature list, and the back's socket is not drawn on the top
    expect(BOARD_STYLES[p.id].looks!.length).toBe(p.geom.features!.length);
    const top = boardItems(p);
    expect(top.length).toBe(2);
    for (const it of top) expect(Math.abs(it.x) < 0.01 && Math.abs(it.y + 8.5) < 0.01, JSON.stringify(it)).toBe(false);
    // the lead plugs in from behind
    expect(plugFor(p, "USB")).toMatchObject({ at: [0, -8.5, -4.5], out: [0, 0, -1] });
  });

  it("gives every feature of the servo adapter a look", () => {
    const p = part("waveshare_bus_servo_adapter_a");
    expect(BOARD_STYLES[p.id].looks!.length).toBe(p.geom.features!.length);
    expect(buildGeometry(p, {}).fields.scalars!.below).toBe(0);
    // both servo ports take a plug
    expect(plugFor(p, "SERVO_S")?.more?.length).toBe(1);
  });
});
