// What gravity does to everything that moves. A pivot holds a part in place
// but lets it turn, and a guide lets it slide: so a moving group still needs
// something to carry its weight the way it is free to go. For each drive
// (the motions that are tied together: a crank, its rods and what they push;
// a lift and the wheels that roll with it; gears in mesh) Kerf works out,
// from the parts' real masses at every position of the motion, the force or
// torque gravity puts on it, and checks that something is there to take it:
// a screw and nut, a belt, a spring, an actuator, or a motor strong enough.
// Guides are checked the whole way as well: a carriage that runs off the end
// of its rail is on nothing from there on.

import { turns, type EvalPart, type Model, type Motion } from "./model";
import type { CheckItem } from "./checks";
import type { ChecksResult } from "../kernel/protocol";
import { applyMat, driveAngle, motionPoseSplit } from "./kinematics";
import { isFastener, motionOfPart, type Holds, type MeshLookup } from "./holds";
import { massBodies, type MassBody } from "./stability";
import { contactRun, sweepAngles } from "./sweepChecks";
import { beltBetween } from "./roundBeltChecks";
import { ropeHolds, ropeRuns, type RopeHold } from "./ropeChecks";
import { catalogPart } from "../machine/catalog";
import { motorSupplies } from "../machine/erc";
import type { CatalogKind, MachineComponent } from "../machine/types";
import { fmtNum } from "../lang/values";
import type { V3 } from "../kernel/recipe";

/** Standard gravity, m/s². */
export const G = 9.80665;
/** A pull along a lift's travel under this is nothing to hold (2 g), N. */
const FORCE_MIN = 0.02;
/**
 * A turning group nothing drives is worth a word when its weight sits at least 2 mm off its axis and puts 1 N·mm
 * or more on it: less is the unevenness of any real rotor (a keyway, a screw's flights).
 */
const TORQUE_MIN = 1;
const ARM_MIN = 2;
/** A motor's share of its torque under this is not worth a line when the group is as good as balanced. */
const SHARE_MIN = 0.02;
/** Positions a guide is looked at through a travel. */
const GUIDE_STEPS = 24;

/** What gravity puts on one drive, through its motion. */
export interface DriveLoad {
  /** the motions tied together: moving one moves them all */
  motions: Set<Motion>;
  /** the motion the load is given at: a lift's travel, or the shaft that turns the rest */
  root: Motion;
  kind: "lift" | "turn";
  /** a part on the root, for names */
  lead: EvalPart;
  /** every part that moves when this drive does, and what they weigh together, kg */
  parts: EvalPart[];
  mass: number;
  /** drive angles looked at, degrees */
  angles: number[];
  /**
   * At each angle: N along a lift's travel (positive pulls it back toward where it is drawn), or N·mm about the
   * root's shaft (positive resists the way it is drawn turning).
   */
  load: number[];
  /** the largest load, either way, and the drive angle it comes at */
  peak: number;
  peakDeg: number;
  /** where it settles when let go: the lowest point of its run */
  restDeg: number;
  /** how far its weight rises and falls through the motion, mm (of the centre of mass of what moves) */
  rise: number;
}

const chain = (m: Motion | undefined): Motion[] => {
  const out: Motion[] = [];
  for (let x = m; x; x = x.parent) out.push(x);
  return out;
};

