// Plain modelling commands done at once, without Claude: "fillet 2",
// "chamfer 1 top", "shell 2", "hole M3 here", "move 10 up", "rotate 90 z",
// "wall 3", "material PETG", "colour red", "copy", "delete", "box 40x20x10".
// A command is only recognised when every word in it is understood, so a
// request with more in it than a plain command still goes to Claude.
// Everything here is a text edit on the design source, like any other.

import type { Item, Stmt } from "../lang/ast";
import { parse } from "../lang/parser";
import { fmtNum } from "../lang/values";
import { MATERIAL_DB } from "../library/materialDb";
import type { EvalParam, Model } from "./model";
import { formatParamValue, setBlockProps } from "./sourceEdit";

export type Vec3 = [number, number, number];

export const EDGE_PRESETS = ["all", "top", "bottom", "vertical", "horizontal", "convex", "concave", "sharp"] as const;
export type EdgePreset = (typeof EDGE_PRESETS)[number];

export type QuickCommand =
  | { k: "fillet" | "chamfer"; r?: number; edges?: EdgePreset; target?: string }
  /** open: a face direction ("Z", "-Y"), "here" for the face the user points at, or null for a closed shell */
  | { k: "shell"; t?: number; open?: string | null; target?: string }
  | { k: "hole"; size?: string; d?: number; depth?: number; through?: boolean; fit?: "clearance" | "close" | "tap" | "insert" | "thread"; csink?: boolean; cbore?: boolean; target?: string }
  | { k: "move"; by: Vec3; target?: string }
  | { k: "rotate"; angle: number; axis: 0 | 1 | 2; target?: string }
  | { k: "param"; name: string; op: "set" | "add" | "mul"; value: number | string | boolean }
  | { k: "material"; material: string; target?: string }
  | { k: "color"; color: string; name: string; target?: string }
  | { k: "copy"; by?: Vec3; target?: string }
  | { k: "delete"; target?: string }
  /** size: box (w, d, h), cylinder (d, h), sphere (d); join: add to the part pointed at rather than make a new part */
  | { k: "new"; shape: "box" | "cylinder" | "sphere"; size: number[]; join?: boolean }
  /** copies of a part: in a row, `step` apart, or round an axis through `center`, spread over `angle` degrees (360: all the way round) */
  | { k: "pattern"; count: number; step?: Vec3; angle?: number; axis?: 0 | 1 | 2; center?: Vec3; target?: string }
  /** the other hand of a part: a new part that is its mirror image across the plane square to `axis` at `at` along it, and follows it */
  | { k: "mirror"; axis: 0 | 1 | 2; at?: number; target?: string }
  /** cut another part or component (`tool`, which stays) out of this part, where it really sits */
  | { k: "subtract"; tool: string; target?: string }
  | { k: "undo" }
  | { k: "redo" };

/** What the parser needs to know about the design: its parameter and part names. */
export interface QuickVocab {
  params: Pick<EvalParam, "name" | "value">[];
  parts: { name: string; label: string }[];
}

export const vocabOf = (model: Model | null): QuickVocab => ({
  params: model?.params ?? [],
  parts: [...new Map((model?.parts ?? []).map((p) => [p.name, { name: p.name, label: p.label }])).values()],
});

// ---------------------------------------------------------------------------
// Words

const POLITE = new Set(["please", "pls", "plz", "can", "could", "would", "will", "you", "now", "ok", "okay", "then", "just", "also", "and", "so", "hey", "kerf", "quickly"]);
const COMMON = new Set(["the", "a", "an", "some", "it", "its", "it's", "this", "that", "these", "those", "them", "one", "of", "to", "on", "onto", "with", "by", "at", "for", "please", "part", "thing", "piece", "mm", "here", "there"]);

const LENGTH: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, '"': 25.4 };
/** Unit words after a number ("2 mm"); "in" and "m" only count written onto the number ("2in"), since "10 in x" is not inches. */
const LENGTH_WORDS: Record<string, number> = { mm: 1, millimetre: 1, millimeter: 1, millimetres: 1, millimeters: 1, cm: 10, inch: 25.4, inches: 25.4 };
const ANGLE = new Set(["deg", "degs", "degree", "degrees", "°"]);

const DIRS: Record<string, Vec3> = {
  up: [0, 0, 1], upward: [0, 0, 1], upwards: [0, 0, 1], higher: [0, 0, 1], above: [0, 0, 1],
  down: [0, 0, -1], downward: [0, 0, -1], downwards: [0, 0, -1], below: [0, 0, -1],
  left: [-1, 0, 0], right: [1, 0, 0],
  forward: [0, -1, 0], forwards: [0, -1, 0], front: [0, -1, 0], closer: [0, -1, 0],
  back: [0, 1, 0], backward: [0, 1, 0], backwards: [0, 1, 0], rear: [0, 1, 0], away: [0, 1, 0], behind: [0, 1, 0],
  x: [1, 0, 0], "+x": [1, 0, 0], "-x": [-1, 0, 0], y: [0, 1, 0], "+y": [0, 1, 0], "-y": [0, -1, 0], z: [0, 0, 1], "+z": [0, 0, 1], "-z": [0, 0, -1],
};

/** Face words for shell openings and placement, as the direction the face looks. */
const FACES: Record<string, string> = { top: "Z", bottom: "-Z", base: "-Z", underside: "-Z", front: "-Y", back: "Y", rear: "Y", left: "-X", right: "X", "+z": "Z", z: "Z", "-z": "-Z", "+x": "X", x: "X", "-x": "-X", "+y": "Y", y: "Y", "-y": "-Y" };

const PRESET_WORDS: Record<string, EdgePreset> = {
  all: "all", every: "all", top: "top", upper: "top", bottom: "bottom", lower: "bottom", vertical: "vertical", upright: "vertical", corners: "vertical", corner: "vertical",
  horizontal: "horizontal", outside: "convex", outer: "convex", outer_edges: "convex", external: "convex", convex: "convex", inside: "concave", inner: "concave", internal: "concave", concave: "concave", sharp: "sharp",
};

export const COLORS: Record<string, string> = {
  red: "#d64541", orange: "#ef8a2d", yellow: "#f2c230", lime: "#9bd23c", green: "#3fa66b", teal: "#2a9d8f", cyan: "#3cc4d8", blue: "#3d7bfd", navy: "#24407a", purple: "#8a5cd6", violet: "#8a5cd6", pink: "#e86fa6", magenta: "#d63fa0",
  brown: "#8b5a3c", tan: "#c9a77c", beige: "#d8c8a8", black: "#22252a", white: "#eef0f2", grey: "#8a9099", gray: "#8a9099", silver: "#b8bec6", gold: "#c9a43b", bronze: "#a8743c", copper: "#b87333", olive: "#7a8040",
};
const SHADES: Record<string, number> = { dark: -0.35, light: 0.4, pale: 0.55, bright: 0.15, deep: -0.25 };

/** Material aliases people say, to the names Kerf knows. */
const MATERIAL_ALIASES: Record<string, string> = {
  aluminium: "Aluminum 6061", aluminum: "Aluminum 6061", alu: "Aluminum 6061", ally: "Aluminum 6061", "6061": "Aluminum 6061", "7075": "Aluminum 7075", "5052": "Aluminum 5052",
  stainless: "Stainless 304", "stainless steel": "Stainless 304", "304": "Stainless 304", "316": "Stainless 316", ss: "Stainless 304",
  "mild steel": "Steel", "carbon steel": "Steel", iron: "Cast iron", "cast iron": "Cast iron",
  nylon: "Nylon", pa: "Nylon", pa12: "Nylon", "carbon nylon": "Nylon CF", "nylon carbon": "Nylon CF", "carbon fibre nylon": "Nylon CF", pacf: "Nylon CF", "petg cf": "PETG CF", "petg-cf": "PETG CF", "carbon petg": "PETG CF",
  "carbon fibre": "Carbon fiber", "carbon fiber": "Carbon fiber", carbon: "Carbon fiber", cf: "Carbon fiber",
  polycarbonate: "PC", acetal: "POM", delrin: "POM", polypropylene: "PP", perspex: "Acrylic", plexiglass: "Acrylic", pmma: "Acrylic",
  rubber: "Natural rubber", plywood: "Wood", timber: "Wood", resin: "Resin", ti: "Titanium",
};

// ---------------------------------------------------------------------------
// Tokens

interface Num {
  v: number;
  unit?: "len" | "angle";
  /** the text had an explicit sign: +1 or -1 */
  signed?: boolean;
}

const NUM = /^([+-]?(?:\d+\.?\d*|\.\d+))(mm|cm|m|in|"|°|deg|degs|degrees?)?$/;
const DIMS = /^(\d+(?:\.\d+)?)(?:mm)?(?:x(\d+(?:\.\d+)?)(?:mm)?){1,2}$/;
const MSIZE = /^m(\d+(?:\.\d+)?)$/;

function tokenize(text: string): string[] {
  const s = text
    .toLowerCase()
    .replace(/[×✕]/g, "x")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/=/g, " = ")
    .replace(/(\d)\s*x\s*(?=\d)/g, "$1x");
  const raw = s.match(/\(\s*[-+]?[\d.]+\s*,\s*[-+]?[\d.]+\s*,\s*[-+]?[\d.]+\s*\)|"[^"]*"|#[0-9a-f]{3,8}\b|[^\s,;]+/g) ?? [];
  return raw.map((t) => (t.startsWith("(") || t.startsWith('"') || t.startsWith("#") ? t : t.replace(/[.!:]+$/, ""))).filter(Boolean);
}

