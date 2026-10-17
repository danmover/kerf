// A small mesh builder for the wiring overlay: boxes, cylinders and tubes
// with per-vertex colours, written straight into one buffer per mesh so a
// whole cable or plug is a single draw.

import * as THREE from "three";
import type { V3 } from "../../../kernel/recipe";
import type { Frame } from "../../../machine/harness/harness";

export class MeshBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private col: number[] = [];
  private idx: number[] = [];
  /** extra per-vertex value (a cable's position along its length, 0 to 1) */
  private span: number[] = [];
  private c = new THREE.Color();

  get vertexCount() {
    return this.pos.length / 3;
  }

  private vert(p: V3, n: V3, color: THREE.Color, span = 0) {
    this.pos.push(p[0], p[1], p[2]);
    this.nor.push(n[0], n[1], n[2]);
    this.col.push(color.r, color.g, color.b);
    this.span.push(span);
    return this.pos.length / 3 - 1;
  }

  /** A box between two corners, in a frame (x, y, z axes of the frame). */
  box(f: Frame, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color: string | number) {
    const c = this.c.set(color);
    const P = (x: number, y: number, z: number): V3 => at(f, x, y, z);
    const faces: [V3, [number, number, number][]][] = [
      [f.x, [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]],
      [neg(f.x), [[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]]],
      [f.y, [[x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]]],
      [neg(f.y), [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]],
      [f.z, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]],
      [neg(f.z), [[x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]]],
    ];
    for (const [n, q] of faces) {
      const a = this.vert(P(...q[0]), n, c);
      const b = this.vert(P(...q[1]), n, c);
      const d = this.vert(P(...q[2]), n, c);
      const e = this.vert(P(...q[3]), n, c);
      this.idx.push(a, b, d, a, d, e);
    }
  }

  /** A cylinder along the frame's z (or y when `axis` is "y"), centred at (cx, cy) in the other two axes. */
  cyl(f: Frame, cx: number, cy: number, z0: number, z1: number, r: number, color: string | number, seg = 12, axis: "z" | "y" = "z", r1 = r) {
    const c = this.c.set(color);
    const u = axis === "z" ? f.x : f.z;
    const v = axis === "z" ? f.y : f.x;
    const w = axis === "z" ? f.z : f.y;
    // along y the cylinder is centred at x = cx, z = cy
    const base = (along: number): V3 => (axis === "z" ? at(f, cx, cy, along) : at(f, cx, along, cy));
    const ring = (along: number, rad: number) => {
      const o = base(along);
      const out: { p: V3; n: V3 }[] = [];
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        const n: V3 = [u[0] * Math.cos(a) + v[0] * Math.sin(a), u[1] * Math.cos(a) + v[1] * Math.sin(a), u[2] * Math.cos(a) + v[2] * Math.sin(a)];
        out.push({ p: [o[0] + n[0] * rad, o[1] + n[1] * rad, o[2] + n[2] * rad], n });
      }
      return out;
    };
    const lo = ring(z0, r);
    const hi = ring(z1, r1);
    const s = lo.map((q) => this.vert(q.p, q.n, c));
    const t = hi.map((q) => this.vert(q.p, q.n, c));
    for (let i = 0; i < seg; i++) this.idx.push(s[i], s[i + 1], t[i + 1], s[i], t[i + 1], t[i]);
    // end caps
    for (const [rg, along, n] of [
      [lo, z0, neg(w)],
      [hi, z1, w],
    ] as const) {
      const centre = this.vert(base(along), n, c);
      const rim = rg.map((q) => this.vert(q.p, n, c));
      for (let i = 0; i < seg; i++) n === w ? this.idx.push(centre, rim[i], rim[i + 1]) : this.idx.push(centre, rim[i + 1], rim[i]);
    }
  }

  /** A sphere squashed along the frame's z. */
  blob(f: Frame, cx: number, cy: number, cz: number, r: number, squash: number, color: string | number) {
    const c = this.c.set(color);
    const rows = 6;
    const seg = 10;
    const grid: number[][] = [];
    for (let i = 0; i <= rows; i++) {
      const th = (i / rows) * Math.PI;
      const line: number[] = [];
      for (let j = 0; j <= seg; j++) {
        const ph = (j / seg) * Math.PI * 2;
        const lx = Math.sin(th) * Math.cos(ph);
        const ly = Math.sin(th) * Math.sin(ph);
        const lz = Math.cos(th);
        const p = at(f, cx + lx * r, cy + ly * r, cz + lz * r * squash);
        const n = norm(lin(f, lx, ly, lz / Math.max(0.2, squash)));
        line.push(this.vert(p, n, c));
      }
      grid.push(line);
    }
    for (let i = 0; i < rows; i++) for (let j = 0; j < seg; j++) this.idx.push(grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j], grid[i + 1][j + 1], grid[i][j + 1]);
  }

  /**
   * A tube along points with a frame per point (normal and binormal), radius r.
   * `span` gives each ring's place along the cable for the explode stretch.
   */
  tube(pts: V3[], nrm: V3[], bin: V3[], r: number, color: string | number, seg: number, span: number[]) {
    const c = this.c.set(color);
    const rings: number[][] = [];
    for (let i = 0; i < pts.length; i++) {
      const line: number[] = [];
      for (let j = 0; j <= seg; j++) {
        const a = (j / seg) * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const n: V3 = [nrm[i][0] * ca + bin[i][0] * sa, nrm[i][1] * ca + bin[i][1] * sa, nrm[i][2] * ca + bin[i][2] * sa];
        line.push(this.vert([pts[i][0] + n[0] * r, pts[i][1] + n[1] * r, pts[i][2] + n[2] * r], n, c, span[i]));
      }
      rings.push(line);
    }
    // bin = tangent × nrm, so this winding faces outward
    for (let i = 0; i < rings.length - 1; i++) for (let j = 0; j < seg; j++) this.idx.push(rings[i][j], rings[i + 1][j + 1], rings[i + 1][j], rings[i][j], rings[i][j + 1], rings[i + 1][j + 1]);
    // ends: a flat cap is enough at this size
    for (const [i, sign] of [
      [0, -1],
      [pts.length - 1, 1],
    ] as const) {
      const t = tangent(pts, i);
      const n: V3 = [t[0] * sign, t[1] * sign, t[2] * sign];
      const centre = this.vert(pts[i], n, c, span[i]);
      const rim = rings[i].map((k) => this.vert([this.pos[3 * k], this.pos[3 * k + 1], this.pos[3 * k + 2]], n, c, span[i]));
      for (let j = 0; j < seg; j++) sign > 0 ? this.idx.push(centre, rim[j], rim[j + 1]) : this.idx.push(centre, rim[j + 1], rim[j]);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute("span", new THREE.Float32BufferAttribute(this.span, 1));
    g.setIndex(this.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

export function at(f: Frame, x: number, y: number, z: number): V3 {
  return [f.o[0] + f.x[0] * x + f.y[0] * y + f.z[0] * z, f.o[1] + f.x[1] * x + f.y[1] * y + f.z[1] * z, f.o[2] + f.x[2] * x + f.y[2] * y + f.z[2] * z];
}

function lin(f: Frame, x: number, y: number, z: number): V3 {
  return [f.x[0] * x + f.y[0] * y + f.z[0] * z, f.x[1] * x + f.y[1] * y + f.z[1] * z, f.x[2] * x + f.y[2] * y + f.z[2] * z];
}

const neg = (v: V3): V3 => [-v[0], -v[1], -v[2]];

export function norm(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function tangent(pts: V3[], i: number): V3 {
  const a = pts[Math.max(0, i - 1)];
  const b = pts[Math.min(pts.length - 1, i + 1)];
  return norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
}
