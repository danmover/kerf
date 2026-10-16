// Product shots: the shot block in the language, writing shots back into the
// source, and the camera maths (framing, lens and depth of field).

import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { aspectRatio, angleOf, defaultShot, depthOfField, sensorSize, verticalFov, viewDirection, blurFraction, angleText } from "../src/shots/spec";
import { appendShot, freeShotName, removeShot, renameShot, shotRange, shotToSource, writeShot } from "../src/shots/source";
import { orbitCameras, project, shotBasis, solveFraming } from "../src/shots/camera";
import type { V3 } from "../src/kernel/recipe";

const BASE = `design "Box"
part base {
  body box(60, 40, 20)
}
part lid {
  body box(60, 40, 4)
  at: (0, 0, 20)
}
`;

describe("shot blocks", () => {
  it("evaluates a shot with its kind's defaults and the written values", () => {
    const m = evaluate(`${BASE}
shot hero {
  title: "Hero"
  kind: "hero"
  angle: (40deg, 15deg)
  lens: 100mm
  aperture: 8
  focus: lid
  frame: [base, lid]
  lighting: "showroom"
  backdrop: "seamless"
  color: #1b1d22
  props: ["coin"]
  note: "Low three-quarter angle"
  callout(lid, "Tool-free lid")
  callout((0, 0, 24), "Top face")
}
`);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(m.shots).toHaveLength(1);
    const s = m.shots[0];
    expect(s.kind).toBe("hero");
    expect(s.angle).toEqual([40, 15]);
    expect(s.lens).toBe(100);
    expect(s.aperture).toBe(8);
    expect(s.focus).toBe("lid");
    expect(s.frame).toEqual(["base", "lid"]);
    expect(s.color).toBe("#1b1d22");
    expect(s.props).toEqual(["coin"]);
    expect(s.note).toBe("Low three-quarter angle");
    expect(s.callouts.map((c) => c.target)).toEqual(["lid", [0, 0, 24]]);
    // not written: from the hero defaults
    expect(s.fill).toBe(0.72);
    expect(s.aspect).toBe("16:9");
    expect(s.problems).toEqual([]);
    expect(s.set).toContain("lens");
    expect(m.blocks.some((b) => b.kind === "shot" && b.name === "hero")).toBe(true);
  });

  it("takes the kind's defaults wherever kind is written, and section as a call", () => {
    const m = evaluate(`${BASE}
shot cut {
  lens: 70
  section("y", at: 5mm)
  kind: "section"
}
shot plain {
  kind: "section"
  section: false
}
`);
    const [cut, plain] = m.shots;
    expect(cut.kind).toBe("section");
    expect(cut.section).toEqual({ axis: "y", at: 5 });
    expect(plain.section).toBeNull();
  });

  it("reads part names before the parts are defined, and flags names that don't exist", () => {
    const m = evaluate(`design "x"
shot early {
  frame: [lid]
  ghost: [nothing_here]
  focus: lid
}
part lid {
  body box(10, 10, 2)
}
`);
    const s = m.shots[0];
    expect(s.frame).toEqual(["lid"]);
    expect(s.ghost).toEqual([]);
    expect(s.problems.join(" ")).toMatch(/nothing_here/);
    expect(m.diagnostics.some((d) => d.severity === "warning" && /nothing_here/.test(d.message))).toBe(true);
    expect(m.diagnostics.some((d) => d.severity === "error")).toBe(false);
  });

  it("keeps the shot when a line is wrong, with the line flagged", () => {
    const m = evaluate(`${BASE}
shot hero {
  lens: 2000mm
  backdrop: "sky"
  wobble: 3
  fill: 0.5
}
`);
    const s = m.shots[0];
    expect(s.lens).toBe(70);
    expect(s.backdrop).toBe("studio");
    expect(s.fill).toBe(0.5);
    expect(s.problems).toHaveLength(3);
    expect(m.diagnostics.filter((d) => /In shot "hero"/.test(d.message))).toHaveLength(3);
  });

  it("refuses two shots with one name, and doesn't confuse shot with a name", () => {
    const m = evaluate(`${BASE}
let shot = 3
shot a {
  kind: "hero"
}
shot a {
  kind: "detail"
}
`);
    expect(m.shots).toHaveLength(1);
    expect(m.diagnostics.some((d) => d.severity === "error" && /already exists/.test(d.message))).toBe(true);
  });

  it("reports a parse error inside a shot and recovers at the next block", () => {
    const m = evaluate(`${BASE}
shot broken {
  lens: (
}
shot fine {
  kind: "hero"
}
`);
    expect(m.shots.map((s) => s.name)).toContain("fine");
  });
});

