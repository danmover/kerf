import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { evaluate } from "../src/lang/evaluator";
import { KernelCore } from "../src/kernel/core";
import type { V3 } from "../src/kernel/recipe";
import type { Model } from "../src/core/model";
import { DFA_TIMES, dfaItems, dfaPromptSection, dfaReport, dfaText, directionLabel, fmtTime, geometryFromMeshes, placedBox, type DfaFacts, type DfaReport } from "../src/mfg/dfa";
import { initKernel } from "./helpers/kernel";

const demo = (name: string) => readFileSync(new URL(`../src/demos/${name}.kerf`, import.meta.url), "utf8");

function model(src: string): Model {
  const m = evaluate(src);
  const errors = m.diagnostics.filter((d) => d.severity === "error");
  if (errors.length) throw new Error(errors.map((d) => d.message).join("; "));
  return m;
}

/** Exact boxes of made parts whose body is a plain box, without the kernel. */
function boxFacts(m: Model, touching?: DfaFacts["touching"]): DfaFacts {
  const byId = new Map(m.parts.map((p) => [p.id, p]));
  return {
    geometry: (id) => {
      const p = byId.get(id);
      const b = p?.recipe.base;
      if (!p || p.kind !== "part" || !b || b.t !== "box") return undefined;
      const local: [V3, V3] = [
        [b.at[0] - b.w / 2, b.at[1] - b.d / 2, b.at[2]],
        [b.at[0] + b.w / 2, b.at[1] + b.d / 2, b.at[2] + b.h],
      ];
      return { box: placedBox(local, p.xf), volume: b.w * b.d * b.h };
    },
    touching,
  };
}

const ids = (r: DfaReport) => r.findings.map((f) => f.id);
const finding = (r: DfaReport, id: string) => r.findings.find((f) => f.id === id);

describe("counting what goes into an assembly", () => {
  const SRC = `design "Box"
part base { material: "PETG" body box(80, 60, 30) }
part lid { material: "PETG" removable body box(80, 60, 3, at: (0, 0, 30)) }
component pcb = lib.pcb(w: 50, d: 40) { at: (0, 0, 5) }
component usb = lib.usb_c() { at: (25, 0, 6.6), facing: X }
component brg = lib.bearing("608") { at: (0, 0, 0), axis: Z }
component inserts = lib.insert(M3) { at: [(30, 20, 30), (-30, 20, 30), (30, -20, 30), (-30, -20, 30)], axis: -Z }
component screws = lib.screw(M3, 8) { at: [(30, 20, 33), (-30, 20, 33), (30, -20, 33), (-30, -20, 33)], axis: -Z }
`;

  it("counts every instance once, with fasteners and board parts apart", () => {
    const r = dfaReport(model(SRC));
    expect(r.counts).toMatchObject({ items: 12, made: 2, bought: 2, fasteners: 8, boardParts: 1, wires: 0 });
    // the PCB's component solid belongs to the board item
    expect(r.items.find((w) => w.id === "pcb")?.parts).toEqual(["pcb", "pcb.parts"]);
    expect(r.fastenerTypes.map((t) => [t.type, t.count])).toEqual([
      ["insert", 4],
      ["screw", 4],
    ]);
    expect(r.threads).toEqual([{ size: "M3", count: 8 }]);
  });

  it("finds the theoretical minimum: base, removable lid and bought parts, never fasteners", () => {
    const r = dfaReport(model(SRC));
    const ess = Object.fromEntries(r.items.filter((w) => w.essential).map((w) => [w.id, w.reason]));
    expect(ess).toEqual({ base: "base", lid: "service", pcb: "bought", brg: "bought" });
    expect(r.minimumParts).toBe(4);
    expect(r.items.filter((w) => w.role === "fastener").every((w) => !w.essential && /fastener/i.test(w.why))).toBe(true);
  });

  it("times the work with the documented table and keeps the index between 0 and 1", () => {
    const r = dfaReport(model(SRC));
    // 2 made + pcb placed (3 s), bearing pressed (6 s), 4 inserts (10 s), 4 screws (8 s), all from above
    expect(r.time.seconds).toBe(3 * 3 + 6 + 4 * 10 + 4 * 8);
    expect(r.time.lines.reduce((s, l) => s + l.seconds, 0)).toBe(r.time.seconds);
    expect(r.time.low).toBeLessThan(r.time.seconds);
    expect(r.time.high).toBeGreaterThan(r.time.seconds);
    expect(r.efficiency).toBeCloseTo((DFA_TIMES.ideal * 4) / r.time.seconds, 6);
    expect(r.efficiency).toBeGreaterThan(0);
    expect(r.efficiency).toBeLessThanOrEqual(1);
    expect(r.items.find((w) => w.id === "screws#1")?.time).toEqual(["drive a screw 8 s"]);
  });

  it("does not claim there is nothing to combine before the geometry is known", () => {
    const r = dfaReport(model(SRC));
    expect(r.geometry).toBe("none");
    expect(ids(r)).not.toContain("dfa:lean");
    expect(ids(r)[0]).toBe("dfa:summary");
  });
});

