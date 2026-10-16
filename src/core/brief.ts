// The design brief as plain data: read from the evaluated model, edited by
// the brief panel and by Claude, and written back into the design source as
// one canonical `brief { ... }` block. The source stays the single truth, so
// the brief has history, undo and diffs like every other edit.

import type { Brief, Model } from "./model";
import type { V3 } from "../kernel/recipe";
import { parse } from "../lang/parser";
import { fmtNum } from "../lang/values";

export interface BriefUseData {
  id: string;
  text: string;
  assumed: boolean;
  load?: number;
  dir?: V3;
  on?: string;
  cycles?: number;
  note?: string;
}

export interface BriefGivenData {
  name: string;
  /** value expression as written, e.g. "25mm" */
  text: string;
  desc?: string;
  assumed: boolean;
}

export interface BriefRefData {
  id: string;
  title: string;
  file?: string;
  url?: string;
  notes?: string;
}

export interface BriefData {
  purpose?: string;
  setting?: string;
  look?: string;
  priorities: string[];
  temp?: [number, number];
  outdoor?: boolean;
  exposure: string[];
  process?: string;
  material?: string;
  quantity?: number;
  buildVolume?: V3;
  maxSize?: V3;
  maxMass?: number;
  /** source names of the fields Claude assumed */
  assumed: string[];
  uses: BriefUseData[];
  givens: BriefGivenData[];
  refs: BriefRefData[];
  assumptions: { text: string; confirmed: boolean }[];
  extra: { name: string; text: string }[];
}

export type FieldKey = "purpose" | "setting" | "look" | "priorities" | "temp" | "outdoor" | "exposure" | "process" | "material" | "quantity" | "build_volume" | "max_size" | "max_mass";

/** Source name, data key and a plain label for every brief field, in file order. */
export const FIELDS: { key: FieldKey; prop: keyof BriefData; label: string }[] = [
  { key: "purpose", prop: "purpose", label: "purpose" },
  { key: "setting", prop: "setting", label: "where and how it is used" },
  { key: "priorities", prop: "priorities", label: "priorities" },
  { key: "look", prop: "look", label: "look" },
  { key: "temp", prop: "temp", label: "temperature range" },
  { key: "outdoor", prop: "outdoor", label: "outdoors" },
  { key: "exposure", prop: "exposure", label: "exposure" },
  { key: "process", prop: "process", label: "process" },
  { key: "material", prop: "material", label: "material" },
  { key: "quantity", prop: "quantity", label: "quantity" },
  { key: "build_volume", prop: "buildVolume", label: "build volume" },
  { key: "max_size", prop: "maxSize", label: "maximum size" },
  { key: "max_mass", prop: "maxMass", label: "maximum mass" },
];
export const fieldByKey = (k: string) => FIELDS.find((f) => f.key === k);

export const emptyBrief = (): BriefData => ({ priorities: [], exposure: [], assumed: [], uses: [], givens: [], refs: [], assumptions: [], extra: [] });

export function briefData(b: Brief | null | undefined): BriefData | null {
  if (!b) return null;
  return {
    purpose: b.purpose,
    setting: b.setting,
    look: b.look,
    priorities: [...b.priorities],
    temp: b.temp ? [b.temp[0], b.temp[1]] : undefined,
    outdoor: b.outdoor,
    exposure: [...b.exposure],
    process: b.process,
    material: b.material,
    quantity: b.quantity,
    buildVolume: b.buildVolume ? [...b.buildVolume] : undefined,
    maxSize: b.maxSize ? [...b.maxSize] : undefined,
    maxMass: b.maxMass,
    // in field order, so the same brief always compares equal however it was typed
    assumed: FIELDS.map((f) => f.key as string).filter((k) => b.assumed.includes(k)),
    uses: b.uses.map((u) => ({ id: u.id, text: u.text, assumed: u.assumed, load: u.load, dir: u.dir ? [...u.dir] : undefined, on: u.on, cycles: u.cycles, note: u.note })),
    givens: b.givens.map((g) => ({ name: g.name, text: g.text, desc: g.desc, assumed: g.assumed })),
    refs: b.refs.map((r) => ({ id: r.id, title: r.title, file: r.file, url: r.url, notes: r.notes })),
    assumptions: b.assumptions.map((a) => ({ text: a.text, confirmed: a.confirmed })),
    extra: b.extra.map((e) => ({ name: e.name, text: e.text })),
  };
}

