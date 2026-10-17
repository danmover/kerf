// The build pack: everything needed to order, make, wire, program and test a
// machine, generated from the design. These are pure functions of the model
// so they run in Node too; geometry (part meshes, the STEP file) is handed in
// by the caller, which gets it from the kernel.

import { assembleReport, type CheckItem, type CheckReport } from "../core/checks";
import type { EvalPart, Model } from "../core/model";
import type { MeshData } from "../kernel/build";
import { xformMatrix } from "../kernel/recipe";
import { fmtNum } from "../lang/values";
import { materialDensity } from "../library/standards";
import { bomRows, bomTotal, writeStl, type BomRow } from "../persist/files";
import { catalogPart } from "./catalog";
import { boardPackFiles, boardWord, routeBoards, type BoardFolder } from "./boardPack";
import { buildNetlist, netLabel } from "./erc";
import { generateFirmware, type FirmwareOutput } from "./firmware";
import type { RoutedBoard } from "./pcb";
import { serviceMd, servicePlan, type UseFacts } from "./service";
import type { CalcLine, CalcTrace, CatalogKind, CatalogPart, MachineData } from "./types";
import { componentPositions, csvCell, wireList, wiresCsv, wiringDiagram, type WireRow } from "./wiring";

export interface PackFile {
  path: string;
  data: string | Uint8Array;
}

