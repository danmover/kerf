// Trying other versions of the design side by side. Claude describes two to
// four alternatives as edits or parameter values; Kerf builds, checks and
// measures each one in a geometry worker of its own, next to the current
// design, and runs the structural analyses that cover the changed parts at a
// draft resolution. The design itself does not change, so choosing between
// concepts rests on numbers and costs one step instead of an edit, check and
// undo for each. edit_design applies the chosen one by its label.

import { z } from "zod";
import { evaluate } from "../lang/evaluator";
import { fmtNum } from "../lang/values";
import { applyTextEdits } from "../core/sourceEdit";
import { paramEdits, applySpanEdits } from "../core/decisions";
import type { EvalPart, Model } from "../core/model";
import type { CheckItem, CheckReport } from "../core/checks";
import { materialDensity } from "../library/standards";
import type { MeasuredResult } from "../agents/isolated";
import type { PartInspection } from "../kernel/inspect";
import { resolveThermal, structuralChecks, structuralInput } from "../analysis/runtime";
import type { StructuralSpec } from "../analysis/spec";
import type { StructuralInput, StructuralResult } from "../analysis/fe/structural";
import { structuralVerdict } from "../analysis/summary";
import { MAX_SOURCE_CHARS } from "../persist/files";
import { openBranch } from "./plan";
import type { ToolOutcome } from "./tools";

// no generated code: the page CSP forbids eval
z.config({ jitless: true });

export const COMPARE_TOOL = {
  name: "compare_designs",
  description:
    "Try two to four alternative versions of the design side by side without changing it. Give each alternative a short label, the idea behind it, and the edits (as in edit_design) and/or parameter values that make it from the current source. Kerf builds and checks each one in its own geometry worker next to the current design, and for the parts that differ reports mass, size, thinnest wall and print support, plus every structural analysis covering them at draft resolution (safety factor, peak stress, deflection), and which checks each alternative newly fails or fixes. Use it to choose between real concepts on numbers; then apply the winner with edit_design alternative: \"<label>\". Takes about as long as building the design once per alternative, plus the analyses.",
  input_schema: {
    type: "object" as const,
    properties: {
      alternatives: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "One to four words, unique, e.g. 'Ribbed channel'." },
            idea: { type: "string", description: "The concept in one sentence: what is different and why it might be better." },
            edits: {
              type: "array",
              maxItems: 40,
              description: "Exact replacements on the current source, as in edit_design.",
              items: {
                type: "object",
                properties: { old_text: { type: "string" }, new_text: { type: "string" } },
                required: ["old_text", "new_text"],
                additionalProperties: false,
              },
            },
            set: { type: "object", description: "Parameter values, by name, applied after the edits, e.g. {\"wall\": 2.4}.", additionalProperties: { type: ["number", "string", "boolean"] } },
          },
          required: ["label"],
          additionalProperties: false,
        },
      },
      parts: { type: "array", items: { type: "string" }, maxItems: 20, description: "Parts to measure as well as the ones that differ." },
      analyse: { type: "boolean", description: "Run the structural analyses that cover the changed parts (default true)." },
      unlock_ok: { type: "boolean", description: "Set true only when the user explicitly asked to change a locked parameter or component." },
    },
    required: ["alternatives"],
    additionalProperties: false,
  },
};

export const COMPARE_TITLE = "Comparing designs";

const Alternative = z.object({
  label: z.string().trim().min(1).max(40),
  idea: z.string().max(400).optional(),
  edits: z.array(z.object({ old_text: z.string().max(MAX_SOURCE_CHARS), new_text: z.string().max(MAX_SOURCE_CHARS) })).max(40).optional(),
  set: z.record(z.string().max(80), z.union([z.number(), z.string().max(200), z.boolean()])).optional(),
});
export const CompareInput = z.object({
  alternatives: z.array(Alternative).min(1).max(4),
  parts: z.array(z.string().max(80)).max(20).optional(),
  analyse: z.boolean().optional(),
  unlock_ok: z.boolean().optional(),
});

export interface CompareDeps {
  /** the design as it is, once built and checked */
  current(): Promise<{ source: string; model: Model | null; report: CheckReport | null }>;
  /** build, check and measure a source away from the design */
  measure(src: string, inspect: (m: Model) => string[], onStage?: (s: string) => void): Promise<MeasuredResult>;
  solve(input: StructuralInput, signal?: AbortSignal): Promise<StructuralResult>;
  /** items the user locked or stated that this change touches */
  locked(before: string, after: string): string[];
}

