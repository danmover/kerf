// Puts the real hardware into a design: a screw through every empty screw hole
// with the right thing behind it (a T-nut in a profile's slot, a nut on the far
// face, the thread of a tapped or insert hole, a heat-set insert where the hole
// is cut for one), and corner brackets with their screws and T-nuts in the free
// inside corners of profile joints that nothing joins. Every length is chosen
// so the stack really clamps (the tip a thread past the nut, short of the
// profile's core), preferring lengths sold in hardware-store packs.
//
// It works on the built meshes (the material along each hole's axis is measured
// the way the screw checks measure it) and returns source lines, one component
// per group of identical screws, nuts or brackets, to go after each part.

import type { EvalPart, Model } from "./model";
import { applyXformsToDir, frameFor, vadd, vdot, vnorm, vscale, vsub, type V3 } from "../kernel/recipe";
import { cylEnd, cylMid, lineDistance } from "../analysis/fits/geometry";
import { boxNearSegment, cylsOf, findHolds, isFastener, isProfile, meshIntervals, worldBox, type MeshLookup, type Shank } from "./holds";
import { clearanceSize } from "./completeChecks";
import { headDims, insertDims, nutDims, pickLength, washerDims, type HeadType } from "../library/fasteners";
import type { ThreadSpec } from "../library/standards";
import type { ChecksResult } from "../kernel/protocol";

type Box = [V3, V3];

export interface FastenGroup {
  /** the part the hardware is for: its lines go after that part's block */
  part: string;
  kind: "screw" | "nut" | "tnut" | "insert" | "washer" | "bracket";
  /** lib call, e.g. lib.screw(M5, 12, head: "button") */
  call: string;
  at: V3[];
  axis: V3;
  rotate?: number;
}

export interface FastenPlan {
  groups: FastenGroup[];
  /** what was put where, per part, in words */
  done: { part: string; text: string }[];
  /** holes or joints that could not be fastened, and why */
  skipped: { part: string; why: string }[];
}

export interface FastenOptions {
  /** the parts to fasten (names); all parts with empty screw holes, and all unjoined profile joints, when left out */
  parts?: string[];
  /** contacts and boxes from the kernel, for the profile joints */
  kernel?: ChecksResult | null;
}

const r3 = (x: number) => {
  const v = Math.round(x * 1000) / 1000;
  return Object.is(v, -0) ? 0 : v;
};
const ptText = (p: V3) => `(${p.map(r3).join(", ")})`;
export function axisText(a: V3): string {
  const k = [0, 1, 2].find((i) => Math.abs(Math.abs(a[i]) - 1) < 1e-6);
  if (k !== undefined) return `${a[k] < 0 ? "-" : ""}${"XYZ"[k]}`;
  return `(${a.map((x) => Math.round(x * 1e4) / 1e4).join(", ")})`;
}
const instanceOf = (p: EvalPart) => p.id.split(".")[0];

/** The angle (degrees) to turn a part placed on `axis` so its local +x (dirX) or local +y (dirY) points along `want`. */
function rotateFor(axis: V3, want: V3, local: "x" | "y"): number {
  const { u, v } = frameFor(axis);
  const a = Math.atan2(vdot(want, v), vdot(want, u)) * (180 / Math.PI);
  const deg = local === "x" ? a : a - 90;
  const r = Math.round(((deg % 360) + 360) % 360 * 1000) / 1000;
  return r > 180 ? r - 360 : r;
}

/** A profile's slot lines on the face whose outward normal is `n`: for each, a point on it and the line's direction. */
function slotLines(p: EvalPart, n: V3): { at: V3; dir: V3 }[] {
  const along = vnorm(applyXformsToDir([0, 0, 1], p.xf));
  if (Math.abs(vdot(along, n)) > 0.01) return [];
  const b = worldBox(p);
  if (!b) return [];
  const k = n.findIndex((x) => Math.abs(x) > 0.99);
  const i = along.findIndex((x) => Math.abs(x) > 0.99);
  if (k < 0 || i < 0) return [];
  const j = [0, 1, 2].find((x) => x !== k && x !== i)!;
  const face = n[k] > 0 ? b[1][k] : b[0][k];
  const out: { at: V3; dir: V3 }[] = [];
  for (let c = b[0][j] + 10; c < b[1][j] - 5; c += 20) {
    const at: V3 = [0, 0, 0];
    at[k] = face;
    at[j] = c;
    at[i] = (b[0][i] + b[1][i]) / 2;
    out.push({ at, dir: along });
  }
  return out;
}

