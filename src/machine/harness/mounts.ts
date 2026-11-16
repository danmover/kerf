// Whether each electronics module is actually held, from the geometry:
// screws through its mounting holes that bite into something (a boss, an
// insert, a standoff, a nut), pegs through them, or parts that close it in
// on all six sides (a pocket with a lid, a slot with an end stop, clips over
// its edges). Anything else rests or floats and comes loose the first time
// the machine moves. A design can say how a part is held where the geometry
// cannot show it (held: "double-sided foam tape", "hook-and-loop strap").
// Runs in the cable worker, with the same solids as the wiring checks.

import type { V3 } from "../../kernel/recipe";
import { transform, transformDir, type Skip, type SolidItem, type Solids } from "./solids";

/** One module to check, in its own frame: a board (its slab, holes through it) or a box. */
export interface MountSpec {
  /** component instance name, with [i] for patterns */
  comp: string;
  /** its main solid's id: every solid of the instance has this as its comp */
  partId: string;
  label: string;
  /** placement of the main solid, column-major */
  m: number[];
  /** the body in its own frame: a board's slab, or a box's extent */
  body: [V3, V3];
  /** a flat board: its holes go through the slab along its z */
  board: boolean;
  /** mounting holes in the body's own frame (x, y), with their diameters */
  holes: { x: number; y: number; d: number }[];
  /** how the design says it is held, when the geometry cannot show it */
  held?: string;
}

/** A screw as placed: its seat (under the head), shank direction, length and thread size. */
export interface ScrewSpec {
  id: string;
  seat: V3;
  axis: V3;
  length: number;
  d: number;
}

export type MountVerdict =
  /** screws through two or more holes, biting into something */
  | "screwed"
  /** closed in on every side by the parts round it */
  | "held"
  /** held as the design says (tape, a strap): the geometry cannot show it */
  | "declared"
  /** one screw only: it can swing round it */
  | "one-screw"
  /** sits on standoffs or bosses under its holes, but no screws are modelled */
  | "no-screws"
  /** touches parts but can come away in some direction */
  | "loose"
  /** touches nothing */
  | "floating";

export type Dir = "+x" | "-x" | "+y" | "-y" | "+z" | "-z";
export const DIRS: Dir[] = ["+x", "-x", "+y", "-y", "+z", "-z"];
const LOCAL: Record<Dir, V3> = { "+x": [1, 0, 0], "-x": [-1, 0, 0], "+y": [0, 1, 0], "-y": [0, -1, 0], "+z": [0, 0, 1], "-z": [0, 0, -1] };

export interface MountResult {
  comp: string;
  partId: string;
  verdict: MountVerdict;
  holes: number;
  screwed: string[];
  pegged: number;
  /** holes with a boss or standoff under them but no screw */
  bosses: number;
  /** the ways (in the assembly) it can come away: unit directions, with the module's own name for each */
  free: { dir: V3; local: Dir }[];
  /** the parts it rests against or is held by */
  touches: string[];
  held?: string;
}

/** A part this close counts as touching, mm: printed slots and pockets leave a few tenths each side. */
const GAP = 0.9;

/** Check every module. `screws` are all the screws in the design. */
export function checkMounts(specs: MountSpec[], screws: ScrewSpec[], solids: Solids): MountResult[] {
  return specs.map((s) => checkOne(s, screws, solids));
}

