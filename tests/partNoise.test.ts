// The noise a part's finish is made of. Its random values are read from a small block of them (a 3D texture) where
// the shader used to work each one out with a hash: 8 hashes a call and some 26 calls were two thirds of the time
// Direct3D's compiler took over the parts' shader (1.3 s of 1.9 s on an RX 7800 XT, bench/shadercost.cjs).

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { NOISE_N, NOISE_TEX, noiseHash, noiseValues, partUniforms, patchPartMaterial } from "../src/ui/viewport/render/partShader";

const N = NOISE_N;
const data = noiseValues();
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => t * t * (3 - 2 * t);
/** the four values a read of the block gives: texelFetch(tNoise, ivec3(x, y, z), 0), as numbers 0 to 1 */
const fetch = (x: number, y: number, z: number) => [0, 1, 2, 3].map((k) => data[((z * N + y) * N + x) * 4 + k] / 255);
/** a whole number's low bits, as `& (N - 1)` gives them for negative ones too */
const low = (v: number) => v & (N - 1);

/** kNoiseG as the shader has it, read from the block: [value, d/dx, d/dy] */
function noiseG(x: number, y: number, z: number): [number, number, number] {
  const fl = [Math.floor(x), Math.floor(y), Math.floor(z)];
  const f = [x - fl[0], y - fl[1], z - fl[2]];
  const u = f.map(smooth);
  const du = f.map((t) => 6 * t * (1 - t));
  const i = fl.map(low);
  const a = fetch(i[0], i[1], i[2]);
  const b = fetch(i[0], i[1], low(i[2] + 1));
  const c = a.map((v, k) => mix(v, b[k], u[2]));
  const d = [mix(c[0], c[1], u[0]), mix(c[2], c[3], u[0])];
  const sx = mix(c[1] - c[0], c[3] - c[2], u[1]);
  const sy = d[1] - d[0];
  return [mix(d[0], d[1], u[1]), sx * du[0], sy * du[1]];
}
const noise = (x: number, y: number, z: number) => noiseG(x, y, z)[0];

/** the noise as it was: every corner's value worked out with the hash */
function hashed(x: number, y: number, z: number): number {
  const i = [Math.floor(x), Math.floor(y), Math.floor(z)];
  const u = [x - i[0], y - i[1], z - i[2]].map(smooth);
  const h = (dx: number, dy: number, dz: number) => noiseHash(i[0] + dx, i[1] + dy, i[2] + dz);
  const lo = mix(mix(h(0, 0, 0), h(1, 0, 0), u[0]), mix(h(0, 1, 0), h(1, 1, 0), u[0]), u[1]);
  const hi = mix(mix(h(0, 0, 1), h(1, 0, 1), u[0]), mix(h(0, 1, 1), h(1, 1, 1), u[0]), u[1]);
  return mix(lo, hi, u[2]);
}

/** a few hundred points, the same every run */
function points(n: number, from: number, to: number): [number, number, number][] {
  let s = 12345;
  const next = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff), s / 0x7fffffff);
  return Array.from({ length: n }, () => [mix(from, to, next()), mix(from, to, next()), mix(from, to, next())]);
}

describe("the block of values the finishes' noise is read from", () => {
  it("holds, for every cell, the values at four of its corners, wrapping round at its sides", () => {
    expect(data.length).toBe(N * N * N * 4);
    for (const [x, y, z] of [
      [0, 0, 0],
      [5, 9, 2],
      [N - 1, 3, 7],
      [4, N - 1, N - 1],
      [N - 1, N - 1, 31],
    ]) {
      const v = (a: number, b: number) => Math.round(noiseHash(low(a), low(b), z) * 255) / 255;
      expect(fetch(x, y, z)).toEqual([v(x, y), v(x + 1, y), v(x, y + 1), v(x + 1, y + 1)]);
    }
  });

  it("has values spread over the whole range, as the hash's are", () => {
    let sum = 0;
    const tenths = new Array<number>(10).fill(0);
    for (let k = 0; k < data.length; k += 4) {
      sum += data[k];
      tenths[Math.min(9, Math.floor(data[k] / 25.6))]++;
    }
    const cells = N * N * N;
    expect(sum / cells / 255).toBeGreaterThan(0.47);
    expect(sum / cells / 255).toBeLessThan(0.53);
    for (const t of tenths) expect(t / cells).toBeGreaterThan(0.07);
  });

  it("is one texture for all parts, read cell by cell", () => {
    const a = partUniforms();
    const b = partUniforms();
    expect(a.tNoise).toBe(NOISE_TEX);
    expect(b.tNoise.value).toBe(a.tNoise.value);
    const t = a.tNoise.value!;
    expect(t).toBeInstanceOf(THREE.Data3DTexture);
    expect([t.image.width, t.image.height, t.image.depth]).toEqual([N, N, N]);
    expect([t.format, t.type, t.minFilter, t.magFilter]).toEqual([THREE.RGBAFormat, THREE.UnsignedByteType, THREE.NearestFilter, THREE.NearestFilter]);
  });
});

