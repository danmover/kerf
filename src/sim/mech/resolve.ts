// Resolves a scenario's mechanism against the built design: which parts move
// together on which joint, each body's mass, centre of mass and inertia from
// its parts' own shapes and materials (or the catalog's weight for a bought
// part), the corners that can touch the floor, gear sizes from the gears
// themselves, bearings found on a pivot's axis for its friction, a cam's
// profile from its shape, and everything converted to SI units for the
// solver. Runs in the app (it needs the meshes), before the run is queued.

import { partMass, turns, type EvalPart, type Link, type Model, type Motion } from "../../core/model";
import { findHolds, isFastener } from "../../core/holds";
import type { MeshEntry } from "../../core/engine";
import { applyXforms, type Xform } from "../../kernel/recipe";
import { cylMid, lineDistance, partCylinders } from "../../analysis/fits/geometry";
import { catalogPart } from "../../machine/catalog";
import type { BeltDef, BeltNode } from "../../machine/types";
import { MATERIALS, materialDensity } from "../../library/standards";
import type { ScenarioSpec } from "../scenario";
import type { MechItem, MechJointItem, MechSpec } from "./lang";
import { FRAME, type MechBody, type MechDrive, type MechGround, type MechJet, type MechJoint, type MechLink, type MechModel } from "./model";
import type { M3, V3 } from "./solver";

export type Resolved = { mech: MechModel } | { error: string } | { waiting: string[] };

const G = 9.80665;
const D2R = Math.PI / 180;
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scl = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => scl(a, 1 / (len(a) || 1));
/** One key per turning: its axis line (its closest point to the design origin), its rate, and what it rides on. */
function lineKey(m: Motion): string {
  if (m.link) return `${m.kind}:${m.link.id}`;
  const a = unit(m.axis);
  const c = sub(m.origin, scl(a, dot(m.origin, a)));
  const key = [...a.map((x) => Math.round(Math.abs(x) * 1e4)), ...c.map((x) => Math.round(x * 100)), Math.round(m.ratio * 1e6) * Math.sign(a[0] + a[1] * 1e-3 + a[2] * 1e-6 || 1)].join(",");
  return m.parent ? `${key}<${lineKey(m.parent)}` : key;
}
const SI = (p: V3): V3 => [p[0] / 1000, p[1] / 1000, p[2] / 1000];

/** rotates v about a unit axis by an angle */
function rot(v: V3, a: V3, ang: number): V3 {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const k = cross(a, v);
  const d = dot(a, v) * (1 - c);
  return [v[0] * c + k[0] * s + a[0] * d, v[1] * c + k[1] * s + a[1] * d, v[2] * c + k[2] * s + a[2] * d];
}

// ---------- mass properties from meshes ----------

interface PartProps {
  /** mm³ from the mesh, scaled to the kernel's exact volume */
  volume: number;
  /** centre, mm, world */
  com: V3;
  /** ∫ (x - com)(x - com)ᵀ dV, mm⁵ */
  cov: M3;
  /** support points in 42 directions, mm, world */
  support: V3[];
  /** world box */
  min: V3;
  max: V3;
  /** world vertices, for cam profiles and wheel radii */
  verts: Float32Array;
  /**
   * World boxes that follow its shape, for loose objects to press on: its own box when it fills most of it, else
   * slices of it (an L-shaped finger is its rack and its blade, not the corner between them).
   */
  boxes: { min: V3; max: V3 }[];
  /** a part that is all but a box (a pad, a plate): its corners, which are on its faces */
  corners?: V3[];
}

/**
 * A mesh cut into n slices along one axis, each slice in its own box. The box of a slice is exact: the triangle
 * corners inside it and the points where triangle edges cross its two faces.
 */
function sliceBoxes(verts: Float32Array, idx: ArrayLike<number>, min: V3, max: V3, ax: number, n: number): { min: V3; max: V3 }[] {
  const w = (max[ax] - min[ax]) / n;
  if (!(w > 1e-9)) return [{ min, max }];
  const out = Array.from({ length: n }, () => ({ min: [Infinity, Infinity, Infinity] as V3, max: [-Infinity, -Infinity, -Infinity] as V3 }));
  const grow = (k: number, x: number, y: number, z: number) => {
    const b = out[k];
    if (x < b.min[0]) b.min[0] = x;
    if (y < b.min[1]) b.min[1] = y;
    if (z < b.min[2]) b.min[2] = z;
    if (x > b.max[0]) b.max[0] = x;
    if (y > b.max[1]) b.max[1] = y;
    if (z > b.max[2]) b.max[2] = z;
  };
  const slice = (x: number) => Math.max(0, Math.min(n - 1, Math.floor((x - min[ax]) / w)));
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const i = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3];
    const lo = Math.min(verts[i[0] + ax], verts[i[1] + ax], verts[i[2] + ax]);
    const hi = Math.max(verts[i[0] + ax], verts[i[1] + ax], verts[i[2] + ax]);
    for (let k = slice(lo); k <= slice(hi); k++) {
      const a = min[ax] + k * w;
      const b = a + w;
      for (let j = 0; j < 3; j++) {
        const p = i[j];
        const q = i[(j + 1) % 3];
        const pa = verts[p + ax];
        const qa = verts[q + ax];
        if (pa >= a - 1e-9 && pa <= b + 1e-9) grow(k, verts[p], verts[p + 1], verts[p + 2]);
        for (const cut of [a, b]) {
          if ((pa - cut) * (qa - cut) >= 0) continue;
          const u = (cut - pa) / (qa - pa);
          grow(k, verts[p] + u * (verts[q] - verts[p]), verts[p + 1] + u * (verts[q + 1] - verts[p + 1]), verts[p + 2] + u * (verts[q + 2] - verts[p + 2]));
        }
      }
    }
  }
  // neighbours with the same section are one box
  const merged: { min: V3; max: V3 }[] = [];
  for (const b of out) {
    if (b.min[0] > b.max[0]) continue;
    const last = merged[merged.length - 1];
    const same = last && [0, 1, 2].every((c) => c === ax || (Math.abs(last.min[c] - b.min[c]) < 0.3 && Math.abs(last.max[c] - b.max[c]) < 0.3));
    if (same && Math.abs(last.max[ax] - b.min[ax]) < 1e-6) last.max[ax] = b.max[ax];
    else merged.push(b);
  }
  return merged;
}

/** The boxes a part's shape is taken as: see PartProps.boxes. */
function shapeBoxes(verts: Float32Array, idx: ArrayLike<number>, min: V3, max: V3, volume: number): { boxes: { min: V3; max: V3 }[]; corners?: V3[] } {
  const ext = sub(max, min);
  const full = ext[0] * ext[1] * ext[2];
  const one = [{ min, max }];
  if (!(full > 1e-9) || !(volume > 0)) return { boxes: one };
  const fill = volume / full;
  if (fill > 0.85) {
    const corners: V3[] = [];
    for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) corners.push([x, y, z]);
    return { boxes: one, corners };
  }
  if (fill > 0.6 || Math.max(...ext) < 8) return { boxes: one };
  // sliced along whichever axis leaves the least empty space in the boxes
  let best = one;
  let bestV = full;
  for (let ax = 0; ax < 3; ax++) {
    const bs = sliceBoxes(verts, idx, min, max, ax, 8);
    const v = bs.reduce((a, b) => a + (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]), 0);
    if (v < bestV * 0.9) {
      best = bs;
      bestV = v;
    }
  }
  return { boxes: best };
}

const DIRS: V3[] = (() => {
  const out: V3[] = [];
  // the 6 faces, 12 edges and 8 corners of a cube, plus 16 more between them
  for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) if (x || y || z) out.push(unit([x, y, z]));
  for (const s of [-1, 1]) for (const t of [-1, 1]) {
    out.push(unit([2 * s, t, 0]), unit([s, 2 * t, 0]), unit([0, 2 * s, t]), unit([2 * s, 0, t]));
  }
  return out;
})();

const propsCache = new Map<string, PartProps | null>();

