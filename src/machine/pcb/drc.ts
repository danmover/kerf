// Design rule check of a finished board, on the real geometry rather than the
// router's grid: copper clearance and shorts between nets (pads, tracks,
// vias and pours), copper near the edge or a mounting hole, drill sizes,
// annular rings, holes too close together, and whether every net's pads are
// actually joined by copper.

import { MIN_HOLE_GAP, drillProblems, holeShape, mm, placedHoles, placedPads, type PlacedPad } from "./board";
import { Buckets, RingIndex, capsule, circle, grow, padShape, shapeBox, shapeEdgeDist, shapeGap, type BBox, type Pt, type Shape } from "./geom";
import { pourGroups, ringBox } from "./pour";
import type { DrcItem, RoutedBoard } from "./types";

interface Obj {
  id: number;
  /** net name, or a key of its own for a pad on no net */
  net: string;
  realNet?: string;
  /** 1 top, 2 bottom, 3 both */
  layers: number;
  shape: Shape;
  box: BBox;
  kind: "pad" | "track" | "via" | "pour";
  /** objects with the same group are one piece of copper (segments of a track, edges of a pour) */
  group: string;
  label: string;
  pad?: number;
  /** pour edges: index into pours list */
  pour?: number;
}

interface PourGroup {
  net: string;
  layer: number;
  rings: RingIndex[];
  box: BBox;
}

interface Copper {
  objs: Obj[];
  pads: PlacedPad[];
  pours: PourGroup[];
  index: Buckets<Obj>;
}

const LAYER = { F: 1, B: 2 } as const;

function collect(b: RoutedBoard): Copper {
  const objs: Obj[] = [];
  const pads = placedPads(b.spec);
  const add = (o: Omit<Obj, "id" | "box">) => objs.push({ ...o, id: objs.length, box: shapeBox(o.shape) });
  pads.forEach((p, i) => add({ net: p.net ?? `\u0000pad${i}`, realNet: p.net, layers: 3, shape: padShape(p), kind: "pad", group: `pad${i}`, label: `${p.ref} pin ${p.num ?? p.pin}`, pad: i }));
  b.tracks.forEach((t, ti) => {
    for (let k = 1; k < t.pts.length; k++)
      add({ net: t.net, realNet: t.net, layers: LAYER[t.layer], shape: capsule(t.pts[k - 1][0], t.pts[k - 1][1], t.pts[k][0], t.pts[k][1], t.w / 2), kind: "track", group: `t${ti}`, label: `a ${t.net} track` });
  });
  b.vias.forEach((v, vi) => add({ net: v.net, realNet: v.net, layers: 3, shape: circle(v.x, v.y, v.pad / 2), kind: "via", group: `v${vi}`, label: `a ${v.net} via` }));
  const pours: PourGroup[] = [];
  for (const p of b.pours)
    for (const rings of pourGroups(p.polys)) {
      const gi = pours.length;
      pours.push({ net: p.net, layer: LAYER[p.layer], rings: rings.map((r) => new RingIndex(r)), box: ringBox(rings[0]) });
      for (const r of rings)
        for (let k = 0; k < r.length; k++) {
          const [ax, ay] = r[k];
          const [bx, by] = r[(k + 1) % r.length];
          add({ net: p.net, realNet: p.net, layers: LAYER[p.layer], shape: capsule(ax, ay, bx, by, 0), kind: "pour", group: `p${gi}`, label: `the ${p.net} pour`, pour: gi });
        }
    }
  const index = new Buckets<Obj>(b.spec.w, b.spec.h, 2);
  for (const o of objs) index.add(o.box, o);
  return { objs, pads, pours, index };
}

function inPour(g: PourGroup, x: number, y: number): boolean {
  if (x < g.box[0] || x > g.box[2] || y < g.box[1] || y > g.box[3]) return false;
  if (!g.rings[0].contains(x, y)) return false;
  for (let k = 1; k < g.rings.length; k++) if (g.rings[k].contains(x, y)) return false;
  return true;
}

const centre = (s: Shape): Pt => (s.k === "cap" ? [(s.ax + s.bx) / 2, (s.ay + s.by) / 2] : [(s.p[0] + s.p[4]) / 2, (s.p[1] + s.p[5]) / 2]);

class UF {
  p: number[] = [];
  find(a: number): number {
    if (this.p[a] === undefined) this.p[a] = a;
    while (this.p[a] !== a) {
      this.p[a] = this.p[this.p[a]];
      a = this.p[a];
    }
    return a;
  }
  union(a: number, b: number) {
    this.p[this.find(a)] = this.find(b);
  }
}