/** analyses run per design at most, and the time all of them may take together */
const MAX_ANALYSES = 3;
const ANALYSIS_BUDGET_MS = 240_000;

/** The alternatives of the last comparison, so edit_design can apply one by its label. */
let last: { base: string; sources: Map<string, string> } | null = null;

/** The source of an alternative from the last comparison; an error when there is none or the design changed since. */
export function alternativeSource(label: string, current: string): { src?: string; error?: string } {
  const src = last?.sources.get(label.trim().toLowerCase());
  if (!last || !src) return { error: `There is no alternative "${label}" from compare_designs${last?.sources.size ? ` (there are: ${[...last.sources.keys()].join(", ")})` : ""}. Send the edits instead.` };
  if (last.base !== current) return { error: `The design changed since compare_designs ran, so alternative "${label}" no longer applies as it was measured. Send its edits instead, or compare again.` };
  return { src };
}

export function forgetAlternatives() {
  last = null;
}

interface Design {
  label: string;
  idea?: string;
  src: string;
  /** set when the alternative could not be made or evaluated */
  error?: string;
  model?: Model;
  built?: MeasuredResult;
  analyses: { spec: StructuralSpec; result?: StructuralResult; error?: string }[];
  /** the checks, with the analyses' verdicts in place of their placeholders */
  items: CheckItem[];
}

/** Make an alternative's source: its edits, then its parameter values. */
function makeSource(base: string, alt: z.infer<typeof Alternative>): { src: string; error?: string } {
  let src = base;
  if (alt.edits?.length) {
    const r = applyTextEdits(src, alt.edits);
    if (r.errors.length) return { src, error: `its edits could not be applied: ${r.errors.join(" ")}` };
    src = r.src;
  }
  if (alt.set && Object.keys(alt.set).length) {
    const m = evaluate(src, { skipGeometry: true });
    const { edits, missing } = paramEdits(m, alt.set);
    if (missing.length) return { src, error: `there is no parameter named ${missing.join(", ")}` };
    src = applySpanEdits(src, edits);
  }
  if (src.length > MAX_SOURCE_CHARS) return { src, error: "the source would exceed the 300,000 character limit" };
  if (src === base && (alt.edits?.length || alt.set)) return { src, error: "it is the same as the current design" };
  return { src };
}

const made = (m: Model) => m.parts.filter((p) => p.kind === "part");

/** Parts whose geometry, placement or material differ from the current design in any alternative. */
function changedParts(current: Model, others: Model[]): string[] {
  const key = (p: EvalPart) => `${p.hash}|${JSON.stringify(p.xf)}|${p.material}`;
  const now = new Map(made(current).map((p) => [p.id, key(p)]));
  const out = new Set<string>();
  for (const m of others) {
    const ids = new Set<string>();
    for (const p of made(m)) {
      ids.add(p.id);
      if (now.get(p.id) !== key(p)) out.add(p.name);
    }
    for (const p of made(current)) if (!ids.has(p.id)) out.add(p.name);
  }
  return [...out];
}

