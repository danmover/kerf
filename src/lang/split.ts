// split: and pieces(): a part made in pieces, cut across planes so each piece
// fits the printer (or the machine) and joined again on dowel pins. The
// language side: what the design asks for, and where the evaluator finds the
// cuts and pin spots the engine works out from the part as built (src/core/
// splitGeom.ts), the way mates find the built solids' faces.

import { def } from "./builtins";
import { Obj, Vec, typeName, type CallCtx, type Value } from "./values";
import { frameFor, vnorm, type V3 } from "../kernel/recipe";
import type { ProcessSpec } from "../mfg/types";
import { isPrinted } from "../library/materials";

export const SPLIT_JOINS = ["dowel", "printed", "glue", "none"] as const;
export type SplitJoin = (typeof SPLIT_JOINS)[number];

/** One direction a part is cut across: at given heights along it, into a number of equal pieces, or (neither) into the fewest that fit. */
export interface SplitAxis {
  /** unit, in the part's own coordinates */
  dir: V3;
  /** where the cuts are, mm along dir from the part's origin, ascending */
  at?: number[];
  count?: number;
}

export interface SplitSpec {
  axes: SplitAxis[];
  join: SplitJoin;
  /** pins in each joint */
  pins: number;
  /** pin diameter and length, mm; left out, sized to the joints */
  pin?: number;
  length?: number;
}

/** What the evaluator asks of the part as built: the part's geometry hash and the split, with what it is made by (for the bed). */
export interface SplitQuery {
  key: string;
  hash: string;
  part: string;
  spec: SplitSpec;
  process?: ProcessSpec;
  material: string;
}

/** One cell of the cuts that has material in it: a piece. */
export interface SplitCell {
  /** interval index on each axis */
  index: number[];
  /** the piece's box, part coordinates */
  box: [V3, V3];
}

/** Pins in one joint: where a cut meets material between two neighbouring pieces. */
export interface SplitJoint {
  axis: number;
  cut: number;
  /** the cells on either side (indices into cells) */
  below: number;
  above: number;
  /** pin centres on the cut plane, part coordinates */
  spots: V3[];
  /** area of the joint face, mm² */
  area: number;
  /** the widest pin the joint has room for, mm (0: none) */
  room: number;
}

/** The cuts and pins the engine worked out for a split part, from its mesh. */
export interface SplitInfo {
  /** cut heights per axis, mm along its dir */
  cuts: number[][];
  /** the part's extent along each axis */
  range: [number, number][];
  /** the part's box in each axis's own frame (u, v across, n along): [lo, hi] each */
  across: [[number, number], [number, number]][];
  cells: SplitCell[];
  joints: SplitJoint[];
  /** the pins used: diameter and length, mm (0 when the join has none) */
  pin: number;
  length: number;
  /** the build volume the pieces were sized for, when the count was left to the bed */
  bed?: { size: V3; what: string };
  warnings: string[];
  error?: string;
}

export type SplitLookup = (q: SplitQuery) => SplitInfo | undefined;

let splitTable: SplitLookup = () => undefined;
/** Where evaluation finds the cuts and pins of split parts (the engine sets it, and fills it as parts are built). */
export function setEvalSplits(lookup: SplitLookup) {
  splitTable = lookup;
}
export const evalSplits = () => splitTable;

/** The key a split is known by: the part's geometry and the split asked for. */
export function splitKey(hash: string, spec: SplitSpec): string {
  return `${hash}|${JSON.stringify(spec)}`;
}

/** Steel dowel pins (ISO 8734) kept in stock: diameters, and a length of about four diameters for each. */
export const DOWEL_SIZES: [number, number][] = [
  [2, 8],
  [2.5, 10],
  [3, 12],
  [4, 16],
  [5, 20],
  [6, 24],
  [8, 32],
  [10, 40],
];

export const dowelLength = (d: number) => DOWEL_SIZES.find(([s]) => Math.abs(s - d) < 1e-6)?.[1] ?? Math.round(4 * d);

/** Clearance of a pin's hole over the pin, mm: printed holes close up a little, machined ones are reamed to size. */
export function pinHoleClearance(join: SplitJoin, printed: boolean): number {
  if (join === "printed") return 0.3;
  return printed ? 0.2 : 0;
}

