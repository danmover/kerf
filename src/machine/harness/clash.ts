// Checks the routed harness against the assembly: every cable clear of the
// parts and of the other cables, every plug clear of the parts and of the
// other plugs, room to pull each plug off its pins and for its cable to
// leave it, where cables pass through openings (grommets), and where they
// can be tied down along a surface (and where they hang free). Runs in the
// cable worker after routing; the report pass (checks.ts) words the results.

import type { V3 } from "../../kernel/recipe";
import { PLUG_BACK, PULL, SPLICE_LEN, leadLength, plugBox, type Harness, type HarnessWire, type PlugEnd, type Splice } from "./harness";
import type { SignedField } from "./relax";
import type { RoutedWire } from "./route";
import type { OBox, Skip, SolidItem, Solids } from "./solids";
import type { PivotCrossing } from "./pivots";
import type { TravelPlan } from "./travel";

/** A stretch of cable that runs into a part. */
export interface CableHit {
  wire: string;
  /** the part's id */
  part: string;
  /** the centre line goes inside the part (not just pressing on its surface) */
  through: boolean;
  /** length of the stretch, mm */
  length: number;
  /** deepest the cable's outside goes into the part, mm */
  depth: number;
  at: V3;
}

/** Two cables that run through each other. */
export interface CableCross {
  a: string;
  b: string;
  depth: number;
  at: V3;
  /** the part nearest the crossing, to say where it is */
  near?: string;
}

export interface EndRef {
  wire: string;
  end: 0 | 1;
}

/** A plug that meets a part, or another plug. */
export interface PlugHit extends EndRef {
  part: string;
  at: V3;
}

export interface PlugClash {
  a: EndRef;
  b: EndRef;
  depth: number;
  at: V3;
}

/** A plug that cannot come off its pins, or a cable that cannot leave its plug, for a part in the way. */
export interface Blocked extends EndRef {
  part: string;
  /** how far the plug needs to travel, or the lead's length, mm */
  need: number;
}

/** Cables through an opening in a part: a grommet or a rounded edge saves their insulation. */
export interface Opening {
  part: string;
  at: V3;
  wires: string[];
}

/** A cable tie round the cables at a point, anchored on a part. */
export interface Tie {
  at: V3;
  dir: V3;
  part: string;
  wires: string[];
  /** at a plug: takes the pull off its contacts */
  relief: boolean;
}

/** A stretch of cable with nothing within reach to tie it to. */
export interface FreeSpan {
  wire: string;
  length: number;
  at: V3;
  /** the nearest part within reach of the stretch's middle, if any */
  near?: string;
}

export interface SpliceInfo {
  host: string;
  wires: string[];
  comp: string;
  pin: string;
  label: string;
  at: V3;
  /** a part is in the way of the splice */
  blocked?: string;
}

export interface WiringFindings {
  cableHits: CableHit[];
  crossings: CableCross[];
  plugHits: PlugHit[];
  plugClashes: PlugClash[];
  pullBlocked: Blocked[];
  leadBlocked: Blocked[];
  splices: SpliceInfo[];
  openings: Opening[];
  ties: Tie[];
  freeSpans: FreeSpan[];
  /** cables between two places inside the assembly that leave it on the way (out through a hole and back) */
  outside: { wire: string; length: number; at: V3 }[];
  /** cables the router found no way for (drawn straight) */
  unrouted: string[];
  /** cable left in a fan's intake or jet (filled in after routing, wiringRun.ts) */
  flow?: { wire: string; zone: number; part: string; comp: string; kind: "intake" | "jet"; length: number; at: V3 }[];
  /** where cables cross the design's pivots, and how far from each axis */
  pivots?: (PivotCrossing & { at?: V3; r?: number })[];
  ms: number;
}

