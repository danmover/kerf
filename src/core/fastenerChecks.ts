// Checks on the screws and motor mounts in a design, read from the model
// like the fits (no kernel needed): every screw has something to thread
// into (a nut, an insert, a tapped hole or a pilot hole in plastic), has
// enough thread engaged for what that is, does not bottom out in a blind
// hole such as a motor's tapped holes, and carries the load it was given;
// every motor has screws in its mounting holes.

import type { EvalPart, Model } from "./model";
import type { CheckItem } from "./checks";
import { vdot, vsub } from "../kernel/recipe";
import { axialOverlap, cylEnd, cylMid, lineDistance, partCylinders, type Cyl } from "../analysis/fits/geometry";
import { engagementFor, gradeFrom, proofLoad, stockLengths, threadCapacity, HEAD_TYPES, type HeadType, type Into } from "../library/fasteners";
import { materialRecord } from "../library/materialDb";
import { isPrinted } from "../library/materials";
import { fmtNum } from "../lang/values";

const MOTOR_KINDS = new Set(["gearmotor", "stepper", "servo", "bldc"]);
const instanceOf = (p: EvalPart) => p.id.split(".")[0];

interface Engagement {
  hole: Cyl;
  host: EvalPart;
  into: Into | "standoff";
  /** thread engaged, mm */
  engaged: number;
  /** how far the tip runs past the far end of the threaded hole, mm (negative: short of it) */
  past: number;
}

/** What a threaded hole is: a nut, an insert, a standoff, a tapped hole or a pilot in plastic. */
function intoOf(host: EvalPart, hole: Cyl): Engagement["into"] {
  if (host.libKind === "nut") return /\|nyloc\|/.test(host.bom?.key ?? "") ? "nyloc" : "nut";
  if (host.libKind === "insert") return "insert";
  if (host.libKind === "standoff") return "standoff";
  // the pocket a heat-set insert is melted into (hole(M3, fit: "insert"))
  if (hole.holeFit === "insert") return "insert";
  if (hole.role === "thread") return "tapped";
  const rec = materialRecord(host.material);
  return isPrinted(host.material) || (rec && rec.category !== "metal") ? "plastic" : "tapped";
}

/** Holes a catalog component's screws go into are blind (a motor face): the screw must stop short of the bottom. */
const blind = (host: EvalPart, into: Engagement["into"]) => host.kind === "component" && into === "tapped" && host.libKind !== "screw";

function engagements(screw: EvalPart, shank: Cyl, holes: Cyl[]): { threads: Engagement[]; through: EvalPart[]; short?: { host: EvalPart; gap: number } } {
  const threads: Engagement[] = [];
  const through: EvalPart[] = [];
  let short: { host: EvalPart; gap: number } | undefined;
  const tip = cylEnd(shank);
  for (const h of holes) {
    if (h.part === screw || instanceOf(h.part) === instanceOf(screw)) continue;
    if (Math.abs(vdot(h.axis, shank.axis)) < 0.995) continue;
    if (lineDistance(cylMid(h), shank.at, shank.axis) > Math.max(0.3, 0.03 * h.d)) continue;
    const overlap = axialOverlap(h, shank);
    const threaded = h.role === "thread" || h.d < shank.d - 0.2;
    if (overlap < 0.3) {
      // a nut, insert or threaded hole just beyond the tip: the screw is too short to reach it
      if (threaded) {
        const down = vdot(vsub(tip, shank.at), h.axis) >= 0 ? 1 : -1;
        const s0 = vdot(vsub(tip, h.at), h.axis) * down;
        const gap = down > 0 ? -s0 : s0 - h.length;
        if (gap > -0.3 && gap < 10 && (!short || gap < short.gap)) short = { host: h.part, gap: Math.max(0, gap) };
      }
      continue;
    }
    if (!threaded) {
      if (!through.includes(h.part)) through.push(h.part);
      continue;
    }
    // along the hole: where the screw enters and where its tip is
    const entry = vdot(vsub(shank.at, h.at), h.axis);
    const t = vdot(vsub(tip, h.at), h.axis);
    // a nut's thread is cut 0.1 mm past both faces
    const over = h.part.libKind === "nut" ? 0.1 : 0;
    const past = (t >= entry ? t - h.length : -t) + over;
    threads.push({ hole: h, host: h.part, into: intoOf(h.part, h), engaged: Math.min(overlap, h.length - 2 * over), past });
  }
  return { threads, through, short };
}