function numOf(t: string): Num | null {
  const m = NUM.exec(t);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (!Number.isFinite(v)) return null;
  const u = m[2];
  const signed = /^[+-]/.test(m[1]);
  if (!u) return { v, signed };
  if (u === "°" || u.startsWith("deg")) return { v, unit: "angle", signed };
  return { v: v * LENGTH[u], unit: "len", signed };
}

const vecOf = (t: string): Vec3 | null => {
  const m = /^\(\s*([-+]?[\d.]+)\s*,\s*([-+]?[\d.]+)\s*,\s*([-+]?[\d.]+)\s*\)$/.exec(t);
  return m ? [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])] : null;
};

/** Numbers in a token list, taking a following unit word into the number. Returns the numbers and the tokens left. */
function takeNumbers(tokens: string[]): { nums: Num[]; rest: string[]; order: (Num | string)[] } {
  const nums: Num[] = [];
  const rest: string[] = [];
  const order: (Num | string)[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const n = numOf(tokens[i]);
    if (!n) {
      rest.push(tokens[i]);
      order.push(tokens[i]);
      continue;
    }
    const next = tokens[i + 1];
    if (!n.unit && next !== undefined) {
      if (next in LENGTH_WORDS) {
        n.v *= LENGTH_WORDS[next];
        n.unit = "len";
        i++;
      } else if (ANGLE.has(next)) {
        n.unit = "angle";
        i++;
      }
    }
    nums.push(n);
    order.push(n);
  }
  return { nums, rest, order };
}

const onlyWords = (rest: string[], allowed: Set<string>) => rest.every((w) => allowed.has(w) || COMMON.has(w));

// ---------------------------------------------------------------------------
// Parsing

/**
 * The command in a message, or null when the message is anything more than a
 * plain command (it then goes to Claude). Part and parameter names come from
 * the design, so "move lid 5 up" and "wall 3" work.
 */
export function parseQuick(text: string, vocab: QuickVocab): QuickCommand | null {
  const t = text.trim();
  if (!t || t.length > 140 || t.includes("\n") || /\?\s*$/.test(t)) return null;
  let tokens = tokenize(t);
  while (tokens.length && POLITE.has(tokens[0])) tokens = tokens.slice(1);
  if (!tokens.length) return null;
  // a part named like a command word ("shell", "box") is tried both ways
  const named = takeTarget(tokens, vocab);
  if (named) {
    const cmd = parseTokens(named.rest, vocab, named.target);
    if (cmd) return cmd;
  }
  return parseTokens(tokens, vocab, undefined);
}

/** A part named in the message ("on the lid", "bracket"), and the words left. */
function takeTarget(tokens: string[], vocab: QuickVocab): { target: string; rest: string[] } | null {
  const names: { words: string[]; name: string }[] = [];
  for (const p of vocab.parts) {
    names.push({ words: [p.name.toLowerCase()], name: p.name });
    const label = p.label.toLowerCase().split(/\s+/).filter(Boolean);
    if (label.length && label.join(" ") !== p.name.toLowerCase()) names.push({ words: label, name: p.name });
    if (p.name.includes("_")) names.push({ words: p.name.toLowerCase().split("_"), name: p.name });
  }
  // longest names first, so "front panel" beats "panel"
  names.sort((a, b) => b.words.length - a.words.length);
  for (const n of names) {
    for (let i = 0; i + n.words.length <= tokens.length; i++) {
      if (!n.words.every((w, k) => tokens[i + k] === w)) continue;
      let start = i;
      while (start > 0 && ["on", "to", "of", "for", "the", "from", "in"].includes(tokens[start - 1])) start--;
      return { target: n.name, rest: [...tokens.slice(0, start), ...tokens.slice(i + n.words.length)] };
    }
  }
  return null;
}

const FAMILY: Record<string, QuickCommand["k"]> = {
  fillet: "fillet", fillets: "fillet", filleted: "fillet", round: "fillet", rounded: "fillet", radius: "fillet", radiused: "fillet", radii: "fillet",
  chamfer: "chamfer", chamfers: "chamfer", chamfered: "chamfer", bevel: "chamfer", bevels: "chamfer", bevelled: "chamfer", beveled: "chamfer",
  shell: "shell", hollow: "shell",
  hole: "hole", holes: "hole", drill: "hole",
  move: "move", shift: "move", nudge: "move", translate: "move", raise: "move", lower: "move",
  rotate: "rotate", turn: "rotate", flip: "rotate", tilt: "rotate",
  color: "color", colour: "color", paint: "color", recolor: "color", recolour: "color",
  material: "material",
  copy: "copy", duplicate: "copy", clone: "copy",
  delete: "delete", remove: "delete", erase: "delete",
  box: "new", cube: "new", block: "new", cylinder: "new", rod: "new", disc: "new", disk: "new", puck: "new", sphere: "new", ball: "new",
  undo: "undo", redo: "redo",
};

function parseTokens(tokens: string[], vocab: QuickVocab, target: string | undefined): QuickCommand | null {
  if (!tokens.length) return null;
  // the first word that names a command decides it, unless it is the name of one of the design's parameters
  const verbAt = tokens.findIndex((w) => w in FAMILY);
  const param = target ? null : findParam(tokens, vocab);
  if (param && (verbAt < 0 || (verbAt >= param.at && verbAt < param.at + param.len))) return parseParam(tokens, param);
  const cmd = parseCommand(tokens, verbAt, target);
  return cmd ?? (param ? parseParam(tokens, param) : null);
}

function parseCommand(tokens: string[], verbAt: number, target: string | undefined): QuickCommand | null {
  if (verbAt < 0) {
    // "make it red", "use PETG", "petg"
    return parseColor(tokens, target) ?? parseMaterial(tokens, target);
  }
  const verb = tokens[verbAt];
  const rest = [...tokens.slice(0, verbAt), ...tokens.slice(verbAt + 1)];
  switch (FAMILY[verb]) {
    case "fillet":
    case "chamfer":
      return parseEdges(FAMILY[verb] as "fillet" | "chamfer", rest, target);
    case "shell":
      return parseShell(rest, target);
    case "hole":
      return parseHole(rest, target);
    case "move":
      return parseMove(verb, rest, target);
    case "rotate":
      return parseRotate(verb, rest, target);
    case "color":
      return parseColor(rest, target, true);
    case "material":
      return parseMaterial(rest, target);
    case "copy":
      return parseCopy(rest, target);
    case "delete":
      return onlyWords(rest, new Set(["it", "this", "part", "the", "that", "selected", "selection", "whole", "body"])) ? { k: "delete", target } : null;
    case "new":
      return parseNew(verb, rest, target);
    case "undo":
    case "redo":
      return !target && onlyWords(rest, new Set(["that", "last", "change", "it"])) ? { k: FAMILY[verb] as "undo" | "redo" } : null;
  }
  return null;
}

const EDGE_WORDS = new Set(["add", "make", "give", "put", "apply", "edge", "edges", "corner", "corners", "off", "around", "all", "the", "r", "radius", "size", "everywhere", "outside_edges"]);

function parseEdges(k: "fillet" | "chamfer", rest: string[], target: string | undefined): QuickCommand | null {
  // "r2" and "r 2" are the radius
  const { nums, rest: words } = takeNumbers(rest.map((w) => /^r\d/.test(w) ? w.slice(1) : w));
  // without a size it is Claude's call how big ("round the corners")
  if (nums.length !== 1 || nums[0].unit === "angle" || nums[0].v <= 0) return null;
  const said = new Set<EdgePreset>();
  let corners = false;
  const left: string[] = [];
  for (const w of words) {
    const p = PRESET_WORDS[w];
    if (!p) left.push(w);
    else if (w === "corner" || w === "corners") corners = true;
    else said.add(p);
  }
  // "all the top edges" is the top edges; "the corners" are the vertical edges unless something else is said
  if (said.size > 1) said.delete("all");
  if (corners && !said.size) said.add("vertical");
  if (said.size > 1 || !onlyWords(left, EDGE_WORDS)) return null;
  return { k, r: nums[0]?.v, edges: [...said][0], target };
}

const SHELL_WORDS = new Set(["out", "wall", "walls", "thick", "thickness", "shell", "leave", "leaving", "make", "it", "inside", "face", "side", "open", "opening", "closed", "sealed", "solid", "with", "and", "at", "into", "a"]);

function parseShell(rest: string[], target: string | undefined): QuickCommand | null {
  const { nums, rest: words } = takeNumbers(rest);
  if (nums.length !== 1 || nums[0].unit === "angle" || nums[0].v <= 0) return null;
  let open: string | null | undefined;
  let openWord = false;
  for (const w of words) {
    if (w === "closed" || w === "sealed") open = null;
    else if (w === "open" || w === "opening") openWord = true;
    else if (FACES[w] && w !== "x" && w !== "y" && w !== "z") open = FACES[w];
    else if (!SHELL_WORDS.has(w) && !COMMON.has(w)) return null;
  }
  if (openWord && open === undefined && (words.includes("here") || words.includes("this") || words.includes("face"))) open = "here";
  if (openWord && open === null) return null;
  return { k: "shell", t: nums[0]?.v, open, target };
}

const HOLE_WORDS = new Set(["add", "make", "put", "drill", "cut", "hole", "for", "screw", "bolt", "dia", "diameter", "d", "size", "wide", "deep", "depth", "through", "thru", "all", "way", "the", "clearance", "close", "tap", "tapped", "threaded", "thread", "insert", "heat-set", "heatset", "countersunk", "countersink", "csk", "counterbored", "counterbore", "cbore", "an", "x", "blind"]);

