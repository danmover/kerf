// Semantic PMI in STEP AP242: a part's dimensions, tolerances, fits,
// datums and geometric tolerances (pmi.ts) written into the STEP file the
// kernel exports, tied to the faces they are about, so CAM, inspection and
// other CAD tools read them as data rather than as pictures. The kernel's
// STEP writer has no PMI support, so the entities are added to its text:
// the faces are found by their geometry (planes by normal and offset,
// cylinders by radius and axis) and the PMI follows the CAx-IF recommended
// practice for AP242 (shape aspects with geometric item specific usages,
// dimensional sizes and locations with their representations, plus-minus
// tolerances or limits and fits, datum systems and geometric tolerances).

import { vcross, vdot, vnorm, vsub, type V3 } from "../kernel/recipe";
import type { Fcf, GdtKind } from "./gdt";
import type { PartPmi, PmiDim, PmiPlace, PmiRound, PmiSize } from "./pmi";

// ---------- reading the STEP file ----------

type Arg = string | number | null | Arg[] | { ref: number } | { enum: string } | { typed: string; v: Arg[] };

interface Entity {
  id: number;
  /** a simple entity's name, or the first part of a complex one */
  name: string;
  args: Arg[];
  /** a complex entity's parts, by name */
  parts?: Map<string, Arg[]>;
}

/** Splits the DATA section into its instances, respecting quoted strings. */
function instances(text: string): { body: string; start: number; end: number } {
  const start = text.indexOf("DATA;");
  const end = text.lastIndexOf("ENDSEC;");
  if (start < 0 || end < start) throw new Error("not a STEP file: no DATA section");
  return { body: text.slice(start + 5, end), start: start + 5, end };
}

function parseArgs(s: string, i: number): [Arg[], number] {
  // s[i] is "(", perhaps after spaces
  while (/\s/.test(s[i])) i++;
  const out: Arg[] = [];
  i++;
  for (;;) {
    while (/\s/.test(s[i])) i++;
    if (s[i] === ")") return [out, i + 1];
    const [v, j] = parseValue(s, i);
    out.push(v);
    i = j;
    while (/\s/.test(s[i])) i++;
    if (s[i] === ",") i++;
  }
}

function parseValue(s: string, i: number): [Arg, number] {
  const c = s[i];
  if (c === "'") {
    let j = i + 1;
    let v = "";
    for (;;) {
      if (s[j] === "'" && s[j + 1] === "'") {
        v += "'";
        j += 2;
      } else if (s[j] === "'") break;
      else v += s[j++];
    }
    return [v, j + 1];
  }
  if (c === "#") {
    const m = /^#(\d+)/.exec(s.slice(i, i + 20))!;
    return [{ ref: Number(m[1]) }, i + m[0].length];
  }
  if (c === "(") return parseArgs(s, i);
  if (c === "$" || c === "*") return [null, i + 1];
  if (c === ".") {
    const j = s.indexOf(".", i + 1);
    return [{ enum: s.slice(i + 1, j) }, j + 1];
  }
  const m = /^[A-Z_][A-Z0-9_]*/.exec(s.slice(i, i + 80));
  if (m) {
    const [v, j] = parseArgs(s, i + m[0].length);
    return [{ typed: m[0], v }, j];
  }
  const n = /^[-+]?[0-9.]+(E[-+]?\d+)?/i.exec(s.slice(i, i + 40))!;
  return [Number(n[0]), i + n[0].length];
}

