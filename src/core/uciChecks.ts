// The UCI's technical rules for road racing bikes (regulation part 1.3, as
// in force for 2026), checked on the model an analysis "..." { uci: "road" }
// block names: weight, overall size, bottom bracket position, saddle
// setback and length, handlebar width, flare and lever spacing, wheel size,
// rim depth, tube sections and top gear. Each failure says what to change,
// so a model iterating on a race bike knows which way to move.

import type { CheckItem, CheckStatus } from "./checks";
import type { EvalPart, Model } from "./model";
import { worldBox, type MeshLookup } from "./holds";
import type { UciSpec } from "../analysis/spec";
import type { AeroTube, TubeRole } from "../lang/aero";
import { applyXforms, vadd, vdot, vscale, type V3 } from "../kernel/recipe";
import { fmtNum } from "../lang/values";

const N = (x: number, d = 0) => fmtNum(x, d);

/** The limits, in mm and g. */
export const UCI_ROAD = {
  weight: 6800,
  length: 1850,
  width: 500,
  bbHeight: [240, 300],
  bbFront: [540, 650],
  bbRear: [350, 500],
  setback: 50,
  saddleLength: [240, 300],
  barWidth: 400,
  hoodGap: 280,
  flare: 65,
  wheel: [550, 700],
  rimDepth: 65,
  /** every frame, fork, bar and post element 10 to 80 mm; the head tube zone up to 160 mm deep; the joints between tubes are free */
  tube: { max: { main: 80, head: 160, stay: 80, bar: 80, post: 80 } as Record<TubeRole, number>, min: 10 },
  /** the proposed top-gear rollout per crank turn (about 54 × 11), on hold for 2026 */
  rollout: 10460,
} as const;

/** What the check measured, for the analysis panel. */
export interface UciResult {
  label: string;
  error?: string;
  weight?: number;
  /** parts weighed by their declared mass: rather than their solid */
  declared: string[];
  length?: number;
  width?: number;
  bbHeight?: number;
  bbFront?: number;
  bbRear?: number;
  setback?: number;
  saddleLength?: number;
  barWidth?: number;
  hoodGap?: number;
  flare?: number;
  wheels: number[];
  rollout?: number;
}

const results = new WeakMap<Model, Map<string, UciResult>>();

/** The measurements behind a model's UCI items (once its checks have run). */
export function uciResult(model: Model, label: string): UciResult | undefined {
  return results.get(model)?.get(label);
}

/** extents along the bike's forward, sideways and up directions */
type Ext = { f: [number, number]; s: [number, number]; u: [number, number] };

const extCache = new WeakMap<EvalPart, Map<string, Ext>>();

/**
 * A part's extent along the bike's directions: from its mesh, placed, when
 * there is one (exact, which a saddle's setback needs), else from its box.
 */
function partExt(p: EvalPart, dirs: [V3, V3, V3], mesh: MeshLookup | undefined): Ext | null {
  const key = dirs.flat().join(",");
  const hit = extCache.get(p)?.get(key);
  if (hit) return hit;
  const e: Ext = { f: [Infinity, -Infinity], s: [Infinity, -Infinity], u: [Infinity, -Infinity] };
  const add = (w: V3) => {
    (["f", "s", "u"] as const).forEach((k, i) => {
      const v = vdot(w, dirs[i]);
      e[k][0] = Math.min(e[k][0], v);
      e[k][1] = Math.max(e[k][1], v);
    });
  };
  const m = mesh?.(p.hash);
  if (m && m.positions.length) {
    for (let i = 0; i < m.positions.length; i += 3) add(applyXforms([m.positions[i], m.positions[i + 1], m.positions[i + 2]], p.xf));
    if (!extCache.has(p)) extCache.set(p, new Map());
    extCache.get(p)!.set(key, e);
    return e;
  }
  const b = worldBox(p, mesh);
  if (!b) return null;
  for (let c = 0; c < 8; c++) add([c & 1 ? b[1][0] : b[0][0], c & 2 ? b[1][1] : b[0][1], c & 4 ? b[1][2] : b[0][2]]);
  return e;
}