function parseHole(rest: string[], target: string | undefined): QuickCommand | null {
  const sizes = rest.map((w) => MSIZE.exec(w)).filter((m): m is RegExpExecArray => !!m);
  if (sizes.length > 1) return null;
  const tokens = rest.filter((w) => !MSIZE.test(w));
  const { order, rest: words } = takeNumbers(tokens);
  if (!onlyWords(words, HOLE_WORDS)) return null;
  const cmd: Extract<QuickCommand, { k: "hole" }> = { k: "hole", target };
  if (sizes.length) cmd.size = `M${sizes[0][1]}`;
  // numbers: the diameter unless an M size gave it; a number next to "deep"/"depth" is the depth
  for (let i = 0; i < order.length; i++) {
    const n = order[i];
    if (typeof n === "string") continue;
    if (n.unit === "angle" || n.v <= 0) return null;
    const near = [order[i - 1], order[i + 1]].filter((x): x is string => typeof x === "string");
    if (near.includes("deep") || near.includes("depth")) cmd.depth = n.v;
    else if (cmd.size === undefined && cmd.d === undefined) cmd.d = n.v;
    else if (cmd.depth === undefined) cmd.depth = n.v;
    else return null;
  }
  if (words.some((w) => w === "through" || w === "thru") || (words.includes("all") && words.includes("way"))) cmd.through = true;
  if (cmd.through && cmd.depth !== undefined) return null;
  if (words.includes("insert") || words.includes("heat-set") || words.includes("heatset")) cmd.fit = "insert";
  else if (words.includes("threaded") || words.includes("thread")) cmd.fit = "thread";
  else if (words.includes("tap") || words.includes("tapped")) cmd.fit = "tap";
  else if (words.includes("close")) cmd.fit = "close";
  else if (words.includes("clearance")) cmd.fit = "clearance";
  if (cmd.fit && cmd.fit !== "clearance" && cmd.d !== undefined && !cmd.size) return null;
  if (words.some((w) => w.startsWith("countersun") || w === "countersink" || w === "csk")) cmd.csink = true;
  if (words.some((w) => w.startsWith("counterbor") || w === "cbore")) cmd.cbore = true;
  if (cmd.csink && cmd.cbore) return null;
  // without a size it is Claude's call which screw it is for
  if (cmd.size === undefined && cmd.d === undefined) return null;
  return cmd;
}

const MOVE_WORDS = new Set(["it", "by", "along", "in", "the", "direction", "axis", "and", "towards", "toward", "me", "more", "further", "farther", "over", "a", "bit"]);

/** Pairs of amounts and directions: "10 up", "up 10", "x 10", "-5 z", "(10, 0, 5)". */
function offsetOf(rest: string[], allowed: Set<string>): Vec3 | null | undefined {
  const vecs = rest.map(vecOf).filter((v): v is Vec3 => !!v);
  const tokens = rest.filter((w) => !vecOf(w));
  if (vecs.length > 1) return null;
  const { order } = takeNumbers(tokens);
  const out: Vec3 = vecs[0] ? [...vecs[0]] : [0, 0, 0];
  let pendingNum: Num | null = null;
  let pendingDir: Vec3 | null = null;
  let any = !!vecs.length;
  for (const it of order) {
    if (typeof it !== "string") {
      if (it.unit === "angle") return null;
      if (pendingDir) {
        for (let k = 0; k < 3; k++) out[k] += pendingDir[k] * it.v;
        pendingDir = null;
        any = true;
      } else if (pendingNum) return null;
      else pendingNum = it;
      continue;
    }
    const d = DIRS[it];
    if (d) {
      if (pendingNum) {
        for (let k = 0; k < 3; k++) out[k] += d[k] * pendingNum.v;
        pendingNum = null;
        any = true;
      } else if (pendingDir) return null;
      else pendingDir = d;
    } else if (!allowed.has(it) && !COMMON.has(it)) return null;
  }
  if (pendingNum || (pendingDir && any)) return null;
  return any ? out : undefined;
}

function parseMove(verb: string, rest: string[], target: string | undefined): QuickCommand | null {
  if (verb === "raise" || verb === "lower") {
    const { nums, rest: words } = takeNumbers(rest);
    if (nums.length !== 1 || nums[0].unit === "angle" || !onlyWords(words, MOVE_WORDS)) return null;
    return { k: "move", by: [0, 0, verb === "raise" ? nums[0].v : -nums[0].v], target };
  }
  const by = offsetOf(rest, MOVE_WORDS);
  if (!by || by.every((v) => v === 0)) return null;
  return { k: "move", by, target };
}

const ROTATE_WORDS = new Set(["it", "by", "about", "around", "round", "the", "axis", "over", "upside", "down", "clockwise", "cw", "counterclockwise", "counter-clockwise", "anticlockwise", "anti-clockwise", "ccw", "on", "its", "side"]);

function parseRotate(verb: string, rest: string[], target: string | undefined): QuickCommand | null {
  const { nums, rest: words } = takeNumbers(rest);
  if (nums.length > 1 || nums.some((n) => n.unit === "len")) return null;
  if (!onlyWords(words.filter((w) => !["x", "y", "z"].includes(w)), ROTATE_WORDS)) return null;
  const axes = words.filter((w) => w === "x" || w === "y" || w === "z");
  if (axes.length > 1) return null;
  let angle = nums[0]?.v;
  if (angle === undefined) {
    if (verb !== "flip") return null;
    angle = 180;
  }
  if (words.some((w) => w === "clockwise" || w === "cw")) angle = -angle;
  const axis = (axes.length ? "xyz".indexOf(axes[0]) : verb === "flip" || verb === "tilt" ? 0 : 2) as 0 | 1 | 2;
  if (!angle) return null;
  return { k: "rotate", angle, axis, target };
}

const COPY_WORDS = new Set([...MOVE_WORDS, "and", "move", "place", "put", "next", "beside", "make", "a", "another"]);

function parseCopy(rest: string[], target: string | undefined): QuickCommand | null {
  // "copy that" means "understood"
  if (rest.includes("that")) return null;
  const by = offsetOf(rest, COPY_WORDS);
  if (by === null) return null;
  return { k: "copy", by: by && by.some((v) => v !== 0) ? by : undefined, target };
}

const COLOR_WORDS = new Set(["make", "set", "change", "turn", "it", "paint", "color", "colour", "in", "to", "the", "be", "use"]);

function parseColor(tokens: string[], target: string | undefined, verb = false): QuickCommand | null {
  const left: string[] = [];
  let hex: string | null = null;
  let name = "";
  let shade = 0;
  for (const w of tokens) {
    if (/^#[0-9a-f]{6}$/.test(w) || /^#[0-9a-f]{3}$/.test(w)) {
      if (hex) return null;
      hex = w.length === 4 ? `#${w[1]}${w[1]}${w[2]}${w[2]}${w[3]}${w[3]}` : w;
      name = w;
    } else if (COLORS[w]) {
      if (hex) return null;
      hex = COLORS[w];
      name = w;
    } else if (SHADES[w] !== undefined) shade = SHADES[w];
    else left.push(w);
  }
  if (!hex || !onlyWords(left, COLOR_WORDS)) return null;
  // "make it red" without a colour verb needs the "make it" (or similar) or nothing at all
  if (!verb && left.some((w) => !["make", "it", "turn", "paint", "set", "change", "to", "the", "use", "in"].includes(w))) return null;
  if (shade && name in COLORS) {
    hex = shadeHex(hex, shade);
    name = `${Object.keys(SHADES).find((k) => SHADES[k] === shade)} ${name}`;
  }
  return { k: "color", color: hex, name, target };
}

function shadeHex(hex: string, by: number): string {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const out = c.map((v) => Math.round(by >= 0 ? v + (255 - v) * by : v * (1 + by)));
  return `#${out.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`;
}

const MATERIAL_WORDS = new Set(["make", "it", "use", "change", "switch", "set", "to", "the", "in", "out", "of", "from", "material", "made", "print", "printed", "machine", "machined", "be", "instead"]);

/** The material named by some words, by Kerf's own name or a common alias. */
export function matchMaterial(words: string): string | undefined {
  const w = words.trim().toLowerCase().replace(/\s+/g, " ");
  if (!w) return undefined;
  const exact = MATERIAL_DB.find((m) => m.name.toLowerCase() === w || m.name.toLowerCase().replace(/\s+/g, "") === w.replace(/\s+/g, ""));
  if (exact) return exact.name;
  return MATERIAL_ALIASES[w];
}

function parseMaterial(tokens: string[], target: string | undefined): QuickCommand | null {
  const left = tokens.filter((w) => !MATERIAL_WORDS.has(w) && !COMMON.has(w));
  const material = matchMaterial(left.join(" "));
  return material ? { k: "material", material, target } : null;
}

const NEW_WORDS = new Set(["add", "make", "new", "create", "put", "place", "a", "an", "solid", "join", "joined", "x", "by", "d", "dia", "diameter", "h", "height", "high", "tall", "long", "wide", "deep", "w", "l", "size", "side", "sides", "of", "radius", "r"]);