/** A split part is printed when its process prints it, or it has none and its material is a filament. */
export const splitPrinted = (q: { process?: ProcessSpec; material: string }) => (q.process ? ["fdm", "sla", "sls", "metal_print"].includes(q.process.id) : isPrinted(q.material));

/** How deep each pin goes into each piece: half its length and a little to spare. */
export const pinDepth = (length: number) => length / 2 + 0.5;

const AXIS_WORDS: [V3, string][] = [
  [[1, 0, 0], "x"],
  [[0, 1, 0], "y"],
  [[0, 0, 1], "z"],
];

/** "x" for X, "-y" for -Y, the direction itself otherwise. */
export function axisWord(d: V3): string {
  for (const [a, w] of AXIS_WORDS) {
    const dot = d[0] * a[0] + d[1] * a[1] + d[2] * a[2];
    if (dot > 0.9999) return w;
    if (dot < -0.9999) return `-${w}`;
  }
  return `(${d.map((x) => +x.toFixed(3)).join(", ")})`;
}

/** The frame a split axis cuts in: n along it, u and v across (v = n × u, like a profile's). */
export function axisFrame(dir: V3): { u: V3; v: V3; n: V3 } {
  return frameFor(dir);
}

function axisFrom(v: Value, ctx: CallCtx, what: string): V3 {
  if (!(v instanceof Vec) || v.v.length !== 3) return ctx.error(`${what} should be a direction like X, Y or Z, got ${typeName(v)}`);
  const d = v.v as V3;
  if (Math.hypot(...d) < 1e-9) return ctx.error(`${what} must be a non-zero direction`);
  return vnorm(d);
}

/** A pieces() value, or the plain axis split: X. */
export class SplitV extends Obj {
  constructor(
    public axis: SplitAxis,
    public join?: SplitJoin,
    public pins?: number,
    public pin?: number,
    public length?: number,
  ) {
    super({}, "split", "pieces");
  }
}

/** The split: value of a part as a spec: an axis, a pieces() or a list of them (a grid of cuts). */
export function splitSpec(v: Value, ctx: CallCtx): SplitSpec {
  const list = Array.isArray(v) ? v : [v];
  if (!list.length) return ctx.error("split: needs a direction, like split: X, or pieces(X, at: [150])");
  if (list.length > 3) return ctx.error("split: takes at most three directions (a grid of cuts)");
  const items = list.map((x, i) => (x instanceof SplitV ? x : new SplitV({ dir: axisFrom(x, ctx, list.length > 1 ? `split: item ${i + 1}` : "split:") })));
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i].axis.dir;
      const b = items[j].axis.dir;
      if (Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) > 0.98) ctx.error("split: two of the directions are the same: give that one direction all its cuts, like pieces(X, at: [100, 200])");
    }
  const pick = <K extends "join" | "pins" | "pin" | "length">(k: K): SplitV[K] => {
    const given = items.filter((x) => x[k] !== undefined);
    if (given.length > 1 && given.some((x) => x[k] !== given[0][k])) ctx.error(`split: the directions give different ${k}: values; the joints all take the same pins, so give ${k}: once`);
    return given[0]?.[k];
  };
  const join = pick("join") ?? "dowel";
  const pins = pick("pins") ?? (join === "dowel" || join === "printed" ? 2 : 0);
  const pin = pick("pin");
  const length = pick("length");
  return {
    axes: items.map((x) => x.axis),
    join,
    pins: join === "dowel" || join === "printed" ? pins : 0,
    ...(pin !== undefined ? { pin } : {}),
    ...(length !== undefined ? { length } : {}),
  };
}

/** How the split reads in words: "across x at 150 and 300", "across x into 3 pieces", "across x to fit the printer". */
export function splitWords(spec: SplitSpec): string {
  return spec.axes
    .map((a) => {
      const w = axisWord(a.dir);
      if (a.at) return `across ${w} at ${a.at.map((t) => +t.toFixed(1)).join(", ")}`;
      if (a.count) return `across ${w} into ${a.count} pieces`;
      return `across ${w}`;
    })
    .join(" and ");
}