export function uciChecks(model: Model, mesh: MeshLookup | undefined, massOf: (p: EvalPart) => number | undefined): CheckItem[] {
  const out: CheckItem[] = [];
  const store = new Map<string, UciResult>();
  results.set(model, store);
  for (const a of model.analyses) {
    if (a.kind !== "uci") continue;
    const r: UciResult = { label: a.label, declared: [], wheels: [] };
    store.set(a.label, r);
    out.push(...checkBike(model, a, mesh, massOf, r));
  }
  return out;
}

function checkBike(model: Model, a: UciSpec, mesh: MeshLookup | undefined, massOf: (p: EvalPart) => number | undefined, res: UciResult): CheckItem[] {
  const out: CheckItem[] = [];
  const id = (s: string) => `uci:${a.label}:${s}`;
  const named = (n: string) => model.parts.filter((p) => p.name === n);
  const ids = (names: string[]) => names.flatMap((n) => named(n).map((p) => p.id));
  const base = { category: "requirement" as const, span: a.span, basis: "geometry" as const };
  const push = (key: string, status: CheckStatus, title: string, detail: string, parts: string[], fix?: string, extra: Partial<CheckItem> = {}) =>
    out.push({ ...base, id: id(key), status, title: `UCI: ${title}`, detail, parts: ids(parts), ...(fix && status !== "pass" ? { fix } : {}), ...extra });

  const f = a.forward;
  const up: V3 = [0, 0, 1];
  const side: V3 = [-f[1], f[0], 0];
  const dirs: [V3, V3, V3] = [f, side, up];
  /** the named parts' extent along the bike's directions (null while one has no shape yet) */
  const extOf = (names: string[]): Ext | null | undefined => {
    let e: Ext | null = null;
    for (const n of names)
      for (const p of named(n)) {
        const x = partExt(p, dirs, mesh);
        if (!x) return null;
        e = e ? { f: [Math.min(e.f[0], x.f[0]), Math.max(e.f[1], x.f[1])], s: [Math.min(e.s[0], x.s[0]), Math.max(e.s[1], x.s[1])], u: [Math.min(e.u[0], x.u[0]), Math.max(e.u[1], x.u[1])] } : x;
      }
    return e ?? undefined;
  };
  const mid = (e: Ext): V3 => vadd(vadd(vscale(f, (e.f[0] + e.f[1]) / 2), vscale(side, (e.s[0] + e.s[1]) / 2)), vscale(up, (e.u[0] + e.u[1]) / 2));

  const missing = [...a.wheels, a.saddle, a.bars, ...(a.hoods ?? []), ...(a.bb.part ? [a.bb.part] : [])].filter((n) => !named(n).length);
  if (missing.length) {
    res.error = `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not shown as parts, so there is nothing to measure.`;
    push("setup", "fail", `${a.label} can't be measured`, res.error, [], "Name parts or components that are in the design (a component made of several parts counts as one).");
    return out;
  }
  const wheelBoxes = a.wheels.map((w) => extOf([w]));
  const saddleBox = extOf([a.saddle]);
  const barBox = extOf([a.bars]);
  const hoodBoxes = (a.hoods ?? []).map((h) => extOf([h]));
  if ([...wheelBoxes, saddleBox, barBox, ...hoodBoxes].some((b) => !b)) {
    push("setup", "pending", `measuring ${a.label}`, "Waiting for the parts' shapes to measure the bike.", []);
    return out;
  }

  // wheels: the front one is further forward; the ground is under the lower one
  const wheels = a.wheels
    .map((name, i) => {
      const b = wheelBoxes[i]!;
      return { name, c: mid(b), d: Math.max(b.f[1] - b.f[0], b.u[1] - b.u[0]), bottom: b.u[0] };
    })
    .sort((x, y) => vdot(y.c, f) - vdot(x.c, f));
  const [front, rear] = wheels;
  const ground = Math.min(front.bottom, rear.bottom);
  res.wheels = wheels.map((w) => w.d);

  // the bottom bracket: a point, or the axis the crankset turns about
  let bb: V3;
  if (a.bb.at) bb = a.bb.at;
  else {
    const p = named(a.bb.part!)[0];
    if (p.motion && !p.motion.parent && !p.motion.kind) bb = p.motion.origin;
    else bb = mid(extOf([a.bb.part!])!);
  }

  // weight
  {
    const parts = a.parts ? model.parts.filter((p) => a.parts!.includes(p.name)) : model.parts;
    let total = 0;
    const unknown: string[] = [];
    for (const p of parts) {
      const m = massOf(p);
      if (m === undefined) unknown.push(p.name);
      else total += m;
      if (p.mass !== undefined) res.declared.push(p.name);
    }
    if (unknown.length) push("weight", "pending", "weight", `Weighing… (${unknown.length} part${unknown.length === 1 ? "" : "s"} still building)`, []);
    else {
      res.weight = total;
      const declared = res.declared.length ? ` ${res.declared.join(", ")} ${res.declared.length === 1 ? "is" : "are"} weighed by ${res.declared.length === 1 ? "its" : "their"} mass: (a hollow carbon part modelled solid); the rest by volume and material.` : "";
      const ok = total >= UCI_ROAD.weight;
      push(
        "weight",
        ok ? "pass" : "fail",
        ok ? `weighs ${N(total / 1000, 2)} kg` : `too light at ${N(total / 1000, 2)} kg`,
        `The bike weighs ${N(total / 1000, 2)} kg ready to ride; the UCI minimum is 6.8 kg (Art. 1.3.019).${declared}${ok && total < UCI_ROAD.weight + 150 ? " Close to the limit: real bikes vary by tens of grams, so teams leave a little over." : ""}`,
        [],
        `Add ${N(UCI_ROAD.weight - total + 50)} g: heavier wheels or tyres, an alloy part in place of a carbon one, or ballast inside the frame (a weight in the seat tube or bottom bracket is legal). Check every part with a mass: is given its real weight.`,
        { margin: total - UCI_ROAD.weight, basis: res.declared.length ? "parameters" : "geometry" },
      );
    }
  }

  // overall size
  {
    const all = extOf((a.parts ?? model.parts.map((p) => p.name)).filter((n, i, xs) => xs.indexOf(n) === i));
    if (all) {
      res.length = all.f[1] - all.f[0];
      res.width = all.s[1] - all.s[0];
      const long = res.length > UCI_ROAD.length;
      const wide = res.width > UCI_ROAD.width;
      push(
        "size",
        long || wide ? "fail" : "pass",
        long || wide ? "bike too big" : "bike size",
        `${N(res.length)} mm long (at most ${UCI_ROAD.length}) and ${N(res.width)} mm wide (at most ${UCI_ROAD.width}), Art. 1.3.011.`,
        [],
        long ? `Shorten the bike by ${N(res.length - UCI_ROAD.length)} mm: a shorter stem, front centre or chainstays.` : `Narrow the widest point (usually the bars or pedals) by ${N((res.width ?? 0) - UCI_ROAD.width)} mm.`,
      );
    }
  }

  // bottom bracket: height and where it sits between the axles
  {
    const h = vdot(bb, up) - ground;
    const fr = vdot(front.c, f) - vdot(bb, f);
    const rr = vdot(bb, f) - vdot(rear.c, f);
    res.bbHeight = h;
    res.bbFront = fr;
    res.bbRear = rr;
    const L = UCI_ROAD;
    const hOk = h >= L.bbHeight[0] && h <= L.bbHeight[1];
    push(
      "bb-height",
      hOk ? "pass" : "fail",
      `bottom bracket ${N(h)} mm high`,
      `The crank axle is ${N(h)} mm above the ground; the UCI allows ${L.bbHeight[0]} to ${L.bbHeight[1]} mm (Art. 1.3.012).`,
      [...(a.bb.part ? [a.bb.part] : []), ...a.wheels],
      h < L.bbHeight[0] ? `Raise the bottom bracket by ${N(L.bbHeight[0] - h)} mm (less bottom bracket drop, or bigger wheels).` : `Lower the bottom bracket by ${N(h - L.bbHeight[1])} mm (more bottom bracket drop).`,
    );
    const fOk = fr >= L.bbFront[0] && fr <= L.bbFront[1];
    const rOk = rr >= L.bbRear[0] && rr <= L.bbRear[1];
    push(
      "bb-axles",
      fOk && rOk ? "pass" : "fail",
      fOk && rOk ? "wheelbase split" : "axles out of place",
      `Front axle ${N(fr)} mm ahead of the bottom bracket (allowed ${L.bbFront[0]} to ${L.bbFront[1]}), rear axle ${N(rr)} mm behind it (allowed ${L.bbRear[0]} to ${L.bbRear[1]}), Art. 1.3.013.`,
      [...a.wheels],
      [
        !fOk && (fr < L.bbFront[0] ? `move the front wheel ${N(L.bbFront[0] - fr)} mm forward (longer front centre: more reach, slacker head angle or more fork rake)` : `bring the front wheel ${N(fr - L.bbFront[1])} mm back`),
        !rOk && (rr < L.bbRear[0] ? `lengthen the chainstays by ${N(L.bbRear[0] - rr)} mm` : `shorten the chainstays by ${N(rr - L.bbRear[1])} mm`),
      ]
        .filter(Boolean)
        .join("; ")
        .replace(/^./, (c) => c.toUpperCase()) + ".",
    );
  }

  // saddle: nose behind the bottom bracket, length
  {
    const [s0, s1] = saddleBox!.f;
    const setback = vdot(bb, f) - s1;
    const len = s1 - s0;
    res.setback = setback;
    res.saddleLength = len;
    const st: CheckStatus = setback >= UCI_ROAD.setback - 1e-6 ? "pass" : setback >= 0 ? "warn" : "fail";
    push(
      "setback",
      st,
      st === "pass" ? `saddle ${N(setback)} mm behind the bottom bracket` : `saddle too far forward`,
      `The saddle's nose is ${setback >= 0 ? `${N(setback)} mm behind` : `${N(-setback)} mm ahead of`} the vertical through the crank axle. The UCI wants at least ${UCI_ROAD.setback} mm (Art. 1.3.013)${st === "warn" ? "; closer is allowed only for a rider who needs it for their build (morphological reasons), never ahead of the axle" : ""}.`,
      [a.saddle],
      `Slide the saddle ${N(UCI_ROAD.setback - setback)} mm back on its rails, or use a seatpost with more setback.`,
      { margin: setback - UCI_ROAD.setback },
    );
    const lOk = len >= UCI_ROAD.saddleLength[0] && len <= UCI_ROAD.saddleLength[1];
    push("saddle-length", lOk ? "pass" : "fail", `saddle ${N(len)} mm long`, `The UCI allows saddles ${UCI_ROAD.saddleLength[0]} to ${UCI_ROAD.saddleLength[1]} mm long (Art. 1.3.014).`, [a.saddle], len < UCI_ROAD.saddleLength[0] ? `Lengthen the saddle to at least ${UCI_ROAD.saddleLength[0]} mm.` : `Shorten the saddle to ${UCI_ROAD.saddleLength[1]} mm or less.`);
  }

  // bars: width, flare, lever spacing
  {
    const [b0, b1] = barBox!.s;
    const w = b1 - b0;
    res.barWidth = w;
    const ok = w >= UCI_ROAD.barWidth - 1e-6;
    push("bar-width", ok ? "pass" : "fail", `bars ${N(w)} mm wide`, `The bars are ${N(w)} mm across, outside to outside; from 2026 the UCI minimum for road racing is ${UCI_ROAD.barWidth} mm.`, [a.bars], `Widen the bars to ${UCI_ROAD.barWidth} mm or more (outside to outside at the widest point).`, { margin: w - UCI_ROAD.barWidth });
    if (hoodBoxes.length === 2) {
      const hs = hoodBoxes.map((b) => b!.s).sort((x, y) => x[0] - y[0]);
      const gap = hs[1][0] - hs[0][1];
      // flare runs from the inside of the tops to the outside of the drops; the levers clamp where the tops end
      const fl = Math.max(hs[0][1] - b0, b1 - hs[1][0]);
      res.hoodGap = gap;
      res.flare = fl;
      const gOk = gap >= UCI_ROAD.hoodGap - 1e-6;
      push("hoods", gOk ? "pass" : "fail", `levers ${N(gap)} mm apart`, `The brake levers' inside edges are ${N(gap)} mm apart; the UCI minimum is ${UCI_ROAD.hoodGap} mm (2026).`, a.hoods!, `Move the levers out to at least ${UCI_ROAD.hoodGap} mm apart inside to inside, or use wider bars.`, { margin: gap - UCI_ROAD.hoodGap });
      const fOk = fl <= UCI_ROAD.flare + 1e-6;
      push("flare", fOk ? "pass" : "fail", `drops flare ${N(fl)} mm`, `The drops reach ${N(fl)} mm out past the inside of the levers on each side; the UCI allows ${UCI_ROAD.flare} mm of flare, from the inside of the tops to the outside of the drops (2026).`, [a.bars, ...a.hoods!], `Use bars with less flare, or move the levers out so the drops sit within ${UCI_ROAD.flare} mm of them.`);
    } else push("hoods", "info", "lever spacing not checked", `Name the brake levers with hoods: [left_lever, right_lever] to check they are at least ${UCI_ROAD.hoodGap} mm apart and the drops flare no more than ${UCI_ROAD.flare} mm.`, [a.bars], undefined, { basis: "needs analysis" });
  }

  // wheels: size and rim depth
  {
    const bad = wheels.filter((w) => w.d < UCI_ROAD.wheel[0] || w.d > UCI_ROAD.wheel[1]);
    push(
      "wheels",
      bad.length ? "fail" : "pass",
      bad.length ? "wheel size" : `wheels ${wheels.map((w) => N(w.d)).join(" and ")} mm`,
      `${wheels.map((w) => `${w.name} is ${N(w.d)} mm across the tyre`).join(", ")}; the UCI allows ${UCI_ROAD.wheel[0]} to ${UCI_ROAD.wheel[1]} mm (Art. 1.3.018). A 700c road wheel with a 25 to 30 mm tyre is about 670 to 685 mm.`,
      a.wheels,
      `Use wheels between ${UCI_ROAD.wheel[0]} and ${UCI_ROAD.wheel[1]} mm across the tyre (700c, 622 mm rim, is standard).`,
    );
    if (a.rimDepth !== undefined) {
      const ok = a.rimDepth <= UCI_ROAD.rimDepth + 1e-6;
      push("rims", ok ? "pass" : "fail", `rims ${N(a.rimDepth)} mm deep`, `From 2026 mass-start races allow rims up to ${UCI_ROAD.rimDepth} mm deep (Art. 1.3.018). Wheels other than plain spoked ones must also be on the UCI's approved list.`, a.wheels, `Use rims ${UCI_ROAD.rimDepth} mm deep or less (deeper and disc wheels are for time trials only).`, { basis: "parameters" });
    } else push("rims", "info", "rim depth not checked", `Give rim_depth: (like rim_depth: 50mm) to check the rims against the 2026 limit of ${UCI_ROAD.rimDepth} mm for mass-start races. Wheels other than plain spoked ones must be on the UCI's approved list.`, a.wheels, undefined, { basis: "needs analysis" });
  }

  // tube sections, from the aero_tube()s that built the frame, fork, bars and post
  {
    const tubes: { part: EvalPart; t: AeroTube }[] = [];
    const parts = a.parts ? model.parts.filter((p) => a.parts!.includes(p.name)) : model.parts;
    for (const p of parts) for (const t of p.tubes ?? []) tubes.push({ part: p, t });
    const T = UCI_ROAD.tube;
    const rule = `Art. 1.3.020 holds every frame, fork, bar and seatpost element to ${T.max.main} mm deep and ${T.min} mm thick, and the head tube zone to ${T.max.head} mm; the joints between tubes are free`;
    if (!tubes.length) push("tubes", "info", "tube sections not checked", `Build the frame, fork, seatpost and bars with aero_tube() or aero_path() and role: and the check reads each tube's section. ${rule}.`, [], undefined, { basis: "needs analysis" });
    else {
      const bad: string[] = [];
      const badParts = new Set<string>();
      for (const { part, t } of tubes) {
        const max = T.max[t.role];
        const c = Math.max(t.chord, t.chord2);
        const th = Math.min(t.thickness, t.thickness2);
        const where = `${part.name}'s ${t.role === "head" ? "head" : t.role} tube from ${pt(t.from)}`;
        if (c > max + 1e-6) bad.push(`${where} is ${N(c)} mm deep (at most ${max})`);
        if (th < T.min - 1e-6) bad.push(`${where} is ${N(th, 1)} mm thick (at least ${T.min})`);
        if (c > max + 1e-6 || th < T.min - 1e-6) badParts.add(part.name);
      }
      push(
        "tubes",
        bad.length ? "fail" : "pass",
        bad.length ? "tube sections" : `${tubes.length} tube sections`,
        bad.length ? `${bad.join("; ")}. ${rule}.` : `Every aero tube fits the UCI's sections. ${rule} (the old 3:1 shape rule is gone).`,
        bad.length ? [...badParts] : [...new Set(tubes.map((x) => x.part.name))],
        `Bring each tube's chord (front to back) to ${T.max.main} mm or less (${T.max.head} for the head tube) and its thickness to ${T.min} mm or more; a shorter Kammtail (tail: 0.6 to 0.7) keeps the airflow of a deeper tube in less depth. An aero_path's first and last points sit in the joints and are not held to the limits.`,
        { basis: "parameters" },
      );
    }
  }

  // top gear: the proposed rollout limit (on hold for 2026)
  {
    let best: { ring: string; zr: number; cog: string; zc: number } | undefined;
    for (const p of model.parts) {
      const c = p.chain;
      if (!c?.spec.bike || !c.drive) continue;
      const dn = c.nodes.find((n) => n.name === c.drive)!;
      for (const n of c.nodes) if (n !== dn && !n.idler && (!best || dn.z / n.z > best.zr / best.zc)) best = { ring: dn.name, zr: dn.z, cog: n.name, zc: n.z };
    }
    if (best) {
      const roll = Math.PI * rear.d * (best.zr / best.zc);
      res.rollout = roll;
      const over = roll > UCI_ROAD.rollout;
      push("gear", over ? "warn" : "pass", `top gear ${best.zr} × ${best.zc}`, `${best.zr} × ${best.zc} on a ${N(rear.d)} mm wheel rolls ${N(roll / 1000, 2)} m per turn of the cranks. The UCI's proposed limit of ${N(UCI_ROAD.rollout / 1000, 2)} m (about 54 × 11) is on hold for 2026${over ? ", but it may come back" : ""}.`, [best.ring, best.cog], `For races under the proposed limit, use a smaller ring or a bigger smallest cog (54 × 11 or lower).`, { basis: "parameters" });
    }
  }

  push("unmeasured", "info", "also inspected at races", "Commissaires also check lever tilt (10° inward at most), fork legs at most 115 mm and seat stays at most 145 mm apart inside, saddle tilt, and that every part is commercially available (Art. 1.3.006). Kerf does not measure these.", [], undefined, { basis: "physical test" });
  return out;
}

const pt = (p: V3) => `(${p.map((x) => fmtNum(x, 0)).join(", ")})`;
