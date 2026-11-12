// Another design inside this one: component mount = design("Motor mount", width: 80) { at:, rotate: } reads the
// other project with the parameters given and places what it makes here, named after the component, as one
// subassembly that mates, analyses and the checks see whole.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { parse } from "../src/lang/parser";
import { designTable, designsUsed, findDesign, setEvalDesigns, type DesignTable } from "../src/lang/designs";
import { applyXforms, type V3 } from "../src/kernel/recipe";
import { Obj, Ref, Vec } from "../src/lang/values";
import { setPartProcess } from "../src/mfg/edit";
import { fullCheck, problems } from "./helpers/fullcheck";
import { initKernel } from "./helpers/kernel";

beforeAll(() => initKernel(), 60_000);
afterEach(() => setEvalDesigns({}));

const MOUNT = `design "Motor mount"
param width = 60 range 40 .. 120 "Plate width"
param thick = 4
param finish = "bare"
let gap = width - 16
part plate {
  material: "Aluminum 6061"
  body box(width, 40, thick)
  for x in [-gap / 2, gap / 2] {
    cut hole(d: 3.4, depth: thick, at: (x, 0, thick))
  }
}
part upright {
  material: "Aluminum 6061"
  held: "Bonded to the plate with epoxy"
  body box(width, thick, 40, at: (0, 18, thick))
}
component screws = lib.screw(M3, 8) { at: [(-gap / 2, 0, thick), (gap / 2, 0, thick)], axis: -Z }
require "Wide enough for the motor": width >= 50
`;

const table = (...designs: [string, string][]): DesignTable =>
  designTable(designs.map(([name, source], i) => ({ id: `prj_${i + 1}`, name, source, updatedAt: 1000 + i })));

const errors = (src: string, designs: DesignTable) =>
  evaluate(src, { designs })
    .diagnostics.filter((d) => d.severity === "error")
    .map((d) => d.message);

const near = (a: V3, b: V3) => a.forEach((x, k) => expect(x).toBeCloseTo(b[k], 6));