/** The cable's outside may press this far into a part, or into another cable, before it counts (mm, or a share of the radius). */
const PRESS = 0.3;
/** Ties every this far along a surface, mm; and the first one this close to a plug, for strain relief. */
const TIE_EVERY = 100;
const RELIEF_WITHIN = 60;
/** A cable may reach this far from a surface and still be tied to it, mm. */
const TIE_REACH = 6;
/** how far a part's own multi-wire lead carries its wires together before they part, mm */
const OWN_LEAD = 60;
/** Longer than this with nothing to tie to: it hangs free, mm. */
const FREE_SPAN = 100;
/** Ties closer than this become one tie round both bundles, mm. */
const TIE_MERGE = 14;
/** Past a buried end, a cable's run this far along is the plug's finding too, mm. */
const BURIED_REACH = 25;
/** Room to grip a plug with fingers beyond its own travel, mm. */
const GRIP = 3;

const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const mid = (a: V3, b: V3): V3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

/** The plug's body as an oriented box in the assembly, shrunk a little so plugs that only touch do not count. */
function plugOBox(e: PlugEnd, w: HarnessWire, shrink: number): OBox | null {
  const b = plugBox(e.spec, w.wires);
  if (!b) return null;
  const f = e.frame;
  return { o: f.o, x: f.x, y: f.y, z: f.z, lo: [b[0][0] + shrink, b[0][1] + shrink, b[0][2] + shrink], hi: [b[1][0] - shrink, b[1][1] - shrink, b[1][2] - shrink] };
}

/** Overlap depth of two oriented boxes along their least separating axis (0 or less: apart). */
function boxOverlap(a: OBox, b: OBox): number {
  const centre = (o: OBox): V3 => {
    const m: V3 = [(o.lo[0] + o.hi[0]) / 2, (o.lo[1] + o.hi[1]) / 2, (o.lo[2] + o.hi[2]) / 2];
    return add(add(add(o.o, o.x, m[0]), o.y, m[1]), o.z, m[2]);
  };
  const half = (o: OBox): V3 => [(o.hi[0] - o.lo[0]) / 2, (o.hi[1] - o.lo[1]) / 2, (o.hi[2] - o.lo[2]) / 2];
  const ca = centre(a);
  const cb = centre(b);
  const ha = half(a);
  const hb = half(b);
  const ax = [a.x, a.y, a.z];
  const bx = [b.x, b.y, b.z];
  const axes: V3[] = [...ax, ...bx];
  for (const u of ax) for (const v of bx) {
    const c = cross(u, v);
    if (Math.hypot(c[0], c[1], c[2]) > 1e-6) axes.push(norm(c));
  }
  const t = sub(cb, ca);
  let least = Infinity;
  for (const n of axes) {
    const ra = ha[0] * Math.abs(dotv(ax[0], n)) + ha[1] * Math.abs(dotv(ax[1], n)) + ha[2] * Math.abs(dotv(ax[2], n));
    const rb = hb[0] * Math.abs(dotv(bx[0], n)) + hb[1] * Math.abs(dotv(bx[1], n)) + hb[2] * Math.abs(dotv(bx[2], n));
    const o = ra + rb - Math.abs(dotv(t, n));
    if (o < least) least = o;
    if (least <= 0) return least;
  }
  return least;
}
const dotv = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A splice's sleeve as a box (and `extra` beyond its end, where its cables start). */
function spliceBox(s: Splice, byId: Map<string, HarnessWire>, from: V3, dir: V3, across: V3, extra: number): OBox {
  const r = Math.max(...s.wires.map((id) => byId.get(id)?.d ?? 1.5)) * Math.sqrt(s.wires.length) * 0.6 + 0.6;
  return { o: from, x: across, y: cross(dir, across), z: dir, lo: [-r, -r, 0], hi: [r, r, SPLICE_LEN + extra] };
}

export const spliceKey = (s: Splice) => `${s.host}|${s.comp}.${s.pin}`;

/** Where a splice sits: the sleeve from `from` to `to` along `dir`. */
export interface SplicePlace {
  key: string;
  from: V3;
  to: V3;
  dir: V3;
  across: V3;
}

