// A film's shots and every frame of them: where the camera is, how far the
// design is exploded or assembled, where the section plane is, which parts
// are in focus, which overlay (wiring, airflow, results, a simulation) is on,
// and the captions and cards drawn over the picture. Pure: the renderer and
// the preview both draw what frameAt() returns.

import type { Box, FilmFacts, FilmPart, V3 } from "./facts";
import { fmtMass, fmtMoney, fmtSize } from "./facts";
import { CROSSFADE, sectionInfo, type Axis, type FilmSection, type FilmSpec, type SectionKind } from "./spec";

export interface FilmCamera {
  pos: V3;
  target: V3;
  /** vertical field of view, degrees */
  fov: number;
}

export type OverlayNeed = { kind: "wiring" } | { kind: "airflow"; label: string } | { kind: "results"; label: string } | { kind: "sim"; label: string; t: number };

/** What the 3D picture of one shot shows at one moment. */
export interface ShotView {
  camera: FilmCamera;
  /** how far the design is exploded along its plan, 0 to 1 */
  explode: number;
  /** assembly progress 0 to 1 (parts arrive in order); null when not assembling */
  build: number | null;
  /** turning parts' driver angle, degrees */
  angle: number;
  section: { axis: Axis; t: number; flip: boolean } | null;
  /** parts kept solid; the rest are ghosted */
  focus: string[] | null;
  overlay: OverlayNeed | null;
  /** seconds into the shot, for overlay animations */
  clock: number;
}

export interface Callout {
  at: V3;
  title: string;
  text: string;
}

export interface Tile {
  label: string;
  /** a number counted up to, or text shown as it is */
  value: number | string;
  unit?: string;
  decimals?: number;
}

export interface TableRow {
  qty: number;
  item: string;
  price: string;
  kind: "Make" | "Buy";
}

export type Graphic =
  | { g: "caption"; title: string; text: string; a: number }
  | { g: "chapter"; n: number; label: string; a: number }
  | { g: "titleCard"; title: string; tagline: string; a: number; k: number }
  | { g: "endCard"; title: string; line: string; badge: string; a: number; k: number }
  | { g: "callouts"; items: Callout[]; camera: FilmCamera; a: number; k: number }
  | { g: "tiles"; items: Tile[]; a: number; k: number }
  | { g: "table"; rows: TableRow[]; more: number; total: string; a: number; k: number }
  | { g: "code"; title: string; lines: string[]; a: number; k: number };

export interface FrameLayer {
  shot: number;
  weight: number;
  view: ShotView;
  graphics: Graphic[];
  /** darken the picture behind cards, 0 to 1 */
  dim: number;
  /** blur the picture behind cards, in pixels at 1080 */
  blur: number;
}

export interface FrameState {
  t: number;
  layers: FrameLayer[];
  /** the badge's opacity (drawn once over both layers of a crossfade) */
  badge: number;
  /** fade to black, 0 to 1 */
  fade: number;
  /** how far through the film */
  progress: number;
}

export interface Shot {
  index: number;
  section: FilmSection;
  /** chapter number shown in its label (title and end cards have none) */
  chapter: number;
  start: number;
  end: number;
}

export interface FilmPlan {
  spec: FilmSpec;
  facts: FilmFacts;
  /** width over height */
  aspect: number;
  shots: Shot[];
  duration: number;
}

// ---------- vector helpers ----------

const D2R = Math.PI / 180;
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const lerp3 = (a: V3, b: V3, k: number): V3 => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const smooth = (x: number) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
/** eased but still moving at the ends, so a move carries on through a crossfade */
const glide = (x: number) => lerp(x, smooth(x), 0.55);
const center = (b: Box): V3 => mul(add(b[0], b[1]), 0.5);
const boxSize = (b: Box): V3 => sub(b[1], b[0]);
const lerpBox = (a: Box, b: Box, k: number): Box => [lerp3(a[0], b[0], k), lerp3(a[1], b[1], k)];
const grow = (b: Box, k: number): Box => {
  const c = center(b);
  const h = mul(boxSize(b), k / 2);
  return [sub(c, h), add(c, h)];
};