describe("parts that could be one", () => {
  const TWO = (extra = "") => `design "t"
part plate { material: "PETG" body box(60, 40, 5) }
part block { material: "PETG" ${extra} body box(20, 20, 15, at: (0, 0, 5)) }
`;

  it("pairs two touching fixed parts of the same material and process", () => {
    const m = model(TWO());
    const boxes = dfaReport(m, boxFacts(m));
    expect(boxes.merges).toHaveLength(1);
    const mg = boxes.merges[0];
    expect(mg).toMatchObject({ id: "dfa:merge:block:plate", into: "plate", material: "PETG", contact: "boxes" });
    expect(boxes.boxContacts).toEqual([["plate", "block"]]);
    expect(boxes.minimumParts).toBe(1);
    // judged from boxes only: a suggestion, and it says so
    const f = finding(boxes, mg.id)!;
    expect(f.status).toBe("info");
    expect(f.detail).toContain("bounding boxes");
    expect(f.title).toBe("plate and block could be one part");
    expect(f.parts).toEqual(["plate", "block"]);

    const confirmed = dfaReport(m, boxFacts(m, () => true));
    expect(confirmed.merges[0].contact).toBe("confirmed");
    expect(confirmed.boxContacts).toEqual([]);
    expect(finding(confirmed, "dfa:merge:block:plate")?.status).toBe("warn");
    expect(finding(confirmed, "dfa:merge:block:plate")?.fix).toContain("fold block into plate");
  });

  it("drops the pair when the kernel says they do not touch", () => {
    const m = model(TWO());
    const r = dfaReport(m, boxFacts(m, () => false));
    expect(r.merges).toEqual([]);
    expect(finding(r, "dfa:lean")?.status).toBe("pass");
  });

  it("never pairs a moving part or a removable lid", () => {
    for (const [extra, reason] of [
      ["spin: 1", "moves"],
      ["removable", "service"],
    ]) {
      const m = model(TWO(extra));
      const r = dfaReport(m, boxFacts(m, () => true));
      expect(r.merges).toEqual([]);
      expect(r.items.find((w) => w.id === "block")).toMatchObject({ essential: true, reason });
      expect(r.minimumParts).toBe(2);
    }
  });

  it("never pairs a part that turns on a sim joint, such as a hinge's moving leaf", () => {
    const m = model(`design "t"
part plate { material: "PETG" body box(60, 40, 5) }
part block { material: "PETG" body box(20, 20, 15, at: (0, 0, 5)) }
scenario "Swing" {
  mechanism: sim.mechanism(sim.pivot(block, at: (0, 0, 5), axis: Z))
  firmware: none
  duration: 1s
}
`);
    const r = dfaReport(m, boxFacts(m, () => true));
    expect(r.merges).toEqual([]);
    expect(r.items.find((w) => w.id === "block")).toMatchObject({ essential: true, reason: "moves" });
    // a free body (a whole vehicle) moves in the world, not against its neighbours: its parts may still merge
    const free = model(`design "t"
part plate { material: "PETG" body box(60, 40, 5) }
part block { material: "PETG" body box(20, 20, 15, at: (0, 0, 5)) }
scenario "Fly" {
  mechanism: sim.mechanism(sim.free([plate, block]))
  firmware: none
  duration: 1s
}
`);
    expect(dfaReport(free, boxFacts(free, () => true)).merges).toHaveLength(1);
  });

  it("never pairs a part that a sprung blade on the other presses on", () => {
    const m = model(`design "t"
part plate {
  material: "PETG"
  body box(60, 40, 5)
  add flexure(at: (12, 0, 5), length: 15, t: 1.5, w: 4, dir: Y, facing: X, travel: 1, preload: 0.3, against: "block") as latch
}
part block { material: "PETG" body box(20, 20, 15, at: (0, 0, 5)) }
`);
    const r = dfaReport(m, boxFacts(m, () => true));
    expect(r.merges).toEqual([]);
    expect(r.items.find((w) => w.id === "block")).toMatchObject({ essential: true, reason: "moves", why: "plate's spring presses on it, so it moves against that part." });
  });

  it("keeps a part of another material that touches, and ignores parts that are apart", () => {
    const m = model(`design "t"
part plate { material: "PETG" body box(60, 40, 5) }
part pad { material: "TPU" body box(20, 20, 2, at: (0, 0, 5)) }
part spacer { material: "PETG" body box(10, 10, 10, at: (100, 0, 0)) }
`);
    const r = dfaReport(m, boxFacts(m));
    expect(r.merges).toEqual([]);
    expect(r.items.find((w) => w.id === "pad")).toMatchObject({ essential: true, reason: "material" });
    expect(r.items.find((w) => w.id === "spacer")?.essential).toBe(false);
    expect(r.minimumParts).toBe(2);
  });

  it("groups three or more into one suggestion and checks the brief's build volume", () => {
    const m = model(`design "t"
brief { purpose: "t" build_volume: (100, 100, 100) }
part a { material: "PETG" body box(80, 40, 5) }
part b { material: "PETG" body box(80, 40, 5, at: (80, 0, 0)) }
part c { material: "PETG" body box(80, 40, 5, at: (160, 0, 0)) }
`);
    const r = dfaReport(m, boxFacts(m, () => true));
    expect(r.merges).toHaveLength(1);
    expect(r.merges[0]).toMatchObject({ id: "dfa:merge:a:b:c", tooBig: true });
    const f = finding(r, "dfa:merge:a:b:c")!;
    expect(f.status).toBe("info");
    expect(f.detail).toContain("bigger than the build volume");
  });
});