/**
 * Put each splice where there is room for it: straight on from its
 * terminal's lead when that is clear, else turned to whichever side is (along
 * the row of contacts, or across it), else straight on regardless (and the
 * check says what is in the way). Moves the splices in `h`, and returns where
 * each went, so the main thread's copy of the harness can follow.
 */
export function placeSplices(h: Harness, solids: Solids): SplicePlace[] {
  const out: SplicePlace[] = [];
  const byId = new Map(h.wires.map((w) => [w.id, w]));
  const seen = new Set<string>();
  for (const w of h.wires)
    for (const e of w.ends) {
      const s = e.splice;
      if (!s || seen.has(spliceKey(s))) continue;
      seen.add(spliceKey(s));
      const host = byId.get(s.host);
      const he = host?.ends.find((x) => x.splice && spliceKey(x.splice) === spliceKey(s));
      if (!host || !he) continue;
      const f = he.frame;
      const back = PLUG_BACK[he.spec.kind];
      const neg = (v: V3): V3 => [-v[0], -v[1], -v[2]];
      const tries: { from: V3; dir: V3; across: V3 }[] = [];
      for (const lead of [leadLength(host), Math.max(3, leadLength(host) / 2)]) {
        const from = add(f.o, f.z, back + lead);
        tries.push({ from, dir: f.z, across: f.x }, { from, dir: f.y, across: f.x }, { from, dir: neg(f.y), across: f.x }, { from, dir: f.x, across: f.y }, { from, dir: neg(f.x), across: f.y });
      }
      const ok = tries.find((t) => !solids.boxHits(spliceBox(s, byId, t.from, t.dir, t.across, 3), (it) => it.comp === s.partId).length) ?? tries[0];
      s.from = ok.from;
      s.dir = ok.dir;
      s.across = ok.across;
      s.to = add(ok.from, ok.dir, SPLICE_LEN);
      out.push({ key: spliceKey(s), from: s.from, to: s.to, dir: s.dir, across: s.across });
    }
  return out;
}