export async function compareDesigns(input: unknown, deps: CompareDeps, signal?: AbortSignal): Promise<ToolOutcome> {
  const p = CompareInput.safeParse(input);
  if (!p.success) {
    const msg = p.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return { isError: true, content: `Invalid tool input: ${msg}`, card: { title: "Invalid tool input", detail: msg, status: "error" } };
  }
  const labels = p.data.alternatives.map((a) => a.label.toLowerCase());
  const dup = labels.find((l, i) => labels.indexOf(l) !== i || l === "current");
  if (dup) return { isError: true, content: `Give each alternative its own label (not "current"); "${dup}" is used twice or is reserved.`, card: { title: "Labels must differ", status: "error" } };

  const now = await deps.current();
  if (!now.model) return { isError: true, content: "There is no design to compare against yet. Write one first.", card: { title: "No design yet", status: "error" } };
  if (now.model.diagnostics.some((d) => d.severity === "error")) return { isError: true, content: "The current design has source errors. Fix them first: the alternatives are measured against it.", card: { title: "Fix the design first", status: "error" } };

  const designs: Design[] = [{ label: "Current", src: now.source, model: now.model, analyses: [], items: [] }];
  for (const a of p.data.alternatives) {
    const { src, error } = makeSource(now.source, a);
    const d: Design = { label: a.label, idea: a.idea, src, error, analyses: [], items: [] };
    if (!error && !p.data.unlock_ok) {
      const locked = deps.locked(now.source, src);
      if (locked.length) d.error = `it changes what the user locked or stated (${locked.join(", ")}); keep them, or set unlock_ok only if the user asked for that change`;
    }
    if (!d.error) {
      d.model = evaluate(src);
      const errs = d.model.diagnostics.filter((x) => x.severity === "error");
      if (errs.length) d.error = `source error${errs.length > 1 ? "s" : ""}: ${errs.slice(0, 3).map((x) => x.message).join("; ")}`;
    }
    designs.push(d);
  }

  const evaluated = designs.slice(1).filter((d) => !d.error).map((d) => d.model!);
  const measured = [...new Set([...changedParts(now.model, evaluated), ...(p.data.parts ?? [])])];
  const pick = (m: Model) => [...new Set(m.parts.filter((x) => measured.includes(x.name)).map((x) => x.hash))];

  const tree = planBranch(designs);
  // the current design is built in a worker too, so every number comes from the same kind of build
  await Promise.all(
    designs.map(async (d, i) => {
      if (d.error) return tree.step(i, "blocked", d.error);
      tree.step(i, "doing", "Building");
      try {
        d.built = await deps.measure(d.src, pick, (s) => tree.step(i, "doing", s));
        d.model = d.built.model;
        d.items = d.built.report?.items ?? [];
        if (d.built.error && !d.built.report) d.error = d.built.error;
      } catch (e) {
        d.error = e instanceof Error ? e.message : String(e);
      }
      tree.step(i, d.error ? "blocked" : "doing", d.error ? d.error : "Built and checked");
    }),
  );
  if (signal?.aborted) {
    tree.finish("blocked", "Stopped");
    return { isError: true, content: "Stopped by the user before the comparison finished.", card: { title: "Comparison stopped", status: "error" } };
  }

  // structural analyses of the parts that differ, at draft resolution so every design is solved the same way
  const deadline = Date.now() + ANALYSIS_BUDGET_MS;
  let skipped = 0;
  if (p.data.analyse !== false && measured.length) {
    for (const [i, d] of designs.entries()) {
      if (d.error || !d.built) continue;
      const specs = d.model!.analyses.filter((a): a is StructuralSpec => a.kind === "structural" && a.parts.some((n) => measured.includes(n))).slice(0, MAX_ANALYSES);
      for (const spec of specs) {
        if (signal?.aborted) break;
        if (Date.now() > deadline) {
          skipped++;
          continue;
        }
        tree.step(i, "doing", `Analysing ${spec.label}`);
        // a part that did not build has no mesh, which structuralInput reports as null
        // heat: "auto" and the surroundings come from the design, as they do for the analysis tab
        const prep = structuralInput(resolveThermal({ ...spec, resolution: "draft" }, d.model!), d.model!.parts.filter((q) => spec.parts.includes(q.name)), false, new Map(), (h) => d.built!.parts.get(h)?.mesh);
        if (!prep) d.analyses.push({ spec, error: "its parts did not build" });
        else if (prep.error) d.analyses.push({ spec, error: prep.error });
        else
          try {
            d.analyses.push({ spec, result: await deps.solve(prep.input!, signal) });
          } catch (e) {
            d.analyses.push({ spec, error: e instanceof Error ? e.message : String(e) });
          }
        const a = d.analyses[d.analyses.length - 1];
        d.items = [...d.items.filter((it) => !it.id.startsWith(`fea:${spec.label}:`)), ...structuralChecks(spec, d.model!, a)];
      }
    }
  }

  last = { base: now.source, sources: new Map(designs.slice(1).filter((d) => !d.error).map((d) => [d.label.toLowerCase(), d.src])) };

  const base = designs[0];
  const lines: string[] = [];
  const ok = designs.slice(1).filter((d) => !d.error);
  lines.push(
    `Compared ${designs.length - 1} alternative${designs.length > 2 ? "s" : ""} with the current design; each was built and checked on its own, and the design is unchanged.` +
      (measured.length ? ` Measured: ${measured.join(", ")}.` : " No part's geometry differs, so only the checks are compared."),
  );
  if (designs.some((d) => d.analyses.length)) lines.push("Structural results are at draft resolution (about 8,000 elements): right for comparing these designs with each other; confirm the one you choose with run_analysis.");
  if (skipped) lines.push(`${skipped} analys${skipped > 1 ? "es were" : "is was"} not run: the comparison's time for analyses ran out. Compare fewer alternatives, or run_analysis on the one you pick.`);
  for (const d of designs) lines.push("", ...designLines(d, d === base ? null : base, measured));
  if (ok.length) lines.push("", `To apply one, call edit_design with alternative: "<label>" and a summary (no edits needed). The labels are: ${ok.map((d) => `"${d.label}"`).join(", ")}.`);

  tree.finish(ok.length ? "done" : "blocked", ok.length ? `${ok.length} of ${designs.length - 1} built` : "None built");
  return {
    isError: !ok.length || undefined,
    content: lines.join("\n"),
    card: { title: `Compared ${designs.length - 1} design${designs.length > 2 ? "s" : ""}`, detail: designs.slice(1).map(cardLine).join(" · "), status: ok.length ? "done" : "error" },
  };
}