describe("writing shots into the source", () => {
  it("round-trips a shot through its source text", () => {
    const s = defaultShot("hero", "hero");
    s.angle = [32.5, 14];
    s.lens = 90;
    s.aperture = 5.6;
    s.focus = "lid";
    s.frame = ["base", "lid"];
    s.ghost = ["base"];
    s.props = ["coin", "pen"];
    s.motion = "turntable";
    s.duration = 8;
    s.callouts = [{ target: "lid", text: "Snap-fit lid" }];
    s.note = 'Rim light on the "lid" edge';
    const src = appendShot(BASE, s);
    const m = evaluate(src);
    expect(m.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
    const back = m.shots[0];
    for (const k of ["angle", "lens", "aperture", "focus", "frame", "ghost", "props", "motion", "duration", "note", "fill", "aspect", "lighting", "backdrop"] as const) expect(back[k]).toEqual(s[k]);
    expect(back.callouts.map((c) => [c.target, c.text])).toEqual([["lid", "Snap-fit lid"]]);
  });

  it("changes only the lines it touches and keeps comments", () => {
    const src = `${BASE}
shot hero {
  // the money shot
  kind: "hero"
  lens: 85mm
  let k = 2
  callout(lid, "Lid")
}
`;
    const m = evaluate(src);
    const next = { ...m.shots[0], lens: 105, angle: [20, 10] as [number, number], ghost: ["base"] };
    const out = writeShot(src, next, { keys: ["lens", "angle", "ghost"] });
    expect(out).toContain("// the money shot");
    expect(out).toContain("let k = 2");
    expect(out).toContain("lens: 105mm");
    expect(out).toContain("angle: (20deg, 10deg)");
    expect(out).toContain("ghost: base");
    expect(out).toContain('callout(lid, "Lid")');
    const m2 = evaluate(out);
    expect(m2.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(m2.shots[0].lens).toBe(105);
    expect(m2.shots[0].angle).toEqual([20, 10]);
    // the angle goes before the lens, as written in order
    expect(out.indexOf("angle:")).toBeLessThan(out.indexOf("lens:"));
  });

  it("removes a line when a value goes back to nothing, and rewrites callouts", () => {
    const src = appendShot(BASE, { ...defaultShot("hero", "hero"), ghost: ["base"], callouts: [{ target: "lid", text: "A" }] });
    const m = evaluate(src);
    const out = writeShot(src, { ...m.shots[0], ghost: [], callouts: [{ target: [0, 0, 1], text: "B" }] }, { keys: ["ghost"], callouts: true });
    expect(out).not.toContain("ghost:");
    expect(out).toContain('callout((0, 0, 1), "B")');
    expect(out).not.toContain('"A"');
  });

  it("finds, renames and removes shot blocks without touching others", () => {
    let src = appendShot(BASE, defaultShot("hero", "hero"));
    src = appendShot(src, defaultShot("detail", "detail"));
    expect(shotRange(src, "detail")).not.toBeNull();
    src = renameShot(src, "detail", "close_up");
    expect(evaluate(src).shots.map((s) => s.name)).toEqual(["hero", "close_up"]);
    src = removeShot(src, "hero");
    expect(evaluate(src).shots.map((s) => s.name)).toEqual(["close_up"]);
    expect(src).toContain("part lid");
    expect(src).not.toMatch(/\n\n\n/);
  });

  it("picks free names", () => {
    const m = evaluate(appendShot(BASE, defaultShot("hero", "hero")));
    expect(freeShotName(m, "hero")).toBe("hero_2");
    expect(freeShotName(m, "base")).toBe("base_2");
    expect(freeShotName(m, "3 quarter view!")).toBe("_3_quarter_view");
  });

  it("writes aperture: false only when the kind would otherwise blur", () => {
    expect(shotToSource({ ...defaultShot("a", "hero"), aperture: null })).not.toContain("aperture");
    expect(shotToSource({ ...defaultShot("a", "detail"), aperture: null })).toContain("aperture: false");
  });
});

describe("lens and depth of field", () => {
  it("keeps the full-frame diagonal for every aspect", () => {
    const [w, h] = sensorSize(1.5);
    expect(w).toBeCloseTo(36, 0);
    expect(h).toBeCloseTo(24, 0);
    expect(Math.hypot(...sensorSize(16 / 9))).toBeCloseTo(43.267, 3);
    expect(aspectRatio("4:5")).toBeCloseTo(0.8);
    // a 50 mm lens on 3:2 full frame sees about 27 degrees vertically
    expect(verticalFov(50, 1.5)).toBeCloseTo(26.99, 1);
  });

  it("matches the textbook depth of field", () => {
    // 50 mm at f/8 focused at 3 m: 2.34 m to 4.19 m (c = 0.03 mm)
    const d = depthOfField(50, 8, 3000);
    expect(d.near / 1000).toBeCloseTo(2.34, 2);
    expect(d.far / 1000).toBeCloseTo(4.19, 2);
    expect(d.hyperfocal / 1000).toBeCloseTo(10.47, 1);
    expect(depthOfField(50, 8, 20000).far).toBe(Infinity);
    // a point at the focus distance is sharp; one twice as far is blurred
    expect(blurFraction(85, 2, 500, 500, 1.5)).toBe(0);
    expect(blurFraction(85, 2, 500, 1000, 1.5)).toBeGreaterThan(0.05);
  });

  it("turns angles into directions and back", () => {
    const d = viewDirection(0, 0);
    expect(d[1]).toBeCloseTo(-1);
    const r = viewDirection(90, 0);
    expect(r[0]).toBeCloseTo(1);
    const a = angleOf(viewDirection(35, 22));
    expect(a[0]).toBeCloseTo(35);
    expect(a[1]).toBeCloseTo(22);
    expect(angleText([35, 20])).toBe("front right, slightly above");
    expect(angleText([-90, 50])).toBe("left side, high");
  });
});

describe("framing", () => {
  const box = (sx: number, sy: number, sz: number, c: V3 = [0, 0, 0]): V3[] => {
    const out: V3[] = [];
    for (let i = 0; i < 8; i++) out.push([c[0] + (i & 1 ? sx / 2 : -sx / 2), c[1] + (i & 2 ? sy / 2 : -sy / 2), c[2] + (i & 4 ? sz : 0)]);
    return out;
  };

  it("fills the frame on the limiting axis and centres the other", () => {
    const pts = box(100, 60, 40);
    for (const lens of [24, 50, 135]) {
      const cam = solveFraming(pts, { angle: [35, 20], roll: 0, lens, fill: 0.7, offset: [0, 0], aspect: "16:9" });
      const e = cam.extent;
      const wx = (e.maxX - e.minX) / 2;
      const wy = (e.maxY - e.minY) / 2;
      expect(Math.max(wx, wy)).toBeCloseTo(0.7, 3);
      expect((e.maxX + e.minX) / 2).toBeCloseTo(0, 3);
      expect((e.maxY + e.minY) / 2).toBeCloseTo(0, 3);
      // every point is in front of the camera
      expect(cam.depth[0]).toBeGreaterThan(0);
    }
  });

  it("moves the subject to the offset, rule-of-thirds style", () => {
    const cam = solveFraming(box(80, 80, 80), { angle: [20, 15], roll: 0, lens: 85, fill: 0.5, offset: [-1 / 6, 0.05], aspect: 1.5 });
    const e = cam.extent;
    expect((e.maxX + e.minX) / 2).toBeCloseTo(-1 / 3, 3);
    expect((e.maxY + e.minY) / 2).toBeCloseTo(0.1, 3);
  });

  it("looks along the shot angle, with roll turning the picture", () => {
    const b = shotBasis([0, 0]);
    expect(b.forward[1]).toBeCloseTo(1);
    expect(b.right[0]).toBeCloseTo(1);
    expect(b.up[2]).toBeCloseTo(1);
    const rolled = shotBasis([0, 0], 90);
    expect(Math.abs(rolled.up[0])).toBeCloseTo(1);
  });

  it("keeps one distance around an orbit so nothing leaves the frame", () => {
    const pts = box(200, 40, 30);
    const turns = Array.from({ length: 12 }, (_, i) => i * 30);
    const cams = orbitCameras(pts, { angle: [0, 20], roll: 0, lens: 50, fill: 0.7, offset: [0, 0], aspect: "16:9" }, turns);
    const d0 = cams[0].distance;
    for (const c of cams) {
      expect(c.distance).toBeCloseTo(d0, 6);
      for (const p of pts) {
        const s = project(c, p);
        expect(Math.abs(s.x)).toBeLessThanOrEqual(0.7001);
        expect(Math.abs(s.y)).toBeLessThanOrEqual(0.7001);
      }
    }
  });
});
