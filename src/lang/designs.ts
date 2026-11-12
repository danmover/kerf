// Other designs inside this one: `component mount = design("Motor mount", width: 80) { at: (0, 0, 20) }`
// reads another of your projects with the sizes given and places what it makes here, as one subassembly.
// The engine hands the evaluator every project's source (setEvalDesigns); this module finds a design by
// name and moves what it made (parts, bought parts, wires, frames) to where it is placed, renamed so its
// names cannot meet this design's: part base of the insert mount becomes mount_base.

import type { BandInfo, EvalPart, FrameInfo, Model, Motion, SplitRecord } from "../core/model";
import { moveDir, movePoint, moveXforms, type BodyMove } from "../core/mates";
import { applyXformsToDir, type V3, type Xform } from "../kernel/recipe";
import type { ChainInfo } from "../machine/chains";
import type { BeltDef, BoardDef, BuyItem, CalcTrace, MachineComponent, NetDef, PinRef, WireDef } from "../machine/types";
import type { Span } from "./ast";
import { Fn } from "./values";

export interface DesignEntry {
  /** the project's id */
  id: string;
  /** the project's name, as on the Projects page */
  name: string;
  /** the name the design gives itself (design "..."), when it says one */
  title?: string;
  source: string;
  updatedAt: number;
}

/** Other designs a design can insert, by project id. */
export type DesignTable = Record<string, DesignEntry>;

let current: DesignTable = {};
let openId: string | undefined;
let version = 0;

/** The designs design("name") finds (set by the engine and the solver worker), and the open project's id (it can't insert itself). */
export function setEvalDesigns(table: DesignTable, open?: string) {
  current = table;
  openId = open;
  version++;
}

export function evalDesigns(): { table: DesignTable; open?: string; version: number } {
  return { table: current, open: openId, version };
}

/** `design` in an expression: only a component statement places another design, so anywhere else it says how. */
export class DesignFn extends Fn {
  constructor() {
    super(
      "design",
      (_pos, _named, ctx) => ctx.error('design("name") places another of your designs as a subassembly: component mount = design("Motor mount", width: 80) { at: (0, 0, 20) }'),
      'design("name", param: value, config: "row") { at:, rotate: } places another of your designs (a project on the Projects page) here as one subassembly, read with the parameters given; its parts are named after the component (mount_base), and mount.base, mount.params and mount.place(p) reach into it',
    );
  }
}

export const DESIGN_FN = new DesignFn();

/** The name a design's source gives itself: design "Motor mount". */
export function designTitle(source: string): string | undefined {
  return /^\s*design\s+"([^"\n]{1,120})"/m.exec(source)?.[1];
}

/** The designs table from the project list. */
export function designTable(projects: { id: string; name: string; source: string; updatedAt: number }[]): DesignTable {
  const out: DesignTable = {};
  for (const p of projects) {
    const title = designTitle(p.source);
    out[p.id] = { id: p.id, name: p.name, ...(title && title !== p.name ? { title } : {}), source: p.source, updatedAt: p.updatedAt };
  }
  return out;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Find a design by its project's name, else the name it gives itself; with how many others answer to the same name. */
export function findDesign(table: DesignTable, name: string): { entry?: DesignEntry; twins: number } {
  const want = norm(name);
  const all = Object.values(table).sort((a, b) => b.updatedAt - a.updatedAt);
  const byName = all.filter((d) => norm(d.name) === want);
  const hits = byName.length ? byName : all.filter((d) => d.title !== undefined && norm(d.title) === want);
  return { entry: hits[0], twins: Math.max(0, hits.length - 1) };
}

export function missingDesignMessage(table: DesignTable, name: string, open?: string): string {
  const names = Object.values(table)
    .filter((d) => d.id !== open)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((d) => `"${d.name}"`);
  if (!names.length) return `No design called "${name}": design("name") places another of your projects, and this is the only one. Make the part you want to reuse as a project of its own first.`;
  return `No design called "${name}". Your other designs: ${names.slice(0, 12).join(", ")}${names.length > 12 ? `, and ${names.length - 12} more` : ""}.`;
}

const DESIGN_CALL = /\bdesign\s*\(\s*"([^"\n]{1,120})"/g;

/** The designs a source inserts, and the ones they insert, so a worker gets only what it needs. */
export function designsUsed(table: DesignTable, src: string): DesignTable {
  const out: DesignTable = {};
  const todo = [src];
  while (todo.length) {
    const s = todo.pop()!;
    for (const m of s.matchAll(DESIGN_CALL)) {
      const e = findDesign(table, m[1]).entry;
      if (!e || out[e.id]) continue;
      out[e.id] = e;
      todo.push(e.source);
    }
  }
  return out;
}

