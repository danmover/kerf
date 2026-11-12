// How a part says it is made, in the design language: the mfg.* functions
// (mfg.cnc_mill(tool_d: 2)), the "cnc_mill" shorthand, and plain-language
// process names ("injection moulded", "laser cut") for briefs and chat.

import { Fn, Obj, Vec, typeName, type CallCtx, type Value } from "../lang/values";
import { MAX_DIRECTIONS, MAX_TOOLS, PROCESSES, PROCESS_IDS, isProcessId, resolveRules, ruleFields, resolvedSettings, sanitizeSettings, sortTools, uniqueDirs, type SettingDef } from "./profiles";
import { defaultMaterial, materialInfo } from "./materials";
import type { ProcessId, ProcessSpec, SettingValue, Tool } from "./types";
import type { V3 } from "../kernel/recipe";
import type { EvalPart, Model } from "../core/model";
import { PLIES_KIND, type PliesSpec } from "../analysis/spec";

export type { ProcessId, ProcessSpec };

/** A process value: what mfg.fdm(...) returns. Its fields are the numbers a design can use. */
export class ProcessV extends Obj {
  constructor(public spec: ProcessSpec) {
    super(processFields(spec), "process", `mfg.${spec.id}`);
  }
}

/** process.min_wall, process.draft, process.tool_d...: settings and the rule numbers that follow from them. */
function processFields(spec: ProcessSpec): Record<string, Value> {
  const fields: Record<string, Value> = { id: spec.id, label: PROCESSES[spec.id].label };
  for (const [k, v] of Object.entries(resolvedSettings(spec))) {
    if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") fields[k] = v;
    else if (Array.isArray(v) && typeof v[0] === "number") fields[k] = new Vec(v as number[]);
  }
  const material = spec.material ?? defaultMaterial(spec.id);
  fields.material = material;
  if (spec.machine) fields.machine = spec.machine;
  Object.assign(fields, ruleFields(resolveRules(spec, material)));
  return fields;
}

/** The mfg namespace: one function per process, taking named settings. */
export function mfgNamespace(): Obj {
  const fns: Record<string, Value> = {};
  for (const id of PROCESS_IDS) {
    const def = PROCESSES[id];
    const keys = def.settings.map((s) => s.key);
    const doc = `mfg.${id}(${[...keys.map((k) => `${k}:`), "material:", "machine:"].join(" ")}) — ${def.label}. ${def.summary}`;
    fns[id] = new Fn(`mfg.${id}`, (pos, named, ctx) => new ProcessV(specFromArgs(id, pos, named, ctx)), doc);
  }
  return new Obj(fns, "manufacturing processes", "mfg");
}

function specFromArgs(id: ProcessId, pos: Value[], named: Record<string, Value>, ctx: CallCtx): ProcessSpec {
  const def = PROCESSES[id];
  const fname = `mfg.${id}`;
  if (pos.length) ctx.error(`${fname}() takes named settings, for example ${fname}(${def.settings[0] ? `${def.settings[0].key}: …` : `material: "…"`})`);
  const settings: Record<string, SettingValue> = {};
  let material: string | undefined;
  let machine: string | undefined;
  for (const [k, v] of Object.entries(named)) {
    if (k === "material") {
      if (typeof v !== "string") ctx.error(`${fname}(): material should be a name such as "ABS", got ${typeName(v)}`);
      material = v as string;
      continue;
    }
    if (k === "machine") {
      if (typeof v !== "string" || !v.trim()) ctx.error(`${fname}(): machine should be the name of a machine or shop from Settings → Making, such as "Prusa MK4", got ${typeName(v)}`);
      machine = (v as string).trim();
      continue;
    }
    const sd = def.settings.find((s) => s.key === k);
    if (!sd) ctx.error(`${fname}() has no setting "${k}". It accepts: ${[...def.settings.map((s) => s.key), "material", "machine"].join(", ")}`);
    settings[k] = settingValue(sd!, v, fname, ctx);
  }
  return { id, settings, ...(material ? { material } : {}), ...(machine ? { machine } : {}) };
}

