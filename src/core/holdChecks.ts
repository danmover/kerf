// Checks that the design really holds together, the way it would on the bench:
// every screw closes on its stack (head seated, no gap between the parts, the
// nut against its part) or it is loose and holds nothing; a part that turns on
// a screw is not clamped solid by it; parts fastened together are not told to
// move differently; and every part is held in place by something (a screw,
// an insert, a fit, a pivot, or a held: the design declares) rather than
// floating or just resting where gravity and friction leave it. Each finding
// says exactly what to move and where, so a quick model can fix it in one go.

import { turns, type EvalPart, type Model } from "./model";
import type { CheckItem } from "./checks";
import type { ChecksResult } from "../kernel/protocol";
import { applyXforms, vadd, vscale, type V3 } from "../kernel/recipe";
import { fmtNum } from "../lang/values";
import { LOOSE_GAP, SEAT_TOL, isFastener, motionOfPart, type Holds, type Stack } from "./holds";
import { mountParts } from "../machine/harness/inputs";
import { catalogPart } from "../machine/catalog";
import type { CatalogKind } from "../machine/types";

const pt = (p: V3) => `(${p.map((x) => fmtNum(Math.abs(x) < 0.005 ? 0 : x, 2)).join(", ")})`;
const origin = (p: EvalPart): V3 => applyXforms([0, 0, 0], p.xf);
const listOf = (names: string[]) => {
  const a = [...new Set(names)];
  return a.length <= 3 ? a.join(", ").replace(/, ([^,]*)$/, " and $1") : `${a.slice(0, 3).join(", ")} and ${a.length - 3} more`;
};
/** Bought parts held by their own fixing where they touch: panel parts by their nut, knobs on their shafts, seals pressed into their bores. */
const SEATED_KINDS = new Set<CatalogKind>(["jack", "switch", "potentiometer", "knob", "seal"]);

function screwName(st: Stack): string {
  const f = st.screw.fastener!;
  return `${f.size}${f.length ? `×${fmtNum(f.length)}` : ""} ${st.screw.name}`;
}