describe("fasteners", () => {
  it("warns about many fastener sizes and names the one to standardise on", () => {
    const r = dfaReport(
      model(`design "t"
part plate { material: "Aluminum 6061" body box(100, 100, 6) }
component a = lib.screw(M3, 8) { at: [(0, 0, 6), (10, 0, 6), (20, 0, 6)], axis: -Z }
component b = lib.screw(M4, 10) { at: [(0, 20, 6), (10, 20, 6)], axis: -Z }
component c = lib.screw(M5, 12) { at: (0, 40, 6), axis: -Z }
`),
    );
    expect(r.threads.map((t) => t.size)).toEqual(["M3", "M4", "M5"]);
    const f = finding(r, "dfa:fastener-sizes")!;
    expect(f.status).toBe("warn");
    expect(f.detail).toContain("M3 × 3, M4 × 2, M5 × 1");
    expect(f.fix).toContain("Standardise on M3");
    expect(f.parts).toEqual(["b#1", "b#2", "c"]);
  });

  it("passes one size", () => {
    const r = dfaReport(model(`design "t"\npart plate { body box(50, 50, 5) }\ncomponent s = lib.screw(M3, 8) { at: [(0, 0, 5), (10, 0, 5)], axis: -Z }\n`));
    expect(finding(r, "dfa:fastener-sizes")).toMatchObject({ status: "pass", title: "One fastener size: M3" });
  });

  it("flags loose nuts, times holding them, and sees that they go on from the other side", () => {
    const m = model(`design "t"
part a { material: "Aluminum 6061" body box(40, 40, 5) }
part b { material: "Aluminum 6061" body box(40, 40, 5, at: (0, 0, 5)) }
component bolt = lib.screw(M4, 16) { at: (0, 0, 10), axis: -Z }
component nut = lib.nut(M4) { at: (0, 0, 0), axis: -Z }
`);
    const r = dfaReport(m);
    expect(finding(r, "dfa:nuts")).toMatchObject({ status: "warn", parts: ["nut"] });
    expect(finding(r, "dfa:nuts")?.fix).toContain("insert");
    expect(r.items.find((w) => w.id === "nut")?.seconds).toBe(DFA_TIMES.nut + DFA_TIMES.nutHold);
    // the bolt goes in from above, the nut from below: one turn over
    expect(r.directions.map((d) => d.label)).toEqual(["down (−Z)", "up (+Z)"]);
    expect(r.reorientations).toBe(1);
    expect(finding(r, "dfa:directions")).toMatchObject({ status: "info", title: "Goes together from 2 directions" });
    expect(r.time.lines.find((l) => l.label === "Turn the assembly over")?.seconds).toBe(DFA_TIMES.reorient);
  });

  it("leaves a nut in a hex pocket alone", () => {
    const m = model(`design "t"
part a { material: "PETG" body box(40, 40, 10) cut prism(points: [(3.349, 0), (1.674, 2.9), (-1.674, 2.9), (-3.349, 0), (-1.674, -2.9), (1.674, -2.9)], h: 3.4, at: (0, 0, -0.01)) }
component bolt = lib.screw(M3, 12) { at: (0, 0, 10), axis: -Z }
component nut = lib.nut(M3) { at: (0, 0, 2.4), axis: -Z }
`);
    const r = dfaReport(m);
    expect(ids(r)).not.toContain("dfa:nuts");
    expect(r.items.find((w) => w.id === "nut")?.seconds).toBe(DFA_TIMES.nut);
  });
});

