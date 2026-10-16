import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { withMaterial } from "../src/materials/apply";
import { creepItem, galvanicItems, galvanicLimit, heldLoads, metalPairs, placedBox, threadItems } from "../src/materials/checks";
import { briefChecks } from "../src/core/briefChecks";
import type { Brief, EvalPart, Model } from "../src/core/model";
import type { V3 } from "../src/kernel/recipe";

const errors = (m: Model) => m.diagnostics.filter((d) => d.severity === "error");

describe("applying a material", () => {
  it("switches the process when the part's own one cannot make the material", () => {
    const src = `design "t"\npart bracket {\n  material: "PLA"\n  process: mfg.fdm()\n  body box(40, 20, 10)\n}\n`;
    const m = evaluate(src);
    const r = withMaterial(src, m, "bracket", { material: "Aluminum 6061", finish: "anodized", color: "#c4c8ce", process: "cnc_mill" });
    const n = evaluate(r.src);
    expect(errors(n)).toEqual([]);
    const p = n.parts.find((q) => q.name === "bracket")!;
    expect(p.material).toBe("Aluminum 6061");
    expect(p.finish).toBe("anodized");
    expect(p.process?.id).toBe("cnc_mill");
    expect(r.changes[0]).toBe("PLA → Aluminum 6061");
    expect(r.changes.join(" ")).toContain("CNC milling instead of FDM printing");
  });

  it("only touches the look when the process can make it", () => {
    const src = `design "t"\npart lid { material: "PLA" body box(40, 20, 2) }\n`;
    const m = evaluate(src);
    const r = withMaterial(src, m, "lid", { material: "PETG", finish: "printed", color: "#3a7bd5" });
    const p = evaluate(r.src).parts[0];
    expect(p.material).toBe("PETG");
    expect(p.color.toLowerCase()).toBe("#3a7bd5");
    expect(p.process).toBeUndefined();
    expect(r.src).not.toContain("process:");
  });
});

describe("threads in printed plastic", () => {
  it("flags machine-screw threads cut into a printed part, not insert holes", () => {
    const m = evaluate(`design "t"
part case {
  material: "PETG"
  body box(40, 40, 10)
  cut hole(M3, fit: "thread", depth: 6, at: (0, 0, 10))
  cut hole(M3, fit: "insert", depth: 6, at: (10, 0, 10))
}
part plate {
  material: "Aluminum 6061"
  process: mfg.cnc_mill()
  body box(40, 40, 4)
  cut hole(M3, fit: "thread", depth: 4, at: (0, 0, 4))
}
`);
    expect(errors(m)).toEqual([]);
    const items = threadItems(m);
    expect(items.map((i) => i.id)).toEqual(["process-threads:case"]);
    expect(items[0].detail).toContain("1 M3 thread is cut straight into printed PETG");
    expect(items[0].fix).toContain('fit: "insert"');
  });
});

const fake = (name: string, material: string, finish?: string, libKind?: string) => ({ id: name, name, label: name, material, finish, libKind, kind: libKind ? "component" : "part", hidden: false, span: { start: 0, end: 0 } }) as unknown as EvalPart;
const box = (lo: V3, hi: V3): [V3, V3] => [lo, hi];

