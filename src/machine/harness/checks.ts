// Words the wiring and mounting findings (clash.ts, mounts.ts) as check
// items: what is wrong, where, and what to change, naming the cables by
// their wire-list ids and the parts by their names in the design, so the
// assistant can find and fix each one. Runs on the main thread when the
// cable worker's results arrive.

import type { CheckItem } from "../../core/checks";
import type { Model } from "../../core/model";
import type { V3 } from "../../kernel/recipe";
import { PULL, type Harness, type HarnessWire, type PlugEnd } from "./harness";
import { PLUG_NAME } from "./plugs";
import type { CableCross, EndRef, WiringFindings } from "./clash";
import type { MountResult } from "./mounts";

/** Crossings this close together are one crowded place, mm. */
const CROWD = 20;
/** Spans longer than this are a warning; shorter ones are listed with the ties, mm. */
const LONG_SPAN = 150;
/** A cable that crosses a pivot further than this from its axis needs a long slack loop, mm. */
const PIVOT_FAR = 30;
/** How far round a crossing point the router looks for room, in words (route.ts VIA_REACH). */
const VIA_WORD = "40 mm";

const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const at = (p: V3) => `(${p.map((v) => Math.round(v)).join(", ")})`;
const list = (xs: string[], max = 6) => (xs.length <= max ? xs.join(", ") : `${xs.slice(0, max).join(", ")} and ${xs.length - max} more`);
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** What a plug kind is called after "the": the connector, or where the wire is fixed when there is none. */
const plugNoun = (k: PlugEnd["spec"]["kind"]) => (k === "solder" ? "solder pads" : k === "lug" ? "solder lugs" : k === "lead" ? "part's own lead" : PLUG_NAME[k]);

/** The way a unit vector points, in the assembly's axes. */
function axisWord(d: V3): string {
  const k = [0, 1, 2].reduce((b, i) => (Math.abs(d[i]) > Math.abs(d[b]) ? i : b), 0);
  return `${d[k] >= 0 ? "+" : "−"}${"XYZ"[k]}`;
}