describe("assembly directions", () => {
  it("counts distinct directions and turns, and prefers top-down", () => {
    const one = dfaReport(model(`design "t"\npart p { body box(50, 50, 5) }\ncomponent s = lib.screw(M3, 8) { at: [(0, 0, 5), (10, 0, 5)], axis: -Z }\n`));
    expect(one.directions).toHaveLength(1);
    expect(one.directions[0]).toMatchObject({ label: "down (−Z)", topDown: true, items: ["s#1", "s#2"] });
    expect(finding(one, "dfa:directions")).toMatchObject({ status: "pass", title: "Everything goes in from above" });

    const three = dfaReport(
      model(`design "t"
part p { body box(50, 50, 50) }
component top = lib.screw(M3, 8) { at: (0, 0, 50), axis: -Z }
component bottom = lib.screw(M3, 8) { at: (0, 0, 0), axis: Z }
component side = lib.screw(M3, 8) { at: (25, 0, 25), axis: -X }
component brg = lib.bearing("608") { at: (0, 10, 50), axis: Z }
`),
    );
    // the bearing's axis could go either way: it joins the screws going down
    expect(three.directions.map((d) => [d.label, d.items.length])).toEqual([
      ["down (−Z)", 2],
      ["up (+Z)", 1],
      ["sideways (−X)", 1],
    ]);
    expect(three.reorientations).toBe(2);
    expect(finding(three, "dfa:directions")?.status).toBe("warn");
    expect(finding(three, "dfa:directions")?.parts).toEqual(["bottom", "side"]);
  });

  it("names directions", () => {
    expect(directionLabel([0, 0, -1])).toBe("down (−Z)");
    expect(directionLabel([0, 1, 0])).toBe("sideways (+Y)");
    expect(directionLabel([0.7071, 0, -0.7071])).toMatch(/^at an angle/);
  });
});