function parseNew(verb: string, rest: string[], target: string | undefined): QuickCommand | null {
  if (target) return null;
  const shape = verb === "cylinder" || verb === "rod" || verb === "disc" || verb === "disk" || verb === "puck" ? "cylinder" : verb === "sphere" || verb === "ball" ? "sphere" : "box";
  const dims = rest.map((w) => DIMS.exec(w)).filter((m): m is RegExpExecArray => !!m);
  const tokens = rest.filter((w) => !DIMS.test(w));
  const { order, rest: words } = takeNumbers(tokens);
  if (!onlyWords(words, NEW_WORDS) || dims.length > 1) return null;
  // "make a block" is a request to design one; a shape with its sizes is a command
  if (!dims.length && !order.some((n) => typeof n !== "string")) return null;
  let size: number[] = dims.length ? dims[0][0].replace(/mm/g, "").split("x").map(Number) : [];
  // labelled numbers: "d 20 h 30", "diameter 20 height 30", "radius 10"
  const labelled: Record<string, number> = {};
  for (let i = 0; i < order.length; i++) {
    const n = order[i];
    if (typeof n === "string") continue;
    if (n.unit === "angle" || n.v <= 0) return null;
    const before = order[i - 1];
    const after = order[i + 1];
    const label = (typeof before === "string" && ["d", "dia", "diameter", "h", "height", "r", "radius", "w", "l"].includes(before) ? before : null) ?? (typeof after === "string" && ["high", "tall", "long", "wide", "deep", "diameter"].includes(after) ? after : null);
    if (label) labelled[label] = n.v;
    else size.push(n.v);
  }
  const d = labelled.d ?? labelled.dia ?? labelled.diameter ?? (labelled.r ?? labelled.radius ? 2 * (labelled.r ?? labelled.radius) : undefined);
  const h = labelled.h ?? labelled.height ?? labelled.high ?? labelled.tall ?? labelled.long;
  if (shape === "cylinder") {
    if (d !== undefined) size = [d, h ?? size[0] ?? d];
    else if (h !== undefined) size = [size[0] ?? 20, h];
    if (size.length === 1) size = [size[0], size[0]];
    if (!size.length) size = [20, 20];
    if (size.length !== 2) return null;
  } else if (shape === "sphere") {
    if (d !== undefined) size = [d];
    if (!size.length) size = [20];
    if (size.length !== 1) return null;
  } else {
    if (labelled.w !== undefined || labelled.wide !== undefined || labelled.deep !== undefined || h !== undefined) {
      const w = labelled.w ?? labelled.wide ?? size[0] ?? 20;
      size = [w, labelled.deep ?? labelled.l ?? size[1] ?? w, h ?? size[2] ?? w];
    }
    if (size.length === 1) size = [size[0], size[0], size[0]];
    if (!size.length) size = [20, 20, 20];
    if (size.length !== 3) return null;
  }
  const join = words.includes("join") || words.includes("joined") ? true : words.includes("new") ? false : undefined;
  return { k: "new", shape, size, join };
}

/** A parameter named in the message: "wall", "wall_t", "wall thickness" for wall_thickness. */
function findParam(tokens: string[], vocab: QuickVocab): { name: string; at: number; len: number; bool: boolean } | null {
  const byName = new Map(vocab.params.map((p) => [p.name.toLowerCase(), p]));
  for (let len = 3; len >= 1; len--) {
    for (let i = 0; i + len <= tokens.length; i++) {
      const p = byName.get(tokens.slice(i, i + len).join("_"));
      if (p) return { name: p.name, at: i, len, bool: typeof p.value === "boolean" };
    }
  }
  return null;
}

const PARAM_WORDS = new Set(["set", "change", "make", "put", "adjust", "update", "to", "=", "is", "be", "by", "value", "param", "parameter", "the", "at", "mm", "more", "less"]);
const UP_WORDS = new Set(["increase", "raise", "add", "grow", "thicker", "wider", "longer", "taller", "bigger", "larger", "higher", "more", "up", "extend", "lengthen", "widen", "thicken"]);
const DOWN_WORDS = new Set(["decrease", "reduce", "lower", "shrink", "thinner", "narrower", "shorter", "smaller", "less", "down", "trim", "shorten", "narrow"]);

const ON = new Set(["true", "on", "yes", "enable", "enabled"]);
const OFF = new Set(["false", "off", "no", "disable", "disabled"]);

function parseParam(tokens: string[], param: { name: string; at: number; len: number; bool: boolean }): QuickCommand | null {
  const rest = [...tokens.slice(0, param.at), ...tokens.slice(param.at + param.len)];
  if (param.bool) {
    const said = rest.filter((w) => ON.has(w) || OFF.has(w));
    const left = rest.filter((w) => !ON.has(w) && !OFF.has(w));
    if (said.length !== 1 || !onlyWords(left, PARAM_WORDS)) return null;
    return { k: "param", name: param.name, op: "set", value: ON.has(said[0]) };
  }
  const words: string[] = [];
  let sign = 0;
  let mul: number | null = null;
  const values: string[] = [];
  for (const w of rest) {
    if (UP_WORDS.has(w)) sign = sign < 0 ? NaN : 1;
    else if (DOWN_WORDS.has(w)) sign = sign > 0 ? NaN : -1;
    else if (w === "double" || w === "twice") mul = 2;
    else if (w === "halve" || w === "half") mul = 0.5;
    else if (w === "triple") mul = 3;
    else if (PARAM_WORDS.has(w) || COMMON.has(w)) words.push(w);
    else values.push(w);
  }
  if (Number.isNaN(sign)) return null;
  if (mul !== null) return values.length || sign ? null : { k: "param", name: param.name, op: "mul", value: mul };
  if (values.length === 1 && /^"[^"]*"$/.test(values[0])) return sign ? null : { k: "param", name: param.name, op: "set", value: values[0].slice(1, -1) };
  const { nums, rest: left } = takeNumbers(values);
  if (nums.length !== 1 || left.length) return null;
  const n = nums[0];
  if (sign) return { k: "param", name: param.name, op: "add", value: sign * Math.abs(n.v) };
  // "wall +1": a signed number after the name with no "to"/"=" adds
  if (n.signed && !words.includes("to") && !words.includes("=")) return { k: "param", name: param.name, op: "add", value: n.v };
  return { k: "param", name: param.name, op: "set", value: n.v };
}

// ---------------------------------------------------------------------------
// Applying

/** Where the user is pointing, in the target part's own coordinates. */
export interface QuickSpot {
  local: Vec3;
  /** outward normal of the face there, in the part's own frame */
  normal?: Vec3;
  /** the middle of the edge nearest the spot, and how far the spot is from it */
  edge?: { mid: Vec3; dist: number };
  /** edges picked in the view with the selection filter: a point along each, away from its ends */
  edges?: Vec3[];
  /** the same spot in assembly coordinates, with its normal there */
  point?: Vec3;
  worldNormal?: Vec3;
}

export interface QuickContext {
  src: string;
  model: Model;
  /** block name of the part the command acts on: from a spot, the selection, or the command */
  target?: string;
  spot?: QuickSpot;
  /** a part's bounding box in its own frame */
  box?: (block: string) => [Vec3, Vec3] | undefined;
  /** the whole design's bounds, in assembly coordinates */
  bounds?: [Vec3, Vec3];
}

export type QuickResult =
  | { ok: true; src: string; title: string; detail?: string; target?: string }
  /** ai: Claude can still do it (the message goes to Claude); otherwise the user is told why */
  | { ok: false; why: string; ai: boolean };

const fail = (why: string, ai = false): QuickResult => ({ ok: false, why, ai });
const f = (n: number, d = 2) => fmtNum(Math.abs(n) < 1e-9 ? 0 : n, d);
const vec = (v: Vec3, d = 2) => `(${v.map((x) => f(x, d)).join(", ")})`;
const mm = (n: number) => `${f(n)} mm`;

type PartStmt = Extract<Stmt, { k: "part" }>;
type CompStmt = Extract<Stmt, { k: "component" }>;

function blockStmt(src: string, name: string): PartStmt | CompStmt | undefined {
  const { program } = parse(src);
  return program.stmts.find((s): s is PartStmt | CompStmt => (s.k === "part" || s.k === "component") && s.name === name);
}

/** Props on a block that tie it to a mechanism: moving it by hand would leave its axis or pins behind. */
const MECHANISM = ["spin", "axis_at", "rides", "pins", "links", "slides", "swings", "mesh"];

/** Apply a parsed command (not undo/redo or material, which the app does itself). */
export function applyQuick(cmd: QuickCommand, ctx: QuickContext): QuickResult {
  switch (cmd.k) {
    case "param":
      return applyParam(cmd, ctx);
    case "new":
      return applyNew(cmd, ctx);
    case "undo":
    case "redo":
    case "material":
      return fail("Done by the app", false);
  }
  const target = cmd.target ?? ctx.target;
  if (!target) return fail(`Click a part first (or name it, like “${example(cmd)} on ${ctx.model.parts.find((p) => p.kind === "part")?.name ?? "bracket"}”), then say it again.`, true);
  const part = ctx.model.parts.find((p) => p.name === target && !p.id.startsWith(`${target}.`)) ?? ctx.model.parts.find((p) => p.name === target);
  const stmt = blockStmt(ctx.src, target);
  if (!part || !stmt) return fail(`There is no part called ${target}.`);
  if (part.locked) return fail(`${part.label} is locked. Unlock it in the parts list first.`);
  switch (cmd.k) {
    case "fillet":
    case "chamfer":
      if (stmt.k !== "part") return fail(`${part.label} is a library part, so its edges can't be changed. Only parts made in this design can be ${cmd.k === "fillet" ? "filleted" : "chamfered"}.`);
      return applyEdges(cmd, stmt, part.label, ctx);
    case "shell":
      if (stmt.k !== "part") return fail(`${part.label} is a library part, so it can't be shelled.`);
      return applyShell(cmd, stmt, part.label, ctx);
    case "hole":
      if (stmt.k !== "part") return fail(`${part.label} is a library part, so it can't have holes added here.`);
      return applyHole(cmd, stmt, part.label, ctx);
    case "move":
      return applyMove(cmd, stmt, part.label, ctx);
    case "rotate":
      return applyRotate(cmd, stmt, part.label, ctx);
    case "color": {
      const src = setBlockProps(ctx.src, target, { color: cmd.color });
      return { ok: true, src, title: `Coloured ${part.label} ${cmd.name}`, target };
    }
    case "copy":
      return applyCopy(cmd, stmt, part.label, ctx);
    case "delete":
      return applyDelete(stmt, part.label, ctx);
    case "pattern":
      return applyPattern(cmd, stmt, part.label, ctx);
    case "mirror":
      if (stmt.k !== "part") return fail(`${part.label} is a library part, and its mirror image would be a different part (a left-hand thread, a flipped board). Copy it instead.`);
      return applyMirror(cmd, stmt, part.label, part.color, ctx);
    case "subtract":
      if (stmt.k !== "part") return fail(`${part.label} is a library part, so nothing can be cut out of it here. Pick the part to cut first, then the part to cut out of it.`);
      return applySubtract(cmd, stmt, part.label, ctx);
  }
}

