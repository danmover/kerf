// UI-side glue between the design model and the process checks: which parts
// to analyse against which rules, and how findings read in the check report.

import type { EvalPart, Model } from "../core/model";
import type { CheckItem } from "../core/checks";
import { PROCESSES, PROCESS_IDS, resolveRules } from "./profiles";
import { defaultMaterial, materialFit } from "./materials";
import { NO_MACHINES, machineForSpec, specOnMachine, type MachineContext } from "./machines";
import type { FindingStatus, ProcessFinding, ProcessId, ProcessProbe, ProcessResult, ProcessSpec, Rules } from "./types";

/** Parts that are made rather than bought: custom parts, not library components. */
export const madeParts = (model: Model) => model.parts.filter((p) => p.kind === "part");

/** The rules a part is held to: its process on the machine it is made on (the part's own, or the user's for that process). */
export function rulesOnMachine(spec: ProcessSpec, material: string, machines: MachineContext = NO_MACHINES): Rules {
  const on = specOnMachine(spec, machines);
  const rules = resolveRules(on.spec, material);
  return on.machine ? { ...rules, machine: on.machine } : rules;
}

/** One probe per part with a process, for the parts whose geometry is built. */
export function processProbes(model: Model, builtHashes: Set<string>, machines: MachineContext = NO_MACHINES): ProcessProbe[] {
  return madeParts(model)
    .filter((p) => p.process && builtHashes.has(p.hash))
    .map((p) => ({ id: p.id, hash: p.hash, rules: withSheetForms(rulesOnMachine(p.process!, p.material, machines), p) }));
}

/** A sheet() part's hems and louvres, for the sheet checks to judge as forms rather than as tight bends and odd walls. */
function withSheetForms(rules: Rules, p: EvalPart): Rules {
  if (!rules.sheet || !p.sheet) return rules;
  const hems = p.sheet.bends.filter((b) => / hem$/.test(b.name)).map((b) => b.r);
  const louvres = (p.sheet.forms ?? []).map((f) => ({ c: f.box.c, axes: f.box.axes, half: f.box.half }));
  return hems.length || louvres.length ? { ...rules, sheet: { ...rules.sheet, forms: { hems, louvres } } } : rules;
}

/** Probes for checking one part against every process, for comparing them: each on the user's machine for it. */
export function compareProbes(part: EvalPart, ids: ProcessId[] = PROCESS_IDS, machines: MachineContext = NO_MACHINES): ProcessProbe[] {
  return ids.map((id) => {
    const own = part.process?.id === id;
    const spec: ProcessSpec = own ? part.process! : { id, settings: {} };
    // a material that does not suit the process would skew its rules: compare with the usual one
    const material = own || materialFit(part.material, id).status === "pass" ? part.material : defaultMaterial(id);
    return { id, hash: part.hash, rules: rulesOnMachine(spec, material, machines) };
  });
}

export interface ProcessSummary {
  fail: number;
  warn: number;
  pass: number;
  /** titles of the failing and warning findings, worst first */
  issues: string[];
}

export function summarize(r: ProcessResult | undefined): ProcessSummary | null {
  if (!r || r.error) return null;
  const s: ProcessSummary = { fail: 0, warn: 0, pass: 0, issues: [] };
  for (const f of sorted(r.findings)) {
    if (f.status === "fail") s.fail++;
    else if (f.status === "warn") s.warn++;
    else if (f.status === "pass") s.pass++;
    if (f.status === "fail" || f.status === "warn") s.issues.push(f.title);
  }
  return s;
}

const RANK: Record<FindingStatus, number> = { fail: 0, warn: 1, info: 2, pass: 3 };
export const sorted = (fs: ProcessFinding[]) => [...fs].sort((a, b) => RANK[a.status] - RANK[b.status]);

/** Check id for one finding on one part; the viewport overlay reads these back. */
export const findingId = (partId: string, rule: string, n = 0) => `mfg:${partId}:${rule}${n ? `#${n}` : ""}`;