/** The drives of a design and what gravity puts on each, from the parts' masses at every position. */
export function driveLoads(model: Model, holds: Holds, bodies: MassBody[]): DriveLoad[] {
  const motionOf = new Map<EvalPart, Motion>();
  for (const p of model.parts) {
    const m = motionOfPart(p, holds);
    if (m && turns(m)) motionOf.set(p, m);
  }
  if (!motionOf.size) return [];
  // every motion in play, with what each depends on
  const all = new Set<Motion>();
  const walk = (m: Motion | undefined) => {
    if (!m || all.has(m)) return;
    all.add(m);
    walk(m.parent);
    walk(m.link?.driver);
    walk(m.roll?.on);
  };
  for (const m of motionOf.values()) walk(m);
  // motions tied together move as one: a rod and its crank, a roller with what carries it and what it rolls on,
  // gears in mesh, sprockets on one chain, pulleys on one belt
  const root = new Map<Motion, Motion>([...all].map((m) => [m, m]));
  const find = (m: Motion): Motion => {
    let r = m;
    while (root.get(r) !== r) r = root.get(r)!;
    root.set(m, r);
    return r;
  };
  const tie = (a: Motion | undefined, b: Motion | undefined) => {
    if (a && b && all.has(a) && all.has(b)) root.set(find(a), find(b));
  };
  for (const m of all) {
    if (m.link) for (const x of chain(m.link.driver)) tie(m, x);
    if (m.kind === "roll") {
      for (const x of chain(m.parent)) tie(m, x);
      for (const x of chain(m.roll?.on)) tie(m, x);
    }
  }
  const named = (name: string) => model.parts.filter((p) => p.name === name).map((p) => motionOf.get(p));
  const together = (names: string[]) => {
    const ms = names.flatMap(named).filter((m): m is Motion => !!m);
    for (let i = 1; i < ms.length; i++) tie(ms[0], ms[i]);
  };
  for (const p of model.parts) {
    if (p.gear?.meshWith) together([p.name, p.gear.meshWith]);
    if (p.chain) together(p.chain.nodes.map((n) => n.name));
  }
  for (const b of model.machine?.belts ?? []) together(b.nodes.filter((n) => n.kind === "pulley").map((n) => n.name));
  for (const b of model.machine?.roundBelts ?? []) together(b.nodes.map((n) => n.name));

  const sets = new Map<Motion, Set<Motion>>();
  for (const m of all) (sets.get(find(m)) ?? sets.set(find(m), new Set()).get(find(m))!).add(m);

  const out: DriveLoad[] = [];
  for (const motions of sets.values()) {
    // what moves when this drive does: parts on its motions, and parts carried by them
    const moved = bodies.map((b) => ({ b, m: motionOf.get(b.p) })).filter((x): x is { b: MassBody; m: Motion } => !!x.m && chain(x.m).some((y) => motions.has(y)));
    const kg = moved.reduce((a, x) => a + x.b.g, 0) / 1000;
    if (!moved.length || kg <= 0) continue;
    const list = [...motions];
    const lift = list.find((m) => m.kind === "slide" && !m.link && !!m.travel);
    const spinner = (m: Motion) => !m.kind && !m.link && Math.abs(m.ratio) > 1e-12;
    const drivers = new Set(list.map((m) => m.link?.driver).filter(Boolean));
    const rootM = lift ?? list.find((m) => spinner(m) && drivers.has(m)) ?? list.find(spinner) ?? list[0];
    const lead = model.parts.find((p) => p.motion === rootM && !isFastener(p)) ?? moved.find((x) => x.m === rootM)?.b.p ?? moved[0].b.p;
    const angles = sweepAngles(list);
    const range = rootM.range;
    // the height of the weight that moves, N·mm, with this drive at one angle and the rest of the design at another
    const U = (deg: number, rest: number) => {
      let u = 0;
      for (const { b, m } of moved) u += (b.g / 1000) * G * applyMat(motionPoseSplit(m, deg, rest, motions), b.c)[2];
      return u;
    };
    // the root's own coordinate per degree of the drive: mm of travel, or radians of its shaft
    const per = lift ? Math.abs(lift.rate ?? 0) : spinner(rootM) ? (rootM.ratio * Math.PI) / 180 : Math.PI / 180;
    if (Math.abs(per) < 1e-12) continue;
    // what gravity puts on this drive at each position: the work it does as this drive alone moves a little,
    // everything else staying where the motion has it (a gondola hanging level stays level)
    const h = 0.25;
    const load = angles.map((deg) => {
      const a = range ? Math.max(0, deg - h) : deg - h;
      const b = range ? Math.min(range, deg + h) : deg + h;
      return (U(b, deg) - U(a, deg)) / ((b - a) * per);
    });
    let peak = 0;
    let peakDeg = 0;
    load.forEach((x, i) => {
      if (Math.abs(x) > Math.abs(peak)) {
        peak = x;
        peakDeg = angles[i];
      }
    });
    // the work gravity has taken from the drawn position on: lowest where it settles when let go
    const work = [0];
    for (let i = 1; i < angles.length; i++) work.push(work[i - 1] + ((load[i - 1] + load[i]) / 2) * (angles[i] - angles[i - 1]) * per);
    let low = 0;
    work.forEach((w, i) => {
      if (w < work[low] - 1e-9) low = i;
    });
    out.push({ motions, root: rootM, kind: lift ? "lift" : "turn", lead, parts: moved.map((x) => x.b.p), mass: kg, angles, load, peak, peakDeg, restDeg: angles[low], rise: (Math.max(...work) - Math.min(...work)) / (kg * G) });
  }
  return out;
}

const mass = (kg: number) => (kg >= 1 ? `${fmtNum(kg, 2)} kg` : `${fmtNum(kg * 1000, 0)} g`);
const force = (n: number) => `${fmtNum(n, n < 10 ? 1 : 0)} N`;
const torque = (nmm: number) => (Math.abs(nmm) >= 100 ? `${fmtNum(nmm / 1000, 2)} N·m` : `${fmtNum(nmm, nmm < 10 ? 1 : 0)} N·mm`);
const listOf = (names: string[]) => {
  const a = [...new Set(names)];
  return a.length <= 3 ? a.join(", ").replace(/, ([^,]*)$/, " and $1") : `${a.slice(0, 3).join(", ")} and ${a.length - 3} more`;
};
const instance = (p: EvalPart) => p.id.split(".")[0];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Bought parts that carry a load along a slide. */
const CARRIES = new Map<CatalogKind, string>([
  ["actuator", "its actuator"],
  ["lead_screw", "its lead screw"],
  ["belt", "its belt"],
]);
/** Motors whose torque the maker gives, and how much of it Kerf's motor choice lets a steady load use. */
const MOTORS = new Map<CatalogKind, { spec: "t_stall" | "t_hold"; word: string; use: number; why: string }>([
  ["gearmotor", { spec: "t_stall", word: "stall", use: 0.5, why: "above about 50 % a brushed gearmotor overheats in continuous use" }],
  ["servo", { spec: "t_stall", word: "stall", use: 0.5, why: "a servo held above about half its stall torque runs hot and sags" }],
  ["stepper", { spec: "t_hold", word: "holding", use: 0.85, why: "a stepper has about 85 % of its holding torque to work with before it loses steps" }],
]);

/** What holds a drive where it is when the design is let go. */
export interface DriveHold {
  load: DriveLoad;
  /**
   * "carried": something drawn carries a lift all the way. "stated": the design's held: says so. "motor": motors
   * or servos on it (each with the torque it can hold with, N·mm at its own shaft; none listed when the maker
   * gives no torque). "nothing": it is free to fall or swing.
   */
  by: "carried" | "stated" | "motor" | "nothing";
  motors?: { comp: string; shaft: Motion; torque: number }[];
  /**
   * Gravity puts next to nothing on it (a level slide; a rotor whose weight is within 2 mm of its axis), so the
   * checks leave it alone: real friction keeps it where it is.
   */
  balanced?: boolean;
  /** carried by this rope from a winch drum that a motor holds: the rope passes the weight on to that motor */
  rope?: string;
}

/** A rope's pull on a winch drum that motors hold: what passes it on to them (a belt) has to carry it. */
export interface WinchPull {
  rope: string;
  drum: string;
  /** how the drum turns, and the torque the rope's pull puts about its axis, N·mm */
  motion: Motion;
  torque: number;
  /** the pull in the rope, N, and how far from the drum's axis it acts, mm */
  tension: number;
  r: number;
  /** the motors on the drum's drive, each with the shaft it turns */
  motors: { comp: string; shaft: Motion }[];
}

/**
 * The gravity checks: what holds each lift up, which motors hold their loads, turning groups nothing holds, and
 * guides that run out part way through a travel.
 */