/** How far a point is from the nearest slot line on that face (in the face, across the slot), and that line. */
function nearestSlot(p: EvalPart, n: V3, q: V3): { off: number; line: { at: V3; dir: V3 } } | undefined {
  let best: { off: number; line: { at: V3; dir: V3 } } | undefined;
  for (const l of slotLines(p, n)) {
    const d = vsub(q, l.at);
    const across = vsub(d, vscale(l.dir, vdot(d, l.dir)));
    const off = Math.hypot(...vsub(across, vscale(n, vdot(across, n))));
    if (!best || off < best.off) best = { off, line: l };
  }
  return best;
}

interface Hardware {
  screw: Placed["screws"][number];
  nut?: Placed["nuts"][number];
  washers?: Placed["washers"];
}

interface Placed {
  part: EvalPart;
  screws: { t: ThreadSpec; L: number; head: HeadType; at: V3; axis: V3 }[];
  nuts: { t: ThreadSpec; kind: "nut" | "tnut" | "insert"; at: V3; axis: V3; rotate?: number; nyloc?: boolean }[];
  washers: { t: ThreadSpec; at: V3; axis: V3 }[];
  brackets: { size: "2020" | "2040"; at: V3; axis: V3; rotate: number }[];
}

/** T-nut depth below the profile face, and how deep a screw may go before it meets the core. */
const TNUT_DEPTH = 4;
const CORE_DEPTH = 6;