export interface PackOptions {
  /** the project name, used in titles (defaults to the design name) */
  name?: string;
  /** a part's mesh in its own frame (before its placement), for STL files of printed and made parts */
  meshFor?: (part: EvalPart) => MeshData | undefined;
  /** STEP of the assembly */
  step?: ArrayBuffer | Uint8Array;
  /** generated firmware, if the caller already has it */
  firmware?: FirmwareOutput[];
  /** finished routes of the design's circuit boards (the app's board runtime has them); boards without one are routed here */
  boards?: RoutedBoard[];
  /** what the machine's simulated job measured, for the service lives in runs */
  use?: UseFacts;
  date?: Date;
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const money = (n: number) => `$${n.toFixed(2)}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const sentence = (s: string) => {
  const t = cap(s.trim());
  return /[.!?]$/.test(t) ? t : t + ".";
};
const listJoin = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const mdCell = (s: string | number | undefined) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const fileSafe = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "part";
const fmtDate = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
const pos = (p: EvalPart): [number, number, number] => {
  const m = xformMatrix(p.xf);
  return [m[12], m[13], m[14]];
};
const fmtPos = (v: number[]) => `(${v.map((x) => fmtNum(Math.round(x * 10) / 10)).join(", ")})`;

// ---------------------------------------------------------------- checks and readiness

/** The check items to report: the live report when there is one, else the checks that need no geometry kernel. */
export function checkItems(model: Model, report: CheckReport | null): CheckItem[] {
  if (report) return report.items;
  return assembleReport(model).items;
}

const CATEGORY_NOUN: Record<string, [string, string]> = {
  electrical: ["wiring check", "wiring checks"],
  engineering: ["calculation check", "calculation checks"],
  requirement: ["requirement", "requirements"],
  interference: ["interference check", "interference checks"],
  access: ["tool access check", "tool access checks"],
  motion: ["motion check", "motion checks"],
  gears: ["gear check", "gear checks"],
  process: ["manufacturing check", "manufacturing checks"],
  assembly: ["assembly check", "assembly checks"],
  build: ["build check", "build checks"],
  testing: ["test check", "test checks"],
  info: ["check", "checks"],
};

export const CATEGORY_LABEL: Record<string, string> = {
  requirement: "Requirements",
  interference: "Interference",
  access: "Tool access",
  motion: "Motion",
  gears: "Gears",
  process: "Manufacturing",
  assembly: "Assembly",
  build: "Build",
  electrical: "Wiring",
  engineering: "Calculations",
  simulation: "Simulations",
  testing: "Physical tests",
  info: "Needs analysis",
};

export interface Readiness {
  level: "ready" | "review" | "blocked";
  /** one sentence, e.g. "Not ready: 2 wiring checks fail." */
  headline: string;
  /** what to do next */
  detail: string;
  fails: CheckItem[];
  warns: CheckItem[];
  pending: number;
  /** physical tests in the test plan that must pass before relying on the machine */
  tests: number;
  electrical: { fail: number; warn: number };
  engineering: { fail: number; warn: number };
}

export function readiness(model: Model, items: CheckItem[], plan: PlanItem[]): Readiness {
  const fails = items.filter((i) => i.status === "fail");
  const warns = items.filter((i) => i.status === "warn");
  const pending = items.filter((i) => i.status === "pending").length;
  const tests = plan.filter((t) => t.required).length;
  const count = (cat: string, st: string) => items.filter((i) => i.category === cat && i.status === st).length;
  const testLine = tests ? `${tests === 1 ? "1 thing needs" : `${tests} things need`} a physical test before you rely on it.` : "";
  const errors = model.diagnostics.filter((d) => d.severity === "error").length;
  let level: Readiness["level"];
  let headline: string;
  let detail: string;
  if (fails.length) {
    level = "blocked";
    const byCat = new Map<string, number>();
    for (const f of fails) byCat.set(f.category, (byCat.get(f.category) ?? 0) + 1);
    const parts = [...byCat].map(([cat, n]) => {
      const [one, many] = CATEGORY_NOUN[cat] ?? ["check", "checks"];
      return `${n} ${n === 1 ? one : many}`;
    });
    headline = errors ? `Not ready: the design has ${plural(errors, "source error")}.` : `Not ready: ${listJoin(parts)} ${fails.length === 1 ? "fails" : "fail"}.`;
    detail = `Fix ${fails.length === 1 ? "it" : "them"} in Kerf before ordering parts: the fix may change what you need to buy.`;
  } else if (warns.length) {
    level = "review";
    headline = `Ready to order and build once you have reviewed ${plural(warns.length, "warning")}.`;
    detail = testLine;
  } else {
    level = "ready";
    headline = "Ready to order and build.";
    detail = testLine;
  }
  if (pending) detail = `${detail} ${plural(pending, "check")} could not be measured yet.`.trim();
  return { level, headline, detail, fails, warns, pending, tests, electrical: { fail: count("electrical", "fail"), warn: count("electrical", "warn") }, engineering: { fail: count("engineering", "fail"), warn: count("engineering", "warn") } };
}

// ---------------------------------------------------------------- test plan

export interface PlanItem {
  title: string;
  source: "design" | "calculation" | "part";
  /** what to do */
  steps: string;
  /** what counts as a pass, when the text says */
  pass?: string;
  /** values to compare against, from a calculation */
  expected?: string[];
  /** components it applies to */
  parts?: string[];
  /** must pass before relying on the machine (rough calculations, part tests, the design's own tests) */
  required: boolean;
}

const CRITERION = /\b(must|should|stays?|below|under|above|over|at least|at most|no more than|less than|more than|within|exceeds?|not exceed|keeps?|survives?)\b|[<>≤≥±]/i;

/** Splits a test into the steps and the pass criterion, when the wording allows. */
export function splitTest(text: string): { steps: string; pass?: string } {
  const t = text.trim().replace(/\s+/g, " ");
  const clauses = t.split(/;\s+|\.\s+(?=[A-Z])/).map((s) => s.replace(/\.$/, "").trim()).filter(Boolean);
  if (clauses.length > 1) {
    const pass = clauses.filter((c) => CRITERION.test(c));
    const steps = clauses.filter((c) => !CRITERION.test(c));
    if (pass.length && steps.length) return { steps: sentence(steps.join(". ")), pass: sentence(pass.join(". ")) };
  }
  const m = t.replace(/\.$/, "").match(/^(.*?),?\s+and (?:then )?(?:check|make sure|confirm|verify)(?: that)?\s+(.*)$/i);
  if (m && CRITERION.test(m[2])) return { steps: sentence(m[1]), pass: sentence(m[2]) };
  return { steps: sentence(t) };
}

const calcLine = (l: CalcLine) => `${l.label}: ${fmtNum(l.value)}${l.unit ? ` ${l.unit}` : ""}`;

export function testPlan(m: MachineData): PlanItem[] {
  const out: PlanItem[] = [];
  // bench checks of individual parts come first: some must happen before anything is connected
  const byPart = new Map<string, { part: CatalogPart; comps: string[] }>();
  for (const c of m.components) {
    const p = catalogPart(c.catalogId);
    if (!p?.tests?.length) continue;
    const e = byPart.get(p.id) ?? { part: p, comps: [] };
    e.comps.push(c.name);
    byPart.set(p.id, e);
  }
  for (const { part, comps } of byPart.values()) {
    for (const t of part.tests ?? []) out.push({ title: `${listJoin(comps)}: ${part.name}`, source: "part", ...splitTest(t), parts: comps, required: true });
  }
  for (const c of m.calcs) {
    if (!c.verify) continue;
    const s = splitTest(c.verify);
    out.push({ title: c.title, source: "calculation", steps: s.steps, pass: s.pass, expected: c.outputs.map(calcLine), required: c.confidence === "rough" });
  }
  for (const t of m.tests) out.push({ title: t.label, source: "design", ...splitTest(t.procedure), required: true });
  // required tests first, in the order above; optional checks after them
  return [...out.filter((t) => t.required), ...out.filter((t) => !t.required)];
}

// ---------------------------------------------------------------- cut list

export interface CutGroup {
  part: CatalogPart;
  cuts: { length: number; qty: number; comps: string[] }[];
  /** bar length the cuts are planned from; undefined when each piece is ordered at length */
  stockLength?: number;
  stockCount?: number;
  note: string;
}

const SAW_KERF = 3;

export function cutList(model: Model): CutGroup[] {
  const groups = new Map<string, CutGroup>();
  for (const c of model.machine?.components ?? []) {
    const p = catalogPart(c.catalogId);
    if (!p?.cut_to_length || !c.length) continue;
    const g = groups.get(p.id) ?? { part: p, cuts: [], note: "" };
    for (let i = 0; i < c.count; i++) {
      const len = Math.round(c.length * 10) / 10;
      const row = g.cuts.find((x) => x.length === len);
      if (row) {
        row.qty++;
        if (!row.comps.includes(c.name)) row.comps.push(c.name);
      } else g.cuts.push({ length: len, qty: 1, comps: [c.name] });
    }
    groups.set(p.id, g);
  }
  for (const g of groups.values()) {
    g.cuts.sort((a, b) => b.length - a.length);
    if (g.part.kind === "extrusion" || g.part.kind === "rod") {
      const longest = g.cuts[0]?.length ?? 0;
      g.stockLength = longest <= 1000 ? 1000 : Math.ceil(longest / 500) * 500;
      // first-fit decreasing, allowing for the saw cut
      const bars: number[] = [];
      for (const c of g.cuts)
        for (let i = 0; i < c.qty; i++) {
          const k = bars.findIndex((free) => free >= c.length);
          if (k >= 0) bars[k] -= c.length + SAW_KERF;
          else bars.push(g.stockLength - c.length - SAW_KERF);
        }
      g.stockCount = bars.length;
      g.note = `Plan: ${plural(g.stockCount, "bar")} of ${g.stockLength} mm if you cut them yourself (${SAW_KERF} mm allowed per saw cut). Most shops will also cut to these lengths for a small fee.`;
    } else {
      g.note = `Order each piece at its length, or the next standard length up and cut it down${g.part.kind === "lead_screw" ? " (keep the machined end if it has one)" : ""}.`;
    }
  }
  return [...groups.values()];
}

export function cutListCsv(groups: CutGroup[]): string {
  const lines = [["Stock", "Catalog id", "Cut length (mm)", "Qty", "Used by", "Stock length (mm)", "Stock lengths to buy", "Note"].join(",")];
  for (const g of groups)
    g.cuts.forEach((c, i) =>
      lines.push([g.part.name, g.part.id, c.length, c.qty, c.comps.join(" "), g.stockLength ?? "order at length", i === 0 ? (g.stockCount ?? g.cuts.reduce((n, x) => n + x.qty, 0)) : "", i === 0 ? g.note : ""].map(csvCell).join(",")),
    );
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------- printed and made parts

const PRINTABLE = ["PLA", "PETG", "ABS", "ASA", "Nylon", "TPU", "PC", "CF-PETG", "PA-CF"];
const PRINT_PROCESSES = ["fdm", "sla", "sls"];

/** Printed when the part names a printing process, or, without one, when its material is a filament. */
function isPrinted(p: EvalPart): boolean {
  if (p.process) return PRINT_PROCESSES.includes(p.process.id);
  return PRINTABLE.some((m) => m.toLowerCase() === p.material.toLowerCase());
}

/** The build direction a printed part's process gives it (fdm or sla with build:), so the STL prints the way the checks assumed. */
export function buildDirection(p: EvalPart): [number, number, number] | undefined {
  const b = p.process && (p.process.id === "fdm" || p.process.id === "sla") ? p.process.settings.build : undefined;
  if (!Array.isArray(b) || typeof b[0] !== "number") return undefined;
  const [x, y, z] = b as [number, number, number];
  const l = Math.hypot(x, y, z);
  return l > 1e-9 ? [x / l, y / l, z / l] : undefined;
}

export interface MadePart {
  /** the first of the identical parts */
  part: EvalPart;
  /** how many identical parts the design has (same geometry and material) */
  qty: number;
  file: string;
  printable: boolean;
  /** oriented for printing, sitting on z = 0 */
  stl?: ArrayBuffer;
  size?: [number, number, number];
  volume?: number;
  /** grams */
  mass?: number;
  orientation?: string;
}

type M3 = [number, number, number, number, number, number, number, number, number];

function rotationTo(n: [number, number, number], target: [number, number, number]): M3 {
  const [x, y, z] = n;
  const c = x * target[0] + y * target[1] + z * target[2];
  if (c > 1 - 1e-9) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (c < -1 + 1e-9) return target[2] !== 0 ? [1, 0, 0, 0, -1, 0, 0, 0, -1] : [-1, 0, 0, 0, -1, 0, 0, 0, 1];
  // Rodrigues: axis = n × target
  let ax = y * target[2] - z * target[1];
  let ay = z * target[0] - x * target[2];
  let az = x * target[1] - y * target[0];
  const s = Math.hypot(ax, ay, az);
  ax /= s;
  ay /= s;
  az /= s;
  const t = 1 - c;
  return [t * ax * ax + c, t * ax * ay - s * az, t * ax * az + s * ay, t * ax * ay + s * az, t * ay * ay + c, t * ay * az - s * ax, t * ax * az - s * ay, t * ay * az + s * ax, t * az * az + c];
}

const DIR_WORDS: [number[], string][] = [
  [[0, 0, -1], "the face that points down (−Z) in the design"],
  [[0, 0, 1], "the face that points up (+Z) in the design, so it prints upside down"],
  [[1, 0, 0], "the +X side in the design"],
  [[-1, 0, 0], "the −X side in the design"],
  [[0, 1, 0], "the +Y side in the design"],
  [[0, -1, 0], "the −Y side in the design"],
];

/**
 * Lays a mesh on its largest flat face that it can rest on (unless the modelled bottom is nearly as good).
 * With a build direction (the part's process build:), it lays the mesh so layers stack that way instead.
 */
export function orientForPrint(mesh: MeshData, build?: [number, number, number]): { positions: Float32Array; indices: Uint32Array; size: [number, number, number]; volume: number; face: string; faceArea: number } {
  const P = mesh.positions;
  const I = mesh.indices;
  const nTri = I.length / 3;
  const area = new Float64Array(nTri);
  const nrm = new Float64Array(nTri * 3);
  const buckets = new Map<string, { n: [number, number, number]; area: number }>();
  let volume = 0;
  for (let t = 0; t < nTri; t++) {
    const a = I[t * 3] * 3;
    const b = I[t * 3 + 1] * 3;
    const c = I[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    volume += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
    if (l < 1e-12) continue;
    area[t] = l / 2;
    nrm[t * 3] = nx / l;
    nrm[t * 3 + 1] = ny / l;
    nrm[t * 3 + 2] = nz / l;
    const key = `${Math.round((nx / l) * 50)},${Math.round((ny / l) * 50)},${Math.round((nz / l) * 50)}`;
    const e = buckets.get(key) ?? { n: [nx / l, ny / l, nz / l], area: 0 };
    e.area += l / 2;
    buckets.set(key, e);
  }
  // area of the flat face on the outside in each candidate direction (pockets and steps do not count)
  const restArea = (n: [number, number, number]) => {
    let support = -Infinity;
    for (let i = 0; i < P.length; i += 3) support = Math.max(support, P[i] * n[0] + P[i + 1] * n[1] + P[i + 2] * n[2]);
    let a = 0;
    for (let t = 0; t < nTri; t++) {
      if (!area[t] || nrm[t * 3] * n[0] + nrm[t * 3 + 1] * n[1] + nrm[t * 3 + 2] * n[2] < 0.999) continue;
      const v = I[t * 3] * 3;
      if (Math.abs(P[v] * n[0] + P[v + 1] * n[1] + P[v + 2] * n[2] - support) < 0.05) a += area[t];
    }
    return a;
  };
  const candidates = [...buckets.values()].sort((x, y) => y.area - x.area).slice(0, 12);
  const down: [number, number, number] = [0, 0, -1];
  if (!candidates.some((c) => c.n[2] < -0.999)) candidates.push({ n: down, area: 0 });
  let best = { n: down, area: restArea(down) };
  const asModelled = best.area;
  for (const c of candidates) {
    const a = restArea(c.n);
    if (a > best.area + 1e-6) best = { n: c.n, area: a };
  }
  // keep the modelled orientation when it is nearly as good: designers often model printed parts the way they print
  if (asModelled >= best.area * 0.9) best = { n: down, area: asModelled };
  if (build) {
    const n: [number, number, number] = [-build[0], -build[1], -build[2]];
    best = { n, area: restArea(n) };
  }
  const R = rotationTo(best.n, down);
  const out = new Float32Array(P.length);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i], y = P[i + 1], z = P[i + 2];
    const r = [R[0] * x + R[1] * y + R[2] * z, R[3] * x + R[4] * y + R[5] * z, R[6] * x + R[7] * y + R[8] * z];
    for (let k = 0; k < 3; k++) {
      out[i + k] = r[k];
      lo[k] = Math.min(lo[k], r[k]);
      hi[k] = Math.max(hi[k], r[k]);
    }
  }
  // centred on the bed, sitting on z = 0
  const cx = (lo[0] + hi[0]) / 2;
  const cy = (lo[1] + hi[1]) / 2;
  for (let i = 0; i < out.length; i += 3) {
    out[i] -= cx;
    out[i + 1] -= cy;
    out[i + 2] -= lo[2];
  }
  const word = DIR_WORDS.find(([d]) => d[0] * best.n[0] + d[1] * best.n[1] + d[2] * best.n[2] > 0.999)?.[1] ?? "a flat face that is at an angle in the design";
  return { positions: out, indices: I, size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], volume: Math.abs(volume), face: word, faceArea: best.area };
}

export function madeParts(model: Model, meshFor?: (p: EvalPart) => MeshData | undefined): MadePart[] {
  const out: MadePart[] = [];
  const used = new Set<string>();
  // identical parts (a pattern, or the same part placed twice) are one file, printed several times
  const same = new Map<string, MadePart>();
  for (const p of model.parts) {
    if (p.kind !== "part") continue;
    const key = `${p.hash}|${p.material}`;
    const twin = same.get(key);
    if (twin) {
      twin.qty++;
      continue;
    }
    let file = fileSafe(p.name);
    for (let i = 2; used.has(file.toLowerCase()); i++) file = `${fileSafe(p.name)}_${i}`;
    used.add(file.toLowerCase());
    const printable = isPrinted(p);
    const mp: MadePart = { part: p, qty: 1, file: `print/${file}.stl`, printable };
    same.set(key, mp);
    const mesh = meshFor?.(p);
    if (mesh && mesh.indices.length) {
      const o = printable ? orientForPrint(mesh, buildDirection(p)) : { ...orientForPrint(mesh), face: "" };
      mp.stl = writeStl([{ mesh: { positions: o.positions, indices: o.indices, normals: new Float32Array(0), edges: new Float32Array(0) }, xf: [] }], `Kerf: ${p.name}`);
      mp.size = o.size;
      mp.volume = o.volume;
      mp.mass = (o.volume / 1000) * materialDensity(p.material);
      if (printable) mp.orientation = `Lay it on ${o.face} (${fmtNum(Math.round(o.faceArea))} mm² flat). The STL is already turned that way and sits on the bed.`;
    }
    out.push(mp);
  }
  return out;
}

const MATERIAL_NOTES: Record<string, string> = {
  pla: "PLA is stiff and easy to print, but softens above about 55 °C: keep it away from motors that run warm, heaters and direct sun.",
  petg: "PETG is tougher than PLA and takes heat to about 70 °C: a good default for machine parts. Print at 230 to 250 °C with a little cooling.",
  abs: "ABS takes heat to about 90 °C but warps: print it in an enclosure.",
  asa: "ASA is like ABS with better UV resistance: print it in an enclosure.",
  nylon: "Nylon is tough and wears well. Dry the filament before printing and print it in an enclosure.",
  tpu: "TPU is flexible: print slowly with a direct-drive extruder.",
};

function printReadme(parts: MadePart[], name: string): string {
  const L: string[] = [`# Printed and made parts: ${name}`, ""];
  const printed = parts.filter((p) => p.printable);
  const made = parts.filter((p) => !p.printable);
  if (printed.length) {
    L.push("Each STL is in millimetres, turned so its largest flat face is on the bed and centred on the origin. Slice them with your usual profile and these settings as a starting point:", "");
    L.push("- 0.2 mm layers, 0.4 mm nozzle.", "- 4 walls (perimeters) and 5 top and bottom layers: machine parts take their strength from the walls.", "- 30 to 40 % gyroid or cubic infill for parts that carry load (motor mounts, brackets); 15 % is enough for covers.", "- Supports only where the slicer shows overhangs steeper than 50°.", "");
  }
  for (const p of printed) {
    L.push(`## ${p.part.name}${p.part.label !== p.part.name ? ` (${p.part.label})` : ""}`, "");
    L.push(`- File: \`${p.file.replace(/^print\//, "")}\`${p.stl ? "" : " (not included: the geometry was not available when the pack was made)"}`);
    if (p.qty > 1) L.push(`- Print ${p.qty}: the design uses ${p.qty} identical copies`);
    L.push(`- Material: ${p.part.material}`);
    if (p.size) L.push(`- Size as printed: ${p.size.map((v) => fmtNum(Math.round(v * 10) / 10)).join(" × ")} mm`);
    if (p.mass !== undefined) L.push(`- About ${fmtNum(Math.round(p.mass))} g of filament at full density (less with infill)`);
    if (p.orientation) L.push(`- Orientation: ${p.orientation}`);
    const note = MATERIAL_NOTES[p.part.material.toLowerCase()];
    if (note) L.push(`- ${note}`);
    L.push("");
  }
  if (made.length) {
    L.push("## Parts to machine or cut", "", "These are not printable materials. The STL gives the shape; use `cad/assembly.step` for exact geometry when you send them to a machine shop or cut them yourself.", "");
    for (const p of made) L.push(`- ${p.qty > 1 ? `${p.qty} × ` : ""}**${p.part.name}** in ${p.part.material}${p.size ? `, ${p.size.map((v) => fmtNum(Math.round(v * 10) / 10)).join(" × ")} mm` : ""}: \`${p.file.replace(/^print\//, "")}\``);
    L.push("");
  }
  return L.join("\n");
}