export function wiringItems(h: Harness, f: WiringFindings | null, mounts: MountResult[], model: Model): CheckItem[] {
  const parts = new Map(model.parts.map((p) => [p.id, p]));
  const name = (id: string) => parts.get(id)?.name ?? id;
  const wires = new Map(h.wires.map((w) => [w.id, w]));
  const endOf = (r: EndRef): PlugEnd | undefined => wires.get(r.wire)?.ends[r.end];
  const endText = (e: PlugEnd) => `${e.comp} ${e.label}`;
  const wireText = (w: HarnessWire) => `${w.id} (${endText(w.ends[0])} → ${endText(w.ends[1])})`;
  const wt = (id: string) => {
    const w = wires.get(id);
    return w ? wireText(w) : id;
  };
  const items: CheckItem[] = [];
  const add = (it: Omit<CheckItem, "basis" | "category"> & { category?: CheckItem["category"] }) => items.push({ category: "electrical", basis: "geometry", ...it });

  if (f) {
    // ---- cables through parts, by part
    const through = new Map<string, typeof f.cableHits>();
    const pressed = new Map<string, typeof f.cableHits>();
    for (const c of f.cableHits) {
      const m = c.through ? through : pressed;
      m.set(c.part, [...(m.get(c.part) ?? []), c]);
    }
    for (const [part, hits] of through) {
      const ids = [...new Set(hits.map((c) => c.wire))];
      add({
        id: `wiring:through:${part}`,
        status: "fail",
        title: `${ids.length === 1 ? `Cable ${ids[0]} runs` : `Cables ${list(ids, 4)} run`} through ${name(part)}`,
        detail: `${hits.map((c) => `${wt(c.wire)} passes through it for ${c.length.toFixed(0)} mm near ${at(c.at)}`).join("; ")}. There is no way round it with the room the cables need, so the router had to cut through.`,
        parts: [part],
        fix: `Make room for the cables to pass ${name(part)}: a hole or slot through it where they must cross (with a grommet), a channel along it, or move the parts so there is a gap at least as wide as the bundle.`,
      });
    }
    for (const [part, hits] of pressed) {
      const ids = [...new Set(hits.map((c) => c.wire))];
      add({
        id: `wiring:pressed:${part}`,
        status: "warn",
        title: `${ids.length === 1 ? `Cable ${ids[0]} is` : `Cables ${list(ids, 4)} are`} squashed against ${name(part)}`,
        detail: `${hits.map((c) => `${wt(c.wire)} presses ${c.depth.toFixed(1)} mm into it for ${c.length.toFixed(0)} mm near ${at(c.at)}`).join("; ")}. The gap is narrower than the cable.`,
        parts: [part],
        fix: `Widen the gap the cable runs through, or route it another way.`,
      });
    }

    // ---- crowded bundles: crossings close together are one place where the cables have no room
    const groups: CableCross[][] = [];
    for (const c of [...f.crossings].sort((a, b) => b.depth - a.depth)) {
      const g = groups.find((x) => x.some((y) => dist(y.at, c.at) < CROWD));
      if (g) g.push(c);
      else groups.push([c]);
    }
    groups.forEach((g) => {
      const ids = [...new Set(g.flatMap((c) => [c.a, c.b]))].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
      const near = [...new Set(g.map((c) => c.near).filter((x): x is string => !!x))];
      const deepest = Math.max(...g.map((c) => c.depth));
      const where = near.length ? ` by ${list(near.map(name), 3)}` : "";
      add({
        id: `wiring:crowded:${ids.join("-")}`,
        status: "warn",
        title: g.length === 1 ? `Cables ${g[0].a} and ${g[0].b} run through each other${where}` : `${plural(ids.length, "cable")} are crowded through each other${where}`,
        detail: `${list(ids, 10)} overlap by up to ${deepest.toFixed(1)} mm near ${at(g[0].at)}: there is not room for them all side by side there.`,
        parts: near,
        fix: `Give the bundle more room there (a wider gap, a channel or a hole sized for every cable through it), send some of the cables another way, or join several into one multi-core or ribbon cable.`,
      });
    });

    // ---- plugs into parts, by the part they sit on and what they hit
    const plugHit = new Set(f.plugHits.map((p) => `${p.wire}|${p.end}`));
    const byHit = new Map<string, { e: PlugEnd; part: string }[]>();
    for (const p of f.plugHits) {
      const e = endOf(p);
      if (!e) continue;
      const k = `${e.comp}|${p.part}`;
      byHit.set(k, [...(byHit.get(k) ?? []), { e, part: p.part }]);
    }
    for (const [k, hits] of byHit) {
      const { e, part } = hits[0];
      const pins = [...new Set(hits.map((x) => x.e.label))];
      const kind = PLUG_NAME[e.spec.kind];
      add({
        id: `wiring:plug:${k}`,
        status: "fail",
        title: `${hits.length === 1 ? `The plug on ${e.comp} ${e.label} runs` : `${plural(hits.length, "plug")} on ${e.comp} run`} into ${name(part)}`,
        detail: `The ${kind} ${hits.length === 1 ? "plug goes" : "plugs go"} on along ${axisWord(e.frame.z)} on ${e.comp} (${list(pins, 8)}), and ${name(part)} is in the way, so ${hits.length === 1 ? "it" : "they"} cannot be plugged in.`,
        parts: [e.partId, part],
        fix: `Turn or move ${e.comp} so its connectors face open space (header pins that point down need the board on standoffs tall enough for the plugs and their leads, or the header soldered the other way up), or move ${name(part)}.`,
      });
    }
    // ---- plugs into each other
    const clashes = new Map<string, typeof f.plugClashes>();
    for (const c of f.plugClashes) {
      const a = endOf(c.a);
      const b = endOf(c.b);
      if (!a || !b) continue;
      const k = [a.comp, b.comp].sort().join("|");
      clashes.set(k, [...(clashes.get(k) ?? []), c]);
    }
    for (const [k, cs] of clashes) {
      const pairs = cs.map((c) => `${endText(endOf(c.a)!)} and ${endText(endOf(c.b)!)}`);
      const [ca, cb] = k.split("|");
      add({
        id: `wiring:plugs:${k}`,
        status: "fail",
        title: ca === cb ? `Plugs on ${ca} overlap each other` : `Plugs on ${ca} and ${cb} overlap`,
        detail: `${list(pairs, 5)} take the same space, so both cannot be plugged in.`,
        parts: [...new Set(cs.flatMap((c) => [endOf(c.a)!.partId, endOf(c.b)!.partId]))],
        fix: `Use pins or terminals that are far enough apart for their plugs, combine the wires into one multi-way plug, or join them in a splice behind one plug.`,
      });
    }
    // ---- no room for the lead out of the plug, or to pull it off (left out where the plug itself is in the way)
    const blocked = (rows: typeof f.leadBlocked, what: "lead" | "pull") => {
      const by = new Map<string, { e: PlugEnd; part: string; need: number }[]>();
      for (const b of rows) {
        if (plugHit.has(`${b.wire}|${b.end}`)) continue;
        const e = endOf(b);
        if (!e) continue;
        const k = `${e.comp}|${b.part}`;
        by.set(k, [...(by.get(k) ?? []), { e, part: b.part, need: b.need }]);
      }
      for (const [k, rs] of by) {
        const { e, part, need } = rs[0];
        const pins = list([...new Set(rs.map((r) => r.e.label))], 8);
        if (what === "lead")
          add({
            id: `wiring:lead:${k}`,
            status: "warn",
            title: `No room for the ${rs.length === 1 ? "cable" : "cables"} to leave ${e.comp} ${rs.length === 1 ? e.label : ""}`.replace(/ +$/, ""),
            detail: `${name(part)} is within ${need.toFixed(0)} mm behind the ${plugNoun(e.spec.kind)} on ${e.comp} (${pins}), so the cable has to bend hard right at the contacts, which works them loose.`,
            parts: [e.partId, part],
            fix: `Leave about ${need.toFixed(0)} mm of straight cable behind the plug: move ${name(part)} back, or turn ${e.comp} so its connectors face open space.`,
          });
        else
          add({
            id: `wiring:pull:${k}`,
            status: "warn",
            title: `${rs.length === 1 ? `The plug on ${e.comp} ${e.label}` : `Plugs on ${e.comp}`} cannot be pulled off`,
            detail: `${name(part)} is in the way of pulling the ${PLUG_NAME[e.spec.kind]} (${pins}) straight off: it needs ${PULL[e.spec.kind]} mm of travel and room to grip, ${need.toFixed(0)} mm in all.`,
            parts: [e.partId, part],
            fix: `Leave room to unplug it, make ${name(part)} come off first (a lid or cover), or turn ${e.comp} so its connectors face an opening.`,
          });
      }
    };
    blocked(f.leadBlocked, "lead");
    blocked(f.pullBlocked, "pull");
    // ---- a part's own lead, or a bought cable, that does not reach
    const short = new Map<string, NonNullable<typeof f.reach>>();
    for (const r of f.reach ?? []) {
      const w = wires.get(r.wire);
      if (!w) continue;
      // the wires of one lead or cable between the same two parts are one finding
      const k = `${r.lead}|${w.ends[0].comp}|${w.ends[1].comp}`;
      short.set(k, [...(short.get(k) ?? []), r]);
    }
    for (const [k, rs] of short) {
      const w = wires.get(rs[0].wire)!;
      const need = Math.max(...rs.map((r) => r.need));
      const have = rs[0].have;
      const own = /own lead/.test(rs[0].lead);
      const lead = own ? rs[0].lead.replace(/'s own lead/g, "'s lead") : `The ${rs[0].lead}`;
      add({
        id: `wiring:reach:${k}`,
        status: "fail",
        title: `${lead} does not reach from ${w.ends[0].comp} to ${w.ends[1].comp}`,
        detail: `${own ? `${lead} is` : `It is`} ${have.toFixed(0)} mm long and the run between ${endText(w.ends[0])} and ${endText(w.ends[1])} is ${need.toFixed(0)} mm (${list(rs.map((r) => r.wire), 6)}), ${(need - have).toFixed(0)} mm too far.`,
        parts: [w.ends[0].partId, w.ends[1].partId],
        fix: own ? `Move ${w.ends[0].comp} and ${w.ends[1].comp} closer or turn one so its connector faces the other, or add an extension lead and say so in the wiring.` : `Move the two closer, or use a longer cable (change cable: and length: on the wire).`,
      });
    }
    // ---- cables that leave the assembly on the way between two places inside it
    if (f.outside.length)
      add({
        id: "wiring:outside",
        status: "warn",
        title: `${f.outside.length === 1 ? `Cable ${f.outside[0].wire} leaves` : `${plural(f.outside.length, "cable")} leave`} the enclosure and come back in`,
        detail: `${f.outside.map((o) => `${wt(o.wire)} runs ${o.length.toFixed(0)} mm outside, first at ${at(o.at)}`).join("; ")}. There is not room for ${f.outside.length === 1 ? "it" : "them"} inside, so the router took ${f.outside.length === 1 ? "it" : "them"} out through an opening.`,
        fix: `Make room inside for the cables (a channel, a pass-through hole between compartments, or a gap beside the boards), or route them another way.`,
      });
    // ---- splices
    const spliceBlocked = f.splices.filter((s) => s.blocked);
    for (const s of spliceBlocked)
      add({
        id: `wiring:splice:${s.comp}.${s.pin}`,
        status: "warn",
        title: `No room for the splice at ${s.comp} ${s.label}`,
        detail: `${plural(s.wires.length, "wire")} (${list(s.wires, 8)}) share ${s.comp} ${s.label}, more than its terminal takes, so they are crimped together in a heat-shrunk splice behind its plug, and ${name(s.blocked!)} is in the way of it on every side.`,
        parts: [s.blocked!],
        fix: `Leave room behind the terminal for the splice, or give the net its own distribution point: a terminal block, a Wago lever connector or a bus bar where the wires meet.`,
      });
    if (f.splices.length)
      add({
        id: "wiring:splices",
        status: "info",
        title: `${plural(f.splices.length, "splice")} where terminals take fewer wires than meet there`,
        detail: `${f.splices.map((s) => `${s.comp} ${s.label}: ${s.wires.length} wires`).join("; ")}. Each is a crimp splice under heat-shrink just behind the terminal's plug (add crimp splices and heat-shrink to the parts list), or a terminal block if you'd rather.`,
      });
    // ---- openings
    if (f.openings.length) {
      const where = [...new Set(f.openings.map((o) => o.part))];
      add({
        id: "wiring:openings",
        status: "info",
        title: `Cables pass through ${plural(f.openings.length, "hole")} in ${list(where.map(name), 3)}`,
        detail: `${f.openings.map((o) => `${list(o.wires, 6)} through ${name(o.part)} near ${at(o.at)}`).join("; ")}. A sharp edge cuts insulation as the cable moves.`,
        parts: where,
        fix: `Fit a rubber grommet in each hole (or chamfer and round its edges on a printed part), sized for the bundle.`,
      });
    }
    // ---- holding the cables down
    const long = f.freeSpans.filter((s) => s.length >= LONG_SPAN);
    if (long.length)
      add({
        id: "wiring:free",
        status: "warn",
        title: `${long.length === 1 ? `Cable ${long[0].wire} hangs` : `${plural(long.length, "cable")} hang`} free with nothing to tie ${long.length === 1 ? "it" : "them"} to`,
        detail: `${long.map((s) => `${wt(s.wire)}: ${s.length.toFixed(0)} mm loose around ${at(s.at)}${s.near ? `, nearest ${name(s.near)}` : ""}`).join("; ")}. A loose cable rubs, catches on moving parts and pulls on its plugs.`,
        parts: [...new Set(long.map((s) => s.near).filter((x): x is string => !!x))],
        fix: `Route it along a surface it can be tied to, or add tie points: a printed tie-wrap anchor, a clip or a cable channel along its run.`,
      });
    if (f.ties.length) {
      const relief = f.ties.filter((t) => t.relief).length;
      const short = f.freeSpans.filter((s) => s.length < LONG_SPAN);
      add({
        id: "wiring:ties",
        status: "info",
        title: `Tie the cables down at ${plural(f.ties.length, "point")}`,
        detail: `${relief} of them within a few centimetres of a plug to take the pull off its contacts (strain relief), the rest about every 100 mm along the parts the cables run beside.${short.length ? ` Shorter loose stretches: ${list(short.map((s) => `${s.wire} ${s.length.toFixed(0)} mm`), 5)}.` : ""} Shown as ties in the wiring view.`,
        fix: `Give the parts tie points where the ties are (a slot or a pair of holes for a cable tie, or adhesive tie mounts), and add the cable ties to the parts list.`,
      });
    }
    // ---- cables in a fan's intake or jet, by fan
    const byFan = new Map<string, NonNullable<typeof f.flow>>();
    for (const x of f.flow ?? []) byFan.set(x.part, [...(byFan.get(x.part) ?? []), x]);
    for (const [part, xs] of byFan) {
      const ids = [...new Set(xs.map((x) => x.wire))];
      const kinds = [...new Set(xs.map((x) => x.kind))];
      const zone = kinds.length > 1 ? "intake and jet" : kinds[0];
      add({
        id: `wiring:flow:${part}`,
        status: "fail",
        title: `${ids.length === 1 ? `Cable ${ids[0]} runs` : `Cables ${list(ids, 4)} run`} through ${xs[0].comp}'s ${zone}`,
        detail: `${xs.map((x) => `${wt(x.wire)}: ${x.length.toFixed(0)} mm in its ${x.kind} near ${at(x.at)}`).join("; ")}. A cable in front of an intake gets drawn into the blades; one in the jet flutters, wears through and costs thrust.`,
        parts: [part],
        fix: `Run the cables along the structure beside ${xs[0].comp}, not across its ends: take the motor leads out of the housing's side and along the mount, and leave the space in front of the intake and behind the exhaust open (move the parts in the way, or add a channel or tie points along the frame so the router has a path).`,
      });
    }
    // ---- where cables cross the design's pivots
    if (f.pivots?.length) {
      const joints = [...new Set(f.pivots.map((c) => c.joint))];
      // a crossing the design gives (sim.pivot's cables:) is a loop of slack by intent, wherever it is
      const far = f.pivots.filter((c) => !c.loop && c.r !== undefined && c.r > PIVOT_FAR);
      const loops = f.pivots.filter((c) => c.loop && c.r !== undefined);
      const lost = f.pivots.filter((c) => c.r === undefined);
      // slack to leave at each crossing: the arc its far side moves through over the joint's travel, plus a little
      const swing = (c: (typeof f.pivots)[number]) => {
        const j = model.scenarios?.flatMap((sc) => sc.spec.mechanism?.items ?? []).find((it) => it.k === "pivot" && it.name === c.joint);
        const [l0, l1] = (j?.k === "pivot" ? j.limits : undefined) ?? [-30, 30];
        return Math.max(Math.abs(l0), Math.abs(l1)) * (Math.PI / 180);
      };
      const slack = (c: (typeof f.pivots)[number]) => Math.max(15, Math.ceil(((c.r ?? 0) * swing(c) * 2 + 10) / 5) * 5);
      for (const j of joints) {
        const cs = far.filter((c) => c.joint === j);
        if (!cs.length) continue;
        add({
          id: `wiring:pivot:${j}`,
          status: "warn",
          title: `${cs.length === 1 ? `Cable ${cs[0].wire} crosses` : `Cables ${list(cs.map((c) => c.wire), 4)} cross`} pivot ${j} far from its axis`,
          detail: `${cs.map((c) => `${wt(c.wire)} ${c.r!.toFixed(0)} mm from the axis`).join("; ")}. Turning the joint pulls a cable that far out through an arc, so it needs a long loop of slack that can catch, and it bends at the same place every time.`,
          parts: [],
          fix: `Leave a path for the cables right beside the bearing: a slot or notch next to the bearing seat on both sides of the joint, or a hollow pivot shaft they can run through.`,
        });
      }
      for (const j of [...new Set(lost.map((c) => c.joint))]) {
        const cs = lost.filter((c) => c.joint === j);
        add({
          id: `wiring:pivot-room:${j}`,
          status: "warn",
          title: `No room for ${cs.length === 1 ? `cable ${cs[0].wire}` : plural(cs.length, "cable")} to cross pivot ${j} ${cs[0].loop ? "where the design says" : "beside its bearing"}`,
          detail: `${list(cs.map((c) => wt(c.wire)), 6)}: there is no gap within ${VIA_WORD} of ${cs[0].loop ? "the joint's cables: point" : "the bearing"} big enough for the cable, so the router took it across wherever it could.`,
          fix: cs[0].loop ? `Move the joint's cables: point into open space between the two bodies, clear of both through the joint's travel.` : `Open a gap or slot beside the bearing for the cables, sized for the bundle with a few millimetres to spare.`,
        });
      }
      for (const j of [...new Set(loops.map((c) => c.joint))]) {
        const cs = loops.filter((c) => c.joint === j);
        const r = Math.max(...cs.map((c) => c.r!));
        // each way from the design pose the far tie moves this chord; the loop covers it with a quarter to spare
        const chord = 2 * r * Math.sin(Math.min(Math.PI, swing(cs[0])) / 2);
        const loop = Math.max(20, Math.ceil((chord * 1.25 + 15) / 5) * 5);
        add({
          id: `wiring:pivot-loop:${j}`,
          status: "info",
          title: `${plural(new Set(cs.map((c) => c.wire)).size, "cable")} ${new Set(cs.map((c) => c.wire)).size === 1 ? "crosses" : "cross"} pivot ${j} in a loop of slack`,
          detail: `${list([...new Set(cs.map((c) => c.wire))], 8)} cross where the design says (its cables: point), ${r.toFixed(0)} mm from the axis. Over the joint's travel the far tie moves about ${chord.toFixed(0)} mm each way, so leave a free loop of about ${loop} mm between a tie on each body.`,
          fix: `Tie the cables on both bodies with the loop between the ties, then turn the joint to both stops: the loop should neither pull tight nor reach anything that moves or draws air.`,
        });
      }
      const ok = f.pivots.filter((c) => !c.loop && c.r !== undefined && c.r <= PIVOT_FAR);
      if (ok.length) {
        const apart = ok.filter((c) => c.apart);
        add({
          id: "wiring:pivots",
          status: "info",
          title: `${plural(new Set(ok.map((c) => c.wire)).size, "cable")} cross ${plural(new Set(ok.map((c) => c.joint)).size, "pivot")} beside the bearings`,
          detail: `${joints
            .map((j) => {
              const cs = ok.filter((c) => c.joint === j);
              if (!cs.length) return "";
              const sides = [...new Set(cs.map((c) => c.side))];
              return `${j}: ${sides.map((sd) => `${list(cs.filter((c) => c.side === sd).map((c) => c.wire), 8)} at one end`).join(", ")} (${Math.min(...cs.map((c) => c.r!)).toFixed(0)} to ${Math.max(...cs.map((c) => c.r!)).toFixed(0)} mm from the axis)`;
            })
            .filter(Boolean)
            .join("; ")}.${apart.length ? ` ${list([...new Set(apart.map((c) => c.wire))], 6)} cross at the other end from the motor leads, away from their switching current.` : ""} Leave a loop of slack at each crossing so the joint can reach the ends of its travel: about ${list([...new Set(ok.map(slack))].sort((a, b) => a - b).map((x) => `${x} mm`), 3)}.`,
          fix: `Tie each cable to both sides of the joint just clear of the bearing, with the slack loop between the ties.`,
        });
      }
    }
    if (f.unrouted.length)
      add({
        id: "wiring:unrouted",
        status: "warn",
        title: `No route found for ${plural(f.unrouted.length, "cable")}`,
        detail: `${list(f.unrouted.map(wt), 6)}: drawn straight, so their clashes are not checked.`,
        fix: `Leave a path for them between the parts, or check where their ends are.`,
      });
  }

  // ---- how each module is held
  const held: string[] = [];
  for (const m of mounts) {
    const label = parts.get(m.partId)?.label ?? m.comp;
    const touching = list([...new Set(m.touches.map(name))], 3);
    const free = m.free.map((d) => axisWord(d.dir)).join(", ");
    const one = { parts: [m.partId], category: "assembly" as const };
    switch (m.verdict) {
      case "screwed":
        held.push(`${m.comp}: ${plural(m.screwed.length, "screw")}`);
        break;
      case "held":
        held.push(`${m.comp}: closed in by ${touching}`);
        break;
      case "declared":
        held.push(`${m.comp}: ${m.held}`);
        break;
      case "floating":
        add({ ...one, id: `mount:${m.comp}`, status: "fail", title: `${m.comp} floats: nothing holds it`, detail: `${label} touches no other part.`, fix: `Seat it on a shelf, bracket or standoffs and fix it there: screws through its mounting holes, a slot or clips over its edges, or say how it is held with held: "…".` });
        break;
      case "loose":
        add({
          ...one,
          id: `mount:${m.comp}`,
          status: "fail",
          title: `${m.comp} is not held down`,
          detail: `${label} rests against ${touching} but nothing fixes it: it can come away along ${free}.${m.holes ? ` It has ${plural(m.holes, "mounting hole")} with no screws in them.` : " It has no mounting holes."}`,
          fix: m.holes
            ? `Screw it down: a boss or standoff under each mounting hole with a heat-set insert or nut, and a lib.screw through each hole (at least two). Or clip it into a slot, or if it is taped or strapped, say so with held: "…".`
            : `Hold it in a slot or cradle that closes it in, clip or strap it down, or if it is stuck down with foam tape, say so with held: "double-sided foam tape".`,
        });
        break;
      case "one-screw":
        add({ ...one, id: `mount:${m.comp}`, status: "warn", title: `${m.comp} is held by one screw`, detail: `${label} can swing round its one screw (${m.screwed[0]}).`, fix: `Add a second screw through another mounting hole, or a peg or slot to stop it turning.` });
        break;
      case "no-screws":
        add({ ...one, id: `mount:${m.comp}`, status: "warn", title: `${m.comp} sits on standoffs with no screws`, detail: `${label} sits on ${plural(m.bosses, "boss", "bosses")} or standoffs under its mounting holes, but no screws are in the design, so it is not held and the parts list has none.`, fix: `Add a lib.screw through each mounting hole into its standoff (with a nut or insert if the standoff has no thread).` });
        break;
    }
  }
  if (held.length) items.push({ id: "mount:held", category: "assembly", basis: "geometry", status: "pass", title: `${plural(held.length, "module")} held in place`, detail: held.join("; ") + "." });
  return items;
}