// ---------- reporting ----------

const counts = (items: CheckItem[]) => {
  const c = { pass: 0, fail: 0, warn: 0 };
  for (const i of items) if (i.status === "pass" || i.status === "fail" || i.status === "warn") c[i.status]++;
  return c;
};

/** Mass of a part's instances in grams, from its built volume and its material. */
function massOf(d: Design, name: string): { g: number; n: number; material: string } | null {
  const inst = d.model!.parts.filter((p) => p.name === name);
  if (!inst.length) return null;
  let g = 0;
  for (const p of inst) {
    const v = d.built?.parts.get(p.hash)?.volume;
    if (v === undefined) return null;
    g += (v / 1000) * materialDensity(p.material);
  }
  return { g, n: inst.length, material: inst[0].material };
}

function totalMass(d: Design): number | null {
  let g = 0;
  for (const p of made(d.model!)) {
    const v = d.built?.parts.get(p.hash)?.volume;
    if (v === undefined) return null;
    g += (v / 1000) * materialDensity(p.material);
  }
  return g;
}

const delta = (now: number, was: number | null | undefined, unit: string, digits = 1) => {
  if (was === null || was === undefined || Math.abs(now - was) < 10 ** -digits / 2) return "";
  const d = now - was;
  return ` (${d > 0 ? "+" : "−"}${fmtNum(Math.abs(d), digits)} ${unit}${was ? `, ${d > 0 ? "+" : "−"}${fmtNum(Math.abs((d / was) * 100), 0)} %` : ""})`;
};

function partLine(d: Design, name: string, base: Design | null): string {
  const m = massOf(d, name);
  if (!m) return `  ${name}: not in this design or did not build`;
  const p = d.model!.parts.find((x) => x.name === name)!;
  const r = d.built?.parts.get(p.hash);
  const bits: string[] = [];
  const was = base ? massOf(base, name)?.g : undefined;
  bits.push(`${m.n > 1 ? `${m.n} × ${fmtNum(m.g / m.n, 1)} g = ` : ""}${fmtNum(m.g, 1)} g ${m.material}${delta(m.g, was, "g")}`);
  if (r) bits.push(r.bbox[1].map((hi, k) => fmtNum(hi - r.bbox[0][k], 1)).join(" × ") + " mm");
  const ins = d.built?.inspections[p.hash] as PartInspection | { error: string } | undefined;
  if (ins && !("error" in ins)) {
    if (ins.walls) bits.push(`thinnest wall ${fmtNum(ins.walls.min, 2)} mm`);
    const best = [...ins.support].sort((a, b) => a.area - b.area)[0];
    if (best) bits.push(best.area < 1 ? `prints without support lying on ${best.down}` : `print support ${fmtNum(best.area, 0)} mm² at best (lying on ${best.down})`);
    if (ins.internal.count) bits.push(`${ins.internal.count} sharp inside corner${ins.internal.count > 1 ? "s" : ""}`);
  }
  return `  ${name}: ${bits.join(", ")}`;
}