// ---------------------------------------------------------------- parts list (bom.csv, bom.html)

interface BomSection {
  title: string;
  rows: (BomRow & { maker?: string; mpn?: string; section: string })[];
}

function bomSections(model: Model): BomSection[] {
  const rows = bomRows(model).map((r) => {
    const p = r.catalogId ? catalogPart(r.catalogId) : undefined;
    const section = r.kind === "Make" ? "Printed and made parts" : p?.cut_to_length ? "Stock cut to length" : r.catalogId ? "Electronics, motors and mechanical parts" : r.item === "item" ? "Hardware and other purchases" : "Standard parts";
    return { ...r, maker: p?.maker, mpn: p?.mpn, section };
  });
  const order = ["Electronics, motors and mechanical parts", "Stock cut to length", "Standard parts", "Hardware and other purchases", "Printed and made parts"];
  return order.map((title) => ({ title, rows: rows.filter((r) => r.section === title) })).filter((s) => s.rows.length);
}

function bomCsvFull(model: Model): string {
  const head = ["Section", "Qty", "Item", "Description", "Maker", "Part number", "Unit price (USD)", "Line price (USD)", "Cut length (mm)", "Material", "Buy link", "Search links", "Catalog id", "Notes"];
  const lines = [head.join(",")];
  const all = bomSections(model).flatMap((s) => s.rows);
  for (const r of all) {
    const direct = r.links.filter((l) => l.direct).map((l) => l.url);
    const search = r.links.filter((l) => !l.direct).map((l) => l.url);
    lines.push(
      [r.section, r.qty, r.item, r.description, r.maker, r.mpn ?? (r.catalogId ? "" : r.standard), r.price?.toFixed(2), r.price !== undefined ? (r.price * r.qty).toFixed(2) : "", r.length, r.material, r.link ?? direct[0], search.join(" "), r.catalogId, r.priceNote]
        .map((v) => csvCell(v))
        .join(","),
    );
  }
  const { total, unpriced } = bomTotal(all);
  lines.push(["Total", "", "", unpriced ? `${plural(unpriced, "item")} without a price not included` : "", "", "", "", total.toFixed(2), "", "", "", "", "", ""].map(csvCell).join(","));
  return lines.join("\n") + "\n";
}

