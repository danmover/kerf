// The schematic sheet: the layout block in the language, the sheet laid out from the design's parts and wires (a wire
// for two pins, ground and supply symbols, labels for bigger nets, pins on the grid), and the edits the sheet writes
// back into the design: where symbols sit, a new connection, a wire or a pin taken out.

import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { GRID, schematicBlock, schematicSheet, schematicSvg } from "../src/machine/schematic";
import { pinKey, placesOf, withConnection, withoutPin, withoutStatements, withSchematic } from "../src/machine/schematicEdit";

const SRC = `design "Drive"
component ctrl = lib.controller("arduino_nano") { at: (0, 0, 0) }
component bat = lib.battery("lipo_3s_2200") { at: (0, 120, 0) }
component fuse = lib.fuse("fuse_holder_atc") { at: (60, 120, 0) }
component drv = lib.motor_driver("pololu_g2_18v17") { at: (60, 0, 0) }
component mot = lib.gearmotor("gobilda_5203_188") { at: (160, 0, 0), axis: X, role: "drive" }
component r1 = lib.resistor("10k") { at: (0, 60, 0) }
wire bat.POS -> fuse.IN { gauge: 16 }
wire fuse.OUT -> drv.VIN { gauge: 16 }
net GND: bat.NEG, drv.GND_PWR, drv.GND, ctrl.GND
wire ctrl.D9 -> drv.PWM
wire ctrl.D8 -> drv.DIR
wire drv.OUTA -> mot.M_PLUS
wire drv.OUTB -> mot.M_MINUS
`;

const errors = (src: string) => evaluate(src).diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
const warnings = (src: string) => evaluate(src).diagnostics.filter((d) => d.severity === "warning").map((d) => d.message);
const onGrid = (v: number) => Math.abs(v / GRID - Math.round(v / GRID)) < 1e-9;

