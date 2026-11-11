// Bolts tightened before the loads (a preload). Each screw's shank is freed from the parts it passes through, as a
// clearance hole leaves it, while its head and the thread it holds by stay bonded; the free length between them is
// stretched by a prestress along its axis, which the solver tunes until the bolt carries the tension it is tightened
// to. The parts it clamps then press together under it, and the loads can open or slide them.

import { GRADES, gradeFrom, type Grade } from "../../library/fasteners";
import { parseThreadName } from "../../library/standards";
import type { V3 } from "./voxel";

/** A fastener's place and size, world frame. */
export interface BoltInfo {
  /** the top of its head, and the way the head faces (out of the joint) */
  headTop: V3;
  outward: V3;
  /** thread size, like "M5" */
  size: string;
  headD: number;
  /** from the head's top to where its shank starts, mm (the library's head height; a countersunk head's cone) */
  headH?: number;
  grade?: string;
}

export interface BoltGrid {
  n: V3;
  h: V3;
  origin: V3;
  owner: Int16Array;
  active: Uint8Array;
  fill: Float32Array;
}

export interface BoltPart {
  name: string;
  bolt?: BoltInfo;
  /** a nut, a threaded insert or a standoff: what a screw's thread holds in */
  threads?: "nut" | "insert";
  /** a metal part: a tapped thread in it takes a full tightening */
  metal: boolean;
  /** a fastener, nut, washer or insert (never one of the parts a bolt clamps) */
  joining?: boolean;
}

/** A bolt to tighten, by its part's name: to a tension in N, by a torque in N·mm, or (neither) as it usually is. */
export interface BoltWant {
  part: string;
  force?: number;
  torque?: number;
}

export interface Bolt {
  /** index of its part */
  part: number;
  /** its part's name, with "#2" for a second instance of the same block */
  label: string;
  size: string;
  grade?: Grade;
  /** into the joint, unit length */
  axis: V3;
  /** the cells of its free length, between the head and where the thread holds */
  grip: Int32Array;
  /** that length along its axis, mm */
  length: number;
  /** what its thread holds in (a part index), and whether that is soft (plastic, wood or an insert in them) */
  into: number;
  soft: boolean;
  /** the parts it clamps between its head and its thread, the one it holds in among them */
  clamps: number[];
  /** the tension it is tightened to, N, and how that was chosen */
  target: number;
  why: string;
  /** tensile stress area, mm², and proof load, N */
  area: number;
  proof: number;
  /** the prestress along its free length that gives target, MPa (tuned as the solver goes) */
  p: number;
}

export interface BoltLayout {
  bolts: Bolt[];
  /** cells of the parts the bolts pass through that touch a shank: they go, so each shank stands free in its hole */
  freed: Int32Array;
  warnings: string[];
}

/** How hard a screw is usually done up into plastic, wood or an insert in them, N·mm, by thread size. */
const SOFT_TORQUE: Record<string, number> = { "2": 120, "2.5": 200, "3": 300, "4": 600, "5": 1000, "6": 1500, "8": 3000 };
/** torque = K·F·d: the nut factor for dry or zinc-plated threads */
export const NUT_FACTOR = 0.2;
/** a full tightening into metal: this share of the proof load */
export const METAL_SHARE = 0.75;

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Tensile stress area, mm² (ISO 898-1). */
export function stressAreaOf(d: number, pitch: number): number {
  const d2 = d - 0.6495 * pitch;
  const d3 = d - 1.2269 * pitch;
  return (Math.PI / 4) * ((d2 + d3) / 2) ** 2;
}

/** The usual torque for a screw done up in plastic or an insert, N·mm. */
export function softTorque(d: number): number {
  return SOFT_TORQUE[String(d)] ?? 300 * (d / 3) ** 2.5;
}

/** The tension a bolt is tightened to, N, and how it was chosen. */
export function tighten(want: BoltWant, d: number, grade: Grade | undefined, proof: number, soft: boolean): { target: number; why: string } {
  const nm = (t: number) => `${+(t / 1000).toPrecision(2)} N·m`;
  if (want.force !== undefined) return { target: want.force, why: "as given" };
  if (want.torque !== undefined) return { target: want.torque / (NUT_FACTOR * d), why: `${nm(want.torque)} on its thread` };
  if (soft) {
    const t = softTorque(d);
    const f = t / (NUT_FACTOR * d);
    return proof > 0 && f > METAL_SHARE * proof ? { target: METAL_SHARE * proof, why: `${Math.round(METAL_SHARE * 100)} % of its proof load` } : { target: f, why: `done up to the usual ${nm(t)} for an ${d} mm screw in plastic` };
  }
  return { target: METAL_SHARE * proof, why: `${Math.round(METAL_SHARE * 100)} % of its proof load${grade ? ` (${grade})` : ""}` };
}