/** Plan the hardware. Needs the parts' meshes. */
export function planFasteners(model: Model, mesh: MeshLookup, opts: FastenOptions = {}): FastenPlan {
  const parts = model.parts.filter((p) => !p.hidden && !(p.imported && p.imported.kind !== "solid"));
  const want = opts.parts ? new Set(opts.parts) : null;
  const plan: FastenPlan = { groups: [], done: [], skipped: [] };
  const placed = new Map<string, Placed>();
  const slot = (p: EvalPart) => placed.get(p.name) ?? placed.set(p.name, { part: p, screws: [], nuts: [], washers: [], brackets: [] }).get(p.name)!;
  const fillers = parts.flatMap((p) => cylsOf(p).filter((c) => c.side === "shaft" || c.role === "screw").map((c) => ({ p, c })));
  // what the planned hardware fills, so two parts sharing a hole get one screw
  const planned: { at: V3; axis: V3; len: number }[] = [];
  const filled = (p: EvalPart, at: V3, axis: V3, len: number, d: number) =>
    fillers.some(({ p: q, c }) => {
      if (q === p || Math.abs(vdot(c.axis, axis)) < 0.995 || lineDistance(cylMid(c), at, axis) > Math.max(0.4, 0.1 * d)) return false;
      const a = vdot(vsub(c.at, at), axis);
      const b = vdot(vsub(cylEnd(c), at), axis);
      return Math.max(a, b) > -1 && Math.min(a, b) < len + 1;
    }) || planned.some((s) => Math.abs(vdot(s.axis, axis)) > 0.995 && lineDistance(s.at, at, axis) < Math.max(0.4, 0.1 * d));

  // ---- a screw through each empty clearance hole ----
  for (const p of parts) {
    if (isFastener(p) || p.libKind === "corner_bracket") continue;
    if (want && !want.has(p.name)) continue;
    if (!want && (p.kind !== "part" || p.processNone)) continue;
    const m = mesh(p.hash);
    if (!m) continue;
    for (const h of cylsOf(p)) {
      if (h.side !== "hole" || h.holeFit === "cbore" || h.role !== "plain") continue;
      const t = clearanceSize(h.d);
      if (!t) continue;
      if (filled(p, h.at, h.axis, h.length, h.d)) continue;
      const res = planHole(p, h.at, h.axis, h.length, t, parts, mesh);
      if ("why" in res) {
        plan.skipped.push({ part: p.name, why: res.why });
        continue;
      }
      planned.push({ at: h.at, axis: h.axis, len: h.length });
      const s = slot(p);
      s.screws.push(res.screw);
      if (res.nut) s.nuts.push(res.nut);
      if (res.washers) s.washers.push(...res.washers);
    }
  }

  // ---- corner brackets on profile joints nothing joins ----
  if (opts.kernel?.contacts) {
    const holds = findHolds(model, mesh);
    const root = new Map<string, string>();
    const find = (x: string): string => {
      let r = x;
      while (root.has(r) && root.get(r) !== r) r = root.get(r)!;
      return r;
    };
    for (const j of holds.joins) if (j.kind !== "band") root.set(find(j.a.id), find(j.b.id));
    const byId = new Map(parts.map((p) => [p.id, p]));
    const taken: Box[] = [];
    for (const c of opts.kernel.contacts) {
      const a = byId.get(c.a);
      const b = byId.get(c.b);
      if (!a || !b || !isProfile(a) || !isProfile(b) || instanceOf(a) === instanceOf(b)) continue;
      if (want && !want.has(a.name) && !want.has(b.name)) continue;
      if (find(a.id) === find(b.id)) continue;
      const got = planJoint(a, b, parts, taken) ?? planJoint(b, a, parts, taken);
      if (!got) {
        plan.skipped.push({ part: a.name, why: `no free inside corner for a bracket where ${a.id} meets ${b.id} (or the slots do not line up): join them with a plate screwed into both` });
        continue;
      }
      root.set(find(a.id), find(b.id));
      const s = slot(got.x);
      for (const br of got.brackets) {
        s.brackets.push(br);
        s.screws.push(...br.screws);
        s.nuts.push(...br.nuts);
      }
    }
  }

  // ---- group into components ----
  const used = new Set(model.parts.map((p) => p.name));
  const nameFor = (base: string) => {
    let n = base;
    for (let i = 2; used.has(n); i++) n = `${base}_${i}`;
    used.add(n);
    return n;
  };
  for (const s of placed.values()) {
    const g = new Map<string, FastenGroup>();
    const add = (kind: FastenGroup["kind"], call: string, at: V3, axis: V3, rotate?: number) => {
      const key = `${kind}|${call}|${axisText(axis)}|${rotate ?? ""}`;
      const e = g.get(key) ?? { part: s.part.name, kind, call, at: [], axis, rotate };
      e.at.push(at);
      g.set(key, e);
    };
    for (const b of s.brackets) add("bracket", `lib.corner_bracket("${b.size}")`, b.at, b.axis, b.rotate);
    for (const sc of s.screws) add("screw", `lib.screw(${sc.t.name.replace(".", "_")}, ${r3(sc.L)}${sc.head !== "socket" ? `, head: "${sc.head}"` : ""})`, sc.at, sc.axis);
    for (const w of s.washers) add("washer", `lib.washer(${w.t.name.replace(".", "_")})`, w.at, w.axis);
    for (const n of s.nuts) {
      const size = n.t.name.replace(".", "_");
      const call = n.kind === "tnut" ? `lib.nut(${size}, type: "tslot20")` : n.kind === "insert" ? `lib.insert(${size})` : `lib.nut(${size}${n.nyloc ? ', type: "nyloc"' : ""})`;
      add(n.kind === "tnut" ? "tnut" : n.kind === "insert" ? "insert" : "nut", call, n.at, n.axis, n.rotate);
    }
    plan.groups.push(...g.values());
    const count = (k: FastenGroup["kind"]) => [...g.values()].filter((x) => x.kind === k).reduce((n, x) => n + x.at.length, 0);
    const words = [
      [count("bracket"), "corner bracket"],
      [count("screw"), "screw"],
      [count("tnut"), "T-nut"],
      [count("nut"), "nut"],
      [count("insert"), "insert"],
      [count("washer"), "washer"],
    ]
      .filter(([n]) => n)
      .map(([n, w]) => `${n} ${w}${n === 1 ? "" : "s"}`);
    plan.done.push({ part: s.part.name, text: words.join(", ") });
  }
  for (const gr of plan.groups) {
    const base = `${gr.part}_${gr.kind === "tnut" ? "tnuts" : gr.kind === "bracket" ? "brackets" : `${gr.kind}s`}`;
    (gr as FastenGroup & { name?: string }).name = nameFor(base);
  }
  return plan;
}