export const SPLIT_FNS = Object.fromEntries([
  def(
    "pieces",
    ["along", "at", "count", "join", "pins", "pin", "length"],
    (a) => {
      const along = a.value("along");
      if (along === undefined) a.ctx.error("pieces(): give the direction to cut across first, like pieces(X, at: [150])");
      const dir = axisFrom(along!, a.ctx, "pieces(): along");
      let at: number[] | undefined;
      if (a.has("at")) {
        const v = a.value("at")!;
        const raw = typeof v === "number" ? [v] : Array.isArray(v) ? v : v instanceof Vec ? v.v : null;
        if (!raw || !raw.length || raw.some((x) => typeof x !== "number" || !Number.isFinite(x))) a.ctx.error("pieces(): at: is where the cuts are, mm along the direction from the part's origin: a number or a list like at: [150, 300]");
        at = [...(raw as number[])].sort((x, y) => x - y);
        for (let i = 1; i < at.length; i++) if (at[i] - at[i - 1] < 2) a.ctx.error(`pieces(): the cuts at ${at[i - 1]} and ${at[i]} are less than 2 mm apart`);
        if (at.length > 30) a.ctx.error("pieces(): at most 30 cuts across one direction");
      }
      let count: number | undefined;
      if (a.has("count")) {
        if (at) a.ctx.error("pieces(): give at: (where the cuts are) or count: (how many equal pieces), not both");
        count = a.num("count");
        if (!Number.isInteger(count) || count < 2 || count > 31) a.ctx.error("pieces(): count: is how many equal pieces to cut it into, 2 to 31");
      }
      const join = a.has("join") ? a.oneOf("join", SPLIT_JOINS, "dowel") : undefined;
      let pins: number | undefined;
      if (a.has("pins")) {
        pins = a.num("pins");
        if (!Number.isInteger(pins) || pins < 0 || pins > 8) a.ctx.error("pieces(): pins: is how many pins go in each joint, 0 to 8");
        if (join === "glue" || join === "none") a.ctx.error(`pieces(): join: "${join}" has no pins; leave out pins:`);
      }
      let pin: number | undefined;
      let length: number | undefined;
      if (a.has("pin")) {
        const v = a.value("pin")!;
        if (typeof v === "number") pin = v;
        else if (v instanceof Vec && v.v.length === 2) [pin, length] = v.v;
        else a.ctx.error("pieces(): pin: is the pins' diameter, like pin: 4, or their diameter and length, like pin: (4, 16)");
        if (!(pin! >= 1 && pin! <= 20)) a.ctx.error("pieces(): pin: diameter should be 1 to 20 mm");
        if (length !== undefined && !(length >= 2 * pin! && length <= 200)) a.ctx.error("pieces(): a pin should be at least twice as long as it is wide");
        if (join === "glue" || join === "none") a.ctx.error(`pieces(): join: "${join}" has no pins; leave out pin:`);
      }
      if (a.has("length")) {
        if (length !== undefined) a.ctx.error("pieces(): give the pins' length once: pin: (4, 16) or length: 16");
        length = a.positive("length");
        if (pin !== undefined && length < 2 * pin) a.ctx.error("pieces(): a pin should be at least twice as long as it is wide");
      }
      return new SplitV({ dir, ...(at ? { at } : {}), ...(count ? { count } : {}) }, join, pins, pin, length);
    },
    'pieces(along, at: [..], count:, join: "dowel", pins: 2, pin: (sized to the joints), length: 4 × pin) — for a part\'s split: property: cut it across `along` (a direction in the part\'s own coordinates) at the heights at: (mm along it from the part\'s origin), into count: equal pieces, or, with neither, into the fewest pieces that fit its printer\'s bed (or machine). join: "dowel" puts pins: steel dowel pins (ISO 8734) in each joint, in holes in both pieces, placed in solid material well apart; "printed" prints the pins with the pieces; "glue" a plain glued joint; "none" just the cut, to join it yourself. pin: (d, length) sets the pins. split: X is pieces(X); a list such as split: [pieces(X, at: [200]), pieces(Y, at: [0])] cuts a grid.',
  ),
]);