export function parseFindingId(id: string): { part: string; rule: string; n: number } | null {
  const m = /^mfg:(.+):([a-z-]+)(?:#(\d+))?$/.exec(id);
  return m ? { part: m[1], rule: m[2], n: m[3] ? Number(m[3]) : 0 } : null;
}

/** The finding a check id points at. */
export function findingFor(id: string, results: Record<string, ProcessResult>): { part: string; finding: ProcessFinding } | null {
  const ref = parseFindingId(id);
  if (!ref) return null;
  const r = results[ref.part];
  if (!r) return null;
  const same = r.findings.filter((f) => f.rule === ref.rule);
  const finding = same[ref.n];
  return finding ? { part: ref.part, finding } : null;
}

/** Check report items for the manufacturing processes. */
export function processItems(model: Model, results: Record<string, ProcessResult> | null, buildErrors?: Map<string, string>, machines: MachineContext = NO_MACHINES): CheckItem[] {
  const items: CheckItem[] = [];
  const made = madeParts(model).filter((p) => !p.hidden);
  const withProcess = made.filter((p) => p.process);
  // one item per instance would repeat itself for patterned parts: report each part block once
  const seen = new Set<string>();
  for (const p of withProcess) {
    const spec = p.process!;
    const def = PROCESSES[spec.id];
    const key = `${p.name}|${p.hash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const span = p.processSpan ?? p.span;
    const base = { category: "process" as const, parts: [p.id], span, basis: "geometry" as const };

    const fit = materialFit(p.material, spec.id);
    if (fit.status !== "pass") {
      items.push({ ...base, id: `mfg:${p.id}:material`, status: fit.status, title: `${p.label}: ${p.material} for ${def.short}`, detail: fit.detail, basis: "parameters" });
    }
    const { missing } = machineForSpec(spec, machines);
    if (missing)
      items.push({
        ...base,
        id: `mfg:${p.id}:machine`,
        status: "warn",
        title: `${p.label}: no machine called "${missing}"`,
        detail: `Checked against a typical ${def.short} shop instead. Add the machine in Settings → Making, or name one that is there.`,
        basis: "parameters",
      });

    const r = results?.[p.id];
    if (!r && buildErrors?.has(p.hash)) {
      items.push({ ...base, id: `mfg:${p.id}:pending`, status: "info", title: `${p.label}: ${def.label}`, detail: "Checked once the part builds" });
      continue;
    }
    if (!r) {
      if (results) items.push({ ...base, id: `mfg:${p.id}:pending`, status: "pending", title: `${p.label}: ${def.label}`, detail: "Waiting for the part to build" });
      continue;
    }
    if (r.error) {
      items.push({ ...base, id: `mfg:${p.id}:error`, status: "warn", title: `${p.label}: ${def.label} check did not run`, detail: r.error });
      continue;
    }
    const count = new Map<string, number>();
    const passes: string[] = [];
    for (const f of r.findings) {
      const n = count.get(f.rule) ?? 0;
      count.set(f.rule, n + 1);
      if (f.status === "pass") {
        passes.push(f.title);
        continue;
      }
      items.push({
        ...base,
        id: findingId(p.id, f.rule, n),
        status: f.status,
        title: `${p.label}: ${f.title}`,
        detail: f.detail,
        fix: f.fix,
        action: f.alt ? { kind: "process-setting", label: f.alt.label, part: p.id, setting: f.alt.setting, value: f.alt.value } : undefined,
      });
    }
    const issues = r.findings.some((f) => f.status === "fail" || f.status === "warn");
    if (passes.length) {
      items.push({
        ...base,
        id: `mfg:${p.id}:ok`,
        status: "pass",
        title: issues ? `${p.label}: ${passes.length} more ${def.short} rules pass` : `${p.label} suits ${def.label}`,
        detail: passes.join(" · "),
      });
    }
  }

  const without = [...new Set(made.filter((p) => !p.process).map((p) => p.label))];
  if (made.length && !withProcess.length) {
    items.push({
      id: "mfg:none",
      category: "process",
      status: "info",
      title: "No manufacturing process chosen",
      detail: "Pick how each part is made (3D printing, CNC, moulding, sheet metal…) under Manufacturing, and Kerf checks it against that process's rules.",
      basis: "parameters",
    });
  } else if (without.length) {
    items.push({
      id: "mfg:unset",
      category: "process",
      status: "info",
      title: `${without.length === 1 ? "1 part has" : `${without.length} parts have`} no process`,
      detail: `${without.slice(0, 6).join(", ")}${without.length > 6 ? ` and ${without.length - 6} more` : ""} ${without.length === 1 ? "is" : "are"} not checked for manufacture.`,
      basis: "parameters",
    });
  }
  return items;
}