const what = (p: EvalPart) => p.name;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function fastenerChecks(model: Model): CheckItem[] {
  const out: CheckItem[] = [];
  const screws = model.parts.filter((p) => p.fastener && p.libKind === "screw" && !p.hidden && p.fastener.head !== "set");
  const motorNames = new Set((model.machine?.components ?? []).filter((c) => MOTOR_KINDS.has(c.kind)).map((c) => c.name));
  if (!screws.length && !motorNames.size) return out;

  const holes: Cyl[] = [];
  for (const p of model.parts) if (!p.hidden && !p.fastener) for (const c of partCylinders(p)) if (c.side === "hole") holes.push(c);

  // grouped so a pattern of identical screws gives one line
  type Item = Omit<CheckItem, "parts" | "detail"> & { detail: (n: number, names: string) => string };
  const groups = new Map<string, { item: Item; parts: Set<string>; names: Set<string>; n: number }>();
  /** `names`: the parts the screws pass through, listed once for the whole group */
  const add = (key: string, item: Item, parts: string[], names: string[] = []) => {
    const g = groups.get(key) ?? { item, parts: new Set<string>(), names: new Set<string>(), n: 0 };
    g.n++;
    for (const p of parts) g.parts.add(p);
    for (const x of names) g.names.add(x);
    groups.set(key, g);
  };
  const listNames = (xs: Set<string>) => {
    const a = [...xs];
    return a.length <= 3 ? a.join(" and ") : `${a.slice(0, 3).join(", ")} and ${a.length - 3} more`;
  };
  const counts = new Map<string, number>();
  const screwsIn = new Map<string, Set<string>>(); // motor instance -> screws in its holes
  let ok = 0;

  for (const s of screws) {
    const f = s.fastener!;
    const shank = partCylinders(s).find((c) => c.role === "screw");
    if (!shank?.thread) continue;
    const t = shank.thread;
    const head = (HEAD_TYPES as string[]).includes(f.head ?? "") ? (f.head as HeadType) : "socket";
    const name = `${t.name}${f.length ? `×${fmtNum(f.length)}` : ""} ${s.name}`;
    const { threads, through, short } = engagements(s, shank, holes);
    for (const e of [...threads.map((x) => x.host), ...through]) if (motorNames.has(e.name)) screwsIn.set(instanceOf(e), (screwsIn.get(instanceOf(e)) ?? new Set()).add(s.id));

    if (!threads.length) {
      // nuts or inserts bought for it but not drawn (buy "M5 T-nuts")
      const bought = (model.machine?.items ?? []).find((it) => new RegExp(`(^|[^\\w.])${t.name.replace(".", "\\.")}(?![\\d.])`, "i").test(it.label) && /nut|insert|threaded|tapped/i.test(it.label));
      if (short)
        add(
          `reach:${s.name}:${short.host.name}`,
          {
            id: `fasten:reach:${s.name}`,
            category: "assembly",
            status: "fail",
            title: `${name} does not reach ${short.host.name}`,
            detail: (n) => `${n > 1 ? "These screws stop" : "It stops"} ${fmtNum(short.gap, 1)} mm short of the thread in ${short.host.name}, so ${n > 1 ? "they hold" : "it holds"} nothing.`,
            fix: `Use a screw at least ${fmtNum(Math.ceil(short.gap + 2 * t.d))} mm longer, or move ${short.host.name} up to it.`,
            span: s.span,
            basis: "geometry",
          },
          [s.id, short.host.id],
        );
      else if (through.length && bought)
        add(
          `bought:${s.name}:${bought.label}`,
          {
            id: `fasten:bought:${s.name}`,
            category: "assembly",
            status: "info",
            title: `${name} threads into ${bought.label}`,
            detail: (n, names) => `${n > 1 ? `${n} of these screws pass` : "It passes"} through ${names} into the ${bought.label} on the parts list. They are not drawn, so their thread engagement is not checked.`,
            span: s.span,
            basis: "parameters",
          },
          [s.id, ...through.map((p) => p.id)],
          through.map(what),
        );
      else if (through.length)
        add(
          `none:${s.name}`,
          {
            id: `fasten:none:${s.name}`,
            category: "assembly",
            status: "warn",
            title: `${name} has nothing to thread into`,
            detail: (n, names) => `${n > 1 ? `${n} of these screws pass` : "It passes"} through ${names}, but no nut, heat-set insert, standoff or tapped hole is on ${n > 1 ? "their" : "its"} axis to hold the thread.`,
            fix: `Add lib.nut(${t.name}) (type: "tslot20" in an extrusion slot) or lib.insert(${t.name}) on the axis, or make the far hole a tapped one (hole(${t.name}, fit: "tap")); calc.fastener() picks the screw, its length and what it goes into. If it screws into something outside the design (a wall, a bench), this is expected.`,
            span: s.span,
            basis: "geometry",
          },
          [s.id, ...through.map((p) => p.id)],
          through.map(what),
        );
      continue;
    }
    // the main thread: a nut, insert or standoff on the axis before the hole it sits in, then the most engagement
    const rank = (x: Engagement) => (x.host.libKind === "nut" || x.host.libKind === "insert" || x.host.libKind === "standoff" ? 1000 : 0) + x.engaged;
    const e = threads.reduce((a, b) => (rank(b) > rank(a) ? b : a));
    // a pilot hole in wood is counted as wood, whatever screw is in it
    const kind = e.into === "plastic" && materialRecord(e.host.material)?.family === "wood" ? "wood" : e.into;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    let fine = true;

    if (blind(e.host, e.into) && e.past > 0.25) {
      fine = false;
      const L = f.length ?? 0;
      const fit = L ? stockLengths(head, t).filter((x) => x <= L - e.past + 1e-6).at(-1) : undefined;
      add(
        `bottom:${s.name}:${e.host.name}`,
        {
          id: `fasten:bottom:${s.name}`,
          category: "assembly",
          status: "fail",
          title: `${name} bottoms out in ${e.host.name}`,
          detail: (n) => `${n > 1 ? `These ${n} screws reach` : "It reaches"} ${fmtNum(e.past, 1)} mm past the bottom of ${e.host.name}'s ${fmtNum(e.hole.length, 1)} mm deep threaded hole${n > 1 ? "s" : ""}, so ${n > 1 ? "they" : "it"} stop before clamping${e.host.libKind === "bldc" ? " and can reach the windings" : ""}.`,
          fix: fit ? `Use a ${fmtNum(fit)} mm screw (or thicken the plate by ${fmtNum(e.past, 1)} mm). calc.fastener(depth: motor.screw_depth) picks the length.` : "Use a shorter screw or a thicker plate.",
          span: s.span,
          basis: "geometry",
        },
        [s.id, e.host.id],
      );
    }

    if (e.into === "nut" || e.into === "nyloc") {
      const need = e.into === "nyloc" ? 2 * t.pitch : t.pitch;
      if (e.past < need - 0.05) {
        fine = false;
        const short = e.past < -0.05;
        add(
          `nut:${s.name}:${e.host.name}`,
          {
            id: `fasten:nut:${s.name}`,
            category: "assembly",
            status: short ? "fail" : "warn",
            title: short ? `${name} does not reach through ${e.host.name}` : `${name} barely clears ${e.host.name}`,
            detail: (n) =>
              short
                ? `${n > 1 ? "These screws engage" : "It engages"} ${fmtNum(e.engaged, 1)} mm of the ${fmtNum(e.hole.length, 1)} mm ${e.into === "nyloc" ? "nyloc " : ""}nut: the last threads of the nut carry nothing and it can strip.`
                : `The tip is ${fmtNum(Math.max(0, e.past), 1)} mm past the nut; it should show at least ${e.into === "nyloc" ? "two full threads past the nylon ring" : "one full thread"} (${fmtNum(need, 1)} mm).`,
            fix: `Use a screw ${fmtNum(Math.ceil(need - e.past))} mm longer.`,
            span: s.span,
            basis: "geometry",
          },
          [s.id, e.host.id],
        );
      }
    } else if (e.into !== "standoff") {
      const rule = engagementFor({ grip: 0, into: e.into, material: e.host.material, depth: blind(e.host, e.into) ? e.hole.length : undefined }, t, head);
      const need = rule?.min ?? 0;
      if (rule && e.engaged < need - 0.1) {
        fine = false;
        const where = e.into === "insert" ? "insert" : e.into === "plastic" ? `pilot hole in ${e.host.material}` : `tapped hole in ${e.host.material}`;
        add(
          `short:${s.name}:${e.host.name}`,
          {
            id: `fasten:short:${s.name}`,
            category: "assembly",
            status: e.engaged < need * 0.6 ? "fail" : "warn",
            title: `${name}: too little thread in ${e.host.name}`,
            detail: (n) => `${n > 1 ? "These screws thread" : "It threads"} ${fmtNum(e.engaged, 1)} mm into the ${where}; ${t.name} wants at least ${fmtNum(need, 1)} mm there (about ${fmtNum(rule.ideal, 1)} mm) or the thread strips before the screw is tight.`,
            fix: `Use a longer screw (calc.fastener() picks one), ${e.into === "insert" ? "a longer insert" : "a deeper hole"}, or ${e.into === "plastic" ? "a heat-set insert" : "a nut"}.`,
            span: s.span,
            basis: "geometry",
          },
          [s.id, e.host.id],
        );
      }
    }

    // strength, when the design says what the screw carries
    const load = f.load ?? 0;
    const shear = f.shear ?? 0;
    if (load > 0 || shear > 0) {
      const grade = gradeFrom(f.grade) ?? "8.8";
      const bolt = proofLoad(t, grade);
      const into: Into = e.into === "standoff" ? "tapped" : e.into;
      const thread = threadCapacity({ grip: 0, into, material: e.host.material }, t, e.engaged, grade);
      const cap = Math.min(bolt, thread.n);
      const sCap = 0.6 * bolt;
      const margin = Math.min(load > 0 ? cap / load : Infinity, shear > 0 ? sCap / shear : Infinity);
      const limit = load > 0 && cap / load <= (shear > 0 ? sCap / shear : Infinity) ? (thread.n < bolt ? thread.what : `the screw (${grade})`) : `the screw in shear (${grade})`;
      add(
        `load:${s.name}:${e.host.name}`,
        {
          id: `fasten:load:${s.name}`,
          category: "engineering",
          status: margin < 1 ? "fail" : margin < 2 ? "warn" : "pass",
          title: `${name} carries its load`,
          detail: () => `${load > 0 ? `${fmtNum(load)} N tension` : ""}${load > 0 && shear > 0 ? " and " : ""}${shear > 0 ? `${fmtNum(shear)} N shear` : ""} each, against ${fmtNum(cap)} N before ${thread.n < bolt ? thread.what : "the screw"} gives${shear > 0 ? ` and ${fmtNum(sCap)} N in shear` : ""}: ${fmtNum(margin, 2)} × margin, limited by ${limit}.`,
          fix: margin < 2 ? "Use a bigger or stronger screw, more screws, more thread engagement or a nut; keep 2 × for joints that cycle." : undefined,
          span: s.span,
          margin,
          basis: "calculation",
        },
        [s.id, e.host.id],
      );
    }
    if (fine) ok++;
  }

  for (const g of groups.values()) out.push({ ...g.item, detail: g.item.detail(g.n, listNames(g.names)), parts: [...g.parts], id: g.n > 1 ? `${g.item.id}#${g.n}` : g.item.id });

  if (ok > 0 && ok === screws.filter((s) => partCylinders(s).some((c) => c.role === "screw")).length) {
    const label: Record<string, string> = { nut: "nuts", nyloc: "nyloc nuts", insert: "inserts", tapped: "tapped holes", plastic: "plastic pilot holes", wood: "pilot holes in wood", standoff: "standoffs" };
    const parts = [...counts].map(([k, n]) => `${n} into ${label[k] ?? k}`);
    out.push({ id: "fasten:ok", category: "assembly", status: "pass", title: "Every screw has thread to hold", detail: `${plural(ok, "screw")}: ${parts.join(", ")}, with enough thread engaged and none bottoming out.`, basis: "geometry" });
  }

  // motors: screws in their mounting holes (or a bought extruder bolted on with the screws in its kit)
  const kits = model.parts.filter((q) => q.libKind === "extruder" && !q.hidden).map((q) => ({ part: q, holes: partCylinders(q).filter((c) => c.side === "hole") }));
  for (const p of model.parts) {
    if (!motorNames.has(p.name) || p.id.includes(".") || p.hidden) continue;
    const mountHoles = partCylinders(p).filter((c) => c.side === "hole" && c.d < 8);
    if (!mountHoles.length) continue;
    const n = screwsIn.get(instanceOf(p))?.size ?? 0;
    const label = p.label;
    const kit = n === 0 ? kits.find((k) => k.holes.some((c) => mountHoles.some((h) => Math.abs(vdot(c.axis, h.axis)) > 0.99 && lineDistance(c.at, h.at, h.axis) < 0.3))) : undefined;
    if (kit) out.push({ id: `motor-mount:${p.id}`, category: "assembly", status: "pass", title: `${p.name} bolted on`, detail: `Held by the screws that come with ${kit.part.label}: they run through its holes into ${label}.`, parts: [p.id, kit.part.id], span: p.span, basis: "geometry" });
    else if (n === 0)
      out.push({
        id: `motor-mount:${p.id}`,
        category: "assembly",
        status: "warn",
        title: `${p.name} is not bolted on`,
        detail: `None of the ${mountHoles.length} mounting holes of ${label} has a screw in it, so nothing holds it against its torque.`,
        fix: `Cut ${p.name}.mount from the plate it sits on (pilot and screw clearance) and put a lib.screw(${p.name}.screw, …) in each of ${p.name}.holes; calc.fastener(grip: plate, into: "tapped", material: "Aluminum 6061", depth: ${p.name}.screw_depth, size: ${p.name}.screw) gives the length.`,
        parts: [p.id],
        span: p.span,
        basis: "geometry",
      });
    else if (n < Math.min(2, mountHoles.length) || n < mountHoles.length / 2)
      out.push({
        id: `motor-mount:${p.id}`,
        category: "assembly",
        status: "warn",
        title: `${p.name} held by ${plural(n, "screw")}`,
        detail: `Only ${n} of the ${mountHoles.length} mounting holes of ${label} have screws: it can rock or twist under load.`,
        fix: `Screw at least ${Math.max(2, Math.ceil(mountHoles.length / 2))} of ${p.name}.holes, spread round the face.`,
        parts: [p.id],
        span: p.span,
        basis: "geometry",
      });
    else out.push({ id: `motor-mount:${p.id}`, category: "assembly", status: "pass", title: `${p.name} bolted on`, detail: `${n} of the ${mountHoles.length} mounting holes of ${label} have screws.`, parts: [p.id], span: p.span, basis: "geometry" });
  }
  return out;
}