function settingValue(sd: SettingDef, v: Value, fname: string, ctx: CallCtx): SettingValue {
  const what = `${fname}(): ${sd.key} (${sd.doc})`;
  switch (sd.kind) {
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v)) return ctx.error(`${what} should be a number, got ${typeName(v)}`);
      if (v < 0) return ctx.error(`${what} cannot be negative`);
      return v;
    case "bool":
      if (typeof v !== "boolean") return ctx.error(`${what} should be true or false, got ${typeName(v)}`);
      return v;
    case "dir":
      return direction(v, what, ctx);
    case "dirs": {
      const list = Array.isArray(v) ? v : [v];
      if (!list.length) return ctx.error(`${what} needs at least one direction`);
      const dirs = uniqueDirs(list.map((d) => direction(d, what, ctx)));
      if (dirs.length > MAX_DIRECTIONS) return ctx.error(`${what} takes at most ${MAX_DIRECTIONS} different directions`);
      return dirs;
    }
    case "size": {
      if (!(v instanceof Vec) || v.v.length !== 3 || v.v.some((x) => !(x > 0))) return ctx.error(`${what} should be three positive sizes, for example (250, 210, 210)`);
      return v.v3();
    }
    case "choice":
      if (typeof v !== "string" || !sd.options?.includes(v)) return ctx.error(`${what} should be one of ${(sd.options ?? []).map((o) => `"${o}"`).join(", ")}`);
      return v;
    case "tools": {
      const list = Array.isArray(v) ? v : [v];
      const tools: Tool[] = [];
      for (const t of list) {
        if (!(t instanceof Vec) || t.v.length !== 2 || t.v.some((x) => !(x > 0))) return ctx.error(`${what} should be a list of (diameter, reach) pairs in mm, for example [(6, 25), (3, 12)]`);
        tools.push([t.v[0], t.v[1]]);
      }
      if (!tools.length) return ctx.error(`${what} needs at least one tool`);
      if (tools.length > MAX_TOOLS) return ctx.error(`${what} takes at most ${MAX_TOOLS} tools`);
      return sortTools(tools);
    }
    case "plies": {
      const example = 'like plies: [plies("0", "carbon woven"), plies("[0/±45/90]s"), plies("[0/90]2", zone: zone(at: (0, 0, 0), r: 45), name: "bottom bracket")]';
      const stacks: PliesSpec[] = [];
      for (const x of Array.isArray(v) ? v : [v]) {
        if (!(x instanceof Obj) || x.kind !== PLIES_KIND) return ctx.error(`${fname}(): plies: is the ply schedule, plies("[0/±45/90]s") or a list of them laid from the outer surface in, ${example}; got ${typeName(x)}`);
        const p = x.fields.spec as unknown as PliesSpec;
        if (p.part) return ctx.error(`${fname}(): plies: are this part's own, so leave part: out of ${p.label}`);
        if (p.zone?.t === "extreme") return ctx.error(`${fname}(): ${p.label}: zone: should be a zone(...) or a face(part, dir)`);
        stacks.push(p);
      }
      if (!stacks.length) return ctx.error(`${fname}(): plies: needs at least one plies(...), ${example}`);
      if (stacks.every((p) => p.zone)) return ctx.error(`${fname}(): plies: has only zones' plies, which go inside the stack over the whole part: give that stack too, ${example}`);
      return stacks;
    }
  }
}

function direction(v: Value, what: string, ctx: CallCtx): V3 {
  if (!(v instanceof Vec)) return ctx.error(`${what} should be a direction such as Z, -Z or X, got ${typeName(v)}`);
  const d = v.v3();
  const l = Math.hypot(...d);
  if (l < 1e-9) return ctx.error(`${what} cannot be a zero vector`);
  // + 0 turns the -0 of a negated axis into 0
  return [d[0] / l + 0, d[1] / l + 0, d[2] / l + 0];
}

/**
 * A part's process: from mfg.fdm(...) or a name ("cnc_mill", or plain words
 * such as "injection moulded"). Errors say what is accepted.
 */
export function toProcess(v: Value, error: (msg: string) => never): ProcessSpec {
  if (v instanceof ProcessV) return v.spec;
  if (typeof v === "string") {
    const id = processFromText(v);
    if (id) return { id, settings: {} };
    return error(`process: "${v}" is not a process Kerf knows. Use one of ${PROCESS_IDS.map((p) => `"${p}"`).join(", ")}, or mfg.${PROCESS_IDS[0]}(...) to give settings`);
  }
  return error(`process: expected mfg.fdm(...), mfg.cnc_mill(...) or a process name, got ${typeName(v)}`);
}