function example(cmd: QuickCommand): string {
  switch (cmd.k) {
    case "fillet":
    case "chamfer":
      return `${cmd.k} ${cmd.r ?? 1}`;
    case "move":
      return "move 10 up";
    case "rotate":
      return "rotate 90 z";
    case "hole":
      return "hole M3";
    default:
      return cmd.k;
  }
}

// --- where statements go inside a part

function addsMaterial(it: Item): boolean {
  if (it.k === "op") return it.op !== "cut";
  if (it.k === "for") return it.body.some(addsMaterial);
  if (it.k === "if") return it.then.some(addsMaterial) || !!it.else?.some(addsMaterial);
  return false;
}

/** Insert a statement into a part after `after` (null: at the end), on its own line with the part's indentation. */
function insertItem(src: string, stmt: PartStmt, text: string, after: Item | null): string {
  const items = stmt.items;
  const close = stmt.span.end - 1;
  const open = src.indexOf("{", stmt.nameSpan.end);
  const body = src.slice(open + 1, close);
  if (!body.includes("\n")) {
    // a one-line part: add with a separator before the closing brace
    const head = src.slice(0, close).replace(/\s*$/, "");
    return `${head}; ${text} ${src.slice(close)}`;
  }
  const first = items[0];
  const lineStart = (pos: number) => src.lastIndexOf("\n", pos - 1) + 1;
  const indent = first ? /^[ \t]*/.exec(src.slice(lineStart(first.span.start)))![0] : /^[ \t]*/.exec(src.slice(lineStart(stmt.span.start)))![0] + "  ";
  const anchor = after ?? items[items.length - 1];
  if (!anchor) return src.slice(0, open + 1) + `\n${indent}${text}` + src.slice(open + 1);
  // after the anchor's whole line, so a comment at its end stays with it
  let at = src.indexOf("\n", anchor.span.end);
  if (at < 0 || at > close) at = anchor.span.end;
  return src.slice(0, at) + `\n${indent}${text}` + src.slice(at);
}

/** The last step that adds material (with the modifiers right after it): fillets go here, before later cuts. */
function afterLastAdd(stmt: PartStmt): Item | null {
  const items = stmt.items;
  let i = -1;
  for (let k = 0; k < items.length; k++) if (addsMaterial(items[k])) i = k;
  if (i < 0) return null;
  while (i + 1 < items.length && items[i + 1].k === "modifier") i++;
  return items[i];
}

const AXES = ["X", "Y", "Z"];
/** "Z", "-X" for a direction along an axis; null otherwise. */
function axisName(n: Vec3): string | null {
  const i = [0, 1, 2].reduce((a, b) => (Math.abs(n[b]) > Math.abs(n[a]) ? b : a), 0);
  if (Math.abs(n[i]) < 0.999) return null;
  return `${n[i] < 0 ? "-" : ""}${AXES[i]}`;
}
const axisIndex = (n: Vec3) => [0, 1, 2].reduce((a, b) => (Math.abs(n[b]) > Math.abs(n[a]) ? b : a), 0);
const dirText = (n: Vec3) => axisName(n) ?? vec(n, 3);
const FACE_WORD: Record<string, string> = { Z: "top", "-Z": "bottom", "-Y": "front", Y: "back", "-X": "left", X: "right" };

/** A spot snapped to a 0.5 mm grid across the face, kept exact along its normal. */
function snapOnFace(p: Vec3, n?: Vec3): Vec3 {
  const ax = n && axisName(n) ? axisIndex(n) : -1;
  return p.map((v, i) => (i === ax || ax < 0 ? Math.round(v * 100) / 100 : Math.round(v * 2) / 2)) as Vec3;
}

const PRESET_TEXT: Record<EdgePreset, string> = { all: "all the edges", top: "the top edges", bottom: "the bottom edges", vertical: "the vertical edges", horizontal: "the horizontal edges", convex: "the outside edges", concave: "the inside corners", sharp: "the sharp edges" };

function applyEdges(cmd: Extract<QuickCommand, { k: "fillet" | "chamfer" }>, stmt: PartStmt, label: string, ctx: QuickContext): QuickResult {
  const r = cmd.r ?? 1;
  const verb = cmd.k === "fillet" ? "Filleted" : "Chamfered";
  const spot = ctx.spot;
  if (spot?.edges?.length && !cmd.edges) {
    const one = (m: Vec3) => `near(${vec(m, 3)}, 0.2)`;
    const sel = spot.edges.length === 1 ? one(spot.edges[0]) : `[${spot.edges.map(one).join(", ")}]`;
    const src = insertItem(ctx.src, stmt, `${cmd.k}(${f(r)}, edges: ${sel})`, null);
    return { ok: true, src, title: `${verb} ${spot.edges.length === 1 ? "the edge" : `the ${spot.edges.length} edges`} you picked on ${label} (${mm(r)})`, target: stmt.name };
  }
  if (cmd.edges || !spot) {
    const edges = cmd.edges ?? "all";
    const src = insertItem(ctx.src, stmt, `${cmd.k}(${f(r)}, edges: "${edges}")`, afterLastAdd(stmt));
    return { ok: true, src, title: `${verb} ${PRESET_TEXT[edges]} of ${label} (${mm(r)})`, target: stmt.name };
  }
  const box = ctx.box?.(stmt.name);
  const diag = box ? Math.hypot(box[1][0] - box[0][0], box[1][1] - box[0][1], box[1][2] - box[0][2]) : 50;
  const n = spot.normal;
  const flat = n ? axisName(n) : null;
  // pointing at an edge: that edge; pointing at the middle of a flat face: the edges around that face
  if (spot.edge && (spot.edge.dist <= Math.max(2, diag * 0.05) || !flat)) {
    const src = insertItem(ctx.src, stmt, `${cmd.k}(${f(r)}, edges: near(${vec(spot.edge.mid)}, 0.2))`, null);
    return { ok: true, src, title: `${verb} the edge you picked on ${label} (${mm(r)})`, target: stmt.name };
  }
  if (flat && n) {
    const i = axisIndex(n);
    const sel = `both(facing(${flat}), in_plane(${AXES[i]}, ${f(spot.local[i])}))`;
    const src = insertItem(ctx.src, stmt, `${cmd.k}(${f(r)}, edges: ${sel})`, null);
    return { ok: true, src, title: `${verb} the edges of the ${FACE_WORD[flat] ?? "picked"} face of ${label} (${mm(r)})`, detail: "Point closer to an edge to round just that edge.", target: stmt.name };
  }
  const src = insertItem(ctx.src, stmt, `${cmd.k}(${f(r)}, edges: near(${vec(spot.local)}, 3))`, null);
  return { ok: true, src, title: `${verb} the edges near the spot on ${label} (${mm(r)})`, target: stmt.name };
}

function applyShell(cmd: Extract<QuickCommand, { k: "shell" }>, stmt: PartStmt, label: string, ctx: QuickContext): QuickResult {
  const t = cmd.t ?? 2;
  let open: string | null;
  let openText: string;
  const spot = ctx.spot;
  const wantsHere = cmd.open === "here" || (cmd.open === undefined && !!spot?.normal);
  if (wantsHere) {
    if (!spot?.normal) return fail("Right-click the face to leave open, then say it again.");
    const ax = axisName(spot.normal);
    const box = ctx.box?.(stmt.name);
    const i = axisIndex(spot.normal);
    const outermost = ax && box && Math.abs(spot.local[i] - (spot.normal[i] > 0 ? box[1][i] : box[0][i])) < 0.05;
    open = outermost ? ax : `near(${vec(spot.local)}, 0.2)`;
    openText = ax ? `open on the ${FACE_WORD[ax]} face you picked` : "open on the face you picked";
  } else if (cmd.open === null) {
    open = null;
    openText = "closed all round";
  } else {
    open = cmd.open ?? "Z";
    openText = `open at the ${FACE_WORD[open] ?? open}`;
  }
  const call = `shell(${f(t)}${open ? `, open: ${open}` : ""})`;
  const existing = stmt.items.find((it): it is Extract<Item, { k: "modifier" }> => it.k === "modifier" && it.call.callee.k === "ident" && it.call.callee.name === "shell");
  let src: string;
  if (existing) src = ctx.src.slice(0, existing.span.start) + call + ctx.src.slice(existing.span.end);
  else {
    // shell right after the body, before bosses, ribs and holes
    const body = stmt.items.find((it) => (it.k === "op" && it.op === "body") || ((it.k === "for" || it.k === "if") && addsMaterial(it))) ?? null;
    src = insertItem(ctx.src, stmt, call, body);
  }
  return { ok: true, src, title: `Shelled ${label} to ${mm(t)} walls, ${openText}`, detail: cmd.open === undefined && !spot ? "Say “closed” or “open bottom” to change the opening." : undefined, target: stmt.name };
}

const INSERT_DEPTH: Record<string, number> = { M2: 4, "M2.5": 5, M3: 7, M4: 9, M5: 11, M6: 13 };