/** The move that places an inserted design: its turn (rotate: as transforms about the origin), then a slide to at:. */
export function placementMove(rot: Xform[], at: V3): BodyMove {
  const cols = ([[1, 0, 0], [0, 1, 0], [0, 0, 1]] as V3[]).map((e) => applyXformsToDir(e, rot));
  const R = [cols[0][0], cols[1][0], cols[2][0], cols[0][1], cols[1][1], cols[2][1], cols[0][2], cols[1][2], cols[2][2]];
  return { R, c: [0, 0, 0], t: at };
}

export interface PlaceOptions {
  /** the component's name in this design: every name the design made is prefixed with it */
  block: string;
  /** the inserted design's project name */
  design: string;
  move: BodyMove;
  span: Span;
  group: string;
  held?: string;
  explode?: V3 | false;
  locked: boolean;
  hidden: boolean;
  removable: boolean;
}

/** What an inserted design adds to this one, placed and renamed. */
export interface PlacedDesign {
  parts: EvalPart[];
  components: MachineComponent[];
  wires: WireDef[];
  nets: NetDef[];
  calcs: CalcTrace[];
  items: BuyItem[];
  boards: BoardDef[];
  belts: BeltDef[];
  frames: FrameInfo[];
  splits: SplitRecord[];
  /** what stays behind in the design itself */
  left: string[];
}