function analysisLine(a: Design["analyses"][number], base: Design | null): string {
  if (!a.result) return `  "${a.spec.label}": could not be analysed: ${a.error ?? "no result"}`;
  const r = a.result;
  const was = base?.analyses.find((b) => b.spec.label === a.spec.label)?.result;
  const parts = [`${structuralVerdict(a.spec, r)}`];
  if (!a.spec.modal || a.spec.loads.length || a.spec.accel) parts.push(`safety ${fmtNum(r.minSafety.value, 2)} (target ${fmtNum(a.spec.safety, 2)}${was ? `, current ${fmtNum(was.minSafety.value, 2)}` : ""})`, `peak ${fmtNum(r.maxStress.value, 1)} MPa`, `deflection ${fmtNum(r.maxDisp.value, 3)} mm${was ? ` (current ${fmtNum(was.maxDisp.value, 3)})` : ""}`);
  if (r.modal?.modes[0]) parts.push(`first mode ${fmtNum(r.modal.modes[0].freq, 1)} Hz`);
  if (r.drop) parts.push(`${fmtNum(r.drop.g, 0)} g on landing`);
  return `  "${a.spec.label}": ${parts.join(", ")}`;
}

function designLines(d: Design, base: Design | null, measured: string[]): string[] {
  const head = base ? `"${d.label}"${d.idea ? `: ${d.idea}` : ""}` : "Current design";
  if (d.error) return [head, `  Not measured: ${d.error.replace(/\.+$/, "")}.`];
  const c = counts(d.items);
  const out = [head];
  let checks = `  Checks: ${c.pass} pass, ${c.fail} fail, ${c.warn} warn`;
  if (base) {
    const before = new Map(base.items.map((i) => [i.id, i.status]));
    const after = new Map(d.items.map((i) => [i.id, i.status]));
    const newFails = d.items.filter((i) => (i.status === "fail" || i.status === "warn") && before.get(i.id) !== i.status && before.get(i.id) !== "fail");
    const fixed = base.items.filter((i) => (i.status === "fail" || i.status === "warn") && after.get(i.id) !== "fail" && after.get(i.id) !== i.status);
    if (newFails.length) checks += `. New problems: ${newFails.slice(0, 8).map((i) => `[${i.status}] ${i.title}: ${i.detail}`).join("; ")}`;
    if (fixed.length) checks += `. Fixed: ${fixed.slice(0, 8).map((i) => i.title).join("; ")}`;
    if (!newFails.length && !fixed.length) checks += " (same as the current design)";
  } else {
    const bad = d.items.filter((i) => i.status === "fail");
    if (bad.length) checks += `. Failing: ${bad.slice(0, 8).map((i) => i.title).join("; ")}`;
  }
  out.push(checks);
  if (d.built?.error) out.push(`  Note: ${d.built.error}`);
  for (const n of measured) out.push(partLine(d, n, base));
  const total = totalMass(d);
  const wasTotal = base ? totalMass(base) : null;
  if (total !== null && made(d.model!).length > 1) out.push(`  All made parts: ${fmtNum(total, 1)} g${delta(total, wasTotal, "g")}`);
  for (const a of d.analyses) out.push(analysisLine(a, base));
  return out;
}

function cardLine(d: Design): string {
  if (d.error) return `${d.label}: not measured`;
  const c = counts(d.items);
  const sf = d.analyses.map((a) => a.result?.minSafety.value).filter((x): x is number => x !== undefined);
  const g = totalMass(d);
  return [d.label + ":", g !== null ? `${fmtNum(g, 1)} g` : "", sf.length ? `safety ${fmtNum(Math.min(...sf), 2)}` : "", c.fail ? `${c.fail} failing` : "checks pass"].filter(Boolean).join(" ");
}

// ---------- the live plan ----------

function planBranch(designs: Design[]) {
  const branch = openBranch({ id: "compare", title: `Compare ${designs.length - 1} design${designs.length > 2 ? "s" : ""}`, agent: "compare" });
  const sid = (i: number) => `d${i}`;
  const state = designs.map((d) => ({ id: "", title: d.label === "Current" ? "Current design" : d.label, status: "todo" as "todo" | "doing" | "done" | "blocked", detail: undefined as string | undefined }));
  state.forEach((s, i) => (s.id = sid(i)));
  branch.setSteps(state);
  return {
    step(i: number, status: "doing" | "blocked", detail?: string) {
      state[i].status = status;
      state[i].detail = detail;
      branch.updateStep(sid(i), { status, detail });
    },
    finish(status: "done" | "blocked", detail: string) {
      state.forEach((s, i) => {
        if (s.status === "doing") branch.updateStep(sid(i), { status: "done", detail: cardLine(designs[i]) });
      });
      branch.finish(status, detail);
    },
  };
}