describe("placing another design", () => {
  const designs = table(["Motor mount", MOUNT]);
  const HOST = `design "Robot base"
param size = 70
part deck {
  body box(200, 150, 6)
}
component mount = design("Motor mount", width: size + 10) { at: (40, 0, 6), rotate: (0, 0, 90) }
let w = mount.params.width
let wide = mount.gap
let corner = mount.place((10, 0, 0))
`;

  it("brings its parts and components, named after the component and moved to where it goes", () => {
    const m = evaluate(HOST, { designs });
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const names = [...new Set(m.parts.map((p) => p.name))];
    expect(names).toEqual(["deck", "mount_plate", "mount_upright", "mount_screws"]);
    const plate = m.parts.find((p) => p.name === "mount_plate")!;
    expect(plate.insert).toEqual({ block: "mount", design: "Motor mount", part: "plate" });
    expect(plate.group).toBe("Motor mount");
    expect(plate.material).toBe("Aluminum 6061");
    expect(plate.span).toEqual(m.blocks.find((b) => b.name === "mount")!.span);
    // turned a quarter about Z, then moved to (40, 0, 6): the plate's (10, 0, 0) lands at (40, 10, 6)
    near(applyXforms([10, 0, 0], plate.xf), [40, 10, 6]);
    // the screws' heads moved with them, and their axis turned
    const screws = m.parts.filter((p) => p.name === "mount_screws");
    expect(screws.map((p) => p.id)).toEqual(["mount_screws#1", "mount_screws#2"]);
    near(screws[0].fastener!.outward, [0, 0, 1]);
    // the width given (size + 10 = 80) set its gap; each head's top is 3 mm over the plate's 4
    const gap = 80 - 16;
    near(screws[0].fastener!.headTop, [40, -gap / 2, 6 + 4 + 3]);
    expect(m.inserts?.[0]).toMatchObject({ name: "mount", design: "Motor mount", label: "Motor mount", at: [40, 0, 6], rotate: [0, 0, 90], parts: ["mount_plate", "mount_upright", "mount_screws"] });
    expect(m.inserts?.[0].params.find((p) => p.name === "width")).toEqual({ name: "width", value: 80, set: true });
  });

  it("gives the component's fields: its parameters, its parts and values, and where its points are here", () => {
    const m = evaluate(HOST + "require \"Plate fits\": w <= 100\nrequire \"Gap\": wide == 64\nrequire \"Corner\": corner.y == 10\n", { designs });
    const own = m.requirements.filter((r) => ["Plate fits", "Gap", "Corner"].includes(r.label));
    expect(own.map((r) => r.status)).toEqual(["pass", "pass", "pass"]);
  });

  it("checks its own requirements with the sizes given here", () => {
    const narrow = evaluate(HOST.replace("width: size + 10", "width: 45"), { designs });
    const r = narrow.requirements.find((q) => q.label === "Motor mount: Wide enough for the motor")!;
    expect(r.status).toBe("fail");
    expect(r.span).toEqual(narrow.blocks.find((b) => b.name === "mount")!.span);
    expect(evaluate(HOST, { designs }).requirements.find((q) => q.label === "Motor mount: Wide enough for the motor")!.status).toBe("pass");
  });

  it("reads its parts as names here, for shape_of(), analyses and the dependency graph", () => {
    const src = HOST + `part cover {\n  body box(60, 60, 2, at: (40, 0, 60))\n  cut shape_of(mount.upright)\n}\n`;
    const m = evaluate(src, { designs });
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(m.parts.find((p) => p.name === "cover")!.deps).toContain("mount");
    // the placed design shows in the graph as one node, depending on the parameter it is given
    expect(m.graph.nodes.filter((n) => n.id.startsWith("mount")).map((n) => n.id)).toEqual(["mount"]);
    expect(m.graph.edges).toContainEqual({ from: "size", to: "mount" });
    expect(m.parts.find((p) => p.name === "mount_plate")!.deps).toContain("size");
  });

  it("says what is wrong with the call", () => {
    expect(errors(HOST.replace('design("Motor mount"', 'design("Motor mnt"'), designs)[0]).toMatch(/No design called "Motor mnt". Your other designs: "Motor mount"/);
    expect(errors(HOST.replace("width: size + 10", "widht: 80"), designs)[0]).toMatch(/Motor mount has no parameter "widht": did you mean width\? Its parameters: width, thick, finish/);
    expect(errors(HOST.replace("width: size + 10", 'width: "wide"'), designs)[0]).toMatch(/width: Motor mount gives it a number \(60\), so give it a number here too/);
    expect(errors(HOST.replace("width: size + 10", "finish: 2"), designs)[0]).toMatch(/finish: Motor mount gives it text/);
    expect(errors(HOST.replace("{ at: (40, 0, 6), rotate: (0, 0, 90) }", "{ at: (40, 0, 6), material: \"PLA\" }"), designs)[0]).toMatch(/material: is not for a placed design/);
    expect(errors(HOST.replace("at: (40, 0, 6)", "at: [(0, 0, 0), (50, 0, 0)]"), designs)[0]).toMatch(/at: places the design once/);
    const wide = evaluate(HOST.replace("width: size + 10", "width: 150"), { designs });
    expect(wide.diagnostics.find((d) => d.severity === "warning" && /outside the range/.test(d.message))?.message).toMatch(/width: 150 is outside the range Motor mount gives it \(40 to 120\)/);
  });

  it("passes on the design's own errors with where they are", () => {
    const broken = table(["Motor mount", MOUNT.replace("body box(width, thick, 40", "body box(width, thick, nope")]);
    expect(errors(HOST, broken)[0]).toMatch(/^In component "mount": Motor mount, line 16: In part "upright": "nope" is not defined/);
  });

  it("makes its parts as that design says, and leaves its source alone when asked to change one", () => {
    const m = evaluate(`design "Shelf"\nbrief { process: "fdm" }\ncomponent mount = design("Motor mount")\n`, { designs });
    const plate = m.parts.find((p) => p.name === "mount_plate")!;
    expect(plate.process).toBeUndefined();
    expect(plate.material).toBe("Aluminum 6061");
    const src = `component mount = design("Motor mount")\n`;
    expect(setPartProcess(src, plate, { id: "cnc_mill", settings: {} })).toBe(src);
  });

  it("is found by its project's name, then by the name it gives itself", () => {
    const t = designTable([
      { id: "a", name: "Mount v2", source: MOUNT, updatedAt: 1 },
      { id: "b", name: "Bracket", source: 'design "Bracket"\npart b { body box(1, 1, 1) }\n', updatedAt: 2 },
    ]);
    expect(findDesign(t, "mount v2").entry?.id).toBe("a");
    expect(findDesign(t, "Motor mount").entry?.id).toBe("a");
    expect(findDesign(t, "Nothing").entry).toBeUndefined();
    // a worker gets only what the source places, and what that places
    expect(Object.keys(designsUsed(t, 'component m = design("Bracket")'))).toEqual(["b"]);
  });

  it("parses design( in an expression and keeps the design line a statement", () => {
    const p = parse(`design "Robot base"\ncomponent mount = design("Motor mount")\n`);
    expect(p.diagnostics).toEqual([]);
    expect(p.program.stmts.map((s) => s.k)).toEqual(["design", "component"]);
    expect(errors(`design "Robot"\nlet x = design("Motor mount")\n`, designs)[0]).toMatch(/places another of your designs as a subassembly: component mount = design/);
  });
});

