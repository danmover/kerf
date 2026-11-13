// Decals: what decal() and a part's decal: give, and how a decal lies on a
// mesh (only the faces facing it, clipped to its box, wrapping round a curve).

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { evaluate } from "../src/lang/evaluator";
import { LETTER_W, LINE_H } from "../src/lang/decals";
import { decalBox, projectDecal, type MeshArrays } from "../src/core/decal";
import type { DecalSpec } from "../src/core/model";
import type { V3 } from "../src/kernel/recipe";
import { Decorators } from "../src/ui/viewport/parts/decorate";
import type { Decorator, PartDecoration } from "../src/ui/viewport/scene";

const errors = (src: string) => evaluate(src).diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
const partWith = (decal: string, body = "box(80, 50, 10)") => evaluate(`design "t"\npart lid {\n  body ${body}\n  decal: ${decal}\n}\n`);

describe("decal()", () => {
  it("sizes lettering from its letter height and faces it the way it is told", () => {
    const m = partWith('decal(text: "KERF", at: (0, 0, 10), dir: +Z, size: 8, bold: true)');
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const [d] = m.parts[0].decals!;
    expect(d.text).toBe("KERF");
    expect(d.at).toEqual([0, 0, 10]);
    expect(d.dir).toEqual([0, 0, 1]);
    // facing up, its up is +Y; on a side, +Z
    expect(d.up).toEqual([0, 1, 0]);
    expect(d.width).toBeCloseTo(8 * 4 * LETTER_W + 8 * 0.6, 6);
    expect(d.height).toBeCloseTo(8 * LINE_H, 6);
    expect(d.bold).toBe(true);
    expect(d.color).toBe("#1b1d21");
    const side = partWith('decal(text: "A\\nB", at: (0, -25, 5), dir: -Y, height: 20, color: #ffffff, background: "#c0392b")').parts[0].decals![0];
    expect(side.up).toEqual([0, 0, 1]);
    expect(side.height).toBe(20);
    expect(side.text).toBe("A\nB");
    expect(side.background).toBe("#c0392b");
    expect(side.color).toBe("#ffffff");
    // up: is squared to dir
    const tilted = partWith('decal(text: "X", at: (0, 0, 10), up: (1, 1, 1))').parts[0].decals![0];
    expect(tilted.up[2]).toBeCloseTo(0, 9);
    expect(Math.hypot(...tilted.up)).toBeCloseTo(1, 9);
  });

  it("takes a project picture and a list of decals", () => {
    const m = partWith('[decal(image: "ast_k3j9x2", at: (0, 0, 10), width: 30, clear: "white"), decal(text: "v2", at: (30, 0, 10))]');
    const [pic, txt] = m.parts[0].decals!;
    expect(pic).toMatchObject({ image: "ast_k3j9x2", width: 30, clear: "white", depth: 15 });
    expect(pic.height).toBeUndefined();
    expect(txt.text).toBe("v2");
  });

  it("goes on a component's main solid", () => {
    const m = evaluate(`design "t"\ncomponent g = lib.spur_gear(m: 1, z: 30, width: 6, bore: 5) { decal: decal(text: "30T", at: (0, 0, 6), size: 4) }\n`);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const withDecals = m.parts.filter((p) => p.decals?.length);
    expect(withDecals.map((p) => p.id)).toEqual(["g"]);
  });

  it("says what is wrong", () => {
    const d = (x: string) => errors(`design "t"\npart lid {\n  body box(80, 50, 10)\n  decal: ${x}\n}\n`).join(" ");
    expect(d('decal(at: (0, 0, 10))')).toMatch(/text: .* or image: .*one of them/);
    expect(d('decal(text: "A", image: "ast_abcd12", at: (0, 0, 10))')).toMatch(/one of them/);
    expect(d('decal(text: "A")')).toMatch(/at: is where its middle sits/);
    expect(d('decal(text: "A", at: (0, 0, 10), up: +Z)')).toMatch(/should not point along dir/);
    expect(d('decal(image: "logo.png", at: (0, 0, 10))')).toMatch(/picture added to the project/);
    expect(d('decal(image: "ast_abcd12", at: (0, 0, 10), size: 4)')).toMatch(/letter height of a text decal/);
    expect(d('decal(text: "A", at: (0, 0, 10), clear: "white")')).toMatch(/clear: leaves a colour of an image/);
    expect(d('decal(text: "A", at: (0, 0, 10), size: 4, width: 20)')).toMatch(/not both/);
    expect(d('decal(text: "A", at: (0, 0, 10), color: "rgb(1, 2, 3)")')).toMatch(/colour like/);
    expect(d('"KERF"')).toMatch(/should be decal\(\.\.\.\)/);
    expect(d('decal(text: "", at: (0, 0, 10))')).toMatch(/empty/);
  });
});

/** A box's surface as triangles, wound outwards, each face with its own normals. */
function boxMesh(sx: number, sy: number, sz: number, c: V3 = [0, 0, 0]): MeshArrays {
  const g = new THREE.BoxGeometry(sx, sy, sz).toNonIndexed();
  g.translate(...c);
  return { position: g.getAttribute("position").array, normal: g.getAttribute("normal").array };
}

/** The triangles' total area. */
function area(p: Float32Array): number {
  let a = 0;
  for (let i = 0; i < p.length; i += 9) {
    const u = [p[i + 3] - p[i], p[i + 4] - p[i + 1], p[i + 5] - p[i + 2]];
    const v = [p[i + 6] - p[i], p[i + 7] - p[i + 1], p[i + 8] - p[i + 2]];
    a += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  }
  return a;
}

