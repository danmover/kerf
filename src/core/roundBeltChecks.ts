// Checks on round belts and O-rings used as belts (lib.round_belt). A belt
// like this drives by friction alone, so what matters is how hard it is
// stretched: enough to grip, not more than its makers work to. From the
// stretch comes the pull in each strand, and from that, the wrap round each
// pulley and the friction there, the most it can pass before it slips (the
// capstan relation). The checks also hold the pulleys to the speeds the belt
// gives them, the smallest pulley its makers allow, and grooves that fit.

import type { CheckItem } from "./checks";
import type { EvalPart, Model, Motion } from "./model";
import { isFastener, motionOfPart, type Holds } from "./holds";
import type { WinchPull } from "./gravityChecks";
import { capstan, cordKept, cordTension, gripForce } from "../machine/roundBelts";
import type { RoundBeltDef, RoundBeltNode } from "../machine/types";
import { fmtNum } from "../lang/values";

/** A round belt takes a few degrees off square; past this it rolls out of its groove. Kerf's own rule of thumb. */
const FLEET_WARN = 5;
/** Grip Kerf asks for over the torque a belt must pass: oil, dust and age all take some. Kerf's own margin. */
const GRIP_MARGIN = 0.7;
/** Pulley speeds further apart than this share are not the belt's doing. */
const RATIO_TOL = 0.005;

const N0 = (x: number, d = 0) => fmtNum(x, d);
const force = (n: number) => `${fmtNum(n, n < 10 ? 1 : 0)} N`;
const torque = (nmm: number) => (nmm >= 1000 ? `${fmtNum(nmm / 1000, 2)} N·m` : `${fmtNum(nmm, nmm < 10 ? 1 : 0)} N·mm`);
const pct = (x: number) => `${fmtNum(x * 100, 1)} %`;
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const listOf = (names: string[]) => {
  const a = [...new Set(names)];
  return a.length <= 3 ? a.join(", ").replace(/, ([^,]*)$/, " and $1") : `${a.slice(0, 3).join(", ")} and ${a.length - 3} more`;
};
const plain = (m: Motion | undefined): m is Motion => !!m && !m.kind && !m.link && !m.parent && Math.abs(m.ratio) > 1e-12;

/** The part each pulley of a belt is. */
export function roundBeltParts(b: RoundBeltDef, model: Model): (EvalPart | undefined)[] {
  return b.nodes.map((nd) => model.parts.find((p) => p.name === nd.name && !isFastener(p)) ?? model.parts.find((p) => p.name === nd.name));
}

/** Friction between the cord and a pulley, by what the pulley is made of. */
function muOn(b: RoundBeltDef, part: EvalPart | undefined): { mu: number; on: string } {
  const m = part?.material ?? "";
  if (/alumin/i.test(m)) return { mu: b.cord.muAluminium, on: "aluminium" };
  if (/steel|stainless|iron/i.test(m)) return { mu: b.cord.muSteel, on: "steel" };
  return { mu: Math.min(b.cord.muAluminium, b.cord.muSteel), on: b.cord.kind === "pu" ? `${m || "its material"}, taken as steel` : m || "its material" };
}

/** A pulley that only guides the belt: one it runs its back on, or a bare bearing. */
const idler = (nd: RoundBeltNode, way: number) => nd.dir !== way || / bearing$/.test(nd.label);

export interface BeltGrip {
  /** pull in each strand the grip is worked out from, N: as fitted, less what rubber loses held stretched for a year */
  t0: number;
  /** the pulley it slips on first, with the friction and wrap there */
  at: RoundBeltNode;
  mu: number;
  on: string;
  /** the most pull (tight side less slack side) it passes before it slips there, N */
  force: number;
}