/** A screw through one hole: measure the material along its axis and choose what is behind it. */
function planHole(p: EvalPart, at: V3, axis: V3, len: number, t: ThreadSpec, parts: EvalPart[], mesh: MeshLookup): Hardware | { why: string } {
  const R = 80;
  const hd = headDims("socket", t);
  const headD = hd?.d ?? t.head_d;
  const sh: Shank = { seat: at, axis, length: R, d: t.d, headD };
  const near = parts.filter((q) => {
    if (isFastener(q) && q.libKind !== "nut" && q.libKind !== "insert") return false;
    const b = worldBox(q, mesh);
    return !!b && boxNearSegment(b, vsub(at, vscale(axis, R)), axis, 2 * R, headD / 2 + 0.5);
  });
  const layers: { part: EvalPart; a: number; b: number }[] = [];
  for (const q of near) {
    const m = mesh(q.hash);
    if (!m) continue;
    const iv = meshIntervals(q, m, sh, -R, R);
    for (const [a, b] of iv ?? []) layers.push({ part: q, a, b });
  }
  // the hole's own wall: the layer of p round the hole's middle
  const mid = len / 2;
  const own = layers.filter((l) => l.part === p).sort((x, y) => Math.abs((x.a + x.b) / 2 - mid) - Math.abs((y.a + y.b) / 2 - mid))[0];
  if (!own) return { why: `could not measure the material round its ${t.name} hole at ${ptText(at)}` };
  const reasons: string[] = [];
  for (const dir of [1, -1]) {
    const res = tryDirection(p, own, layers, at, axis, dir, t, parts, mesh);
    if ("screw" in res) return res;
    reasons.push(res.why);
  }
  // the reason from the side the head fits on says what to change
  const why = reasons.find((r) => !r.startsWith("no room for the head")) ?? reasons[0];
  return { why: `${t.name} hole at ${ptText(at)}: ${why}` };
}

