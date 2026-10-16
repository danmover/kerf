// How a part says it is made, in the design language: the mfg.* functions
// (mfg.cnc_mill(tool_d: 2)), the "cnc_mill" shorthand, and plain-language
// process names ("injection moulded", "laser cut") for briefs and chat.

import { Fn, Obj, Vec, typeName, type CallCtx, type Value } from "../lang/values";
import { PROCESSES, PROCESS_IDS, isProcessId, resolveRules, ruleFields, resolvedSettings, type SettingDef } from "./profiles";
import { defaultMaterial } from "./materials";
import type { ProcessId, ProcessSpec, SettingValue } from "./types";
import type { V3 } from "../kernel/recipe";

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
    if (typeof v === "number" || typeof v === "boolean") fields[k] = v;
    else if (Array.isArray(v) && typeof v[0] === "number") fields[k] = new Vec(v as number[]);
  }
  const material = spec.material ?? defaultMaterial(spec.id);
  fields.material = material;
  Object.assign(fields, ruleFields(resolveRules(spec, material)));
  return fields;
}

/** The mfg namespace: one function per process, taking named settings. */
export function mfgNamespace(): Obj {
  const fns: Record<string, Value> = {};
  for (const id of PROCESS_IDS) {
    const def = PROCESSES[id];
    const keys = def.settings.map((s) => s.key);
    const doc = `mfg.${id}(${[...keys.map((k) => `${k}:`), "material:"].join(" ")}) — ${def.label}. ${def.summary}`;
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
  for (const [k, v] of Object.entries(named)) {
    if (k === "material") {
      if (typeof v !== "string") ctx.error(`${fname}(): material should be a name such as "ABS", got ${typeName(v)}`);
      material = v as string;
      continue;
    }
    const sd = def.settings.find((s) => s.key === k);
    if (!sd) ctx.error(`${fname}() has no setting "${k}". It accepts: ${[...def.settings.map((s) => s.key), "material"].join(", ")}`);
    settings[k] = settingValue(sd!, v, fname, ctx);
  }
  return material ? { id, settings, material } : { id, settings };
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
      return list.map((d) => direction(d, what, ctx));
    }
    case "size": {
      if (!(v instanceof Vec) || v.v.length !== 3 || v.v.some((x) => !(x > 0))) return ctx.error(`${what} should be three positive sizes, for example (250, 210, 210)`);
      return v.v3();
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
    const o = v as { id: ProcessId; settings?: Record<string, SettingValue>; material?: string };
    return { id: o.id, settings: { ...(o.settings ?? {}) }, ...(o.material ? { material: o.material } : {}) };
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
  ["sla", ["sla", "msla", "dlp", "resin printed", "resin print", "resin"]],
  ["sls", ["sls", "mjf", "multi jet fusion", "powder bed", "nylon printed"]],
  ["fdm", ["fdm", "fff", "3d printed", "3d printing", "3d print", "printed", "print", "filament"]],
];

/** "injection moulded" → "injection", "laser cut" → "laser_cut". Null when nothing matches. */
export function processFromText(text: string): ProcessId | null {
  const raw = text.trim().toLowerCase();
  if (isProcessId(raw)) return raw;
  const s = ` ${raw
    .replace(/[_\-/]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
  if (isProcessId(s.trim().replace(/ /g, "_"))) return s.trim().replace(/ /g, "_") as ProcessId;
  // the longest alias found as whole words wins, so "cnc lathe" beats "cnc"
  let best: { id: ProcessId; len: number } | null = null;
  for (const [id, names] of ALIASES) {
    for (const n of names) {
      if (s.includes(` ${n} `) && (!best || n.length > best.len)) best = { id, len: n.length };
    }
  }
  return best?.id ?? null;
}

/** The material a part with this process ends up with. */
export function partMaterial(material: string | undefined, spec: ProcessSpec | undefined): string {
  return material ?? spec?.material ?? (spec ? defaultMaterial(spec.id) : "PLA");
}