/** What a belt can pass before it slips: the least of its working pulleys' grips. */
export function beltGrip(b: RoundBeltDef, model: Model): BeltGrip | null {
  const t0 = cordTension(b.cord, b.stretch) * cordKept(b.cord);
  if (!(t0 > 0)) return null;
  const parts = roundBeltParts(b, model);
  const way = b.nodes[0].dir;
  let working = b.nodes.map((nd, i) => ({ nd, i })).filter((x) => !idler(x.nd, way));
  if (working.length < 2) working = b.nodes.map((nd, i) => ({ nd, i }));
  let best: BeltGrip | null = null;
  for (const { nd, i } of working) {
    const { mu, on } = muOn(b, parts[i]);
    const f = gripForce(t0, mu, nd.wrap);
    if (!best || f < best.force) best = { t0, at: nd, mu, on, force: f };
  }
  return best;
}

/** A belt that joins two shafts, and the most torque it passes to the one that turns as `to` does before it slips, N·mm. */
export function beltBetween(model: Model, holds: Holds, from: Motion, to: Motion): { belt: RoundBeltDef; cap: number; from: RoundBeltNode; to: RoundBeltNode } | null {
  for (const b of model.machine?.roundBelts ?? []) {
    const ms = roundBeltParts(b, model).map((p) => (p ? motionOfPart(p, holds) : undefined));
    const i = ms.indexOf(from);
    const j = ms.indexOf(to);
    if (i < 0 || j < 0 || i === j) continue;
    return { belt: b, cap: (beltGrip(b, model)?.force ?? 0) * b.nodes[j].r, from: b.nodes[i], to: b.nodes[j] };
  }
  return null;
}