function parseEntity(id: number, body: string): Entity | null {
  const b = body.trim();
  if (b.startsWith("(")) {
    // a complex instance: ( A(..) B(..) )
    const parts = new Map<string, Arg[]>();
    let i = 1;
    for (;;) {
      while (/\s/.test(b[i])) i++;
      if (b[i] === ")" || i >= b.length) break;
      const m = /^[A-Z_][A-Z0-9_]*/.exec(b.slice(i, i + 80));
      if (!m) break;
      const [args, j] = parseArgs(b, i + m[0].length);
      parts.set(m[0], args);
      i = j;
    }
    const first = [...parts.keys()][0] ?? "";
    return { id, name: first, args: parts.get(first) ?? [], parts };
  }
  const m = /^([A-Z_][A-Z0-9_]*)\s*/.exec(b);
  if (!m) return null;
  const [args] = parseArgs(b, m[0].length);
  return { id, name: m[1], args };
}

/** Every instance of the file by id, parsed only for the entity names asked for. */
function readEntities(body: string, wanted: (name: string) => boolean): { ents: Map<number, Entity>; maxId: number } {
  const ents = new Map<number, Entity>();
  let maxId = 0;
  const re = /#(\d+)\s*=\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const id = Number(m[1]);
    maxId = Math.max(maxId, id);
    // the instance runs to the first ";" outside a string
    let i = re.lastIndex;
    let q = false;
    for (; i < body.length; i++) {
      const c = body[i];
      if (c === "'") q = !q;
      else if (c === ";" && !q) break;
    }
    const text = body.slice(re.lastIndex, i);
    re.lastIndex = i + 1;
    const name = /^\s*\(?\s*([A-Z_][A-Z0-9_]*)/.exec(text)?.[1] ?? "";
    const complex = text.trimStart().startsWith("(");
    if (complex || wanted(name)) {
      const e = parseEntity(id, text.replace(/\s+/g, " "));
      if (e) ents.set(id, e);
    }
  }
  return { ents, maxId };
}

const WANTED = new Set([
  "PRODUCT",
  "PRODUCT_DEFINITION_FORMATION",
  "PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE",
  "PRODUCT_DEFINITION",
  "PRODUCT_DEFINITION_SHAPE",
  "SHAPE_DEFINITION_REPRESENTATION",
  "ADVANCED_BREP_SHAPE_REPRESENTATION",
  "SHAPE_REPRESENTATION",
  "SHAPE_REPRESENTATION_RELATIONSHIP",
  "MANIFOLD_SOLID_BREP",
  "BREP_WITH_VOIDS",
  "CLOSED_SHELL",
  "OPEN_SHELL",
  "ORIENTED_CLOSED_SHELL",
  "SHELL_BASED_SURFACE_MODEL",
  "ADVANCED_FACE",
  "PLANE",
  "CYLINDRICAL_SURFACE",
  "AXIS2_PLACEMENT_3D",
  "CARTESIAN_POINT",
  "DIRECTION",
]);

const ref = (a: Arg | undefined): number | undefined => (a && typeof a === "object" && "ref" in a ? a.ref : undefined);
const refs = (a: Arg | undefined): number[] => (Array.isArray(a) ? a.map(ref).filter((x): x is number => x !== undefined) : []);

/** A face of a part, as far as matching PMI needs it. */
type Face = { id: number; t: "plane"; n: V3; p: V3 } | { id: number; t: "cyl"; at: V3; dir: V3; r: number };

interface StepPart {
  /** the product's id string (Kerf writes the part's instance id) */
  name: string;
  pds: number;
  rep: number;
  ctx: number;
  mm?: number;
  faces: Face[];
}

