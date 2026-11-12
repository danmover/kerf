import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { evaluate } from "../src/lang/evaluator";
import { buildPart, meshShape, type MeshData } from "../src/kernel/build";
import { zip, crc32 } from "../src/machine/zip";
import { buildPack, cutList, layAcross, madeParts, orientForPrint, readiness, splitTest, testPlan, checkItems } from "../src/machine/pack";
import { wireList, wiringDiagram, wiresCsv, componentPositions } from "../src/machine/wiring";
import { generateFirmware } from "../src/machine/firmware";
import { bomCsv, bomRows, bomTotal } from "../src/persist/files";
import { initKernel } from "./helpers/kernel";

// the sand tunneller demo: about 90 parts and 50 wires. These tests only evaluate it
// (no geometry kernel), which takes well under a second.
const TUNNEL = readFileSync(join(__dirname, "../src/demos/sand-tunneller.kerf"), "utf8");

const PRINTER = `
design "Mini printer"
param bed_size = 220
component psu = lib.psu("lrs_350_24") { at: (-250, 0, 0) }
component board = lib.controller("skr_mini_e3_v3") { at: (-150, 0, 0) }
component pi = lib.host("rpi_zero_2w") { at: (-150, 120, 0) }
component buck = lib.regulator("buck_24v_5v_3a") { at: (-250, 120, 0) }
component mx = lib.stepper("nema17_17hs4401") { at: (0, 300, 300), axis: Y, role: "x" }
component my = lib.stepper("nema17_17hs4401") { at: (150, 0, 50), axis: X, role: "y" }
component mz = lib.stepper("nema17_17hs4401") { at: (0, 0, 40), axis: Z, role: "z" }
component me = lib.stepper("nema17_17hs08_1004s") { at: (0, 300, 360), axis: Y, role: "extruder" }
component hot = lib.hotend("e3d_v6_24v") { at: (0, 280, 250) }
component bed = lib.heated_bed("heated_bed_235_24v") { at: (0, 0, 80) }
component fan_part = lib.fan("blower_5015_24v") { at: (40, 280, 280), axis: X }
component fan_hot = lib.fan("fan_4010_24v") { at: (-30, 280, 280), axis: X }
component stop_x = lib.sensor("endstop_mech") { at: (-120, 300, 300) }
component stop_y = lib.sensor("endstop_mech") { at: (0, -150, 50) }
component probe = lib.sensor("bltouch") { at: (30, 300, 260) }
component frame_a = lib.extrusion("vslot_2020", length: 400) { at: (-160, -160, 0), axis: Z }
component frame_b = lib.extrusion("vslot_2020", length: 400) { at: (160, -160, 0), axis: Z }
component frame_c = lib.extrusion("vslot_2020", length: 340) { at: (-160, -160, 400), axis: X }
component frame_d = lib.extrusion("vslot_2040", length: 340) { at: (-160, 160, 0), axis: X }
component rail_x = lib.rail("mgn12h", length: 300, travel: 100) { at: (-150, 300, 300), axis: X }
component screw_z = lib.lead_screw("lead_screw_t8x8", length: 350, travel: 100) { at: (0, 0, 40), axis: Z }

part motor_mount {
  body box(60, 60, 5)
  cut cylinder(d: 22.5, h: 20, at: (0, 0, -5))
  material: "PETG"
  at: (0, 300, 320)
}
part fan_duct {
  body box(60, 4, 40)
  material: "PLA"
  at: (30, 300, 270)
}
part base_plate {
  body box(120, 80, 6)
  material: "Aluminum 6061"
  at: (0, 0, -10)
}

wire psu.V_PLUS -> board.POWER { gauge: 16, color: "red" }
wire psu.V_MINUS -> board.POWER_GND { gauge: 16, color: "black" }
wire psu.V_PLUS -> buck.IN_POS { gauge: 18 }
wire psu.V_MINUS -> buck.IN_NEG { gauge: 18 }
wire buck.OUT_POS -> pi.V5
wire buck.OUT_NEG -> pi.GND
wire board.XM -> mx.PLUG
wire board.YM -> my.PLUG
wire board.ZAM -> mz.PLUG
wire board.E0M -> me.PLUG
wire board.HE0 -> hot.HEATER
wire board.TH0 -> hot.THERM
wire board.HB -> bed.HEATER
wire board.THB -> bed.THERM
wire board.FAN0 -> fan_part.PLUG
wire board.FAN1 -> fan_hot.PLUG
wire board.XSTOP -> stop_x.PLUG
wire board.YSTOP -> stop_y.PLUG
wire board.PROBE -> probe.PLUG
wire board.USB -> pi.USB

let warm = calc.heater_warmup(power: 220W, mass: 900, from: 25, to: 60)
let flow = calc.print_speed(flow: 15, layer: 0.2, width: 0.45)
firmware klipper { board: board, x_size: bed_size, y_size: bed_size, z_size: 250 }
test "First layer": "Print a 100 mm square one layer thick; it must stick everywhere and be within 0.05 mm of 0.2 mm thick"
test "Bed heat": "Heat the bed to 60 °C; it should take under 3 minutes"
buy "M5 T-nuts" { qty: 30, price: 0.2, search: "M5 drop-in T-nut 2020" }
buy "PTFE tube 1 m" { qty: 1, price: 5 }
buy "GT2 belt 6 mm, 2 m" { qty: 1, url: "https://www.example.com/gt2-belt" }
`;