/**
 * Lenient conversion for other features (the project brief, chat): a process
 * value, a {id, settings} object, a process id or plain words. Null if none.
 */
export function processFromValue(v: unknown): ProcessSpec | null {
  if (v instanceof ProcessV) return v.spec;
  if (typeof v === "string") {
    const id = processFromText(v);
    return id ? { id, settings: {} } : null;
  }
  if (v && typeof v === "object" && "id" in v && typeof (v as { id: unknown }).id === "string" && isProcessId((v as { id: string }).id)) {
    const o = v as { id: ProcessId; settings?: unknown; material?: unknown; machine?: unknown };
    return {
      id: o.id,
      settings: sanitizeSettings(o.id, o.settings),
      ...(typeof o.material === "string" && o.material ? { material: o.material } : {}),
      ...(typeof o.machine === "string" && o.machine.trim() ? { machine: o.machine.trim() } : {}),
    };
  }
  return null;
}

const ALIASES: [ProcessId, string[]][] = [
  ["cnc_lathe", ["cnc lathe", "cnc turning", "cnc turned", "lathe", "turned", "turning"]],
  ["cnc_mill", ["cnc mill", "cnc milling", "cnc milled", "cnc machined", "cnc machining", "cnc", "milled", "milling", "machined", "machining", "mill"]],
  ["injection", ["injection moulding", "injection molding", "injection moulded", "injection molded", "injection mould", "injection mold", "injection", "moulded", "molded", "moulding", "molding"]],
  ["die_cast", ["die casting", "die cast", "diecast", "die-cast", "casting", "cast"]],
  ["sheet_metal", ["sheet metal", "bent sheet", "press brake", "folded", "bent", "sheet"]],
  ["laser_cut", ["laser cutting", "laser cut", "lasercut", "waterjet", "water jet", "plasma cut", "plasma", "laser", "profile cut", "flat cut"]],
  ["sla", ["resin printed", "resin print"]],
  ["sls", ["nylon printed"]],
  ["fdm", ["fdm", "fff", "3d printed", "3d printing", "3d print", "printed", "print", "filament"]],
];

/**
 * Technologies decide the process whatever else the text says, checked in
 * this order: metal printing first ("DMLS printed" is neither FDM nor SLS,
 * though DMLS stands for direct metal laser sintering), then the castings
 * ("resin cast" is vacuum casting, not SLA; "sand cast, then machined" is a
 * casting), then the plastic printing technologies ("SLA printed" is SLA).
 */
const TECHNOLOGIES: [ProcessId, string[]][] = [
  [
    "metal_print",
    [
      "dmls",
      "slm",
      "lpbf",
      "l pbf",
      "metal printed",
      "metal printing",
      "metal print",
      "metal 3d printed",
      "metal 3d printing",
      "metal 3d print",
      "metal additive",
      "laser powder bed",
      "direct metal laser sintering",
      "direct metal laser melting",
      "selective laser melting",
      "laser melted",
    ],
  ],
  [
    "vacuum_cast",
    [
      "vacuum cast",
      "vacuum casting",
      "vacuum casted",
      "urethane cast",
      "urethane casting",
      "polyurethane cast",
      "polyurethane casting",
      "pu cast",
      "pu casting",
      "resin cast",
      "resin casting",
      "silicone mould",
      "silicone mold",
      "silicone moulds",
      "silicone molds",
      "rtv mould",
      "rtv mold",
    ],
  ],
  ["carbon_layup", ["carbon layup", "carbon fibre layup", "carbon fiber layup", "carbon lay-up", "prepreg", "bladder moulded", "bladder molded", "carbon monocoque", "moulded carbon", "molded carbon", "cfrp moulded", "cfrp molded"]],
  ["investment_cast", ["investment cast", "investment casting", "investment casted", "lost wax", "precision cast", "precision casting"]],
  ["sand_cast", ["sand cast", "sand casting", "sand casted", "sandcast", "green sand", "no bake", "nobake", "lost foam"]],
  ["sla", ["sla", "msla", "dlp", "lcd resin", "resin", "stereolithography", "polyjet"]],
  ["sls", ["sls", "mjf", "multi jet fusion", "powder bed", "sintered", "sintering", "laser sintered", "selective laser sintering"]],
];