/** Findings for the screws whose stacks are open, grouped so a pattern of screws gives one line. */
function stackItems(holds: Holds): CheckItem[] {
  const out: CheckItem[] = [];
  const groups = new Map<string, { st: Stack; n: number; parts: Set<string> }>();
  let tight = 0;
  for (const st of holds.stacks) {
    if (st.set || !st.hostKind) continue;
    if (st.tight || st.hinge) tight++;
    if (!st.gap) continue;
    // a nyloc nut set with running clearance is how a pivot bolt is meant to be
    if (st.pivots.length && st.hostKind === "nyloc") continue;
    const key = `${st.screw.name}|${st.gap.at}|${st.gap.before.name}|${st.gap.after?.name ?? ""}|${fmtNum(st.gap.size, 1)}`;
    const g = groups.get(key) ?? { st, n: 0, parts: new Set<string>() };
    g.n++;
    for (const id of [st.screw.id, st.gap.before.id, ...(st.gap.after ? [st.gap.after.id] : [])]) g.parts.add(id);
    groups.set(key, g);
  }
  for (const { st, n, parts } of groups.values()) {
    const gap = st.gap!;
    const size = fmtNum(gap.size, 2);
    const status = gap.size > LOOSE_GAP ? "fail" : "warn";
    const these = n > 1 ? `these ${n} screws` : "the screw";
    const name = screwName(st);
    let title: string;
    let detail: string;
    let fix: string;
    if (gap.at === "head") {
      const to = vadd(origin(st.screw), vscale(st.axis, gap.size));
      title = `${name}: head stands ${size} mm off ${gap.before.name}`;
      detail = `Nothing meets the underside of the head for ${size} mm, so tightening ${these} clamps nothing: ${n > 1 ? "they are" : "it is"} loose and ${gap.before.name} is not held by ${n > 1 ? "them" : "it"}.`;
      fix = n > 1 ? `Move ${st.screw.name} ${size} mm along its axis, onto ${gap.before.name}'s face, or move ${gap.before.name} up to the heads.` : `Move ${st.screw.name} to at: ${pt(to)} (${size} mm along its axis) so the head sits on ${gap.before.name}, or move ${gap.before.name} up to the head.`;
    } else if (gap.at === "nut") {
      const nut = gap.before;
      const to = vadd(origin(nut), vscale(st.axis, -gap.size));
      title = `${nut.name} stands ${size} mm off ${gap.after?.name ?? "its part"}: ${st.screw.name} is loose`;
      detail = `The ${nut.libKind === "standoff" ? "standoff" : "nut"} does not reach ${gap.after?.name ?? "the parts"} by ${size} mm, so tightening ${these} would only spin it down the thread: as drawn nothing is clamped and ${listOf(st.clamped.map((p) => p.name)) || "the parts"} can move.`;
      fix = n > 1 ? `Move ${nut.name} ${size} mm back along the screw so it sits against ${gap.after?.name ?? "the last part"} (lib.nut's at: is the centre of the face that should touch).` : `Move ${nut.name} to at: ${pt(to)} so its face sits against ${gap.after?.name ?? "the last part"} (lib.nut's at: is the centre of that face).`;
    } else {
      title = `${size} mm gap inside ${name}'s joint, between ${gap.after?.name ?? "the head"} and ${gap.before.name}`;
      detail = `The parts the screw passes through do not meet: ${gap.after?.name ?? "the head"} ends ${size} mm before ${gap.before.name} begins, so tightening ${these} has to pull them together${gap.size > LOOSE_GAP ? ", bending or cracking them" : ""}, or ${n > 1 ? "they hold" : "it holds"} nothing.`;
      fix = `Move ${gap.after?.name ?? st.screw.name} ${size} mm along the screw onto ${gap.before.name}, or fill the gap with a ${size} mm spacer or washer.`;
    }
    out.push({ id: `clamp:${gap.at}:${st.screw.name}:${gap.before.name}${n > 1 ? `#${n}` : ""}`, category: "assembly", status, title, detail, fix, parts: [...parts], span: st.screw.span, basis: "geometry" });
  }

  // a part that turns on a screw must not be clamped solid by it
  const pivotGroups = new Map<string, { st: Stack; part: EvalPart; n: number }>();
  for (const st of holds.stacks) {
    if (!st.tight || !st.pivots.length || st.hostKind === "nyloc") continue;
    for (const p of st.pivots) {
      if (!st.clamped.includes(p)) continue;
      const mine = st.layers.filter((l) => l.part === p);
      // a sleeve or bearing through it that is at least as long carries the clamp instead
      const sleeved = mine.every((l) => st.layers.some((o) => o.part !== p && st.clamped.includes(o.part) && o.a <= l.a + SEAT_TOL && o.b >= l.b - SEAT_TOL));
      if (sleeved) continue;
      const key = `${st.screw.name}|${p.name}`;
      const g = pivotGroups.get(key) ?? { st, part: p, n: 0 };
      g.n++;
      pivotGroups.set(key, g);
    }
  }
  for (const { st, part } of pivotGroups.values()) {
    const thick = st.layers.filter((l) => l.part === part).reduce((s, l) => s + (l.b - l.a), 0);
    out.push({
      id: `clamp:pivot:${st.screw.name}:${part.name}`,
      category: "motion",
      status: "warn",
      title: `${part.name} turns on ${st.screw.name}, which clamps it solid`,
      detail: `${part.name} is drawn turning about ${st.screw.name}'s axis, but the screw is tightened against it, so it would be gripped and not turn (or the screw would work loose as it does).`,
      fix: `Put a sleeve or bushing through ${part.name} about 0.1 to 0.2 mm longer than its ${fmtNum(thick, 1)} mm, so the screw clamps the sleeve and ${part.name} turns on it; or use a shoulder screw, or a nyloc nut (lib.nut(${st.screw.fastener!.size}, type: "nyloc")) left a little slack.`,
      parts: [st.screw.id, part.id],
      span: part.span,
      basis: "geometry",
    });
  }

  const opened = holds.stacks.filter((s) => s.hostKind && !s.set);
  if (opened.length && tight === opened.length) {
    const hinges = opened.filter((s) => s.hinge).length;
    out.push({ id: "clamp:ok", category: "assembly", status: "pass", title: "Every screw clamps its parts", detail: `${opened.length} screw${opened.length > 1 ? "s" : ""}: each head sits on its part and every face meets the next down to the nut, insert or thread${hinges ? ` (${hinges} ${hinges > 1 ? "are hinges" : "is a hinge"} on a lock nut, with running clearance)` : ""}${opened.some((s) => s.measured) ? "; measured on the part shapes" : ""}.`, basis: "geometry" });
  }
  return out;
}

/** Parts fastened together but told to move differently. */
function conflictItems(holds: Holds): CheckItem[] {
  return holds.conflicts.map((c, i) => {
    const movers = c.moving.map((p) => p.name);
    const still = c.still.map((p) => p.name);
    const by = listOf(c.by);
    const title = still.length ? `${listOf(movers)} turns but is fastened to ${listOf(still)}` : `${listOf(movers)} are fastened together but turn differently`;
    const detail = still.length
      ? `${by} join${c.by.length > 1 ? "" : "s"} ${listOf(movers)} to ${listOf(still)}, which stays still (${c.still.some((p) => p.kind === "component") ? "a bought part's fixed half" : "it stands on the floor"}), so ${c.by.length > 1 ? "they lock" : "it locks"} the motion: the drive would stall or strip.`
      : `${by} fasten${c.by.length > 1 ? "" : "s"} them rigidly, yet each has its own motion, so the fastening would stop them or shear.`;
    return {
      id: `motion:fastened:${i}:${movers.join("+")}`,
      category: "motion" as const,
      status: "fail" as const,
      title,
      detail,
      fix: `Fasten each moving part only to parts that move with it (give those rides: or turns_with:), let it turn on a pivot on its own axis (a shaft in a bearing, or a screw on that axis with a sleeve), or take ${by} out.`,
      parts: [...c.moving, ...c.still].map((p) => p.id),
      span: c.moving[0]?.span,
      basis: "geometry" as const,
    };
  });
}

/** A gear carried round by a moving part while its teeth are in a gear that does not go round with it. */
function rideItems(model: Model, holds: Holds): CheckItem[] {
  const out: CheckItem[] = [];
  for (const g of model.parts) {
    const c = holds.carried.get(g.id);
    if (!g.gear?.meshWith || !c || turns(g.motion)) continue;
    const other = model.parts.find((q) => q.name === g.gear!.meshWith && q.gear);
    if (!other || motionOfPart(other, holds) === c.motion) continue;
    out.push({
      id: `motion:rides:${g.name}`,
      category: "motion",
      status: "fail",
      title: `${g.name} is carried round by ${c.from.name} but its teeth are in ${other.name}`,
      detail: `${g.name} is fastened to ${c.from.name}, which turns, while ${other.name} does not turn with it, so as drawn the teeth would jam or strip instead of rolling round.`,
      fix: `Give ${g.name} rides: ${c.from.name} and mesh: ${other.name}, so it turns on its own axis as ${c.from.name} carries it round (like a planet gear), and turn ${g.name} on a pin or bearing on ${c.from.name} rather than bolting it solid.`,
      parts: [g.id, c.from.id, other.id],
      span: g.span,
      basis: "geometry",
    });
  }
  return out;
}

/**
 * Every part held in place: joined (screws, inserts, fits, pivots, threads, bands, solder) to the parts that stand
 * on the floor, or declared held. Parts that only touch rest where gravity leaves them; parts touching nothing float.
 */
function heldItems(model: Model, holds: Holds, kernel: ChecksResult, volume: (p: EvalPart) => number | undefined): CheckItem[] {
  const contacts = kernel.contacts;
  const boxes = kernel.boxes;
  if (!contacts || !boxes) return [];
  const parts = model.parts.filter((p) => !p.hidden && !(p.imported && p.imported.kind !== "solid") && boxes[p.id]);
  if (parts.length < 2) return [];
  const byId = new Map(parts.map((p) => [p.id, p]));
  const idx = new Map(parts.map((p, i) => [p.id, i]));
  const root = parts.map((_, i) => i);
  const find = (i: number): number => {
    while (root[i] !== i) i = root[i] = root[root[i]];
    return i;
  };
  const link = (a: string, b: string) => {
    const i = idx.get(a);
    const j = idx.get(b);
    if (i !== undefined && j !== undefined) root[find(i)] = find(j);
  };
  for (const j of holds.joins) link(j.a.id, j.b.id);
  // modules (boards, batteries, supplies) are held or not by the wiring checks; clips, springs, belts and printed
  // films or stickers (a part thinner than 0.3 mm) are held by what they touch
  const modules = mountParts(model);
  const instance = (p: EvalPart) => p.id.split(".")[0];
  // a bought part's catalog entry, for any of its solids (a pot's case and shaft as well as its body)
  const catIds = new Map(model.parts.filter((p) => p.bom?.catalogId).map((p) => [instance(p), p.bom!.catalogId!]));
  const catOf = (p: EvalPart) => {
    const id = p.kind === "component" ? catIds.get(instance(p)) : undefined;
    return id ? catalogPart(id) : undefined;
  };
  const thin = (p: EvalPart) => {
    const v = volume(p);
    const b = boxes[p.id];
    if (v === undefined || !b) return false;
    const d = [0, 1, 2].map((k) => b[1][k] - b[0][k]).sort((x, y) => y - x);
    return v / Math.max(1e-9, d[0] * d[1]) < 0.3;
  };
  const seated = (p: EvalPart) => {
    const cat = catOf(p);
    return !!cat && SEATED_KINDS.has(cat.kind);
  };
  const declared = (p: EvalPart) => modules.has(instance(p)) || !!p.flex?.length || !!p.spring || p.libKind === "belt" || thin(p) || seated(p);
  // a part that says how it is held (held: "glued") is taken at its word
  const says = (p: EvalPart) => !!p.held || !!(model.machine?.components ?? []).find((c) => c.name === p.name && c.held);
  // parts that are not built into the design: an external supply, an inline connector or fuse on its wires, and
  // anything removable (a lid, a launch tool)
  const apart = (p: EvalPart) => {
    if (p.removable) return true;
    const cat = catOf(p);
    return !!cat && (!!cat.external || cat.kind === "connector" || /\binline\b/i.test(cat.name));
  };
  const touchesOf = new Map<string, { other: string; under: boolean }[]>();
  for (const c of contacts) {
    if (!byId.has(c.a) || !byId.has(c.b)) continue;
    (touchesOf.get(c.a) ?? touchesOf.set(c.a, []).get(c.a)!).push({ other: c.b, under: c.aOnB });
    (touchesOf.get(c.b) ?? touchesOf.set(c.b, []).get(c.b)!).push({ other: c.a, under: c.bOnA });
    if (declared(byId.get(c.a)!) || declared(byId.get(c.b)!)) link(c.a, c.b);
  }
  // the parts standing on the floor (the lowest) hold the rest up
  const zmin = Math.min(...parts.filter((p) => !isFastener(p)).map((p) => boxes[p.id][0][2]));
  const ground = new Set<number>();
  for (const p of parts) if ((!isFastener(p) && boxes[p.id][0][2] <= zmin + 0.5) || says(p)) ground.add(find(idx.get(p.id)!));

  const clusters = new Map<number, EvalPart[]>();
  for (const p of parts) {
    const r = find(idx.get(p.id)!);
    if (ground.has(r)) continue;
    clusters.set(r, [...(clusters.get(r) ?? []), p]);
  }
  const out: CheckItem[] = [];
  const moves = (p: EvalPart) => turns(motionOfPart(p, holds));
  for (const members of clusters.values()) {
    // fasteners on their own are reported by the screw checks (loose screws hold nothing)
    const shown = members.filter((p) => !isFastener(p) && !apart(p));
    if (!shown.length) continue;
    const ids = new Set(members.map((p) => p.id));
    const touches = members.flatMap((p) => (touchesOf.get(p.id) ?? []).filter((t) => !ids.has(t.other)));
    const names = listOf(shown.map((p) => p.name));
    const one = shown.length === 1;
    const span = shown[0].span;
    const partIds = shown.map((p) => p.id);
    if (!touches.length) {
      out.push({
        id: `held:float:${shown[0].id}`,
        category: "assembly",
        status: "fail",
        title: `${names} ${one ? "floats" : "float"}: nothing holds ${one ? "it" : "them"}`,
        detail: `${names} ${one ? "touches" : "touch"} no other part (within 0.3 mm) and nothing fastens ${one ? "it" : "them"} in, so ${one ? "it" : "they"} would fall the moment the design is built or moved.`,
        fix: `Move ${names} onto the part ${one ? "it" : "they"} should sit on, then fasten ${one ? "it" : "them"}: screws with nuts or into inserts or tapped holes, a press fit, or a pin. If ${one ? "it is" : "they are"} glued or strapped, say so with held: "glued with epoxy".`,
        parts: partIds,
        span,
        basis: "geometry",
      });
      continue;
    }
    const others = [...new Set(touches.map((t) => t.other))].map((id) => byId.get(id)!);
    const on = [...new Set(touches.filter((t) => t.under).map((t) => t.other))].map((id) => byId.get(id)!);
    const movers = members.some(moves) ? shown.filter(moves) : others.filter(moves);
    const moving = movers.length > 0;
    if (on.length) {
      out.push({
        id: `held:rests:${shown[0].id}`,
        category: "assembly",
        status: "fail",
        title: `${names} only ${one ? "rests" : "rest"} on ${listOf(on.map((p) => p.name))}`,
        detail: `Nothing fastens ${names} to the rest of the design: ${one ? "it sits" : "they sit"} on ${listOf(on.map((p) => p.name))} held only by ${one ? "its" : "their"} weight${moving ? `, and ${listOf(movers.map((p) => p.name))} ${movers.length === 1 ? "moves" : "move"}, so ${one ? "it slides or is flung off" : "they slide or are flung off"} as soon as it runs` : `, so a knock, a tilt or carrying the design moves ${one ? "it" : "them"}`}.`,
        fix: `Fasten ${names} to ${on[0].name}: screws through both into a nut (seated against the far face), a heat-set insert or a tapped hole, or a press-fit pin; calc.fastener() picks the screw. If ${one ? "it is" : "they are"} meant to lift off, mark ${one ? "it" : "them"} removable; if glued, say held: "glued".`,
        parts: [...partIds, ...on.map((p) => p.id)],
        span,
        basis: "geometry",
      });
    } else {
      out.push({
        id: `held:falls:${shown[0].id}`,
        category: "assembly",
        status: "fail",
        title: `${names} ${one ? "is" : "are"} not held up`,
        detail: `${names} only ${one ? "touches" : "touch"} ${listOf(others.map((p) => p.name))} at the side or from below and nothing fastens ${one ? "it" : "them"}, so gravity pulls ${one ? "it" : "them"} away.`,
        fix: `Fasten ${names} to ${others[0].name} (screws into a nut, insert or tapped hole, or a pin), or rest ${one ? "it" : "them"} on a part below and fasten ${one ? "it" : "them"} there.`,
        parts: [...partIds, ...others.map((p) => p.id)],
        span,
        basis: "geometry",
      });
    }
  }
  if (!out.length) {
    const fixed = parts.filter((p) => !isFastener(p)).length;
    out.push({ id: "held:ok", category: "assembly", status: "pass", title: "Every part is held in place", detail: `${fixed} part${fixed === 1 ? "" : "s"}: each is fastened, fitted or pivoted to the parts standing on the floor, or says how it is held; none floats or just rests.`, basis: "geometry" });
  }
  return out;
}

/** The hold-together checks. Contacts come from the kernel; without them only the screw stacks are checked. */
export function holdChecks(model: Model, holds: Holds, kernel?: ChecksResult | null, volume: (p: EvalPart) => number | undefined = () => undefined): CheckItem[] {
  return [...stackItems(holds), ...conflictItems(holds), ...rideItems(model, holds), ...(kernel ? heldItems(model, holds, kernel, volume) : [])];
}