const text = (d: string | Uint8Array) => (typeof d === "string" ? d : new TextDecoder().decode(d));

/** Lists and reads a zip with Python's zipfile (a reader independent of ours). */
function pyUnzip(path: string): Record<string, string> {
  const script = "import sys, json, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nbad = z.testzip()\nassert bad is None, bad\nprint(json.dumps({i.filename: z.read(i).decode('utf-8', 'replace') for i in z.infolist()}))";
  return JSON.parse(execFileSync("python3", ["-I", "-c", script, path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
}

describe("zip writer", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it("round-trips names and contents through unzip and Python's zipfile", () => {
    const dir = mkdtempSync(join(tmpdir(), "kerf-zip-"));
    try {
      const bin = new Uint8Array(70000).map((_, i) => (i * 7919) % 256);
      const entries = [
        { path: "README.md", data: "# Hello\n" },
        { path: "print/bracket.stl", data: bin },
        { path: "wiring/Schaltplan – Größe.svg", data: "<svg>ü ✓</svg>" },
        { path: "/../evil/../ok.txt", data: "clean" },
        { path: "empty.txt", data: "" },
      ];
      const file = join(dir, "pack.zip");
      writeFileSync(file, zip(entries, new Date(2026, 9, 16, 12, 30, 10)));
      // Info-ZIP's tester checks every CRC and header
      const t = execFileSync("unzip", ["-t", file], { encoding: "utf8" });
      expect(t).toMatch(/No errors detected/);
      const files = pyUnzip(file);
      expect(Object.keys(files).sort()).toEqual(["README.md", "empty.txt", "evil/ok.txt", "print/bracket.stl", "wiring/Schaltplan – Größe.svg"].sort());
      expect(files["README.md"]).toBe("# Hello\n");
      expect(files["wiring/Schaltplan – Größe.svg"]).toBe("<svg>ü ✓</svg>");
      expect(files["empty.txt"]).toBe("");
      // binary content survives byte for byte
      const out = join(dir, "x");
      execFileSync("unzip", ["-q", file, "print/bracket.stl", "-d", out]);
      expect(new Uint8Array(readFileSync(join(out, "print/bracket.stl")))).toEqual(bin);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("wiring", () => {
  const m = evaluate(TUNNEL);

  it("lists every physical wire in build order, skipping joins inside a part", () => {
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const rows = wireList(m.machine!, componentPositions(m));
    // the XT60 halves and the fuse join inside the part: no wire between them
    expect(rows.find((r) => r.from.comp === "xt" && r.to.comp === "xt")).toBeUndefined();
    const kinds = rows.map((r) => r.kind);
    expect(kinds[0]).toBe("ground");
    expect(kinds[kinds.length - 1]).toBe("power");
    expect(rows.map((r) => r.id)).toEqual(rows.map((_, i) => `W${i + 1}`));
    const pwm = rows.find((r) => r.from.comp === "ctrl" && r.from.pin === "D9")!;
    expect(pwm.to).toMatchObject({ comp: "drv_f", pin: "PWM" });
    expect(pwm.kind).toBe("signal");
    const own = m.machine!.wires.find((w) => w.a.comp === "ctrl" && w.a.pin === "D9")!;
    expect(pwm.gauge).toBe(own.gauge ?? 24);
    expect(pwm.gaugeSuggested).toBe(own.gauge === undefined);
    const motor = rows.find((r) => r.to.comp === "m_front" && r.to.pin === "M_PLUS")!;
    expect(motor).toMatchObject({ color: "red", kind: "motor" });
    // the gearmotor stalls at several amps: thick wire
    expect(motor.gauge).toBeLessThanOrEqual(18);
    expect(motor.lengthMm).toBeGreaterThan(0);
    // a net is wired as a star from its supply
    const v5 = rows.filter((r) => r.net === "V5");
    expect(v5.length).toBeGreaterThan(3);
    expect(v5.every((r) => r.from.comp === "reg" && r.from.pin === "VOUT")).toBe(true);
    const csv = wiresCsv(rows);
    expect(csv.split("\n")[0]).toBe("Wire,From,From label,To,To label,Net,Gauge (AWG),Colour,Length (mm),Type,Label,Notes");
    expect(csv).toContain("W1,");
  });

  it("suggests a gauge and colour when the design gives none", () => {
    const small = evaluate(`
design "Bench"
component ctrl = lib.controller("arduino_nano") { at: (0, 0, 0) }
component drv = lib.motor_driver("tb6612fng") { at: (60, 0, 0) }
wire ctrl.D9 -> drv.PWMA
wire ctrl.GND -> drv.GND
`);
    expect(small.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const rows = wireList(small.machine!, componentPositions(small));
    const pwm = rows.find((r) => r.to.pin === "PWMA")!;
    expect(pwm).toMatchObject({ gauge: 24, gaugeSuggested: true, colorSuggested: true, kind: "signal" });
    expect(rows[0]).toMatchObject({ kind: "ground", color: "black" });
    expect(wiresCsv(rows)).toContain("Gauge suggested by Kerf");
  });

  it("draws a legible diagram with every wired part", () => {
    const d = wiringDiagram(m.machine!, { title: "Sand tunneller" });
    expect(d.svg.startsWith("<svg")).toBe(true);
    // every wired part has a box; parts without pins (the shaft seals) do not
    const wired = new Set(wireList(m.machine!).flatMap((r) => [r.from.comp, r.to.comp]));
    for (const c of wired) expect(d.svg).toContain(`>${c}<`);
    expect(d.parts).toBe(wired.size);
    expect(d.svg).not.toContain(">seal_f<");
    // printed pin labels from the catalog, not just ids
    expect(d.svg).toContain("Encoder A (yellow)");
    expect(d.width).toBeLessThan(2600);
    expect(d.height).toBeLessThan(1800);
    // well-formed XML
    const dir = mkdtempSync(join(tmpdir(), "kerf-svg-"));
    try {
      writeFileSync(join(dir, "w.svg"), d.svg);
      execFileSync("python3", ["-I", "-c", "import sys, xml.dom.minidom as m; m.parse(sys.argv[1])", join(dir, "w.svg")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("escapes names in the diagram", () => {
    const src = TUNNEL.replace('role: "front screw"', 'role: "<b>front</b> & \\"screw\\""');
    const d = wiringDiagram(evaluate(src).machine!);
    expect(d.svg).not.toContain("<b>");
    expect(d.svg).toContain("&lt;b&gt;front&lt;/b&gt; &amp;");
  });
});

describe("parts list", () => {
  it("adds prices, links, catalog ids, cut lengths and buy statements", () => {
    const m = evaluate(PRINTER);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const rows = bomRows(m);
    const stepper = rows.find((r) => r.catalogId === "nema17_17hs4401")!;
    expect(stepper.qty).toBe(3);
    expect(stepper.price).toBe(10);
    expect(stepper.links.some((l) => /amazon\.com\/s\?k=/.test(l.url))).toBe(true);
    // profiles are priced per metre
    const ext = rows.find((r) => r.catalogId === "vslot_2020" && r.length === 400)!;
    expect(ext.qty).toBe(2);
    expect(ext.price).toBeCloseTo(3.2);
    expect(ext.priceNote).toMatch(/per metre/);
    const nuts = rows.find((r) => r.description === "M5 T-nuts")!;
    expect(nuts).toMatchObject({ qty: 30, price: 0.2, kind: "Buy" });
    const belt = rows.find((r) => r.description === "GT2 belt 6 mm, 2 m")!;
    expect(belt.link).toBe("https://www.example.com/gt2-belt");
    expect(rows.find((r) => r.kind === "Make" && r.item === "motor_mount")?.material).toBe("PETG");
    const { total, unpriced } = bomTotal(rows);
    expect(total).toBeGreaterThan(300);
    expect(unpriced).toBe(1);
    const csv = bomCsv(m).split("\n");
    expect(csv[0]).toBe("Qty,Make/Buy,Item,Description,Material,Standard,Price,Link");
    expect(csv.find((l) => l.includes("M5 T-nuts"))).toContain(",0.20,https://www.amazon.com/s?k=M5%20drop-in%20T-nut%202020");
  });

  it("plans the cuts from standard bars", () => {
    const groups = cutList(evaluate(PRINTER));
    const v2020 = groups.find((g) => g.part.id === "vslot_2020")!;
    expect(v2020.cuts).toEqual([
      { length: 400, qty: 2, comps: ["frame_a", "frame_b"] },
      { length: 340, qty: 1, comps: ["frame_c"] },
    ]);
    // 400 + 400 fit one metre bar, 340 needs a second
    expect(v2020.stockLength).toBe(1000);
    expect(v2020.stockCount).toBe(2);
    expect(groups.find((g) => g.part.id === "mgn12h")?.stockLength).toBeUndefined();
  });

  it("prints identical parts from one file and keeps file names distinct", () => {
    const m = evaluate(`
design "Feet"
part foot {
  body box(20, 20, 10)
  material: "PETG"
}
part foot_b {
  body box(20, 20, 10)
  material: "PETG"
  at: (300, 0, 0)
}
part Foot {
  body box(30, 20, 10)
  material: "PETG"
}
component c = lib.controller("arduino_nano") { at: (0, 0, 50) }
`);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(madeParts(m).map((p) => [p.file, p.qty])).toEqual([
      ["print/foot.stl", 2],
      ["print/Foot_2.stl", 1],
    ]);
    const files = buildPack(m, null);
    const readme = String(files.find((f) => f.path === "print/README.md")!.data);
    expect(readme).toContain("Print 2: the design uses 2 identical copies");
    expect(String(files.find((f) => f.path === "assembly.md")!.data)).toContain("Print 2 × `print/foot.stl`");
  });

  it("prints copies turned into place from one file, and a left and a right hand from two", async () => {
    await initKernel();
    const m = evaluate(`
design "Copies"
part foot_1 { material: "PETG"  process: mfg.fdm()  body box(40, 30, 10, at: (-100, 0, 0), r: 3)  cut hole(d: 5, through: true, at: (-110, 5, 10), dir: -Z) }
part foot_2 { material: "PETG"  process: mfg.fdm()  body box(40, 30, 10, at: (100, 0, 0), r: 3)  cut hole(d: 5, through: true, at: (90, 5, 10), dir: -Z) }
part foot_3 { material: "PETG"  process: mfg.fdm()  rotate: (0, 0, 30)  body rotate(shape_of(foot_1), 30) }
part bracket_left { material: "PETG"  process: mfg.fdm()  body box(40, 30, 10, at: (0, 80, 0))  add box(10, 30, 30, at: (15, 80, 10))  cut hole(d: 5, through: true, at: (-10, 72, 10), dir: -Z) }
part bracket_right { material: "PETG"  process: mfg.fdm()  body mirror(shape_of(bracket_left), normal: X) }
component c = lib.controller("arduino_nano") { at: (0, 0, 50) }
`);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const meshes = new Map<string, MeshData>();
    const meshFor = (p: { hash: string; recipe: Parameters<typeof buildPart>[0] }) => {
      if (!meshes.has(p.hash)) meshes.set(p.hash, meshShape(buildPart(p.recipe), "preview"));
      return meshes.get(p.hash);
    };
    // the feet typed out twice and turned into place are one file, named for what their names share
    expect(madeParts(m, meshFor).map((p) => [p.file, p.qty, p.title])).toEqual([
      ["print/foot.stl", 3, "Foot"],
      ["print/bracket_left.stl", 1, "bracket_left"],
      ["print/bracket_right.stl", 1, "bracket_right"],
    ]);
    const files = buildPack(m, null, { meshFor });
    expect(files.filter((f) => f.path.endsWith(".stl")).map((f) => f.path)).toEqual(["print/foot.stl", "print/bracket_left.stl", "print/bracket_right.stl"]);
    expect(text(files.find((f) => f.path === "print/README.md")!.data)).toContain("Print 3: the design uses 3 identical copies (foot_1, foot_2 and foot_3)");
    // each foot's row in the parts list points at the one file
    const bom = text(files.find((f) => f.path === "bom.html")!.data);
    expect(bom.match(/STL in print\/foot\.stl/g)).toHaveLength(3);
    expect(bom).not.toContain("print/foot_2.stl");
  }, 120000);
});

describe("test plan and readiness", () => {
  it("splits steps from pass criteria", () => {
    expect(splitTest("Dig 30 cm into a bucket of damp sand; current must stay under 6 A")).toEqual({ steps: "Dig 30 cm into a bucket of damp sand.", pass: "Current must stay under 6 A." });
    expect(splitTest("Run the motor at full load for 10 minutes and check the heatsink stays below about 70 °C.")).toEqual({ steps: "Run the motor at full load for 10 minutes.", pass: "The heatsink stays below about 70 °C." });
    expect(splitTest("Time the first heat-up with a thermometer.")).toEqual({ steps: "Time the first heat-up with a thermometer." });
  });

  it("keeps the action before a colon as a step, and asides and commands out of the criterion", () => {
    // from the jet-vane rig: the action and its criterion share a clause, and the set-up mentions numbers in passing
    expect(
      splitTest(
        "No ballast in the hub, both locks out (the load cell stays on the ring), 'arm', 't 40', 'hold', then 't 70'. The unit should hold ±1°. Push it 5° and let go: it should come back in under 1 s without ringing. Then 'gain 1.0', 'save' and repeat.",
      ),
    ).toEqual({
      steps: "No ballast in the hub, both locks out (the load cell stays on the ring), 'arm', 't 40', 'hold', then 't 70'. Push it 5° and let go. Then 'gain 1.0', 'save' and repeat.",
      pass: "The unit should hold ±1°. It should come back in under 1 s without ringing.",
    });
    expect(
      splitTest("With a servo out, push its horn into the vane's pocket: it should go in with a firm push and not rock. Turn the vane by hand: no play you can feel at the trailing edge (under 0.3 mm). If it rocks, a drop of CA in the pocket."),
    ).toEqual({
      steps: "With a servo out, push its horn into the vane's pocket. Turn the vane by hand. If it rocks, a drop of CA in the pocket.",
      pass: "It should go in with a firm push and not rock. No play you can feel at the trailing edge (under 0.3 mm).",
    });
    // a quoted command is not a comparison, and "; " inside brackets does not end the clause
    expect(splitTest("'tare', 'arm', 'sweep'. It should be a straight line (I from the report; about 4 mm). Set the value with 'liftk <value>' and 'save'.")).toEqual({
      steps: "'tare', 'arm', 'sweep'. Set the value with 'liftk <value>' and 'save'.",
      pass: "It should be a straight line (I from the report; about 4 mm).",
    });
  });

  it("collects part, calculation and design tests", () => {
    const m = evaluate(PRINTER);
    const plan = testPlan(m.machine!);
    expect(plan.filter((p) => p.source === "design").map((p) => p.title)).toEqual(["First layer", "Bed heat"]);
    // one entry per catalog part, not per instance
    expect(plan.filter((p) => p.title === "hot: E3D V6 all-metal hotend, 24 V, 1.75 mm")).toHaveLength(1);
    expect(plan.find((p) => p.parts?.includes("mx"))).toBeUndefined();
    expect(plan.find((p) => p.source === "calculation")?.expected?.length).toBeGreaterThan(0);
  });

  it("gives a verdict from the checks", () => {
    const m = evaluate(TUNNEL);
    const items = checkItems(m, null);
    const r = readiness(m, items, testPlan(m.machine!));
    expect(r.headline).toMatch(/^(Ready to order and build|Not ready: )/);
    const broken = evaluate(TUNNEL.replace("wire ctrl.D9 -> drv_f.PWM", "wire ctrl.V5 -> drv_f.PWM\nwire bat.POS -> ctrl.GND"));
    const rb = readiness(broken, checkItems(broken, null), testPlan(broken.machine!));
    expect(rb.level).toBe("blocked");
    expect(rb.headline).toMatch(/^Not ready: \d+ wiring checks? fails?\.$/);
    expect(rb.electrical.fail).toBeGreaterThan(0);
  });
});

describe("build pack", () => {
  it("contains everything for the sand tunneller", () => {
    const m = evaluate(TUNNEL);
    const files = buildPack(m, null, { date: new Date(2026, 9, 16) });
    const paths = files.map((f) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining(["README.md", "bom.html", "bom.csv", "print/README.md", "wiring/wiring.svg", "wiring/wires.csv", "calculations.md", "checks.md", "test_plan.md", "assembly.md", "firmware/brain/brain.ino", "firmware/brain/README.md"]),
    );
    expect(new Set(paths).size).toBe(paths.length);
    // firmware exactly as the generator writes it
    for (const f of generateFirmware(m.machine!, m.name)[0].files) expect(text(files.find((x) => x.path === f.path)!.data)).toBe(f.content);
    const readme = text(files[0].data);
    expect(readme).toMatch(/^# Sand Tunneller: build pack\n\n\*\*(Ready to order and build|Not ready: )/);
    expect(readme).toContain("| `bom.html` |");
    // the circuit's schematic sheet, described in the read-me
    const sch = text(files.find((f) => f.path === "wiring/schematic.svg")!.data);
    expect(sch.startsWith("<svg") || sch.startsWith("<?xml")).toBe(true);
    expect(readme).toContain("| `wiring/schematic.svg` |");
    const assembly = text(files.find((f) => f.path === "assembly.md")!.data);
    // ground first, power last
    expect(assembly.indexOf("### GND")).toBeLessThan(assembly.indexOf("### VBAT"));
    expect(assembly).toContain("firmware/brain/README.md");
    const html = text(files.find((f) => f.path === "bom.html")!.data);
    expect(html).toContain('href="https://www.gobilda.com/');
    expect(html).toContain("<tfoot>");
    // no stock to cut, and no STL files when no geometry is handed in
    expect(paths).not.toContain("cut_list.csv");
    expect(paths.some((p) => p.endsWith(".stl"))).toBe(false);
    // the TPU hinge boot is printed like the PETG parts
    const boot = madeParts(m).find((p) => p.part.material === "TPU")!;
    expect(boot.printable).toBe(true);
    const print = text(files.find((f) => f.path === "print/README.md")!.data);
    expect(print).toContain(`## ${boot.part.name}`);
    expect(print).toContain("TPU is flexible");
    expect(print).not.toContain("Parts to machine or cut");
    // every calculation is in calculations.md with its confidence
    const calcs = text(files.find((f) => f.path === "calculations.md")!.data);
    for (const c of m.machine!.calcs) expect(calcs).toContain(c.title);
  });

  it("orients printed parts on their largest flat face", async () => {
    await initKernel();
    const m = evaluate(PRINTER);
    const mesh = (name: string) => meshShape(buildPart(m.parts.find((p) => p.name === name)!.recipe), "final");
    // modelled standing up: 60 × 4 × 40 lies down on a 60 × 40 face
    const duct = orientForPrint(mesh("fan_duct"));
    expect(duct.size[2]).toBeCloseTo(4, 3);
    expect(duct.faceArea).toBeCloseTo(2400, 0);
    let minZ = Infinity;
    for (let i = 2; i < duct.positions.length; i += 3) minZ = Math.min(minZ, duct.positions[i]);
    expect(minZ).toBeCloseTo(0, 4);
    // the plate is already flat: it keeps its orientation
    const plate = orientForPrint(mesh("motor_mount"));
    expect(plate.size[2]).toBeCloseTo(5, 3);
    expect(plate.face).toMatch(/points down/);
    // a build direction from the part's process wins: the duct stands up again, layers along +Z of the design
    const standing = orientForPrint(mesh("fan_duct"), [0, 0, 1]);
    expect(standing.size[2]).toBeCloseTo(40, 3);
    expect(standing.face).toMatch(/points down/);
  }, 120000);

  it("lays a print too long for the bed across it in the STL", async () => {
    await initKernel();
    const m = evaluate(`
part rail { process: mfg.fdm(bed: (256, 256, 256)) material: "PETG" body box(269, 50, 20) }
part short { process: mfg.fdm(bed: (256, 256, 256)) material: "PETG" body box(200, 50, 20) }
`);
    const made = madeParts(m, (p) => meshShape(buildPart(p.recipe), "preview"));
    const rail = made.find((p) => p.part.name === "rail")!;
    // the part keeps its own size, the STL lies 45° across the 256 mm bed, which only that turn lets it fit
    expect(rail.size![0]).toBeCloseTo(269, 3);
    expect(rail.orientation).toMatch(/longer than the 256 × 256 mm bed, so the STL also lies 45° across it/);
    const dv = new DataView(rail.stl!);
    const lo = [Infinity, Infinity];
    const hi = [-Infinity, -Infinity];
    for (let t = 0; t < dv.getUint32(80, true); t++) {
      for (let v = 0; v < 3; v++) {
        for (let k = 0; k < 2; k++) {
          const x = dv.getFloat32(84 + t * 50 + 12 + v * 12 + k * 4, true);
          lo[k] = Math.min(lo[k], x);
          hi[k] = Math.max(hi[k], x);
        }
      }
    }
    expect(hi[0] - lo[0]).toBeCloseTo((269 + 50) / Math.SQRT2, 1);
    expect(hi[1] - lo[1]).toBeLessThan(256);
    expect(Math.abs(hi[0] + lo[0])).toBeLessThan(1e-3);
    // one that fits square stays square
    expect(made.find((p) => p.part.name === "short")!.orientation).not.toMatch(/across it/);
    expect(layAcross(new Float32Array([0, 0, 0, 200, 50, 0]), [200, 50, 20], [256, 256])).toBeUndefined();
  }, 120000);

  it("lays each tunneller part the way its process says it prints", async () => {
    await initKernel();
    const m = evaluate(TUNNEL);
    const meshes = new Map<string, MeshData>();
    const made = madeParts(m, (p) => {
      if (!meshes.has(p.hash)) meshes.set(p.hash, meshShape(buildPart(p.recipe), "preview"));
      return meshes.get(p.hash);
    });
    const screw = made.find((p) => p.part.name === "front_screw")!;
    // printed standing up along the screw's axis, which is X in the design
    expect(screw.orientation).toMatch(/−X side/);
    expect(screw.size![2]).toBeGreaterThan(200);
    expect(made.find((p) => p.part.name === "rear_screw")!.orientation).toMatch(/\+X side/);
  }, 120000);

  it("contains everything for the printer, with real STL files", async () => {
    await initKernel();
    const m = evaluate(PRINTER);
    const meshes = new Map<string, MeshData>();
    const meshFor = (p: { name: string; recipe: Parameters<typeof buildPart>[0] }) => {
      if (!meshes.has(p.name)) meshes.set(p.name, meshShape(buildPart(p.recipe), "final"));
      return meshes.get(p.name);
    };
    const step = new TextEncoder().encode("ISO-10303-21;\nEND-ISO-10303-21;\n");
    const files = buildPack(m, null, { meshFor, step, name: "My printer" });
    const paths = files.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(["cut_list.csv", "print/motor_mount.stl", "print/fan_duct.stl", "print/base_plate.stl", "print/README.md", "cad/assembly.step", "firmware/klipper/printer.cfg"]));
    const stl = files.find((f) => f.path === "print/motor_mount.stl")!.data as Uint8Array;
    const dv = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
    expect(stl.byteLength).toBe(84 + 50 * dv.getUint32(80, true));
    const printReadme = text(files.find((f) => f.path === "print/README.md")!.data);
    expect(printReadme).toContain("## fan_duct");
    expect(printReadme).toContain("Parts to machine or cut");
    const readme = text(files[0].data);
    expect(readme).toMatch(/^# My printer: build pack/);
    const plan = text(files.find((f) => f.path === "test_plan.md")!.data);
    expect(plan).toContain("**Pass when:** It must stick everywhere and be within 0.05 mm of 0.2 mm thick.");

    // write the pack out when asked, to look at it
    const out = process.env.KERF_PACK_OUT;
    if (out) {
      for (const [n, src, extra] of [["printer", PRINTER, { meshFor, step }], ["tunnel", TUNNEL, {}]] as const) {
        const model = evaluate(src);
        const fs = buildPack(model, null, extra);
        for (const f of fs) {
          const p = join(out, n, f.path);
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, f.data);
        }
        writeFileSync(join(out, `${n}.zip`), zip(fs.map((f) => ({ path: `${model.name} build pack/${f.path}`, data: f.data }))));
      }
    }
  }, 120000);
});