function stepParts(ents: Map<number, Entity>): StepPart[] {
  const point = (id: number | undefined): V3 | undefined => {
    const e = id !== undefined ? ents.get(id) : undefined;
    const c = e?.args[1];
    return Array.isArray(c) && c.length === 3 ? (c as number[]) as V3 : undefined;
  };
  const placement = (id: number | undefined) => {
    const e = id !== undefined ? ents.get(id) : undefined;
    if (!e || e.name !== "AXIS2_PLACEMENT_3D") return undefined;
    const p = point(ref(e.args[1]));
    const z = ref(e.args[2]) !== undefined ? point(ref(e.args[2])) : ([0, 0, 1] as V3);
    return p && z ? { p, z: vnorm(z) } : undefined;
  };
  const faceOf = (id: number): Face | undefined => {
    const f = ents.get(id);
    if (!f || f.name !== "ADVANCED_FACE") return undefined;
    const s = ents.get(ref(f.args[2]) ?? -1);
    if (!s) return undefined;
    const pl = placement(ref(s.args[1]));
    if (!pl) return undefined;
    if (s.name === "PLANE") {
      const same = (f.args[3] as { enum: string } | undefined)?.enum !== "F";
      return { id, t: "plane", n: same ? pl.z : (pl.z.map((c) => -c) as V3), p: pl.p };
    }
    if (s.name === "CYLINDRICAL_SURFACE" && typeof s.args[2] === "number") return { id, t: "cyl", at: pl.p, dir: pl.z, r: s.args[2] };
    return undefined;
  };
  // faces under a representation's items
  const facesUnder = (items: number[]): Face[] => {
    const out: Face[] = [];
    const seen = new Set<number>();
    const stack = [...items];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const e = ents.get(id);
      if (!e) continue;
      if (e.name === "MANIFOLD_SOLID_BREP") stack.push(...refs([e.args[1]]));
      else if (e.name === "BREP_WITH_VOIDS") stack.push(...refs([e.args[1]]), ...refs(e.args[2]));
      else if (e.name === "CLOSED_SHELL" || e.name === "OPEN_SHELL") stack.push(...refs(e.args[1]));
      else if (e.name === "ORIENTED_CLOSED_SHELL") stack.push(...refs([e.args[2]]));
      else if (e.name === "SHELL_BASED_SURFACE_MODEL") stack.push(...refs(e.args[1]));
      else if (e.name === "ADVANCED_FACE") {
        const f = faceOf(id);
        if (f) out.push(f);
      }
    }
    return out;
  };
  const byName = (n: string) => [...ents.values()].filter((e) => e.name === n);
  const out: StepPart[] = [];
  for (const sdr of byName("SHAPE_DEFINITION_REPRESENTATION")) {
    const pds = ref(sdr.args[0]);
    let rep = ref(sdr.args[1]);
    const pdsE = pds !== undefined ? ents.get(pds) : undefined;
    const pd = pdsE && ents.get(ref(pdsE.args[2]) ?? -1);
    const pdf = pd && ents.get(ref(pd.args[2]) ?? -1);
    const prod = pdf && ents.get(ref(pdf.args[2]) ?? -1);
    if (!pdsE || !prod || prod.name !== "PRODUCT" || rep === undefined) continue;
    let repE = ents.get(rep);
    // a plain shape representation pointing at the B-rep one
    if (repE && repE.name !== "ADVANCED_BREP_SHAPE_REPRESENTATION") {
      const rel = byName("SHAPE_REPRESENTATION_RELATIONSHIP").find((r) => ref(r.args[2]) === rep || ref(r.args[3]) === rep);
      const other = rel && [ref(rel.args[2]), ref(rel.args[3])].find((x) => x !== rep && ents.get(x ?? -1)?.name === "ADVANCED_BREP_SHAPE_REPRESENTATION");
      if (other !== undefined) {
        rep = other;
        repE = ents.get(other);
      }
    }
    if (!repE) continue;
    const ctx = ref(repE.args[2]);
    const ctxE = ctx !== undefined ? ents.get(ctx) : undefined;
    const units = ctxE?.parts?.get("GLOBAL_UNIT_ASSIGNED_CONTEXT");
    const mm = refs(units?.[0]).find((u) => ents.get(u)?.parts?.has("LENGTH_UNIT"));
    if (ctx === undefined) continue;
    out.push({ name: String(prod.args[0]), pds: pds!, rep, ctx, mm, faces: facesUnder(refs(repE.args[1])) });
  }
  return out;
}

// ---------- matching PMI to faces ----------