/** Which copper is joined: pads, tracks, vias and pours of each net, through overlaps on a shared layer. */
export function connectivity(b: RoutedBoard, cu: Copper = collect(b)) {
  const uf = new UF();
  const { objs, index, pours } = cu;
  const pourBase = objs.length;
  // pieces of one track or one pour are one piece of copper
  const firstOf = new Map<string, number>();
  for (const o of objs) {
    const f = firstOf.get(o.group);
    if (f === undefined) firstOf.set(o.group, o.id);
    else uf.union(o.id, f);
    if (o.pour !== undefined) uf.union(o.id, pourBase + o.pour);
  }
  for (const o of objs) {
    if (o.kind === "pour") continue;
    for (const q of index.near(grow(o.box, 0.01))) {
      if (q.id === o.id || q.net !== o.net || !(q.layers & o.layers)) continue;
      if (uf.find(q.id) === uf.find(o.id)) continue;
      if (shapeGap(o.shape, q.shape) <= 1e-6) uf.union(o.id, q.id);
    }
    // copper lying wholly inside its net's pour
    const [x, y] = centre(o.shape);
    pours.forEach((g, gi) => {
      if (g.net === o.net && g.layer & o.layers && inPour(g, x, y)) uf.union(o.id, pourBase + gi);
    });
  }
  const padObj = new Map<string, number[]>();
  for (const o of objs)
    if (o.pad !== undefined) {
      const p = cu.pads[o.pad];
      const k = `${p.ref}\u0000${p.pin}`;
      padObj.set(k, [...(padObj.get(k) ?? []), o.id]);
    }
  return {
    uf,
    padObj,
    /** whether two pins of a net are joined by copper */
    sameNode(a: { ref: string; pin: string }, c: { ref: string; pin: string }) {
      const pa = padObj.get(`${a.ref}\u0000${a.pin}`) ?? [];
      const pc = padObj.get(`${c.ref}\u0000${c.pin}`) ?? [];
      return pa.some((x) => pc.some((y) => uf.find(x) === uf.find(y)));
    },
  };
}