// ---------- writing ----------

/** A string literal the Kerf lexer reads back exactly. */
export function quote(s: string): string {
  const clean = s.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
  return '"' + clean.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t") + '"';
}

const num = (n: number, digits = 3) => fmtNum(n, digits);
const vec = (v: V3) => `(${v.map((x) => num(x)).join(", ")})`;
const AXES: [V3, string][] = [
  [[1, 0, 0], "X"],
  [[-1, 0, 0], "-X"],
  [[0, 1, 0], "Y"],
  [[0, -1, 0], "-Y"],
  [[0, 0, 1], "Z"],
  [[0, 0, -1], "-Z"],
];
export function dirText(d: V3): string {
  const hit = AXES.find(([a]) => Math.abs(a[0] - d[0]) < 1e-6 && Math.abs(a[1] - d[1]) < 1e-6 && Math.abs(a[2] - d[2]) < 1e-6);
  return hit ? hit[1] : vec(d);
}
const list = (xs: string[]) => `[${xs.map(quote).join(", ")}]`;

function fieldText(d: BriefData, key: FieldKey): string | null {
  switch (key) {
    case "purpose":
    case "setting":
    case "look":
    case "process":
    case "material": {
      const v = d[key];
      return v ? quote(v) : null;
    }
    case "priorities":
    case "exposure":
      return d[key].length ? list(d[key]) : null;
    case "temp":
      return d.temp ? `${num(d.temp[0], 1)}C .. ${num(d.temp[1], 1)}C` : null;
    case "outdoor":
      return d.outdoor === undefined ? null : String(d.outdoor);
    case "quantity":
      return d.quantity ? String(Math.round(d.quantity)) : null;
    case "build_volume":
      return d.buildVolume ? vec(d.buildVolume) : null;
    case "max_size":
      return d.maxSize ? vec(d.maxSize) : null;
    case "max_mass":
      return d.maxMass ? `${num(d.maxMass, 1)}g` : null;
  }
}

export function serializeBrief(d: BriefData): string {
  const groups: string[][] = [];
  const add = (keys: FieldKey[]) => {
    const lines: string[] = [];
    for (const k of keys) {
      const t = fieldText(d, k);
      if (t !== null) lines.push(`  ${k}: ${t}${d.assumed.includes(k) ? " assumed" : ""}`);
    }
    groups.push(lines);
  };
  add(["purpose", "setting", "priorities", "look"]);
  add(["temp", "outdoor", "exposure"]);
  add(["process", "material", "quantity", "build_volume"]);
  add(["max_size", "max_mass"]);
  groups.push(
    d.uses.map((u) => {
      const props: string[] = [];
      if (u.load !== undefined) props.push(`load: ${num(u.load, 2)}N`);
      if (u.dir) props.push(`dir: ${dirText(u.dir)}`);
      if (u.on) props.push(`on: ${/^[A-Za-z_][A-Za-z0-9_]*$/.test(u.on) ? u.on : quote(u.on)}`);
      if (u.cycles) props.push(`cycles: ${Math.round(u.cycles)}`);
      if (u.note) props.push(`note: ${quote(u.note)}`);
      return `  use ${u.id} ${quote(u.text)}${props.length ? ` { ${props.join(", ")} }` : ""}${u.assumed ? " assumed" : ""}`;
    }),
  );
  groups.push(d.givens.map((g) => `  given ${g.name} = ${g.text.trim()}${g.desc ? " " + quote(g.desc) : ""}${g.assumed ? " assumed" : ""}`));
  groups.push(
    d.refs.map((r) => {
      const props: string[] = [];
      if (r.file) props.push(`file: ${quote(r.file)}`);
      if (r.url) props.push(`url: ${quote(r.url)}`);
      if (r.notes) props.push(`notes: ${quote(r.notes)}`);
      return `  reference ${r.id} ${quote(r.title)}${props.length ? ` { ${props.join(", ")} }` : ""}`;
    }),
  );
  groups.push(d.assumptions.map((a) => `  assume ${quote(a.text)}${a.confirmed ? " confirmed" : ""}`));
  groups.push(d.extra.map((e) => `  ${e.name}: ${e.text}`));
  const body = groups
    .filter((g) => g.length)
    .map((g) => g.join("\n"))
    .join("\n\n");
  return body ? `brief {\n${body}\n}` : "brief {\n}";
}