/** Place what an inserted design made: every part, bought part, wire and frame of it moved and renamed. */
export function placeDesign(inner: Model, o: PlaceOptions): PlacedDesign {
  const ren = (n: string) => `${o.block}_${n}`;
  const mv = o.move;
  const turned = Math.abs(mv.R[0] - 1) + Math.abs(mv.R[4] - 1) + Math.abs(mv.R[8] - 1) > 1e-12;
  const pt = (p: V3): V3 => movePoint(mv, p);
  const dir = (d: V3): V3 => moveDir(mv, d);
  const span = o.span;
  const after = moveXforms(mv);

  const memo = new Map<Motion, Motion>();
  const motion = (m: Motion): Motion => {
    const hit = memo.get(m);
    if (hit) return hit;
    const out: Motion = { ...m, origin: pt(m.origin), axis: dir(m.axis) };
    memo.set(m, out);
    if (m.parent) out.parent = motion(m.parent);
    if (m.link) {
      const l = m.link;
      out.link = { ...l, id: ren(l.id), name: ren(l.name), driver: motion(l.driver), p0: pt(l.p0), w0: pt(l.w0), follower: { ...l.follower, name: ren(l.follower.name), axis: dir(l.follower.axis), at: pt(l.follower.at) } };
    }
    return out;
  };
  const band = (b: BandInfo): BandInfo => {
    const L = b.layout;
    return {
      ...b,
      around: b.around.map(ren),
      ...(b.holds ? { holds: ren(b.holds) } : {}),
      ...(b.hookedOn ? { hookedOn: b.hookedOn.map(ren) } : {}),
      layout: {
        ...L,
        o: pt(L.o),
        n: dir(L.n),
        u: dir(L.u),
        v: dir(L.v),
        route: L.route.map(pt),
        loop: L.loop.map(pt),
        hooks: L.hooks.map((h) => ({ ...h, at: pt(h.at), force: dir(h.force), open: dir(h.open), toward: dir(h.toward) })),
        ...(L.captive ? { captive: ren(L.captive) } : {}),
        ...(L.pastEnd ? { pastEnd: ren(L.pastEnd) } : {}),
      },
    };
  };
  const plane = <P extends { o: V3; u: V3; v: V3; n: V3 }>(p: P): P => ({ ...p, o: pt(p.o), u: dir(p.u), v: dir(p.v), n: dir(p.n) });
  const chain = (c: ChainInfo): ChainInfo => ({
    ...c,
    name: ren(c.name),
    plane: plane(c.plane),
    nodes: c.nodes.map((n) => ({ ...n, name: ren(n.name) })),
    spans: c.spans.map((s) => ({ ...s, from: ren(s.from), to: ren(s.to) })),
    ...(c.drive ? { drive: ren(c.drive) } : {}),
  });

  const parts = inner.parts.map((p): EvalPart => {
    const q: EvalPart = {
      ...p,
      id: ren(p.id),
      name: ren(p.name),
      group: o.group,
      xf: [...p.xf, ...after],
      span,
      deps: [],
      locked: o.locked || p.locked,
      hidden: o.hidden || p.hidden,
      removable: o.removable || p.removable,
      insert: { block: o.block, design: o.design, part: p.name },
    };
    delete q.processSpan;
    delete q.materialSpan;
    delete q.worldXf;
    if (p.held === undefined && o.held !== undefined) q.held = o.held;
    if (o.explode !== undefined) q.explode = o.explode;
    else if (Array.isArray(p.explode)) q.explode = dir(p.explode);
    if (p.motion) q.motion = motion(p.motion);
    if (p.gear) q.gear = { ...p.gear, center: pt(p.gear.center), axis: dir(p.gear.axis), ...(p.gear.meshWith ? { meshWith: ren(p.gear.meshWith) } : {}) };
    if (p.bearing) q.bearing = { ...p.bearing, center: pt(p.bearing.center), axis: dir(p.bearing.axis) };
    if (p.spring) q.spring = { ...p.spring, center: pt(p.spring.center), axis: dir(p.spring.axis) };
    if (p.fastener) q.fastener = { ...p.fastener, headTop: pt(p.fastener.headTop), outward: dir(p.fastener.outward) };
    if (p.flex) q.flex = p.flex.map((f) => (f.against ? { ...f, against: ren(f.against) } : f));
    if (p.band) q.band = band(p.band);
    if (p.chain) q.chain = chain(p.chain);
    if (p.frame) q.frame = ren(p.frame);
    if (p.beam) q.beam = { ...p.beam, frame: ren(p.beam.frame), a: pt(p.beam.a), b: pt(p.beam.b), u: dir(p.beam.u), v: dir(p.beam.v) };
    if (p.split) q.split = { ...p.split, part: ren(p.split.part) };
    return q;
  });

  const m = inner.machine;
  const pin = (r: PinRef): PinRef => ({ ...r, comp: ren(r.comp), span });
  const I: V3[] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const components = (m?.components ?? []).map(
    (c): MachineComponent => ({
      ...c,
      name: ren(c.name),
      span,
      ...(c.at ? { at: pt(c.at) } : {}),
      ...(c.axes || turned ? { axes: (c.axes ?? I).map(dir) as [V3, V3, V3] } : {}),
      ...(c.pcb ? { pcb: { ...c.pcb, board: ren(c.pcb.board) } } : {}),
    }),
  );
  const clamp = (n: string) => (n === "start" || n === "end" ? n : ren(n));
  const belts = (m?.belts ?? []).map((b): BeltDef => {
    const out: BeltDef = {
      ...b,
      name: ren(b.name),
      plane: plane(b.plane),
      nodes: b.nodes.map((n) => ({ ...n, name: clamp(n.name) })),
      spans: b.spans.map((s) => ({ ...s, from: clamp(s.from), to: clamp(s.to), a3: pt(s.a3), b3: pt(s.b3) })),
      ...(b.drive ? { drive: ren(b.drive) } : {}),
      ...(b.motor ? { motor: { ...b.motor, name: ren(b.motor.name) } } : {}),
      span,
    };
    // the tension is written in the other design
    delete out.tensionSpan;
    delete out.tensionParam;
    return out;
  });
  const frames = (inner.frames ?? []).map(
    (f): FrameInfo => ({
      ...f,
      name: ren(f.name),
      members: f.members.map((x) => ({ ...x, name: ren(x.name), from: pt(x.from), to: pt(x.to), start: pt(x.start), end: pt(x.end) })),
      cuts: f.cuts.map((c) => ({ ...c, members: c.members.map(ren) })),
      span,
    }),
  );
  const splits = (inner.splits ?? []).map((r): SplitRecord => ({ ...r, name: ren(r.name), pieces: r.pieces.map(ren), ...(r.pin ? { pin: { ...r.pin, name: ren(r.pin.name) } } : {}), span }));
  const left: string[] = [];
  if (m?.firmware.length) left.push("firmware");
  if (m?.tests.length) left.push("bench tests");
  if (inner.scenarios?.length) left.push("simulated tests");
  if (inner.analyses.length) left.push("analyses");
  if (inner.drawings.length) left.push("drawings");
  return {
    parts,
    components,
    wires: (m?.wires ?? []).map((w) => ({ ...w, a: pin(w.a), b: pin(w.b), span })),
    nets: (m?.nets ?? []).map((n) => ({ ...n, name: ren(n.name), pins: n.pins.map(pin), span })),
    calcs: (m?.calcs ?? []).map((c) => ({ ...c, name: ren(c.name), span })),
    items: (m?.items ?? []).map((it) => ({ ...it, span })),
    boards: (m?.boards ?? []).map((b) => ({ ...b, name: ren(b.name), span })),
    belts,
    frames,
    splits,
    left,
  };
}
