// Files of the shape a topology optimisation found: an STL of the shape (to print, or to model over), and for a shape
// cut from plate a 1:1 DXF of its profile for a laser, waterjet or router.

import type { StructuralResult } from "./fe/structural";

/** Binary STL of the shape found, in millimetres, every analysed part's share of it together. */
export function shapeStl(r: StructuralResult, header = "Kerf topology optimisation"): ArrayBuffer {
  let tris = 0;
  for (const p of r.parts) tris += p.indices.length / 3;
  const buf = new ArrayBuffer(84 + tris * 50);
  const dv = new DataView(buf);
  new Uint8Array(buf, 0, 80).set(new TextEncoder().encode(header.slice(0, 79)));
  dv.setUint32(80, tris, true);
  let o = 84;
  for (const p of r.parts) {
    const P = p.positions,
      I = p.indices;
    for (let t = 0; t < I.length; t += 3) {
      const a = 3 * I[t],
        b = 3 * I[t + 1],
        c = 3 * I[t + 2];
      const ux = P[b] - P[a],
        uy = P[b + 1] - P[a + 1],
        uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a],
        vy = P[c + 1] - P[a + 1],
        vz = P[c + 2] - P[a + 2];
      let nx = uy * vz - uz * vy,
        ny = uz * vx - ux * vz,
        nz = ux * vy - uy * vx;
      const L = Math.hypot(nx, ny, nz) || 1;
      nx /= L;
      ny /= L;
      nz /= L;
      for (const v of [nx, ny, nz, P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2]]) {
        dv.setFloat32(o, v, true);
        o += 4;
      }
      dv.setUint16(o, 0, true);
      o += 2;
    }
  }
  return buf;
}

const num = (v: number) => (Math.round(v * 1e4) / 1e4).toString();

/** A 1:1 DXF (R12, millimetres) of the profile of a shape cut from plate: every outline as closed lines on layer CUT. */
export function outlineDxf(r: StructuralResult): string | null {
  const o = r.topology?.outline;
  if (!o?.loops.length) return null;
  const out: string[] = [];
  const w = (code: number, v: string | number) => out.push(String(code), typeof v === "number" ? num(v) : v);
  w(0, "SECTION");
  w(2, "HEADER");
  w(9, "$ACADVER");
  w(1, "AC1009");
  w(9, "$INSUNITS");
  w(70, 4);
  w(0, "ENDSEC");
  w(0, "SECTION");
  w(2, "TABLES");
  w(0, "TABLE");
  w(2, "LAYER");
  w(70, 2);
  for (const [name, color] of [
    ["CUT", 7],
    ["NOTES", 3],
  ] as const) {
    w(0, "LAYER");
    w(2, name);
    w(70, 0);
    w(62, color);
    w(6, "CONTINUOUS");
  }
  w(0, "ENDTAB");
  w(0, "ENDSEC");
  w(0, "SECTION");
  w(2, "ENTITIES");
  let lo = Infinity;
  let left = Infinity;
  for (const l of o.loops)
    for (let i = 0; i < l.points.length; i++) {
      const [x1, y1] = l.points[i];
      const [x2, y2] = l.points[(i + 1) % l.points.length];
      lo = Math.min(lo, y1);
      left = Math.min(left, x1);
      w(0, "LINE");
      w(8, "CUT");
      w(10, x1);
      w(20, y1);
      w(11, x2);
      w(21, y2);
    }
  w(0, "TEXT");
  w(8, "NOTES");
  w(10, left);
  w(20, lo - 6);
  w(40, 3);
  w(1, `${r.label.toUpperCase()}: ${num(o.to - o.from)} MM PLATE, ${o.plane.join("")} PLANE`);
  w(0, "ENDSEC");
  w(0, "EOF");
  return out.join("\n");
}

/** A file name from an analysis label. */
export const fileStem = (label: string) => label.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "shape";
