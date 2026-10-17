// Realistic boards in the 3D view: every bought board is laid out the same way
// each time with nothing stacked on anything else, plugs land on the header
// pins the board draws, and a board Kerf routes shows the router's own copper.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "../src/lang/evaluator";
import { CATALOG, catalogPart } from "../src/machine/catalog";
import { boardLayout, SMD_SIZE, type Smd } from "../src/machine/boards3d/layout";
import { boardItems, headerPins, pinSpots, PIN_LOOKS } from "../src/machine/boards3d/pins";
import { routedLayout } from "../src/machine/boards3d/routed";
import { boardSpecs } from "../src/machine/boards";
import { placedPads, routeBoard } from "../src/machine/pcb";
import { plugFor } from "../src/machine/harness/plugs";

const BOARDS = CATALOG.filter((p) => p.geom.g === "board");

function smdBox(s: Smd): [number, number, number, number] {
  const [l, w] = SMD_SIZE[s.kind];
  const [a, b] = s.rot ? [w, l] : [l, w];
  return [s.x - a / 2, s.y - b / 2, s.x + a / 2, s.y + b / 2];
}

const overlaps = (a: number[], b: number[]) => a[0] < b[2] - 0.01 && b[0] < a[2] - 0.01 && a[1] < b[3] - 0.01 && b[1] < a[3] - 0.01;

describe("realistic boards", () => {
  it("lays out every bought board the same way each time, with nothing on top of anything else", () => {
    expect(BOARDS.length).toBeGreaterThan(20);
    for (const p of BOARDS) {
      const L = boardLayout(p);
      expect(JSON.stringify(boardLayout(p)), p.id).toBe(JSON.stringify(L));
      const boxes = L.smd.map(smdBox);
      boxes.forEach((a, i) => {
        expect(a[0] >= -L.w / 2 && a[2] <= L.w / 2 && a[1] >= -L.d / 2 && a[3] <= L.d / 2, `${p.id}: a part off the board`).toBe(true);
        for (let j = i + 1; j < boxes.length; j++) expect(overlaps(a, boxes[j]), `${p.id}: two small parts on each other`).toBe(false);
        for (const it of L.items) expect(overlaps(a, [it.x - it.w / 2, it.y - it.d / 2, it.x + it.w / 2, it.y + it.d / 2]), `${p.id}: a small part under ${it.look}`).toBe(false);
      });
      // the silkscreen names the board
      expect(L.top.texts.length + L.bottom.texts.length, p.id).toBeGreaterThan(0);
    }
  });

  it("puts each plug on a header pin the board draws", () => {
    for (const id of ["arduino_nano", "arduino_mega", "rpi_pico", "tmc2209", "pololu_g2_18v17"]) {
      const p = catalogPart(id)!;
      const pins = boardItems(p)
        .filter((it) => PIN_LOOKS.has(it.look))
        .flatMap(headerPins);
      const spots = pinSpots(p);
      const used = new Set<string>();
      for (const pin of p.pins) {
        const s = spots.get(pin.id);
        expect(s, `${id}.${pin.id} has a place`).toBeDefined();
        const key = s!.at.map((v) => v.toFixed(3)).join();
        expect(used.has(key), `${id}.${pin.id} shares a pin`).toBe(false);
        used.add(key);
        if (s!.kind === "dupont") expect(pins.some(([x, y]) => Math.abs(x - s!.at[0]) < 1e-6 && Math.abs(y - s!.at[1]) < 1e-6), `${id}.${pin.id} on a drawn pin`).toBe(true);
        // the 3D wiring uses the same place
        expect(plugFor(p, pin.id)?.at).toEqual(s!.at);
      }
    }
    // the G2's motor and power pins go to its screw terminal
    expect(pinSpots(catalogPart("pololu_g2_18v17")!).get("OUTA")?.kind).toBe("ferrule");
  });

  it("draws the amp's own board with the router's copper, its pads and holes, and a joint on every pin", () => {
    const m = evaluate(readFileSync(join(__dirname, "../src/demos/practice-amp.kerf"), "utf8"));
    const { def, spec } = boardSpecs(m.machine!)[0];
    const routed = routeBoard(spec);
    const L = routedLayout(spec, routed, def.t);
    const pads = placedPads(spec);
    expect(L.top.pads.length).toBe(pads.length);
    expect(L.bottom.pads.length).toBe(pads.length);
    // every through-hole pin is soldered on the side away from its part
    expect(L.top.joints.length + L.bottom.joints.length).toBe(pads.length);
    expect(L.top.traces.length).toBe(routed.tracks.filter((t) => t.layer === "F").length);
    expect(L.bottom.traces.length).toBe(routed.tracks.filter((t) => t.layer === "B").length);
    expect(L.top.vias.length).toBe(routed.vias.length);
    expect((L.top.polys?.length ?? 0) + (L.bottom.polys?.length ?? 0)).toBeGreaterThan(0);
    expect(L.holes.length).toBeGreaterThanOrEqual(pads.length + spec.holes.length);
    // centred on the board, like the bought boards
    for (const p of L.top.pads) expect(Math.abs(p.x) <= spec.w / 2 && Math.abs(p.y) <= spec.h / 2).toBe(true);
    // before routing finishes: pads and silkscreen, no copper yet
    const bare = routedLayout(spec, undefined, def.t);
    expect(bare.top.traces.length).toBe(0);
    expect(bare.top.pads.length).toBe(pads.length);
    expect(bare.top.strokes?.length).toBeGreaterThan(0);
  });
});