function partProps(p: EvalPart, e: MeshEntry): PartProps | null {
  const key = `${p.hash}|${JSON.stringify(p.xf)}`;
  if (propsCache.has(key)) return propsCache.get(key)!;
  // the fast mesh: its volume is scaled to the exact one, and the run does not repeat when the fine mesh lands
  const mesh = e.preview ?? e.final;
  if (!mesh) return null;
  const pos = mesh.positions;
  const n = pos.length / 3;
  const verts = new Float32Array(pos.length);
  const xf: Xform[] = p.xf;
  for (let i = 0; i < n; i++) {
    const w = xf.length ? applyXforms([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]], xf) : [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
    verts[i * 3] = w[0];
    verts[i * 3 + 1] = w[1];
    verts[i * 3 + 2] = w[2];
  }
  // signed tetrahedra from a reference point near the part (keeps the sums well conditioned)
  const idx = mesh.indices;
  const o: V3 = [verts[0], verts[1], verts[2]];
  let V = 0;
  const m1: V3 = [0, 0, 0];
  const C = new Float64Array(9);
  for (let t = 0; t < idx.length; t += 3) {
    const a: V3 = [verts[idx[t] * 3] - o[0], verts[idx[t] * 3 + 1] - o[1], verts[idx[t] * 3 + 2] - o[2]];
    const b: V3 = [verts[idx[t + 1] * 3] - o[0], verts[idx[t + 1] * 3 + 1] - o[1], verts[idx[t + 1] * 3 + 2] - o[2]];
    const c: V3 = [verts[idx[t + 2] * 3] - o[0], verts[idx[t + 2] * 3 + 1] - o[1], verts[idx[t + 2] * 3 + 2] - o[2]];
    const det = dot(a, cross(b, c));
    V += det / 6;
    const s = add(add(a, b), c);
    for (let k = 0; k < 3; k++) m1[k] += (det / 24) * s[k];
    for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) C[i * 3 + k] += (det / 120) * (a[i] * a[k] + b[i] * b[k] + c[i] * c[k] + s[i] * s[k]);
  }
  let min: V3 = [Infinity, Infinity, Infinity];
  let max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++)
    for (let k = 0; k < 3; k++) {
      const x = verts[i * 3 + k];
      if (x < min[k]) min[k] = x;
      if (x > max[k]) max[k] = x;
    }
  if (n === 0) {
    min = [0, 0, 0];
    max = [0, 0, 0];
  }
  // mirrored parts come out inside-out
  if (V < 0) {
    V = -V;
    for (let k = 0; k < 3; k++) m1[k] = -m1[k];
    for (let i = 0; i < 9; i++) C[i] = -C[i];
  }
  const exact = e.volume > 0 ? e.volume : V;
  let com: V3;
  let cov: M3;
  if (V > 1e-9 && V > 0.3 * exact) {
    const cl: V3 = scl(m1, 1 / V);
    com = add(o, cl);
    const k = exact / V;
    cov = Array.from({ length: 9 }, (_, i) => k * (C[i] - V * cl[Math.floor(i / 3)] * cl[i % 3])) as M3;
  } else {
    // an open mesh: a solid box of the same volume fills its bounding box's middle
    com = scl(add(min, max), 0.5);
    const h = scl(sub(max, min), 0.5);
    cov = [(exact * h[0] * h[0]) / 3, 0, 0, 0, (exact * h[1] * h[1]) / 3, 0, 0, 0, (exact * h[2] * h[2]) / 3];
  }
  const support = DIRS.map((d) => {
    let best = -Infinity;
    let bi = 0;
    for (let i = 0; i < n; i++) {
      const s = verts[i * 3] * d[0] + verts[i * 3 + 1] * d[1] + verts[i * 3 + 2] * d[2];
      if (s > best) {
        best = s;
        bi = i;
      }
    }
    return [verts[bi * 3], verts[bi * 3 + 1], verts[bi * 3 + 2]] as V3;
  });
  const out: PartProps = { volume: exact, com, cov, support, min, max, verts, ...shapeBoxes(verts, idx, min, max, V > 0.3 * exact ? exact : 0) };
  if (propsCache.size > 400) propsCache.clear();
  propsCache.set(key, out);
  return out;
}

// ---------- the resolver ----------

class Fail extends Error {}

interface Group {
  id: string;
  members: string[];
  parts: EvalPart[];
  joint?: MechJointItem;
  auto?: boolean;
}

/**
 * final: the design has finished building, so parts still without a mesh (a build error) are left out
 * instead of waited for.
 */
export function resolveMechanism(scn: ScenarioSpec, model: Model, geom: (hash: string) => MeshEntry | undefined, final = false): Resolved {
  const spec = scn.mechanism;
  if (!spec) return { error: "no mechanism" };
  try {
    return resolveInner(spec, scn, model, geom, final);
  } catch (e) {
    if (e instanceof Fail) return { error: e.message };
    throw e;
  }
}