const TOL = 0.02;
const parallel = (a: V3, b: V3) => Math.abs(vdot(vnorm(a), vnorm(b))) > 0.9995;

/** Distance from a point to a line through `at` along unit `dir`. */
function lineDist(p: V3, at: V3, dir: V3): number {
  const d = vsub(p, at);
  const c = vcross(d, dir);
  return Math.hypot(c[0], c[1], c[2]);
}

/** The faces of each round feature: cylinders of that radius on each axis. */
function roundFaces(faces: Face[], r: PmiRound): number[][] {
  return r.centres.map((c) =>
    faces.filter((f) => f.t === "cyl" && Math.abs(f.r - r.r) < TOL && parallel(f.dir, r.dir) && lineDist(c, f.at, vnorm(f.dir)) < TOL).map((f) => f.id),
  ).filter((g) => g.length);
}

/** The faces at one end of a distance: planes square to it there, else holes and bosses whose axis crosses there. */
function placeFaces(faces: Face[], at: PmiPlace): number[] {
  const w = vnorm(at.w);
  const planes = faces.filter((f) => f.t === "plane" && parallel(f.n, w) && Math.abs(vdot(f.p, w) - at.c) < TOL).map((f) => f.id);
  if (planes.length) return planes;
  // an axis across the dimension: all faces of the one round feature nearest
  const cyls = faces.filter((f): f is Extract<Face, { t: "cyl" }> => f.t === "cyl" && Math.abs(vdot(vnorm(f.dir), w)) < 1e-3 && Math.abs(vdot(f.at, w) - at.c) < TOL);
  if (!cyls.length) return [];
  const first = cyls[0];
  return cyls.filter((f) => Math.abs(f.r - first.r) < TOL && lineDist(f.at, first.at, vnorm(first.dir)) < TOL).map((f) => f.id);
}

function planeFaces(faces: Face[], n: V3, p: V3): number[] {
  const u = vnorm(n);
  return faces.filter((f) => f.t === "plane" && vdot(f.n, u) > 0.9995 && Math.abs(vdot(f.p, u) - vdot(p, u)) < TOL).map((f) => f.id);
}

// ---------- writing ----------

const STEP_TOLERANCE: Record<GdtKind, string> = {
  position: "POSITION_TOLERANCE",
  flatness: "FLATNESS_TOLERANCE",
  perpendicularity: "PERPENDICULARITY_TOLERANCE",
  parallelism: "PARALLELISM_TOLERANCE",
  runout: "CIRCULAR_RUNOUT_TOLERANCE",
  coaxiality: "COAXIALITY_TOLERANCE",
  profile: "SURFACE_PROFILE_TOLERANCE",
};
/** tolerances that always refer to datums in AP242 (subtypes of geometric_tolerance_with_datum_reference) */
const NEEDS_DATUMS = new Set<GdtKind>(["perpendicularity", "parallelism", "runout", "coaxiality"]);

const str = (s: string) => `'${s.replace(/'/g, "''").replace(/[^\x20-\x7e]/g, (c) => ({ "Ø": "DIA ", "×": "x", "±": "+/-", "°": "deg" })[c] ?? "")}'`;
const num = (n: number) => {
  const s = String(Math.round(n * 1e6) / 1e6);
  return s.includes(".") || s.includes("e") ? s.toUpperCase() : `${s}.`;
};

export interface StepPmiReport {
  /** per part: annotations written and those whose faces could not be found */
  parts: { part: string; written: number; missed: string[] }[];
}

/**
 * The STEP text with each part's PMI added. Parts are matched to the file's
 * products by name (Kerf names products after part instance ids).
 */