function checkOne(s: MountSpec, screws: ScrewSpec[], solids: Solids): MountResult {
  // what can hold it: made parts, fasteners and other bought parts, never its own solids or another module
  const others: Skip = (it: SolidItem) => it.comp === s.partId || it.role === "mount";
  const [lo, hi] = s.body;
  const W = (x: number, y: number, z: number) => transform(s.m, x, y, z);
  const D = (d: V3) => {
    const v = transformDir(s.m, d[0], d[1], d[2]);
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l] as V3;
  };
  const n = D([0, 0, 1]);
  const t = hi[2] - lo[2];
  const touches = new Set<string>();
  const screwed: string[] = [];
  let pegged = 0;
  let bosses = 0;

  for (const hole of s.holes) {
    // the hole's middle, inside the board or a little way up into a box's tapped hole
    const zc = s.board ? lo[2] + t / 2 : lo[2] + Math.min(2, t / 2);
    const c = W(hole.x, hole.y, zc);
    const screw = screws.find((sc) => {
      if (Math.abs(sc.axis[0] * n[0] + sc.axis[1] * n[1] + sc.axis[2] * n[2]) < 0.9) return false;
      const rel: V3 = [c[0] - sc.seat[0], c[1] - sc.seat[1], c[2] - sc.seat[2]];
      const along = rel[0] * sc.axis[0] + rel[1] * sc.axis[1] + rel[2] * sc.axis[2];
      if (along < -0.5 || along > sc.length + 0.5) return false;
      const off = Math.hypot(rel[0] - along * sc.axis[0], rel[1] - along * sc.axis[1], rel[2] - along * sc.axis[2]);
      return off <= Math.max(hole.d, sc.d) / 2 + 0.3;
    });
    if (screw) {
      // it must bite into something besides the module: a boss, insert, standoff or nut along its shank, or the
      // bracket of another module it is screwed to (a star tracker on its attitude module's wall)
      const notScrew: Skip = (it) => it.comp === s.partId || it.id === screw.id;
      let bites = false;
      for (let a = 0.5; a <= screw.length && !bites; a += 1) {
        const p: V3 = [screw.seat[0] + screw.axis[0] * a, screw.seat[1] + screw.axis[1] * a, screw.seat[2] + screw.axis[2] * a];
        const hit = solids.nearest(p, screw.d / 2 + 1.2, notScrew);
        if (hit) {
          bites = true;
          touches.add(solids.items[hit.item].id);
        }
      }
      if (bites) {
        screwed.push(screw.id);
        touches.add(screw.id);
        continue;
      }
    }
    // a peg through the hole
    const peg = solids.near(c, c, 0, others).find((i) => solids.inside(c, i));
    if (peg !== undefined) {
      pegged++;
      touches.add(solids.items[peg].id);
      continue;
    }
    // a boss or standoff under the hole, with a hole of its own for a screw
    const down = D([0, 0, -1]);
    let ring = 0;
    for (let a = 0; a < 4; a++) {
      const ang = (a / 4) * Math.PI * 2 + Math.PI / 4;
      const r = hole.d / 2 + 1.2;
      const p = W(hole.x + Math.cos(ang) * r, hole.y + Math.sin(ang) * r, lo[2] + 0.3);
      const hit = solids.raycast(p, down, 0.3 + GAP, others);
      if (hit) {
        ring++;
        touches.add(solids.items[hit.item].id);
      }
    }
    if (ring >= 3 && !solids.raycast(W(hole.x, hole.y, lo[2] + 0.3), down, 2.5, others)) bosses++;
  }

  // what closes it in on each side: short rays out of its faces
  const blocked = new Set<Dir>();
  const inset = Math.min(1, t / 2);
  const face = (dir: Dir): V3[] => {
    const pts: V3[] = [];
    const [ax, bx] = [lo[0] + 0.5, hi[0] - 0.5];
    const [ay, by] = [lo[1] + 0.5, hi[1] - 0.5];
    const [az, bz] = [lo[2] + Math.min(0.4, t / 3), hi[2] - Math.min(0.4, t / 3)];
    const grid = (u0: number, u1: number, nu: number, v0: number, v1: number, nv: number, at: (u: number, v: number) => V3) => {
      for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) pts.push(at(nu === 1 ? (u0 + u1) / 2 : u0 + ((u1 - u0) * i) / (nu - 1), nv === 1 ? (v0 + v1) / 2 : v0 + ((v1 - v0) * j) / (nv - 1)));
    };
    const nz = s.board ? 1 : 3;
    switch (dir) {
      case "+z":
        grid(ax, bx, 7, ay, by, 5, (u, v) => [u, v, hi[2] - inset]);
        break;
      case "-z":
        grid(ax, bx, 7, ay, by, 5, (u, v) => [u, v, lo[2] + inset]);
        break;
      case "+x":
        grid(ay, by, 5, az, bz, nz, (u, v) => [hi[0] - inset, u, v]);
        break;
      case "-x":
        grid(ay, by, 5, az, bz, nz, (u, v) => [lo[0] + inset, u, v]);
        break;
      case "+y":
        grid(ax, bx, 7, az, bz, nz, (u, v) => [u, hi[1] - inset, v]);
        break;
      case "-y":
        grid(ax, bx, 7, az, bz, nz, (u, v) => [u, lo[1] + inset, v]);
        break;
    }
    return pts;
  };
  for (const dir of DIRS) {
    const wd = D(LOCAL[dir]);
    for (const p of face(dir)) {
      const hit = solids.raycast(W(p[0], p[1], p[2]), wd, inset + GAP, others);
      if (hit) {
        blocked.add(dir);
        touches.add(solids.items[hit.item].id);
      }
    }
  }
  // pegs locate it in its own plane; screws through two holes hold it every way, and so does one screw with a peg to stop it turning
  if (pegged >= 2) for (const d of ["+x", "-x", "+y", "-y"] as Dir[]) blocked.add(d);
  if (bosses + screwed.length > 0) blocked.add("-z");
  const free = DIRS.filter((d) => !blocked.has(d)).map((d) => ({ dir: D(LOCAL[d]), local: d }));

  let verdict: MountVerdict;
  if (screwed.length >= 2 || (screwed.length === 1 && pegged >= 1)) verdict = "screwed";
  else if (!free.length) verdict = "held";
  else if (!touches.size) verdict = "floating";
  else if (s.held) verdict = "declared";
  else if (screwed.length === 1) verdict = "one-screw";
  else if (bosses + screwed.length >= 2) verdict = "no-screws";
  else verdict = "loose";
  return { comp: s.comp, partId: s.partId, verdict, holes: s.holes.length, screwed, pegged, bosses, free: verdict === "screwed" ? [] : free, touches: [...touches], held: s.held };
}