function resolveInner(spec: MechSpec, scn: ScenarioSpec, model: Model, geom: (hash: string) => MeshEntry | undefined, final: boolean): Resolved {
  const fail = (msg: string): never => {
    throw new Fail(`mechanism: ${msg}`);
  };
  const notes: string[] = [];
  const parts = model.parts.filter((p) => !p.hidden && !(p.imported && p.imported.kind !== "solid"));
  const byName = new Map<string, EvalPart[]>();
  for (const p of parts) {
    const l = byName.get(p.name);
    if (l) l.push(p);
    else byName.set(p.name, [p]);
  }
  const comps = new Map((model.machine?.components ?? []).map((c) => [c.name, c]));

  // ---- bodies: the joints' members, then the design's own turning parts, the rest is the frame
  const groups: Group[] = [];
  const bodyOf = new Map<string, string>();
  // the built parts on a moving body (a component's fixed half, like a motor's body, stays on the frame)
  const taken = new Set<string>();
  const itemJoints = spec.items.filter((i): i is MechJointItem => ["pivot", "slider", "ball", "weld", "free"].includes(i.k));
  for (const j of itemJoints) {
    const g: Group = { id: j.name, members: j.what, parts: [], joint: j };
    for (const m of j.what) {
      if (bodyOf.has(m)) fail(`${m} is on two joints (${bodyOf.get(m)} and ${j.name}): a part moves with one body; put it in one joint's list`);
      const ps = byName.get(m);
      if (!ps?.length) fail(`${j.name}: there is no built part or component called ${m}`);
      bodyOf.set(m, g.id);
      g.parts.push(...ps!);
      for (const p of ps!) taken.add(p.id);
    }
    groups.push(g);
  }
  const explicit = new Set(bodyOf.keys());
  const named = new Set(spec.items.flatMap((i) => ("name" in i ? [i.name] : [])));
  // how the design holds together: what each screw clamps, and what moving parts carry with them
  const holds = findHolds(model, (h) => geom(h)?.preview ?? geom(h)?.final);
  const lines = new Map<string, Group>();
  const rodLinks: { link: Link; group: Group }[] = [];
  if (spec.auto) {
    const parentOf = new Map<Group, string>();
    for (const p of parts) {
      if (!p.motion || explicit.has(p.name) || !turns(p.motion) || p.motion.link) continue;
      const a = unit(p.motion.axis);
      const o = p.motion.origin;
      const key = lineKey(p.motion);
      let g = lines.get(key);
      if (!g) {
        let id = p.name;
        for (let k = 2; named.has(id) || groups.some((x) => x.id === id); k++) id = `${p.name}_${k}`;
        g = { id, members: [], parts: [], auto: true, joint: { k: "pivot", name: id, what: [], on: null, at: o, axis: a } };
        lines.set(key, g);
        groups.push(g);
        if (p.motion.parent) parentOf.set(g, lineKey(p.motion.parent));
      }
      if (!g.members.includes(p.name)) {
        g.members.push(p.name);
        g.joint!.what.push(p.name);
      }
      g.parts.push(p);
      taken.add(p.id);
      if (!bodyOf.has(p.name)) bodyOf.set(p.name, g.id);
    }
    // connecting rods: the follower slides or swings on the frame, and the rod pivots on its driver at the crank pin
    // (a ball joint at the follower's pin closes the loop, below)
    for (const p of parts) {
      const m = p.motion;
      if (!m?.link || !m.kind || explicit.has(p.name)) continue;
      const key = `${m.kind}:${m.link.id}`;
      let g = lines.get(key);
      if (!g) {
        let id = p.name;
        for (let k = 2; named.has(id) || groups.some((x) => x.id === id); k++) id = `${p.name}_${k}`;
        const l = m.link;
        const joint: MechJointItem = m.kind === "slide" ? { k: "slider", name: id, what: [], on: null, at: l.w0, axis: unit(m.axis) } : m.kind === "swing" ? { k: "pivot", name: id, what: [], on: null, at: m.origin, axis: unit(m.axis) } : { k: "pivot", name: id, what: [], on: null, at: l.p0, axis: unit(l.driver.axis) };
        g = { id, members: [], parts: [], auto: true, joint };
        lines.set(key, g);
        groups.push(g);
        if (m.kind === "rod") rodLinks.push({ link: l, group: g });
      }
      if (!g.members.includes(p.name)) {
        g.members.push(p.name);
        g.joint!.what.push(p.name);
      }
      g.parts.push(p);
      taken.add(p.id);
      if (!bodyOf.has(p.name)) bodyOf.set(p.name, g.id);
    }
    for (const { link, group } of rodLinks) {
      const driver = lines.get(lineKey(link.driver)) ?? groups.find((x) => x.parts.some((q) => q.motion === link.driver));
      if (driver && driver !== group) group.joint!.on = driver.id;
    }
    // a gear riding on a turning deck (rides:) pivots on the deck's body, not the frame
    for (const [g, pk] of parentOf) {
      const carrier = lines.get(pk) ?? groups.find((x) => x.parts.some((q) => q.motion && lineKey(q.motion) === pk));
      if (carrier && carrier !== g) g.joint!.on = carrier.id;
    }
    const autos = [...lines.values()];
    if (autos.length) notes.push(`Turning on their own shafts (from spin:/mesh:): ${autos.map((g) => g.members.join(" + ") + (g.joint!.on ? ` (on ${g.joint!.on})` : "")).join("; ")}`);
  }
  // screws, nuts and washers move with the part they clamp (not one they are its pivot), and parts bolted to a
  // turning part turn with it
  const groupOf = new Map<string, Group>();
  for (const g of groups) for (const p of g.parts) groupOf.set(p.id, g);
  const ride = (p: EvalPart, g: Group | undefined) => {
    if (!g || taken.has(p.id)) return;
    g.parts.push(p);
    taken.add(p.id);
    groupOf.set(p.id, g);
  };
  let rode = 0;
  for (const st of holds.stacks) {
    const anchor = st.clamped.find((p) => !isFastener(p) && !st.pivots.includes(p)) ?? (st.host && !st.pivots.includes(st.host) ? st.host : undefined);
    const g = anchor ? groupOf.get(anchor.id) : undefined;
    if (!g) continue;
    const before = taken.size;
    ride(st.screw, g);
    for (const l of st.layers) if (isFastener(l.part) && l.part.libKind !== "insert" && l.part.libKind !== "standoff") ride(l.part, g);
    rode += taken.size - before;
  }
  if (spec.auto)
    for (const p of parts) {
      const c = holds.carried.get(p.id);
      if (!c) continue;
      const before = taken.size;
      ride(p, groupOf.get(c.from.id) ?? lines.get(lineKey(c.motion)));
      rode += taken.size - before;
    }
  if (rode) notes.push(`${rode} screw${rode === 1 ? "" : "s"}, nut${rode === 1 ? "" : "s"} and bolted part${rode === 1 ? "" : "s"} move with the bodies they fasten`);
  const frameParts = parts.filter((p) => !taken.has(p.id));
  const bodyIdOf = (name: string | null, what: string): string => {
    if (name === null || name === FRAME) return FRAME;
    const b = bodyOf.get(name) ?? (groups.some((g) => g.id === name) ? name : undefined);
    if (b) return b;
    if (byName.has(name)) return FRAME;
    return fail(`${what}: ${name} is not a part, component or joint of the design`);
  };

  // ---- mass properties
  const waiting: string[] = [];
  const props = new Map<string, PartProps>();
  for (const p of parts) {
    const e = geom(p.hash);
    const pr = e ? partProps(p, e) : null;
    if (!pr) {
      waiting.push(p.id);
      continue;
    }
    props.set(p.id, pr);
  }
  if (waiting.length && !final) return { waiting };
  if (waiting.length) notes.push(`Left out (not built): ${waiting.slice(0, 6).join(", ")}${waiting.length > 6 ? ` and ${waiting.length - 6} more` : ""}`);

  const payloads = spec.items.filter((i): i is Extract<MechItem, { k: "payload" }> => i.k === "payload");
  const floorWorld = scn.world.kind === "floor";
  const base = spec.base ?? (floorWorld ? "free" : "fixed");
  const wheelBodies = new Set(spec.items.flatMap((i) => (i.k === "wheel" ? [bodyIdOf(i.what, "sim.wheel")] : [])));
  const trackBodies = new Set(spec.items.flatMap((i) => (i.k === "track" ? [bodyIdOf(i.sprocket, "sim.track")] : [])));

  /** a body's mass (kg), centre (m) and inertia (kg·m²) from its parts and payloads */
  const massOf = (id: string, ps: EvalPart[]) => {
    let mass = 0;
    const m1: V3 = [0, 0, 0];
    const items: { m: number; c: V3; cov: M3 }[] = [];
    // a bought part weighs what the catalog says, shared over its solids by volume
    const compMass = new Map<string, number>();
    const compVol = new Map<string, number>();
    for (const p of ps) {
      const pr = props.get(p.id);
      if (!pr) continue;
      compVol.set(p.name, (compVol.get(p.name) ?? 0) + pr.volume);
      if (p.kind === "component" && !compMass.has(p.name)) {
        const mc = comps.get(p.name);
        const cat = mc ? catalogPart(mc.catalogId) : p.bom?.catalogId ? catalogPart(p.bom.catalogId) : undefined;
        const g = cat && typeof cat.specs.mass_g === "number" ? (cat.specs.mass_g as number) : NaN;
        compMass.set(p.name, g);
      }
    }
    for (const p of ps) {
      const pr = props.get(p.id);
      if (!pr) continue;
      const cat = compMass.get(p.name);
      // grams
      // a part's own mass: when given (a printed part's infill), else its solid's volume times its material's density
      const g = cat !== undefined && Number.isFinite(cat) ? (cat * pr.volume) / Math.max(1e-9, compVol.get(p.name)!) : partMass(p, pr.volume, materialDensity(p.material))!;
      const k = g / Math.max(1e-9, pr.volume);
      items.push({ m: g, c: pr.com, cov: pr.cov.map((x) => x * k) as M3 });
      mass += g;
      for (let i = 0; i < 3; i++) m1[i] += g * pr.com[i];
    }
    for (const pl of payloads) {
      if (bodyIdOf(pl.on, "sim.payload") !== id) continue;
      const c = pl.at ?? (mass > 0 ? scl(m1, 1 / mass) : [0, 0, 0]);
      // a small dense block: 30 mm across
      const s = (pl.mass * 30 * 30) / 12;
      items.push({ m: pl.mass, c, cov: [s, 0, 0, 0, s, 0, 0, 0, s] });
      mass += pl.mass;
      for (let i = 0; i < 3; i++) m1[i] += pl.mass * c[i];
    }
    if (mass <= 0) return { mass: 0.001, com: [0, 0, 0] as V3, inertia: [1e-9, 0, 0, 0, 1e-9, 0, 0, 0, 1e-9] as M3, grams: 0 };
    const com = scl(m1, 1 / mass);
    // second moment about the common centre, g·mm², then the inertia tensor
    const S = new Array<number>(9).fill(0);
    for (const it of items) {
      const d = sub(it.c, com);
      for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) S[i * 3 + k] += it.cov[i * 3 + k] + it.m * d[i] * d[k];
    }
    const tr = S[0] + S[4] + S[8];
    // g·mm² to kg·m²
    const I = S.map((x, i) => ((i % 4 === 0 ? tr : 0) - x) * 1e-9) as M3;
    // keep it invertible: a thin rod still has some inertia about its own axis
    const floor = Math.max(1e-10, 1e-4 * (I[0] + I[4] + I[8]));
    for (const i of [0, 4, 8]) I[i] = Math.max(I[i], floor);
    return { mass: mass / 1000, com: SI(com), inertia: I, grams: mass };
  };

  const bodies: MechBody[] = [];
  const supportOf = (ps: EvalPart[]): V3[] => {
    const pts: V3[] = [];
    DIRS.forEach((d, k) => {
      let best = -Infinity;
      let bp: V3 | null = null;
      for (const p of ps) {
        const sp = props.get(p.id)?.support[k];
        if (!sp) continue;
        const s = dot(sp, d);
        if (s > best) {
          best = s;
          bp = sp;
        }
      }
      if (bp && !pts.some((q) => len(sub(q, bp!)) < 2)) pts.push(bp);
    });
    // a box-shaped part's corners too: a gripper's pad sits inside its finger's outline, so none of the body's
    // outermost points is on the face that does the gripping
    for (const p of ps) for (const c of props.get(p.id)?.corners ?? []) if (pts.length < 96 && !pts.some((q) => len(sub(q, c)) < 2)) pts.push(c);
    return pts.map(SI);
  };
  // a moving body's parts by their shape; the frame's by one box each (there are many, and loose things lie on them)
  const boxesOf = (ps: EvalPart[], fixed: boolean) =>
    ps.flatMap((p) => {
      const pr = props.get(p.id);
      if (!pr) return [];
      const bs = fixed ? [{ min: pr.min, max: pr.max }] : pr.boxes;
      return bs.map((b) => ({ c: SI(scl(add(b.min, b.max), 0.5)), h: SI(scl(sub(b.max, b.min), 0.5)), q: [1, 0, 0, 0] as [number, number, number, number] }));
    });
  const massLines: string[] = [];
  const addBody = (id: string, ps: EvalPart[], label: string, fixed: boolean) => {
    const mp = massOf(id, ps);
    const touches = !fixed && !wheelBodies.has(id) && !trackBodies.has(id);
    bodies.push({ id, label, parts: ps.map((p) => p.id), mass: mp.mass, com: mp.com, inertia: mp.inertia, points: touches ? supportOf(ps) : [], boxes: boxesOf(ps, fixed), fixed: fixed || undefined });
    if (!fixed || id === FRAME) massLines.push(`${id} ${fmtMass(mp.grams)}`);
  };
  addBody(FRAME, frameParts, "the frame", base === "fixed");
  for (const g of groups) addBody(g.id, g.parts, g.members.join(", "), false);
  const mats = [...new Set(parts.filter((p) => p.kind === "part").map((p) => MATERIALS[p.material]?.label ?? p.material))];
  notes.push(`Masses from each part's shape and material${mats.length ? ` (${mats.slice(0, 4).join(", ")}${mats.length > 4 ? ", …" : ""})` : ""} and the catalog's weights for bought parts: ${massLines.join(", ")}${base === "fixed" ? " (the frame bolted down)" : ""}`);
  const bodyById = new Map(bodies.map((b) => [b.id, b]));

  // ---- joints
  const joints: MechJoint[] = [];
  const drives: MechDrive[] = [];
  const firstWith = <T>(ps: EvalPart[], f: (p: EvalPart) => T | undefined): T | undefined => {
    for (const p of ps) {
      const v = f(p);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  const jointByName = new Map<string, MechJoint>();
  for (const g of groups) {
    const j = g.joint!;
    if (j.k === "free") continue;
    const body = bodyById.get(g.id)!;
    const on = bodyIdOf(j.on, j.name);
    if (on === g.id) fail(`${j.name} cannot hang on itself`);
    let at = j.at;
    let axis = j.axis;
    if (j.k === "pivot" && (!at || !axis)) {
      const fromPart = firstWith(g.parts, (p) => (p.motion ? { at: p.motion.origin, axis: p.motion.axis } : p.gear ? { at: p.gear.center, axis: p.gear.axis } : p.bearing ? { at: p.bearing.center, axis: p.bearing.axis } : undefined));
      if (!fromPart) fail(`sim.pivot(${j.name}) needs at: and axis: (its parts have no spin:, gear or bearing to take them from)`);
      at = at ?? fromPart!.at;
      axis = axis ?? fromPart!.axis;
    }
    if (j.k === "slider" && !axis) fail(`sim.slider(${j.name}) needs axis:, the way it slides`);
    const atM = at ? SI(at) : body.com;
    const ax = unit(axis ?? [0, 0, 1]);
    const mj: MechJoint = { kind: j.k as MechJoint["kind"], name: j.name, body: g.id, on, at: atM, axis: ax, assumed: [] };
    if (j.k === "pivot") {
      if (j.limits) mj.limits = [j.limits[0] * D2R, j.limits[1] * D2R];
      if (j.friction !== undefined) mj.friction = j.friction / 1000;
      if (j.damping !== undefined) mj.damping = (j.damping / 1000) * (180 / Math.PI);
      if (j.spring !== undefined) mj.spring = (j.spring / 1000) * (180 / Math.PI);
      if (j.free !== undefined) mj.free = j.free * D2R;
      if (j.friction === undefined) {
        // a bearing on the axis (on either body) sets the friction; else a plain bushing
        const onBody = on === FRAME ? frameParts : (groups.find((x) => x.id === on)?.parts ?? []);
        const brg = [...g.parts, ...onBody].find((p) => p.bearing && Math.abs(dot(unit(p.bearing.axis), ax)) > 0.99 && len(cross(sub(SI(p.bearing.center), atM), ax)) < 0.002);
        // or a bought part turning in itself, like a motor's shaft in its body
        const own = brg ? undefined : g.parts.find((p) => p.kind === "component" && onBody.some((q) => q.kind === "component" && q.name === p.name));
        if (brg?.bearing) {
          mj.frictionPerLoad = 0.0015 * (brg.bearing.bore / 2000);
          mj.assumed!.push(`${j.name}: turns in ${brg.name} (${brg.bearing.code}), rolling friction 0.0015`);
        } else if (own) {
          mj.frictionPerLoad = 0.0015 * 0.0025;
          mj.assumed!.push(`${j.name}: turns in ${own.name}'s own bearings, rolling friction 0.0015`);
        } else {
          // a pin on the axis (a dowel or shaft the body hangs on) turns in a plain hole: its own size, and no drag
          // beyond the friction of the load on it, so a light part hanging free still finds its level
          const atMm: V3 = [atM[0] * 1000, atM[1] * 1000, atM[2] * 1000];
          const pin = [...g.parts, ...onBody].flatMap((p) => partCylinders(p).filter((c) => c.side === "shaft" && c.role === "plain" && Math.abs(dot(unit(c.axis), ax)) > 0.99 && lineDistance(cylMid(c), atMm, ax) < Math.max(0.5, c.d * 0.1)).map((c) => ({ p, c })))[0];
          if (pin) {
            mj.frictionPerLoad = 0.15 * (pin.c.d / 2000);
            mj.assumed!.push(`${j.name}: turns on ${pin.p.name}, a plain Ø${Math.round(pin.c.d * 10) / 10} mm pin (friction 0.15)`);
          } else {
            mj.frictionPerLoad = 0.15 * 0.004;
            mj.friction = 0.002;
            mj.assumed!.push(`${j.name}: no bearing found on its axis, so a plain 8 mm pin (friction 0.15)`);
          }
        }
      }
    } else if (j.k === "slider") {
      if (j.limits) mj.limits = [j.limits[0] / 1000, j.limits[1] / 1000];
      if (j.friction !== undefined) mj.friction = j.friction;
      if (j.damping !== undefined) mj.damping = j.damping * 1000;
      if (j.spring !== undefined) mj.spring = j.spring * 1000;
      if (j.free !== undefined) mj.free = j.free / 1000;
      if (j.friction === undefined) {
        mj.frictionPerLoad = 0.05;
        mj.assumed!.push(`${j.name}: a lubricated slide (friction 0.05)`);
      }
    }
    if (j.drive) {
      const mc = comps.get(j.drive);
      const cat = mc ? catalogPart(mc.catalogId) : undefined;
      if (!mc || !cat) fail(`${j.name}: drive: ${j.drive} is not a catalog gearmotor, servo or linear actuator (for a hand, a solenoid or an air cylinder use sim.turn, sim.solenoid or sim.cylinder)`);
      if (cat!.kind === "gearmotor") {
        if (j.k !== "pivot") fail(`${j.name}: a gearmotor turns a pivot, not a ${j.k}`);
        drives.push({ kind: "motor", joint: j.name, comp: j.drive, sign: 1 });
      } else if (cat!.kind === "servo") {
        if (j.k !== "pivot") fail(`${j.name}: a servo turns a pivot, not a ${j.k}`);
        const range = Number(cat!.specs.range_deg ?? 180);
        const zero = j.zero ?? range / 2;
        drives.push({ kind: "servo", joint: j.name, comp: j.drive, sign: 1, zero });
        // the servo's own end stops
        if (!mj.limits) mj.limits = [-zero * D2R, (range - zero) * D2R];
      } else if (cat!.kind === "actuator") {
        if (j.k !== "slider") fail(`${j.name}: a linear actuator works a slider, not a ${j.k}`);
        const stroke = Number(cat!.specs.stroke ?? 50);
        const start = typeof mc!.length === "number" ? mc!.length : stroke / 2;
        drives.push({ kind: "actuator", joint: j.name, comp: j.drive, sign: 1, start });
        if (!mj.limits) mj.limits = [-start / 1000, (stroke - start) / 1000];
        // the actuator's screw, not a slide, carries it
        delete mj.frictionPerLoad;
        mj.assumed = mj.assumed!.filter((x) => !x.includes("lubricated slide"));
      } else fail(`${j.name}: drive: ${j.drive} is a ${cat!.kind}; a joint is driven by a gearmotor, servo or linear actuator`);
    }
    joints.push(mj);
    jointByName.set(mj.name, mj);
    for (const a of mj.assumed ?? []) notes.push(a);
  }
  // each connecting rod's pin in its follower closes the loop: a ball joint, so a planar linkage is not held twice over
  for (const { link, group } of rodLinks) {
    const follower = lines.get(`${link.follower.kind}:${link.id}`);
    if (!follower) continue;
    joints.push({ kind: "ball", name: `${link.name}-${link.follower.name} pin`, body: follower.id, on: group.id, at: SI(link.w0), axis: unit(link.driver.axis), assumed: [] });
    notes.push(`${link.name} drives ${link.follower.name} through its pins (a closed linkage)`);
  }
  const jointOf = (name: string, what: string, kind?: MechJoint["kind"]): MechJoint => {
    const j = jointByName.get(name) ?? joints.find((x) => x.body === bodyOf.get(name));
    if (!j) return fail(`${what}: ${name} is not on a joint (add sim.pivot(${name}, ...) or sim.slider(${name}, ...))`);
    if (kind && j.kind !== kind) return fail(`${what}: ${name} should be on a ${kind}, not a ${j.kind}`);
    return j;
  };
  const gearOf = (name: string, what: string) => {
    const g = byName.get(name)?.find((p) => p.gear)?.gear;
    if (!g) return fail(`${what}: ${name} is not a lib.spur_gear`);
    return g;
  };

  // ---- links
  const links: MechLink[] = [];
  const meshed = new Set<string>();
  const addGears = (name: string, a: string, b: string, backlash: number | undefined, eff: number) => {
    const key = [a, b].sort().join("|");
    if (meshed.has(key)) return;
    meshed.add(key);
    const ga = gearOf(a, "sim.gears");
    const gb = gearOf(b, "sim.gears");
    const ja = jointOf(a, `gears ${name}`, "pivot");
    const jb = jointOf(b, `gears ${name}`, "pivot");
    if (ja === jb) fail(`gears ${name}: ${a} and ${b} are on the same body`);
    const ra = (ga.m * ga.z) / 2 / 1000;
    const bl = (backlash ?? (ga.backlash || gb.backlash || 0.05)) / 1000;
    links.push({ kind: "gears", name, a: ja.name, b: jb.name, ca: SI(ga.center), cb: SI(gb.center), ra, backlash: bl, efficiency: eff });
  };
  for (const it of spec.items) if (it.k === "gears") addGears(it.name, it.a, it.b, it.backlash, it.efficiency);
  if (spec.auto)
    for (const p of parts) {
      const g = p.gear;
      if (!g?.meshWith || (!bodyOf.has(p.name) && !bodyOf.has(g.meshWith))) continue;
      const ja = bodyOf.has(p.name) ? joints.find((x) => x.body === bodyOf.get(p.name)) : undefined;
      const jb = bodyOf.has(g.meshWith) ? joints.find((x) => x.body === bodyOf.get(g.meshWith!)) : undefined;
      if (ja?.kind === "pivot" && jb?.kind === "pivot" && ja !== jb) addGears(`${p.name}-${g.meshWith}`, p.name, g.meshWith, undefined, 0.98);
      else if (!ja !== !jb) {
        // one gear still on the frame: the other rolls round it if its pivot rides on a moving body (a planet)
        const [mover, still] = ja ? [p, byName.get(g.meshWith)?.find((q) => q.gear)] : [byName.get(g.meshWith)?.find((q) => q.gear), p];
        const jm = ja ?? jb!;
        if (!mover?.gear || !still?.gear || jm.kind !== "pivot" || jm.on === FRAME) continue;
        const key = [mover.name, still.name].sort().join("|");
        if (meshed.has(key)) continue;
        meshed.add(key);
        links.push({ kind: "gears", name: `${mover.name}-${still.name}`, a: jm.name, b: FRAME, ca: SI(mover.gear.center), cb: SI(still.gear.center), ra: (mover.gear.m * mover.gear.z) / 2 / 1000, backlash: (mover.gear.backlash || still.gear.backlash || 0.05) / 1000, efficiency: 0.98 });
      }
    }
  if (spec.auto) for (const b of model.machine?.belts ?? []) beltLinks(b, joints, bodyOf, bodyById, links, notes);

  for (const it of spec.items) {
    switch (it.k) {
      case "rack": {
        const g = gearOf(it.pinion, `rack ${it.name}`);
        const jp = jointOf(it.pinion, `rack ${it.name}`, "pivot");
        const jr = jointOf(it.rack, `rack ${it.name}`, "slider");
        const c = SI(g.center);
        const a = unit(g.axis);
        const toward = sub(bodyById.get(jr.body)!.com, c);
        const e = unit(sub(toward, scl(a, dot(toward, a))));
        const r = (g.m * g.z) / 2 / 1000;
        links.push({ kind: "rack", name: it.name, pinion: jp.name, rack: jr.name, p: add(c, scl(e, r)), dir: jr.axis, backlash: (it.backlash ?? (g.backlash || 0.05)) / 1000, efficiency: it.efficiency });
        break;
      }
      case "screw": {
        const js = jointOf(it.screw, `${it.worm ? "worm" : "lead screw"} ${it.name}`, "pivot");
        const fol = it.worm ? jointOf(it.nut, `worm ${it.name}`, "pivot") : jointOf(it.nut, `lead screw ${it.name}`, "slider");
        const a = js.axis;
        let point: V3;
        if (it.worm) {
          // the wheel's pitch point: on the common normal of the two axes, the worm's pitch radius from its axis
          const p1 = js.at;
          const p2 = fol.at;
          const n = cross(a, fol.axis);
          if (len(n) < 1e-6) fail(`worm ${it.name}: the worm and wheel axes are parallel`);
          const nn = unit(n);
          const w = sub(p2, p1);
          // closest point on the worm axis to the wheel axis
          const b2 = fol.axis;
          const d1 = dot(a, w);
          const d2 = dot(b2, w);
          const ab = dot(a, b2);
          const s = (d1 - ab * d2) / (1 - ab * ab);
          const q = add(p1, scl(a, s));
          const side = dot(sub(p2, q), nn) >= 0 ? 1 : -1;
          point = add(q, scl(nn, (side * it.d) / 2000));
        } else {
          const c = bodyById.get(fol.body)!.com;
          point = add(js.at, scl(a, dot(sub(c, js.at), a)));
        }
        const leadAngle = Math.atan(Math.abs(it.lead) / (Math.PI * it.d));
        const flank = it.worm ? 20 : it.ball ? 0 : 15;
        const muP = it.mu / Math.cos(flank * D2R);
        const rm = it.worm || it.ball ? it.d / 2000 : (0.45 * it.d) / 1000;
        links.push({ kind: "thread", name: it.name, screw: js.name, follower: fol.body, point, k: -it.lead / 1000 / (2 * Math.PI), backlash: it.backlash / 1000, frictionArm: muP * rm, what: it.worm ? "worm" : it.ball ? "ball screw" : "lead screw" });
        const locks = muP > Math.tan(leadAngle);
        notes.push(`${it.name}: lead angle ${(leadAngle / D2R).toFixed(1)}°, friction angle ${(Math.atan(muP) / D2R).toFixed(1)}°, so it ${locks ? "holds its load without power (self-locking)" : "can be back-driven by its load"}`);
        break;
      }
      case "chain": {
        const ja = jointOf(it.a, `${it.chain ? "chain" : "coupling"} ${it.name}`);
        const jb = jointOf(it.b, `${it.chain ? "chain" : "coupling"} ${it.name}`);
        if (ja === jb) fail(`${it.name}: ${it.a} and ${it.b} are on the same joint`);
        links.push({ kind: "ratio", name: it.name, a: ja.name, b: jb.name, ratio: it.ratio, slack: jb.kind === "pivot" ? it.slack * D2R : it.slack / 1000, efficiency: it.efficiency });
        break;
      }
      case "cam": {
        const jc = jointOf(it.cam, `cam ${it.name}`, "pivot");
        const jf = jointOf(it.follower, `cam ${it.name}`, "slider");
        const fb = bodyById.get(jf.body)!;
        const a = jc.axis;
        const toF = sub(fb.com, jc.at);
        const u = unit(sub(toF, scl(a, dot(toF, a))));
        if (dot(jf.axis, u) < 0) {
          jf.axis = scl(jf.axis, -1);
          if (jf.limits) jf.limits = [-jf.limits[1], -jf.limits[0]];
          notes.push(`${jf.name}: its axis is taken pointing away from ${it.cam}, so its pos grows as the cam lifts it`);
        }
        const n = 180;
        const lift: number[] = [];
        if (it.lift) {
          const m = it.lift.length;
          for (let i = 0; i < m; i++) lift.push(it.lift[(m - i) % m] / 1000);
        } else {
          const camParts = (byName.get(it.cam) ?? []).map((p) => props.get(p.id)).filter((x): x is PartProps => !!x);
          if (!camParts.length) fail(`cam ${it.name}: ${it.cam} has no shape to take its profile from (give lift:)`);
          const c = scl(jc.at, 1000);
          for (let i = 0; i < n; i++) {
            const d = rot(u, a, (2 * Math.PI * i) / n);
            let best = -Infinity;
            for (const pr of camParts) {
              const v = pr.verts;
              for (let k = 0; k < v.length; k += 3) {
                const s = (v[k] - c[0]) * d[0] + (v[k + 1] - c[1]) * d[1] + (v[k + 2] - c[2]) * d[2];
                if (s > best) best = s;
              }
            }
            lift.push(best / 1000);
          }
          const lo = Math.min(...lift);
          const hi = Math.max(...lift);
          notes.push(`${it.name}: profile from ${it.cam}'s shape, ${((hi - lo) * 1000).toFixed(1)} mm of lift, for a flat-faced follower`);
        }
        links.push({ kind: "cam", name: it.name, cam: jc.name, follower: jf.name, lift, phase: 0, grooved: it.grooved });
        break;
      }
      case "clutch": {
        const jb = jointOf(it.b, `${it.a ? "clutch" : "brake"} ${it.name}`, "pivot");
        const ja = it.a ? jointOf(it.a, `clutch ${it.name}`, "pivot") : undefined;
        links.push({ kind: "clutch", name: it.name, a: ja?.name, b: jb.name, torque: Number.isFinite(it.torque) ? it.torque / 1000 : Infinity, oneWay: it.oneWay, engaged: it.engaged });
        break;
      }
    }
  }

  // ---- inputs
  for (const it of spec.items) {
    switch (it.k) {
      case "turn": {
        const j = jointOf(it.joint, `sim.turn(${it.joint})`);
        const k = j.kind === "pivot" ? (2 * Math.PI) / 60 : 1 / 1000;
        drives.push({ kind: "turn", name: it.name, joint: j.name, speed: it.speed.map(([t, v]) => [t, v * k]), limit: j.kind === "pivot" ? it.limit / 1000 : it.limit });
        break;
      }
      case "motor": {
        const mc = comps.get(it.comp);
        const cat = mc ? catalogPart(mc.catalogId) : undefined;
        if (!mc || cat?.kind !== "gearmotor") fail(`sim.motor(${it.comp}): ${it.comp} is not a catalog gearmotor in the design`);
        const j = jointOf(it.comp, `sim.motor(${it.comp})`, "pivot");
        if (drives.some((d) => d.joint === j.name)) fail(`sim.motor(${it.comp}): ${j.name} already has a drive`);
        drives.push({ kind: "motor", joint: j.name, comp: it.comp, sign: 1 });
        break;
      }
      case "push": {
        const j = jointOf(it.joint, `sim.push(${it.joint})`);
        drives.push({ kind: "force", name: it.name, joint: j.name, value: it.value.map(([t, v]) => [t, j.kind === "pivot" ? v / 1000 : v]) });
        break;
      }
      case "solenoid": {
        const j = jointOf(it.joint, `sim.solenoid(${it.joint})`, "slider");
        drives.push({ kind: "solenoid", name: it.name, joint: j.name, dir: it.pull ? -1 : 1, force: it.force, stroke: it.stroke / 1000, on: it.on });
        break;
      }
      case "cylinder": {
        const j = jointOf(it.joint, `sim.cylinder(${it.joint})`, "slider");
        const fOut = (Math.PI / 4) * it.bore * it.bore * it.pressure;
        const fIn = (Math.PI / 4) * (it.bore * it.bore - it.rod * it.rod) * it.pressure;
        drives.push({ kind: "cylinder", name: it.name, joint: j.name, sign: it.retract ? -1 : 1, fOut, fIn, vmax: it.speed / 1000, seal: it.seal ?? 0.03 * fOut + 2, valve: it.valve });
        notes.push(`${it.name}: ${fOut.toFixed(0)} N out and ${fIn.toFixed(0)} N back at ${(it.pressure * 10).toFixed(1)} bar`);
        break;
      }
    }
  }

  // ---- springs and loads
  const springs = spec.items.flatMap((it) => {
    if (it.k !== "spring") return [];
    const a = bodyIdOf(it.a, `spring ${it.name}`);
    const b = bodyIdOf(it.b, `spring ${it.name}`);
    if (a === b) fail(`spring ${it.name}: both ends are on ${a}`);
    const L = len(sub(it.atB, it.atA));
    if (it.cell) {
      const cat = comps.get(it.cell) ? catalogPart(comps.get(it.cell)!.catalogId) : undefined;
      if (cat?.specs.iface !== "bridge") fail(`spring ${it.name}: cell: ${it.cell} is not a load cell in the design`);
      if (!(it.rate > 0)) fail(`spring ${it.name}: give the load cell's stiffness as rate: (N/mm)`);
    }
    return [{ name: it.name, a, b, pa: SI(it.atA), pb: SI(it.atB), k: it.rate * 1000, c: it.damping * 1000, free: (it.free ?? L) / 1000, push: it.push, cell: it.cell }];
  });
  const loads = spec.items.flatMap((it) => {
    if (it.k !== "load") return [];
    const id = bodyIdOf(it.on, `load ${it.name}`);
    const b = bodyById.get(id)!;
    return [{ name: it.name, body: id, at: it.at ? SI(it.at) : b.com, dir: it.dir, value: it.value.map(([t, v]) => [t, it.torque ? v / 1000 : v] as [number, number]), torque: it.torque, turns: it.turns }];
  });

  // ---- jets: a ducted fan's thrust and the vanes steering it
  const jets: MechJet[] = [];
  for (const it of spec.items) {
    if (it.k !== "jet") continue;
    const mc = comps.get(it.fan);
    const cat = mc ? catalogPart(mc.catalogId) : undefined;
    if (!mc || !cat || cat.kind !== "bldc") fail(`sim.jet(${it.fan}): ${it.fan} is not a ducted fan or brushless motor component in the design`);
    const main = (byName.get(it.fan) ?? []).find((p) => p.id.replace(/#\d+$/, "") === it.fan);
    if (!main) fail(`sim.jet(${it.fan}): ${it.fan} has not been built`);
    const o = applyXforms([0, 0, 0], main!.xf);
    const z = unit(sub(applyXforms([0, 0, 1], main!.xf), o));
    const dims = cat!.geom?.dims ?? {};
    const L = Number(dims.length ?? 60);
    const fanD = Number(dims.fan_d ?? cat!.specs.fan_d ?? 64);
    const hubD = Number(dims.hub_d ?? cat!.specs.hub_d ?? fanD * 0.45);
    const d = scl(z, -1);
    const vanes = it.vanes.map((v) => {
      const j = jointOf(v, `sim.jet(${it.name}): vane ${v}`, "pivot");
      const a = unit(j.axis);
      if (Math.abs(dot(a, z)) > 0.2) fail(`sim.jet(${it.name}): ${v} turns about an axis along the jet; a vane's pivot runs across it`);
      // its planform from its shape: along the pivot (span) and along the jet (chord), mm from the pivot point
      const p0 = scl(j.at, 1000);
      let a0 = Infinity;
      let a1 = -Infinity;
      let c0 = Infinity;
      let c1 = -Infinity;
      for (const pid of bodyById.get(j.body)?.parts ?? []) {
        const vs = props.get(pid)?.verts;
        if (!vs) continue;
        for (let k = 0; k < vs.length; k += 3) {
          const r = sub([vs[k], vs[k + 1], vs[k + 2]], p0);
          const pa = dot(r, a);
          const pc = dot(r, d);
          if (pa < a0) a0 = pa;
          if (pa > a1) a1 = pa;
          if (pc < c0) c0 = pc;
          if (pc > c1) c1 = pc;
        }
      }
      if (!Number.isFinite(a0) && (it.chord === undefined || it.span === undefined)) fail(`sim.jet(${it.name}): ${v} has no shape to size it from; give chord: and span:`);
      const annulus = (fanD - hubD) / 2;
      const span = it.span ?? Math.min(a1 - a0, annulus);
      const chord = it.chord ?? c1 - c0;
      const le = Number.isFinite(c0) ? c0 : -chord / 4;
      const mid = Number.isFinite(a0) ? (a0 + a1) / 2 : 0;
      const cp = add(add(p0, scl(a, mid)), scl(d, le + chord / 4));
      // the duct wall at its root doubles its aspect ratio; Helmbold's low-aspect-ratio lift slope
      const ar = (2 * span) / chord;
      const cla = it.lift ?? (2 * Math.PI * ar) / (2 + Math.sqrt(ar * ar + 4));
      return { joint: j.name, body: j.body, cp: SI(cp), axis: a, area: (span * chord) / 1e6, cla, ar, span, chord };
    });
    const body = bodyIdOf(it.fan, `sim.jet(${it.name})`);
    if (body === FRAME) notes.push(`${it.name}: ${it.fan} is on the frame, so its thrust pushes nothing that moves`);
    jets.push({ name: it.name, fan: it.fan, body, at: SI(add(o, scl(z, -L / 2))), axis: z, vanes: vanes.map(({ span: _s, chord: _c, ...v }) => v), stall: it.stall * D2R, recovery: it.recovery });
    if (vanes.length)
      notes.push(
        `${it.name}: ${vanes.length} vane${vanes.length > 1 ? "s" : ""}, ${vanes.map((v) => `${v.chord.toFixed(0)} × ${v.span.toFixed(0)} mm`).filter((x, i, l) => l.indexOf(x) === i).join(", ")} (chord × span), lift slope ${vanes[0].cla.toFixed(2)} per radian at aspect ratio ${vanes[0].ar.toFixed(2)} with the duct wall at the root, lift held past ${it.stall}°; jet pressure from thrust ÷ (2 × the fan's swept area)`,
      );
  }

  // ---- the ground
  let zmin = Infinity;
  let cx = 0;
  let cy = 0;
  let nb = 0;
  for (const pr of props.values()) {
    zmin = Math.min(zmin, pr.min[2]);
    cx += (pr.min[0] + pr.max[0]) / 2;
    cy += (pr.min[1] + pr.max[1]) / 2;
    nb++;
  }
  if (!Number.isFinite(zmin)) zmin = 0;
  const centre: V3 = [cx / Math.max(1, nb), cy / Math.max(1, nb), zmin];
  let gravity: V3 = [0, 0, -G];
  let ground: MechGround | null = null;
  const fw = scn.world.kind === "floor" ? scn.world.floor : null;
  if (fw) {
    const blocks = fw.blocks.map((b) => ({ min: SI(b.min), max: SI(b.max) }));
    ground = { floor: { p: SI(centre), n: [0, 0, 1] }, blocks, mu: fw.grip, roll: fw.roll, label: fw.surface };
    if (fw.slope > 0) {
      const up = unit([fw.uphill[0], fw.uphill[1], 0]);
      const s = fw.slope * D2R;
      // the slope tilts gravity: down the hill and into it
      gravity = add(scl(up, -G * Math.sin(s)), [0, 0, -G * Math.cos(s)]);
      ground.down = unit(gravity);
      notes.push(`The floor slopes ${fw.slope}° rising along (${fw.uphill.map((x) => +x.toFixed(2)).join(", ")})`);
    }
  } else if (scn.world.kind === "bench" && bodies.some((b) => !b.fixed && b.id !== FRAME)) {
    // the bench top under the machine: moving parts and loose boxes land on it
    ground = { floor: { p: SI(centre), n: [0, 0, 1] }, blocks: [], mu: 0.5, roll: 0.01, label: "bench top" };
  }

  // ---- wheels, tracks, loose boxes
  const wheels = spec.items.flatMap((it) => {
    if (it.k !== "wheel") return [];
    const j = jointOf(it.what, `sim.wheel(${it.what})`, "pivot");
    const b = bodyById.get(j.body)!;
    const centre = add(j.at, scl(j.axis, dot(sub(b.com, j.at), j.axis)));
    let r = (it.d ?? 0) / 2000;
    if (!r) {
      for (const p of byName.get(it.what) ?? []) {
        const v = props.get(p.id)?.verts;
        if (!v) continue;
        for (let k = 0; k < v.length; k += 3) {
          const d = sub([v[k] / 1000, v[k + 1] / 1000, v[k + 2] / 1000], centre);
          r = Math.max(r, len(sub(d, scl(j.axis, dot(d, j.axis)))));
        }
      }
      notes.push(`${it.name}: ${(r * 2000).toFixed(0)} mm across, from its shape`);
    }
    if (!ground) fail(`sim.wheel(${it.what}) needs a floor: world: sim.floor()`);
    return [{ name: it.name, joint: j.name, centre, axis: j.axis, radius: r, grip: it.grip >= 0 ? it.grip : ground!.mu }];
  });
  const tracks = spec.items.flatMap((it) => {
    if (it.k !== "track") return [];
    const j = jointOf(it.sprocket, `sim.track(${it.sprocket})`, "pivot");
    if (!ground) fail(`sim.track(${it.sprocket}) needs a floor: world: sim.floor()`);
    const r = it.d / 2000;
    const up: V3 = [0, 0, 1];
    const fwd = it.toward ? unit(sub(it.toward, scl(j.axis, dot(it.toward, j.axis)))) : unit(cross(j.axis, up));
    const b = bodyById.get(j.body)!;
    const c = add(j.at, scl(j.axis, dot(sub(b.com, j.at), j.axis)));
    const p0 = sub(c, scl(up, r));
    const pts: V3[] = [0, 0.25, 0.5, 0.75, 1].map((f) => add(p0, scl(fwd, (f * it.length) / 1000)));
    return [{ name: it.name, joint: j.name, frame: j.on, points: pts, radius: r, grip: it.grip >= 0 ? it.grip : ground!.mu }];
  });
  const loose = spec.items.flatMap((it) => (it.k === "box" ? [{ id: it.name, size: SI(it.size), mass: it.mass / 1000, at: SI(it.at), grip: it.grip }] : []));
  if (loose.length && !ground) ground = { floor: { p: SI(centre), n: [0, 0, 1] }, blocks: [], mu: 0.5, roll: 0.01, label: "floor" };

  const mounts: Record<string, string> = {};
  for (const g of groups) for (const m of g.members) if (comps.has(m)) mounts[m] = g.id;
  // hall sensors and the magnets they see: where each senses or sits in the design pose
  const magnets: NonNullable<MechModel["magnets"]> = { sensors: [], magnets: [] };
  for (const mc of comps.values()) {
    const cat = catalogPart(mc.catalogId);
    const hall = cat?.kind === "sensor" && cat.specs.iface === "hall";
    if (!cat || (!hall && cat.kind !== "magnet")) continue;
    for (const p of byName.get(mc.name) ?? []) {
      // the component's main solid, not its extra ones (name.parts)
      if (p.id.replace(/#\d+$/, "") !== mc.name) continue;
      if (hall) magnets.sensors.push({ comp: mc.name, at: SI(applyXforms([Number(cat.specs.sense_x ?? 0), Number(cat.specs.sense_y ?? 0), Number(cat.specs.sense_z ?? 0)], p.xf)), range: Number(cat.specs.range_mm ?? 6) / 1000 });
      else {
        const pr = props.get(p.id);
        if (pr) magnets.magnets.push({ comp: mc.name, at: SI(pr.com) });
      }
    }
  }
  const power: Record<string, [number, number][]> = {};
  for (const it of spec.items) if (it.k === "power") power[it.comp] = it.value;
  const follow = spec.follow ? bodyIdOf(spec.follow, "follow") : base === "free" ? FRAME : undefined;

  return {
    mech: { bodies, joints, drives, links, springs, loads, jets: jets.length ? jets : undefined, wheels, tracks, loose, ground, base, gravity, mounts, magnets: magnets.sensors.length ? magnets : undefined, power, follow, notes },
  };
}

function fmtMass(g: number): string {
  return g >= 1000 ? `${(g / 1000).toFixed(g >= 10000 ? 1 : 2)} kg` : `${g.toFixed(g >= 100 ? 0 : 1)} g`;
}

/**
 * A timing belt (lib.belt) on the mechanism's joints. A closed loop links each pulley on a pivot to the
 * driving one; an open belt drives the slider its clamped ends ride on. Each link is as stiff as the belt
 * between the two: both sides stretch against each other, EA over each side's length, so the driven side
 * lags and rings under load the way a real belt does. Pulleys on no joint (idlers on the frame) only guide it.
 */
function beltLinks(b: BeltDef, joints: MechJoint[], bodyOf: Map<string, string>, bodyById: Map<string, MechBody>, links: MechLink[], notes: string[]) {
  const n = b.plane.n;
  const pivotOf = (nd: BeltNode) => {
    if (nd.kind !== "pulley" || !bodyOf.has(nd.name)) return undefined;
    const j = joints.find((x) => x.body === bodyOf.get(nd.name));
    return j?.kind === "pivot" && Math.abs(dot(unit(n), j.axis)) > 0.99 ? j : undefined;
  };
  const on = b.nodes.map(pivotOf);
  let d = b.drive ? b.nodes.findIndex((x) => x.name === b.drive && on[b.nodes.indexOf(x)]) : -1;
  if (d < 0) d = on.findIndex((j) => !!j);
  if (d < 0) return;
  const na = b.nodes[d];
  const ja = on[d]!;
  // a pulley's turn about its joint axis per metre of belt: the belt turns round it one way or the other (dir)
  const perM = (nd: BeltNode, j: MechJoint) => (nd.dir * Math.sign(dot(n, j.axis))) / (nd.r / 1000);
  const ea = b.belt.ea;
  const mesh = (nd: BeltNode) => (nd.r * nd.wrap * Math.PI) / 180;
  const spanFrom = new Map(b.spans.map((s) => [s.from, s]));
  // belt length forward from the middle of one node's wrap to the middle of another's, mm
  const forward = (i: number, k: number) => {
    let l = mesh(b.nodes[i]) / 2 + mesh(b.nodes[k]) / 2;
    for (let j = i; j !== k; j = (j + 1) % b.nodes.length) {
      l += spanFrom.get(b.nodes[j].name)?.length ?? 0;
      if (j !== i) l += mesh(b.nodes[j]);
    }
    return l;
  };
  const added: string[] = [];
  if (!b.open) {
    const driven = b.nodes.map((nd, i) => ({ nd, i, j: on[i] })).filter((x) => x.j && x.i !== d && x.j !== ja);
    for (const { nd, i, j } of driven) {
      const la = Math.max(1, forward(d, i));
      const lb = Math.max(1, b.length - la);
      const kLin = ea / (la / 1000) + ea / (lb / 1000);
      const name = driven.length > 1 ? `${b.name}_${nd.name}` : b.name;
      const ratio = perM(nd, j!) / perM(na, ja);
      // N·m per radian at the driven pulley
      links.push({ kind: "ratio", name, a: ja.name, b: j!.name, ratio, slack: 0, efficiency: 0.98, stiffness: kLin * (nd.r / 1000) ** 2 });
      added.push(`${nd.name} at ${Math.abs(1 / ratio).toFixed(2)}:1, ${fmtK(kLin)}`);
    }
  } else {
    // the belt's ends are clamped to a carriage: it moves with the belt at its start clamp
    const first = spanFrom.get("start");
    if (!first) return;
    const along = unit(sub(first.b3, first.a3));
    const clamp = SI(first.a3);
    const distTo = (j: MechJoint) => Math.min(...(bodyById.get(j.body)?.boxes ?? []).map((x) => Math.max(0, len(sub(clamp, x.c)) - len(x.h))), Infinity);
    const sliders = joints.filter((j) => j.kind === "slider" && Math.abs(dot(j.axis, along)) > 0.95).sort((p, q) => distTo(p) - distTo(q));
    const js = sliders[0];
    if (!js || distTo(js) > 0.05) return;
    const kLin = (b.figures.kShown ?? (4 * ea) / Math.max(1, b.length)) * 1000;
    links.push({ kind: "ratio", name: b.name, a: ja.name, b: js.name, ratio: dot(along, js.axis) / perM(na, ja), slack: 0, efficiency: 0.98, stiffness: kLin });
    added.push(`${js.name} ${(((2 * Math.PI) / Math.abs(perM(na, ja))) * 1000).toFixed(0)} mm a turn, ${fmtK(kLin)}`);
  }
  if (added.length) notes.push(`${b.name}: ${b.open ? "drives" : "turns"} ${added.join("; ")} from ${na.name} (belt stretch from EA ${Math.round(ea)} N; teeth never skip)`);
}

const fmtK = (k: number) => `${(k / 1000).toFixed(0)} N/mm of belt`;