/** A printing word next to a metal, with no plastic named, means metal printing: "3D printed titanium", "316L printed". */
const METALS = "metal|titanium|ti64|stainless|steel|inconel|alsi10mg|aluminium|aluminum|cobalt chrome|copper|316l";
const PRINTED_METAL = new RegExp(` (?:3d )?print(?:ed|ing)?(?: in)? (?:${METALS}) | (?:${METALS})(?: steel)? (?:3d )?print(?:ed|ing)? `);
const PLASTICS = ["plastic", "filament", "fdm", "fff", "pla", "petg", "abs", "asa", "nylon", "tpu", "pc", "pa", "cf"];

/** Processes Kerf has no rules for, which would otherwise read as one it has ("binder jetted steel" is not FDM). */
const UNSUPPORTED = ["binder jet", "binder jetted", "binder jetting"];

/** "injection moulded" → "injection", "laser cut" → "laser_cut". Null when nothing matches. */
export function processFromText(text: string): ProcessId | null {
  const raw = text.trim().toLowerCase();
  if (isProcessId(raw)) return raw;
  // process source written as text, as in the brief: mfg.cnc_lathe(...)
  const src = /^mfg\.([a-z_]+)\b/.exec(raw);
  if (src && isProcessId(src[1])) return src[1];
  const s = ` ${raw
    .replace(/[_\-/]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
  if (isProcessId(s.trim().replace(/ /g, "_"))) return s.trim().replace(/ /g, "_") as ProcessId;
  const has = (n: string) => s.includes(` ${n} `);
  if (UNSUPPORTED.some(has)) return null;
  for (const [id, names] of TECHNOLOGIES) if (names.some(has)) return id;
  // the longest alias found as whole words wins, so "cnc lathe" beats "cnc"
  let best: { id: ProcessId; len: number } | null = null;
  for (const [id, names] of ALIASES) {
    for (const n of names) {
      if (has(n) && (!best || n.length > best.len)) best = { id, len: n.length };
    }
  }
  if (best?.id === "fdm" && PRINTED_METAL.test(s) && !PLASTICS.some(has)) return "metal_print";
  return best?.id ?? null;
}

/** The material a part with this process ends up with. */
export function partMaterial(material: string | undefined, spec: ProcessSpec | undefined): string {
  return material ?? spec?.material ?? (spec ? defaultMaterial(spec.id) : "PLA");
}

/**
 * Design-wide defaults from the project brief's "how it's made". Custom parts
 * that name no process get the brief's (marked processInherited), unless
 * they say process: false or their own material cannot be made that way: a
 * steel shaft in a printed design is bought or made another way. Parts that name neither a material
 * nor a process of their own take the brief's material, or else the
 * process's usual one. A build volume becomes the bed of every printing
 * process that does not set one, explicit or inherited.
 */
export function applyDefaultProcess(model: Model, spec: ProcessSpec | null, opts: { buildVolume?: V3; material?: string } = {}): void {
  for (const p of model.parts) {
    if (p.kind !== "part" || p.processNone) continue;
    const own = !!p.process;
    if (!own && spec && (!p.materialSpan || suits(p.material, spec.id))) {
      p.process = { ...spec, settings: { ...spec.settings } };
      p.processInherited = true;
    }
    if (!own && !p.materialSpan) {
      const m = p.process ? (p.process.material ?? opts.material ?? defaultMaterial(p.process.id)) : opts.material;
      if (m) p.material = m;
    }
    const bedless = p.process && PROCESSES[p.process.id].family === "additive" && PROCESSES[p.process.id].settings.some((s) => s.key === "bed") && p.process.settings.bed === undefined;
    if (bedless && opts.buildVolume) {
      p.process = { ...p.process!, settings: { ...p.process!.settings, bed: opts.buildVolume } };
      p.processDefaults = [...(p.processDefaults ?? []), "bed"];
    }
  }
}

/** Whether a part's own material can be made by a process (unknown materials get the benefit of the doubt). */
function suits(material: string, id: ProcessId): boolean {
  const info = materialInfo(material);
  return info.family === "unknown" || info.processes.includes(id);
}

/** The part's process as its own source states it: without settings filled in from design-wide defaults. */
export function ownProcess(part: EvalPart): ProcessSpec | undefined {
  if (!part.process || !part.processDefaults?.length) return part.process;
  const settings = { ...part.process.settings };
  for (const k of part.processDefaults) delete settings[k];
  return { ...part.process, settings };
}