describe("outputs", () => {
  const SRC = `design "t"
part plate { material: "PETG" body box(60, 40, 5) }
part block { material: "PETG" body box(20, 20, 15, at: (0, 0, 5)) }
component s = lib.screw(M3, 8) { at: [(20, 10, 5), (-20, 10, 5)], axis: -Z }
`;

  it("turns findings into assembly check items with stable ids and parts to highlight", () => {
    const m = model(SRC);
    const r = dfaReport(m, boxFacts(m, () => true));
    const items = dfaItems(m, r);
    expect(items.every((i) => i.category === "assembly")).toBe(true);
    expect(items.map((i) => i.id)).toEqual(["dfa:summary", "dfa:merge:block:plate", "dfa:fastener-sizes", "dfa:directions"]);
    const merge = items.find((i) => i.id === "dfa:merge:block:plate")!;
    expect(merge).toMatchObject({ status: "warn", basis: "geometry", parts: ["plate", "block"] });
    expect(merge.span).toEqual(m.parts.find((p) => p.id === "plate")!.span);
    expect(merge.fix).toBeTruthy();
    expect(items[0]).toMatchObject({ status: "info", parts: undefined });
    // the same design gives the same ids again
    expect(dfaItems(m, dfaReport(m, boxFacts(m, () => true))).map((i) => i.id)).toEqual(items.map((i) => i.id));
  });

  it("writes a compact text for Claude and a prompt section", () => {
    const m = model(SRC);
    const t = dfaText(dfaReport(m, boxFacts(m, () => true)));
    expect(t).toContain("4 items: 2 made, 0 bought, 2 fasteners");
    expect(t).toContain("Theoretical minimum 1: plate (base)");
    expect(t).toMatch(/DFA index \d+ %/);
    expect(t).toContain("[warn] plate and block could be one part");
    expect(t).toContain("Fix: Make them one part");
    expect(t).toContain("[blocks: plate, block]");
    expect(t).toContain("Directions: down (−Z) ×2; 0 turns of the assembly.");
    expect(dfaText(dfaReport(model(`design "t"\n`)))).toContain("nothing to assemble");
    const p = dfaPromptSection();
    expect(p.startsWith("## Design for assembly")).toBe(true);
    for (const w of ["fewer parts", "one size", "straight down", "self-locating", "snap fits", "loose nuts", "hex key", "asymmetric"]) expect(p).toContain(w);
  });

  it("formats times", () => {
    expect(fmtTime(45)).toBe("45 s");
    expect(fmtTime(156)).toBe("2 min 35 s");
    expect(fmtTime(3600)).toBe("1 h 0 min");
  });
});

