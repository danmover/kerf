// Design for assembly (DFA): how many separate things go into a design, how
// many it really needs (the Boothroyd–Dewhurst theoretical minimum), which
// ways they go in, and roughly how long it takes to put together by hand.
// Pure: the caller passes what it knows about the geometry (boxes, volumes,
// confirmed contacts) and mfg/dfaRuntime feeds that from the live engine.

import type { CheckItem } from "../core/checks";
import type { EvalPart, Model } from "../core/model";
import { applyXforms, applyXformsToDir, frameAt, framePoint, vadd, vdot, vlen, vnorm, vscale, vsub, type ShapeRecipe, type V2, type V3, type Xform } from "../kernel/recipe";
import { THREADS, materialDensity } from "../library/standards";
import { materialRecord } from "../library/materialDb";
import { fmtNum } from "../lang/values";
import { wireList } from "../machine/wiring";
import { PROCESSES } from "./profiles";

/**
 * Simplified Boothroyd–Dewhurst manual assembly times, in seconds: what a
 * trained person at a bench takes to grasp, move and fit each item. Totals
 * are an estimate (the report gives a range of −30 % to +30 %).
 *
 *   place a part that locates itself (grasp, move, set in place)      3.0
 *   large part (longest side over 300 mm)                             +1.0
 *   very large or heavy part (over 600 mm or 4.5 kg: two hands)       +3.0  (instead of +1)
 *   tiny part (under 3 mm every way: tweezers)                        +2.5
 *   drive a screw (pick up, start, run down, tighten)                  8.0
 *   nut: place it                                                      3.0
 *     ... and hold it with a spanner while the screw is tightened     +6.0  (not when a hex pocket holds it)
 *   washer: place it over the hole                                     3.0
 *   heat-set insert pressed in with a soldering iron                  10.0
 *   press-fit bearing                                                  6.0
 *   dowel pin pressed in                                               6.0
 *   rivet: place and set                                               7.0
 *   gear: line its teeth up with the gear it meshes with              +2.0
 *   part that screws on by hand (a threaded lid)                      +4.0
 *   turn the assembly over or onto another side                        4.5 each
 *   wire end connected (plug, crimp or screw terminal)                 6.0 each
 *
 * The ideal is 3 s per part, so the design efficiency (DFA index) is
 * 3 s × theoretical minimum part count ÷ estimated total time.
 */
export const DFA_TIMES = {
  place: 3,
  large: 1,
  heavy: 3,
  tiny: 2.5,
  screw: 8,
  nut: 3,
  nutHold: 6,
  washer: 3,
  insert: 10,
  pressFit: 6,
  rivet: 7,
  mesh: 2,
  screwOn: 4,
  reorient: 4.5,
  wireEnd: 6,
  ideal: 3,
} as const;

/** Size and mass limits behind the handling adjustments (mm, g). */
export const DFA_LIMITS = { largeMm: 300, veryLargeMm: 600, heavyG: 4500, tinyMm: 3 } as const;

/** Boxes closer than this meet, when the exact contact is not known (mm). */
const BOX_TOL = 0.2;
/** Directions within this angle count as one (degrees). */
const SAME_DIR_DEG = 15;

export type DfaStatus = "pass" | "warn" | "info";
export type DfaRole = "made" | "bought" | "fastener";
export type FastenerType = "screw" | "nut" | "washer" | "insert" | "dowel" | "rivet" | "other";
/** Why an item is in the theoretical minimum: it is the base, moves, comes off, is bought for its own job, or must be a different material. */
export type EssentialReason = "base" | "moves" | "service" | "bought" | "material";

/** What the caller knows about one solid (by part id). */
export interface DfaGeometry {
  /** box in assembly coordinates, mm */
  box: [V3, V3];
  /** solid volume, mm³ */
  volume?: number;
}

export interface DfaFacts {
  /** a solid's placed box and volume by part id; undefined when it is not built */
  geometry?: (id: string) => DfaGeometry | undefined;
  /** whether two solids (part ids) really touch: undefined when not measured, and boxes meeting stand in */
  touching?: (a: string, b: string) => boolean | undefined;
}

/** One thing to pick up and fit: a made part, a bought part, or one fastener of a pattern. */
export interface DfaItem {
  /** instance id: the part id, or one component instance ("lid_screws#2") */
  id: string;
  /** block name in the source */
  name: string;
  label: string;
  role: DfaRole;
  libKind?: string;
  fastener?: FastenerType;
  /** thread size of screws, nuts and inserts ("M3") */
  thread?: string;
  /** what you buy, for bought parts and fasteners */
  description?: string;
  material: string;
  /** made parts: process id ("fdm"), "none" for made by hand, "default" when unset */
  process?: string;
  /** its solids (part ids), for highlighting */
  parts: string[];
  essential: boolean;
  reason?: EssentialReason;
  /** why it is or is not in the minimum, in plain words */
  why: string;
  /** estimated seconds to handle and fit it */
  seconds: number;
  /** what the seconds are made of ("drive a screw 8 s") */
  time: string[];
  /** unit direction it goes in along, when the design records one */
  direction?: V3;
  /** box size, mm, when the geometry is known */
  dims?: V3;
  /** made parts: mass in g from the solid and its material (bought parts are drawn as solid blocks, so none) */
  mass?: number;
}

/** Made parts that could be one part: fixed, touching, same material and process. */
export interface DfaMerge {
  /** stable id: dfa:merge:<a>:<b>... (sorted item ids) */
  id: string;
  items: string[];
  /** the one the others would join (the base or the largest) */
  into: string;
  material: string;
  process?: string;
  /** pairs that touch inside the group */
  pairs: [string, string][];
  /** confirmed by the geometry kernel, or judged from bounding boxes only */
  contact: "confirmed" | "boxes";
  /** the combined part is bigger than the brief's build volume */
  tooBig?: boolean;
}

export interface DfaDirection {
  dir: V3;
  /** "down (−Z)", "sideways (+X)" */
  label: string;
  topDown: boolean;
  items: string[];
}

export interface DfaFastenerType {
  /** what you buy, e.g. "Socket head cap screw M3×8" */
  label: string;
  type: FastenerType;
  thread?: string;
  count: number;
  items: string[];
}

export interface DfaFinding {
  /** stable check id (dfa:...) */
  id: string;
  status: DfaStatus;
  title: string;
  /** what was found, with the numbers behind it */
  detail: string;
  /** what to change, as a suggestion */
  fix?: string;
  /** solids (part ids) to highlight */
  parts: string[];
  /** the items (instance ids) it is about */
  items: string[];
  basis: "geometry" | "parameters";
}

export interface DfaTimeLine {
  label: string;
  count: number;
  seconds: number;
}