/** From the target toward the camera: azimuth from +X toward +Y, elevation above the ground (Z up). */
export function dirOf(azDeg: number, elDeg: number): V3 {
  const az = azDeg * D2R;
  const el = elDeg * D2R;
  return [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
}

function basis(dir: V3): { f: V3; r: V3; u: V3 } {
  const f = mul(norm(dir), -1);
  let r = cross(f, [0, 0, 1]);
  if (Math.hypot(...r) < 1e-6) r = [1, 0, 0];
  r = norm(r);
  return { f, r, u: cross(r, f) };
}

/** How far along `dir` from `target` the camera must be for every corner of the box to fill `fill` of the frame. */
export function fitDistance(box: Box, target: V3, dir: V3, fovDeg: number, aspect: number, fill: number): number {
  const { f, r, u } = basis(dir);
  const tv = Math.tan((fovDeg * D2R) / 2) * fill;
  const th = tv * aspect;
  let d = 0;
  for (let i = 0; i < 8; i++) {
    const c: V3 = [i & 1 ? box[1][0] : box[0][0], i & 2 ? box[1][1] : box[0][1], i & 4 ? box[1][2] : box[0][2]];
    const p = sub(c, target);
    const z = dot(p, f);
    d = Math.max(d, Math.abs(dot(p, r)) / th - z, Math.abs(dot(p, u)) / tv - z);
  }
  return Math.max(d, Math.hypot(...boxSize(box)) * 0.05);
}

/** Where a point shows in the frame: x and y from 0 to 1 (top left 0, 0), and whether it is in front of the camera. */
export function project(cam: FilmCamera, aspect: number, p: V3): { x: number; y: number; front: boolean } {
  const { f, r, u } = basis(sub(cam.pos, cam.target));
  const v = sub(p, cam.pos);
  const z = dot(v, f);
  const tv = Math.tan((cam.fov * D2R) / 2);
  const x = dot(v, r) / (z * tv * aspect);
  const y = dot(v, u) / (z * tv);
  return { x: 0.5 + x / 2, y: 0.5 - y / 2, front: z > 0 };
}

// ---------- camera moves ----------

interface Move {
  /** azimuth relative to the design's front (-Y), start and end, degrees */
  az: [number, number];
  el: [number, number];
  /** distance as a multiple of the fitting distance */
  dist: [number, number];
  fov: number;
  /** move the subject across the frame, as a share of its width (portrait: of its height, upward) */
  shift?: number;
}

const FRONT = -90;

function cameraFor(box: Box, mv: Move, u: number, aspect: number, fill = 0.8): FilmCamera {
  const e = glide(u);
  const az = FRONT + lerp(mv.az[0], mv.az[1], e);
  const el = lerp(mv.el[0], mv.el[1], e);
  const dir = dirOf(az, el);
  const size = boxSize(box);
  // a touch low, so the design sits above the captions
  const target: V3 = add(center(box), [0, 0, -size[2] * 0.04]);
  const shift = mv.shift ?? 0;
  const portrait = aspect < 0.9;
  // a shifted subject has less of the frame: fit it into what is left
  const room = 1 - Math.abs(shift) * 0.9;
  let d = fitDistance(box, target, dir, mv.fov, aspect, fill * room) * lerp(mv.dist[0], mv.dist[1], e);
  d = Math.max(d, 1);
  let pos = add(target, mul(dir, d));
  let tgt = target;
  if (shift) {
    const { r, u: up } = basis(dir);
    const hv = d * Math.tan((mv.fov * D2R) / 2);
    const v = portrait ? mul(up, -shift * 2 * hv) : mul(r, -shift * 2 * hv * aspect);
    pos = add(pos, v);
    tgt = add(tgt, v);
  }
  return { pos, target: tgt, fov: mv.fov };
}

function blendCamera(a: FilmCamera, b: FilmCamera, k: number): FilmCamera {
  // swing round the target rather than cutting through the design
  const ta = lerp3(a.target, b.target, k);
  const da = sub(a.pos, a.target);
  const db = sub(b.pos, b.target);
  const la = Math.hypot(...da);
  const lb = Math.hypot(...db);
  const dir = norm(lerp3(norm(da), norm(db), k));
  const len = Math.exp(lerp(Math.log(la), Math.log(lb), k));
  return { pos: add(ta, mul(dir, len)), target: ta, fov: lerp(a.fov, b.fov, k) };
}

const MOVES: Partial<Record<SectionKind, Move>> = {
  title: { az: [32, 22], el: [5, 11], dist: [0.78, 0.64], fov: 26 },
  reveal: { az: [72, -12], el: [24, 15], dist: [1.02, 0.9], fov: 32 },
  build: { az: [22, 58], el: [28, 22], dist: [1, 0.95], fov: 34 },
  explode: { az: [38, 76], el: [24, 30], dist: [1, 0.96], fov: 34 },
  motion: { az: [12, 38], el: [18, 23], dist: [0.92, 0.8], fov: 32 },
  sim: { az: [28, 50], el: [30, 26], dist: [1, 0.92], fov: 34 },
  airflow: { az: [84, 32], el: [12, 18], dist: [1, 0.92], fov: 32 },
  results: { az: [-32, 8], el: [26, 22], dist: [0.96, 0.88], fov: 32 },
  wiring: { az: [22, -16], el: [38, 30], dist: [0.9, 0.82], fov: 32 },
  firmware: { az: [-22, 8], el: [26, 22], dist: [1, 0.94], fov: 30, shift: 0.2 },
  specs: { az: [205, 240], el: [20, 24], dist: [1.05, 0.98], fov: 32 },
  parts: { az: [48, 66], el: [28, 26], dist: [1, 0.96], fov: 32, shift: 0.22 },
  end: { az: [34, 22], el: [16, 12], dist: [1.3, 1.12], fov: 30 },
};

// ---------- the plan ----------

/** Number the shots and place them on the film's clock: each one after the first starts as the last fades out. */
export function planFilm(spec: FilmSpec, facts: FilmFacts, aspect: number): FilmPlan {
  const shots: Shot[] = [];
  let t = 0;
  let chapter = 0;
  spec.sections.forEach((s, i) => {
    const plain = s.kind === "title" || s.kind === "end";
    if (!plain) chapter++;
    const start = i === 0 ? 0 : t - CROSSFADE;
    shots.push({ index: i, section: s, chapter: plain ? 0 : chapter, start, end: start + s.seconds });
    t = start + s.seconds;
  });
  return { spec, facts, aspect, shots, duration: t };
}

/** A part's share of its move home while the design assembles: parts arrive in order, overlapping. */
export function buildShare(index: number, count: number, u: number): number {
  if (count <= 1) return smooth(u / 0.7);
  const span = Math.min(0.45, 2.4 / count + 0.12);
  const start = (index / (count - 1)) * (0.82 - span);
  return smooth((u - start) / span);
}

/** Assembly progress over a build shot: parts are home with a little time to spare. */
const buildU = (u: number) => clamp01(u / 0.92);

/** Explode amount over an explode shot: out by halfway, then held. */
const explodeU = (u: number) => smooth((u - 0.06) / 0.46);

/** The section plane's travel over an inside shot: from the uncut side to the middle. */
const insideU = (u: number) => smooth((u - 0.08) / 0.5);

const appear = (sec: number, len: number, inAt = 0.35, outBefore = 0.45) => smooth((sec - inAt) / 0.5) * (1 - smooth((sec - (len - outBefore - 0.45)) / 0.45));

function partById(facts: FilmFacts, id: string): FilmPart | undefined {
  return facts.parts.find((p) => p.id === id) ?? facts.parts.find((p) => p.name === id);
}

/** The parts a detail shot visits, found by id or block name, in order. */
export function spotParts(facts: FilmFacts, s: FilmSection): FilmPart[] {
  const out: FilmPart[] = [];
  for (const id of s.parts ?? []) {
    const p = partById(facts, id);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/** Parts named in the exploded view: the biggest made parts and bought components, one per block. */
function namedParts(facts: FilmFacts, n: number): FilmPart[] {
  const vol = (p: FilmPart) => {
    const s = boxSize(p.box);
    return s[0] * s[1] * s[2];
  };
  const seen = new Set<string>();
  return facts.parts
    .filter((p) => !p.hardware && p.exploded)
    .sort((a, b) => vol(b) - vol(a))
    .filter((p) => (seen.has(p.name) ? false : (seen.add(p.name), true)))
    .slice(0, n);
}

function partLine(p: FilmPart): string {
  return [p.material, p.mass > 0 ? fmtMass(p.mass) : "", p.kind === "component" ? "bought" : ""].filter(Boolean).join(" · ");
}

/** The view and graphics of one shot `sec` seconds in. */
export function shotAt(plan: FilmPlan, shot: Shot, sec: number): Omit<FrameLayer, "weight"> {
  const { facts, aspect, spec } = plan;
  const s = shot.section;
  const len = s.seconds;
  const u = clamp01(sec / len);
  const box = facts.box;
  const exploded = facts.exploded ?? box;
  const base: ShotView = { camera: cameraFor(box, MOVES.reveal!, u, aspect), explode: 0, build: null, angle: 0, section: null, focus: null, overlay: null, clock: sec };
  const graphics: Graphic[] = [];
  let dim = 0;
  let blur = 0;
  const captions = spec.captions;
  const cap = (title = s.title ?? "", text = s.text ?? "", a = appear(sec, len)) => {
    if (captions && (title || text)) graphics.push({ g: "caption", title, text, a });
  };
  const chapterLabel = () => {
    const label = sectionInfo(s.kind).chapter;
    if (captions && label && shot.chapter) graphics.push({ g: "chapter", n: shot.chapter, label, a: appear(sec, len, 0.2, 0.3) });
  };
  const view = { ...base };
  switch (s.kind) {
    case "title": {
      view.camera = cameraFor(box, MOVES.title!, u, aspect);
      dim = lerp(0.5, 0.25, smooth(u));
      graphics.push({ g: "titleCard", title: s.title || spec.title, tagline: s.text ?? spec.tagline, a: appear(sec, len, 0.25, 0.35), k: u });
      break;
    }
    case "reveal":
      view.camera = cameraFor(box, MOVES.reveal!, u, aspect);
      cap();
      chapterLabel();
      break;
    case "build": {
      const b = buildU(u);
      view.build = b;
      view.camera = cameraFor(lerpBox(exploded, box, smooth(b)), MOVES.build!, u, aspect);
      cap();
      chapterLabel();
      break;
    }
    case "explode": {
      const x = explodeU(u);
      view.explode = x;
      view.camera = cameraFor(lerpBox(box, exploded, x), MOVES.explode!, u, aspect);
      cap();
      chapterLabel();
      const named = namedParts(facts, aspect < 0.9 ? 3 : 4);
      if (captions && named.length && len >= 3.5)
        graphics.push({
          g: "callouts",
          items: named.map((p) => ({ at: lerp3(center(p.box), p.exploded!, x), title: p.label, text: partLine(p) })),
          camera: view.camera,
          a: smooth((u - 0.5) / 0.1) * (1 - smooth((sec - (len - 0.9)) / 0.45)),
          k: clamp01((u - 0.5) / 0.25),
        });
      break;
    }
    case "inside": {
      const axis = s.axis ?? "y";
      const mv: Move = axis === "x" ? { az: [84, 62], el: [20, 24], dist: [0.95, 0.88], fov: 32 } : axis === "z" ? { az: [30, 46], el: [52, 58], dist: [0.95, 0.88], fov: 32 } : { az: [18, 34], el: [20, 24], dist: [0.95, 0.88], fov: 32 };
      view.camera = cameraFor(box, mv, u, aspect);
      const ax = axis === "x" ? 0 : axis === "y" ? 1 : 2;
      const mid = center(box)[ax];
      // cut away the half nearer the camera, so the cut face looks at it
      const flip = cameraFor(box, mv, 0.5, aspect).pos[ax] < mid;
      const k = insideU(u);
      view.section = { axis, t: lerp(flip ? 0 : 1, 0.5, k), flip };
      cap();
      chapterLabel();
      break;
    }
    case "motion":
      view.camera = cameraFor(box, MOVES.motion!, u, aspect);
      view.angle = 120 * sec;
      cap();
      chapterLabel();
      break;
    case "sim": {
      const run = facts.sims.find((r) => r.label === s.label) ?? facts.sims[0];
      const simBox = run?.box ?? grow(box, 1.4);
      view.camera = cameraFor(simBox, MOVES.sim!, u, aspect);
      if (run) view.overlay = { kind: "sim", label: run.label, t: clamp01((sec - 0.3) / Math.max(0.5, len - 0.8)) * run.seconds };
      cap();
      chapterLabel();
      break;
    }
    case "airflow": {
      const run = facts.airflow.find((r) => r.label === s.label) ?? facts.airflow[0];
      view.camera = cameraFor(box, MOVES.airflow!, u, aspect);
      if (run) view.overlay = { kind: "airflow", label: run.label };
      cap();
      chapterLabel();
      break;
    }
    case "results": {
      const run = facts.structural.find((r) => r.label === s.label) ?? facts.structural[0];
      view.camera = cameraFor(box, MOVES.results!, u, aspect);
      if (run) view.overlay = { kind: "results", label: run.label };
      cap();
      chapterLabel();
      break;
    }
    case "wiring":
      view.camera = cameraFor(box, MOVES.wiring!, u, aspect);
      view.overlay = { kind: "wiring" };
      cap();
      chapterLabel();
      break;
    case "spotlight": {
      const ps = spotParts(facts, s);
      if (!ps.length) {
        view.camera = cameraFor(box, MOVES.reveal!, u, aspect);
        cap();
        chapterLabel();
        break;
      }
      const each = len / ps.length;
      const j = Math.min(ps.length - 1, Math.floor(sec / each));
      const local = (sec - j * each) / each;
      const at = (i: number, k: number) => {
        const p = ps[i];
        const side = i % 2 ? -1 : 1;
        // close on the part, with some of what is round it
        const pb = grow(p.box, 1.35);
        return cameraFor(pb, { az: [side * 38, side * 38 + 16 * side], el: [24, 20], dist: [1.08, 0.9], fov: 30, shift: aspect < 0.9 ? 0.08 : -0.12 }, k, aspect, 0.62);
      };
      const glideIn = smooth(local / 0.32);
      const from = j === 0 ? cameraFor(box, MOVES.reveal!, 1, aspect) : at(j - 1, 1);
      view.camera = glideIn < 1 ? blendCamera(from, at(j, 0), glideIn) : at(j, (local - 0.32) / 0.68);
      view.focus = [ps[j].id];
      cap();
      chapterLabel();
      if (captions) {
        const p = ps[j];
        graphics.push({
          g: "callouts",
          items: [{ at: center(p.box), title: p.label, text: partLine(p) }],
          camera: view.camera,
          a: smooth((local - 0.3) / 0.12) * (1 - smooth((local - 0.86) / 0.1)),
          k: clamp01((local - 0.3) / 0.2),
        });
      }
      break;
    }
    case "firmware": {
      const fw = facts.firmware;
      view.camera = cameraFor(box, MOVES.firmware!, u, aspect);
      const board = fw?.board ? facts.parts.find((p) => p.name === fw.board || p.id === fw.board) : undefined;
      if (board) view.focus = [board.id];
      dim = 0.25;
      if (fw) graphics.push({ g: "code", title: fw.file, lines: fw.lines, a: appear(sec, len, 0.2, 0.3), k: u });
      cap();
      chapterLabel();
      break;
    }
    case "specs": {
      view.camera = cameraFor(box, MOVES.specs!, u, aspect);
      dim = 0.55;
      blur = 7;
      graphics.push({ g: "tiles", items: specTiles(facts), a: appear(sec, len, 0.2, 0.3), k: clamp01((sec - 0.3) / 1.6) });
      cap(s.title ?? "", s.text ?? "");
      chapterLabel();
      break;
    }
    case "parts": {
      view.explode = facts.exploded ? 0.85 : 0;
      view.camera = cameraFor(facts.exploded ? lerpBox(box, exploded, 0.85) : box, MOVES.parts!, u, aspect);
      dim = 0.3;
      const t = partsTable(facts, aspect < 0.9 ? 6 : 7);
      graphics.push({ g: "table", rows: t.rows, more: t.more, total: t.total, a: appear(sec, len, 0.2, 0.3), k: clamp01((sec - 0.3) / 2) });
      cap();
      chapterLabel();
      break;
    }
    case "end": {
      view.camera = cameraFor(box, MOVES.end!, u, aspect);
      dim = lerp(0.3, 0.55, smooth(u));
      graphics.push({ g: "endCard", title: s.title || spec.title, line: s.text || spec.endLine, badge: spec.badge, a: smooth((sec - 0.3) / 0.6), k: u });
      break;
    }
  }
  return { shot: shot.index, view, graphics, dim, blur };
}

export function specTiles(f: FilmFacts): Tile[] {
  const tiles: Tile[] = [];
  if (f.size) tiles.push({ label: "Size", value: fmtSize(f.size) });
  if (f.mass > 0) tiles.push(f.mass >= 1000 ? { label: "Mass", value: f.mass / 1000, unit: "kg", decimals: f.mass >= 10000 ? 1 : 2 } : { label: "Mass", value: Math.round(f.mass), unit: "g" });
  tiles.push({ label: "Parts", value: f.make + f.buy, unit: `${f.make} made · ${f.buy} bought` });
  if (f.cost && f.cost.total > 0) tiles.push({ label: "Bought parts", value: f.cost.total, unit: "$", decimals: f.cost.total >= 100 ? 0 : 2 });
  if (f.checks && f.checks.total > 0) tiles.push({ label: "Checks passing", value: f.checks.pass, unit: `of ${f.checks.total}` });
  if (f.materials.length) tiles.push({ label: "Materials", value: f.materials.length, unit: f.materials.slice(0, 2).map((m) => m.label).join(", ") });
  return tiles.slice(0, 6);
}

export function partsTable(f: FilmFacts, n: number): { rows: TableRow[]; more: number; total: string } {
  const rows = [...f.bom].sort((a, b) => (a.kind === b.kind ? (b.price ?? 0) * b.qty - (a.price ?? 0) * a.qty : a.kind === "Buy" ? -1 : 1));
  const shown = rows.slice(0, n).map((r) => ({ qty: r.qty, item: r.item, kind: r.kind, price: r.price !== undefined ? fmtMoney(r.price * r.qty) : r.kind === "Make" ? "made" : "" }));
  const total = f.cost && f.cost.total > 0 ? `About ${fmtMoney(f.cost.total)} to buy${f.make ? `, ${f.make} part${f.make === 1 ? "" : "s"} to make` : ""}` : `${f.make + f.buy} parts`;
  return { rows: shown, more: Math.max(0, rows.length - n), total };
}

/** Everything drawn at time t: one shot, or two while one fades into the next. */
export function frameAt(plan: FilmPlan, t: number): FrameState {
  const live = plan.shots.filter((s) => t >= s.start - 1e-9 && t <= s.end + 1e-9);
  const layers: FrameLayer[] = [];
  live.forEach((s) => {
    const next = plan.shots[s.index + 1];
    const prev = plan.shots[s.index - 1];
    let w = 1;
    if (prev && t < prev.end) w = smooth((t - s.start) / CROSSFADE);
    if (next && t > next.start) w = Math.min(w, 1 - smooth((t - next.start) / CROSSFADE));
    if (w > 1e-4) layers.push({ ...shotAt(plan, s, t - s.start), weight: w });
  });
  if (!layers.length && plan.shots.length) {
    const last = plan.shots[plan.shots.length - 1];
    layers.push({ ...shotAt(plan, last, last.section.seconds), weight: 1 });
  }
  const total = layers.reduce((s, l) => s + l.weight, 0) || 1;
  for (const l of layers) l.weight /= total;
  const badged = (k: SectionKind) => k !== "title" && k !== "end";
  const badge = plan.spec.badge && plan.spec.captions ? layers.reduce((s, l) => s + (badged(plan.shots[l.shot].section.kind) ? l.weight : 0), 0) : 0;
  const fadeIn = 1 - smooth(t / 0.6);
  const fadeOut = smooth((t - (plan.duration - 0.9)) / 0.8);
  return { t, layers, badge, fade: Math.max(fadeIn, fadeOut), progress: plan.duration > 0 ? clamp01(t / plan.duration) : 0 };
}

/** The overlay a shot needs on, for setting it up before the shot is drawn. */
export function shotOverlay(plan: FilmPlan, shot: Shot): OverlayNeed | null {
  return shotAt(plan, shot, shot.section.seconds / 2).view.overlay;
}

/** Shots that need the same overlay set up run together: the start of each shot whose overlay differs from the one before. */
export function overlayChanges(plan: FilmPlan): { at: number; need: OverlayNeed | null }[] {
  const key = (n: OverlayNeed | null) => (n ? `${n.kind}:${"label" in n ? n.label : ""}` : "");
  const out: { at: number; need: OverlayNeed | null }[] = [];
  let last = "\u0000";
  for (const s of plan.shots) {
    const n = shotOverlay(plan, s);
    if (key(n) !== last) out.push({ at: s.start, need: n });
    last = key(n);
  }
  return out;
}
