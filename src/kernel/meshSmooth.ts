// Faceted solids made from meshes: shaded smooth where neighbouring faces meet
// at a shallow angle, without the lines between such faces, so a scanned or
// sculpted model looks like itself rather than a net of triangles. Sharp edges
// keep their lines and their crisp shading. Display only: the solid is unchanged.

import type { MeshData } from "./build";

const key = (P: ArrayLike<number>, i: number) => `${Math.round(P[i * 3] * 1e4)},${Math.round(P[i * 3 + 1] * 1e4)},${Math.round(P[i * 3 + 2] * 1e4)}`;

/** Smooth a faceted body's display mesh: faces within `angle` degrees of each other share normals and lose the line between them. */
export function smoothFaceted(m: MeshData, angle = 30): MeshData {
  const P = m.positions;
  const N = m.normals;
  const I = m.indices;
  const nV = P.length / 3;
  if (!nV || N.length !== P.length) return m;
  const cos = Math.cos((angle * Math.PI) / 180);
  const dotN = (a: number, b: number) => N[a * 3] * N[b * 3] + N[a * 3 + 1] * N[b * 3 + 1] + N[a * 3 + 2] * N[b * 3 + 2];

  // each corner is a vertex per face that meets there: average the normals of the faces that meet gently
  const at = new Map<string, number[]>();
  const keys: string[] = new Array(nV);
  for (let i = 0; i < nV; i++) {
    const k = (keys[i] = key(P, i));
    const l = at.get(k);
    if (l) l.push(i);
    else at.set(k, [i]);
  }
  const normals = new Float32Array(N.length);
  for (const list of at.values()) {
    for (const v of list) {
      let x = 0,
        y = 0,
        z = 0;
      for (const w of list) {
        if (w !== v && dotN(v, w) < cos) continue;
        x += N[w * 3];
        y += N[w * 3 + 1];
        z += N[w * 3 + 2];
      }
      const l = Math.hypot(x, y, z) || 1;
      normals[v * 3] = x / l;
      normals[v * 3 + 1] = y / l;
      normals[v * 3 + 2] = z / l;
    }
  }

  const E = m.edges;
  const G = m.edgeGroups;
  if (!G || !E.length) return { ...m, normals };
  // the faces on each side of every triangle edge, by the corners' positions
  const sides = new Map<string, number[]>();
  for (let t = 0; t + 2 < I.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = I[t + k],
        b = I[t + ((k + 1) % 3)];
      const ka = keys[a],
        kb = keys[b];
      const e = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const l = sides.get(e);
      if (l) l.push(a);
      else sides.set(e, [a]);
    }
  const lines: number[] = [];
  const groups: number[] = [];
  for (let g = 0; g + 2 < G.length; g += 3) {
    const start = G[g],
      count = G[g + 1];
    let sharp = false;
    for (let k = start; k + 1 < start + count && !sharp; k += 2) {
      const ka = key(E, k),
        kb = key(E, k + 1);
      const s = sides.get(ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`);
      // an edge the faces do not share in pairs, or where they fold, keeps its line
      sharp = !s || s.length !== 2 || dotN(s[0], s[1]) < cos;
    }
    if (!sharp) continue;
    groups.push(lines.length / 3, count, G[g + 2]);
    for (let k = start * 3; k < (start + count) * 3; k++) lines.push(E[k]);
  }
  return { ...m, normals, edges: Float32Array.from(lines), edgeGroups: Int32Array.from(groups) };
}