/**
 * Finds each bolt to tighten in the voxel grid: its head (the cells well outside its shank), its shank past the head,
 * the part its thread holds in (a nut or insert it reaches, or else the deepest part it goes into), and the free
 * length between them. The other parts' cells that share a node with the shank are freed, so it slides in its hole.
 */
export function boltLayout(g: BoltGrid, parts: BoltPart[], wants: BoltWant[]): BoltLayout {
  const [nx, ny, nz] = g.n;
  const [hx, hy, hz] = g.h;
  const warnings: string[] = [];
  const freed = new Set<number>();
  const bolts: Bolt[] = [];
  const byName = new Map<string, BoltWant>();
  for (const w of wants) byName.set(w.part, w);
  const cellsOf: number[][] = parts.map(() => []);
  for (let e = 0; e < g.active.length; e++) if (g.active[e] && g.owner[e] >= 0) cellsOf[g.owner[e]].push(e);
  const centre = (e: number): V3 => [g.origin[0] + ((e % nx) + 0.5) * hx, g.origin[1] + ((Math.floor(e / nx) % ny) + 0.5) * hy, g.origin[2] + (Math.floor(e / (nx * ny)) + 0.5) * hz];
  /** every active cell of another part that shares a node with cell e */
  const around = (e: number, self: number, f: (c: number, o: number) => void) => {
    const i = e % nx,
      j = Math.floor(e / nx) % ny,
      k = Math.floor(e / (nx * ny));
    for (let dk = -1; dk <= 1; dk++)
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const ii = i + di,
            jj = j + dj,
            kk = k + dk;
          if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz) continue;
          const c = ii + nx * (jj + ny * kk);
          const o = g.owner[c];
          if (g.active[c] && o >= 0 && o !== self) f(c, o);
        }
  };
  const seen = new Map<string, number>();
  parts.forEach((pt, pi) => {
    const want = byName.get(pt.name);
    if (!want) return;
    const k = (seen.get(pt.name) ?? 0) + 1;
    seen.set(pt.name, k);
    const label = k > 1 ? `${pt.name} #${k}` : pt.name;
    const b = pt.bolt;
    if (!b) {
      warnings.push(`preload: ${label} is not a screw or bolt, so there is nothing to tighten.`);
      return;
    }
    const th = parseThreadName(b.size);
    if (!th) {
      warnings.push(`preload: ${label} is a ${b.size} thread, which Kerf has no sizes for, so it is left as it is.`);
      return;
    }
    const d = th.d;
    const ol = Math.hypot(...b.outward) || 1;
    const axis: V3 = [-b.outward[0] / ol, -b.outward[1] / ol, -b.outward[2] / ol];
    /** a cell's length along the axis */
    const ha = Math.abs(axis[0]) * hx + Math.abs(axis[1]) * hy + Math.abs(axis[2]) * hz;
    const cells = cellsOf[pi];
    const tOf = new Float64Array(cells.length);
    // the head: from its top to where the shank starts (the library says how tall it is), or else down to the last
    // cell well outside the shank (half way to the head's rim)
    let seat = b.headH ?? -Infinity;
    const rHead = (d / 2 + Math.max(b.headD, 1.3 * d) / 2) / 2;
    cells.forEach((e, q) => {
      const v = sub(centre(e), b.headTop);
      const t = dot(v, axis);
      tOf[q] = t;
      if (b.headH === undefined && Math.hypot(v[0] - t * axis[0], v[1] - t * axis[1], v[2] - t * axis[2]) > rHead) seat = Math.max(seat, t + ha / 2);
    });
    if (!(seat > 0)) {
      warnings.push(`preload: ${label} has no head to tighten against${b.headH === undefined ? " at this element size" : ""} (a set screw, or too few elements across it), so it is left as it is.`);
      return;
    }
    const isHead = new Uint8Array(cells.length);
    cells.forEach((_, q) => {
      if (tOf[q] < seat) isHead[q] = 1;
    });
    // the head must bear on something: what it touches stays, so it has that to bear on
    const bearing = new Set<number>();
    const under = new Set<number>();
    cells.forEach((e, q) => {
      if (isHead[q])
        around(e, pi, (c, o) => {
          bearing.add(c);
          under.add(o);
        });
    });
    if (!bearing.size) {
      warnings.push(`preload: ${label}'s head does not bear on any analysed part, so there is nothing for it to clamp; it is left as it is.`);
      return;
    }
    const shank: number[] = [];
    const shankT: number[] = [];
    cells.forEach((e, q) => {
      if (!isHead[q]) {
        shank.push(e);
        shankT.push(tOf[q]);
      }
    });
    // what the shank touches, from how near the head to how deep
    const first = new Map<number, number>();
    const last = new Map<number, number>();
    shank.forEach((e, q) =>
      around(e, pi, (_, o) => {
        first.set(o, Math.min(first.get(o) ?? Infinity, shankT[q]));
        last.set(o, Math.max(last.get(o) ?? -Infinity, shankT[q]));
      }),
    );
    if (!last.size) {
      warnings.push(`preload: ${label}'s shank goes into no analysed part, so it holds nothing to tighten against; it is left as it is.`);
      return;
    }
    // its thread holds in a nut or insert it reaches, or else in the deepest part it goes into
    let engaged = [...last.keys()].filter((o) => parts[o].threads);
    if (!engaged.length) {
      let best = -1,
        bt = -Infinity;
      for (const [o, t] of last)
        if (!parts[o].joining && t > bt) {
          bt = t;
          best = o;
        }
      if (best < 0) for (const [o, t] of last) if (t > bt) [bt, best] = [t, o];
      engaged = [best];
    }
    const eng = new Set(engaged);
    const tEng = Math.min(...engaged.map((o) => first.get(o)!));
    // free the shank from every other part it passes through (but what the head bears on); it clamps those, what
    // the head bears on (through a hole too wide for the shank to touch) and what it holds in
    const clamps = new Set<number>(engaged);
    for (const o of under) if (!parts[o].joining) clamps.add(o);
    const mine = new Set<number>();
    for (const e of shank)
      around(e, pi, (c, o) => {
        if (eng.has(o) || bearing.has(c)) return;
        mine.add(c);
        if (!parts[o].joining) clamps.add(o);
      });
    // The free length: the whole shank between the last of it that still touches what the head bears on and the
    // first of it that the thread holds in. It must be whole slices of the shank: a prestress in part of a slice only
    // pulls against the rest of it.
    let tTop = -Infinity;
    shank.forEach((e, q) => {
      if (shankT[q] < tEng) around(e, pi, (c) => !mine.has(c) && (tTop = Math.max(tTop, shankT[q])));
    });
    const grip: number[] = [];
    let t0 = Infinity,
      t1 = -Infinity;
    shank.forEach((e, q) => {
      if (shankT[q] <= tTop || shankT[q] >= tEng) return;
      grip.push(e);
      t0 = Math.min(t0, shankT[q]);
      t1 = Math.max(t1, shankT[q]);
    });
    const into = engaged[0];
    if (!grip.length) {
      warnings.push(`preload: ${label} has no free length between its head and where it holds in ${parts[into].name} at this element size, so it is left as it is; a finer resolution: lets it stretch.`);
      return;
    }
    for (const c of mine) freed.add(c);
    const soft = parts[into].threads === "insert" || (!parts[into].threads && !parts[into].metal);
    const grade = gradeFrom(b.grade);
    const area = stressAreaOf(d, th.pitch);
    const proof = area * GRADES[grade ?? "8.8"].proof;
    const { target, why } = tighten(want, d, grade, proof, soft);
    if (!(target > 0)) {
      warnings.push(`preload: ${label} is tightened to nothing, so it is left as it is.`);
      return;
    }
    const length = t1 - t0 + ha;
    let vol = 0;
    for (const e of grip) vol += g.fill[e] * hx * hy * hz;
    bolts.push({
      part: pi,
      label,
      size: th.name,
      ...(grade ? { grade } : {}),
      axis,
      grip: Int32Array.from(grip),
      length,
      into,
      soft,
      clamps: [...clamps],
      target,
      why: grade ? why : `${why}, taken as steel 8.8`,
      area,
      proof,
      // a first guess: the joint as stiff as the bolt halves what the prestress makes
      p: (2 * target) / Math.max(vol / length, 1e-9),
    });
  });
  // a part the clearance round its bolts takes much of
  const lost = new Map<number, number>();
  for (const e of freed) lost.set(g.owner[e], (lost.get(g.owner[e]) ?? 0) + 1);
  for (const [o, n] of lost)
    if (n > 0.25 * cellsOf[o].length)
      warnings.push(`preload: freeing the bolts in their holes takes ${Math.round((100 * n) / cellsOf[o].length)} % of ${parts[o].name}'s elements, so it is weaker here than it is; a finer resolution: keeps more of it.`);
  return { bolts, freed: Int32Array.from(freed), warnings };
}

/** The prestress a bolt's free length carries, as a stress (Voigt xx, yy, zz, xy, yz, zx): p·(a⊗a). */
export function boltStress(b: Bolt, out: Float64Array): Float64Array {
  const [a0, a1, a2] = b.axis;
  out[0] = b.p * a0 * a0;
  out[1] = b.p * a1 * a1;
  out[2] = b.p * a2 * a2;
  out[3] = b.p * a0 * a1;
  out[4] = b.p * a1 * a2;
  out[5] = b.p * a2 * a0;
  return out;
}