function applyHole(cmd: Extract<QuickCommand, { k: "hole" }>, stmt: PartStmt, label: string, ctx: QuickContext): QuickResult {
  const spot = ctx.spot;
  if (!spot?.normal) return fail("Right-click where the hole goes, then say it again (or use Hole in the modelling tools).", true);
  const size = cmd.size ?? (cmd.d !== undefined ? f(cmd.d) : "M3");
  const nominal = cmd.size ? parseFloat(cmd.size.slice(1)) : (cmd.d ?? 3);
  let depth = cmd.depth;
  if ((cmd.fit === "insert" || cmd.fit === "thread" || cmd.fit === "tap") && depth === undefined && !cmd.through) depth = cmd.fit === "insert" ? (INSERT_DEPTH[size] ?? Math.round(nominal * 2.3)) : Math.round(nominal * 2.5);
  const through = depth === undefined;
  const at = snapOnFace(spot.local, spot.normal);
  const into: Vec3 = [-spot.normal[0], -spot.normal[1], -spot.normal[2]];
  const args = [size, through ? "through: true" : `depth: ${f(depth!)}`, `at: ${vec(at)}`, `dir: ${dirText(into)}`];
  if (cmd.fit && cmd.fit !== "clearance" && cmd.size) args.push(`fit: "${cmd.fit}"`);
  if (cmd.csink) args.push("csink: true");
  if (cmd.cbore) args.push("cbore: true");
  const src = insertItem(ctx.src, stmt, `cut hole(${args.join(", ")})`, null);
  const kind = cmd.fit === "insert" ? " heat-set insert" : cmd.fit === "thread" ? " threaded" : cmd.fit === "tap" ? " tapping" : cmd.size ? " clearance" : "";
  const what = cmd.size ? `${size}${kind}` : `${size} mm`;
  const an = /^(M|8|11|18)/.test(what) ? "an" : "a";
  return {
    ok: true,
    src,
    title: `Added ${an} ${what} hole ${through ? "right through" : `${mm(depth!)} deep in`} ${label}`,
    target: stmt.name,
  };
}

// --- placement props

function propItem(stmt: PartStmt | CompStmt, name: string) {
  return stmt.items.find((i): i is Extract<Item, { k: "prop" }> => i.k === "prop" && i.name === name);
}

/** A literal (x, y, z) of numbers, or null when the value is an expression. */
function literalVec(src: string, stmt: PartStmt | CompStmt, name: string): Vec3 | null | undefined {
  const it = propItem(stmt, name);
  if (!it) return undefined;
  const e = it.value;
  if (e.k !== "vec" || e.items.length !== 3) return null;
  const out: number[] = [];
  for (const x of e.items) {
    if (x.k === "num" && (!x.unit || x.unit === "mm" || x.unit === "deg")) out.push(x.v);
    else if (x.k === "unary" && x.op === "-" && x.arg.k === "num" && (!x.arg.unit || x.arg.unit === "mm" || x.arg.unit === "deg")) out.push(-x.arg.v);
    else return null;
  }
  return out as Vec3;
}

/** at: moved by `by`: summed when it is plain numbers, else written as the old value plus the offset. */
function shiftedAt(src: string, stmt: PartStmt | CompStmt, by: Vec3): string {
  const lit = literalVec(src, stmt, "at");
  if (lit === undefined) return vec(by);
  if (lit) return vec([lit[0] + by[0], lit[1] + by[1], lit[2] + by[2]]);
  const it = propItem(stmt, "at")!;
  const old = src.slice(it.value.span.start, it.value.span.end);
  const wrapped = it.value.k === "binary" || it.value.k === "ternary" ? `(${old})` : old;
  return `${wrapped} + ${vec(by)}`;
}

function mechanismProp(stmt: PartStmt | CompStmt): string | undefined {
  return MECHANISM.find((m) => propItem(stmt, m));
}

const dirWords = (by: Vec3) => {
  const out: string[] = [];
  const names: [string, string][] = [
    ["right", "left"],
    ["back", "forward"],
    ["up", "down"],
  ];
  by.forEach((v, i) => {
    if (Math.abs(v) > 1e-9) out.push(`${mm(Math.abs(v))} ${v > 0 ? names[i][0] : names[i][1]}`);
  });
  return out.join(", ");
};

/** The part another part's body is made from with shape_of() (a mirror image follows its source), if any. */
function followsPart(stmt: PartStmt | CompStmt, src: string): string | undefined {
  if (stmt.k !== "part") return undefined;
  const body = stmt.items.find((it): it is Extract<Item, { k: "op" }> => it.k === "op" && it.op === "body");
  if (!body) return undefined;
  return /\bshape_of\(\s*([A-Za-z_][\w]*)/.exec(src.slice(body.shape.span.start, body.shape.span.end))?.[1];
}

function applyMove(cmd: Extract<QuickCommand, { k: "move" }>, stmt: PartStmt | CompStmt, label: string, ctx: QuickContext): QuickResult {
  const mech = mechanismProp(stmt);
  if (mech) return fail(`${label} is part of a mechanism (${mech}:), so its axis has to move with it.`, true);
  const source = followsPart(stmt, ctx.src);
  if (source) return fail(`${label} is made from ${source} and stays where it is. Move ${source} instead, or change the mirror plane in its steps (features tab).`);
  const src = setBlockProps(ctx.src, stmt.name, { at: shiftedAt(ctx.src, stmt, cmd.by) });
  return { ok: true, src, title: `Moved ${label} ${dirWords(cmd.by)}`, target: stmt.name };
}

type M3 = number[][];
const rad = (d: number) => (d * Math.PI) / 180;
function axisRot(axis: 0 | 1 | 2, deg: number): M3 {
  const c = Math.cos(rad(deg));
  const s = Math.sin(rad(deg));
  if (axis === 0)
    return [
      [1, 0, 0],
      [0, c, -s],
      [0, s, c],
    ];
  if (axis === 1)
    return [
      [c, 0, s],
      [0, 1, 0],
      [-s, 0, c],
    ];
  return [
    [c, -s, 0],
    [s, c, 0],
    [0, 0, 1],
  ];
}
const mul = (a: M3, b: M3): M3 => a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
const apply3 = (m: M3, v: Vec3): Vec3 => [0, 1, 2].map((i) => m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2]) as Vec3;
/** rotate: (rx, ry, rz) as Kerf applies it: about X, then Y, then Z, all about the fixed axes. */
const eulerMatrix = (r: Vec3): M3 => mul(axisRot(2, r[2]), mul(axisRot(1, r[1]), axisRot(0, r[0])));

/** The (rx, ry, rz) that gives this rotation, in Kerf's order. */
export function eulerOf(m: M3): Vec3 {
  const clean = (d: number) => {
    let v = Math.round(d * 1000) / 1000;
    if (v <= -180) v += 360;
    if (v > 180) v -= 360;
    return Object.is(v, -0) ? 0 : v;
  };
  const deg = (r: number) => (r * 180) / Math.PI;
  const sy = -m[2][0];
  if (Math.abs(sy) > 0.999999) {
    const ry = sy > 0 ? 90 : -90;
    return [0, ry, clean(deg(Math.atan2(-m[0][1], m[1][1])))];
  }
  return [clean(deg(Math.atan2(m[2][1], m[2][2]))), clean(deg(Math.asin(sy))), clean(deg(Math.atan2(m[1][0], m[0][0])))];
}

function applyRotate(cmd: Extract<QuickCommand, { k: "rotate" }>, stmt: PartStmt | CompStmt, label: string, ctx: QuickContext): QuickResult {
  const mech = mechanismProp(stmt);
  if (mech) return fail(`${label} is part of a mechanism (${mech}:), so its axis has to turn with it.`, true);
  const source = followsPart(stmt, ctx.src);
  if (source) return fail(`${label} is made from ${source} and stays where it is. Turn ${source} instead.`);
  if (stmt.k === "component" && (propItem(stmt, "axis") || propItem(stmt, "facing") || propItem(stmt, "mesh"))) return fail(`${label} is placed by its axis, so turning it needs its axis changed.`, true);
  const old = literalVec(ctx.src, stmt, "rotate");
  if (old === null) return fail(`${label}'s rotation is worked out from other values.`, true);
  const r0: Vec3 = old ?? [0, 0, 0];
  const R0 = eulerMatrix(r0);
  const R1 = mul(axisRot(cmd.axis, cmd.angle), R0);
  const r1 = eulerOf(R1);
  // turn it where it is: keep the middle of the part in place
  const box = ctx.box?.(stmt.name);
  const props: Record<string, string | null> = { rotate: r1.every((v) => v === 0) ? null : vec(r1, 3) };
  if (box) {
    const c: Vec3 = [0, 1, 2].map((i) => (box[0][i] + box[1][i]) / 2) as Vec3;
    const a = apply3(R0, c);
    const b = apply3(R1, c);
    const shift: Vec3 = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    if (shift.some((v) => Math.abs(v) > 1e-6)) props.at = shiftedAt(ctx.src, stmt, shift.map((v) => Math.round(v * 1000) / 1000) as Vec3);
  }
  const src = setBlockProps(ctx.src, stmt.name, props);
  return { ok: true, src, title: `Turned ${label} ${f(Math.abs(cmd.angle), 1)}° ${cmd.angle < 0 ? "clockwise " : ""}about ${AXES[cmd.axis]}`, target: stmt.name };
}

/** A name for a new block that nothing in the design uses yet: base1, base2… (never the bare word, which could hide a function such as box). */
function freshName(src: string, base: string, from = 1): string {
  const used = (n: string) => new RegExp(`\\b${n}\\b`).test(src);
  for (let i = from; ; i++) if (!used(`${base}${i}`)) return `${base}${i}`;
}