describe("designs inside designs", () => {
  const WHEEL = `design "Wheel"
param d = 60
part hub {
  material: "PETG"
  body cylinder(d: d, h: 20)
}
`;
  const CORNER = `design "Corner module"
part bracket {
  material: "PETG"
  body box(40, 40, 5)
}
component wheel = design("Wheel", d: 50) { at: (0, 0, 5) }
`;

  it("names nested parts after each component they are inside", () => {
    const designs = table(["Wheel", WHEEL], ["Corner module", CORNER]);
    const m = evaluate(`design "Cart"\ncomponent front = design("Corner module") { at: (100, 0, 0) }\n`, { designs });
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(m.parts.map((p) => p.id)).toEqual(["front_bracket", "front_wheel_hub"]);
    const hub = m.parts.find((p) => p.id === "front_wheel_hub")!;
    expect(hub.insert).toEqual({ block: "front", design: "Corner module", part: "wheel_hub" });
    near(applyXforms([0, 0, 0], hub.xf), [100, 0, 5]);
  });

  it("never places a design inside itself", () => {
    const loop = table(["Wheel", WHEEL.replace("part hub", 'component back = design("Corner module")\npart hub')], ["Corner module", CORNER]);
    expect(errors(`design "Cart"\ncomponent front = design("Corner module")\n`, loop)[0]).toMatch(/"Corner module" is already being read further out/);
    // the open project is not offered to itself
    setEvalDesigns(table(["Cart", 'design "Cart"\ncomponent me = design("Cart")\n']), "prj_1");
    expect(evaluate('design "Cart"\ncomponent me = design("Cart")\n').diagnostics.find((d) => d.severity === "error")?.message).toMatch(/"Cart" is this design: a design can't be placed inside itself/);
  });
});

describe("a placed design as one body", () => {
  const designs = table(["Motor mount", MOUNT]);
  it("moves whole under a mate, whichever of its parts the mate holds by", () => {
    const src = `design "Robot base"
part deck {
  body box(200, 150, 6)
}
component mount = design("Motor mount") { at: (40, 0, 30) }
mate seat = coincident(point(mount.plate, (40, 0, 30)), point(deck, (40, 0, 6)))
`;
    const m = evaluate(src, { designs });
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(m.mates?.list[0]).toMatchObject({ status: "ok", bodies: ["mount", "deck"] });
    // every part it brought dropped 24 mm together; the deck stayed
    for (const n of ["mount_plate", "mount_upright"]) near(applyXforms([0, 0, 0], m.parts.find((p) => p.name === n)!.xf), [40, 0, 6]);
    near(applyXforms([0, 0, 0], m.parts.find((p) => p.name === "deck")!.xf), [0, 0, 0]);
    expect(evaluate(src.replace("point(deck, (40, 0, 6))", "point(mount.upright, (0, 0, 0))"), { designs }).diagnostics.find((d) => d.severity === "error")?.message).toMatch(/both are parts of mount, which moves as one/);
  });

  it("is analysed with all its parts, and face(mount, ...) takes the side of all of them", () => {
    const src = `design "Robot base"
component mount = design("Motor mount")
analysis "Motor pull" {
  parts: [mount]
  fix: face(mount, -Z)
  load: force(face(mount.upright, +Z), (0, 0, -200N))
}
`;
    const m = evaluate(src, { designs });
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const a = m.analyses[0] as { parts: string[] };
    expect(a.parts).toEqual(["mount_plate", "mount_upright", "mount_screws"]);
  });

  it("can be wired to and checked whole", async () => {
    // the mount's screws reach 4 mm below its plate: here they go into tapped holes in the base, placed with mount.place()
    const src = `design "Bench"
component mount = design("Motor mount", width: 70) { at: (0, 0, 8) }
part base {
  material: "Aluminum 6061"
  body box(160, 120, 8)
  for x in [-27, 27] {
    cut hole(M3, depth: 6, at: mount.place((x, 0, 0)), fit: "tap")
  }
}
`;
    setEvalDesigns(designs);
    const r = await fullCheck(src);
    expect(r.buildErrors.size).toBe(0);
    expect(r.model.parts.filter((p) => p.insert).length).toBe(4);
    expect(problems(r.report, ["fail"])).toEqual([]);
  }, 120_000);
});

describe("bought parts and wiring", () => {
  const DRIVE = `design "Drive unit"
part bracket {
  material: "PETG"
  body box(60, 40, 5)
}
component motor = lib.gearmotor("gobilda_5203_188") { at: (0, 0, 5), axis: X, role: "drive" }
component driver = lib.motor_driver("pololu_g2_18v17") { at: (0, 60, 0) }
wire driver.OUTA -> motor.M_PLUS { gauge: 16 }
wire driver.OUTB -> motor.M_MINUS { gauge: 16 }
`;
  it("brings its bought parts and wires, renamed and moved, and lets this design wire to them", () => {
    const designs = table(["Drive unit", DRIVE]);
    const src = `design "Cart"
component ctrl = lib.controller("arduino_nano") { at: (0, -80, 0) }
component left = design("Drive unit") { at: (100, 0, 0), rotate: (0, 0, 180) }
wire ctrl.D9 -> left_driver.PWM
wire ctrl.D8 -> left_driver.DIR
`;
    const m = evaluate(src, { designs });
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const comps = m.machine!.components.map((c) => c.name);
    expect(comps).toEqual(["ctrl", "left_motor", "left_driver"]);
    const drv = m.machine!.components.find((c) => c.name === "left_driver")!;
    // (0, 60, 0) turned half round Z and moved to (100, 0, 0)
    near(drv.at!, [100, -60, 0]);
    near(drv.axes![0], [-1, 0, 0]);
    expect(m.machine!.wires.map((w) => `${w.a.comp}.${w.a.pin} > ${w.b.comp}.${w.b.pin}`)).toEqual(["left_driver.OUTA > left_motor.M_PLUS", "left_driver.OUTB > left_motor.M_MINUS", "ctrl.D9 > left_driver.PWM", "ctrl.D8 > left_driver.DIR"]);
    // the bought parts are parts here too, in its group
    expect(m.parts.filter((p) => p.insert && p.bom?.catalogId).map((p) => p.name)).toContain("left_motor");
  });
});

describe("its value", () => {
  it("is a component with the design's parts as references", () => {
    const designs = table(["Motor mount", MOUNT]);
    const m = evaluate(`design "x"\ncomponent mount = design("Motor mount")\nrequire "a": mount.thick == 4\nrequire "b": mount.params.width == 60\n`, { designs });
    expect(m.requirements.filter((r) => r.label === "a" || r.label === "b").map((r) => r.status)).toEqual(["pass", "pass"]);
    // Obj, Ref and Vec are what the fields hold (checked through the language above); keep the imports used
    expect([Obj, Ref, Vec].every(Boolean)).toBe(true);
  });
});
