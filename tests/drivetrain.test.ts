import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { lewisY, runDrivetrain, velocityFactor } from "../src/analysis/drivetrain";
import type { DrivetrainSpec } from "../src/analysis/spec";

const reducer = readFileSync(new URL("../src/demos/reducer.kerf", import.meta.url), "utf8");

describe("drivetrain checks", () => {
  it("interpolates the Lewis form factor and the velocity factor", () => {
    expect(lewisY(20)).toBeCloseTo(0.322);
    expect(lewisY(23)).toBeCloseTo(0.334);
    expect(lewisY(1000)).toBe(0.485);
    expect(velocityFactor(0, false)).toBe(1);
    expect(velocityFactor(3.05, true)).toBeCloseTo(2);
  });

  it("follows torque through a two-stage reducer", () => {
    const m = evaluate(reducer + `\nanalysis "Duty" {\n  drive: motor\n  torque: 0.4Nm\n  speed: 600rpm\n  life: 2000h\n  safety: 1.5\n}\n`);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const spec = m.analyses.find((a) => a.label === "Duty") as DrivetrainSpec;
    const r = runDrivetrain(m, spec);
    expect(r.error).toBeUndefined();
    expect(r.meshes).toHaveLength(2);
    // stage 1: 0.4 N·m on a 12-tooth m1 pinion (6 mm pitch radius) → 66.7 N at the teeth
    const s1 = r.meshes.find((x) => x.driven === "g2")!;
    expect(s1.force).toBeCloseTo(400 / 6, 1);
    // pitch-line speed 600 rpm × 2π × 6 mm
    expect(s1.speed).toBeCloseTo((600 * 2 * Math.PI * 6) / 60 / 1000, 4);
    // Lewis by hand for the pinion: F·Kv / (b·m·Y)
    const t = s1.teeth[0];
    expect(t.gear).toBe("g1");
    expect(t.stress).toBeCloseTo((s1.force * t.Kv) / (6 * 1 * 0.245), 3);
    // stage 2 carries 4× the torque at the m1.25 pinion (7.5 mm radius)
    const s2 = r.meshes.find((x) => x.driven === "g4")!;
    expect(s2.force).toBeCloseTo((400 * 4) / 7.5, 1);
    // output: 12:1 → 50 rpm and 4.8 N·m
    expect(r.outputs[0].name).toBe("g4");
    expect(r.outputs[0].rpm).toBeCloseTo(50, 3);
    expect(r.outputs[0].torque).toBeCloseTo(4800, 0);
    // the intermediate and output shafts each sit in two bearings
    expect(r.bearings.map((b) => b.id).sort()).toEqual(["mid_back", "mid_front", "out_back", "out_front"]);
    const mid = r.bearings.filter((b) => b.id.startsWith("mid"));
    // the two tooth forces on the intermediate shaft are shared between its bearings
    const total = (s1.force + s2.force) / Math.cos((20 * Math.PI) / 180);
    expect(mid[0].load + mid[1].load).toBeCloseTo(total, 3);
    for (const b of r.bearings) expect(b.life).toBeCloseTo((Math.pow(b.rating / b.load, 3) * 1e6) / (60 * b.rpm), 0);
    // shaft torsion on the intermediate shaft (5 mm, stainless)
    const shaft = r.shafts.find((s) => s.gears.includes("g2"))!;
    expect(shaft.d).toBe(5);
    expect(shaft.material).toMatch(/Stainless/);
    expect(shaft.assumed).toBe(false);
    expect(shaft.shear).toBeCloseTo((16 * 1600) / (Math.PI * 125), 3);
    // the check items replace the generic note, one per tooth, bearing and shaft
    expect(r.items.filter((i) => i.id.includes(":tooth:"))).toHaveLength(4);
    expect(r.items.every((i) => i.basis === "calculation")).toBe(true);
  });

  it("the reducer demo passes its stated light duty, and says the motor's full torque breaks a pinion", () => {
    const m = evaluate(reducer);
    const light = m.analyses.find((a) => a.label === "Light duty") as DrivetrainSpec;
    expect(light).toBeDefined();
    const ok = runDrivetrain(m, light);
    expect(ok.items.filter((i) => i.status === "fail" || i.status === "warn")).toEqual([]);
    const full = runDrivetrain(m, { ...light, torque: 400, speed: 600, life: 2000 });
    const failing = full.items.filter((i) => i.status === "fail").map((i) => i.id);
    expect(failing).toContain("drive:Light duty:tooth:g3:g3-g4");
    expect(failing.every((id) => id.includes(":tooth:"))).toBe(true);
  });

  it("explains a drive that does not turn", () => {
    const m = evaluate(`design "x"\ncomponent g = lib.spur_gear(m: 1, z: 20, width: 5) { at: (0, 0, 0) }\nanalysis "D" {\n  drive: g\n  torque: 1Nm\n  speed: 100rpm\n}`);
    const r = runDrivetrain(m, m.analyses[0] as DrivetrainSpec);
    expect(r.error).toMatch(/does not turn/);
    expect(r.items[0].status).toBe("fail");
  });
});