function tryDirection(p: EvalPart, own: { a: number; b: number }, layers: { part: EvalPart; a: number; b: number }[], at: V3, axis0: V3, dir: number, t: ThreadSpec, parts: EvalPart[], mesh: MeshLookup): Hardware | { why: string } {
  // distances along the screw (dir), from the head's seat
  const axis = vscale(axis0, dir);
  const s = (x: number) => x * dir;
  const L = layers.map((l) => ({ part: l.part, a: Math.min(s(l.a), s(l.b)), b: Math.max(s(l.a), s(l.b)) }));
  const ownA = Math.min(s(own.a), s(own.b));
  const ownB = Math.max(s(own.a), s(own.b));
  const point = (x: number) => vadd(at, vscale(axis, x));
  const head = headDims("socket", t)!;
  // room for the head: nothing else in the way just above the seat
  const blocked = L.find((l) => l.part !== p && l.b > ownA - head.h - 0.5 && l.a < ownA - 0.05);
  if (blocked) return { why: `no room for the head (${blocked.part.name} is in the way)` };
  // the parts the screw passes through, each against the next
  let x = ownB;
  const through: EvalPart[] = [p];
  for (let guard = 0; guard < 6; guard++) {
    const next = L.filter((l) => l.part !== p && !through.includes(l.part) && l.a >= x - 0.3 && l.a <= x + 0.3).sort((a, b) => a.a - b.a)[0];
    const prof = parts.find((q) => isProfile(q) && !through.includes(q) && profileFaceAt(q, point(x), axis));
    if (prof) {
      const n = vscale(axis, -1);
      const slotAt = nearestSlot(prof, n, point(x));
      if (!slotAt) return { why: `it meets the end of ${prof.name} (tap the profile's end bore instead)` };
      if (slotAt.off > 0.6) return { why: `it is ${r3(slotAt.off)} mm off ${prof.name}'s slot line` };
      const grip = x - ownA;
      // the tip a thread past the T-nut and short of the core: a window of about a millimetre, so washers under the head make up a length the shops sell
      const wh = washerDims("flat", t)?.h ?? 1;
      for (let k = 0; k <= 3; k++) {
        const pick = pickLength("socket", t, grip + k * wh + TNUT_DEPTH + 0.8, grip + k * wh + CORE_DEPTH);
        if (!pick) continue;
        const washers = Array.from({ length: k }, (_, i) => ({ t, at: point(ownA - (i + 1) * wh), axis }));
        return {
          screw: { t, L: pick.length, head: "socket", at: point(ownA - k * wh), axis },
          nut: { t, kind: "tnut", at: point(x), axis, rotate: rotateFor(axis, slotAt.line.dir, "y") },
          washers,
        };
      }
      return { why: `no stocked ${t.name} length between ${r3(grip + TNUT_DEPTH + 0.8)} and ${r3(grip + CORE_DEPTH)} mm, even with washers (the part is ${r3(grip)} mm thick there: counterbore it so a ${t.name} × 10 or 12 reaches)` };
    }
    if (!next) break;
    const q = next.part;
    // a hole in the next part on the same axis: threaded, insert, or clearance to go on through
    const hole = cylsOf(q).find((c) => c.side === "hole" && Math.abs(vdot(c.axis, axis)) > 0.995 && lineDistance(cylMid(c), at, axis) < Math.max(0.3, 0.05 * c.d) && c.holeFit !== "cbore");
    const bought = q.kind === "component" && !isFastener(q);
    if (!hole && !bought) return { why: `${q.name} has no hole on its axis (cut hole(${t.name.replace(".", "_")}, fit: "insert") or a through hole for a nut in it)` };
    const grip = x - ownA;
    const depth = next.b - next.a;
    if (hole && (hole.role === "thread" || (hole.d < t.d - 0.2 && q.libKind !== "nut"))) {
      const insert = hole.holeFit === "insert";
      const ins = insert ? insertDims(t) : null;
      const engage = insert ? (ins?.length ?? 1.5 * t.d) : Math.min(1.5 * t.d, depth - 0.5);
      const pick = pickLength("socket", t, grip + Math.min(engage, depth - 0.5) - 0.01, grip + depth - 0.5);
      if (!pick) return { why: `no stocked ${t.name} length to reach into ${q.name}'s ${insert ? "insert" : "tapped hole"} (${r3(grip)} mm grip, ${r3(depth)} mm deep)` };
      return { screw: { t, L: pick.length, head: "socket", at: point(ownA), axis }, nut: insert ? { t, kind: "insert", at: point(x), axis } : undefined };
    }
    if (hole && clearanceSize(hole.d)?.name === t.name) {
      through.push(q);
      x = next.b;
      continue;
    }
    if (bought && !hole) {
      // a bought part's own threaded holes (a motor face, a rail carriage): a short screw into its thread
      const pick = pickLength("socket", t, grip + Math.min(1.5 * t.d, 4), grip + Math.min(depth - 0.5, 6));
      if (!pick) return { why: `no stocked ${t.name} length to reach into ${q.name}'s thread` };
      return { screw: { t, L: pick.length, head: "socket", at: point(ownA), axis } };
    }
    return { why: `${q.name}'s hole there is not a ${t.name} clearance or thread` };
  }
  if (through.length < 2) return { why: "nothing behind it to fasten to" };
  // a nut on the last part's far face, with room for it
  const nd = nutDims("hex", t);
  if (!nd) return { why: `no ${t.name} nut` };
  const room = L.find((l) => !through.includes(l.part) && l.a < x + nd.h + 0.5 && l.b > x + 0.05);
  if (room) return { why: `no room for a nut behind ${through[through.length - 1].name} (${room.part.name} is in the way)` };
  const grip = x - ownA;
  const moves = through.some((q) => q.motion);
  const pick = pickLength("socket", t, grip + nd.h + Math.max(0.8, 2 * t.pitch), grip + nd.h + 8);
  if (!pick) return { why: `no stocked ${t.name} length for a ${r3(grip)} mm grip and a nut` };
  return { screw: { t, L: pick.length, head: "socket", at: point(ownA), axis }, nut: { t, kind: "nut", at: point(x), axis, nyloc: moves } };
}