export function boardDrc(b: RoutedBoard): DrcItem[] {
  const out: DrcItem[] = [];
  const { spec, rules } = b;
  const cu = collect(b);
  const { objs, index, pads, pours } = cu;
  const clr = rules.clearance;
  const tol = 1e-3;

  // clearance and shorts between nets; one report per pair of copper pieces
  const reported = new Set<string>();
  const report = (o: Obj, q: Obj, gap: number, x: number, y: number) => {
    const k = o.group < q.group ? `${o.group}|${q.group}` : `${q.group}|${o.group}`;
    if (reported.has(k)) return;
    reported.add(k);
    const nets = [...new Set([o.realNet, q.realNet].filter((n): n is string => !!n))];
    const refs = [o, q].filter((z) => z.pad !== undefined).map((z) => pads[z.pad!].ref);
    out.push({
      kind: gap < 0 ? "short" : "clearance",
      message: gap < 0 ? `${cap(o.label)} touches ${q.label}.` : `${cap(o.label)} is ${mm(gap)} mm from ${q.label}; the rule is ${mm(clr)} mm.`,
      x,
      y,
      ...(refs.length ? { refs: [...new Set(refs)] } : {}),
      ...(nets.length ? { nets } : {}),
    });
  };
  for (const o of objs) {
    if (o.kind === "pour") continue;
    for (const q of index.near(grow(o.box, clr))) {
      if (q.net === o.net || !(q.layers & o.layers)) continue;
      if (q.kind !== "pour" && q.id < o.id) continue;
      const gap = shapeGap(o.shape, q.shape);
      if (gap < clr - tol) {
        const [x, y] = centre(o.shape);
        report(o, q, gap, x, y);
      }
    }
    const [x, y] = centre(o.shape);
    pours.forEach((g, gi) => {
      if (g.net !== o.net && g.layer & o.layers && inPour(g, x, y)) {
        const fake = { ...o, group: `p${gi}`, label: `the ${g.net} pour`, realNet: g.net, pad: undefined } as Obj;
        report(o, fake, -1, x, y);
      }
    });
  }

  // copper near the board edge and non-plated holes
  const holes = placedHoles(spec);
  const edgeSeen = new Set<string>();
  for (const o of objs) {
    const d = shapeEdgeDist(spec, o.shape);
    if (d < rules.edge - tol && !edgeSeen.has(o.group)) {
      edgeSeen.add(o.group);
      const [x, y] = centre(o.shape);
      out.push({ kind: "offboard", message: `${cap(o.label)} is ${d < 0 ? "off the board" : `${mm(d)} mm from the board edge; copper needs ${mm(rules.edge)} mm`}.`, x, y, ...(o.realNet ? { nets: [o.realNet] } : {}) });
    }
  }
  for (const h of holes) {
    const hs = circle(h.x, h.y, h.d / 2);
    const seen = new Set<string>();
    for (const o of index.near(grow(shapeBox(hs), rules.edge))) {
      if (seen.has(o.group)) continue;
      if (o.pad !== undefined && pads[o.pad].ref === h.ref) continue;
      const gap = shapeGap(o.shape, hs);
      if (gap < rules.edge - tol) {
        seen.add(o.group);
        out.push({ kind: "clearance", message: `${cap(o.label)} is ${mm(Math.max(0, gap))} mm from the ${mm(h.d)} mm ${h.ref ? `hole of ${h.ref}` : "mounting hole"}; copper needs ${mm(rules.edge)} mm.`, x: h.x, y: h.y, ...(o.realNet ? { nets: [o.realNet] } : {}) });
      }
    }
  }

  // drills: sizes, rings, and holes too close together
  for (const p of pads) for (const msg of drillProblems(`${p.ref} pin ${p.num ?? p.pin}`, p)) out.push({ kind: "drill", message: msg, x: p.x, y: p.y, refs: [p.ref] });
  for (const v of b.vias) for (const msg of drillProblems(`The ${v.net} via`, { shape: "circle", w: v.pad, h: v.pad, drill: v.drill })) out.push({ kind: "drill", message: msg, x: v.x, y: v.y, nets: [v.net] });
  const drills: { s: Shape; label: string; key: string }[] = [];
  pads.forEach((p, i) => drills.push({ s: holeShape(p), label: `${p.ref} pin ${p.num ?? p.pin}`, key: `pad${i}` }));
  b.vias.forEach((v, i) => drills.push({ s: circle(v.x, v.y, v.drill / 2), label: `a ${v.net} via`, key: `v${i}` }));
  holes.forEach((h, i) => drills.push({ s: circle(h.x, h.y, h.d / 2), label: h.ref ? `a hole of ${h.ref}` : "a mounting hole", key: `h${i}` }));
  const dIndex = new Buckets<number>(spec.w, spec.h, 3);
  drills.forEach((d, i) => dIndex.add(shapeBox(d.s), i));
  drills.forEach((d, i) => {
    for (const j of dIndex.near(grow(shapeBox(d.s), MIN_HOLE_GAP))) {
      if (j <= i) continue;
      const gap = shapeGap(d.s, drills[j].s);
      if (gap < MIN_HOLE_GAP - tol) {
        const [x, y] = centre(d.s);
        out.push({ kind: "drill", message: `The holes of ${d.label} and ${drills[j].label} ${gap < 0 ? "overlap" : `are only ${mm(gap)} mm apart`}.`, x, y });
      }
    }
  });

  // nets whose pads copper doesn't join
  const conn = connectivity(b, cu);
  const byNet = new Map<string, number[]>();
  for (const o of objs) if (o.pad !== undefined && o.realNet) byNet.set(o.realNet, [...(byNet.get(o.realNet) ?? []), o.id]);
  for (const [net, ids] of byNet) {
    const groups = new Map<number, number[]>();
    for (const id of ids) {
      const r = conn.uf.find(id);
      groups.set(r, [...(groups.get(r) ?? []), id]);
    }
    if (groups.size < 2) continue;
    const gs = [...groups.values()].sort((a, c) => c.length - a.length);
    const main = gs[0];
    for (const g of gs.slice(1)) {
      // name the nearest pair so the message points somewhere useful
      let best = { d: Infinity, a: g[0], c: main[0] };
      for (const a of g)
        for (const c of main) {
          const pa = pads[objs[a].pad!];
          const pc = pads[objs[c].pad!];
          const d = Math.hypot(pa.x - pc.x, pa.y - pc.y);
          if (d < best.d) best = { d, a, c };
        }
      const pa = pads[objs[best.a].pad!];
      const pc = pads[objs[best.c].pad!];
      out.push({ kind: "unrouted", message: `${net}: ${pa.ref} pin ${pa.num ?? pa.pin} is not connected to ${pc.ref} pin ${pc.num ?? pc.pin}.`, x: (pa.x + pc.x) / 2, y: (pa.y + pc.y) / 2, refs: [...new Set([pa.ref, pc.ref])], nets: [net] });
    }
  }
  return out;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