export function checkWiring(h: Harness, routes: RoutedWire[], solids: Solids, field: SignedField | null, plan?: TravelPlan | null): WiringFindings {
  const t0 = Date.now();
  const out: WiringFindings = { cableHits: [], crossings: [], plugHits: [], plugClashes: [], pullBlocked: [], leadBlocked: [], splices: [], openings: [], ties: [], freeSpans: [], outside: [], unrouted: [], ms: 0 };
  // which wire each routed run belongs to
  const wireOf = new Map<string, string>();
  for (const w of h.wires) {
    wireOf.set(w.id, w.id);
    for (const pc of plan?.pieces[w.id] ?? []) wireOf.set(pc.id, w.id);
  }
  const byId = new Map(h.wires.map((w) => [w.id, w]));
  const runs = routes.filter((r) => wireOf.has(r.id));
  out.unrouted = [...new Set(runs.filter((r) => r.straight).map((r) => wireOf.get(r.id)!))];
  const phi = (p: V3) => (field ? field.phi(p[0], p[1], p[2]) : 0);

  // ---- cables against the parts, every half millimetre along each run (a step can jump a thin wall)
  const depthAt = (p: V3, r: number): { item: number; depth: number; inside: boolean } | null => {
    const hit = solids.nearest(p, r + 0.01);
    if (hit) return { item: hit.item, depth: hit.inside ? r + hit.d : r - hit.d, inside: hit.inside };
    // deeper inside a part than its surface is near
    if (field && phi(p) >= 0) return null;
    const i = solids.near(p, p, 0).find((k) => solids.inside(p, k));
    return i === undefined ? null : { item: i, depth: 2 * r, inside: true };
  };
  for (const r of runs) {
    if (r.straight) continue;
    const wire = wireOf.get(r.id)!;
    const tol = Math.max(PRESS, 0.35 * r.r);
    let cur: CableHit | null = null;
    const pts = r.points;
    const close = () => {
      if (!cur) return;
      const same = out.cableHits.find((c) => c.wire === cur!.wire && c.part === cur!.part);
      if (!same) out.cableHits.push(cur);
      else if (cur.through > same.through || cur.depth > same.depth) Object.assign(same, { ...cur, length: same.length + cur.length });
      else same.length += cur.length;
      cur = null;
    };
    // an end buried in a part (a plug that points into it) is the plug's finding, not the cable's: start where the cable comes clear
    const clear = (i: number) => {
      const hit = depthAt(pts[i], r.r);
      return !hit || hit.depth <= tol;
    };
    let first = 1;
    let last = pts.length - 1;
    const arc = (i: number, j: number) => {
      let L = 0;
      for (let k = Math.min(i, j) + 1; k <= Math.max(i, j); k++) L += dist(pts[k - 1], pts[k]);
      return L;
    };
    // and a little past that: the way out of a buried end can cross the wall the plug points through
    if (!clear(0)) {
      while (first < last && !clear(first - 1)) first++;
      while (first < last && arc(0, first) < BURIED_REACH) first++;
    }
    if (!clear(pts.length - 1)) {
      while (last > first && !clear(last)) last--;
      while (last > first && arc(last, pts.length - 1) < BURIED_REACH) last--;
    }
    for (let i = first; i < last; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const L = dist(a, b);
      const n = Math.max(1, Math.ceil(L / 0.5));
      for (let k = 1; k <= n; k++) {
        const p: V3 = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n, a[2] + ((b[2] - a[2]) * k) / n];
        if (field && phi(p) > r.r + 3) {
          close();
          continue;
        }
        const hit = depthAt(p, r.r);
        if (!hit || hit.depth <= tol) {
          close();
          continue;
        }
        const part = solids.items[hit.item].id;
        if (cur && (cur as CableHit).part !== part) close();
        if (!cur) cur = { wire, part, through: hit.inside, length: 0, depth: hit.depth, at: p };
        cur.length += L / n;
        if (hit.inside) cur.through = true;
        if (hit.depth > cur.depth) {
          cur.depth = hit.depth;
          cur.at = p;
        }
      }
    }
    close();
  }
  // a brush against a part over a millimetre or two is the drawing, not a clash
  out.cableHits = out.cableHits.filter((c) => c.through || c.length >= 3);

  // ---- cables that leave the assembly between two places inside it
  if (field?.outside && field.region) {
    const isOut = (p: V3) => field.outside!(p[0], p[1], p[2]);
    const region = (p: V3) => field.region!(p[0], p[1], p[2]);
    for (const r of runs) {
      if (r.straight) continue;
      const pts = r.points;
      const n = pts.length;
      // a few millimetres in from each end, clear of the plug
      const inA = pts[Math.min(n - 1, 4)];
      const inB = pts[Math.max(0, n - 5)];
      // both ends in the same space inside: there is a way between them without going out
      const ra = region(inA);
      if (!ra || ra !== region(inB)) continue;
      let length = 0;
      let at: V3 | null = null;
      for (let i = 1; i < n; i++)
        if (isOut(pts[i])) {
          length += dist(pts[i], pts[i - 1]);
          at ??= pts[i];
        }
      if (length < 5 || !at) continue;
      const wire = wireOf.get(r.id)!;
      const same = out.outside.find((o) => o.wire === wire);
      if (same) same.length += length;
      else out.outside.push({ wire, length, at });
    }
  }

  // ---- cables against each other
  const rMax = Math.max(0.5, ...runs.map((r) => r.r));
  const cell = 2 * rMax + 0.5;
  const hash = new Map<number, number[]>();
  const key = (x: number, y: number, z: number) => (x & 1023) | ((y & 1023) << 10) | ((z & 1023) << 20);
  runs.forEach((r, ri) => {
    if (r.straight) return;
    for (let i = 1; i < r.points.length - 1; i++) {
      const p = r.points[i];
      const k = key(Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell));
      let l = hash.get(k);
      if (!l) hash.set(k, (l = []));
      l.push(ri, i);
    }
  });
  const crossings = new Map<string, CableCross>();
  // a part's own multi-wire lead (an actuator's or a sensor's cable) carries its wires in one jacket for a way
  // before they part: where two wires leave the same lead, they lie together that far
  const ownLeads = new Map<string, V3[]>();
  const ownLeadOf = (wa: string, wb: string): V3[] => {
    const k = `${wa}|${wb}`;
    let at = ownLeads.get(k);
    if (!at) {
      const ea = byId.get(wa)!.ends.filter((e) => e.spec.kind === "lead");
      const eb = byId.get(wb)!.ends.filter((e) => e.spec.kind === "lead");
      at = ea.filter((e) => eb.some((f) => f.partId === e.partId && dist(f.frame.o, e.frame.o) < 3)).map((e) => e.frame.o);
      ownLeads.set(k, at);
    }
    return at;
  };
  runs.forEach((a, ai) => {
    if (a.straight) return;
    const wa = wireOf.get(a.id)!;
    const ends = (r: RoutedWire) => [r.points[0], r.points[r.points.length - 1]];
    for (let i = 1; i < a.points.length - 1; i++) {
      const p = a.points[i];
      const cx = Math.floor(p[0] / cell),
        cy = Math.floor(p[1] / cell),
        cz = Math.floor(p[2] / cell);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++) {
            const l = hash.get(key(cx + dx, cy + dy, cz + dz));
            if (!l) continue;
            for (let m = 0; m < l.length; m += 2) {
              const bi = l[m];
              if (bi <= ai) continue;
              const b = runs[bi];
              const wb = wireOf.get(b.id)!;
              if (wb === wa) continue;
              const q = b.points[l[m + 1]];
              const depth = a.r + b.r - dist(p, q);
              if (depth <= Math.max(PRESS, 0.4 * Math.min(a.r, b.r))) continue;
              // cables leaving the same terminal or splice lie together there
              const shared = ends(a).some((e) => ends(b).some((f) => dist(e, f) < a.r + b.r + 1 && dist(p, e) < 4 * (a.r + b.r) + 4 && dist(q, e) < 4 * (a.r + b.r) + 4));
              if (shared) continue;
              if (ownLeadOf(wa, wb).some((e) => dist(p, e) < OWN_LEAD && dist(q, e) < OWN_LEAD)) continue;
              const k = wa < wb ? `${wa}|${wb}` : `${wb}|${wa}`;
              const c = crossings.get(k);
              if (!c || depth > c.depth) crossings.set(k, { a: wa < wb ? wa : wb, b: wa < wb ? wb : wa, depth, at: mid(p, q) });
            }
          }
    }
  });
  out.crossings = [...crossings.values()];
  for (const c of out.crossings) {
    const n = solids.nearest(c.at, 40);
    if (n) c.near = solids.items[n.item].id;
  }

  // ---- plugs
  // a board's own screws sit where its maker left room for them beside its connectors (the header positions here are only close)
  const own = (comp: string): Skip => (it: SolidItem) => it.comp === comp || it.role === "fastener";
  const ownOrCover = (comp: string): Skip => (it: SolidItem) => it.comp === comp || it.role === "fastener" || it.removable;
  const ends: { e: PlugEnd; w: HarnessWire; k: 0 | 1; box: OBox }[] = [];
  for (const w of h.wires)
    w.ends.forEach((e, k) => {
      // a wire joined into a splice has no plug of its own
      if (e.splice && e.splice.host !== w.id) return;
      const box = plugOBox(e, w, 0.2);
      if (box) ends.push({ e, w, k: k as 0 | 1, box });
    });
  for (const { e, w, k, box } of ends) {
    for (const i of solids.boxHits(box, own(e.partId))) out.plugHits.push({ wire: w.id, end: k, part: solids.items[i].id, at: e.frame.o });
    const b = plugBox(e.spec, w.wires)!;
    // pulled straight off its pins, the whole body slides its pull length out, with room to grip it
    if (PULL[e.spec.kind] > 0) {
      const sweep: OBox = { o: e.frame.o, x: e.frame.x, y: e.frame.y, z: e.frame.z, lo: [b[0][0] + 0.2, b[0][1] + 0.2, b[1][2]], hi: [b[1][0] - 0.2, b[1][1] - 0.2, b[1][2] + PULL[e.spec.kind] + GRIP] };
      const hits = solids.boxHits(sweep, ownOrCover(e.partId));
      if (hits.length) out.pullBlocked.push({ wire: w.id, end: k, part: solids.items[hits[0]].id, need: PULL[e.spec.kind] + GRIP });
    }
  }
  // the cable straight out of the back of each plug (or a part's own lead) needs room before it can bend
  for (const w of h.wires)
    w.ends.forEach((e, k) => {
      if (e.splice && e.splice.host !== w.id) return;
      const b = plugBox(e.spec, w.wires);
      const back = b ? b[1][2] : 0;
      const r = w.d / 2;
      const lead = leadLength(w);
      const box: OBox = { o: e.frame.o, x: e.frame.x, y: e.frame.y, z: e.frame.z, lo: [-r + 0.15, -r + 0.15, back + 0.3], hi: [r - 0.15, r - 0.15, back + lead] };
      const hits = solids.boxHits(box, own(e.partId));
      if (hits.length) out.leadBlocked.push({ wire: w.id, end: k as 0 | 1, part: solids.items[hits[0]].id, need: lead });
    });
  for (let i = 0; i < ends.length; i++)
    for (let j = i + 1; j < ends.length; j++) {
      const A = ends[i];
      const B = ends[j];
      // wires the terminal takes together (a twin ferrule, two forks under a screw) share one place
      if (A.e.partId === B.e.partId && dist(A.e.frame.o, B.e.frame.o) < 0.01) continue;
      if (dist(A.e.frame.o, B.e.frame.o) > 60) continue;
      const depth = boxOverlap(A.box, B.box);
      if (depth > 0.05) out.plugClashes.push({ a: { wire: A.w.id, end: A.k }, b: { wire: B.w.id, end: B.k }, depth: depth + 0.4, at: mid(A.e.frame.o, B.e.frame.o) });
    }

  // ---- splices
  const seen = new Set<string>();
  for (const w of h.wires)
    for (const e of w.ends) {
      const s = e.splice;
      if (!s || seen.has(spliceKey(s))) continue;
      seen.add(spliceKey(s));
      const hits = solids.boxHits(spliceBox(s, byId, s.from, s.dir, s.across, 0), own(s.partId));
      out.splices.push({ host: s.host, wires: s.wires, comp: s.comp, pin: s.pin, label: s.label, at: mid(s.from, s.to), blocked: hits.length ? solids.items[hits[0]].id : undefined });
    }

  // ---- openings, ties and free spans, along each run
  const structural: Skip = (it) => it.role === "mount" || it.role === "fastener";
  const candidates: Tie[] = [];
  const passes: { wire: string; part: string; at: V3 }[] = [];
  for (const r of runs) {
    if (r.straight) continue;
    const wire = wireOf.get(r.id)!;
    const pts = r.points;
    const n = pts.length;
    // distance along the run, and which points lie within reach of a surface to tie to
    const s = [0];
    for (let i = 1; i < n; i++) s.push(s[i - 1] + dist(pts[i - 1], pts[i]));
    const anchor: (string | null)[] = pts.map((p) => {
      if (field && phi(p) > r.r + TIE_REACH) return null;
      const hit = solids.nearest(p, r.r + TIE_REACH, structural);
      return hit && !hit.inside ? solids.items[hit.item].id : null;
    });
    // an opening: the cable is ringed by solid all round, a little way out from its surface
    if (field) {
      let inHole = false;
      for (let i = 1; i < n - 1; i += 2) {
        const tdir = norm(sub(pts[Math.min(n - 1, i + 1)], pts[i - 1]));
        const u = norm(Math.abs(tdir[2]) < 0.9 ? cross(tdir, [0, 0, 1]) : cross(tdir, [1, 0, 0]));
        const v = cross(tdir, u);
        const R = r.r + 3;
        const ring: V3[] = [];
        for (let a = 0; a < 8; a++) {
          const ang = (a / 8) * Math.PI * 2;
          const q = add(add(pts[i], u, Math.cos(ang) * R), v, Math.sin(ang) * R);
          if (phi(q) < 0.6) ring.push(q);
        }
        // one part all round it: a hole through a wall (not a gap between parts that happen to crowd it)
        let ringed: string | null = null;
        if (ring.length >= 7) {
          const count = new Map<string, number>();
          for (const q of ring) {
            const hit = solids.nearest(q, 1.5);
            if (hit) {
              const id = solids.items[hit.item].id;
              count.set(id, (count.get(id) ?? 0) + 1);
            }
          }
          for (const [id, c] of count) if (c >= 7) ringed = id;
        }
        if (ringed && !inHole) passes.push({ wire, part: ringed, at: pts[i] });
        inHole = !!ringed;
      }
    }
    // ties: one near each plug for strain relief, then one every TIE_EVERY along each stretch it can be tied
    const tieAt = (i: number, relief: boolean) => candidates.push({ at: pts[i], dir: norm(sub(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)])), part: anchor[i]!, wires: [wire], relief });
    let relief0 = -1;
    for (let i = 0; i < n && s[i] <= RELIEF_WITHIN; i++)
      if (anchor[i]) {
        relief0 = i;
        break;
      }
    let relief1 = -1;
    for (let i = n - 1; i >= 0 && s[n - 1] - s[i] <= RELIEF_WITHIN; i--)
      if (anchor[i]) {
        relief1 = i;
        break;
      }
    if (relief0 >= 0) tieAt(relief0, true);
    if (relief1 >= 0 && relief1 !== relief0) tieAt(relief1, true);
    let last = relief0 >= 0 ? s[relief0] : -Infinity;
    let freeFrom = -1;
    for (let i = 0; i < n; i++) {
      if (anchor[i]) {
        if (freeFrom >= 0) {
          const L = s[i] - s[freeFrom];
          if (L > FREE_SPAN) {
            const m = pts[Math.floor((i + freeFrom) / 2)];
            const near = solids.nearest(m, 60, structural);
            out.freeSpans.push({ wire, length: L, at: m, near: near ? solids.items[near.item].id : undefined });
          }
          freeFrom = -1;
        }
        if (s[i] - last >= TIE_EVERY && (relief1 < 0 || s[relief1] - s[i] >= TIE_EVERY / 3)) {
          tieAt(i, false);
          last = s[i];
        }
      } else if (freeFrom < 0) freeFrom = Math.max(0, i - 1);
    }
    if (freeFrom >= 0 && s[n - 1] - s[freeFrom] > FREE_SPAN) {
      const m = pts[Math.floor((n - 1 + freeFrom) / 2)];
      const near = solids.nearest(m, 60, structural);
      out.freeSpans.push({ wire, length: s[n - 1] - s[freeFrom], at: m, near: near ? solids.items[near.item].id : undefined });
    }
  }
  // one tie round every bundle that passes the same place
  for (const c of candidates) {
    const t = out.ties.find((x) => dist(x.at, c.at) < TIE_MERGE);
    if (!t) {
      out.ties.push({ ...c, wires: [...c.wires] });
      continue;
    }
    for (const w of c.wires) if (!t.wires.includes(w)) t.wires.push(w);
    t.relief ||= c.relief;
  }
  // cables through the same opening share a grommet
  for (const p of passes) {
    const o = out.openings.find((x) => x.part === p.part && dist(x.at, p.at) < 12);
    if (!o) out.openings.push({ part: p.part, at: p.at, wires: [p.wire] });
    else if (!o.wires.includes(p.wire)) o.wires.push(p.wire);
  }
  out.ms = Date.now() - t0;
  return out;
}