/** Is q a face of this profile, met from outside along `axis` (the screw going into the profile)? */
function profileFaceAt(prof: EvalPart, q: V3, axis: V3): boolean {
  const b = worldBox(prof);
  if (!b) return false;
  const k = axis.findIndex((x) => Math.abs(x) > 0.99);
  if (k < 0) return false;
  const face = axis[k] > 0 ? b[0][k] : b[1][k];
  if (Math.abs(q[k] - face) > 0.3) return false;
  return [0, 1, 2].every((i) => i === k || (q[i] > b[0][i] + 0.5 && q[i] < b[1][i] - 0.5));
}

// ---------- corner brackets ----------

interface JointPlan {
  x: EvalPart;
  brackets: (Placed["brackets"][number] & { screws: Placed["screws"]; nuts: Placed["nuts"] })[];
}

/**
 * Brackets where profile x meets profile y's face: in each inside corner between a long face of x and y's face that
 * has room for a bracket's leg on y and slots where both legs' screws go.
 */
function planJoint(x: EvalPart, y: EvalPart, parts: EvalPart[], taken: Box[]): JointPlan | null {
  const bx = worldBox(x);
  const by = worldBox(y);
  if (!bx || !by) return null;
  // the contact: x sits on y's face along axis k
  let k = -1;
  let mSign = 0;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(bx[0][i] - by[1][i]) < 0.3) (k = i), (mSign = 1);
    else if (Math.abs(bx[1][i] - by[0][i]) < 0.3) (k = i), (mSign = -1);
  }
  if (k < 0) return null;
  const m: V3 = [0, 0, 0];
  m[k] = mSign;
  const plane = mSign > 0 ? by[1][k] : by[0][k];
  const xAlong = vnorm(applyXformsToDir([0, 0, 1], x.xf));
  const yAlong = vnorm(applyXformsToDir([0, 0, 1], y.xf));
  if (![xAlong, yAlong].every((d) => d.some((c) => Math.abs(c) > 0.999))) return null;
  const T = 3;
  const SLOT = [8.5, 12.5];
  const out: JointPlan["brackets"] = [];
  const t = { name: "M5", d: 5, pitch: 0.8 } as ThreadSpec;
  for (let j = 0; j < 3; j++) {
    if (j === k || Math.abs(xAlong[j]) > 0.5) continue;
    for (const sg of [1, -1]) {
      const n: V3 = [0, 0, 0];
      n[j] = sg;
      const face = sg > 0 ? bx[1][j] : bx[0][j];
      // room on y's face for leg A
      const yEdge = sg > 0 ? by[1][j] : by[0][j];
      if ((yEdge - face) * sg < 19.5) continue;
      const i = [0, 1, 2].find((q) => q !== j && q !== k)!;
      const w: V3 = [0, 0, 0];
      w[i] = 1;
      const lo = Math.max(bx[0][i], by[0][i]);
      const hi = Math.min(bx[1][i], by[1][i]);
      // where the bracket's middle can go across the joint, and the slot positions that fix it
      const xSlots = slotLines(x, n);
      const ySlots = slotLines(y, m);
      const centres: number[] = [];
      const xAcross = Math.abs(xAlong[k]) > 0.99; // x stands on y: its slots run up from the joint, at fixed i
      const yAcross = Math.abs(yAlong[j]) > 0.99; // y's slots run along n, at fixed i
      if (xAcross) for (const l of xSlots) centres.push(l.at[i]);
      else if (yAcross) for (const l of ySlots) centres.push(l.at[i]);
      else centres.push((lo + hi) / 2);
      for (const ci of centres) {
        if (ci - 10 < lo - 0.5 || ci + 10 > hi + 0.5) continue;
        if (yAcross && !ySlots.some((l) => Math.abs(l.at[i] - ci) < 0.6)) continue;
        // leg B's screw height: on x's slot line when x's slots run across the joint, else free
        let sb = 12.5;
        if (!xAcross) {
          const hs = xSlots.map((l) => (l.at[k] - plane) * mSign).filter((h) => h >= SLOT[0] - 0.01 && h <= SLOT[1] + 0.01);
          if (!hs.length) continue;
          sb = hs[0];
        }
        // leg A's screw distance out from x's face: on y's slot line when y's slots run across n, else free
        let sa = 12.5;
        if (!yAcross) {
          const ds = ySlots.map((l) => (l.at[j] - face) * sg).filter((d) => d >= SLOT[0] - 0.01 && d <= SLOT[1] + 0.01);
          if (!ds.length) continue;
          sa = ds[0];
        }
        if (Math.max(sa, sb) < 10.5) sa = yAcross ? 12.5 : sa;
        if (Math.max(sa, sb) < 10.5) continue;
        const corner: V3 = [0, 0, 0];
        corner[k] = plane;
        corner[j] = face;
        corner[i] = ci;
        // the bracket's room: nothing else there
        const p1 = vadd(corner, vadd(vscale(n, 20), vscale(m, 20)));
        const box: Box = [corner.map((c, q) => Math.min(c, p1[q])) as V3, corner.map((c, q) => Math.max(c, p1[q])) as V3];
        box[0][i] = ci - 10;
        box[1][i] = ci + 10;
        const shrink = (b: Box): Box => [b[0].map((v) => v + 0.2) as V3, b[1].map((v) => v - 0.2) as V3];
        const inner = shrink(box);
        const clash = parts.some((q) => q !== x && q !== y && !isFastener(q) && overlap(inner, worldBox(q))) || taken.some((b) => overlap(inner, b));
        if (clash) continue;
        taken.push(box);
        const rotate = rotateFor(m, n, "x");
        const screws: Placed["screws"] = [];
        const nuts: Placed["nuts"] = [];
        const la = pickLength("button", t, T + TNUT_DEPTH + 0.8, T + CORE_DEPTH)?.length ?? 8;
        const off = vscale(w, 0);
        // leg A: down into y's slot
        const aAt = vadd(vadd(corner, vscale(n, sa)), off);
        screws.push({ t, L: la, head: "button", at: vadd(aAt, vscale(m, T)), axis: vscale(m, -1) });
        nuts.push({ t, kind: "tnut", at: aAt, axis: vscale(m, -1), rotate: rotateFor(vscale(m, -1), yAlong, "y") });
        // leg B: across into x's slot
        const bAt = vadd(vadd(corner, vscale(m, sb)), off);
        screws.push({ t, L: la, head: "button", at: vadd(bAt, vscale(n, T)), axis: vscale(n, -1) });
        nuts.push({ t, kind: "tnut", at: bAt, axis: vscale(n, -1), rotate: rotateFor(vscale(n, -1), xAlong, "y") });
        out.push({ size: "2020", at: corner, axis: m, rotate, screws, nuts });
        break;
      }
    }
  }
  return out.length ? { x, brackets: out } : null;
}