export interface DfaReport {
  counts: {
    /** everything picked up and fitted: made + bought + fasteners */
    items: number;
    made: number;
    bought: number;
    fasteners: number;
    /** parts soldered to circuit boards: counted with their board, not here */
    boardParts: number;
    wires: number;
    /** wire ends to connect (two per wire) */
    wireEnds: number;
  };
  /** distinct fasteners you buy, most used first */
  fastenerTypes: DfaFastenerType[];
  /** thread sizes of screws, nuts and inserts, most used first */
  threads: { size: string; count: number }[];
  /** Boothroyd–Dewhurst theoretical minimum part count */
  minimumParts: number;
  items: DfaItem[];
  merges: DfaMerge[];
  directions: DfaDirection[];
  /** times the assembly is turned over or onto another side */
  reorientations: number;
  time: {
    /** estimated hand assembly time per unit, s */
    seconds: number;
    low: number;
    high: number;
    lines: DfaTimeLine[];
  };
  /** design efficiency, 0..1: 3 s × minimum parts ÷ estimated time */
  efficiency: number;
  findings: DfaFinding[];
  /** solid pairs (part ids) whose contact was judged from boxes alone: the runtime measures these */
  boxContacts: [string, string][];
  /** how much geometry the report saw */
  geometry: "full" | "partial" | "none";
}

// ---------------------------------------------------------------- classifying

const FASTENER_KINDS: Record<string, FastenerType> = {
  screw: "screw",
  bolt: "screw",
  nut: "nut",
  washer: "washer",
  insert: "insert",
  dowel: "dowel",
  pin: "dowel",
  rivet: "rivet",
  standoff: "other",
  circlip: "other",
};

const BOARD_KINDS = new Set(["pcb", "circuit_board"]);
/** parts that are soldered to the board they sit on in every real build */
const SOLDERED_KINDS = new Set(["usb_c"]);

const KIND_NOUN: Record<string, string> = {
  bearing: "bearing",
  linear_bearing: "bearing",
  nema17: "motor",
  stepper: "motor",
  gearmotor: "motor",
  servo: "motor",
  actuator: "actuator",
  pcb: "circuit board",
  circuit_board: "circuit board",
  controller: "circuit board",
  host: "circuit board",
  motor_driver: "circuit board",
  stepper_driver: "circuit board",
  regulator: "circuit board",
  sensor: "sensor",
  amplifier: "circuit board",
  display: "display",
  usb_c: "connector",
  connector: "connector",
  jack: "connector",
  terminal: "connector",
  spur_gear: "gear",
  extrusion: "frame extrusion",
  rail: "linear rail",
  rod: "rod",
  lead_screw: "lead screw",
  pulley: "pulley",
  coupler: "shaft coupler",
  seal: "seal",
  step: "imported part",
};

const plain = (label: string) => label.replace(/ #\d+$/, "");
/** what to call an item in a sentence: a made part's label, a bought part's block name (catalog names run long) */
const nameOf = (w: { role: DfaRole; label: string; name: string }) => (w.role === "made" ? w.label : w.name);
/** "y_beams ×2, base" */
function namesWithCounts(ws: { role: DfaRole; label: string; name: string }[]): string[] {
  const counts = new Map<string, number>();
  for (const w of ws) counts.set(nameOf(w), (counts.get(nameOf(w)) ?? 0) + 1);
  return [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n));
}
const instanceOf = (p: EvalPart) => (p.kind === "component" ? p.id.split(".")[0] : p.id);
const threadName = (text: string | undefined) => text?.match(/\bM\d+(?:\.\d+)?\b/)?.[0];
const threadSpec = (size: string | undefined) => (size ? Object.values(THREADS).find((t) => t.name === size) : undefined);
const plural = (n: number, one: string, many = one + "s") => `${fmtNum(n, 0)} ${n === 1 ? one : many}`;
const pct = (x: number) => `${fmtNum(x * 100, 0)} %`;

/** "45 s", "2 min 40 s" */
export function fmtTime(s: number): string {
  if (s < 90) return `${fmtNum(Math.round(s), 0)} s`;
  const r = Math.round(s / 5) * 5;
  const m = Math.floor(r / 60);
  const sec = r - m * 60;
  if (m >= 60) return `${fmtNum(Math.floor(m / 60), 0)} h ${fmtNum(m % 60, 0)} min`;
  return sec ? `${m} min ${sec} s` : `${m} min`;
}

