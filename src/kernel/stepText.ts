// Reads the parts of a STEP file (ISO 10303-21) that OpenCASCADE's plain
// reader drops: product and instance names, the assembly tree, and colours.
// The geometry itself is read by OpenCASCADE; this only looks at the text.
// STEP files are untrusted, so this is a bounded tokenizer that never
// evaluates anything and keeps only the entity types it needs.

export type StepParam = string | number | StepRef | StepEnum | StepTyped | StepParam[] | null;
export interface StepRef {
  ref: number;
}
export interface StepEnum {
  enum: string;
}
export interface StepTyped {
  typed: string;
  args: StepParam[];
}

export interface StepEntity {
  id: number;
  /** entity type, or the first part's type for a complex entity */
  type: string;
  args: StepParam[];
  /** every part of a complex entity: (A(...) B(...)) */
  parts?: { type: string; args: StepParam[] }[];
}

/** Entity types the structure, naming and colour passes need. Everything else is skipped unparsed. */
const KEEP = new Set([
  "PRODUCT",
  "PRODUCT_DEFINITION_FORMATION",
  "PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE",
  "PRODUCT_DEFINITION",
  "PRODUCT_DEFINITION_WITH_ASSOCIATED_DOCUMENTS",
  "PRODUCT_DEFINITION_SHAPE",
  "SHAPE_DEFINITION_REPRESENTATION",
  "SHAPE_REPRESENTATION",
  "ADVANCED_BREP_SHAPE_REPRESENTATION",
  "MANIFOLD_SURFACE_SHAPE_REPRESENTATION",
  "FACETED_BREP_SHAPE_REPRESENTATION",
  "SHAPE_REPRESENTATION_RELATIONSHIP",
  "NEXT_ASSEMBLY_USAGE_OCCURRENCE",
  "MANIFOLD_SOLID_BREP",
  "BREP_WITH_VOIDS",
  "FACETED_BREP",
  "CLOSED_SHELL",
  "OPEN_SHELL",
  "ORIENTED_CLOSED_SHELL",
  "SHELL_BASED_SURFACE_MODEL",
  "STYLED_ITEM",
  "OVER_RIDING_STYLED_ITEM",
  "PRESENTATION_STYLE_ASSIGNMENT",
  "PRESENTATION_STYLE_BY_CONTEXT",
  "SURFACE_STYLE_USAGE",
  "SURFACE_SIDE_STYLE",
  "SURFACE_STYLE_FILL_AREA",
  "FILL_AREA_STYLE",
  "FILL_AREA_STYLE_COLOUR",
  "COLOUR_RGB",
  "DRAUGHTING_PRE_DEFINED_COLOUR",
  "PRE_DEFINED_COLOUR",
]);

export const SOLID_TYPES = new Set(["MANIFOLD_SOLID_BREP", "BREP_WITH_VOIDS", "FACETED_BREP"]);

/** Files that put more entities than this in their data section are read for geometry only. */
const MAX_ENTITIES = 20_000_000;

class Cursor {
  i = 0;
  constructor(public s: string) {}
}