describe("galvanic corrosion", () => {
  const brief = (o: Partial<Brief>) => ({ exposure: [], outdoor: false, ...o }) as Brief;

  it("only matters when the design gets wet", () => {
    expect(galvanicLimit(brief({}))).toBeNull();
    expect(galvanicLimit(brief({ outdoor: true }))?.volts).toBe(0.15);
    expect(galvanicLimit(brief({ exposure: ["sea spray"] }))?.where).toBe("near salt water");
    expect(galvanicLimit(brief({ exposure: ["humid"] }))?.volts).toBe(0.25);
  });

  it("pairs different metals that meet, and leaves sacrificial zinc and coatings alone", () => {
    const plate = fake("plate", "Aluminum 6061", "machined");
    const bolt = fake("bolt", "Stainless 304", undefined, "screw");
    const nut = fake("nut", "Steel", "zinc-plated", "nut");
    const far = fake("far", "Brass");
    const coated = fake("coated", "Aluminum 6061", "anodized");
    const model = { parts: [plate, bolt, nut, far, coated] } as unknown as Model;
    const boxes: Record<string, [V3, V3]> = {
      plate: box([0, 0, 0], [50, 50, 5]),
      bolt: box([20, 20, -10], [25, 25, 10]),
      nut: box([20, 20, -12], [26, 26, -6]),
      far: box([200, 0, 0], [210, 10, 10]),
      coated: box([20, 20, 5], [30, 30, 10]),
    };
    const pairs = metalPairs(model, (p) => boxes[p.name], 0.15);
    const names = pairs.map((p) => [p.a.name, p.b.name].sort().join("+")).sort();
    // stainless on aluminium and stainless on zinc; zinc on aluminium is sacrificial; brass is far away; anodizing insulates
    expect(names).toEqual(["bolt+nut", "bolt+plate"]);
    const plateBolt = pairs.find((p) => p.a.name === "plate" || p.b.name === "plate")!;
    expect(plateBolt.anode.name).toBe("plate");
    const items = galvanicItems([plateBolt], { volts: 0.15, where: "outdoors" });
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("warn");
    expect(items[0].detail).toContain("0.4 V apart");
    expect(items[0].detail).toContain("the Aluminum 6061 corrodes");
    expect(items[0].fix).toContain("Tef-Gel");
  });

  it("finds boxes in assembly coordinates", () => {
    const b = placedBox(box([0, 0, 0], [10, 2, 2]), [{ op: "rotate", angle: 90, origin: [0, 0, 0], axis: [0, 0, 1] }]);
    expect(b[0][1]).toBeCloseTo(0, 6);
    expect(b[1][1]).toBeCloseTo(10, 6);
  });
});

describe("creep under a load that stays on", () => {
  const SHELF = `design "Shelf bracket"
brief {
  purpose: "Hold a shelf"
  use shelf "Holds a 4 kg shelf" { load: 4kg, dir: -Z, on: bracket }
  use knock "Knocked by a hand" { load: 50N, on: bracket, cycles: 10000 }
}
part bracket { material: "PLA" body box(40, 20, 10) }
`;

  it("reads held loads from the brief and judges the analysis stress against the long-term limit", () => {
    const m = evaluate(SHELF);
    expect(errors(m)).toEqual([]);
    const held = heldLoads(m.brief);
    expect([...held.keys()]).toEqual(["bracket"]);
    expect(held.get("bracket")!.map((l) => l.text)).toEqual(["Holds a 4 kg shelf"]);
    const part = m.parts[0];
    const base = { label: "Shelf load", target: 2, printed: true, material: "PLA", layerStress: null, disp: 0.5, gravity: false, exact: true };
    const low = creepItem(m, part, held.get("bracket")!, { ...base, stress: 4 })!;
    expect(low.status).toBe("pass");
    const high = creepItem(m, part, held.get("bracket")!, { ...base, stress: 20 })!;
    expect(high.status).toBe("warn");
    expect(high.detail).toContain("sag over weeks");
    expect(high.fix).toMatch(/creeps less here: \w+/);
  });
});

describe("brief material checks", () => {
  it("suggests better materials that the parts' process can make", () => {
    const m = evaluate(`design "t"
brief {
  purpose: "Garden sign"
  temp: -10C .. 70C
  outdoor: true
  process: "FDM print"
}
part sign { material: "PLA" body box(80, 4, 40) }
`);
    const items = briefChecks(m, [], () => undefined);
    const temp = items.find((i) => i.id === "brief-temp:PLA")!;
    expect(temp.status).toBe("fail");
    expect(temp.detail).toMatch(/(ASA|ABS|PC|Nylon CF) or (ASA|ABS|PC|Nylon CF) would hold up/);
    const sun = items.find((i) => i.id === "brief-sun:PLA")!;
    expect(sun.detail).toContain("ASA");
  });

  it("counts a protective finish when the design gets wet", () => {
    const m = evaluate(`design "t"
brief { purpose: "Bike mount" outdoor: true }
part clamp { material: "Steel" finish: "powder-coated" body box(20, 20, 4) }
part pin { material: "Steel" body box(4, 4, 20) }
`);
    const items = briefChecks(m, [], () => undefined);
    const wet = items.filter((i) => i.id === "brief-wet:Steel");
    expect(wet).toHaveLength(1);
    // one coated and one bare part: still a warning
    expect(wet[0].status).toBe("warn");
  });
});