function listText(xs: string[], max = 4): string {
  const shown = xs.length > max ? [...xs.slice(0, max), `${xs.length - max} more`] : xs;
  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}` : (shown[0] ?? "");
}

const AXES = ["X", "Y", "Z"];

/**
 * A screw's head sits at this box: within about a head's size of its surface on the
 * side the head faces (counterbored heads included), not buried deep inside it.
 */
function headAt(f: { solids: EvalPart[] }, box: [V3, V3]): boolean {
  const fi = f.solids[0]?.fastener;
  if (!fi) return false;
  const p = fi.headTop;
  const o = fi.outward;
  const outside = Math.hypot(...[0, 1, 2].map((k) => Math.max(box[0][k] - p[k], 0, p[k] - box[1][k])));
  if (outside > fi.headD) return false;
  let exit = Infinity;
  for (let k = 0; k < 3; k++) {
    if (o[k] > 1e-9) exit = Math.min(exit, (box[1][k] - p[k]) / o[k]);
    else if (o[k] < -1e-9) exit = Math.min(exit, (box[0][k] - p[k]) / o[k]);
  }
  return exit <= fi.headD;
}

/** Where an assembly direction points, in words. */
export function directionLabel(d: V3): string {
  let k = 0;
  for (let i = 1; i < 3; i++) if (Math.abs(d[i]) > Math.abs(d[k])) k = i;
  if (Math.abs(d[k]) > 0.97) {
    const sign = d[k] < 0 ? "−" : "+";
    if (k === 2) return d[2] < 0 ? "down (−Z)" : "up (+Z)";
    return `sideways (${sign}${AXES[k]})`;
  }
  return `at an angle (${d.map((x) => fmtNum(x, 2)).join(", ")})`;
}

function unionBox(boxes: [V3, V3][]): [V3, V3] | undefined {
  if (!boxes.length) return undefined;
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const [a, b] of boxes)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], a[k]);
      hi[k] = Math.max(hi[k], b[k]);
    }
  return [lo, hi];
}

const boxesMeet = (x: [V3, V3], y: [V3, V3], tol = BOX_TOL) => [0, 1, 2].every((k) => x[0][k] - tol <= y[1][k] && y[0][k] - tol <= x[1][k]);
const boxDims = (b: [V3, V3]): V3 => [b[1][0] - b[0][0], b[1][1] - b[0][1], b[1][2] - b[0][2]];

/** A solid's box in assembly coordinates from its own (unplaced) box and placement. */
export function placedBox(local: [V3, V3], xf: Xform[]): [V3, V3] {
  const corners: [V3, V3][] = [];
  for (let i = 0; i < 8; i++) {
    const c: V3 = [local[i & 1 ? 1 : 0][0], local[i & 2 ? 1 : 0][1], local[i & 4 ? 1 : 0][2]];
    const w = applyXforms(c, xf);
    corners.push([w, w]);
  }
  return unionBox(corners)!;
}

/** Facts from mesh results by geometry hash (the engine's mesh cache, or kernel builds in tests). */
export function geometryFromMeshes(model: Model, mesh: (hash: string) => { bbox: [V3, V3]; volume: number } | undefined, skip?: (p: EvalPart) => boolean): (id: string) => DfaGeometry | undefined {
  const byId = new Map(model.parts.map((p) => [p.id, p]));
  return (id) => {
    const p = byId.get(id);
    if (!p || skip?.(p)) return undefined;
    const m = mesh(p.hash);
    return m ? { box: placedBox(m.bbox, p.xf), volume: m.volume } : undefined;
  };
}

// ---------------------------------------------------------------- recipe reading

/** Hex pockets cut into made parts (captive nuts): centre in assembly coordinates, across-flats and depth. */
function hexPockets(made: EvalPart[]): { center: V3; af: number; depth: number }[] {
  const out: { center: V3; af: number; depth: number }[] = [];
  const hexOf = (pts: V2[]): { c: V2; af: number } | null => {
    if (pts.length !== 6) return null;
    const c: V2 = [pts.reduce((s, p) => s + p[0], 0) / 6, pts.reduce((s, p) => s + p[1], 0) / 6];
    const rs = pts.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1]));
    const r = rs.reduce((s, x) => s + x, 0) / 6;
    if (!(r > 0) || rs.some((x) => Math.abs(x - r) > 0.08 * r)) return null;
    return { c, af: r * Math.sqrt(3) };
  };
  const walk = (s: ShapeRecipe, xf: Xform[]): void => {
    switch (s.t) {
      case "prism": {
        const h = hexOf(s.pts);
        if (!h) return;
        const f = frameAt(s.at, s.dir, s.rot);
        out.push({ center: applyXforms(vadd(framePoint(f, h.c[0], h.c[1]), vscale(vnorm(s.dir), s.h / 2)), xf), af: h.af, depth: s.h });
        return;
      }
      case "extrude": {
        const h = s.p.t === "poly" ? hexOf(s.p.pts) : null;
        if (!h) return;
        out.push({ center: applyXforms(vadd(framePoint(s.f, h.c[0], h.c[1]), vscale(vnorm(s.f.n), s.h / 2)), xf), af: h.af, depth: s.h });
        return;
      }
      case "xform":
        return walk(s.shape, [...s.xf, ...xf]);
      case "union":
        return s.shapes.forEach((x) => walk(x, xf));
      case "diff":
        return walk(s.a, xf);
      default:
        return;
    }
  };
  for (const p of made) for (const o of p.recipe.ops) if (o.op === "cut") walk(o.shape, p.xf);
  return out;
}

/** A large thread on a removable part: it screws on by hand (a jar lid), not with machine screws. */
function screwsOnByHand(p: EvalPart): boolean {
  const big = (s: ShapeRecipe): boolean => {
    switch (s.t) {
      case "thread":
        return s.spec.d > 12;
      case "xform":
        return big(s.shape);
      case "union":
        return s.shapes.some(big);
      default:
        return false;
    }
  };
  return (p.recipe.base ? big(p.recipe.base) : false) || p.recipe.ops.some((o) => (o.op === "add" || o.op === "cut") && big(o.shape));
}

// ---------------------------------------------------------------- the report

interface Work extends DfaItem {
  solids: EvalPart[];
  box?: [V3, V3];
  volume?: number;
  /** ambiguous axis (bearings, gears, dowels): either way along it */
  axis?: V3;
  moves: boolean;
  removable: boolean;
  /** nut held in a hex pocket */
  captive?: boolean;
  /** timeline bucket */
  op: string;
}

function processKey(p: EvalPart): string {
  if (p.processNone) return "none";
  return p.process?.id ?? "default";
}

function processLabel(key: string | undefined): string | undefined {
  if (!key || key === "default") return undefined;
  if (key === "none") return "bought or made by hand";
  return (PROCESSES as Record<string, { label: string } | undefined>)[key]?.label ?? key;
}

/** Plastic parts can usually take snap fits; metals and wood rarely. */
function snapFitMaterial(material: string): boolean {
  const r = materialRecord(material);
  if (r) return r.category === "plastic";
  return /PLA|PETG|ABS|ASA|Nylon|PA\b|POM|PP\b|PC\b|TPU/i.test(material);
}

/**
 * The design-for-assembly report. Everything in `facts` is optional: without
 * geometry the counts, minimum, times and directions still come out, but
 * there are no merge candidates or size adjustments.
 */
export function dfaReport(model: Model, facts: DfaFacts = {}): DfaReport {
  const geom = facts.geometry ?? (() => undefined);
  const boxContacts: [string, string][] = [];
  const seenBoxPair = new Set<string>();

  // ---- items: one per instance, sub-solids of a component belong to it
  const machine = model.machine;
  const onBoard = new Set((machine?.components ?? []).filter((c) => c.pcb).map((c) => c.name));
  const hasBoard = model.parts.some((p) => p.libKind && BOARD_KINDS.has(p.libKind));
  const groups = new Map<string, EvalPart[]>();
  const boardInstances = new Set<string>();
  for (const p of model.parts) {
    if (p.hidden) continue;
    const inst = instanceOf(p);
    if (p.kind === "component" && (onBoard.has(p.name) || (hasBoard && SOLDERED_KINDS.has(p.libKind ?? "")))) {
      boardInstances.add(inst);
      continue;
    }
    groups.set(inst, [...(groups.get(inst) ?? []), p]);
  }

  const items: Work[] = [];
  for (const [id, solids] of groups) {
    const main = solids.find((s) => s.id === id) ?? solids[0];
    const libKind = main.kind === "component" ? main.libKind : undefined;
    const fastener = libKind ? FASTENER_KINDS[libKind] : undefined;
    const role: DfaRole = main.kind === "part" ? "made" : fastener ? "fastener" : "bought";
    const g = solids.map((s) => geom(s.id));
    const boxes = g.filter((x): x is DfaGeometry => !!x).map((x) => x.box);
    const box = boxes.length === solids.length ? unionBox(boxes) : undefined;
    const known = g.every((x) => x && x.volume !== undefined);
    const volume = known ? g.reduce((s, x) => s + (x!.volume ?? 0), 0) : undefined;
    // bought parts are modelled as solid blocks, so only a made part's mass is worth anything
    const mass = known && main.kind === "part" ? solids.reduce((s, x, i) => s + ((g[i]!.volume ?? 0) / 1000) * materialDensity(x.material), 0) : undefined;
    const thread = main.fastener?.size ?? (fastener ? threadName(main.bom?.description ?? main.label) : undefined);
    items.push({
      id,
      name: main.name,
      label: plain(main.label),
      role,
      libKind,
      fastener,
      thread,
      description: role === "made" ? undefined : (main.bom?.description ?? plain(main.label)),
      material: main.material,
      process: role === "made" ? processKey(main) : undefined,
      parts: solids.map((s) => s.id),
      essential: false,
      why: "",
      seconds: 0,
      time: [],
      dims: box ? boxDims(box) : undefined,
      mass,
      solids,
      box,
      volume,
      moves: solids.some((s) => !!s.motion && Math.abs(s.motion.ratio) > 1e-9),
      removable: solids.some((s) => s.removable),
      op: "",
    });
  }
  const byId = new Map(items.map((w) => [w.id, w]));
  const made = items.filter((w) => w.role === "made");
  const bought = items.filter((w) => w.role === "bought");
  const fasteners = items.filter((w) => w.role === "fastener");

  // ---- contact between two items: the kernel's answer when there is one, else their boxes
  const contact = (a: Work, b: Work): "yes" | "boxes" | "no" | "unknown" => {
    if (a.box && b.box && !boxesMeet(a.box, b.box)) return "no";
    let unknown = false;
    const pending: [string, string][] = [];
    for (const sa of a.solids)
      for (const sb of b.solids) {
        const ga = geom(sa.id);
        const gb = geom(sb.id);
        if (ga && gb && !boxesMeet(ga.box, gb.box)) continue;
        const t = facts.touching?.(sa.id, sb.id);
        if (t === true) return "yes";
        if (t === undefined) {
          unknown = true;
          if (ga && gb) pending.push([sa.id, sb.id]);
        }
      }
    if (!unknown) return "no";
    if (!a.box || !b.box) return "unknown";
    for (const [x, y] of pending) {
      const k = [x, y].sort().join("|");
      if (!seenBoxPair.has(k)) {
        seenBoxPair.add(k);
        boxContacts.push([x, y]);
      }
    }
    return "boxes";
  };

  // ---- the base: the largest made part (or the first written), else the largest bought one
  const size = (w: Work) => w.volume ?? (w.box ? boxDims(w.box).reduce((s, x) => s * Math.max(x, 0.1), 1) : 0);
  const pickLargest = (ws: Work[]) => ws.reduce<Work | undefined>((best, w) => (!best || size(w) > size(best) ? w : best), undefined);
  const still = made.filter((w) => !w.moves && !w.removable);
  const pool = still.length ? still : made;
  const base = pool.length ? (pool.some((w) => w.volume !== undefined || w.box) ? pickLargest(pool) : pool[0]) : pickLargest(bought.filter((w) => !w.moves));

  // ---- essential items (Boothroyd–Dewhurst): fasteners never are
  for (const w of items) {
    if (w.role === "fastener") {
      w.why = w.fastener === "insert" ? "A fastener: it only gives a screw something to hold." : "A fastener: it only holds other parts together.";
      continue;
    }
    if (w === base) {
      w.essential = true;
      w.reason = "base";
      w.why = "The base the rest is built onto.";
    } else if (w.moves) {
      w.essential = true;
      w.reason = "moves";
      w.why = "It moves relative to the parts around it.";
    } else if (w.removable) {
      w.essential = true;
      w.reason = "service";
      w.why = "It comes off for service, so it has to be separate.";
    } else if (w.role === "bought") {
      w.essential = true;
      w.reason = "bought";
      const noun = KIND_NOUN[w.libKind ?? ""] ?? (w.libKind ?? "part").replace(/_/g, " ");
      w.why = `A bought ${noun} that does a job of its own.`;
    }
  }

  // ---- merge groups: fixed made parts of one material and process that touch
  const fixed = made.filter((w) => !w.moves && !w.removable);
  const parent = new Map(fixed.map((w) => [w.id, w.id]));
  const find = (x: string): string => {
    while (parent.get(x) !== x) x = parent.get(x)!;
    return x;
  };
  const edges: { a: Work; b: Work; how: "yes" | "boxes" }[] = [];
  for (let i = 0; i < fixed.length; i++)
    for (let j = i + 1; j < fixed.length; j++) {
      const a = fixed[i];
      const b = fixed[j];
      if (a.material !== b.material || a.process !== b.process) continue;
      const c = contact(a, b);
      if (c !== "yes" && c !== "boxes") continue;
      edges.push({ a, b, how: c });
      parent.set(find(a.id), find(b.id));
    }
  const clusters = new Map<string, Work[]>();
  for (const w of fixed) clusters.set(find(w.id), [...(clusters.get(find(w.id)) ?? []), w]);

  const merges: DfaMerge[] = [];
  const bv = model.brief?.buildVolume;
  for (const group of clusters.values()) {
    const keep = group.find((w) => w.essential);
    // a group with no base in it is needed once when it must be a different material from a made part it touches
    let into = keep;
    if (!into) {
      const other = made.find((m) => !group.includes(m) && m.material !== group[0].material && group.some((g) => ["yes", "boxes"].includes(contact(g, m))));
      if (other) {
        into = pickLargest(group)!;
        into.essential = true;
        into.reason = "material";
        into.why = `It is ${into.material}, a different material from ${other.label} (${other.material}), which it touches.`;
      }
    }
    for (const w of group) {
      if (w.essential) continue;
      const e = edges.find((x) => x.a === w || x.b === w);
      w.why = e
        ? `Fixed, and the same material and process as ${(e.a === w ? e.b : e.a).label}, which it touches: the two could be one part.`
        : "Fixed, and touches no made part of another material: in principle another part could do its job.";
    }
    if (group.length < 2) continue;
    const ids = group.map((w) => w.id).sort();
    const pairs = edges.filter((e) => group.includes(e.a)).map((e) => [e.a.id, e.b.id] as [string, string]);
    const confirmed = edges.filter((e) => group.includes(e.a)).every((e) => e.how === "yes");
    const union = unionBox(group.filter((w) => w.box).map((w) => w.box!));
    let tooBig: boolean | undefined;
    if (bv && union && group.every((w) => w.box)) {
      const need = boxDims(union).sort((x, y) => x - y);
      const have = [...bv].sort((x, y) => x - y);
      tooBig = need.some((x, k) => x > have[k] + 1e-6);
    }
    const target = into ?? pickLargest(group)!;
    merges.push({ id: `dfa:merge:${ids.join(":")}`, items: ids, into: target.id, material: group[0].material, process: group[0].process, pairs, contact: confirmed ? "confirmed" : "boxes", tooBig });
  }

  // ---- directions each item goes in along
  const screws = fasteners.filter((w) => w.fastener === "screw" && w.solids[0].fastener);
  const pockets = hexPockets(made.flatMap((w) => w.solids));
  for (const w of items) {
    const main = w.solids.find((s) => s.id === w.id) ?? w.solids[0];
    if (w.fastener === "screw" && main.fastener) w.direction = vnorm(vscale(main.fastener.outward, -1));
    else if (w.fastener === "insert") w.direction = vnorm(applyXformsToDir([0, 0, 1], main.xf));
    else if (w.fastener === "nut") {
      const t = threadSpec(w.thread);
      const h = t?.nut_h ?? 2;
      const c = applyXforms([0, 0, h / 2], main.xf);
      w.captive = pockets.some((pk) => (!t || (pk.af >= t.nut_af - 0.2 && pk.af <= t.nut_af + 1.2)) && vlen(vsub(pk.center, c)) <= pk.depth / 2 + h / 2 + 1);
      if (!w.captive) {
        // a loose nut goes on from the far side, toward the screw head
        const s = screws.find((sc) => {
          const f = sc.solids[0].fastener!;
          if (t && f.size !== t.name) return false;
          const rel = vsub(c, f.headTop);
          const along = vdot(rel, f.outward);
          if (along > 0) return false;
          return vlen(vsub(rel, vscale(f.outward, along))) < 1;
        });
        if (s) w.direction = vnorm(s.solids[0].fastener!.outward);
      }
    } else if (main.bearing) w.axis = vnorm(main.bearing.axis);
    else if (main.gear) w.axis = vnorm(main.gear.axis);
    else if (w.fastener === "dowel") w.axis = vnorm(applyXformsToDir([0, 0, 1], main.xf));
  }
  const cosSame = Math.cos((SAME_DIR_DEG * Math.PI) / 180);
  const dirs: DfaDirection[] = [];
  const addDir = (w: Work, d: V3) => {
    w.direction = d;
    const hit = dirs.find((x) => vdot(x.dir, d) >= cosSame);
    if (hit) hit.items.push(w.id);
    else dirs.push({ dir: d, label: directionLabel(d), topDown: d[2] < -0.97, items: [w.id] });
  };
  for (const w of items) if (w.direction) addDir(w, w.direction);
  // either way along an axis: the way something already goes in, else downward
  for (const w of items) {
    if (w.direction || !w.axis) continue;
    const a = w.axis;
    const neg = vscale(a, -1);
    const down = a[2] > 1e-6 ? neg : a;
    const withA = dirs.find((x) => vdot(x.dir, a) >= cosSame)?.items.length ?? 0;
    const withNeg = dirs.find((x) => vdot(x.dir, neg) >= cosSame)?.items.length ?? 0;
    addDir(w, withA > withNeg ? a : withNeg > withA ? neg : down);
  }
  dirs.sort((x, y) => y.items.length - x.items.length);
  const reorientations = Math.max(0, dirs.length - 1);

  // ---- times
  const meshPartners = new Set<string>();
  for (const p of model.parts) if (p.gear?.meshWith) meshPartners.add(p.name).add(p.gear.meshWith);
  for (const w of items) {
    const t: string[] = [];
    let s = 0;
    const add = (sec: number, what: string) => {
      s += sec;
      t.push(`${what} ${fmtNum(sec, 1)} s`);
    };
    switch (w.fastener) {
      case "screw":
        add(DFA_TIMES.screw, "drive a screw");
        w.op = "Drive screws";
        break;
      case "nut":
        add(DFA_TIMES.nut, "place a nut");
        if (!w.captive) add(DFA_TIMES.nutHold, "hold it while tightening");
        w.op = "Fit nuts";
        break;
      case "washer":
        add(DFA_TIMES.washer, "place a washer");
        w.op = "Fit washers";
        break;
      case "insert":
        add(DFA_TIMES.insert, "press in a heat-set insert");
        w.op = "Press in heat-set inserts";
        break;
      case "dowel":
        add(DFA_TIMES.pressFit, "press in a dowel pin");
        w.op = "Press in pins and bearings";
        break;
      case "rivet":
        add(DFA_TIMES.rivet, "place and set a rivet");
        w.op = "Set rivets";
        break;
      default:
        if (w.libKind === "bearing") {
          add(DFA_TIMES.pressFit, "press in a bearing");
          w.op = "Press in pins and bearings";
        } else {
          add(DFA_TIMES.place, "place it");
          w.op = w.role === "made" ? "Place made parts" : "Place bought parts";
        }
    }
    if (w.libKind === "spur_gear" && meshPartners.has(w.name)) add(DFA_TIMES.mesh, "line up its teeth");
    if (w.role === "made" && w.removable && w.solids.some(screwsOnByHand)) add(DFA_TIMES.screwOn, "screw it on");
    const dims = w.dims;
    if (dims) {
      const longest = Math.max(...dims);
      if ((w.mass ?? 0) > DFA_LIMITS.heavyG || longest > DFA_LIMITS.veryLargeMm) add(DFA_TIMES.heavy, (w.mass ?? 0) > DFA_LIMITS.heavyG ? "heavy: two hands" : "very large: two hands");
      else if (longest > DFA_LIMITS.largeMm) add(DFA_TIMES.large, "large");
      else if (longest < DFA_LIMITS.tinyMm) add(DFA_TIMES.tiny, "tiny: tweezers");
    }
    w.seconds = s;
    w.time = t;
  }
  let wires = 0;
  if (machine && (machine.wires.length || machine.nets.length)) {
    try {
      wires = wireList(machine).length;
    } catch {
      wires = machine.wires.length;
    }
  }
  const lines = new Map<string, DfaTimeLine>();
  for (const w of items) {
    const l = lines.get(w.op) ?? { label: w.op, count: 0, seconds: 0 };
    l.count++;
    l.seconds += w.seconds;
    lines.set(w.op, l);
  }
  if (reorientations) lines.set("reorient", { label: "Turn the assembly over", count: reorientations, seconds: reorientations * DFA_TIMES.reorient });
  if (wires) lines.set("wires", { label: "Connect wire ends", count: 2 * wires, seconds: 2 * wires * DFA_TIMES.wireEnd });
  const total = [...lines.values()].reduce((s, l) => s + l.seconds, 0);
  const minimumParts = items.length ? Math.max(1, items.filter((w) => w.essential).length) : 0;
  const efficiency = total > 0 ? Math.min(1, (DFA_TIMES.ideal * minimumParts) / total) : 0;

  // ---- fastener variety
  const types = new Map<string, DfaFastenerType>();
  for (const w of fasteners) {
    const key = w.description ?? w.label;
    const ty = types.get(key) ?? { label: key, type: w.fastener!, thread: w.thread, count: 0, items: [] };
    ty.count++;
    ty.items.push(w.id);
    types.set(key, ty);
  }
  const fastenerTypes = [...types.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const threadCount = new Map<string, number>();
  for (const w of fasteners) if (w.thread) threadCount.set(w.thread, (threadCount.get(w.thread) ?? 0) + 1);
  const threads = [...threadCount].map(([s, count]) => ({ size: s, count })).sort((a, b) => b.count - a.count || a.size.localeCompare(b.size, undefined, { numeric: true }));

  const withBox = items.filter((w) => w.box).length;
  const out: DfaReport = {
    counts: { items: items.length, made: made.length, bought: bought.length, fasteners: fasteners.length, boardParts: boardInstances.size, wires, wireEnds: 2 * wires },
    fastenerTypes,
    threads,
    minimumParts,
    items: items.map(({ solids: _s, box: _b, volume: _v, axis: _a, moves: _m, removable: _r, captive: _c, op: _o, ...rest }) => rest),
    merges,
    directions: dirs,
    reorientations,
    time: { seconds: total, low: total * 0.7, high: total * 1.3, lines: [...lines.values()].sort((a, b) => b.seconds - a.seconds) },
    efficiency,
    findings: [],
    boxContacts,
    geometry: !items.length || withBox === items.length ? "full" : withBox ? "partial" : "none",
  };
  out.findings = findings(model, out, items, byId);
  return out;
}

// ---------------------------------------------------------------- findings

function findings(model: Model, r: DfaReport, items: Work[], byId: Map<string, Work>): DfaFinding[] {
  const out: DfaFinding[] = [];
  const solidsOf = (ids: string[]) => ids.flatMap((id) => byId.get(id)?.parts ?? []);
  const label = (id: string) => {
    const w = byId.get(id);
    return w ? nameOf(w) : id;
  };
  const fasteners = items.filter((w) => w.role === "fastener");
  const made = items.filter((w) => w.role === "made");

  // summary
  if (items.length) {
    const essentials = items.filter((w) => w.essential);
    const fastSec = fasteners.reduce((s, w) => s + w.seconds, 0);
    out.push({
      id: "dfa:summary",
      status: "info",
      title: `Assembly: ${plural(r.counts.items, "item")}, about ${fmtTime(r.time.seconds)} by hand`,
      detail:
        `${r.counts.items} to put together: ${plural(r.counts.made, "made part")}, ${plural(r.counts.bought, "bought part")} and ${plural(r.counts.fasteners, "fastener")}` +
        `${r.counts.boardParts ? `, plus ${plural(r.counts.boardParts, "part")} soldered to circuit boards` : ""}${r.counts.wires ? ` and ${plural(r.counts.wireEnds, "wire end")} to connect` : ""}. ` +
        `Theoretical minimum ${r.minimumParts} (${listText(namesWithCounts(essentials), 5)}): the parts that move, come off, are bought for a job of their own, must be a different material, or are the base. ` +
        `Estimated ${fmtTime(r.time.seconds)} per unit (${fmtTime(r.time.low)} to ${fmtTime(r.time.high)})${fastSec > 0 ? `, ${fmtTime(fastSec)} of it on fasteners` : ""}. ` +
        `DFA index ${pct(r.efficiency)} (3 s × ${r.minimumParts} ÷ ${fmtNum(r.time.seconds, 0)} s): first designs often score 5–10 %, well-refined ones 20–30 %.`,
      parts: [],
      items: [],
      basis: r.geometry === "none" ? "parameters" : "geometry",
    });
  }

  // parts that could be one
  for (const m of r.merges) {
    const ordered = [m.into, ...m.items.filter((id) => id !== m.into)];
    const names = ordered.map(label);
    const between = fasteners.filter((f) => {
      const fb = f.box;
      if (!fb) return false;
      return m.items.filter((id) => {
        const b = byId.get(id)?.box;
        return !!b && boxesMeet(b, fb);
      }).length >= 2;
    });
    const saved = m.items.filter((id) => id !== m.into).reduce((s, id) => s + (byId.get(id)?.seconds ?? 0), 0) + between.reduce((s, f) => s + f.seconds, 0);
    const how = processLabel(m.process);
    const two = m.items.length === 2;
    out.push({
      id: m.id,
      status: m.contact === "confirmed" && !m.tooBig && m.items.length === 2 ? "warn" : "info",
      title: two ? `${names[0]} and ${names[1]} could be one part` : `${listText(names, 3)} could be fewer parts`,
      detail:
        `${two ? "Both are" : `All ${m.items.length} are`} ${m.material}${how ? ` (${how})` : ""}, they touch${m.contact === "boxes" ? " (judged from their bounding boxes; the exact contact is not confirmed yet)" : ""} and none of them moves or comes off. ` +
        `Making ${two ? "them one part" : `them fewer parts`} saves about ${fmtTime(saved)} of assembly per unit${between.length ? `, including the ${plural(between.length, "fastener")} that join${between.length === 1 ? "s" : ""} them` : ""}.` +
        (m.tooBig ? ` Together they are bigger than the build volume in the brief, so they may have to stay separate.` : ""),
      fix: `Make ${two ? "them one part" : `the ${m.material} parts fewer`}: ${two ? `fold ${names[1]} into ${names[0]} (join the bodies in one part block)` : `build what you can onto ${names[0]} as one part block`}. Keep them apart only if they must be to make, to fit the machine or to replace one on its own.`,
      parts: solidsOf(ordered),
      items: ordered,
      basis: "geometry",
    });
  }
  // only when every made part's geometry is known: without it, contact is unknown
  if (!r.merges.length && made.length && made.every((w) => w.box)) {
    out.push({
      id: "dfa:lean",
      status: "pass",
      title: made.length === 1 ? "One made part" : "No made parts to combine",
      detail:
        made.length === 1
          ? `${made[0].label} is the only part to make; the other ${plural(r.counts.items - 1, "item")} ${r.counts.items - 1 === 1 ? "is" : "are"} bought.`
          : `None of the ${made.length} made parts touches another of the same material and process while both stay put, so there is nothing obvious to combine.`,
      parts: [],
      items: [],
      basis: r.geometry === "none" ? "parameters" : "geometry",
    });
  }

  // fastener variety
  const screwTypes = r.fastenerTypes.filter((t) => t.type === "screw");
  const threadText = r.threads.map((t) => `${t.size} × ${t.count}`).join(", ");
  const keys = [...new Set(fasteners.filter((w) => w.fastener === "screw").map((w) => w.solids[0].fastener?.key).filter((k): k is number => k !== undefined))].sort((a, b) => a - b);
  const keyText = keys.length ? ` (${keys.length === 1 ? `one ${fmtNum(keys[0])} mm hex key` : `hex keys ${listText(keys.map((k) => `${fmtNum(k)}`))} mm`})` : "";
  if (r.threads.length >= 3) {
    const top = r.threads[0];
    out.push({
      id: "dfa:fastener-sizes",
      status: "warn",
      title: `${r.threads.length} fastener sizes`,
      detail: `The fasteners come in ${r.threads.length} thread sizes: ${threadText}${keyText}. Every size is another tool, another box of parts and another chance to pick the wrong one.`,
      fix: `Standardise on ${top.size}, the most used (${top.count} of ${fasteners.filter((w) => w.thread).length}), wherever the load allows; keep a larger size only where a joint needs it.`,
      parts: solidsOf(fasteners.filter((w) => w.thread && w.thread !== top.size).map((w) => w.id)),
      items: fasteners.filter((w) => w.thread && w.thread !== top.size).map((w) => w.id),
      basis: "parameters",
    });
  } else if (screwTypes.length >= 5) {
    out.push({
      id: "dfa:fastener-sizes",
      status: "info",
      title: `${screwTypes.length} different screws`,
      detail: `${screwTypes.map((t) => `${t.label} × ${t.count}`).join(", ")}. Each length is another part to stock and sort.`,
      fix: "Use fewer screw lengths: where one length can reach in two places, use it in both.",
      parts: solidsOf(screwTypes.flatMap((t) => t.items)),
      items: screwTypes.flatMap((t) => t.items),
      basis: "parameters",
    });
  } else if (r.threads.length) {
    out.push({
      id: "dfa:fastener-sizes",
      status: "pass",
      title: r.threads.length === 1 ? `One fastener size: ${r.threads[0].size}` : `Two fastener sizes: ${r.threads.map((t) => t.size).join(" and ")}`,
      detail: `${r.fastenerTypes.map((t) => `${t.label} × ${t.count}`).join(", ")}${keyText}.`,
      parts: [],
      items: [],
      basis: "parameters",
    });
  }

  // loose nuts
  const loose = fasteners.filter((w) => w.fastener === "nut" && !w.captive);
  if (loose.length) {
    const sizes = [...new Set(loose.map((w) => w.thread).filter(Boolean))] as string[];
    const sz = sizes[0] ?? "M3";
    out.push({
      id: "dfa:nuts",
      status: "warn",
      title: `${plural(loose.length, "nut")} must be held while tightening`,
      detail: `${loose.length} ${sizes.join("/")} ${loose.length === 1 ? "nut has" : "nuts have"} to be held with a spanner while the screw is turned: about ${fmtNum(DFA_TIMES.nutHold, 0)} s extra each (${fmtNum(loose.length * DFA_TIMES.nutHold, 0)} s per unit), a hand on each side of the part, and a nut to drop.`,
      fix: `Thread the screw into the part instead: a heat-set insert in printed plastic (hole(${sz}, fit: "insert") with lib.insert(${sz})), a tapped hole in metal, or a hex pocket that stops the nut turning (cut ngon(6, af: ${sz}.nut_af + 0.3) extruded ${sz}.nut_h deep).`,
      parts: solidsOf(loose.map((w) => w.id)),
      items: loose.map((w) => w.id),
      basis: "parameters",
    });
  }

  // separate washers
  const washers = fasteners.filter((w) => w.fastener === "washer");
  const boughtWashers = (model.machine?.items ?? []).filter((i) => /washer/i.test(i.label)).reduce((s, i) => s + i.qty, 0);
  if (washers.length || boughtWashers) {
    const n = washers.length + boughtWashers;
    out.push({
      id: "dfa:washers",
      status: "info",
      title: `${plural(n, "separate washer")}`,
      detail: `${n} ${n === 1 ? "washer goes" : "washers go"} on by hand, about ${fmtNum(DFA_TIMES.washer, 0)} s each, and ${n === 1 ? "it is" : "they are"} easy to forget or drop.`,
      fix: "Use flanged (or washer-faced) screws and nuts so the washer comes with the fastener.",
      parts: solidsOf(washers.map((w) => w.id)),
      items: washers.map((w) => w.id),
      basis: "parameters",
    });
  }

  // many screws for one joint
  const screwItems = fasteners.filter((w) => w.fastener === "screw");
  const inserts = fasteners.filter((w) => w.fastener === "insert");
  const removables = items.filter((w) => w.removable && !w.moves && w.role !== "fastener" && w.box);
  const counted = new Set<string>();
  for (const rem of removables) {
    const s = screwItems.filter((f) => f.box && boxesMeet(f.box, rem.box!) && headAt(f, rem.box!));
    if (s.length < 4) continue;
    s.forEach((f) => counted.add(f.id));
    const ins = inserts.filter((f) => f.box && s.some((sc) => boxesMeet(f.box!, sc.box!)));
    const sec = [...s, ...ins].reduce((t, f) => t + f.seconds, 0);
    const size = [...new Set(s.map((f) => f.thread).filter(Boolean))].join("/");
    out.push({
      id: `dfa:joint:${rem.id}`,
      status: "info",
      title: `${nameOf(rem)} is held by ${s.length} screws`,
      detail: `${s.length} ${size} screws${ins.length ? ` into ${ins.length} inserts` : ""} hold ${nameOf(rem)}, which comes off for service: ${s.length + ins.length} parts and about ${fmtTime(sec)} to fit, and ${fmtTime(s.length * DFA_TIMES.screw)} more every time it comes off and goes back on.`,
      fix: `A suggestion, if it comes off often: let a lip or locating tabs take the side loads so ${Math.max(2, Math.ceil(s.length / 2))} screws do, or use quarter-turn fasteners${snapFitMaterial(rem.material) ? ` or snap fits (${rem.material} takes them)` : ""}. Keep the screws if it has to seal or stay stiff.`,
      parts: solidsOf([rem.id, ...s.map((f) => f.id)]),
      items: [rem.id, ...s.map((f) => f.id)],
      basis: "geometry",
    });
  }
  // fixed joints: screws grouped by the parts their boxes meet
  const joints = new Map<string, { held: Work[]; screws: Work[] }>();
  const held = items.filter((w) => w.role !== "fastener" && w.box);
  for (const f of screwItems) {
    if (!f.box || counted.has(f.id)) continue;
    const h = held.filter((w) => boxesMeet(w.box!, f.box!));
    if (h.length < 2) continue;
    const key = h.map((w) => w.id).sort().join("+");
    const j = joints.get(key) ?? { held: h, screws: [] };
    j.screws.push(f);
    joints.set(key, j);
  }
  for (const [key, j] of joints) {
    if (j.screws.length < 6) continue;
    const size = [...new Set(j.screws.map((f) => f.thread).filter(Boolean))].join("/");
    const names = j.held.map(nameOf);
    out.push({
      id: `dfa:joint:${key}`,
      status: "info",
      title: `${j.screws.length} screws join ${listText(names, 3)}`,
      detail: `${j.screws.length} ${size} screws hold one joint between ${listText(names, 3)}: about ${fmtTime(j.screws.reduce((t, f) => t + f.seconds, 0))} per unit.`,
      fix: "A suggestion: let locating features (a lip, tabs or dowels) take the loads so fewer, perhaps larger, screws hold the joint.",
      parts: solidsOf(j.screws.map((f) => f.id)),
      items: j.screws.map((f) => f.id),
      basis: "geometry",
    });
  }

  // directions
  const describe = (d: DfaDirection) => {
    const ws = d.items.map((id) => byId.get(id)!);
    const kinds = new Map<string, number>();
    for (const w of ws) {
      const k = w.fastener ? `${w.thread ? w.thread + " " : ""}${w.fastener}` : w.libKind ? (KIND_NOUN[w.libKind] ?? w.libKind) : w.label;
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
    }
    return `${[...kinds].map(([k, n]) => (n > 1 ? `${n} ${k}s` : `1 ${k}`)).join(", ")} ${d.label}`;
  };
  if (r.directions.length === 1) {
    const d = r.directions[0];
    out.push({
      id: "dfa:directions",
      status: "pass",
      title: d.topDown ? "Everything goes in from above" : "Everything goes in from one side",
      detail: `${describe(d)}${d.topDown ? "" : `: stand the assembly with that side up and it all goes in from above`}, with no turning over.`,
      parts: [],
      items: [],
      basis: "parameters",
    });
  } else if (r.directions.length >= 2) {
    const [main, ...rest] = r.directions;
    const odd = rest.flatMap((d) => d.items);
    out.push({
      id: "dfa:directions",
      status: r.directions.length >= 3 ? "warn" : "info",
      title: `Goes together from ${r.directions.length} directions`,
      detail: `${r.directions.map(describe).join("; ")}. That is ${plural(r.reorientations, "turn", "turns")} of the assembly (about ${fmtNum(DFA_TIMES.reorient, 1)} s each), and parts that go in sideways or from below have to be held while they are fastened.`,
      fix: `Rearrange so most of it goes in ${main.topDown ? "from above like the rest" : "the same way, ideally straight down"}: screws from the top into inserts or tapped holes instead of nuts from below, and covers that drop on rather than slide in. Start with the ${plural(odd.length, "item")} that ${odd.length === 1 ? "goes" : "go"} ${listText([...new Set(rest.map((d) => d.label))])}.`,
      parts: solidsOf(odd),
      items: odd,
      basis: "parameters",
    });
  }

  // tiny and heavy parts
  const tiny = items.filter((w) => w.dims && Math.max(...w.dims) < DFA_LIMITS.tinyMm);
  if (tiny.length) {
    out.push({
      id: "dfa:tiny",
      status: "info",
      title: `${plural(tiny.length, "tiny part")}`,
      detail: `${listText(namesWithCounts(tiny))} ${tiny.length === 1 ? "is" : "are"} under ${DFA_LIMITS.tinyMm} mm every way: they need tweezers (about ${fmtNum(DFA_TIMES.tiny, 1)} s extra each) and get dropped.`,
      fix: "Make them part of a larger part, or larger, or buy them already fitted (on the board or in a kit).",
      parts: solidsOf(tiny.map((w) => w.id)),
      items: tiny.map((w) => w.id),
      basis: "geometry",
    });
  }
  const heavy = items.filter((w) => (w.mass ?? 0) > DFA_LIMITS.heavyG || (w.dims && Math.max(...w.dims) > DFA_LIMITS.veryLargeMm));
  if (heavy.length) {
    out.push({
      id: "dfa:heavy",
      status: "info",
      title: `${plural(heavy.length, "part")} needs two hands`,
      detail: `${heavy.map((w) => `${nameOf(w)} (${w.mass && w.mass > DFA_LIMITS.heavyG ? `${fmtNum(w.mass / 1000, 1)} kg` : `${fmtNum(Math.max(...w.dims!), 0)} mm long`})`).join(", ")}: over ${fmtNum(DFA_LIMITS.heavyG / 1000, 1)} kg or ${DFA_LIMITS.veryLargeMm} mm takes two hands or a helper.`,
      fix: "Fit the big parts first, as the base the rest goes onto, and give them somewhere to hold or lift.",
      parts: solidsOf(heavy.map((w) => w.id)),
      items: heavy.map((w) => w.id),
      basis: "geometry",
    });
  }

  const order: Record<DfaStatus, number> = { warn: 0, info: 1, pass: 2 };
  return out.sort((a, b) => (a.id === "dfa:summary" ? -1 : b.id === "dfa:summary" ? 1 : order[a.status] - order[b.status]));
}

// ---------------------------------------------------------------- outputs

/** The report's findings as check items (category "assembly"). */
export function dfaItems(model: Model, report: DfaReport): CheckItem[] {
  const spans = new Map(model.parts.map((p) => [p.id, p.span]));
  return report.findings.map((f) => ({
    id: f.id,
    category: "assembly",
    status: f.status,
    title: f.title,
    detail: f.detail,
    fix: f.fix,
    parts: f.parts.length ? f.parts : undefined,
    span: f.parts.length ? spans.get(f.parts[0]) : undefined,
    basis: f.basis,
  }));
}

/** Block names with counts: "lid_screws (4), lid". */
function blockNames(report: DfaReport, ids: string[]): string {
  const byId = new Map(report.items.map((w) => [w.id, w]));
  const counts = new Map<string, number>();
  for (const id of ids) {
    const n = byId.get(id)?.name ?? id;
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  return [...counts].map(([n, c]) => (c > 1 ? `${n} (${c})` : n)).join(", ");
}

/** A compact plain-text version of the report, for Claude. */
export function dfaText(report: DfaReport): string {
  const r = report;
  if (!r.counts.items) return "Design for assembly: nothing to assemble yet.";
  const L: string[] = ["Design for assembly (Boothroyd–Dewhurst estimate):"];
  L.push(
    `- ${r.counts.items} items: ${r.counts.made} made, ${r.counts.bought} bought, ${r.counts.fasteners} fasteners${r.counts.boardParts ? ` (+${r.counts.boardParts} soldered to boards, not counted)` : ""}${r.counts.wires ? `; ${r.counts.wires} wires (${r.counts.wireEnds} ends)` : ""}.`,
  );
  if (r.fastenerTypes.length) L.push(`- Fasteners: ${r.fastenerTypes.map((t) => `${t.label} ×${t.count}`).join(", ")}.`);
  const ess = r.items.filter((w) => w.essential);
  const why = new Map<string, number>();
  for (const w of ess) why.set(`${w.name} (${w.reason})`, (why.get(`${w.name} (${w.reason})`) ?? 0) + 1);
  L.push(`- Theoretical minimum ${r.minimumParts}: ${[...why].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(", ") || "none"}.`);
  L.push(`- Hand assembly about ${fmtTime(r.time.seconds)} per unit (${fmtTime(r.time.low)}–${fmtTime(r.time.high)}): ${r.time.lines.map((l) => `${l.label.toLowerCase()} ${l.count}× ${fmtNum(l.seconds, 0)} s`).join(", ")}.`);
  L.push(`- DFA index ${pct(r.efficiency)} (3 s × minimum ÷ time; 5–10 % is typical of first designs, 20–30 % is lean).`);
  if (r.directions.length) L.push(`- Directions: ${r.directions.map((d) => `${d.label} ×${d.items.length}`).join(", ")}; ${plural(r.reorientations, "turn")} of the assembly.`);
  if (r.geometry !== "full") L.push(`- Geometry: ${r.geometry === "none" ? "not built yet, so no contacts, sizes or merge candidates" : "partly built, so some contacts and sizes are missing"}.`);
  const fs = r.findings.filter((f) => f.id !== "dfa:summary");
  if (fs.length) {
    L.push("Findings:");
    for (const f of fs) L.push(`- [${f.status}] ${f.title}: ${f.detail}${f.fix ? ` Fix: ${f.fix}` : ""}${f.items.length ? ` [blocks: ${blockNames(r, f.items)}]` : ""}`);
  }
  return L.join("\n");
}

/** Working rules for Claude's system prompt. */
export function dfaPromptSection(): string {
  return `## Design for assembly
Design every product to be put together quickly and without mistakes; the assembly checks (category "assembly") estimate it the Boothroyd–Dewhurst way. Use fewer parts: a part earns its place only if it moves relative to the others, must be a different material, has to come off for service, or is bought for a job of its own; anything else should be part of a neighbour (combine fixed parts of the same material that touch). Use standard fasteners, as few as hold the load, and one size throughout (M3 for small printed parts) so one tool does everything. Make it go together from one direction, ideally straight down onto a base, with no turning over. Give parts self-locating features (lips, tabs, pins, chamfered lead-ins) so they drop into place and need no holding while they are fastened. Use snap fits where the material allows (PETG, ABS, nylon, PP; not for parts opened often in brittle PLA). Avoid loose nuts and separate washers: thread into heat-set inserts, tapped holes or captive hex pockets, and use flanged screws. Leave room for the driver or hex key to reach every screw straight on. Mistake-proof parts: make them symmetric so orientation does not matter, or clearly asymmetric (a tab, a keyed hole) so they only fit the right way. Keep parts big enough to handle (over about 3 mm). When you change a design for assembly, say what it saves in parts and seconds.`;
}
