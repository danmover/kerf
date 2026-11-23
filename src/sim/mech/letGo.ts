// "Let go": the design under gravity with hands off, for the 3D view. It is
// the same rigid-body solver the simulations use, set up from the design
// alone: every part that turns or slides is a body on its joint, gears,
// belts and connecting rods tie them together, and each drive is held by
// exactly what the gravity checks found holding it (a screw or belt that
// carries a lift, a motor up to the torque it can hold with, a held: the
// design states) and by nothing else. Parts the hold checks found fastened
// to nothing come off the machine and fall as loose boxes onto whatever is
// under them. So what drops here is what those checks fail, and what stays
// is what they pass.

import type { ChecksResult } from "../../kernel/protocol";
import type { MeshEntry } from "../../core/engine";
import { gravityHolds } from "../../core/gravityChecks";
import { unheldParts } from "../../core/holdChecks";
import { findHolds, isFastener, motionOfPart, type MeshLookup } from "../../core/holds";
import type { Mat4 } from "../../core/kinematics";
import { turns, type EvalPart, type Model, type Motion } from "../../core/model";
import { massBodies } from "../../core/stability";
import type { ScenarioSpec } from "../scenario";
import type { MechItem } from "./lang";
import { FRAME, type MechJoint, type MechModel } from "./model";
import { resolveMechanism } from "./resolve";
import { qrot, type Body, type V3 } from "./solver";
import { MECH_FACTORS, MechSystem } from "./system";

/** A hold nothing drawn can overcome (a screw and nut, a clamped belt): N or N·m. */
const RIGID = 1e7;
/** How hard swings are damped so a free arm comes to rest in a few swings (a share of critical). */
const SETTLE_DAMPING = 0.15;
/** Still: under 3 mm/s and 0.03 rad/s for this long, s. */
const STILL_FOR = 0.35;
const STILL_V = 0.003;
const STILL_W = 0.03;
/** The longest a preview runs, s. */
const LONGEST = 20;
const STEP = 1e-3;

export interface LetGoHold {
  /** the joint held, and what holds it as a person would say it */
  joint: string;
  by: string;
  /** N for a slide, N·m for a turn */
  limit: number;
}

export interface LetGoPlan {
  mech: MechModel;
  /** the body each part that can move is drawn with, by part id (parts not here stay where they are) */
  bodyOf: Map<string, string>;
  /** what each body is called */
  names: Map<string, string>;
  holds: LetGoHold[];
  /** bodies free to go (nothing holds them along their joint), and loose groups */
  free: string[];
  /**
   * Lifts nothing holds that are drawn at the low end of their travel: the run starts with each at the other end,
   * since "let go" of one already at the bottom would show nothing. By body id.
   */
  raised: string[];
}

export interface LetGoOptions {
  /** damping added to free pivots so swings die away (a share of critical; 0 for none) */
  damping?: number;
}

/** What a body did between being let go and now. */
export interface LetGoMove {
  name: string;
  /** "fell": a loose group; "slid": along its guide; "swung": about its pivot */
  how: "fell" | "slid" | "swung";
  /** mm for fell and slid, degrees for swung */
  amount: number;
  /** how far its centre of mass went down, mm */
  drop: number;
}