export function addStepPmi(text: string, pmi: PartPmi[]): { text: string; report: StepPmiReport } {
  const { body, end } = instances(text);
  const { ents, maxId } = readEntities(body, (n) => WANTED.has(n));
  const parts = stepParts(ents);
  let next = maxId + 1;
  const lines: string[] = [];
  const add = (s: string) => {
    const id = next++;
    lines.push(`#${id}=${s};`);
    return id;
  };
  const report: StepPmiReport = { parts: [] };

  for (const p of pmi) {
    const sp = parts.find((x) => x.name === p.part) ?? parts.find((x) => x.name === p.name);
    if (!sp) continue;
    const done = { part: p.part, written: 0, missed: [] as string[] };
    report.parts.push(done);
    if (sp.mm === undefined) {
      done.missed.push("the file has no length unit");
      continue;
    }
    const mm = sp.mm;
    const of = `#${sp.pds}`;
    // a shape aspect for one feature, tied to its faces
    const aspect = (name: string, faces: number[], kind = "SHAPE_ASPECT") => {
      const a = add(`${kind}(${str(name)},'',${of},.T.)`);
      for (const f of faces) add(`GEOMETRIC_ITEM_SPECIFIC_USAGE('','',#${a},#${sp.rep},#${f})`);
      return a;
    };
    // a pattern: one aspect per feature, grouped
    const feature = (name: string, groups: number[][]) => {
      if (groups.length === 1) return aspect(name, groups[0]);
      const g = add(`COMPOSITE_GROUP_SHAPE_ASPECT(${str(name)},'',${of},.T.)`);
      groups.forEach((faces, i) => add(`SHAPE_ASPECT_RELATIONSHIP('','',#${g},#${aspect(`${name} ${i + 1}`, faces)})`));
      return g;
    };
    const measure = (v: number, name: string) => add(`( LENGTH_MEASURE_WITH_UNIT() MEASURE_REPRESENTATION_ITEM() MEASURE_WITH_UNIT(LENGTH_MEASURE(${num(v)}),#${mm}) REPRESENTATION_ITEM(${str(name)}) )`);
    const valueRep = (v: number) => add(`SHAPE_DIMENSION_REPRESENTATION('',(#${measure(v, "nominal value")}),#${sp.ctx})`);
    const tolerance = (dim: number, d: { basic?: boolean; fit?: string; tol?: [number, number] }) => {
      if (d.basic) return;
      if (d.fit) {
        const m = /^([A-Za-z]+)(\d+)$/.exec(d.fit.trim());
        if (m) {
          const hole = m[1][0] === m[1][0].toUpperCase();
          add(`PLUS_MINUS_TOLERANCE(#${add(`LIMITS_AND_FITS(${str(m[1])},${str(hole ? "hole" : "shaft")},${str(m[2])},'ISO 286-1')`)},#${dim})`);
          return;
        }
      }
      if (d.tol) {
        const [up, lo] = d.tol;
        add(`PLUS_MINUS_TOLERANCE(#${add(`TOLERANCE_VALUE(#${measure(lo, "lower limit")},#${measure(up, "upper limit")})`)},#${dim})`);
      }
    };

    // datums: a datum feature on each face, its datum, and a datum system per frame
    const datumIds = new Map<string, number>();
    const datumFeature = (letter: string, faces: number[]) => {
      const df = aspect(`datum feature ${letter}`, faces, "DATUM_FEATURE");
      const dt = add(`DATUM('','',${of},.F.,${str(letter)})`);
      add(`SHAPE_ASPECT_RELATIONSHIP('','',#${df},#${dt})`);
      datumIds.set(letter, dt);
      return df;
    };
    const datumAspects = new Map<string, number>();
    for (const d of p.datums) {
      const faces = planeFaces(sp.faces, d.n, d.p);
      if (!faces.length) {
        done.missed.push(`datum ${d.letter}`);
        continue;
      }
      datumAspects.set(d.letter, datumFeature(d.letter, faces));
      done.written++;
    }
    // each round feature's faces, a size at a time (a stacked callout has several)
    type Sized = { size: PmiSize; groups: number[][] };
    const sized = new Map<PmiDim, Sized[]>();
    for (const d of p.dims) {
      if (d.kind !== "size" || !d.round) continue;
      const sizes = d.sizes ?? [{ r: d.round.r, fit: d.fit, tol: d.tol }];
      sized.set(d, sizes.map((size) => ({ size, groups: roundFaces(sp.faces, { ...d.round!, r: size.r }) })));
    }
    /** the size a stacked callout's frames and datum belong to: the one with a fit (the seat), else the first */
    const mainSize = (list: Sized[]) => list.find((x) => x.size.fit && x.groups.length) ?? list.find((x) => x.groups.length);
    const distanceFaces = new Map<PmiDim, [number[], number[]]>();
    for (const d of p.dims) if (d.kind === "distance" && d.ends) distanceFaces.set(d, [placeFaces(sp.faces, d.ends[0]), placeFaces(sp.faces, d.ends[1])]);
    // datum features of size: a bore, a boss, or the two faces of a width
    for (const d of p.dims) {
      if (!d.datum || datumIds.has(d.datum)) continue;
      const m = sized.get(d) && mainSize(sized.get(d)!);
      const ends = distanceFaces.get(d);
      const faces = m ? m.groups.flat() : ends && ends[0].length && ends[1].length ? [...ends[0], ...ends[1]] : [];
      if (faces.length) {
        datumAspects.set(d.datum, datumFeature(d.datum, faces));
        done.written++;
      } else done.missed.push(`datum ${d.datum}`);
    }
    const systems = new Map<string, number>();
    const system = (letters: string[]) => {
      const key = letters.join(" ");
      if (systems.has(key)) return systems.get(key)!;
      const comps = letters.map((l) => datumIds.get(l)).filter((x): x is number => x !== undefined).map((dt) => add(`DATUM_REFERENCE_COMPARTMENT('','',${of},.F.,#${dt},$)`));
      if (comps.length !== letters.length || !comps.length) return undefined;
      const id = add(`DATUM_SYSTEM('','',${of},.F.,(${comps.map((c) => `#${c}`).join(",")}))`);
      systems.set(key, id);
      return id;
    };
    const frame = (f: Fcf, target: number) => {
      const mag = add(`LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(${num(f.tol)}),#${mm})`);
      const ds = f.datums.length ? system(f.datums) : undefined;
      // a frame whose datums are not all in the file is left out rather than written without them
      if ((f.datums.length || NEEDS_DATUMS.has(f.kind)) && ds === undefined) return false;
      const partsOf: [string, string][] = [
        ["GEOMETRIC_TOLERANCE", `${str(f.kind)},'',#${mag},#${target}`],
        [STEP_TOLERANCE[f.kind], f.kind === "runout" ? "$" : ""],
      ];
      if (ds !== undefined) partsOf.push(["GEOMETRIC_TOLERANCE_WITH_DATUM_REFERENCE", `(#${ds})`]);
      if (f.mmc) partsOf.push(["GEOMETRIC_TOLERANCE_WITH_MODIFIERS", "(.MAXIMUM_MATERIAL_REQUIREMENT.)"]);
      let gt: number;
      if (partsOf.length === 2 && f.kind !== "runout") gt = add(`${STEP_TOLERANCE[f.kind]}(${partsOf[0][1]})`);
      else gt = add(`( ${partsOf.sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([n, a]) => `${n}(${a})`).join(" ")} )`);
      if (f.dia) add(`TOLERANCE_ZONE('','',${of},.F.,(#${gt}),#${add("TOLERANCE_ZONE_FORM('cylindrical or circular')")})`);
      return true;
    };
    for (const d of p.datums) {
      const a = datumAspects.get(d.letter);
      if (d.frame && a !== undefined) {
        if (frame(d.frame, a)) done.written++;
        else done.missed.push(`${d.frame.kind} of datum ${d.letter}`);
      }
    }

    for (const d of p.dims) {
      const list = sized.get(d);
      if (list) {
        const main = mainSize(list);
        if (!main) {
          done.missed.push(d.text);
          continue;
        }
        let target = 0;
        for (const x of list) {
          if (!x.groups.length) {
            done.missed.push(`Ø${num(2 * x.size.r)} of ${d.text}`);
            continue;
          }
          const isMain = x === main;
          const aspectId = isMain && d.datum && datumAspects.has(d.datum) ? datumAspects.get(d.datum)! : feature(list.length > 1 ? `DIA ${num(2 * x.size.r)} of ${d.text}` : d.text, x.groups);
          if (isMain) target = aspectId;
          const dim = add(`DIMENSIONAL_SIZE(#${aspectId},'diameter')`);
          add(`DIMENSIONAL_CHARACTERISTIC_REPRESENTATION(#${dim},#${valueRep(2 * x.size.r)})`);
          tolerance(dim, { basic: d.basic, fit: x.size.fit, tol: x.size.tol });
          done.written++;
        }
        for (const f of d.frames) {
          if (frame(f, target)) done.written++;
          else done.missed.push(`${f.kind} of ${d.text}`);
        }
      } else if (d.kind === "distance" && d.ends) {
        const [fa, fb] = distanceFaces.get(d)!;
        if (!fa.length || !fb.length) {
          done.missed.push(d.text);
          continue;
        }
        let dim: number;
        let target: number;
        if (d.datum && datumAspects.has(d.datum)) {
          // a width that is itself a datum feature: a size of that feature
          target = datumAspects.get(d.datum)!;
          dim = add(`DIMENSIONAL_SIZE(#${target},'width')`);
        } else {
          const [aa, ab] = [aspect(`${d.label} (from)`, fa), aspect(`${d.label} (to)`, fb)];
          target = ab;
          dim = add(`DIMENSIONAL_LOCATION('linear distance','',#${aa},#${ab})`);
        }
        add(`DIMENSIONAL_CHARACTERISTIC_REPRESENTATION(#${dim},#${valueRep(d.value)})`);
        tolerance(dim, d);
        done.written++;
        for (const f of d.frames) {
          if (frame(f, target)) done.written++;
          else done.missed.push(`${f.kind} of ${d.text}`);
        }
      }
    }
  }
  if (!lines.length) return { text, report };
  // the new instances go at the end of the DATA section
  return { text: text.slice(0, end) + lines.join("\n") + "\n" + text.slice(end), report };
}

/** Every #reference in the DATA section points at an instance, and no id is used twice (a check for tests). */
export function stepIntegrity(text: string): { ok: boolean; problems: string[] } {
  const { body } = instances(text);
  const ids = new Map<number, number>();
  for (const m of body.matchAll(/(?:^|;)\s*#(\d+)\s*=/g)) ids.set(Number(m[1]), (ids.get(Number(m[1])) ?? 0) + 1);
  const problems: string[] = [];
  for (const [id, n] of ids) if (n > 1) problems.push(`#${id} is defined ${n} times`);
  const noStrings = body.replace(/'(?:[^']|'')*'/g, "''");
  for (const m of noStrings.matchAll(/#(\d+)/g)) if (!ids.has(Number(m[1]))) problems.push(`#${m[1]} is used but never defined`);
  return { ok: !problems.length, problems: [...new Set(problems)].slice(0, 20) };
}

/** Counts of the PMI entities in a STEP file, by name (for tests and the export summary). */
export function stepPmiCounts(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of ["DIMENSIONAL_SIZE", "DIMENSIONAL_LOCATION", "PLUS_MINUS_TOLERANCE", "LIMITS_AND_FITS", "DATUM", "DATUM_FEATURE", "DATUM_SYSTEM", "GEOMETRIC_ITEM_SPECIFIC_USAGE", "TOLERANCE_ZONE", ...Object.values(STEP_TOLERANCE)]) {
    out[n] = (text.match(new RegExp(`[=( ]${n}\\(`, "g")) ?? []).length;
  }
  return out;
}