const h = (s: string | number | undefined) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const safeUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : "#");

function bomHtml(model: Model, name: string, date: Date): string {
  const sections = bomSections(model);
  const all = sections.flatMap((s) => s.rows);
  const { total, unpriced } = bomTotal(all);
  const bought = all.filter((r) => r.kind === "Buy").reduce((n, r) => n + r.qty, 0);
  const fileOf = new Map<string, string>();
  for (const mp of madeParts(model)) if (!fileOf.has(mp.part.name)) fileOf.set(mp.part.name, mp.file);
  const body: string[] = [];
  for (const s of sections) {
    body.push(`<tr class="sec"><th colspan="6">${h(s.title)}</th></tr>`);
    for (const r of s.rows) {
      const links = r.links
        .map((l) => `<a class="${l.direct ? "shop" : "search"}" href="${h(safeUrl(l.url))}" target="_blank" rel="noopener noreferrer">${h(l.direct ? l.vendor : `Search ${l.vendor}`)}</a>`)
        .join(" ");
      const sub = [r.priceNote, r.kind === "Make" ? `Material: ${r.material}. STL in ${fileOf.get(r.item) ?? `print/${fileSafe(r.item)}.stl`}` : ""].filter(Boolean).join(" · ");
      body.push(
        `<tr><td class="num">${r.qty}</td><td><div class="name">${h(r.description)}</div>${sub ? `<div class="sub">${h(sub)}</div>` : ""}</td><td class="mono">${h([r.maker, r.mpn].filter(Boolean).join(" ") || (r.catalogId ? "" : r.standard))}</td><td class="num">${r.price !== undefined ? money(r.price) : ""}</td><td class="num">${r.price !== undefined ? money(r.price * r.qty) : r.kind === "Buy" ? '<span class="sub">no price</span>' : ""}</td><td class="links">${links}</td></tr>`,
      );
    }
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(name)}: parts list</title>
<style>
  :root { color-scheme: light; }
  body { font-family: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", Arial, sans-serif; color: #1b1f24; margin: 32px auto; max-width: 1100px; padding: 0 20px; font-size: 13.5px; line-height: 1.45; background: #fff; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .meta { color: #59616b; margin-bottom: 18px; }
  .totals { display: flex; gap: 28px; margin: 12px 0 22px; padding: 12px 16px; border: 1px solid #dde1e6; border-radius: 8px; background: #f7f8fa; }
  .totals b { display: block; font-size: 18px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #e6e9ed; vertical-align: top; }
  thead th { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #6a717b; border-bottom: 2px solid #cfd4da; }
  tr.sec th { background: #f1f3f6; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #3d444d; padding-top: 10px; }
  td.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  td.mono { font-family: "IBM Plex Mono", Menlo, Consolas, monospace; font-size: 12px; color: #3d444d; }
  .name { font-weight: 500; }
  .sub { color: #6a717b; font-size: 12px; }
  .links a { display: inline-block; margin: 0 4px 4px 0; padding: 2px 8px; border-radius: 12px; font-size: 12px; text-decoration: none; white-space: nowrap; }
  .links a.shop { background: #1e63c4; color: #fff; }
  .links a.search { border: 1px solid #c6ccd4; color: #3d444d; }
  tfoot td { font-weight: 700; border-top: 2px solid #cfd4da; border-bottom: 0; }
  .note { color: #6a717b; font-size: 12px; margin-top: 14px; }
  @media print { body { margin: 0; max-width: none; font-size: 11px; } .links a.search { display: none; } .links a.shop { background: none; color: #1e63c4; padding: 0; } a[href]::after { content: ""; } }
</style>
</head>
<body>
<h1>${h(name)}: parts list</h1>
<div class="meta">Generated by Kerf on ${h(fmtDate(date))}. Prices are typical prices in US dollars, for budgeting only.</div>
<div class="totals"><div><b>${bought}</b>items to buy</div><div><b>${money(total)}</b>estimated cost${unpriced ? ` (${plural(unpriced, "item")} without a price)` : ""}</div><div><b>${all.filter((r) => r.kind === "Make").reduce((n, r) => n + r.qty, 0)}</b>parts to print or make</div></div>
<table>
<thead><tr><th>Qty</th><th>Part</th><th>Maker part no.</th><th style="text-align:right">Unit</th><th style="text-align:right">Line</th><th>Where to buy</th></tr></thead>
<tbody>
${body.join("\n")}
</tbody>
<tfoot><tr><td></td><td>Total${unpriced ? ` <span class="sub">(${plural(unpriced, "item")} without a price not included)</span>` : ""}</td><td></td><td></td><td class="num">${money(total)}</td><td></td></tr></tfoot>
</table>
<p class="note">Blue links go to the maker or an official distributor. Search links look the part up on marketplaces: check the listing matches the part number and ratings before you buy. Stock cut to length is listed at its cut length; see cut_list.csv for the cuts.</p>
</body>
</html>
`;
}

// ---------------------------------------------------------------- calculations and checks

function calculationsMd(calcs: CalcTrace[], name: string): string {
  const L = [`# Engineering calculations: ${name}`, ""];
  if (!calcs.length) return [...L, "This design has no calculations.", ""].join("\n");
  L.push(
    `${plural(calcs.length, "calculation")} back this design. Each one lists its inputs, the method, what it assumes, and how far to trust it:`,
    "",
    "- **standard**: a textbook method with known inputs.",
    "- **estimate**: a standard method, but some inputs are uncertain.",
    "- **rough**: an order-of-magnitude answer. The test plan says how to check it on the real machine.",
    "",
  );
  calcs.forEach((c, i) => {
    L.push(`## ${i + 1}. ${c.title}`, "", `\`let ${c.name} = calc.${c.fn}(…)\` · confidence: **${c.confidence}**`, "");
    const table = (rows: CalcLine[]) => ["| Quantity | Value | Unit | Note |", "| --- | ---: | --- | --- |", ...rows.map((r) => `| ${mdCell(r.label)} | ${fmtNum(r.value)} | ${mdCell(r.unit)} | ${mdCell(r.note)} |`)];
    if (c.inputs.length) L.push("**Inputs**", "", ...table(c.inputs), "");
    if (c.outputs.length) L.push("**Results**", "", ...table(c.outputs), "");
    if (c.method.length) L.push("**Method**", "", ...c.method.map((x) => `- ${x}`), "");
    if (c.assumptions.length) L.push("**Assumptions**", "", ...c.assumptions.map((x) => `- ${x}`), "");
    if (c.verify) L.push(`**What to verify:** ${c.verify}`, "");
  });
  return L.join("\n");
}

const STATUS_WORD: Record<string, string> = { fail: "FAIL", warn: "WARN", pass: "pass", info: "note", pending: "not measured" };

function checksMd(items: CheckItem[], name: string): string {
  const n = (s: string) => items.filter((i) => i.status === s).length;
  const L = [`# Checks: ${name}`, "", `${n("fail")} failing · ${n("warn")} warnings · ${n("pass")} passing · ${n("info")} notes${n("pending") ? ` · ${n("pending")} not measured` : ""}`, ""];
  L.push("Each check says how it was established: geometry (measured on the 3D model), parameters, wiring rules (datasheet ratings applied to the wiring), calculation, or physical test (only a test on the real machine can confirm it).", "");
  const cats = [...new Set(items.map((i) => i.category))];
  const rank = (s: string) => ({ fail: 0, warn: 1, pending: 2, info: 3, pass: 4 })[s] ?? 5;
  for (const cat of cats) {
    const list = items.filter((i) => i.category === cat).sort((a, b) => rank(a.status) - rank(b.status));
    L.push(`## ${CATEGORY_LABEL[cat] ?? cat}`, "");
    for (const i of list) L.push(`- **${STATUS_WORD[i.status] ?? i.status}** ${i.title}${i.level === "soft" ? " (soft)" : ""}: ${i.detail.replace(/\n/g, " ")} _(${i.basis})_`);
    L.push("");
  }
  return L.join("\n");
}

function testPlanMd(plan: PlanItem[], name: string): string {
  const L = [`# Test plan: ${name}`, ""];
  if (!plan.length) return [...L, "No physical tests are listed for this design. Add test statements to the design for anything a calculation cannot settle.", ""].join("\n");
  const req = plan.filter((p) => p.required);
  const opt = plan.filter((p) => !p.required);
  L.push(`Work through these in order: bench checks of single parts first, then the calculations that need confirming, then the whole machine. Write each result down. ${plural(req.length, "test")} must pass before you rely on the machine${opt.length ? `; ${plural(opt.length, "more check")} at the end ${opt.length === 1 ? "is" : "are"} worth doing` : ""}.`, "");
  const SRC: Record<PlanItem["source"], string> = { part: "part check", calculation: "confirms a calculation", design: "design test" };
  const block = (p: PlanItem, n: number) => {
    L.push(`### ${n}. ${p.title}`, "", `_${SRC[p.source]}${p.parts?.length ? `: ${p.parts.join(", ")}` : ""}_`, "");
    L.push(`- [ ] **Do:** ${p.steps}`);
    if (p.pass) L.push(`- [ ] **Pass when:** ${p.pass}`);
    else if (p.expected?.length) L.push("- [ ] **Pass when:** the measurements agree with the calculation, or are better. If the real load is higher, check the margins in calculations.md still hold.");
    else L.push(`- [ ] **Record:** there is no fixed pass mark for this one. Write down what you measured${p.source === "part" ? " and compare it with the part's rating" : " and whether it is good enough for the job"}.`);
    if (p.expected?.length) L.push(`- **Calculated:** ${p.expected.join("; ")}`);
    L.push("- **Result:** ______________________", "");
  };
  if (req.length) {
    L.push("## Before you rely on it", "");
    req.forEach((p, i) => block(p, i + 1));
  }
  if (opt.length) {
    L.push("## Worth checking", "", "These confirm estimates that already have a margin. They are not required, but they tell you how close to the limits the machine runs.", "");
    opt.forEach((p, i) => block(p, req.length + i + 1));
  }
  return L.join("\n");
}

// ---------------------------------------------------------------- assembly guide

const KIND_WORDS: Partial<Record<CatalogKind, [string, string]>> = {
  controller: ["controller", "controllers"],
  host: ["host computer", "host computers"],
  motor_driver: ["motor driver", "motor drivers"],
  stepper_driver: ["stepper driver", "stepper drivers"],
  gearmotor: ["gearmotor", "gearmotors"],
  stepper: ["stepper motor", "stepper motors"],
  servo: ["servo", "servos"],
  actuator: ["linear actuator", "linear actuators"],
  sensor: ["sensor", "sensors"],
  hotend: ["hotend", "hotends"],
  extruder: ["extruder", "extruders"],
  heated_bed: ["heated bed", "heated beds"],
  fan: ["fan", "fans"],
  rail: ["linear rail", "linear rails"],
  lead_screw: ["lead screw", "lead screws"],
};

function machineSummary(m: MachineData): string {
  const ofKind = (k: CatalogKind) => m.components.filter((c) => c.kind === k);
  const brains = [...ofKind("controller"), ...ofKind("host")];
  const brain = brains.length ? `It is built around ${listJoin(brains.map((c) => `${/^[AEIOU]/i.test(catalogPart(c.catalogId)?.name ?? "") ? "an" : "a"} ${catalogPart(c.catalogId)?.name}`))}` : "It is built from catalog parts";
  const others = (Object.keys(KIND_WORDS) as CatalogKind[])
    .filter((k) => k !== "controller" && k !== "host")
    .map((k) => {
      const n = ofKind(k).reduce((s, c) => s + c.count, 0);
      const w = KIND_WORDS[k]!;
      return n ? `${n} ${n === 1 ? w[0] : w[1]}` : "";
    })
    .filter(Boolean);
  const power = [...ofKind("battery"), ...ofKind("psu")].map((c) => catalogPart(c.catalogId)?.name).filter(Boolean) as string[];
  let s = brain + (others.length ? ` with ${listJoin(others)}` : "");
  if (power.length) s += `, powered by ${listJoin(power.map((p) => `${/^[AEIOU8]/i.test(p) ? "an" : "a"} ${p}`))}`;
  s += ".";
  const roles = m.components.filter((c) => c.role).map((c) => `${c.name} (${c.role})`);
  if (roles.length) s += ` Roles: ${listJoin(roles)}.`;
  return s;
}

const GROUP_ORDER = ["Frame", "Motion", "Bed", "Drive", "Toolhead", "Parts", "Seals", "Power", "Electronics"];

function assemblyMd(model: Model, name: string, ctx: { made: MadePart[]; cuts: CutGroup[]; rows: WireRow[]; fw: FirmwareOutput[]; plan: PlanItem[]; ready: Readiness; boards: BoardFolder[] }): string {
  const m = model.machine!;
  const L: string[] = [`# Assembly guide: ${name}`, ""];
  L.push("Work through the sections in order and tick each box as you go. Positions are in millimetres in the design's own coordinates, the same as `cad/assembly.step`, so you can check each part against the 3D model. Wire numbers (W1, W2 …) match `wiring/wires.csv` and the wiring diagram.", "");

  // 1. before you start
  L.push("## 1. Before you start", "");
  L.push("- [ ] Check every part against `bom.html` as it arrives.");
  for (const b of ctx.boards) {
    if (b.problems) L.push(`- [ ] **Do not order the ${boardWord(b.def.title)} yet:** it has ${plural(b.problems, "problem")} listed in \`boards/${b.folder}/PROBLEMS.txt\`. Fix them in Kerf and download a new pack.`);
    else if (b.zip) L.push(`- [ ] Order the ${boardWord(b.def.title, "circuit board")} first, as it takes the longest to arrive (one to three weeks): upload \`${b.zip}\` to a board house such as JLCPCB or PCBWay. \`boards/${b.folder}/gerbers/README.txt\` says which options to pick.`);
  }
  if (ctx.ready.fails.length) L.push(`- [ ] **${ctx.ready.headline}** See \`checks.md\`: ${listJoin(ctx.ready.fails.slice(0, 4).map((f) => f.title))}${ctx.ready.fails.length > 4 ? " and more" : ""}.`);
  else if (ctx.ready.warns.length) L.push(`- [ ] Read the ${plural(ctx.ready.warns.length, "warning")} in \`checks.md\` and decide whether each one matters for your build.`);
  const tools = ["hex keys and screwdrivers", "a multimeter"];
  if (ctx.rows.length) tools.push("wire strippers and a crimp tool for the connectors you use");
  if (ctx.boards.length) tools.push("a temperature-controlled soldering iron, thin solder and flush cutters for the circuit board");
  else if (m.components.some((c) => ["connector", "battery", "fuse"].includes(c.kind))) tools.push("a soldering iron and heat-shrink for the power connectors");
  if (ctx.made.some((p) => p.printable)) tools.push("a 3D printer");
  if (ctx.cuts.length) tools.push("a saw with a fine blade and a deburring tool (or have the stock cut when you order it)");
  L.push(`- [ ] Tools: ${tools.join("; ")}.`, "");

  let step = 2;
  // 2. print and make
  if (ctx.made.length) {
    L.push(`## ${step++}. Print and make the parts`, "");
    for (const p of ctx.made) {
      if (p.printable) L.push(`- [ ] Print ${p.qty > 1 ? `${p.qty} × ` : ""}\`${p.file}\` (${p.part.label}) in ${p.part.material}.${p.orientation ? " " + p.orientation.split(".")[0] + "." : ""}`);
      else L.push(`- [ ] Make ${p.qty > 1 ? `${p.qty} × ` : ""}**${p.part.label}** in ${p.part.material}: machine or cut it to \`${p.file}\` / \`cad/assembly.step\`.`);
    }
    L.push("", "Settings and orientation notes are in `print/README.md`. Remove supports and clean up holes with a drill of the right size before assembly.", "");
  }
  // 3. cut the stock
  if (ctx.cuts.length) {
    L.push(`## ${step++}. Cut the stock`, "");
    for (const g of ctx.cuts) for (const c of g.cuts) L.push(`- [ ] ${g.stockLength ? "Cut" : "Order or cut"} ${c.qty} × ${fmtNum(c.length)} mm of ${g.part.name} (${listJoin(c.comps)}).`);
    L.push("", "Cut square, deburr the ends, and measure each piece: a frame is only as square as its cuts. The full list with stock lengths is in `cut_list.csv`.", "");
  }
  // circuit boards: their own soldering guides
  if (ctx.boards.length) {
    L.push(`## ${step++}. Solder the circuit board${ctx.boards.length === 1 ? "" : "s"}`, "");
    for (const b of ctx.boards) L.push(`- [ ] **${b.def.title}** (\`${b.def.name}\`, ${plural(b.parts, "part")}): follow \`boards/${b.folder}/assembly.md\`, lowest parts first, and finish with its power-up check before the board goes in.`);
    L.push("", "The parts on a board are listed in its own `parts.csv` and soldering guide, so they are left out of the steps below.", "");
  }
  // 4. mechanics; parts soldered to a board are in its own guide
  const onBoard = new Set(m.components.filter((c) => c.pcb).map((c) => c.name));
  const mech = model.parts.filter((p) => (p.kind === "part" || p.bom) && !/^(Electronics|Power)$/.test(p.group) && !onBoard.has(p.name));
  const elec = model.parts.filter((p) => p.kind === "component" && p.bom && /^(Electronics|Power)$/.test(p.group) && !onBoard.has(p.name));
  const seenNotes = new Set<string>();
  const partLine = (p: EvalPart) => {
    const cp = p.bom?.catalogId ? catalogPart(p.bom.catalogId) : undefined;
    const mc = m.components.find((c) => c.name === p.name);
    const what = p.kind === "part" ? `${isPrinted(p) ? "printed" : "made"} ${p.material} part` : (p.bom?.description ?? p.label);
    let s = `- [ ] **${p.id}**${mc?.role ? ` (${mc.role})` : ""}: ${what}, at ${fmtPos(pos(p))}.`;
    if (cp && !seenNotes.has(cp.id)) {
      seenNotes.add(cp.id);
      if (cp.notes?.length) s += ` ${cp.notes.filter((n) => !/^Price is per/.test(n)).join(" ")}`;
    }
    return s.trimEnd();
  };
  if (mech.length) {
    L.push(`## ${step++}. Put the mechanics together`, "");
    const groups = [...new Set(mech.map((p) => p.group))].sort((a, b) => (GROUP_ORDER.indexOf(a) + 1 || 99) - (GROUP_ORDER.indexOf(b) + 1 || 99));
    for (const g of groups) {
      L.push(`### ${g}`, "");
      for (const p of mech.filter((x) => x.group === g)) L.push(partLine(p));
      L.push("");
    }
    if (m.components.some((c) => ["gearmotor", "stepper", "servo", "actuator"].includes(c.kind))) L.push("Before wiring the motors, move everything they drive by hand through its whole travel (uncouple a motor if its gearbox is too stiff to turn): it should move freely, without binding or tight spots.", "");
  }
  if (elec.length) {
    L.push(`## ${step++}. Mount the electronics and power parts`, "");
    for (const p of elec) L.push(partLine(p));
    L.push("", "Mount boards on standoffs so nothing conductive touches their underside, and leave air around driver heatsinks and regulators.", "");
  }

  // wiring
  if (ctx.rows.length) {
    L.push(`## ${step++}. Wiring`, "");
    L.push("Wire with every power source disconnected: battery unplugged, power supply switched off at the wall. Ground wires go in first, then signals, then motors and cables, and power last. Use the wire size given or thicker, and label both ends of each wire with its number.", "");
    const groups = new Map<string, WireRow[]>();
    for (const r of ctx.rows) {
      const g = r.named ? `net:${r.net}` : `kind:${r.kind}`;
      groups.set(g, [...(groups.get(g) ?? []), r]);
    }
    const KIND_HEAD: Record<string, string> = { ground: "Ground wires", power: "Power wires", signal: "Signal wires", motor: "Motor leads", cable: "Cables" };
    const spec = (r: WireRow) => (r.cable ? r.cable : `${r.gauge ? `${r.gauge} AWG` : "wire"} ${r.color}`);
    const end = (e: WireRow["from"]) => `${e.comp}.${e.pin}${e.label !== e.pin ? ` ("${e.label}")` : ""}`;
    for (const [key, rows] of groups) {
      const r0 = rows[0];
      const same = rows.every((r) => spec(r) === spec(r0));
      const head = key.startsWith("net:") ? `${r0.net} (${r0.kind})` : KIND_HEAD[r0.kind];
      L.push(`### ${head}${same && !r0.cable ? `: ${spec(r0)}` : ""}`, "");
      if (r0.cable) L.push("Plug in the cable that comes with each part (or one of the same type), and route it so it cannot rub or catch on anything that moves.", "");
      for (const r of rows) L.push(`- [ ] **${r.id}**: ${end(r.from)} → ${end(r.to)}${same || r.cable ? "" : `, ${spec(r)}`}${r.cable ? `, ${r.cable}` : ""}${r.lengthMm ? `, about ${r.lengthMm} mm` : ""}.${r.label ? ` ${sentence(r.label)}` : ""}`);
      const note = rows.find((r) => r.note && !r.cable)?.note;
      if (note) L.push("", note);
      L.push("");
    }
    const powerNets = [...new Set(ctx.rows.filter((r) => r.kind === "power").map((r) => r.net))];
    const groundNets = [...new Set(ctx.rows.filter((r) => r.kind === "ground").map((r) => r.net))];
    if (powerNets.length && groundNets.length) {
      const or = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`);
      L.push(`Before connecting any power, set the multimeter to continuity and check there is no connection from ${or(powerNets)} to ${or(groundNets)}. A beep means a short: find it before going on.`, "");
    }
  }

  // firmware
  if (ctx.fw.length) {
    L.push(`## ${step++}. Firmware`, "");
    for (const f of ctx.fw) {
      const readme = f.files.find((x) => /README\.md$/i.test(x.path));
      L.push(`- [ ] **${f.name}** on ${f.board}: ${f.summary}.${readme ? ` Follow \`${readme.path}\` to install the tools and upload it.` : ""}`);
      for (const w of f.warnings) L.push(`  - Note: ${w}`);
    }
    L.push("", "Upload with the motors disconnected or the machine raised so nothing can move unexpectedly the first time it runs.", "");
  }

  // first power-up
  const nl = buildNetlist(m);
  const volts = nl.nets
    .map((n) => {
      const src = n.pins.find((p) => p.pin.type === "pwr_out") ?? n.pins.find((p) => p.pin.type === "pwr_rail");
      return src?.pin.v !== undefined && n.pins.length > 1 ? `${netLabel(n)} about ${fmtNum(src.pin.v)} V${src.pin.vmax && src.pin.vmax > src.pin.v ? ` (up to ${fmtNum(src.pin.vmax)} V)` : ""}` : "";
    })
    .filter(Boolean);
  L.push(`## ${step++}. First power-up`, "");
  if (ctx.plan.some((p) => p.source === "part")) L.push("- [ ] Do the bench checks of single parts at the start of `test_plan.md` first: some of them must happen before anything is connected.");
  const has = (k: CatalogKind) => m.components.some((c) => c.kind === k);
  const how = has("battery") ? " from a charged battery" : has("psu") ? " by switching the supply on at the wall" : "";
  L.push(`- [ ] Power up${has("fuse") ? " with the fuse fitted" : ""}${how}, ready to switch off at once if anything smells, smokes or gets hot.`);
  if (volts.length) L.push(`- [ ] Measure each supply against ground: ${listJoin(volts)}.`);
  L.push("");

  // bring-up tests
  if (ctx.plan.length) {
    L.push(`## ${step++}. Bring-up tests`, "");
    L.push("Run the tests in `test_plan.md` in order and write the results down:", "");
    ctx.plan.forEach((p, i) => L.push(`- [ ] ${i + 1}. ${p.title}${p.required ? "" : " (worth checking)"}`));
    L.push("");
  }
  return L.join("\n");
}

// ---------------------------------------------------------------- README

function readmeMd(model: Model, name: string, date: Date, ctx: { ready: Readiness; rows: WireRow[]; made: MadePart[]; cuts: CutGroup[]; fw: FirmwareOutput[]; plan: PlanItem[]; items: CheckItem[]; files: string[]; step: boolean; boards: BoardFolder[] }): string {
  const m = model.machine!;
  const bom = bomRows(model);
  const { total, unpriced } = bomTotal(bom);
  const bought = bom.filter((r) => r.kind === "Buy").reduce((n, r) => n + r.qty, 0);
  const L: string[] = [`# ${name}: build pack`, ""];
  L.push(`**${ctx.ready.headline}**${ctx.ready.detail ? ` ${ctx.ready.detail}` : ""}`, "");
  L.push(`Generated by Kerf on ${fmtDate(date)} from the design "${model.name}".`, "");
  L.push("## What this machine is", "", machineSummary(m));
  for (const f of m.firmware) if (typeof f.settings.behaviour === "string") L.push("", `What it does: ${sentence(f.settings.behaviour)}`);
  if (model.notes.length) L.push("", ...model.notes.map((n) => `> ${n}`));
  L.push("");
  const gauges = [...new Set(ctx.rows.map((r) => r.gauge).filter((g): g is number => g !== undefined))].sort((a, b) => a - b);
  const n = (s: string) => ctx.items.filter((i) => i.status === s).length;
  L.push("## At a glance", "", "| | |", "| --- | --- |");
  L.push(`| Items to buy | ${bought} (${plural(bom.filter((r) => r.kind === "Buy").length, "line")} in the parts list) |`);
  L.push(`| Estimated cost | ${money(total)}${unpriced ? ` plus ${plural(unpriced, "item")} without a price` : ""} |`);
  const madeQty = ctx.made.reduce((n, p) => n + p.qty, 0);
  L.push(`| Printed and made parts | ${madeQty}${madeQty !== ctx.made.length ? ` (${plural(ctx.made.length, "file")})` : ""} |`);
  if (ctx.cuts.length) L.push(`| Stock to cut | ${plural(ctx.cuts.reduce((s, g) => s + g.cuts.reduce((x, c) => x + c.qty, 0), 0), "piece")} from ${plural(ctx.cuts.length, "stock size")} |`);
  if (ctx.boards.length)
    L.push(`| Circuit boards | ${ctx.boards.map((b) => `${b.def.title}: ${fmtNum(b.def.w)} × ${fmtNum(b.def.d)} mm, ${plural(b.parts, "part")}${b.problems ? ` (${plural(b.problems, "problem")} to fix)` : ""}`).join("; ")} |`);
  L.push(`| Wires | ${ctx.rows.length}${gauges.length ? ` (${gauges.length > 1 ? `${gauges[0]} to ${gauges[gauges.length - 1]}` : gauges[0]} AWG)` : ""} |`);
  L.push(`| Calculations | ${m.calcs.length}${m.calcs.some((c) => c.confidence === "rough") ? ` (${m.calcs.filter((c) => c.confidence === "rough").length} rough)` : ""} |`);
  L.push(`| Checks | ${n("fail")} failing, ${n("warn")} warnings, ${n("pass")} passing |`);
  L.push(`| Physical tests | ${ctx.plan.filter((p) => p.required).length} required${ctx.plan.some((p) => !p.required) ? `, ${ctx.plan.filter((p) => !p.required).length} worth doing` : ""} |`, "");
  const badBoards = ctx.boards.filter((b) => b.problems);
  if (ctx.ready.fails.length || ctx.ready.warns.length || badBoards.length) {
    L.push("## Before you order", "");
    for (const b of badBoards) L.push(`- **Circuit board:** the ${boardWord(b.def.title)} has ${plural(b.problems, "problem")} (\`boards/${b.folder}/PROBLEMS.txt\`). Do not order it until they are fixed.`);
    for (const f of ctx.ready.fails) L.push(`- **Fails:** ${f.title}: ${f.detail}`);
    for (const w of ctx.ready.warns.slice(0, 12)) L.push(`- **Warning:** ${w.title}: ${w.detail}`);
    if (ctx.ready.warns.length > 12) L.push(`- …and ${ctx.ready.warns.length - 12} more in \`checks.md\`.`);
    L.push("");
  }
  L.push("## What is in this pack", "", "| File | What it is |", "| --- | --- |");
  const DESC: [RegExp, string][] = [
    [/^bom\.html$/, "Parts list with prices and buy links. Open it in a browser; it prints cleanly."],
    [/^bom\.csv$/, "The same parts list as a spreadsheet."],
    [/^cut_list\.csv$/, "Profiles, rails, rods and lead screws to cut, with lengths and how many bars to buy."],
    [/^print\/README\.md$/, "Material, orientation and slicer settings for each printed part."],
    [/^print\//, "STL files of the printed and made parts, each laid flat on its best face."],
    [/^cad\/assembly\.step$/, "The whole assembly as exact solids, for any CAD program."],
    [/^wiring\/wiring\.svg$/, "Wiring diagram. Open it in a browser and print it landscape."],
    [/^wiring\/wires\.csv$/, "Every wire: from, to, size, colour and length."],
    [/^boards\/[^/]+\//, "A circuit board: the Gerber and drill files zipped for the board house (`*-gerbers.zip`) and loose in `gerbers/`, pictures of both sides, its parts list and a soldering guide."],
    [/^firmware\//, "Generated firmware. Start with the README in each folder."],
    [/^calculations\.md$/, "The engineering calculations with their inputs, methods and assumptions."],
    [/^checks\.md$/, "Every check Kerf ran on the design, grouped by kind."],
    [/^test_plan\.md$/, "Physical tests, with what to measure and when it passes."],
    [/^service\.md$/, "What wears out and when, and the maintenance schedule."],
    [/^assembly\.md$/, "Step-by-step build guide, from the first part to the first test."],
  ];
  const shown = new Set<string>();
  for (const f of ctx.files) {
    const d = DESC.find(([re]) => re.test(f));
    if (!d) continue;
    const key = d[0].source;
    const label = /^print\/(?!README)/.test(f) ? "print/*.stl" : /^firmware\//.test(f) ? "firmware/" : /^boards\//.test(f) ? `${f.split("/").slice(0, 2).join("/")}/` : f;
    if (shown.has(key + label)) continue;
    shown.add(key + label);
    L.push(`| \`${label}\` | ${d[1]} |`);
  }
  L.push("");
  L.push("## Order of work", "");
  const orderable = ctx.boards.filter((b) => b.zip && !b.problems);
  const boardsBad = ctx.boards.some((b) => b.problems);
  L.push(`1. ${ctx.ready.fails.length || boardsBad ? `Fix the failing checks${boardsBad ? " and board problems" : ""} in Kerf and export a new pack.` : `Order the parts in \`bom.html\`${orderable.length ? ` and the circuit board${orderable.length === 1 ? "" : "s"}: upload ${listJoin(orderable.map((b) => `\`${b.zip}\``))} to a board house` : ""}.`}`);
  let k = 2;
  if (ctx.made.length) L.push(`${k++}. Print the parts in \`print/\` while you wait for the deliveries.`);
  if (ctx.boards.length) L.push(`${k++}. Solder the board${ctx.boards.length === 1 ? "" : "s"} with ${listJoin(ctx.boards.map((b) => `\`boards/${b.folder}/assembly.md\``))} when ${ctx.boards.length === 1 ? "it arrives" : "they arrive"}.`);
  L.push(`${k++}. Follow \`assembly.md\` from start to finish: it covers the cutting, assembly, wiring and firmware.`);
  L.push(`${k++}. Run \`test_plan.md\` before you rely on the machine.`, "");
  L.push("Kerf checks the design against datasheet ratings and engineering rules, but it cannot see the parts you actually receive. Check ratings on the delivered parts, and treat the test plan as part of the design.", "");
  return L.join("\n");
}

// ---------------------------------------------------------------- the pack

/** Every file of the build pack, ready to zip. */
export function buildPack(model: Model, report: CheckReport | null, opts: PackOptions = {}): PackFile[] {
  const m = model.machine;
  if (!m) throw new Error("This design has no machine parts, wiring or firmware to make a build pack from.");
  const name = opts.name ?? model.name ?? "Design";
  const date = opts.date ?? new Date();
  const items = checkItems(model, report);
  const plan = testPlan(m);
  const ready = readiness(model, items, plan);
  const rows = wireList(m, componentPositions(model));
  const made = madeParts(model, opts.meshFor);
  const cuts = cutList(model);
  const fw = opts.firmware ?? generateFirmware(m, model.name || name);
  const files: PackFile[] = [];
  const add = (path: string, data: string | Uint8Array) => files.push({ path, data });

  add("bom.html", bomHtml(model, name, date));
  add("bom.csv", bomCsvFull(model));
  if (cuts.length) add("cut_list.csv", cutListCsv(cuts));
  if (made.length) {
    for (const p of made) if (p.stl) add(p.file, new Uint8Array(p.stl));
    add("print/README.md", printReadme(made, name));
  }
  if (opts.step) add("cad/assembly.step", opts.step instanceof Uint8Array ? opts.step : new Uint8Array(opts.step));
  if (rows.length) {
    add("wiring/wiring.svg", wiringDiagram(m, { title: name }).svg);
    add("wiring/wires.csv", wiresCsv(rows));
  }
  const boards = boardPackFiles(m, m.boards.length ? routeBoards(m, opts.boards) : [], date);
  for (const f of boards.files) add(f.path, f.data);
  for (const f of fw) for (const file of f.files) add(file.path.startsWith("firmware/") ? file.path : `firmware/${file.path}`, file.content);
  if (m.calcs.length) add("calculations.md", calculationsMd(m.calcs, name));
  add("checks.md", checksMd(items, name));
  add("test_plan.md", testPlanMd(plan, name));
  const service = servicePlan(model, opts.use);
  if (service.items.length) add("service.md", serviceMd(service, name));
  add("assembly.md", assemblyMd(model, name, { made, cuts, rows, fw, plan, ready, boards: boards.folders }));
  const paths = ["README.md", ...files.map((f) => f.path)];
  files.unshift({ path: "README.md", data: readmeMd(model, name, date, { ready, rows, made, cuts, fw, plan, items, files: paths, step: !!opts.step, boards: boards.folders }) });
  return files;
}