/** True when the source has a brief the parser could not read cleanly; editing it as data would drop the broken part. */
export function briefHasErrors(src: string, model: Model | null): boolean {
  const b = model?.brief;
  const hasBlock = /(^|\n)\s*brief\s*\{/.test(src);
  if (!hasBlock) return false;
  if (!b) return true;
  return !!model?.diagnostics.some((d) => d.severity === "error" && d.start >= b.span.start && d.start <= b.span.end);
}

/** Replace the brief block, or add one after the design name and notes at the top of the file. */
export function writeBrief(src: string, model: Model | null, d: BriefData): string {
  const text = serializeBrief(d);
  const b = model?.brief;
  if (b) return src.slice(0, b.span.start) + text + src.slice(b.span.end);
  let at = 0;
  for (const s of parse(src).program.stmts) {
    if (s.k !== "design" && s.k !== "note") break;
    at = s.span.end;
  }
  if (at === 0) return `${text}\n\n${src.replace(/^\n+/, "")}`;
  const rest = src.slice(at).replace(/^[ \t]*\n?/, "");
  return `${src.slice(0, at)}\n\n${text}\n${rest.startsWith("\n") || !rest ? "" : "\n"}${rest}`;
}

// ---------- names ----------

const ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const validId = (s: string) => ID_RE.test(s) && s.length <= 40;

/** A short identifier from free text: "Holds the tube" → holds_tube. */
export function slugId(text: string, taken: Iterable<string>, fallback = "use"): string {
  const stop = new Set(["the", "a", "an", "of", "to", "and", "it", "is", "for", "with", "on", "in", "from", "be", "can"]);
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !stop.has(w))
    .slice(0, 3);
  let base = words.join("_") || fallback;
  if (!/^[a-z_]/.test(base)) base = `${fallback}_${base}`;
  base = base.slice(0, 28);
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}${i}`)) return `${base}${i}`;
}

// ---------- processes and vocabulary ----------

export type ProcessKind = "fdm" | "resin" | "sls" | "cnc" | "laser" | "sheet" | "molding" | "other";

export const PROCESSES: { kind: ProcessKind; label: string; print?: boolean; volume?: V3 }[] = [
  { kind: "fdm", label: "FDM print", print: true, volume: [220, 220, 250] },
  { kind: "resin", label: "Resin print", print: true, volume: [200, 120, 200] },
  { kind: "sls", label: "SLS print", print: true, volume: [300, 300, 300] },
  { kind: "cnc", label: "CNC machined" },
  { kind: "laser", label: "Laser cut" },
  { kind: "sheet", label: "Sheet metal" },
  { kind: "molding", label: "Injection moulded" },
  { kind: "other", label: "Other" },
];

/** Reads loose process names ("3D printed in PETG", "machined") as a process kind. */
export function processKind(p: string | undefined): ProcessKind | null {
  if (!p) return null;
  const s = p.toLowerCase();
  if (/resin|sla|msla|dlp/.test(s)) return "resin";
  if (/sls|mjf|powder|multi jet/.test(s)) return "sls";
  if (/fdm|fff|3d.?print|print/.test(s)) return "fdm";
  if (/cnc|machin|mill|lathe|turn/.test(s)) return "cnc";
  if (/laser|waterjet|water jet/.test(s)) return "laser";
  if (/sheet|bend|fold|brake/.test(s)) return "sheet";
  if (/mou?ld|inject|cast/.test(s)) return "molding";
  return "other";
}
export const processInfo = (p: string | undefined) => PROCESSES.find((x) => x.kind === processKind(p)) ?? null;

export const EXPOSURES = ["sunlight", "rain", "humidity", "salt water", "oil", "chemicals", "food contact", "dust", "impacts", "vibration", "skin contact"];
export const PRIORITIES = ["strength", "stiffness", "low weight", "low cost", "print time", "looks", "easy assembly", "serviceability", "durability", "precision", "safety", "quiet"];

// ---------- describing changes ----------

const fieldValue = (d: BriefData, key: FieldKey): string => {
  switch (key) {
    case "temp":
      return d.temp ? `${num(d.temp[0], 1)} to ${num(d.temp[1], 1)} °C` : "not set";
    case "outdoor":
      return d.outdoor === undefined ? "not set" : d.outdoor ? "yes" : "no";
    case "priorities":
    case "exposure":
      return d[key].length ? d[key].join(", ") : "none";
    case "build_volume":
    case "max_size": {
      const v = key === "max_size" ? d.maxSize : d.buildVolume;
      return v ? `${v.map((x) => num(x, 1)).join(" × ")} mm` : "not set";
    }
    case "max_mass":
      return d.maxMass ? `${num(d.maxMass, 1)} g` : "not set";
    case "quantity":
      return d.quantity ? String(d.quantity) : "not set";
    default: {
      const v = d[key as "purpose"];
      return v ? `“${v}”` : "not set";
    }
  }
};

export function loadText(u: { load?: number; dir?: V3; on?: string }): string {
  if (u.load === undefined) return "";
  const arrow = u.dir ? ({ "-Z": " down", Z: " up", X: " +X", "-X": " −X", Y: " +Y", "-Y": " −Y" } as Record<string, string>)[dirText(u.dir)] ?? ` along ${dirText(u.dir)}` : "";
  return `${num(u.load, 1)} N${arrow}${u.on ? ` on ${u.on}` : ""}`;
}

/** Plain-language list of what changed between two briefs, for version messages and for Claude. */
export function briefChanges(a: BriefData | null, b: BriefData | null): string[] {
  const A = a ?? emptyBrief();
  const B = b ?? emptyBrief();
  const out: string[] = [];
  for (const f of FIELDS) {
    const va = fieldValue(A, f.key);
    const vb = fieldValue(B, f.key);
    if (va !== vb) out.push(vb === "not set" || vb === "none" ? `cleared ${f.label}` : va === "not set" || va === "none" ? `${f.label} ${vb}` : `${f.label} ${va} → ${vb}`);
    else if (A.assumed.includes(f.key) && !B.assumed.includes(f.key) && vb !== "not set") out.push(`confirmed ${f.label}`);
  }
  for (const u of B.uses) {
    const p = A.uses.find((x) => x.id === u.id);
    if (!p) out.push(`added use “${u.text}”${u.load !== undefined ? ` (${loadText(u)})` : ""}`);
    else {
      if (p.text !== u.text) out.push(`use ${u.id} now reads “${u.text}”`);
      if (loadText(p) !== loadText(u)) out.push(`use ${u.id} load ${loadText(p) || "none"} → ${loadText(u) || "none"}`);
      if (p.assumed && !u.assumed) out.push(`confirmed use “${u.text}”`);
    }
  }
  for (const u of A.uses) if (!B.uses.some((x) => x.id === u.id)) out.push(`removed use “${u.text}”`);
  for (const g of B.givens) {
    const p = A.givens.find((x) => x.name === g.name);
    if (!p) out.push(`added ${g.name} = ${g.text}`);
    else if (p.text.trim() !== g.text.trim()) out.push(`${g.name} ${p.text} → ${g.text}`);
    else if (p.assumed && !g.assumed) out.push(`confirmed ${g.name} = ${g.text}`);
  }
  for (const g of A.givens) if (!B.givens.some((x) => x.name === g.name)) out.push(`removed ${g.name}`);
  for (const r of B.refs) {
    const p = A.refs.find((x) => x.id === r.id);
    if (!p) out.push(`added reference “${r.title}”`);
    else if (p.notes !== r.notes || p.title !== r.title) out.push(`edited reference “${r.title}”`);
  }
  for (const r of A.refs) if (!B.refs.some((x) => x.id === r.id)) out.push(`removed reference “${r.title}”`);
  for (const x of B.assumptions) {
    const p = A.assumptions.find((y) => y.text === x.text);
    if (!p) out.push(`${x.confirmed ? "added" : "assumed"} “${x.text}”`);
    else if (!p.confirmed && x.confirmed) out.push(`confirmed “${x.text}”`);
  }
  for (const x of A.assumptions) if (!B.assumptions.some((y) => y.text === x.text)) out.push(`removed “${x.text}”`);
  return out;
}

/**
 * Things the user stated that an edit would change or drop. Claude may only
 * do this when the user asked in this conversation; the tools refuse otherwise.
 */
export function protectedBriefChanges(a: BriefData | null, b: BriefData | null): string[] {
  if (!a) return [];
  const B = b ?? emptyBrief();
  const out: string[] = [];
  for (const f of FIELDS) {
    if (a.assumed.includes(f.key)) continue;
    const va = fieldValue(a, f.key);
    if (va === "not set" || va === "none") continue;
    if (va !== fieldValue(B, f.key) || B.assumed.includes(f.key)) out.push(`the ${f.label} (${va})`);
  }
  for (const u of a.uses) {
    if (u.assumed) continue;
    const n = B.uses.find((x) => x.id === u.id);
    if (!n || n.text !== u.text || n.assumed || loadText(n) !== loadText(u)) out.push(`use ${u.id} (“${u.text}”)`);
  }
  for (const g of a.givens) {
    if (g.assumed) continue;
    const n = B.givens.find((x) => x.name === g.name);
    if (!n || n.text.trim() !== g.text.trim() || n.assumed) out.push(`${g.name} = ${g.text}`);
  }
  for (const x of a.assumptions) if (x.confirmed && !B.assumptions.some((y) => y.text === x.text && y.confirmed)) out.push(`“${x.text}”`);
  return out;
}

/** Everything Claude assumed and the user has not confirmed yet. */
export function openAssumptions(d: BriefData | null): { kind: "field" | "use" | "given" | "note"; key: string; label: string; value: string }[] {
  if (!d) return [];
  const out: ReturnType<typeof openAssumptions> = [];
  for (const k of d.assumed) {
    const f = fieldByKey(k);
    if (f) out.push({ kind: "field", key: k, label: f.label, value: fieldValue(d, f.key) });
  }
  for (const u of d.uses) if (u.assumed) out.push({ kind: "use", key: u.id, label: "use", value: u.text });
  for (const g of d.givens) if (g.assumed) out.push({ kind: "given", key: g.name, label: g.name, value: `${g.text}${g.desc ? ` (${g.desc})` : ""}` });
  for (const a of d.assumptions) if (!a.confirmed) out.push({ kind: "note", key: a.text, label: "assumption", value: a.text });
  return out;
}

/** Mark one open assumption as confirmed by the user. */
export function confirmAssumption(d: BriefData, kind: "field" | "use" | "given" | "note", key: string): BriefData {
  const n: BriefData = structuredClone(d);
  if (kind === "field") n.assumed = n.assumed.filter((k) => k !== key);
  if (kind === "use") n.uses = n.uses.map((u) => (u.id === key ? { ...u, assumed: false } : u));
  if (kind === "given") n.givens = n.givens.map((g) => (g.name === key ? { ...g, assumed: false } : g));
  if (kind === "note") n.assumptions = n.assumptions.map((a) => (a.text === key ? { ...a, confirmed: true } : a));
  return n;
}

// ---------- the brief in Claude's context ----------

/** Compact text of the brief for every turn, with the status of each use from the latest checks. */
export function briefContext(d: BriefData | null, useStatus: (id: string) => string | undefined): string {
  if (!d) return "Brief: none yet. Before modelling a new design, record one with update_brief (purpose, uses, givens, environment, process).";
  const a = (k: FieldKey) => (d.assumed.includes(k) ? " (assumed)" : "");
  const lines: string[] = ["Brief:"];
  if (d.purpose) lines.push(`  Purpose: ${d.purpose}${a("purpose")}`);
  if (d.setting) lines.push(`  Setting: ${d.setting}${a("setting")}`);
  if (d.priorities.length) lines.push(`  Priorities, most important first: ${d.priorities.join(", ")}${a("priorities")}`);
  if (d.look) lines.push(`  Look: ${d.look}${a("look")}`);
  const env: string[] = [];
  if (d.temp) env.push(`${num(d.temp[0], 1)} to ${num(d.temp[1], 1)} °C${a("temp")}`);
  if (d.outdoor !== undefined) env.push(`${d.outdoor ? "outdoors" : "indoors"}${a("outdoor")}`);
  if (d.exposure.length) env.push(`exposed to ${d.exposure.join(", ")}${a("exposure")}`);
  if (env.length) lines.push(`  Environment: ${env.join("; ")}`);
  const make: string[] = [];
  if (d.process) make.push(`${d.process}${a("process")}`);
  if (d.material) make.push(`material ${d.material}${a("material")}`);
  if (d.quantity) make.push(`quantity ${d.quantity}${a("quantity")}`);
  if (d.buildVolume) make.push(`build volume ${d.buildVolume.map((x) => num(x, 0)).join(" × ")} mm${a("build_volume")}`);
  if (make.length) lines.push(`  Making: ${make.join("; ")}`);
  if (d.maxSize) lines.push(`  Must fit within ${d.maxSize.map((x) => num(x, 1)).join(" × ")} mm (X × Y × Z)${a("max_size")}`);
  if (d.maxMass) lines.push(`  Must weigh at most ${num(d.maxMass, 1)} g${a("max_mass")}`);
  if (d.uses.length) {
    lines.push("  Uses (each needs a require ... for <id>):");
    for (const u of d.uses) {
      const extra = [loadText(u), u.cycles ? `${u.cycles} cycles` : "", u.note ?? ""].filter(Boolean).join("; ");
      lines.push(`    - ${u.id}: ${u.text}${extra ? ` [${extra}]` : ""}${u.assumed ? " (assumed)" : ""} → ${useStatus(u.id) ?? "not checked yet"}`);
    }
  } else lines.push("  Uses: none recorded yet.");
  if (d.givens.length) lines.push(`  Givens (fixed facts; use these names in the design): ${d.givens.map((g) => `${g.name} = ${g.text}${g.desc ? ` (${g.desc})` : ""}${g.assumed ? " (assumed)" : ""}`).join("; ")}`);
  if (d.refs.length) lines.push(`  References: ${d.refs.map((r) => `${r.id} “${r.title}”${r.file ? " [file]" : ""}${r.url ? ` <${r.url}>` : ""}${r.notes ? `: ${r.notes}` : ""}`).join("; ")}`);
  const open = d.assumptions.filter((x) => !x.confirmed);
  const conf = d.assumptions.filter((x) => x.confirmed);
  if (conf.length) lines.push(`  Confirmed by the user: ${conf.map((x) => x.text).join("; ")}`);
  if (open.length) lines.push(`  Your assumptions awaiting confirmation: ${open.map((x) => x.text).join("; ")}`);
  return lines.join("\n");
}