function applyCopy(cmd: Extract<QuickCommand, { k: "copy" }>, stmt: PartStmt | CompStmt, label: string, ctx: QuickContext): QuickResult {
  const mech = mechanismProp(stmt);
  if (mech) return fail(`${label} is part of a mechanism (${mech}:), so a copy needs its own axis and pins.`, true);
  const base = stmt.name.replace(/\d+$/, "") || stmt.name;
  const name = freshName(ctx.src, base, 2);
  let by = cmd.by;
  if (!by) {
    const box = ctx.box?.(stmt.name);
    const w = box ? box[1][0] - box[0][0] : 20;
    by = [Math.ceil(w + 10), 0, 0];
  }
  const text = ctx.src.slice(stmt.span.start, stmt.span.end);
  const nameAt = stmt.nameSpan.start - stmt.span.start;
  const copy = text.slice(0, nameAt) + name + text.slice(nameAt + stmt.name.length);
  // the copy goes right after the original, then moves
  const lineEnd = ctx.src.indexOf("\n", stmt.span.end);
  const at = lineEnd < 0 ? ctx.src.length : lineEnd;
  let src = ctx.src.slice(0, at) + "\n\n" + copy + ctx.src.slice(at);
  const moved = blockStmt(src, name);
  if (!moved) return fail(`Couldn't copy ${label}.`, true);
  src = setBlockProps(src, name, { at: shiftedAt(src, moved, by) });
  return { ok: true, src, title: `Copied ${label} as ${name}, ${dirWords(by)}`, target: name };
}

/** Copies of a block right after the original, in order, each placed by `place(i)`: the props to set on copy i. */
function copiesOf(src: string, stmt: PartStmt | CompStmt, count: number, place: (i: number, s: string, copy: PartStmt | CompStmt) => Record<string, string | null>): { src: string; names: string[] } {
  const base = stmt.name.replace(/\d+$/, "") || stmt.name;
  const text = src.slice(stmt.span.start, stmt.span.end);
  const nameAt = stmt.nameSpan.start - stmt.span.start;
  const names: string[] = [];
  let out = src;
  let after = stmt.name;
  for (let i = 1; i < count; i++) {
    const name = freshName(out, base, 2);
    const prev = blockStmt(out, after)!;
    const lineEnd = out.indexOf("\n", prev.span.end);
    const at = lineEnd < 0 ? out.length : lineEnd;
    out = out.slice(0, at) + "\n\n" + text.slice(0, nameAt) + name + text.slice(nameAt + stmt.name.length) + out.slice(at);
    const copy = blockStmt(out, name)!;
    out = setBlockProps(out, name, place(i, out, copy));
    names.push(name);
    after = name;
  }
  return { src: out, names };
}

function applyPattern(cmd: Extract<QuickCommand, { k: "pattern" }>, stmt: PartStmt | CompStmt, label: string, ctx: QuickContext): QuickResult {
  const mech = mechanismProp(stmt);
  if (mech) return fail(`${label} is part of a mechanism (${mech}:), so each copy needs its own axis and pins.`, true);
  if (followsPart(stmt, ctx.src)) return fail(`${label} is made from another part, so pattern that part instead.`);
  const count = Math.round(cmd.count);
  if (!(count >= 2 && count <= 50)) return fail("A pattern of parts has 2 to 50 copies (the original counts as one). For more, pattern a step inside one part.");
  const atItem = propItem(stmt, "at");
  if (atItem && atItem.value.k === "list") return fail(`${label} is already a pattern of positions.`, true);
  if (cmd.step) {
    const step = cmd.step;
    if (step.every((v) => Math.abs(v) < 1e-9)) return fail("Give the spacing between copies.");
    const { src, names } = copiesOf(ctx.src, stmt, count, (i, s, copy) => ({ at: shiftedAt(s, copy, step.map((v) => Math.round(v * i * 1000) / 1000) as Vec3) }));
    return { ok: true, src, title: `Patterned ${label} ${count} times in a row, ${mm(Math.hypot(...step))} apart (${names.join(", ")})`, target: stmt.name };
  }
  const axis = cmd.axis ?? 2;
  const total = cmd.angle ?? 360;
  if (!(Math.abs(total) > 1e-9 && Math.abs(total) <= 360)) return fail("Give the angle to spread the copies over (360 for all the way round).");
  if (stmt.k === "component" && (propItem(stmt, "axis") || propItem(stmt, "facing") || propItem(stmt, "mesh"))) return fail(`${label} is placed by its axis, so turning copies of it needs their axes changed.`, true);
  const at0 = literalVec(ctx.src, stmt, "at");
  const r0 = literalVec(ctx.src, stmt, "rotate");
  if (at0 === null || r0 === null) return fail(`${label}'s position is worked out from other values, so Kerf can't turn copies of it round an axis. Pattern it in a row, or ask Claude.`, true);
  const full = Math.abs(Math.abs(total) - 360) < 1e-9;
  const each = total / (full ? count : count - 1);
  const c = cmd.center ?? [0, 0, 0];
  const a0: Vec3 = at0 ?? [0, 0, 0];
  const R0 = eulerMatrix(r0 ?? [0, 0, 0]);
  const round3 = (v: Vec3) => v.map((x) => Math.round(x * 1000) / 1000) as Vec3;
  // a copy turned by Ra about the axis through c: rotation Ra·R0, position Ra·(at0 − c) + c
  const { src, names } = copiesOf(ctx.src, stmt, count, (i) => {
    const Ra = axisRot(axis, each * i);
    const r1 = eulerOf(mul(Ra, R0));
    const p = apply3(Ra, [a0[0] - c[0], a0[1] - c[1], a0[2] - c[2]]);
    return { at: vec(round3([p[0] + c[0], p[1] + c[1], p[2] + c[2]])), rotate: r1.every((v) => v === 0) ? null : vec(r1, 3) };
  });
  return { ok: true, src, title: `Patterned ${label} ${count} times round ${AXES[axis]}, ${f(each, 1)}° apart (${names.join(", ")})`, target: stmt.name };
}

const PROP_COPY = ["color", "material", "finish", "process", "group"];

function applyMirror(cmd: Extract<QuickCommand, { k: "mirror" }>, stmt: PartStmt, label: string, color: string, ctx: QuickContext): QuickResult {
  if (followsPart(stmt, ctx.src)) return fail(`${label} is already made from another part; mirror that part instead.`);
  const name = freshName(ctx.src, `${stmt.name}_mirror`);
  const point: Vec3 = [0, 0, 0];
  point[cmd.axis] = cmd.at ?? 0;
  const lines = [`label: "${label.replace(/"/g, "'")} (mirrored)"`];
  for (const k of PROP_COPY) {
    const it = propItem(stmt, k);
    if (it) lines.push(ctx.src.slice(it.span.start, it.span.end));
    else if (k === "color") lines.push(`color: ${color}`);
  }
  lines.push(`body mirror(shape_of(${stmt.name}), normal: ${AXES[cmd.axis]}, at: ${vec(point)})`);
  const block = `// the mirror image of ${stmt.name}: it follows every change to it\npart ${name} {\n${lines.map((l) => `  ${l}`).join("\n")}\n}`;
  const lineEnd = ctx.src.indexOf("\n", stmt.span.end);
  const at = lineEnd < 0 ? ctx.src.length : lineEnd;
  const src = ctx.src.slice(0, at) + "\n\n" + block + ctx.src.slice(at);
  const plane = cmd.axis === 0 ? "YZ" : cmd.axis === 1 ? "XZ" : "XY";
  return { ok: true, src, title: `Mirrored ${label} across the ${plane} plane${cmd.at ? ` at ${AXES[cmd.axis]} = ${mm(cmd.at)}` : ""} as ${name}`, detail: `${name} follows every change to ${label}.`, target: name };
}

function applySubtract(cmd: Extract<QuickCommand, { k: "subtract" }>, stmt: PartStmt, label: string, ctx: QuickContext): QuickResult {
  if (cmd.tool === stmt.name) return fail("Pick a different part to cut out of it.");
  const toolPart = ctx.model.parts.find((p) => p.name === cmd.tool);
  let tool = blockStmt(ctx.src, cmd.tool);
  if (!toolPart || !tool) return fail(`There is no part called ${cmd.tool}.`);
  if (new RegExp(`\\bshape_of\\(\\s*${stmt.name}\\b`).test(ctx.src.slice(tool.span.start, tool.span.end))) return fail(`${toolPart.label} is made from ${label}, so it can't be cut out of it.`);
  let src = ctx.src;
  // the part that is cut comes after the one it is cut by
  if (tool.span.start > stmt.span.start) {
    const start = src.lastIndexOf("\n", stmt.span.start - 1) + 1;
    let end = src.indexOf("\n", stmt.span.end);
    end = end < 0 ? src.length : end + 1;
    const text = src.slice(start, end);
    src = (src.slice(0, start) + src.slice(end)).replace(/\n{3,}/g, "\n\n");
    tool = blockStmt(src, cmd.tool)!;
    let at = src.indexOf("\n", tool.span.end);
    at = at < 0 ? src.length : at;
    src = src.slice(0, at) + "\n\n" + text.replace(/\n$/, "") + src.slice(at);
  }
  const host = blockStmt(src, stmt.name) as PartStmt;
  src = insertItem(src, host, `cut shape_of(${cmd.tool})`, null);
  return { ok: true, src, title: `Cut ${toolPart.label} out of ${label}`, detail: `The cut is exactly ${toolPart.label}'s shape, where it sits, and follows it when it moves or changes. Give it room with a clearance if it has to slide in.`, target: stmt.name };
}