describe("schematic block", () => {
  it("reads each part's place and quarter turn", () => {
    const m = evaluate(`${SRC}schematic {\n  ctrl: (40, 60)\n  drv: (160, 60, 90)\n}\n`);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(m.schematic?.places.ctrl).toEqual({ x: 40, y: 60, rot: 0 });
    expect(m.schematic?.places.drv).toEqual({ x: 160, y: 60, rot: 90 });
    expect(m.schematic?.entries.map((e) => e.name)).toEqual(["ctrl", "drv"]);
  });

  it("warns about a part that is not there, a turn that is not a quarter, and a copy past a pattern's end", () => {
    const w = warnings(`${SRC}component leds = lib.resistor("330") { at: [(0, 90, 0), (10, 90, 0), (20, 90, 0)] }\nschematic {\n  ctlr: (40, 60)\n  drv: (160, 60, 80)\n  leds[1]: (10, 10)\n  leds[3]: (10, 30)\n}\n`);
    expect(w.some((x) => /"ctlr" is not one of the design's electronic parts \(ctrl, bat, fuse, drv, mot, r1/.test(x))).toBe(true);
    expect(w.some((x) => /drv turns in quarter turns .* so 80 is read as 90/.test(x))).toBe(true);
    expect(w.some((x) => /leds has 3 copies, numbered from 0 to 2, so leds\[3\] has no symbol/.test(x))).toBe(true);
    expect(w.some((x) => /leds\[1\]/.test(x))).toBe(false);
  });

  it("refuses a second block and a place that is not (x, y)", () => {
    expect(errors(`${SRC}schematic { ctrl: (0, 0) }\nschematic { drv: (0, 0) }\n`)[0]).toMatch(/one schematic block/);
    expect(errors(`${SRC}schematic { ctrl: 40 }\n`)[0]).toMatch(/ctrl takes its place on the sheet as \(x, y\)/);
    expect(errors(`${SRC}schematic { ctrl = (0, 0) }\n`)[0]).toMatch(/inside schematic/);
  });
});

describe("schematic sheet", () => {
  const sheetOf = (src: string) => {
    const m = evaluate(src);
    return schematicSheet(m.machine!, m.schematic);
  };

  it("draws a symbol per part, wires for two-pin nets, ground symbols, and every pin on the grid", () => {
    const s = sheetOf(SRC);
    expect(s.symbols.map((x) => x.key).sort()).toEqual(["bat", "ctrl", "drv", "fuse", "mot", "r1"]);
    expect(s.symbols.find((x) => x.key === "fuse")!.shape).toBe("fuse");
    expect(s.symbols.find((x) => x.key === "r1")!.shape).toBe("resistor");
    expect(s.symbols.find((x) => x.key === "ctrl")!.shape).toBe("box");
    const wires = s.wires.map((w) => `${w.a}-${w.b}`).sort();
    expect(wires).toEqual(["bat.POS-fuse.IN", "ctrl.D8-drv.DIR", "ctrl.D9-drv.PWM", "drv.OUTA-mot.M_PLUS", "drv.OUTB-mot.M_MINUS", "fuse.OUT-drv.VIN"]);
    // each wire keeps the line it came from, to delete it or show it
    for (const w of s.wires) expect(SRC.slice(w.spans[0].start, w.spans[0].start + 5)).toBe("wire ");
    const gnd = s.labels.filter((l) => l.kind === "ground").map((l) => l.pin).sort();
    expect(gnd).toEqual(["bat.NEG", "ctrl.GND", "drv.GND", "drv.GND_PWR"]);
    for (const sym of s.symbols) for (const p of sym.pins) expect(onGrid(p.at[0]) && onGrid(p.at[1])).toBe(true);
    // wires run square
    for (const w of s.wires) for (let i = 1; i < w.points.length; i++) expect(w.points[i][0] === w.points[i - 1][0] || w.points[i][1] === w.points[i - 1][1]).toBe(true);
    // symbols laid out automatically do not overlap
    const boxes = s.symbols.map((x) => x.box);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(boxes[i][2] <= boxes[j][0] || boxes[j][2] <= boxes[i][0] || boxes[i][3] <= boxes[j][1] || boxes[j][3] <= boxes[i][1]).toBe(true);
  });

  it("routes wires round the symbols, clear of other pins and of each other", () => {
    const s = sheetOf(SRC);
    const inside = (p: [number, number], b: [number, number, number, number]) => p[0] > b[0] + 1e-6 && p[0] < b[2] - 1e-6 && p[1] > b[1] + 1e-6 && p[1] < b[3] - 1e-6;
    const tips = s.symbols.flatMap((x) => x.pins.map((p) => ({ ref: p.ref, at: p.at })));
    const cells = new Map<string, number>();
    s.wires.forEach((w, wi) => {
      for (let i = 1; i < w.points.length; i++) {
        const [a, b] = [w.points[i - 1], w.points[i]];
        const n = Math.round(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / 2.5);
        for (let q = 0; q <= n; q++) {
          const p: [number, number] = [a[0] + ((b[0] - a[0]) * q) / Math.max(n, 1), a[1] + ((b[1] - a[1]) * q) / Math.max(n, 1)];
          for (const sym of s.symbols) expect(inside(p, sym.box), `${w.a}-${w.b} runs through ${sym.key}`).toBe(false);
          for (const t of tips) if (t.ref !== w.a && t.ref !== w.b) expect(t.at[0] === p[0] && t.at[1] === p[1], `${w.a}-${w.b} touches ${t.ref}`).toBe(false);
          // no two wires share a run (a crossing shares one point, and is fine)
          const key = `${p[0]},${p[1]},${a[1] === b[1] ? "h" : "v"}`;
          const had = cells.get(key);
          expect(had === undefined || had === wi, `${w.a}-${w.b} runs along another wire at ${key}`).toBe(true);
          cells.set(key, wi);
        }
      }
    });
    // while a symbol is being dragged, the plain routes are quick and still join the same pins
    const m = evaluate(SRC);
    const quick = schematicSheet(m.machine!, m.schematic, { route: "plain" });
    for (const w of quick.wires) {
      const full = s.wires.find((x) => x.a === w.a && x.b === w.b)!;
      expect(w.points[0]).toEqual(full.points[0]);
      expect(w.points[w.points.length - 1]).toEqual(full.points[full.points.length - 1]);
    }
  });

  it("keeps a fuse between its two nets (it does not join them on the sheet)", () => {
    const s = sheetOf(SRC);
    const fuse = s.symbols.find((x) => x.key === "fuse")!;
    const [a, b] = fuse.pins;
    expect(a.net).toBeDefined();
    expect(b.net).toBeDefined();
    expect(a.net).not.toBe(b.net);
  });

  it("puts a placed symbol where the block says, turned, with its pins turned with it", () => {
    const s = sheetOf(`${SRC}schematic {\n  drv: (200, 100, 90)\n}\n`);
    const drv = s.symbols.find((x) => x.key === "drv")!;
    expect(drv.at).toEqual([200, 100]);
    expect(drv.placed).toBe(true);
    // a quarter turn: the side pins now point up and down
    expect(drv.pins.every((p) => p.out[0] === 0 && Math.abs(p.out[1]) === 1)).toBe(true);
    expect(drv.pins.every((p) => Math.abs(p.at[0] - 200) <= drv.h / 2 + 1e-9)).toBe(true);
    // the rest go to the right of it, not on top of it
    for (const o of s.symbols.filter((x) => !x.placed)) expect(o.box[0]).toBeGreaterThan(drv.box[2]);
  });

  it("labels a net of more than two pins and flags a supply's pins", () => {
    const src = SRC.replace("wire ctrl.D9 -> drv.PWM", "net PWM: ctrl.D9, drv.PWM, r1.A\nnet V5: ctrl.V5, r1.B, mot.ENC_VCC");
    const s = sheetOf(src);
    const pwm = s.labels.filter((l) => l.text === "PWM").map((l) => l.pin).sort();
    expect(pwm).toEqual(["ctrl.D9", "drv.PWM", "r1.A"]);
    expect(s.labels.filter((l) => l.kind === "supply").map((l) => l.text)).toEqual(["V5", "V5", "V5"]);
    // a net line drawn as one wire knows its line, to take it out
    const s2 = sheetOf(SRC.replace("wire ctrl.D9 -> drv.PWM", "net PWM: ctrl.D9, drv.PWM"));
    const w = s2.wires.find((x) => x.a === "ctrl.D9")!;
    expect(w.spans).toEqual([]);
    expect(SRC.replace("wire ctrl.D9 -> drv.PWM", "net PWM: ctrl.D9, drv.PWM").slice(w.netSpan!.start, w.netSpan!.start + 7)).toBe("net PWM");
  });

  it("lays out a pattern's copies one under another from one place", () => {
    const src = `${SRC}component leds = lib.resistor("330") { at: [(0, 90, 0), (10, 90, 0), (20, 90, 0)] }\nwire ctrl.D2 -> leds[0].A\nwire ctrl.D3 -> leds[1].A\nwire ctrl.D4 -> leds[2].A\nschematic {\n  leds: (300, 20)\n}\n`;
    const s = sheetOf(src);
    const at = ["leds[0]", "leds[1]", "leds[2]"].map((k) => s.symbols.find((x) => x.key === k)!.at);
    expect(at[0]).toEqual([300, 20]);
    expect(at[1][0]).toBe(300);
    expect(at[2][1]).toBeGreaterThan(at[1][1]);
    expect(at[1][1]).toBeGreaterThan(at[0][1]);
    expect(s.wires.some((w) => w.a === "ctrl.D3" && w.b === "leds[1].A")).toBe(true);
  });

  it("saves as an SVG sheet with a title block", () => {
    const svg = schematicSvg(sheetOf(SRC), "Drive <v1>");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("Drive &lt;v1&gt;");
    expect(svg).toContain("Schematic");
    expect((svg.match(/<polyline/g) ?? []).length).toBe(6);
  });
});

describe("editing from the sheet", () => {
  it("writes every symbol's place when one moves, and rewrites the block in place after that", () => {
    const m = evaluate(SRC);
    const sheet = schematicSheet(m.machine!, m.schematic);
    const places = placesOf(sheet, { drv: { x: 250, y: 40 } });
    const once = withSchematic(SRC, m.schematic, places);
    expect(once.startsWith(SRC.trimEnd())).toBe(true);
    const m1 = evaluate(once);
    expect(m1.diagnostics).toEqual(m.diagnostics);
    expect(m1.schematic?.places.drv).toEqual({ x: 250, y: 40, rot: 0 });
    // nothing else moved
    const s1 = schematicSheet(m1.machine!, m1.schematic);
    for (const sym of sheet.symbols.filter((x) => x.key !== "drv")) expect(s1.symbols.find((x) => x.key === sym.key)!.at).toEqual(sym.at);
    // a turn rewrites the same block
    const twice = withSchematic(once, m1.schematic, placesOf(s1, { drv: { rot: 90 } }));
    expect(twice.match(/schematic \{/g)?.length).toBe(1);
    expect(evaluate(twice).schematic?.places.drv).toEqual({ x: 250, y: 40, rot: 90 });
    expect(schematicBlock({ a: { x: 1.25, y: 2, rot: 0 }, b: { x: 0, y: 0, rot: 270 } })).toBe("schematic {\n  a: (1.3, 2)\n  b: (0, 0, 270)\n}");
  });

  it("adds a wire line after the last one, or a pin to the net line it joins", () => {
    const m = evaluate(SRC).machine!;
    const w = withConnection(SRC, m, "ctrl.D5", "drv.SLP");
    expect(w.src).not.toBeNull();
    if (w.src === null) return;
    expect(w.how).toBe("wire");
    expect(w.src).toContain("wire drv.OUTB -> mot.M_MINUS\nwire ctrl.D5 -> drv.SLP\n");
    const mw = evaluate(w.src).machine!;
    expect(mw.wires.some((x) => x.a.pin === "D5" && x.b.pin === "SLP")).toBe(true);
    // onto ground: the pin joins the GND net line
    const g = withConnection(SRC, m, "mot.ENC_GND", "ctrl.GND");
    expect(g.src === null ? "" : g.src).toContain("net GND: bat.NEG, drv.GND_PWR, drv.GND, ctrl.GND, mot.ENC_GND\n");
    if (g.src !== null) expect(g.how).toBe("net");
    // already joined
    const again = withConnection(SRC, m, "drv.PWM", "ctrl.D9");
    expect(again.src).toBeNull();
    if (again.src === null) expect(again.why).toMatch(/already wired together/);
    const same = withConnection(SRC, m, "bat.NEG", "ctrl.GND");
    if (same.src === null) expect(same.why).toMatch(/both on the GND net/);
    else throw new Error("expected no change");
    // a design with no wiring yet gets its first wire at the end
    const bare = `design "Bare"\ncomponent ctrl = lib.controller("arduino_nano") { at: (0, 0, 0) }\ncomponent r1 = lib.resistor("1k") { at: (0, 60, 0) }\n`;
    const first = withConnection(bare, evaluate(bare).machine!, "ctrl.D2", "r1.A");
    expect(first.src).toBe(`${bare}\nwire ctrl.D2 -> r1.A\n`);
  });

  it("takes out a wire line, or a pin from a net line", () => {
    const m = evaluate(SRC);
    const sheet = schematicSheet(m.machine!, m.schematic);
    const w = sheet.wires.find((x) => x.a === "ctrl.D8")!;
    const out = withoutStatements(SRC, w.spans);
    expect(out).not.toContain("wire ctrl.D8 -> drv.DIR");
    expect(out.split("\n").length).toBe(SRC.split("\n").length - 1);
    expect(evaluate(out).machine!.wires.length).toBe(m.machine!.wires.length - 1);
    // a pin off the ground net: the rest of the list stays
    const off = withoutPin(SRC, m.machine!, "drv.GND");
    expect(off).toContain("net GND: bat.NEG, drv.GND_PWR, ctrl.GND\n");
    const first = withoutPin(SRC, m.machine!, "bat.NEG");
    expect(first).toContain("net GND: drv.GND_PWR, drv.GND, ctrl.GND\n");
    // a pin on wire lines: those lines go
    const motor = withoutPin(SRC, m.machine!, "mot.M_PLUS");
    expect(motor).not.toContain("mot.M_PLUS");
    expect(evaluate(motor).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    // a net left with one pin goes altogether
    const two = SRC.replace("wire ctrl.D9 -> drv.PWM", "net PWM: ctrl.D9, drv.PWM");
    expect(withoutPin(two, evaluate(two).machine!, "drv.PWM")).not.toContain("net PWM");
    expect(pinKey("leds[2].A")).toBe("leds[2].A");
    expect(pinKey("ctrl.D9")).toBe("ctrl[0].D9");
  });
});