describe("demos", () => {
  it("analyses every demo without geometry, with the index between 0 and 1", () => {
    for (const name of ["blank", "bracket", "canister", "enclosure", "practice-amp", "printer", "reducer", "sand-tunneller", "shelf"]) {
      const r = dfaReport(model(demo(name)));
      expect(r.efficiency, name).toBeGreaterThanOrEqual(0);
      expect(r.efficiency, name).toBeLessThanOrEqual(1);
      expect(r.minimumParts, name).toBeLessThanOrEqual(r.counts.items);
      expect(new Set(ids(r)).size, name).toBe(r.findings.length);
    }
  });

  it("counts wiring in machines and leaves soldered board parts out", () => {
    const r = dfaReport(model(demo("practice-amp")));
    expect(r.counts.boardParts).toBeGreaterThan(40);
    expect(r.counts.wires).toBeGreaterThan(10);
    expect(r.counts.wireEnds).toBe(2 * r.counts.wires);
    expect(r.time.lines.find((l) => l.label === "Connect wire ends")?.seconds).toBe(r.counts.wireEnds * DFA_TIMES.wireEnd);
  });

  it("times a threaded lid that screws on by hand", () => {
    const r = dfaReport(model(demo("canister")));
    expect(r.items.find((w) => w.id === "lid")?.seconds).toBe(DFA_TIMES.place + DFA_TIMES.screwOn);
    expect(r.minimumParts).toBe(2);
  });

  describe("with real geometry", () => {
    beforeAll(async () => {
      await initKernel();
    }, 60_000);
    const core = new KernelCore();

    function analyse(name: string): DfaReport {
      const m = model(demo(name));
      const built = new Map<string, { bbox: [V3, V3]; volume: number }>();
      for (const p of m.parts) {
        if (built.has(p.hash)) continue;
        const e = core.build({ hash: p.hash, recipe: p.recipe, label: p.label });
        built.set(p.hash, { bbox: e.bbox, volume: e.volume });
      }
      const byId = new Map(m.parts.map((p) => [p.id, p]));
      return dfaReport(m, {
        geometry: geometryFromMeshes(m, (h) => built.get(h)),
        touching: (a, b) => {
          const pa = byId.get(a)!;
          const pb = byId.get(b)!;
          return core.measure([{ hash: pa.hash, xf: pa.xf }], [{ hash: pb.hash, xf: pb.xf }]).distance < 0.05;
        },
      });
    }

    it("enclosure: a lean, top-down design with one suggestion about the lid screws", () => {
      const r = analyse("enclosure");
      expect(r.geometry).toBe("full");
      expect(r.counts).toMatchObject({ items: 19, made: 2, bought: 1, fasteners: 16, boardParts: 1 });
      expect(r.minimumParts).toBe(3);
      expect(r.merges).toEqual([]);
      expect(r.directions.map((d) => d.label)).toEqual(["down (−Z)"]);
      expect(r.reorientations).toBe(0);
      expect(r.efficiency).toBeGreaterThan(0.03);
      expect(r.efficiency).toBeLessThan(0.15);
      const st = Object.fromEntries(r.findings.map((f) => [f.id, f.status]));
      expect(st).toEqual({
        "dfa:summary": "info",
        "dfa:joint:lid": "info",
        "dfa:lean": "pass",
        "dfa:fastener-sizes": "pass",
        "dfa:directions": "pass",
      });
      const lid = finding(r, "dfa:joint:lid")!;
      expect(lid.detail).toContain("4 M3 screws into 4 inserts");
      expect(lid.fix).toContain("snap fits (PETG takes them)");
      expect(lid.parts).toEqual(["lid", "lid_fasteners#1", "lid_fasteners#2", "lid_fasteners#3", "lid_fasteners#4"]);
    }, 60_000);

    it("reducer: moving parts and bearings are the minimum, everything goes in along one axis", () => {
      const r = analyse("reducer");
      expect(r.counts).toMatchObject({ items: 25, made: 4, bought: 9, fasteners: 12 });
      expect(r.minimumParts).toBe(13);
      expect(r.items.find((w) => w.id === "housing")?.reason).toBe("base");
      expect(r.items.find((w) => w.id === "mid_shaft")?.reason).toBe("moves");
      expect(r.merges).toEqual([]);
      expect(r.directions).toHaveLength(1);
      expect(r.directions[0].label).toBe("sideways (−Y)");
      expect(r.efficiency).toBeGreaterThan(0.15);
      expect(r.efficiency).toBeLessThan(0.35);
      expect(r.findings.filter((f) => f.status === "warn")).toEqual([]);
      expect(r.findings.filter((f) => f.status === "info").map((f) => f.id)).toEqual(["dfa:summary", "dfa:joint:cover"]);
      expect(finding(r, "dfa:directions")?.title).toBe("Everything goes in from one side");
    }, 60_000);
  });
});