const listOf = (names: string[]): string => (names.length <= 1 ? (names[0] ?? "") : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names[0]}, ${names[1]} and ${names.length - 2} more`);

/**
 * Sets the design up to be let go. Null when nothing in it can move under gravity (no moving part and nothing
 * unheld); an error when the mechanism does not resolve.
 */
export function planLetGo(model: Model, geom: (hash: string) => MeshEntry | undefined, kernel: ChecksResult, mesh: MeshLookup, volume: (p: EvalPart) => number | undefined, opts: LetGoOptions = {}): LetGoPlan | { error: string } | null {
  const boxes = kernel.boxes;
  if (!boxes) return null;
  const holds = findHolds(model, mesh);
  const { drives } = gravityHolds(model, holds, kernel, mesh, volume);
  const found = unheldParts(model, holds, kernel, volume);

  // parts fastened to nothing: off the machine, and a loose box in their place. A group that only rests on
  // something stays where it is unless what it rests on can move away under it.
  const visible = model.parts.filter((p) => !p.hidden && !(p.imported && p.imported.kind !== "solid") && boxes[p.id]);
  const weights = new Map(massBodies(visible, boxes, mesh, volume).map((b) => [b.p.id, b.g]));
  const moves = (p: EvalPart) => turns(motionOfPart(p, holds));
  const items: MechItem[] = [];
  const offIds: string[] = [];
  const looseOf = new Map<string, string>();
  const names = new Map<string, string>();
  const free: string[] = [];
  for (const u of found?.unheld ?? []) {
    if (u.why === "rests" && !u.on.some(moves)) continue;
    let min: V3 = [Infinity, Infinity, Infinity];
    let max: V3 = [-Infinity, -Infinity, -Infinity];
    let grams = 0;
    for (const p of u.members) {
      const b = boxes[p.id];
      if (!b) continue;
      min = [Math.min(min[0], b[0][0]), Math.min(min[1], b[0][1]), Math.min(min[2], b[0][2])];
      max = [Math.max(max[0], b[1][0]), Math.max(max[1], b[1][1]), Math.max(max[2], b[1][2])];
      grams += weights.get(p.id) ?? 0;
    }
    if (!(max[0] > min[0])) continue;
    const id = `loose ${items.length + 1}`;
    // a little in from its faces, so one that sits on something starts on it, not in it
    const size: V3 = [Math.max(0.5, max[0] - min[0] - 0.2), Math.max(0.5, max[1] - min[1] - 0.2), Math.max(0.5, max[2] - min[2] - 0.2)];
    items.push({ k: "box", name: id, size, mass: Math.max(0.05, grams), at: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2], grip: 0.5 });
    for (const p of u.members) {
      offIds.push(p.id);
      looseOf.set(p.id, id);
    }
    names.set(id, listOf(u.shown.filter((p) => !isFastener(p)).map((p) => p.name)));
    free.push(id);
  }

  if (!items.length && !visible.some(moves)) return null;
  const spec: ScenarioSpec = {
    label: "Let go",
    world: { kind: "bench", bench: { loads: {}, loadFactor: 1, forces: {}, force: 0, range: 1000, ambient: 20, signals: [] } },
    physicsOnly: true,
    mechanism: { items, auto: true, base: "fixed", offIds, shapes: items.length > 0 },
    duration: LONGEST,
    console: [],
    config: {},
    variants: ["expected"],
    charge: 1,
    seed: 1,
  };
  const res = resolveMechanism(spec, model, geom, true);
  if ("error" in res) return { error: res.error };
  if ("waiting" in res) return { error: "the design is still building" };
  const mech = res.mech;

  const bodyOf = new Map<string, string>(looseOf);
  const motionBody = new Map<Motion, string>();
  const partById = new Map(model.parts.map((p) => [p.id, p]));
  for (const b of mech.bodies) {
    if (b.id === FRAME || b.fixed) continue;
    names.set(b.id, b.label);
    for (const id of b.parts) {
      bodyOf.set(id, b.id);
      const m = partById.get(id)?.motion;
      if (m && !motionBody.has(m)) motionBody.set(m, b.id);
    }
  }
  const jointOn = (m: Motion): MechJoint | undefined => {
    const b = motionBody.get(m);
    return b === undefined ? undefined : mech.joints.find((j) => j.body === b && (j.kind === "pivot" || j.kind === "slider"));
  };

  // each drive held by what the gravity checks found holding it
  const held: LetGoHold[] = [];
  const hold = (j: MechJoint, by: string, limit: number) => {
    const was = held.find((h) => h.joint === j.name);
    if (was) {
      was.limit = Math.min(RIGID, was.limit + limit);
      return;
    }
    held.push({ joint: j.name, by, limit });
  };
  for (const d of drives) {
    const root = jointOn(d.load.root);
    if (d.by === "carried" || d.by === "stated") {
      // a rope to a winch the solver has tied in passes the weight on to the winch's motor, which holds it or does not
      if (root && d.rope && mech.links.some((l) => l.kind === "ratio" && l.name === d.rope && l.b === root.name)) continue;
      if (root) hold(root, d.by === "stated" ? "as the design says it is held" : "by what carries it", RIGID);
      continue;
    }
    // a rotor as good as balanced: the checks leave the little its weight is off its axis to friction, and so does this
    if (d.by === "nothing" && d.balanced && d.load.kind === "turn") {
      if (root && root.kind === "pivot") hold(root, "by its own balance", Math.max(1e-4, (2 * Math.abs(d.load.peak)) / 1000));
      continue;
    }
    if (d.by === "motor") {
      // a motor the maker gives no torque for still drives it: taken as holding
      if (!d.motors?.length) {
        if (root) hold(root, "by its motor", RIGID);
        continue;
      }
      for (const m of d.motors) {
        const j = jointOn(m.shaft);
        if (j) hold(j, `by ${m.comp}`, j.kind === "pivot" ? m.torque / 1000 : RIGID);
        else if (root && Math.abs(d.load.root.ratio) > 1e-12) hold(root, `by ${m.comp}`, (m.torque / 1000) * Math.abs(m.shaft.ratio / d.load.root.ratio));
      }
    }
  }
  // a lift nothing holds, drawn at the bottom of its travel, is let go from the top of it
  const raised: string[] = [];
  const tied = new Set<string>();
  // (a rope from a winch does not stop a lift being raised: it follows, and its drum is turned by the fall)
  const ropes = new Set((model.machine?.ropes ?? []).map((r) => r.name));
  for (const l of mech.links) if (!(l.kind === "ratio" && ropes.has(l.name))) for (const k of ["a", "b", "pinion", "rack", "screw", "follower", "cam"] as const) if (k in l) tied.add((l as unknown as Record<string, string>)[k]);
  for (const d of drives) {
    if (d.by !== "nothing" || d.load.kind !== "lift") continue;
    const j = jointOn(d.load.root);
    if (!j || j.kind !== "slider" || !j.limits || j.on !== FRAME || tied.has(j.name) || tied.has(j.body)) continue;
    if (mech.joints.some((o) => o !== j && (o.body === j.body || o.on === j.body) && o.kind === "ball")) continue;
    // which way is down along its travel
    const pull = j.axis[0] * mech.gravity[0] + j.axis[1] * mech.gravity[1] + j.axis[2] * mech.gravity[2];
    if (Math.abs(pull) < 0.5) continue;
    const [lo, hi] = j.limits;
    const low = pull < 0 ? lo : hi;
    const high = pull < 0 ? hi : lo;
    if (Math.abs(low) > 5e-4 || Math.abs(high - low) < 2e-3) continue;
    j.start = high;
    raised.push(j.body);
  }
  for (const h of held) mech.drives.push({ kind: "turn", name: `hold ${h.joint}`, joint: h.joint, speed: [[0, 0]], limit: h.limit });
  // what a rope ties to a held winch is held through the rope
  const roped = new Set<string>();
  for (const l of mech.links) {
    if (l.kind !== "ratio" || !ropes.has(l.name)) continue;
    if (held.some((h) => h.joint === l.a)) roped.add(l.b);
    if (held.some((h) => h.joint === l.b)) roped.add(l.a);
  }
  for (const j of mech.joints) if ((j.kind === "pivot" || j.kind === "slider") && !held.some((h) => h.joint === j.name) && !roped.has(j.name) && !free.includes(j.body)) free.push(j.body);

  // swings die away: each free pivot damped by a share of critical for what hangs on it
  const zeta = opts.damping ?? SETTLE_DAMPING;
  if (zeta > 0) {
    const byId = new Map(mech.bodies.map((b) => [b.id, b]));
    const kids = (id: string): string[] => mech.joints.filter((j) => j.on === id && j.body !== id).flatMap((j) => [j.body, ...kids(j.body)]);
    const g = Math.hypot(...mech.gravity);
    for (const j of mech.joints) {
      if (j.kind !== "pivot") continue;
      let m = 0;
      const c: V3 = [0, 0, 0];
      let I = 0;
      for (const id of new Set([j.body, ...kids(j.body)])) {
        const b = byId.get(id);
        if (!b) continue;
        const r: V3 = [b.com[0] - j.at[0], b.com[1] - j.at[1], b.com[2] - j.at[2]];
        const along = r[0] * j.axis[0] + r[1] * j.axis[1] + r[2] * j.axis[2];
        const d2 = r[0] * r[0] + r[1] * r[1] + r[2] * r[2] - along * along;
        const a = j.axis;
        const In = b.inertia;
        I += a[0] * (In[0] * a[0] + In[1] * a[1] + In[2] * a[2]) + a[1] * (In[3] * a[0] + In[4] * a[1] + In[5] * a[2]) + a[2] * (In[6] * a[0] + In[7] * a[1] + In[8] * a[2]) + b.mass * d2;
        m += b.mass;
        for (let k = 0; k < 3; k++) c[k] += b.mass * r[k];
      }
      if (!(m > 0)) continue;
      const along = (c[0] * j.axis[0] + c[1] * j.axis[1] + c[2] * j.axis[2]) / m;
      const arm = Math.sqrt(Math.max(0, (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]) / (m * m) - along * along));
      j.damping = (j.damping ?? 0) + 2 * zeta * Math.sqrt(I * m * g * arm);
    }
  }

  // loose things only meet what is under or beside them: the rest of the frame's boxes are left out of the run
  const frame = mech.bodies.find((b) => b.id === FRAME);
  if (frame && mech.loose.length) {
    const near = (bx: { c: V3; h: V3 }) =>
      mech.loose.some((l) => {
        const reach = Math.max(l.size[0], l.size[1], l.size[2]);
        return Math.abs(bx.c[0] - l.at[0]) <= bx.h[0] + l.size[0] / 2 + reach && Math.abs(bx.c[1] - l.at[1]) <= bx.h[1] + l.size[1] / 2 + reach && bx.c[2] - bx.h[2] <= l.at[2] + l.size[2] / 2;
      });
    frame.boxes = frame.boxes.filter(near);
  }
  return { mech, bodyOf, names, holds: held, free, raised };
}

/** A let-go run: step it and read where every part is. */
export class LetGoRun {
  readonly sys: MechSystem;
  t = 0;
  settled = false;
  private still = 0;
  private movers: Body[];
  /** where each body's centre was when it was let go (after any lift was raised), m */
  private from = new Map<Body, V3>();

  constructor(public plan: LetGoPlan) {
    this.sys = new MechSystem(plan.mech, MECH_FACTORS.expected);
    this.movers = [...this.sys.bodies.values()].filter((b) => !b.fixed);
  }

  /** Runs up to `seconds` more (less when it comes to rest, or when `budgetMs` of real time runs out). */
  advance(seconds: number, budgetMs = Infinity): number {
    const t0 = performance.now();
    const steps = Math.max(1, Math.round(seconds / STEP));
    let n = 0;
    for (; n < steps && !this.settled; n++) {
      this.sys.step(STEP);
      if (!this.from.size) for (const b of this.movers) this.from.set(b, [...b.x]);
      this.t += STEP;
      let quiet = true;
      for (const b of this.movers) {
        if (Math.hypot(b.v[0], b.v[1], b.v[2]) > STILL_V || Math.hypot(b.w[0], b.w[1], b.w[2]) > STILL_W) {
          quiet = false;
          break;
        }
      }
      this.still = quiet ? this.still + STEP : 0;
      // a moment to get going before stillness counts
      if ((this.still >= STILL_FOR && this.t > 0.15) || this.t >= LONGEST) this.settled = true;
      if ((n & 7) === 7 && performance.now() - t0 > budgetMs) {
        n++;
        break;
      }
    }
    return n * STEP;
  }

  /** Where a body has gone from where it is drawn: a column-major 4×4 in the design's units (mm). */
  matrix(body: string): Mat4 | null {
    const b = this.sys.bodies.get(body);
    if (!b || b.fixed) return null;
    const q = b.turn();
    const x = qrot(q, [1, 0, 0]);
    const y = qrot(q, [0, 1, 0]);
    const z = qrot(q, [0, 0, 1]);
    const o = qrot(q, b.x0);
    return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, (b.x[0] - o[0]) * 1000, (b.x[1] - o[1]) * 1000, (b.x[2] - o[2]) * 1000, 1];
  }

  /** Every moved part's matrix, by part id. */
  poses(): Map<string, Mat4> {
    const byBody = new Map<string, Mat4 | null>();
    const out = new Map<string, Mat4>();
    for (const [part, body] of this.plan.bodyOf) {
      if (!byBody.has(body)) byBody.set(body, this.matrix(body));
      const m = byBody.get(body);
      if (m) out.set(part, m);
    }
    return out;
  }

  /** What has moved more than a millimetre or a degree, the furthest first. */
  moves(): LetGoMove[] {
    const out: LetGoMove[] = [];
    const g = this.plan.mech.gravity;
    const gl = Math.hypot(g[0], g[1], g[2]) || 1;
    const down = (b: Body) => {
      const f = this.from.get(b) ?? b.x0;
      return (((b.x[0] - f[0]) * g[0] + (b.x[1] - f[1]) * g[1] + (b.x[2] - f[2]) * g[2]) / gl) * 1000;
    };
    for (const [id, name] of this.plan.names) {
      const b = this.sys.bodies.get(id);
      if (!b || b.fixed) continue;
      const j = this.plan.mech.joints.find((x) => x.body === id && (x.kind === "pivot" || x.kind === "slider"));
      if (!j) {
        const f = this.from.get(b) ?? b.x0;
        const d = Math.hypot(b.x[0] - f[0], b.x[1] - f[1], b.x[2] - f[2]) * 1000;
        if (d > 1) out.push({ name, how: "fell", amount: d, drop: down(b) });
        continue;
      }
      const c = (this.sys.joints.get(j.name)?.coord ?? 0) - (this.from.size ? (j.start ?? 0) : 0);
      if (j.kind === "slider") {
        if (Math.abs(c) * 1000 > 1) out.push({ name, how: "slid", amount: Math.abs(c) * 1000, drop: down(b) });
      } else if ((Math.abs(c) * 180) / Math.PI > 1) out.push({ name, how: "swung", amount: (Math.abs(c) * 180) / Math.PI, drop: down(b) });
    }
    const size = (m: LetGoMove) => Math.max(Math.abs(m.drop), m.how === "swung" ? 0 : m.amount);
    return out.sort((a, b) => size(b) - size(a));
  }
}

/** The run's outcome in a line, for the 3D view. */
export function letGoLine(run: LetGoRun): string {
  const mv = run.moves();
  if (!mv.length) return run.settled ? "Nothing moved: everything is held." : "";
  const raised = new Set(run.plan.raised.map((id) => run.plan.names.get(id)));
  const say = (m: LetGoMove) => {
    const n = (x: number) => (x >= 10 ? Math.round(x).toString() : (Math.round(x * 10) / 10).toString());
    if (m.how === "swung") return m.amount >= 360 ? `${m.name} turned ${n(m.amount / 360)} times` : `${m.name} swung ${n(m.amount)}°`;
    if (m.how === "slid") return `${m.name}${raised.has(m.name) ? ", raised to the top of its travel and let go," : ""} ${m.drop > 0.5 ? "dropped" : "slid"} ${n(m.amount)} mm`;
    return `${m.name} fell ${n(m.amount)} mm`;
  };
  const shown = mv.slice(0, 3).map(say);
  return `${shown.join("; ")}${mv.length > 3 ? `; and ${mv.length - 3} more` : ""}.`;
}