const spec = (s: Partial<DecalSpec>): DecalSpec => ({ text: "A", at: [0, 0, 0], dir: [0, 0, 1], up: [0, 1, 0], width: 10, height: 6, depth: 5, color: "#000", ...s });

describe("laying a decal on a mesh", () => {
  it("covers its box on the face it faces, and nothing behind or beside", () => {
    // a plate 2 mm thick: the box reaches through it, but only the top faces the decal
    const plate = boxMesh(40, 30, 2, [0, 0, 1]);
    const m = projectDecal(plate, decalBox(spec({ at: [0, 0, 2], depth: 10 }), 6), 0.05);
    expect(area(m.position)).toBeCloseTo(60, 6);
    for (let i = 0; i < m.position.length; i += 3) {
      expect(m.position[i + 2]).toBeCloseTo(2.05, 5);
      expect(Math.abs(m.position[i])).toBeLessThanOrEqual(5 + 1e-6);
      expect(Math.abs(m.position[i + 1])).toBeLessThanOrEqual(3 + 1e-6);
      expect(m.normal[i + 2]).toBeCloseTo(1, 6);
    }
    // uv runs 0..1 left to right and bottom to top: the corner at (-5, -3) is (0, 0), (5, 3) is (1, 1)
    const uv = Array.from(m.uv);
    expect(Math.min(...uv)).toBeCloseTo(0, 6);
    expect(Math.max(...uv)).toBeCloseTo(1, 6);
    for (let i = 0, k = 0; i < m.position.length; i += 3, k += 2) {
      expect(m.uv[k]).toBeCloseTo((m.position[i] + 5) / 10, 5);
      expect(m.uv[k + 1]).toBeCloseTo((m.position[i + 1] + 3) / 6, 5);
    }
    // the decal's triangles face out, like the face under them
    for (let i = 0; i < m.position.length; i += 9) {
      const u = [m.position[i + 3] - m.position[i], m.position[i + 4] - m.position[i + 1]];
      const v = [m.position[i + 6] - m.position[i], m.position[i + 7] - m.position[i + 1]];
      expect(u[0] * v[1] - u[1] * v[0]).toBeGreaterThan(0);
    }
    // half off the edge: only the half on the plate
    expect(area(projectDecal(plate, decalBox(spec({ at: [20, 0, 2] }), 6)).position)).toBeCloseTo(30, 6);
    // facing the plate's side, it is on the side only
    const side = projectDecal(plate, decalBox(spec({ at: [0, -15, 1], dir: [0, -1, 0], up: [0, 0, 1], height: 2, depth: 3 }), 2));
    expect(area(side.position)).toBeCloseTo(20, 6);
    for (let i = 1; i < side.position.length; i += 3) expect(side.position[i]).toBeCloseTo(-15.05, 5);
    // turned by up:, across follows
    const turned = projectDecal(plate, decalBox(spec({ at: [0, 0, 2], up: [-1, 0, 0] }), 6));
    for (let i = 0; i < turned.position.length; i += 3) {
      expect(Math.abs(turned.position[i])).toBeLessThanOrEqual(3 + 1e-6);
      expect(Math.abs(turned.position[i + 1])).toBeLessThanOrEqual(5 + 1e-6);
    }
  });

  it("wraps round a curved face", () => {
    // a cylinder r 10 along Z; the decal faces +X, 12 wide
    const g = new THREE.CylinderGeometry(10, 10, 30, 96, 1, true).rotateX(Math.PI / 2).toNonIndexed();
    const cyl = { position: g.getAttribute("position").array, normal: g.getAttribute("normal").array };
    const m = projectDecal(cyl, decalBox(spec({ at: [10, 0, 0], dir: [1, 0, 0], up: [0, 0, 1], width: 12, height: 8, depth: 6 }), 8), 0);
    // laid on the curve it covers more than its flat 12 × 8: an arc of 2 asin(0.6) × 10 wide
    expect(area(m.position)).toBeCloseTo(2 * Math.asin(0.6) * 10 * 8, 0);
    for (let i = 0; i < m.position.length; i += 3) expect(Math.hypot(m.position[i], m.position[i + 1])).toBeCloseTo(10, 1);
  });
});

describe("decorators together", () => {
  const fake = (name: string, ready = true, hides: string[] = []) => {
    const log: string[] = [];
    const d: Decorator & { log: string[] } = {
      log,
      key: () => name,
      make: (): PartDecoration | null => {
        if (!ready) return null;
        const o = new THREE.Group();
        o.name = name;
        return { object: o, hides, dispose: () => log.push(`dispose ${name}`) };
      },
    };
    return d;
  };
  const part = { id: "p" } as never;

  it("draws every decorator's detail on a part, or waits for all of them", () => {
    const a = fake("board", true, ["p.parts"]);
    const b = fake("decals");
    const both = new Decorators([a, b]).make(part)!;
    expect(both.object.children.map((c) => c.name)).toEqual(["board", "decals"]);
    expect(both.hides).toEqual(["p.parts"]);
    both.dispose();
    expect([...a.log, ...b.log]).toEqual(["dispose board", "dispose decals"]);
    expect(new Decorators([a, b]).key(part)).toBe("0|board||1|decals");
    // one not ready: none shown yet, and what was made is let go
    const c = fake("routing", false);
    const d = fake("decals");
    expect(new Decorators([d, c]).make(part)).toBeNull();
    expect(d.log).toEqual(["dispose decals"]);
  });
});