export function gravityChecks(model: Model, holds: Holds, kernel: ChecksResult, mesh: MeshLookup, volume: (p: EvalPart) => number | undefined): CheckItem[] {
  return gravityHolds(model, holds, kernel, mesh, volume).items;
}

const loadCache = new WeakMap<Model, { holds: Holds; kernel: ChecksResult; loads: DriveLoad[] }>();

/** What gravity puts on each drive of the design (none when nothing moves), worked out once for all the checks that ask. */
export function gravityLoads(model: Model, holds: Holds, kernel: ChecksResult, mesh: MeshLookup, volume: (p: EvalPart) => number | undefined): DriveLoad[] {
  const boxes = kernel.boxes;
  if (!boxes) return [];
  const hit = loadCache.get(model);
  if (hit && hit.holds === holds && hit.kernel === kernel) return hit.loads;
  const parts = model.parts.filter((p) => !p.hidden && !(p.imported && p.imported.kind !== "solid") && boxes[p.id]);
  const loads = parts.some((p) => turns(motionOfPart(p, holds))) ? driveLoads(model, holds, massBodies(parts, boxes, mesh, volume)) : [];
  loadCache.set(model, { holds, kernel, loads });
  return loads;
}

/** The gravity checks, and for each drive what holds it (for the "let go" preview, which must agree with them). */
export function gravityHolds(model: Model, holds: Holds, kernel: ChecksResult, mesh: MeshLookup, volume: (p: EvalPart) => number | undefined): { items: CheckItem[]; drives: DriveHold[]; pulls: WinchPull[] } {
  const drives: DriveHold[] = [];
  const out: CheckItem[] = [];
  const pulls: WinchPull[] = [];
  const done = { items: out, drives, pulls };
  const boxes = kernel.boxes;
  if (!boxes) return done;
  const loads = gravityLoads(model, holds, kernel, mesh, volume);
  if (!loads.length) return done;
  const comps = model.machine?.components ?? [];
  const catIds = new Map(model.parts.filter((p) => p.bom?.catalogId).map((p) => [instance(p), p.bom!.catalogId!]));
  const kindOf = (p: EvalPart): CatalogKind | undefined => {
    const id = catIds.get(instance(p)) ?? comps.find((c) => c.name === p.name)?.catalogId;
    return id ? catalogPart(id)?.kind : undefined;
  };
  const says = (p: EvalPart) => p.held ?? comps.find((c) => c.name === p.name && c.held)?.held;
  const supplies = model.machine ? motorSupplies(model.machine) : new Map<string, number>();
  const base = { category: "engineering" as const, basis: "calculation" as const };

  // the motors on a drive, each with the turn of its own shaft
  const plain = (m: Motion | undefined): m is Motion => !!m && !m.kind && !m.link && Math.abs(m.ratio) > 1e-12;
  const motorsOn = (set: Set<Motion>) => {
    const motors: { mc: MachineComponent; ratio: number; shaft: Motion }[] = [];
    // a motor whose torque the maker does not give (a brushless outrunner) still drives it
    let driven = false;
    for (const mc of comps) {
      const kind = catalogPart(mc.catalogId)?.kind;
      if (!kind || !(MOTORS.has(kind) || kind === "bldc")) continue;
      const shaft = model.parts.filter((p) => p.name === mc.name).map((p) => motionOfPart(p, holds)).find((x) => x && set.has(x) && plain(x));
      if (!shaft) continue;
      driven = true;
      if (MOTORS.has(kind)) motors.push({ mc, ratio: shaft.ratio, shaft });
    }
    return { motors, driven };
  };
  // what each motor can hold with, at its own shaft
  const torqueOf = (mc: MachineComponent): number | undefined => {
    const part = catalogPart(mc.catalogId)!;
    const rule = MOTORS.get(part.kind)!;
    const rated = part.specs[rule.spec];
    if (typeof rated !== "number") return undefined;
    const v = supplies.get(mc.name);
    return rated * (rule.spec === "t_stall" && v !== undefined && typeof part.specs.v_rated === "number" && part.specs.v_rated > 0 ? v / part.specs.v_rated : 1);
  };
  const perOf = (d: DriveLoad) => (plain(d.root) ? d.root.ratio : 1);

  // ropes: the pull in each, and the torque that puts on the drive that turns its drum
  const roped: RopeHold[] = model.machine?.ropes?.length ? ropeHolds(ropeRuns(model, holds, mesh), loads) : [];
  interface Winch {
    /** N·mm at the drive's root */
    torque: number;
    pulls: { rope: string; drum: string; r: number; tension: number; hold: RopeHold }[];
  }
  const winches = new Map<DriveLoad, Winch>();
  for (const h of roped) {
    if (!(h.tension > 1e-6)) continue;
    for (const dr of h.drums) {
      const m = dr.motion;
      if (!plain(m)) continue;
      const L = loads.find((x) => x.kind === "turn" && x.motions.has(m));
      if (!L) continue;
      const w = winches.get(L) ?? winches.set(L, { torque: 0, pulls: [] }).get(L)!;
      w.torque += dr.torque * Math.abs(m.ratio / perOf(L));
      w.pulls.push({ rope: h.run.rope.name, drum: h.run.rope.nodes[dr.node].name, r: h.run.rope.nodes[dr.node].r, tension: h.tension, hold: h });
    }
  }
  /**
   * What holds a rope's drums against its pull: "fixed" when none of them turns (the rope is as good as tied
   * there), "motor" when motors on every turning drum's drive can hold it, "weak" when one cannot, "free" when a
   * turning drum has no motor on it at all.
   */
  for (const h of roped) {
    if (!(h.tension > 1e-6)) continue;
    for (const dr of h.drums) {
      const m = dr.motion;
      if (!plain(m)) continue;
      const L = loads.find((x) => x.kind === "turn" && x.motions.has(m));
      const nd = h.run.rope.nodes[dr.node];
      pulls.push({ rope: h.run.rope.name, drum: nd.name, motion: m, torque: dr.torque, tension: h.tension, r: nd.r, motors: motorsOn(L?.motions ?? new Set(chain(m))).motors.map((x) => ({ comp: x.mc.name, shaft: x.shaft })) });
    }
  }
  const winchOf = (h: RopeHold): { state: "fixed" | "motor" | "weak" | "free"; drum?: string; motors: string[]; torque: number; slips?: string } => {
    let slips: string | undefined;
    let state: "fixed" | "motor" | "weak" | "free" = "fixed";
    let drum: string | undefined;
    let most = 0;
    const names: string[] = [];
    const rank = { fixed: 0, motor: 1, weak: 2, free: 3 };
    for (const dr of h.drums) {
      const m = dr.motion;
      if (!plain(m)) continue;
      const L = loads.find((x) => x.kind === "turn" && x.motions.has(m));
      const { motors, driven } = motorsOn(L?.motions ?? new Set(chain(m)));
      let st: "motor" | "weak" | "free" = driven ? "motor" : "free";
      if (L && driven) {
        const peak = Math.abs(L.peak) + (winches.get(L)?.torque ?? 0);
        for (const x of motors) {
          const has = torqueOf(x.mc);
          if (has !== undefined && x.mc.load === undefined && Math.abs((peak * perOf(L)) / x.ratio) / motors.length >= has) st = "weak";
        }
      }
      // motors that hold the drum through a friction belt hold it only as far as the belt grips (its own check says so)
      if (st === "motor" && motors.length) {
        const across = motors.map((x) => (x.shaft !== m ? beltBetween(model, holds, x.shaft, m) : null));
        if (across.every(Boolean)) {
          const caps = new Map(across.map((x) => [x!.belt.name, x!.cap]));
          if (dr.torque > [...caps.values()].reduce((a, b) => a + b, 0)) {
            st = "weak";
            slips = [...caps.keys()][0];
          }
        }
      }
      names.push(...motors.map((x) => x.mc.name));
      if (rank[st] >= rank[state]) {
        state = st;
        drum = h.run.rope.nodes[dr.node].name;
        most = Math.max(most, dr.torque);
      }
    }
    return { state, drum: drum ?? (h.drums[0] ? h.run.rope.nodes[h.drums[0].node].name : undefined), motors: [...new Set(names)], torque: most, ...(slips ? { slips } : {}) };
  };

  for (const d of loads) {
    const moves = (p: EvalPart) => {
      const m = motionOfPart(p, holds);
      return !!m && chain(m).some((x) => d.motions.has(x));
    };
    const name = d.lead.name;
    const motorNames = new Set(comps.filter((c) => MOTORS.has(catalogPart(c.catalogId)?.kind as CatalogKind)).map((c) => c.name));
    const others = d.parts.filter((p) => p.name !== name && !isFastener(p) && !motorNames.has(p.name)).map((p) => p.name);
    const withIt = others.length ? ` with ${listOf(others)}` : "";
    const ids = [...new Set(d.parts.map((p) => p.id))];

    if (d.kind === "lift") {
      const m = d.root;
      const travel = Math.abs(m.travel ?? 0);
      const at = (deg: number) => Math.abs(m.rate ?? 0) * driveAngle(deg, m.range);
      // a carriage that runs off the end of its guides is on nothing from there
      const n = Math.min(GUIDE_STEPS, d.angles.length - 1);
      const sample = Array.from({ length: n + 1 }, (_, i) => d.angles[Math.round((i * (d.angles.length - 1)) / n)]);
      const off = contactRun(model, holds, kernel, mesh, moves, sample);
      if (typeof off === "object") {
        const s = at(off.deg);
        out.push({
          ...base,
          category: "motion",
          basis: "geometry",
          id: `held:leaves:${name}`,
          status: "fail",
          title: `${name} runs off ${off.last.name}`,
          detail: `${name}${withIt} travels ${fmtNum(travel, 0)} mm, but ${fmtNum(s, 0)} mm along it leaves ${off.last.name} and from there touches nothing: it is guided and held by nothing for the last ${fmtNum(travel - s, 0)} mm.`,
          fix: `Make ${off.last.name} at least ${fmtNum(Math.ceil(travel - s) + 1, 0)} mm longer that way, shorten ${name}'s travel: to under ${fmtNum(Math.floor(s), 0)}, or start ${name} further back on ${off.last.name}.`,
          parts: [...ids, off.last.id],
          span: d.lead.span,
        });
      }
      if (Math.abs(d.peak) < FORCE_MIN) {
        // a level slide: there is nothing for gravity to pull it along
        drives.push({ load: d, by: "nothing", balanced: true });
        continue;
      }
      // what can carry its weight along the travel
      const member = new Set(d.parts.map((p) => p.id));
      for (const p of model.parts) if (moves(p)) member.add(p.id);
      const byId = new Map(model.parts.map((p) => [p.id, p]));
      // (a belt, a spring or a band goes with it as it moves; a screw, an actuator or a wheel must stay in touch)
      const carriers: { part: EvalPart; how: string; rigid: boolean; on?: EvalPart }[] = [];
      const consider = (q: EvalPart, thread: boolean) => {
        if (member.has(q.id) || carriers.some((c) => c.part.name === q.name)) return;
        const k = kindOf(q);
        const soft = q.libKind === "belt" ? "its belt" : q.spring ? "its spring" : q.band ? "its band" : k === "belt" ? "its belt" : undefined;
        const how = soft ?? (thread ? "the thread it runs on" : k ? CARRIES.get(k) : undefined);
        if (how) carriers.push({ part: q, how, rigid: !soft });
      };
      for (const j of holds.joins) {
        if (member.has(j.a.id) === member.has(j.b.id)) continue;
        // (the two halves of a bought actuator are joined too: its rod moves with the lift and its body carries it)
        consider(member.has(j.a.id) ? j.b : j.a, j.kind === "thread");
      }
      for (const c of kernel.contacts ?? []) {
        if (member.has(c.a) === member.has(c.b)) continue;
        const q = byId.get(member.has(c.a) ? c.b : c.a);
        if (q) consider(q, false);
      }
      // a driven wheel pressed on it carries it by friction, and so do gear teeth
      const a = unit(m.axis);
      const names = new Set(model.parts.filter((p) => member.has(p.id)).map((p) => p.name));
      for (const q of model.parts) {
        if (member.has(q.id) || carriers.some((c) => c.part.name === q.name)) continue;
        const spins = !!q.motion && turns(q.motion) && q.motion.kind !== "roll" && !q.motion.link;
        if (spins && q.rollsOn?.names.some((x) => names.has(x)) && Math.abs(dot(unit(q.motion!.axis), a)) < 0.5) carriers.push({ part: q, how: "the grip of a driven wheel", rigid: true });
        else if (q.gear?.meshWith && names.has(q.gear.meshWith)) carriers.push({ part: q, how: "gear teeth", rigid: false });
      }
      // a driven wheel on the lift itself that runs on a part that stays put climbs it
      for (const p of model.parts) {
        if (!member.has(p.id) || !p.rollsOn || !p.motion || p.motion === m || p.motion.kind === "roll" || p.motion.link || !turns(p.motion) || Math.abs(dot(unit(p.motion.axis), a)) >= 0.5) continue;
        const q = model.parts.find((x) => p.rollsOn!.names.includes(x.name) && !member.has(x.id));
        if (q && !carriers.some((c) => c.part.name === p.name)) carriers.push({ part: p, how: "the grip of its own driven wheel", rigid: true, on: q });
      }
      for (const p of model.parts) {
        if (!member.has(p.id) || !p.gear?.meshWith) continue;
        const q = model.parts.find((x) => x.name === p.gear!.meshWith && !member.has(x.id));
        if (q && !carriers.some((c) => c.part.name === q.name)) carriers.push({ part: q, how: "gear teeth", rigid: false });
      }
      // a screw, an actuator or a wheel carries it only while the two stay in touch: how far along the travel
      const spec = (c: { part: EvalPart; on?: EvalPart }) => {
        const id = catIds.get(instance(c.on ?? c.part)) ?? comps.find((x) => x.name === (c.on ?? c.part).name)?.catalogId;
        return id ? catalogPart(id) : undefined;
      };
      const reachOf = new Map<EvalPart, number>();
      for (const c of [...carriers]) {
        if (!c.rigid) continue;
        const inst = instance(c.on ?? c.part);
        const x = spec(c);
        // an actuator whose rod is fixed to the lift goes with it as far as its stroke (its rod is drawn only
        // where it shows, so touch cannot tell)
        if (x?.kind === "actuator" && model.parts.some((p) => instance(p) === inst && member.has(p.id))) {
          reachOf.set(c.part, typeof x.specs.stroke === "number" ? x.specs.stroke : travel);
          continue;
        }
        // (a wheel on the lift that climbs a fixed part: it is the wheel that must stay on it)
        const run = contactRun(model, holds, kernel, mesh, c.on ? (p) => p.id === c.part.id : moves, sample, (p) => instance(p) === inst);
        // a wheel the lift only passes on its way is not what carries it
        if (run === "never" && c.how.startsWith("the grip of")) carriers.splice(carriers.indexOf(c), 1);
        else reachOf.set(c.part, typeof run === "object" ? at(run.deg) : travel);
      }
      // what the lift itself says holds it (a part that rides on it says only how it is fixed to the lift)
      const stated = says(d.lead);
      const up = d.peak > 0;
      const pull = Math.abs(d.peak);
      const weighs = `${name}${withIt} weighs ${mass(d.mass)}${Math.abs(a[2]) < 0.999 ? `, ${force(pull)} of it along its travel` : ` (${force(pull)})`}`;
      const onRope = carriers.length ? [] : roped.flatMap((h) => h.carries.filter((c) => c.load === d && c.holds).map((c) => ({ h, c, w: winchOf(h) })));
      if (onRope.length) {
        // the rope carries it: what matters then is what holds the rope's drum
        const order = { fixed: 0, motor: 1, weak: 2, free: 3 };
        const best = [...onRope].sort((x, y) => order[x.w.state] - order[y.w.state])[0];
        const { h, c, w } = best;
        const rope = h.run.rope;
        const who = listOf(onRope.map((x) => x.h.run.rope.name));
        const share = Math.abs(c.take - 1) > 0.02 ? `, on ${fmtNum(c.take, Math.abs(c.take - Math.round(c.take)) > 0.02 ? 1 : 0)} parts of rope` : "";
        const inRope = `${force(c.pull)} in ${rope.name}${share}`;
        const b = { ...base, parts: [...ids, ...model.parts.filter((p) => onRope.some((x) => x.h.run.rope.name === p.name)).map((p) => p.id)], span: d.lead.span };
        const nd = rope.nodes.find((x) => x.name === w.drum);
        const atDrum = nd ? `${torque(w.torque)} about ${w.drum} (${force(h.tension)} at ${fmtNum(nd.r, 1)} mm from its axis)` : "";
        if (w.state === "fixed" || w.state === "motor") {
          drives.push({ load: d, by: "carried", ...(w.state === "motor" ? { rope: rope.name } : {}) });
          const drumSays = w.state === "motor" ? ` ${w.drum} is held against that by ${listOf(w.motors)}, checked on its own.` : w.drum ? ` ${w.drum} does not turn, so the rope is as good as tied there.` : " Both its ends are tied.";
          out.push({ ...b, id: `gravity:carried:${name}`, status: "pass", title: `${name} is held up by ${who}`, detail: `${weighs}, carried through its ${fmtNum(travel, 0)} mm of travel by its rope: ${inRope}.${drumSays}${onRope.length > 1 ? " Each rope is checked as if it carried the weight alone." : ""}`, margin: 1 });
        } else if (w.state === "weak") {
          // the motor's own check says so
          drives.push({ load: d, by: "nothing", rope: rope.name });
        } else if (stated) {
          drives.push({ load: d, by: "stated" });
          out.push({ ...b, id: `gravity:stated:${name}`, status: "info", title: `${name} is held up by "${stated}", which is not drawn`, detail: `${weighs}. ${rope.name} carries that to ${w.drum}: ${atDrum}. Nothing drawn holds ${w.drum} against it, and the design says ${name} is held by "${stated}", so that must. Kerf cannot check that it does.`, fix: `Draw what holds ${w.drum} so it can be checked: a gearmotor or stepper on its shaft (turns_with: ${w.drum}).`, basis: "needs analysis" });
        } else {
          drives.push({ load: d, by: "nothing" });
          out.push({
            ...b,
            id: `gravity:falls:${name}`,
            status: "fail",
            title: `Nothing stops ${w.drum} unwinding, so ${name} falls`,
            detail: `${weighs}. ${rope.name} carries that to ${w.drum}: ${atDrum}. ${w.drum} is free to turn and nothing holds it against that: no gearmotor, stepper or servo is on its shaft. Let go, ${name} drops and pulls the rope off the drum.`,
            fix: `Put a gearmotor or stepper on ${w.drum}'s shaft (turns_with: ${w.drum}) so Kerf can check it holds ${torque(w.torque)}. If a ratchet, a brake or a worm gear that is not drawn holds it, say so on ${name} with held: "ratchet on the winch".`,
            margin: 0,
          });
        }
        continue;
      }
      if (carriers.length) {
        const friction = carriers.every((c) => c.how.startsWith("the grip of"));
        const by = `carried through its ${fmtNum(travel, 0)} mm of travel by ${listOf(carriers.map((c) => `${c.how} (${c.part.name}${c.on ? ` on ${c.on.name}` : ""})`))}`;
        const b = { ...base, parts: [...ids, ...carriers.map((c) => c.part.id)], span: d.lead.span };
        // a bought actuator says how hard it pushes, and a bought screw whether it holds with the power off
        const acts = carriers.map(spec).filter((x) => x?.kind === "actuator" && typeof x.specs.f_max === "number");
        const push = acts.reduce((n, x) => n + (x!.specs.f_max as number), 0);
        const only = acts.length === carriers.length;
        const screw = carriers.map(spec).find((x) => x?.kind === "lead_screw" && typeof x.specs.efficiency === "number");
        const locks = screw ? ((screw.specs.efficiency as number) < 0.5 ? " The screw holds it where it stops with the power off: one under 50 % efficient does not back-drive." : " The screw back-drives (over 50 % efficient): with the power off the weight turns it, so its motor needs a brake or must stay powered.") : "";
        const reach = carriers.every((c) => c.rigid) ? Math.max(...carriers.map((c) => reachOf.get(c.part) ?? travel)) : travel;
        const who = listOf(carriers.map((c) => c.part.name));
        drives.push({ load: d, by: (only && pull >= push) || reach < travel - 1 ? "nothing" : "carried" });
        if (only && pull >= push) {
          out.push({ ...b, id: `gravity:carried:${name}`, status: "fail", title: `${who} cannot lift ${name}`, detail: `${weighs}, more than the ${force(push)} ${acts.length > 1 ? "the actuators push between them" : "the actuator pushes at most"}.`, fix: `Use ${acts.length > 1 ? "actuators" : "an actuator"} rated for at least ${force(pull * 2)} (twice the weight, to start and stop it), make ${name} lighter, or carry part of it on a spring or counterweight.`, margin: push / pull });
        } else if (reach < travel - 1) {
          const wheel = carriers.some((c) => c.how.startsWith("the grip of"));
          const stroke = Math.max(0, ...acts.map((x) => (typeof x!.specs.stroke === "number" ? x!.specs.stroke : 0)));
          const fix = wheel
            ? carriers[0].on
              ? `Make ${carriers[0].on.name} as long as ${name}'s travel where ${who} runs on it, or shorten the travel:.`
              : `Give ${name} a face as long as its travel for ${who} to run on (a strip down its side), or mount ${who} on ${name} (rides: ${name}, with its spin:) and run it on a part that stays put.`
            : acts.length
              ? `Fix the end of the actuator's rod to ${name} (a pin or screw through its eye) so the rod moves with it, and use one with at least ${fmtNum(travel, 0)} mm of stroke${stroke ? ` (this one has ${fmtNum(stroke, 0)} mm)` : ""}, or shorten ${name}'s travel:.`
              : `Fasten ${name} to the screw's nut so the nut travels with it (screws through the nut's flange, or a tapped hole in ${name} the screw runs through), and make the screw at least as long as the travel.`;
          out.push({
            ...b,
            id: `gravity:carried:${name}`,
            status: "fail",
            title: reach < 1 ? `${who} does not go with ${name}` : `${who} lets go of ${name} part way`,
            detail: `${weighs}. ${reach < 1 ? `It sits on ${carriers[0].how} (${who}) where it is drawn, but leaves it as soon as it moves` : `${carriers[0].how.replace(/^./, (c) => c.toUpperCase())} (${who}) carries it for the first ${fmtNum(reach, 0)} mm of its ${fmtNum(travel, 0)} mm travel, then the two part`}: from there nothing holds it up.`,
            fix,
            margin: reach / travel,
          });
        } else {
          out.push({
            ...b,
            id: `gravity:carried:${name}`,
            status: "pass",
            title: `${name} is held up by ${who}`,
            detail: `${weighs}, ${by}${only ? `: ${fmtNum((pull / push) * 100, 0)} % of the ${force(push)} ${acts.length > 1 ? "they push" : "it pushes"}` : ""}.${locks}${friction ? " Grip against that weight is not worked out yet: with the power off a friction drive holds only as well as its motor does." : ""}`,
            margin: only ? push / pull : 1,
          });
        }
      } else if (stated) {
        drives.push({ load: d, by: "stated" });
        out.push({
          ...base,
          id: `gravity:stated:${name}`,
          status: "info",
          title: `${name} is held up by "${stated}", which is not drawn`,
          detail: `${weighs}. The design says it is held by "${stated}", so that must carry ${force(pull)} through all ${fmtNum(travel, 0)} mm of travel, and more as it starts and stops. Nothing drawn carries it, so Kerf cannot check that it does.`,
          fix: `Draw what carries it so it can be checked: a lead screw and its nut, a belt clamped to ${name}, a linear actuator, or a driven wheel with rolls_on: ${name}.`,
          parts: ids,
          span: d.lead.span,
          basis: "needs analysis",
        });
      } else {
        drives.push({ load: d, by: "nothing" });
        out.push({
          ...base,
          id: `gravity:falls:${name}`,
          status: "fail",
          title: `Nothing holds ${name} up`,
          detail: `${weighs}, and it is free to slide ${fmtNum(travel, 0)} mm ${up ? "up from" : "down from"} where it is drawn. Its guides stop it going sideways, but nothing carries its weight along the travel: no screw and nut, belt, spring, actuator or driven wheel joins it to a part that stays put. ${up ? "Raised and let go, it drops straight back down." : "Let go, it drops to the far end of its travel as soon as it is built."}`,
          fix: `Give ${name} what lifts it: a lead screw through a nut fixed to it (per_turn: is the screw's lead), a belt clamped to it, a linear actuator, or a driven wheel with rolls_on: ${name}. If something not drawn carries it (a hoist rope, a counterweight), say so with held: "hoist rope"; it must carry ${force(pull)}.`,
          parts: ids,
          span: d.lead.span,
          margin: 0,
        });
      }
      continue;
    }

    // a turning group: is it out of balance, does a rope hold it or pull on it, and does a motor hold it
    const winch = winches.get(d);
    const peak = Math.abs(d.peak) + (winch?.torque ?? 0);
    const arm = Math.abs(d.peak) / (d.mass * G);
    const per = perOf(d);
    // the same load at a motor's own shaft: the work is the same, so the torque goes by the speeds
    const { motors, driven } = motorsOn(d.motions);
    const balanced = !winch && (Math.abs(d.peak) < TORQUE_MIN || arm < ARM_MIN);
    const where = `with the drive at ${fmtNum(d.peakDeg % 360, 0)}°`;
    // a rope that holds it up (a boom raised by a rope): then it is the rope's drum that must be held
    const onRope = driven || balanced ? [] : roped.flatMap((h) => h.carries.filter((c) => c.load === d && c.holds).map((c) => ({ h, c, w: winchOf(h) })));
    if (onRope.length) {
      const order = { fixed: 0, motor: 1, weak: 2, free: 3 };
      const { h, c, w } = [...onRope].sort((x, y) => order[x.w.state] - order[y.w.state])[0];
      const rope = h.run.rope;
      const b = { ...base, parts: [...ids, ...model.parts.filter((p) => p.name === rope.name).map((p) => p.id)], span: d.lead.span };
      const weighs = `${name}${withIt} weighs ${mass(d.mass)}, which puts up to ${torque(Math.abs(d.peak))} on its shaft (${where})`;
      const nd = rope.nodes.find((x) => x.name === w.drum);
      const atDrum = nd ? `${torque(w.torque)} about ${w.drum} (${force(h.tension)} at ${fmtNum(nd.r, 1)} mm from its axis)` : "";
      const stated = says(d.lead);
      if (w.state === "fixed" || w.state === "motor") {
        drives.push({ load: d, by: "carried" });
        out.push({ ...b, id: `gravity:carried:${name}`, status: "pass", title: `${name} is held up by ${rope.name}`, detail: `${weighs}. ${rope.name} holds it there with up to ${force(c.pull)} in the rope.${w.state === "motor" ? ` ${w.drum} is held against that by ${listOf(w.motors)}, checked on its own.` : w.drum ? ` ${w.drum} does not turn, so the rope is as good as tied there.` : " Both its ends are tied."}`, margin: 1 });
      } else if (w.state === "weak") drives.push({ load: d, by: "nothing" });
      else if (stated) {
        drives.push({ load: d, by: "stated" });
        out.push({ ...b, id: `gravity:stated:${name}`, status: "info", title: `${name} is held up by "${stated}", which is not drawn`, detail: `${weighs}. ${rope.name} carries that to ${w.drum}: ${atDrum}. Nothing drawn holds ${w.drum} against it, and the design says ${name} is held by "${stated}", so that must. Kerf cannot check that it does.`, fix: `Draw what holds ${w.drum} so it can be checked: a gearmotor or stepper on its shaft (turns_with: ${w.drum}).`, basis: "needs analysis" });
      } else {
        drives.push({ load: d, by: "nothing" });
        out.push({ ...b, id: `gravity:falls:${name}`, status: "fail", title: `Nothing stops ${w.drum} unwinding, so ${name} falls`, detail: `${weighs}. ${rope.name} carries that to ${w.drum}: ${atDrum}. ${w.drum} is free to turn and nothing holds it against that: no gearmotor, stepper or servo is on its shaft. Let go, ${name} swings down and pulls the rope off the drum.`, fix: `Put a gearmotor or stepper on ${w.drum}'s shaft (turns_with: ${w.drum}) so Kerf can check it holds ${torque(w.torque)}. If a ratchet, a brake or a worm gear that is not drawn holds it, say so on ${name} with held: "ratchet on the winch".`, margin: 0 });
      }
      continue;
    }
    drives.push(driven ? { load: d, by: "motor", motors: motors.flatMap((x) => (torqueOf(x.mc) === undefined ? [] : [{ comp: x.mc.name, shaft: x.shaft, torque: torqueOf(x.mc)! }])), balanced } : { load: d, by: "nothing", balanced });
    // what the rope on its drum is holding up, for the words
    const hung = winch ? listOf(winch.pulls.flatMap((p) => p.hold.carries.filter((c) => c.holds).map((c) => c.load.lead.name))) : "";
    const pullSays = winch ? `The pull of ${winch.pulls.map((p) => `${p.rope} on ${p.drum} (${force(p.tension)} at ${fmtNum(p.r, 1)} mm from its axis)`).join(" and of ")}` : "";
    if (!driven) {
      if (balanced) continue;
      if (winch) {
        // a lift or a boom on the rope says so itself; a rope with only a pull: of its own is said here
        if (!hung)
          out.push({ ...base, id: `gravity:winch:${name}`, status: "fail", title: `Nothing holds ${name} against its rope`, detail: `${pullSays} puts ${torque(winch.torque)} on ${name}'s shaft. ${name} is free to turn and no gearmotor, stepper or servo is on it, so the rope pulls itself off the drum.`, fix: `Put a gearmotor or stepper on ${name}'s shaft (turns_with: ${name}) so Kerf can check it holds ${torque(winch.torque)}.`, parts: ids, span: d.lead.span, margin: 0 });
        continue;
      }
      out.push({
        ...base,
        id: `gravity:free:${name}`,
        status: "info",
        title: `${name} is out of balance: nothing holds it against its weight`,
        detail: `${name}${withIt} weighs ${mass(d.mass)} and is free to turn. Its weight puts up to ${torque(Math.abs(d.peak))} on ${name}'s shaft (${where}), and no motor or servo is on it, so let go it ${d.restDeg === d.angles[0] ? "swings back to where it is drawn" : `swings round to rest with the drive at ${fmtNum(d.restDeg % 360, 0)}°`}.`,
        fix: `If a motor or servo drives it, give its shaft turns_with: ${name} so Kerf can check it holds ${torque(Math.abs(d.peak))}. If it is meant to swing or run free (a pendulum, an engine), nothing to do. To balance it, add a counterweight opposite the heavy side.`,
        parts: ids,
        span: d.lead.span,
      });
      continue;
    }
    for (const { mc, ratio } of motors) {
      const part = catalogPart(mc.catalogId)!;
      const rule = MOTORS.get(part.kind)!;
      const has = torqueOf(mc);
      if (has === undefined) continue;
      const v = supplies.get(mc.name);
      const k = has / (part.specs[rule.spec] as number);
      // motors on one drive share its load
      const need = Math.abs((peak * per) / ratio) / motors.length;
      const frac = need / has;
      const label = mc.role ? `${mc.name} (${mc.role})` : mc.name;
      const volts = k !== 1 ? ` at ${fmtNum(v!, 1)} V` : "";
      const b = { ...base, parts: [mc.name, ...ids, ...(winch ? model.parts.filter((p) => winch.pulls.some((x) => x.rope === p.name)).map((p) => p.id) : [])], span: mc.span, margin: has / need };
      // what it holds: the weight on its own drive, or what hangs on the rope round its drum
      const held = winch ? hung || `${listOf(winch.pulls.map((p) => p.rope))}'s pull` : name;
      const what = winch ? `${pullSays}${hung ? `, which is the weight of ${hung},` : ""} puts up to ${torque(need)} on ${label}` : `The weight of ${name}${withIt} (${mass(d.mass)}) puts up to ${torque(need)} on ${label}, ${where}`;
      // a smaller drum eases the motor, but only down to the smallest the rope may be bent round
      const rp = winch?.pulls[0].hold.run.rope.rope;
      const smaller = winch ? Math.floor((winch.pulls[0].r * 2 * rule.use) / frac) : 0;
      const lighter = winch ? `${rp && smaller >= rp.bend * rp.d + rp.d ? `use a smaller drum (${fmtNum(smaller, 0)} mm across would do) or ` : ""}share the weight over more parts of rope with a sheave on the load` : `make ${name} lighter or shorter`;
      if (mc.load !== undefined) {
        // the design gives its own load: say so only when the weight alone is more
        if (need > 1.25 * mc.load) out.push({ ...b, id: `gravity:load:${mc.name}`, status: "warn", title: `${label}: load: is less than the weight on it`, detail: `${what}, but its load: is ${torque(mc.load)}. The motor checks use load:, so they are passing a lighter job than gravity gives it.`, fix: `Set load: on ${mc.name} to at least ${fmtNum(Math.ceil(need), 0)} (N·mm), or ${winch ? lighter : `balance ${name} so the motor carries less`}.` });
        continue;
      }
      if (balanced && frac < SHARE_MIN) continue;
      if (frac >= 1) out.push({ ...b, id: `gravity:motor:${mc.name}`, status: "fail", title: `${label} cannot hold ${held}${winch && !hung ? "" : " up"}`, detail: `${what}: more than its ${torque(has)} ${rule.word} torque${volts}. It stalls there, and lets ${winch ? (hung ? `${hung} fall` : "the rope run out") : `${name} fall back`}.`, fix: `Use a motor with at least ${torque(need / rule.use)} of ${rule.word} torque, gear it down ${fmtNum(Math.ceil((frac / rule.use) * 10) / 10, 1)} times more, ${lighter}${winch ? "" : ", or balance it with a counterweight or spring"} (calc.motor_select() picks a motor for a duty).` });
      else if (frac > rule.use) out.push({ ...b, id: `gravity:motor:${mc.name}`, status: "warn", title: `${label} works hard holding ${held}`, detail: `${what}: ${fmtNum(frac * 100, 0)} % of its ${torque(has)} ${rule.word} torque${volts}, before ${winch ? "any speeding up or snatch" : "anything it carries or any speeding up"}. ${rule.why.replace(/^./, (c) => c.toUpperCase())}.`, fix: `Use a motor with at least ${torque(need / rule.use)} of ${rule.word} torque, gear it down further, or ${winch ? lighter : `balance ${name} with a counterweight or spring`}.` });
      else {
        // strong enough, but holding through a friction belt that lets go first
        const slips = winch?.pulls.map((p) => winchOf(p.hold).slips).find(Boolean);
        out.push({ ...b, id: `gravity:motor:${mc.name}`, status: "pass", title: slips ? `${label} is strong enough to hold ${held}${hung ? " up" : ""}` : winch ? `${label} holds ${held}${hung ? " up" : ""}` : `${label} holds ${name} against its weight`, detail: `${what}: ${fmtNum(frac * 100, 0)} % of its ${torque(has)} ${rule.word} torque${volts}.${slips ? ` It holds it through ${slips}, which slips before that: see that belt's own check.` : ""}` });
      }
    }
  }
  return done;
}