export function roundBeltChecks(model: Model, holds: Holds, pulls: WinchPull[]): CheckItem[] {
  const belts = model.machine?.roundBelts ?? [];
  const out: CheckItem[] = [];
  for (const b of belts) {
    const c = b.cord;
    const parts = roundBeltParts(b, model);
    const beltPart = model.parts.find((p) => p.name === b.name);
    const ids = [...(beltPart ? [beltPart.id] : []), ...parts.filter((p): p is EvalPart => !!p).map((p) => p.id)];
    const base = { category: "engineering" as const, parts: ids, span: b.span, basis: "calculation" as const };
    const geo = { ...base, basis: "geometry" as const };
    const names = b.nodes.map((nd) => nd.name);
    const ring = c.kind === "rubber";
    // the stretch to aim for: what lib.round_belt fits it at when the design gives none
    const mid = ring ? 0.1 : 0.05;
    // the belt that would fit at the middle of its working stretch
    const fitMade = b.length / (1 + mid);
    const fitFix = ring ? `Use an O-ring of about ${N0(fitMade / Math.PI - c.d, 1)} mm inside diameter (${pct(mid)} stretch), or move the pulleys ${b.stretch < mid ? "apart" : "together"}.` : `Weld it to ${N0(fitMade, 0)} mm, which is stretch: ${N0(mid * 100, 0)}.`;
    const own = b.ringId !== undefined ? `The ${N0(b.ringId, 1)} × ${N0(c.d, 1)} mm O-ring is ${N0(b.made, 1)} mm round its middle` : `The belt is ${N0(b.made, 1)} mm long`;

    out.push({ ...geo, id: `rbelt:path:${b.name}`, status: "pass", title: `${b.name} runs round ${listOf(names)}`, detail: `${b.label}: ${N0(b.length, 1)} mm round the path along the middle of the cord. ${ring && b.ringId === undefined ? `An O-ring of ${N0(b.made / Math.PI - c.d, 1)} mm inside diameter fits it (or cord joined to ${N0(b.made, 1)} mm)` : b.ringId !== undefined ? own : `Weld it to ${N0(b.made, 1)} mm`}, which is ${b.stretch >= 0 ? `${pct(b.stretch)} stretch` : "longer than the path"}.` });

    // how hard it is stretched
    const fresh = cordTension(c, b.stretch);
    const kept = cordKept(c);
    const sid = `rbelt:stretch:${b.name}`;
    if (b.stretch <= 1e-4) {
      out.push({ ...base, id: sid, status: "fail", title: `${b.name} hangs slack`, detail: `${own}, and the path round the pulleys is ${N0(b.length, 1)} mm: with no stretch it does not grip, and it drives by friction alone.`, fix: fitFix });
    } else if (b.stretch < c.stretchMin) {
      out.push({ ...base, id: sid, status: ring ? "warn" : "fail", title: `${b.name} is barely stretched: ${pct(b.stretch)}`, detail: `${own} for a ${N0(b.length, 1)} mm path, which puts ${force(fresh)} in each strand. ${c.stretchBasis}: under ${pct(c.stretchMin)} it slips at a light load and goes slack as it beds in.`, fix: fitFix });
    } else if (b.stretch > c.stretchMax) {
      const far = b.stretch > 2 * c.stretchMax;
      out.push({ ...base, id: sid, status: far ? "fail" : "warn", title: `${b.name} is stretched ${pct(b.stretch)}, past the ${pct(c.stretchMax)} it is meant to work at`, detail: `${own} for a ${N0(b.length, 1)} mm path, which puts ${force(fresh)} in each strand. ${c.stretchBasis}. Stretched further it creeps longer, wears faster and loads the shafts' bearings${far ? " (failing it at twice the working stretch is Kerf's own line, not a maker's)" : ""}.`, fix: fitFix });
    } else {
      const worst = b.nodes.reduce((m, nd) => Math.max(m, 2 * fresh * Math.sin((nd.wrap * Math.PI) / 360)), 0);
      out.push({ ...base, id: sid, status: "pass", title: `${b.name} is fitted at ${pct(b.stretch)} stretch: ${force(fresh)} in each strand`, detail: `${c.stretchBasis}. Its two strands pull up to ${force(worst)} on a pulley's shaft${kept < 0.999 ? `, and rubber held stretched relaxes: about ${force(fresh * kept)} is left in each strand after a year, which is what the grip below is worked out from` : ""}.` });
    }

    // the smallest pulley its makers allow
    const small = b.nodes.filter((nd) => nd.rootD < c.minPulley - 1e-6);
    if (small.length) out.push({ ...geo, id: `rbelt:pulley:${b.name}`, status: "fail", title: `${listOf(small.map((x) => x.name))} ${small.length > 1 ? "are" : "is"} too small for ${b.name}`, detail: `${small.map((x) => `${x.name} is ${N0(x.rootD, 1)} mm at the bottom of its groove`).join("; ")}. ${c.pulleyBasis}: ${N0(c.minPulley, 1)} mm for this ${N0(c.d, 1)} mm cord.`, fix: `Make ${small.length > 1 ? "them" : "it"} ${N0(c.minPulley, 0)} mm or more at the bottom of the groove, or use a thinner cord.` });
    else out.push({ ...geo, id: `rbelt:pulley:${b.name}`, status: "pass", title: `${b.name}: pulleys are big enough`, detail: `The smallest is ${N0(Math.min(...b.nodes.map((x) => x.rootD)), 1)} mm at the bottom of its groove. ${c.pulleyBasis}: ${N0(c.minPulley, 1)} mm for this ${N0(c.d, 1)} mm cord.` });

    // grooves that hold it, and pulleys in line
    const way = b.nodes[0].dir;
    const tight = b.nodes.filter((nd) => nd.width !== undefined && nd.width < c.d * 0.95);
    const bare = b.nodes.filter((nd) => !idler(nd, way) && nd.flange !== undefined && nd.flange < c.d * 0.3);
    const askew = b.nodes.filter((nd) => nd.fleet > FLEET_WARN);
    if (tight.length) out.push({ ...geo, id: `rbelt:groove:${b.name}`, status: "fail", title: `${b.name} does not fit ${listOf(tight.map((x) => x.name))}`, detail: `${tight.map((x) => `${x.name}'s groove is ${N0(x.width!, 1)} mm wide where the cord sits`).join("; ")}, and the cord is ${N0(c.d, 1)} mm: it rides on the rims and climbs out.`, fix: `Give the pulley a round groove the cord's own width and depth (lib.sheave sizes one from rope: ${N0(c.d, 1)}).` });
    else if (bare.length) out.push({ ...geo, id: `rbelt:groove:${b.name}`, status: "warn", title: `Nothing keeps ${b.name} on ${listOf(bare.map((x) => x.name))}`, detail: `${listOf(bare.map((x) => x.name))} ${bare.length > 1 ? "have" : "has"} no groove for the cord: a round belt wanders across a plain surface and runs off its edge.`, fix: `Cut a round groove the cord's own width and depth, or use lib.sheave with rope: ${N0(c.d, 1)}.` });
    else if (askew.length) out.push({ ...geo, id: `rbelt:groove:${b.name}`, status: "warn", title: `${b.name} meets ${listOf(askew.map((x) => x.name))} ${N0(Math.max(...askew.map((x) => x.fleet)), 0)}° off square`, detail: `The pulleys' grooves are not in line. A round belt takes a few degrees, and past about ${FLEET_WARN}° it rolls in its groove and climbs out (Kerf's own rule of thumb, not a maker's figure).`, fix: "Line the grooves up: move one pulley along its shaft until the belt leaves and meets each groove square." });
    else out.push({ ...geo, id: `rbelt:groove:${b.name}`, status: "pass", title: `${b.name} sits square in its grooves`, detail: `Every pulley's groove takes the ${N0(c.d, 1)} mm cord, and the belt meets each ${Math.max(0, ...b.nodes.map((x) => x.fleet)) < 0.05 ? "one square" : `within ${N0(Math.max(0, ...b.nodes.map((x) => x.fleet)), 1)}° of square`}.` });

    // the speeds it gives its pulleys
    const motions = parts.map((p) => (p ? motionOfPart(p, holds) : undefined));
    // belt speed for each degree of the drive, by each pulley that turns: all should agree
    const speed = (i: number) => (plain(motions[i]) ? motions[i]!.ratio * Math.sign(dot(motions[i]!.axis, b.nodes[i].axis) || 1) * b.nodes[i].dir * b.nodes[i].r : undefined);
    const turning = b.nodes.map((_, i) => i).filter((i) => speed(i) !== undefined);
    if (turning.length) {
      const ref = (b.drive ? turning.find((i) => b.nodes[i].name === b.drive) : undefined) ?? turning[0];
      const v = speed(ref)!;
      const want = (i: number) => v / (Math.sign(dot(motions[i]?.axis ?? b.nodes[i].axis, b.nodes[i].axis) || 1) * b.nodes[i].dir * b.nodes[i].r);
      const wrong = turning.filter((i) => i !== ref && Math.abs(speed(i)! - v) > RATIO_TOL * Math.abs(v));
      const still = b.nodes.map((_, i) => i).filter((i) => !motions[i] && !idler(b.nodes[i], way) && parts[i]);
      const mo = { ...geo, category: "motion" as const };
      const rn = b.nodes[ref];
      if (wrong.length) {
        const i = wrong[0];
        const nd = b.nodes[i];
        out.push({ ...mo, id: `rbelt:ratio:${b.name}`, status: "fail", title: `${nd.name} does not turn at the speed ${b.name} gives it`, detail: `${rn.name} turns at spin: ${N0(motions[ref]!.ratio, 4)} and the middle of the cord runs ${N0(2 * rn.r, 1)} mm across on it; on ${nd.name} it runs ${N0(2 * nd.r, 1)} mm across, so the belt turns ${nd.name} at ${N0(want(i), 4)}${Math.sign(want(i)) !== Math.sign(motions[ref]!.ratio) ? " (the other way)" : ""}. The design says spin: ${N0(motions[i]!.ratio, 4)}.`, fix: `Set spin: ${N0(want(i), 4)} on ${nd.name}${turning.length === 2 ? `, or spin: ${N0(speed(i)! / (Math.sign(dot(motions[ref]!.axis, rn.axis) || 1) * rn.dir * rn.r), 4)} on ${rn.name}` : ""}.` });
      } else if (still.length) {
        const i = still[0];
        const nd = b.nodes[i];
        out.push({ ...mo, id: `rbelt:ratio:${b.name}`, status: "warn", title: `${b.name} turns ${nd.name}, and the design leaves it still`, detail: `${rn.name} turns and ${b.name} runs round ${nd.name} too, so it turns with it: ${N0(Math.abs(rn.r / nd.r), 3)} turns for each turn of ${rn.name}.`, fix: `Give ${nd.name} axis:, axis_at: and spin: ${N0(want(i), 4)}.` });
      } else if (turning.length > 1) out.push({ ...mo, id: `rbelt:ratio:${b.name}`, status: "pass", title: `${b.name}'s pulleys turn at the speeds it gives them`, detail: `${turning.filter((i) => i !== ref).map((i) => `${b.nodes[i].name} turns ${N0(Math.abs(rn.r / b.nodes[i].r), 3)} times for each turn of ${rn.name}`).join("; ")}, by the diameters the middle of the cord runs on. A friction belt creeps a little under load, so it does not keep step exactly: use a toothed belt where position matters.` });
    }

    // what it can pass before it slips
    const g = beltGrip(b, model);
    if (g) {
      const driveNode = (b.drive ? b.nodes.find((nd) => nd.name === b.drive) : undefined) ?? g.at;
      const cap = g.force * driveNode.r;
      const how = `With ${force(g.t0)} in each strand${kept < 0.999 ? " (what a year held stretched leaves)" : ""}, friction of ${N0(g.mu, 2)} on ${g.on} (${c.muBasis}) and ${N0(g.at.wrap, 0)}° of wrap on ${g.at.name}, the tight side can carry ${N0(capstan(g.mu, g.at.wrap), 1)} times the slack side before the belt slips there: ${force(g.force)} of pull, which is ${torque(cap)} at ${driveNode.name}`;
      // the torque it must pass: as the design gives it, or what the weight on this drive puts on the motor's pulley
      let need: { nmm: number; why: string; given: boolean } | undefined = b.torque !== undefined ? { nmm: b.torque, why: `the design asks it to pass ${torque(b.torque)} there (torque:)`, given: true } : undefined;
      if (!need) {
        // a winch drum on one of its pulleys with the motors that hold it on another: the rope's pull passes through the belt
        for (const w of pulls) {
          const j = motions.indexOf(w.motion);
          if (j < 0 || !w.motors.length || !w.motors.every((m) => m.shaft !== w.motion && motions.includes(m.shaft))) continue;
          const pull = w.torque / b.nodes[j].r;
          need = { nmm: pull * driveNode.r, why: `the pull of ${w.rope} on ${w.drum} (${force(w.tension)} at ${N0(w.r, 1)} mm from its axis) is held by ${listOf(w.motors.map((m) => m.comp))} through this belt, which makes it ${force(pull)} of pull to pass`, given: true };
          break;
        }
      }
      const gid = `rbelt:grip:${b.name}`;
      if (!need) out.push({ ...base, id: gid, status: "info", title: `${b.name} can pass ${torque(cap)} at ${driveNode.name} before it slips`, detail: `${how}. Give the belt torque: (what it must pass at its driving pulley) to have that checked.` });
      else if (need.nmm > cap) out.push({ ...base, id: gid, status: need.given ? "fail" : "warn", title: `${b.name} slips: it can pass ${torque(cap)} and has ${torque(need.nmm)} to pass`, detail: `${how}. ${need.why[0].toUpperCase()}${need.why.slice(1)}.`, fix: `Stretch it more (up to ${pct(c.stretchMax)}), use a thicker cord, or give ${g.at.name} more wrap or a bigger diameter.`, margin: cap / need.nmm });
      else if (need.nmm > GRIP_MARGIN * cap) out.push({ ...base, id: gid, status: "warn", title: `${b.name} is close to slipping: ${N0((need.nmm / cap) * 100, 0)} % of its grip`, detail: `${how}. ${need.why[0].toUpperCase()}${need.why.slice(1)}. Oil, dust and age all take grip away: Kerf asks for ${N0((1 - GRIP_MARGIN) * 100, 0)} % in hand, which is its own margin.`, fix: `Stretch it more (up to ${pct(c.stretchMax)}), use a thicker cord, or give ${g.at.name} more wrap or a bigger diameter.`, margin: cap / need.nmm });
      else out.push({ ...base, id: gid, status: "pass", title: `${b.name} grips: ${N0((need.nmm / cap) * 100, 0)} % of what it can pass`, detail: `${how}. ${need.why[0].toUpperCase()}${need.why.slice(1)}.`, margin: cap / need.nmm });
    }
  }
  return out;
}