function applyDelete(stmt: PartStmt | CompStmt, label: string, ctx: QuickContext): QuickResult {
  const before = ctx.src.slice(0, stmt.span.start);
  const after = ctx.src.slice(stmt.span.end);
  const others = (before + after).replace(/\/\/[^\n]*/g, "");
  if (new RegExp(`\\b${stmt.name}\\b`).test(others)) return fail(`Other parts of the design refer to ${label}, so they need changing too.`, true);
  // take its whole lines, and the comment lines right above it
  let start = ctx.src.lastIndexOf("\n", stmt.span.start - 1) + 1;
  for (;;) {
    const prevEnd = start - 1;
    if (prevEnd <= 0) break;
    const prevStart = ctx.src.lastIndexOf("\n", prevEnd - 1) + 1;
    if (!/^\s*\/\//.test(ctx.src.slice(prevStart, prevEnd))) break;
    start = prevStart;
  }
  let end = ctx.src.indexOf("\n", stmt.span.end);
  end = end < 0 ? ctx.src.length : end + 1;
  let src = ctx.src.slice(0, start) + ctx.src.slice(end);
  src = src.replace(/\n{3,}/g, "\n\n");
  return { ok: true, src, title: `Deleted ${label}` };
}

function applyParam(cmd: Extract<QuickCommand, { k: "param" }>, ctx: QuickContext): QuickResult {
  const p = ctx.model.params.find((x) => x.name === cmd.name);
  if (!p) return fail(`There is no value called ${cmd.name}.`);
  if (p.locked) return fail(`${p.name} is locked. Unlock it in the parameters panel first.`);
  let value: number | string | boolean;
  if (typeof p.value === "number") {
    if (typeof cmd.value !== "number") return fail(`${p.name} is a number.`);
    value = cmd.op === "add" ? p.value + cmd.value : cmd.op === "mul" ? p.value * cmd.value : cmd.value;
  } else if (typeof p.value === "boolean") {
    if (typeof cmd.value !== "boolean") return fail(`${p.name} is on or off.`);
    value = cmd.value;
  } else {
    if (typeof cmd.value !== "string") return fail(`${p.name} is text.`);
    value = cmd.value;
  }
  const text = formatParamValue(p, value);
  const src = ctx.src.slice(0, p.valueSpan.start) + text + ctx.src.slice(p.valueSpan.end);
  const out = typeof value === "number" ? text : String(value);
  const range = typeof value === "number" && ((p.min !== undefined && value < p.min) || (p.max !== undefined && value > p.max)) ? `That is outside its usual range (${p.min ?? "…"} to ${p.max ?? "…"}).` : undefined;
  return { ok: true, src, title: `Set ${p.name} to ${out}`, detail: range };
}

const NEW_COLORS = ["#3d7bfd", "#e2a93b", "#3fa66b", "#d64541", "#8a5cd6", "#2a9d8f"];

function applyNew(cmd: Extract<QuickCommand, { k: "new" }>, ctx: QuickContext): QuickResult {
  const sz = cmd.size;
  const word = cmd.shape === "box" ? (sz[0] === sz[1] && sz[1] === sz[2] ? "cube" : "box") : cmd.shape;
  const sizeText = cmd.shape === "box" ? `${sz.map((v) => f(v)).join(" × ")} mm` : cmd.shape === "cylinder" ? `⌀${f(sz[0])} × ${f(sz[1])} mm` : `⌀${f(sz[0])} mm`;
  const spot = ctx.spot;
  const host = ctx.target ? blockStmt(ctx.src, ctx.target) : undefined;
  const hostPart = ctx.target ? ctx.model.parts.find((p) => p.name === ctx.target) : undefined;
  // pointing at a part made in this design: the shape joins it, unless "new" was said
  if (cmd.join !== false && spot?.normal && host?.k === "part" && hostPart) {
    if (hostPart.locked) return fail(`${hostPart.label} is locked. Unlock it in the parts list first.`);
    const shape = shapeOn(cmd, spot.local, spot.normal);
    const src = insertItem(ctx.src, host, `add ${shape}`, afterLastAdd(host));
    return { ok: true, src, title: `Added a ${sizeText} ${word} to ${hostPart.label}`, detail: "Say “new box …” for a separate part instead.", target: host.name };
  }
  if (cmd.join && !spot) return fail("Right-click the face it goes on, then say it again.");
  const name = freshName(ctx.src, word);
  let shape: string;
  if (spot?.point && spot.worldNormal) shape = shapeOn(cmd, spot.point, spot.worldNormal);
  else {
    // beside what is already there, standing on the same floor
    const b = ctx.bounds;
    const w = cmd.shape === "box" ? sz[0] : sz[0];
    const empty = !b || ctx.model.parts.length === 0 || !b.flat().every(Number.isFinite);
    const at: Vec3 = empty ? [0, 0, 0] : [Math.ceil(b![1][0] + 10 + w / 2), Math.round((b![0][1] + b![1][1]) / 2), Math.round(b![0][2])];
    shape = cmd.shape === "box" ? `box(${sz.map((v) => f(v)).join(", ")}, at: ${vec(at)})` : cmd.shape === "cylinder" ? `cylinder(d: ${f(sz[0])}, h: ${f(sz[1])}, at: ${vec(at)})` : `sphere(d: ${f(sz[0])}, at: ${vec([at[0], at[1], at[2] + sz[0] / 2])})`;
  }
  const color = NEW_COLORS[ctx.model.parts.length % NEW_COLORS.length];
  const label = word[0].toUpperCase() + word.slice(1);
  const block = `part ${name} {\n  label: "${label}"\n  color: ${color}\n  body ${shape}\n}\n`;
  const src = ctx.src.replace(/\s*$/, "") + "\n\n" + block;
  return { ok: true, src, title: `Added a ${sizeText} ${word} as a new part (${name})`, target: name };
}

/** A shape standing on a face at p, growing out along the face's normal n. */
function shapeOn(cmd: Extract<QuickCommand, { k: "new" }>, p0: Vec3, n: Vec3): string {
  const sz = cmd.size;
  const p = snapOnFace(p0, n);
  const ax = axisName(n);
  if (cmd.shape === "cylinder") return `cylinder(d: ${f(sz[0])}, h: ${f(sz[1])}, at: ${vec(p)}, dir: ${dirText(n)})`;
  if (cmd.shape === "sphere") return `sphere(d: ${f(sz[0])}, at: ${vec([p[0] + (n[0] * sz[0]) / 2, p[1] + (n[1] * sz[0]) / 2, p[2] + (n[2] * sz[0]) / 2])})`;
  // box(w, d, h, at:) stands on the middle of its bottom face: put its middle half its depth out from the face
  const i = ax ? axisIndex(n) : 2;
  const ext = sz[i];
  const c: Vec3 = ax ? [p[0] + (n[0] * ext) / 2, p[1] + (n[1] * ext) / 2, p[2] + (n[2] * ext) / 2] : [p[0], p[1], p[2] + sz[2] / 2];
  return `box(${sz.map((v) => f(v)).join(", ")}, at: ${vec([c[0], c[1], c[2] - sz[2] / 2])})`;
}

/** What a command will do, in a few words, before it runs (for the command field). */
export function describeQuick(cmd: QuickCommand): string {
  switch (cmd.k) {
    case "fillet":
    case "chamfer":
      return `${cmd.k === "fillet" ? "Fillet" : "Chamfer"} ${cmd.edges ? PRESET_TEXT[cmd.edges] : "edges"} · ${mm(cmd.r ?? 1)}`;
    case "shell":
      return `Shell to ${mm(cmd.t ?? 2)} walls${cmd.open === null ? ", closed" : cmd.open && cmd.open !== "here" ? `, open ${FACE_WORD[cmd.open] ?? cmd.open}` : ""}`;
    case "hole":
      return `${cmd.size ?? (cmd.d !== undefined ? `${f(cmd.d)} mm` : "M3")} hole${cmd.through || cmd.depth === undefined ? " through" : `, ${mm(cmd.depth)} deep`}`;
    case "move":
      return `Move ${dirWords(cmd.by)}`;
    case "rotate":
      return `Turn ${f(Math.abs(cmd.angle), 1)}° about ${AXES[cmd.axis]}`;
    case "param":
      return cmd.op === "set" ? `Set ${cmd.name} to ${String(cmd.value)}` : cmd.op === "add" ? `${cmd.name} ${Number(cmd.value) >= 0 ? "+" : "−"}${f(Math.abs(Number(cmd.value)))}` : `${cmd.name} × ${String(cmd.value)}`;
    case "material":
      return `Material: ${cmd.material}`;
    case "color":
      return `Colour: ${cmd.name}`;
    case "copy":
      return cmd.by ? `Copy, ${dirWords(cmd.by)}` : "Copy beside it";
    case "delete":
      return "Delete the part";
    case "new":
      return `New ${cmd.shape} ${cmd.size.map((v) => f(v)).join(" × ")} mm`;
    case "pattern":
      return cmd.step ? `${cmd.count} in a row, ${mm(Math.hypot(...cmd.step))} apart` : `${cmd.count} round ${AXES[cmd.axis ?? 2]}${cmd.angle !== undefined && Math.abs(cmd.angle) !== 360 ? ` over ${f(cmd.angle, 1)}°` : ""}`;
    case "mirror":
      return `Mirror across ${cmd.axis === 0 ? "YZ" : cmd.axis === 1 ? "XZ" : "XY"}${cmd.at ? ` at ${AXES[cmd.axis]} = ${mm(cmd.at)}` : ""}`;
    case "subtract":
      return `Cut ${cmd.tool} out of it`;
    case "undo":
      return "Undo";
    case "redo":
      return "Redo";
  }
}