const overlap = (a: Box, b: Box | null) => !!b && a[0].every((_, i) => a[0][i] < b[1][i] && b[0][i] < a[1][i]);

/** The plan as source text: one component line per group, keyed by the part each goes after. */
export function planLines(plan: FastenPlan): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const g of plan.groups) {
    const name = (g as FastenGroup & { name?: string }).name!;
    const at = g.at.length === 1 ? ptText(g.at[0]) : `[${g.at.map(ptText).join(", ")}]`;
    const props = [`at: ${at}`, `axis: ${axisText(g.axis)}`, ...(g.rotate ? [`rotate: ${r3(g.rotate)}`] : [])];
    const line = `component ${name} = ${g.call} { ${props.join(", ")} }`;
    out.set(g.part, [...(out.get(g.part) ?? []), line]);
  }
  return out;
}

/** Insert the plan's lines after each part's statement in the source. */
export function applyFastenPlan(src: string, model: Model, plan: FastenPlan): string {
  const lines = planLines(plan);
  const edits: { at: number; text: string }[] = [];
  for (const [part, ls] of lines) {
    const p = model.parts.find((q) => q.name === part);
    if (!p?.span) continue;
    // after the end of the line the statement ends on
    let at = src.indexOf("\n", p.span.end);
    if (at < 0) at = src.length;
    edits.push({ at, text: `\n${ls.join("\n")}` });
  }
  edits.sort((a, b) => b.at - a.at);
  let out = src;
  for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.at);
  return out;
}