/** Decode the escapes STEP uses inside strings: '' for a quote, \X2\hhhh…\X0\ for UTF-16, \X\hh and \S\c for Latin-1. */
export function decodeStepString(raw: string): string {
  let out = raw.replace(/''/g, "'");
  out = out.replace(/\\X2\\((?:[0-9A-Fa-f]{4})+)\\X0\\/g, (_, hex: string) => {
    let s = "";
    for (let i = 0; i < hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    return s;
  });
  out = out.replace(/\\X\\([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  out = out.replace(/\\S\\(.)/g, (_, c: string) => String.fromCharCode(c.charCodeAt(0) + 128));
  return out.replace(/\\\\/g, "\\");
}

function skipWs(c: Cursor) {
  const s = c.s;
  for (;;) {
    const ch = s.charCodeAt(c.i);
    if (ch === 32 || ch === 9 || ch === 10 || ch === 13) {
      c.i++;
      continue;
    }
    if (ch === 47 && s.charCodeAt(c.i + 1) === 42) {
      const end = s.indexOf("*/", c.i + 2);
      c.i = end < 0 ? s.length : end + 2;
      continue;
    }
    return;
  }
}

function readString(c: Cursor): string {
  // at the opening quote
  const s = c.s;
  let j = c.i + 1;
  for (;;) {
    const k = s.indexOf("'", j);
    if (k < 0) throw new Error("unterminated string");
    if (s.charCodeAt(k + 1) === 39) {
      j = k + 2;
      continue;
    }
    const raw = s.slice(c.i + 1, k);
    c.i = k + 1;
    return decodeStepString(raw);
  }
}

function readParam(c: Cursor, depth: number): StepParam {
  if (depth > 64) throw new Error("nesting too deep");
  skipWs(c);
  const s = c.s;
  const ch = s[c.i];
  if (ch === "'") return readString(c);
  if (ch === "#") {
    let j = c.i + 1;
    while (j < s.length && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++;
    const ref = Number(s.slice(c.i + 1, j));
    c.i = j;
    return { ref };
  }
  if (ch === "(") return readList(c, depth + 1);
  if (ch === "$" || ch === "*") {
    c.i++;
    return null;
  }
  if (ch === ".") {
    const end = s.indexOf(".", c.i + 1);
    const e = s.slice(c.i + 1, end);
    c.i = end + 1;
    return { enum: e };
  }
  if (ch === '"') {
    // binary: keep as text, unused
    const end = s.indexOf('"', c.i + 1);
    c.i = end + 1;
    return null;
  }
  // number, or a typed parameter such as LENGTH_MEASURE(1.0)
  let j = c.i;
  while (j < s.length && /[A-Za-z0-9_+\-.]/.test(s[j])) j++;
  const word = s.slice(c.i, j);
  c.i = j;
  skipWs(c);
  if (/^[A-Za-z]/.test(word) && s[c.i] === "(") {
    const args = readList(c, depth + 1);
    return { typed: word.toUpperCase(), args };
  }
  const n = Number(word);
  return Number.isFinite(n) ? n : word;
}

function readList(c: Cursor, depth: number): StepParam[] {
  // at "("
  c.i++;
  const out: StepParam[] = [];
  skipWs(c);
  if (c.s[c.i] === ")") {
    c.i++;
    return out;
  }
  for (;;) {
    out.push(readParam(c, depth));
    skipWs(c);
    const ch = c.s[c.i];
    if (ch === ",") {
      c.i++;
      continue;
    }
    if (ch === ")") {
      c.i++;
      return out;
    }
    throw new Error(`unexpected "${ch ?? "end"}" in a parameter list`);
  }
}

/** Index of the ";" that ends the statement starting at i, skipping strings and comments. */
function statementEnd(s: string, i: number): number {
  for (let j = i; j < s.length; j++) {
    const ch = s.charCodeAt(j);
    if (ch === 59) return j;
    if (ch === 39) {
      // string: skip to its closing quote ('' is an escaped quote)
      for (j++; j < s.length; j++) {
        if (s.charCodeAt(j) === 39) {
          if (s.charCodeAt(j + 1) === 39) j++;
          else break;
        }
      }
    } else if (ch === 47 && s.charCodeAt(j + 1) === 42) {
      const end = s.indexOf("*/", j + 2);
      j = end < 0 ? s.length : end + 1;
    }
  }
  return -1;
}

/** Parse the DATA section, keeping only the entity types in `keep`. */
export function parseStepEntities(text: string, keep: Set<string> = KEEP): Map<number, StepEntity> {
  const out = new Map<number, StepEntity>();
  const data = text.search(/\bDATA\s*;/);
  if (data < 0) return out;
  let i = text.indexOf(";", data) + 1;
  let count = 0;
  const head = /\s*#(\d+)\s*=\s*/y;
  while (i < text.length) {
    const end = statementEnd(text, i);
    if (end < 0) break;
    if (++count > MAX_ENTITIES) break;
    head.lastIndex = i;
    const m = head.exec(text);
    if (m) {
      const id = Number(m[1]);
      const c = new Cursor(text);
      c.i = head.lastIndex;
      const s = text;
      try {
        if (s[c.i] === "(") {
          // complex entity: (A(...) B(...))
          c.i++;
          const parts: { type: string; args: StepParam[] }[] = [];
          for (;;) {
            skipWs(c);
            if (s[c.i] === ")") break;
            let j = c.i;
            while (j < end && /[A-Za-z0-9_]/.test(s[j])) j++;
            const type = s.slice(c.i, j).toUpperCase();
            c.i = j;
            skipWs(c);
            if (!type || s[c.i] !== "(") break;
            parts.push({ type, args: readList(c, 1) });
          }
          if (parts.some((p) => keep.has(p.type))) out.set(id, { id, type: parts[0]?.type ?? "", args: parts[0]?.args ?? [], parts });
        } else {
          let j = c.i;
          while (j < end && /[A-Za-z0-9_]/.test(s[j])) j++;
          const type = s.slice(c.i, j).toUpperCase();
          if (keep.has(type)) {
            c.i = j;
            skipWs(c);
            out.set(id, { id, type, args: s[c.i] === "(" ? readList(c, 1) : [] });
          }
        }
      } catch {
        // a malformed entity is skipped; OpenCASCADE decides whether the file is readable
      }
    } else if (/^\s*ENDSEC\b/.test(text.slice(i, i + 20))) break;
    i = end + 1;
  }
  return out;
}

// ---------- structure ----------

export interface StepSolidInfo {
  /** entity id of the solid (MANIFOLD_SOLID_BREP, BREP_WITH_VOIDS or FACETED_BREP) */
  id: number;
  name: string;
  /** name of the product the solid belongs to */
  product: string;
  /** solids of the same product, for "body 2 of 5" style names */
  siblings: number;
  color?: string;
  /** ADVANCED_FACE ids of the outer shell, in file order */
  faces: number[];
}

export interface StepStructure {
  solids: Map<number, StepSolidInfo>;
  faceColors: Map<number, string>;
  /** leaf solids in assembly order, with the instance path that reaches each one */
  instances: { solid: number; path: string[] }[];
  /** name of the top product, when the file names one */
  rootName: string;
  /** names of every product in the file */
  products: string[];
}

const ref = (p: StepParam | undefined): number | undefined => (p && typeof p === "object" && "ref" in p ? p.ref : undefined);
const str = (p: StepParam | undefined): string => (typeof p === "string" ? p : "");
const refs = (p: StepParam | undefined): number[] => (Array.isArray(p) ? (p.map(ref).filter((x) => x !== undefined) as number[]) : []);

/** Names that CAD exporters write when the user gave none. */
const PLACEHOLDER_NAMES = /^(|the product name|open cascade step translator.*|none|unknown|untitled|part|body|solid|product|shape|default|-+|\d+)$/i;

/** Clean a name read from a file before showing it or handing it to Claude. */
export function cleanName(s: string, max = 80): string {
  const t = s
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

const meaningful = (s: string) => {
  const t = cleanName(s);
  return PLACEHOLDER_NAMES.test(t) ? "" : t;
};

function rgbHex(r: number, g: number, b: number) {
  const c = (x: number) =>
    Math.round(Math.max(0, Math.min(1, x)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

const NAMED_COLOURS: Record<string, string> = {
  red: "#ff0000",
  green: "#00ff00",
  blue: "#0000ff",
  yellow: "#ffff00",
  magenta: "#ff00ff",
  cyan: "#00ffff",
  black: "#000000",
  white: "#ffffff",
};

/** Follow a style chain from a STYLED_ITEM to the first colour it names. */
function findColour(ents: Map<number, StepEntity>, start: StepParam[], budget = 40): string | undefined {
  const stack: StepParam[] = [...start];
  const seen = new Set<number>();
  while (stack.length && budget-- > 0) {
    const p = stack.pop()!;
    if (Array.isArray(p)) {
      for (let k = p.length - 1; k >= 0; k--) stack.push(p[k]);
      continue;
    }
    const r = ref(p);
    if (r === undefined || seen.has(r)) continue;
    seen.add(r);
    const e = ents.get(r);
    if (!e) continue;
    if (e.type === "COLOUR_RGB" && e.args.length >= 4) {
      const [, rr, gg, bb] = e.args;
      if (typeof rr === "number" && typeof gg === "number" && typeof bb === "number") return rgbHex(rr, gg, bb);
    }
    if (e.type === "DRAUGHTING_PRE_DEFINED_COLOUR" || e.type === "PRE_DEFINED_COLOUR") {
      const c = NAMED_COLOURS[str(e.args[0]).toLowerCase()];
      if (c) return c;
    }
    for (let k = e.args.length - 1; k >= 0; k--) stack.push(e.args[k]);
  }
  return undefined;
}

export function stepStructure(text: string): StepStructure {
  const ents = parseStepEntities(text);
  const byType = (t: string) => [...ents.values()].filter((e) => e.type === t || e.parts?.some((p) => p.type === t));

  // product of each product definition
  const productName = new Map<number, string>(); // PRODUCT id -> name
  for (const e of byType("PRODUCT")) productName.set(e.id, meaningful(str(e.args[1])) || meaningful(str(e.args[0])));
  const formationProduct = new Map<number, number>();
  for (const e of [...byType("PRODUCT_DEFINITION_FORMATION"), ...byType("PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE")]) {
    const p = ref(e.args[2]);
    if (p !== undefined) formationProduct.set(e.id, p);
  }
  const pdName = new Map<number, string>();
  const pds: number[] = [];
  for (const e of [...byType("PRODUCT_DEFINITION"), ...byType("PRODUCT_DEFINITION_WITH_ASSOCIATED_DOCUMENTS")]) {
    pds.push(e.id);
    const f = ref(e.args[2]);
    const prod = f !== undefined ? formationProduct.get(f) : undefined;
    pdName.set(e.id, prod !== undefined ? productName.get(prod) ?? "" : "");
  }

  // representations that carry geometry for each product definition
  const pdsDef = new Map<number, number>(); // PRODUCT_DEFINITION_SHAPE -> PRODUCT_DEFINITION
  for (const e of byType("PRODUCT_DEFINITION_SHAPE")) {
    const d = ref(e.args[2]);
    if (d !== undefined && pdName.has(d)) pdsDef.set(e.id, d);
  }
  const repPd = new Map<number, number>();
  for (const e of byType("SHAPE_DEFINITION_REPRESENTATION")) {
    const pdsId = ref(e.args[0]);
    const rep = ref(e.args[1]);
    const pd = pdsId !== undefined ? pdsDef.get(pdsId) : undefined;
    if (pd !== undefined && rep !== undefined) repPd.set(rep, pd);
  }
  // plain shape-representation relationships tie a product's shape representation to its geometry
  // (relationships with a transformation place a child in an assembly and are not followed here)
  const links = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    links.set(a, [...(links.get(a) ?? []), b]);
    links.set(b, [...(links.get(b) ?? []), a]);
  };
  for (const e of ents.values()) {
    if (e.type === "SHAPE_REPRESENTATION_RELATIONSHIP" && !e.parts) {
      const a = ref(e.args[2]);
      const b = ref(e.args[3]);
      if (a !== undefined && b !== undefined) link(a, b);
    }
  }
  const geometryOf = new Map<number, number[]>(); // PD -> solid ids in order
  const repItems = (id: number) => {
    const e = ents.get(id);
    return e && /REPRESENTATION$/.test(e.type) ? refs(e.args[1]) : [];
  };
  for (const [rep, pd] of repPd) {
    const seen = new Set<number>([rep]);
    const queue = [rep];
    const solids: number[] = [];
    while (queue.length) {
      const r = queue.shift()!;
      for (const it of repItems(r)) {
        const e = ents.get(it);
        if (e && SOLID_TYPES.has(e.type)) solids.push(it);
      }
      for (const n of links.get(r) ?? []) {
        if (!seen.has(n) && !repPd.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    if (solids.length) geometryOf.set(pd, [...(geometryOf.get(pd) ?? []), ...solids]);
  }

  // faces of each solid's outer shell, for face colours
  const shellFaces = (id: number): number[] => {
    const e = ents.get(id);
    if (!e) return [];
    if (e.type === "ORIENTED_CLOSED_SHELL") return shellFaces(ref(e.args[2]) ?? -1);
    return refs(e.args[1]);
  };

  // colours: a STYLED_ITEM points at the item it styles
  const itemColour = new Map<number, string>();
  for (const e of ents.values()) {
    if (e.type !== "STYLED_ITEM" && e.type !== "OVER_RIDING_STYLED_ITEM") continue;
    const target = ref(e.args[2]);
    if (target === undefined) continue;
    const colour = findColour(ents, [e.args[1]]);
    if (colour && (!itemColour.has(target) || e.type === "OVER_RIDING_STYLED_ITEM")) itemColour.set(target, colour);
  }

  const solids = new Map<number, StepSolidInfo>();
  for (const [pd, list] of geometryOf) {
    list.forEach((sid, k) => {
      const e = ents.get(sid)!;
      const outer = ref(e.args[1]);
      solids.set(sid, {
        id: sid,
        name: meaningful(str(e.args[0])),
        product: pdName.get(pd) ?? "",
        siblings: list.length,
        color: itemColour.get(sid),
        faces: outer !== undefined ? shellFaces(outer) : [],
      });
      void k;
    });
  }
  // solids that no product claims (unusual files) still get their colour and faces
  for (const e of ents.values()) {
    if (!SOLID_TYPES.has(e.type) || solids.has(e.id)) continue;
    const outer = ref(e.args[1]);
    solids.set(e.id, { id: e.id, name: meaningful(str(e.args[0])), product: "", siblings: 1, color: itemColour.get(e.id), faces: outer !== undefined ? shellFaces(outer) : [] });
  }
  const faceColors = new Map<number, string>();
  for (const s of solids.values()) for (const f of s.faces) if (itemColour.has(f)) faceColors.set(f, itemColour.get(f)!);

  // assembly tree: children of each product definition, in file order
  const children = new Map<number, { child: number; name: string }[]>();
  const isChild = new Set<number>();
  for (const e of byType("NEXT_ASSEMBLY_USAGE_OCCURRENCE").sort((a, b) => a.id - b.id)) {
    const parent = ref(e.args[3]);
    const child = ref(e.args[4]);
    if (parent === undefined || child === undefined) continue;
    isChild.add(child);
    const nm = meaningful(str(e.args[1])) || meaningful(str(e.args[5])) || "";
    children.set(parent, [...(children.get(parent) ?? []), { child, name: nm }]);
  }
  const roots = pds.filter((p) => !isChild.has(p)).sort((a, b) => a - b);
  const instances: StepStructure["instances"] = [];
  const visit = (pd: number, path: string[], depth: number) => {
    if (depth > 40 || instances.length > 200_000) return;
    for (const s of geometryOf.get(pd) ?? []) instances.push({ solid: s, path });
    for (const c of children.get(pd) ?? []) visit(c.child, [...path, c.name || pdName.get(c.child) || ""], depth + 1);
  };
  for (const r of roots) visit(r, [], 0);

  return {
    solids,
    faceColors,
    instances,
    rootName: roots.length === 1 ? pdName.get(roots[0]) ?? "" : "",
    products: [...new Set([...pdName.values()].filter(Boolean))],
  };
}