describe("the finishes' noise, read from the block", () => {
  it("is the noise it was, to the block's 1 part in 255, within the block's first round", () => {
    for (const [x, y, z] of points(400, 0, N - 1)) expect(Math.abs(noise(x, y, z) - hashed(x, y, z))).toBeLessThan(0.5 / 255 + 1e-9);
  });

  it("comes round again every block, with no seam where it does or at nought", () => {
    for (const [x, y, z] of points(100, -200, 200)) {
      expect(noise(x + N, y, z)).toBeCloseTo(noise(x, y, z), 12);
      expect(noise(x, y - 3 * N, z + 2 * N)).toBeCloseTo(noise(x, y, z), 12);
    }
    for (const at of [0, N, -N, 5 * N]) for (const [, y, z] of points(40, -70, 70)) expect(Math.abs(noise(at - 1e-7, y, z) - noise(at + 1e-7, y, z))).toBeLessThan(1e-6);
  });

  it("gives its slope along with its value", () => {
    const h = 1e-5;
    for (const [x, y, z] of points(200, -90, 90)) {
      const [v, sx, sy] = noiseG(x, y, z);
      // (not across a corner of the grid, where the slope turns)
      if (Math.floor(x - h) !== Math.floor(x + h) || Math.floor(y - h) !== Math.floor(y + h)) continue;
      expect(v).toBeCloseTo(noise(x, y, z), 12);
      expect(sx).toBeCloseTo((noise(x + h, y, z) - noise(x - h, y, z)) / (2 * h), 4);
      expect(sy).toBeCloseTo((noise(x, y + h, z) - noise(x, y - h, z)) / (2 * h), 4);
    }
  });
});

describe("the noise in the parts' shader", () => {
  const mat = new THREE.MeshPhysicalMaterial();
  patchPartMaterial(mat, partUniforms());
  const shader = { uniforms: {} as Record<string, THREE.IUniform>, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
  mat.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, undefined as unknown as THREE.WebGLRenderer);
  const f = shader.fragmentShader;
  const body = (name: string) => {
    const at = f.search(new RegExp(`\\b(float|vec3) ${name}\\(vec3 x\\) \\{`));
    return f.slice(at, f.indexOf("\n}", at));
  };

  it("reads a point's eight corners in two reads and works no value out", () => {
    for (const name of ["kNoise", "kNoiseG"]) {
      expect(body(name).match(/texelFetch\(tNoise,/g)?.length, name).toBe(2);
      expect(body(name), name).not.toContain("kHash");
      expect(body(name), name).toContain(`& ${N - 1}`);
    }
    expect(f).toContain("uniform highp sampler3D tNoise;");
  });

  it("has the slope's lines as the test above works them out", () => {
    const g = body("kNoiseG").replace(/\s+/g, " ");
    expect(g).toContain("vec4 c = mix(texelFetch(tNoise, i, 0), texelFetch(tNoise, ivec3(i.xy, (i.z + 1) & 63), 0), u.z);");
    expect(g).toContain("vec2 d = mix(c.xz, c.yw, u.x);");
    expect(g).toContain("float sx = mix(c.y - c.x, c.w - c.z, u.y);");
    expect(g).toContain("float sy = d.y - d.x;");
    expect(g).toContain("return vec3(mix(d.x, d.y, u.y), sx * du.x, sy * du.y);");
  });

  it("is given the block", () => {
    expect(shader.uniforms.tNoise).toBe(NOISE_TEX);
  });

  it("reads with texelFetch only: a read that picks its own level may not be asked for inside a branch", () => {
    expect(body("kNoise")).not.toMatch(/\btexture(2D|Lod|3D)?\s*\(/);
    expect(body("kNoiseG")).not.toMatch(/\btexture(2D|Lod|3D)?\s*\(/);
  });
});
