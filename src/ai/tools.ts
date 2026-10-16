// Tools Claude uses to read, edit and verify the design. Every edit goes
// through the same source-text path as manual edits, and every input is
// validated before it touches the design.

import { z } from "zod";
import { useDesign, whenChecked, solveWith, evaluateOnly } from "../core/engine";
import { applyTextEdits, diffStats } from "../core/sourceEdit";
import type { Model } from "../core/model";
import type { CheckReport } from "../core/checks";
import { commitSource } from "../app/project";
import { viewport } from "../app/viewportApi";
import { MAX_SOURCE_CHARS } from "../persist/files";
import { fmtNum, Obj, type Value } from "../lang/values";
import { lineCol } from "../lang/lexer";
import { evaluate } from "../lang/evaluator";
import { BEARINGS } from "../library/standards";
import { CATALOG_KINDS, catalogPart, describePart, searchCatalog } from "../machine/catalog";
import { CALC_FNS, isCalc } from "../machine/calcs";
import { generateFirmware } from "../machine/firmware";
import type { CatalogPart } from "../machine/types";
import { calcParams } from "./reference";

// no generated code: the page CSP forbids eval
z.config({ jitless: true });

export const VIEW_NAMES = ["iso", "front", "back", "top", "bottom", "left", "right"] as const;

export const TOOL_DEFS = [
  {
    name: "get_design",
    description:
      "Read the current design: full source with line numbers (the numbers are not part of the text), the evaluated parameters, parts and requirements, and the latest check results. Call before your first edit and whenever the user may have changed the source.",
    input_schema: { type: "object" as const, properties: {}, additionalProperties: false },
  },
  {
    name: "edit_design",
    description:
      "Apply exact text replacements to the design source, in order. Each old_text must match the current source exactly once (copy it from get_design without the line-number prefix). The design is re-evaluated at once and the result returned; call run_checks afterwards for geometry checks. Prefer several small edits over large ones.",
    eager_input_streaming: true,
    input_schema: {
      type: "object" as const,
      properties: {
        summary: { type: "string", description: "One short line for the version history, in the user's terms, e.g. 'Narrowed the enclosure to 77 mm and moved the bosses'." },
        edits: {
          type: "array",
          minItems: 1,
          maxItems: 40,
          items: {
            type: "object",
            properties: {
              old_text: { type: "string", description: "Exact current text to replace (unique in the file)." },
              new_text: { type: "string", description: "Replacement text. Empty string deletes." },
            },
            required: ["old_text", "new_text"],
            additionalProperties: false,
          },
        },
        unlock_ok: { type: "boolean", description: "Set true only when the user explicitly asked to change a locked parameter or component." },
      },
      required: ["summary", "edits"],
      additionalProperties: false,
    },
  },
  {
    name: "write_design",
    description: "Replace the whole design source. Use for a brand-new design or a rewrite of most of the file; otherwise use edit_design.",
    eager_input_streaming: true,
    input_schema: {
      type: "object" as const,
      properties: {
        summary: { type: "string", description: "One short line for the version history." },
        source: { type: "string", description: "The complete new .kerf source." },
        unlock_ok: { type: "boolean", description: "Set true only when the user explicitly asked to change locked items." },
      },
      required: ["summary", "source"],
      additionalProperties: false,
    },
  },
  {
    name: "run_checks",
    description:
      "Wait for the geometry kernel to build the current design, then return every check: requirements with margins, solid interference, fastener tool access, gear meshing, swept motion envelopes, build errors, and for machines the electrical rules, motor loads, the physical test plan and a summary of the generated firmware with its warnings.",
    input_schema: { type: "object" as const, properties: {}, additionalProperties: false },
  },
  {
    name: "explore_fixes",
    description:
      "When hard requirements fail, search the unlocked parameters for the smallest changes that make every hard parametric requirement pass. Returns single-parameter and combined options, or reports that no parameter change can satisfy them (a true conflict). Pass hold to keep named parameters fixed, e.g. what the user said to keep.",
    input_schema: {
      type: "object" as const,
      properties: { hold: { type: "array", items: { type: "string" }, maxItems: 50, description: "Parameter names that must not change." } },
      additionalProperties: false,
    },
  },
  {
    name: "catalog_lookup",
    description:
      "Look up purchasable parts in Kerf's parts catalog. Give id for one part in full: specs, every pin with its electrical type and ratings, shape and fields, notes, the physical tests it usually needs, and where to buy it. Or search with query (for example \"15 A motor driver\", \"NEMA 17\", \"3S LiPo\") and/or kind: the best matches come back in full and the rest as one line each. With only kind, every part of that kind is listed in one line each. Call it before choosing or wiring a catalog part: only catalog parts have pins.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "A catalog id, e.g. \"pololu_g2_18v17\"." },
        query: { type: "string", description: "Words to search ids, names, makers, part numbers, summaries and specs." },
        kind: { type: "string", enum: [...CATALOG_KINDS], description: "Only parts of this kind." },
        limit: { type: "integer", minimum: 0, maximum: 12, description: "How many matches to return in full (default 3 for a query, 0 for a kind listing)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "engineering_calc",
    description:
      "Run one engineering calculator (calc.<name>) outside the design and get its full working: inputs, results, method, assumptions, confidence and what a physical test should confirm, plus every result field in base units. Use it to size a machine before choosing parts, to compare options, or to check a number; then record the calculation you rely on in the design as `let x = calc.<name>(...)`. Arguments are named, as in the language reference. Values: numbers in base units (mm, N, N·mm, MPa, V, A, W, s, g), or text with a unit such as \"9.5m\", \"10.8Nm\", \"32deg\", \"12kPa\"; true or false for flags; a catalog id (\"gobilda_5203_188\") or the name of a catalog component in the current design for motor, battery and actuator arguments; a bearing code (\"6808\") for bearing.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", enum: Object.keys(CALC_FNS), description: "The calculator." },
        args: {
          type: "object",
          description: "Named arguments, e.g. {\"depth\": \"9.5m\", \"box_w\": \"1m\"}.",
          additionalProperties: { anyOf: [{ type: "number" }, { type: "string" }, { type: "boolean" }] },
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "capture_view",
    description: "Render the current model from a camera angle and return the image so you can look at it. Optionally highlight parts and cut a section.",
    input_schema: {
      type: "object" as const,
      properties: {
        view: { type: "string", enum: [...VIEW_NAMES], description: "Camera direction. iso is a 3/4 view from the front right." },
        highlight: { type: "array", items: { type: "string" }, maxItems: 30, description: "Part or component names to emphasise; others are ghosted." },
        section: { type: "string", enum: ["x", "y", "z"], description: "Cut the model in half across this axis to see inside." },
      },
      required: ["view"],
      additionalProperties: false,
    },
  },
  {
    name: "ask_user",
    description:
      "Ask the user to decide between options (a tradeoff, a conflict, a missing dimension). Shows a choice card and ends your turn; the user's choice comes back as this tool's result. Use when the decision changes their goal or a visible outcome. Give 2 to 4 options, each with a one-line consequence, and mark the one you recommend.",
    input_schema: {
      type: "object" as const,
      properties: {
        question: { type: "string", description: "The question, short and specific." },
        options: {
          type: "array",
          minItems: 2,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Two to five words." },
              consequence: { type: "string", description: "What happens if chosen, one sentence." },
              recommended: { type: "boolean" },
            },
            required: ["label", "consequence"],
            additionalProperties: false,
          },
        },
      },
      required: ["question", "options"],
      additionalProperties: false,
    },
  },
];

const EditInput = z.object({
  summary: z.string().min(1).max(300),
  edits: z.array(z.object({ old_text: z.string().max(MAX_SOURCE_CHARS), new_text: z.string().max(MAX_SOURCE_CHARS) })).min(1).max(40),
  unlock_ok: z.boolean().optional(),
});
const WriteInput = z.object({ summary: z.string().min(1).max(300), source: z.string().min(1).max(MAX_SOURCE_CHARS), unlock_ok: z.boolean().optional() });
const FixInput = z.object({ hold: z.array(z.string().max(80)).max(50).optional() });
const ViewInput = z.object({ view: z.enum(VIEW_NAMES), highlight: z.array(z.string().max(80)).max(30).optional(), section: z.enum(["x", "y", "z"]).optional() });
const AskInput = z.object({
  question: z.string().min(1).max(500),
  options: z.array(z.object({ label: z.string().min(1).max(80), consequence: z.string().max(300), recommended: z.boolean().optional() })).min(2).max(4),
});

const LookupInput = z.object({ id: z.string().max(80).optional(), query: z.string().max(200).optional(), kind: z.string().max(40).optional(), limit: z.number().int().min(0).max(12).optional() });
const CalcInput = z.object({
  name: z.string().min(1).max(60),
  args: z.record(z.string().max(60), z.union([z.number(), z.string().max(200), z.boolean()])).optional(),
});

export type ToolResultContent = string | ({ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: "image/jpeg" | "image/png"; data: string } })[];

export interface ToolOutcome {
  content: ToolResultContent;
  isError?: boolean;
  /** what the chat shows on the tool card */
  card: { title: string; detail?: string; diff?: { before: string; after: string }; image?: string; status?: "done" | "error" };
  /** ends the turn and waits for the user */
  ask?: { question: string; options: { label: string; consequence: string; recommended?: boolean }[] };
}

// ---------- summaries ----------

const show = (v: number | string | boolean) => (typeof v === "number" ? fmtNum(v, 3) : JSON.stringify(v));

export function modelSummary(m: Model | null): string {
  if (!m) return "No design is loaded.";
  const unique = new Set(m.parts.map((p) => p.hash)).size;
  const lines: string[] = [];
  lines.push(`Design "${m.name}": ${m.parts.length} solids (${unique} unique geometries).`);
  if (m.params.length) lines.push("Parameters: " + m.params.map((p) => `${p.name}=${show(p.value)}${p.locked ? " (locked)" : ""}`).join(", "));
  const locked = m.blocks.filter((b) => b.locked && b.kind !== "param").map((b) => b.name);
  if (locked.length) lines.push("Locked components/parts: " + locked.join(", "));
  const groups = new Map<string, string[]>();
  for (const p of m.parts) {
    const k = p.group || "Other";
    const name = p.id.includes("#") ? p.id.split("#")[0] + "#…" : p.id;
    const arr = groups.get(k) ?? [];
    if (!arr.includes(name)) arr.push(name);
    groups.set(k, arr);
  }
  lines.push("Parts by group: " + [...groups].map(([g, ns]) => `${g}: ${ns.join(", ")}`).join("; "));
  const machine = machineSummary(m);
  if (machine) lines.push(machine);
  if (m.requirements.length) {
    // geometry-based requirements are only resolved once the kernel has measured them
    const report = useDesign.getState().report;
    const fromReport = (label: string) => report?.items.find((i) => i.id === `req:${label}`);
    lines.push(
      "Requirements:\n" +
        m.requirements
          .map((r) => {
            const done = r.status === "pending" ? fromReport(r.label) : undefined;
            return `  - [${done?.status ?? r.status}${r.level === "soft" ? ", soft" : ""}] ${r.label}: ${done?.detail ?? r.detail}`;
          })
          .join("\n"),
    );
  }
  const errs = m.diagnostics.filter((d) => d.severity === "error");
  if (errs.length) lines.push("Source errors:\n" + errs.map((d) => `  - line ${lineCol(useDesign.getState().source, d.start).line}: ${d.message}`).join("\n"));
  const warns = m.diagnostics.filter((d) => d.severity === "warning");
  if (warns.length) lines.push("Warnings:\n" + warns.map((d) => `  - ${d.message}`).join("\n"));
  return lines.join("\n");
}

export function reportSummary(r: CheckReport | null, limit = 40): string {
  if (!r) return "Checks have not run yet.";
  const c = r.counts;
  const head = `Checks: ${c.pass} pass, ${c.fail} fail, ${c.warn} warn, ${c.pending} pending, ${c.info} info.`;
  const notable = r.items.filter((i) => i.status !== "pass");
  // machine checks say how they were established: rules, calculation or a physical test still to do
  const basis = (i: CheckReport["items"][number]) => (i.basis === "electrical rules" || i.basis === "calculation" || i.basis === "physical test" ? `; ${i.basis}` : "");
  const body = notable.slice(0, limit).map((i) => `  - [${i.status}] (${i.category}${basis(i)}) ${i.title}: ${i.detail}${i.parts?.length ? ` [parts: ${i.parts.join(", ")}]` : ""}`);
  if (notable.length > limit) body.push(`  - … and ${notable.length - limit} more not shown (fix the ones above, then check again)`);
  const passed = r.items.filter((i) => i.status === "pass").map((i) => i.title);
  return [head, ...body, passed.length ? `Passing: ${passed.slice(0, 60).join("; ")}${passed.length > 60 ? `; … (${passed.length - 60} more)` : ""}` : ""].filter(Boolean).join("\n");
}

/** Purchased parts, wiring and calculations at a glance. */
export function machineSummary(m: Model): string {
  const mm = m.machine;
  if (!mm) return "";
  let cost = 0;
  for (const c of mm.components) cost += (c.price ?? catalogPart(c.catalogId)?.price_usd ?? 0) * c.count;
  for (const it of mm.items) cost += (it.price ?? 0) * it.qty;
  const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
  const lines = [
    `Machine: ${n(mm.components.reduce((s, c) => s + c.count, 0), "catalog part")}, ${n(mm.wires.length, "wire")}, ${n(mm.nets.length, "net")}, ${n(mm.calcs.length, "calculation")}, ${n(mm.firmware.length, "firmware block")}, ${n(mm.tests.length, "test")}, ${n(mm.items.length, "buy item")}; parts about $${Math.round(cost)}.`,
  ];
  if (mm.calcs.length) lines.push("Calculations: " + mm.calcs.map((c) => `${c.name} (${c.title}; ${c.confidence})`).join("; "));
  return lines.join("\n");
}

/** What the firmware generators make of the design, and what they warn about. */
export function firmwareSummary(m: Model | null): { text: string; warnings: number } {
  const mm = m?.machine;
  if (!m || !mm?.firmware.length) return { text: "", warnings: 0 };
  try {
    const outs = generateFirmware(mm, m.name);
    const warnings = outs.reduce((s, o) => s + o.warnings.length, 0);
    const lines = outs.map((o) => {
      const head = `  - ${o.name} (board ${o.board || "?"}): ${o.target === "none" ? "no code generated" : o.target === "arduino" ? "Arduino sketch" : "Klipper config"}. ${o.summary}. ${o.files.length} file${o.files.length === 1 ? "" : "s"}, ${o.pinTable.length} wired signal${o.pinTable.length === 1 ? "" : "s"}.`;
      return o.warnings.length ? `${head}\n    Warnings:\n${o.warnings.map((w) => `    * ${w}`).join("\n")}` : `${head} No warnings.`;
    });
    return { text: ["Firmware:", ...lines].join("\n"), warnings };
  } catch (e) {
    return { text: `Firmware: the generator failed (${e instanceof Error ? e.message : String(e)}).`, warnings: 1 };
  }
}

function numbered(src: string) {
  const lines = src.split("\n");
  const w = String(lines.length).length;
  return lines.map((l, i) => `${String(i + 1).padStart(w, " ")}| ${l}`).join("\n");
}

/** Names of locked params and blocks whose text an edit would change. */
function lockedChanges(before: string, after: string): string[] {
  const a = evaluateOnly(before);
  const b = evaluateOnly(after);
  const out: string[] = [];
  for (const p of a.params) {
    if (!p.locked) continue;
    const q = b.params.find((x) => x.name === p.name);
    if (!q || q.value !== p.value || !q.locked) out.push(`parameter ${p.name}`);
  }
  for (const blk of a.blocks) {
    if (!blk.locked || blk.kind === "param") continue;
    const other = b.blocks.find((x) => x.name === blk.name && x.kind === blk.kind);
    const textA = before.slice(blk.span.start, blk.span.end);
    const textB = other ? after.slice(other.span.start, other.span.end) : "";
    if (textA !== textB) out.push(`${blk.kind} ${blk.name}`);
  }
  return out;
}

function evalFeedback(m: Model, before: Model | null): string {
  const lines = [modelSummary(m)];
  if (before) {
    const changed = m.parts.filter((p) => {
      const q = before.parts.find((x) => x.id === p.id);
      return !q || q.hash !== p.hash || JSON.stringify(q.xf) !== JSON.stringify(p.xf);
    });
    const removed = before.parts.filter((p) => !m.parts.some((x) => x.id === p.id));
    lines.push(`Geometry to rebuild: ${changed.length} solid(s)${changed.length ? ` (${changed.slice(0, 20).map((p) => p.id).join(", ")})` : ""}; removed: ${removed.length}. Unchanged solids are reused from cache.`);
  }
  lines.push("Next: call run_checks to build and check the geometry.");
  return lines.join("\n");
}

function applySource(next: string, summary: string, unlockOk: boolean | undefined): ToolOutcome {
  const before = useDesign.getState().source;
  const beforeModel = useDesign.getState().model;
  if (next === before) return { content: "No change: the new source is identical to the current one.", card: { title: "No change needed" } };
  if (!unlockOk) {
    const locked = lockedChanges(before, next);
    if (locked.length) {
      return {
        isError: true,
        content: `Rejected: this edit changes locked items (${locked.join(", ")}). The user froze them. Find a solution that keeps them, or ask the user; set unlock_ok only if they explicitly asked to change these.`,
        card: { title: "Edit blocked: touches locked items", detail: locked.join(", "), status: "error" },
      };
    }
  }
  const model = commitSource(next, "claude", summary);
  const stats = diffStats(before, next);
  const errors = model.diagnostics.filter((d) => d.severity === "error").length;
  return {
    content: evalFeedback(model, beforeModel),
    card: {
      title: summary,
      detail: `+${stats.added} −${stats.removed} lines${errors ? ` · ${errors} source error${errors > 1 ? "s" : ""}` : ""}`,
      diff: { before, after: next },
      status: errors ? "error" : "done",
    },
  };
}

// ---------- handlers ----------

export async function runTool(name: string, input: unknown): Promise<ToolOutcome> {
  switch (name) {
    case "get_design": {
      const { source, model, report } = useDesign.getState();
      return {
        content: `<source>\n${numbered(source)}\n</source>\n\n${modelSummary(model)}\n\n${reportSummary(report)}`,
        card: { title: "Read the design", detail: `${source.split("\n").length} lines` },
      };
    }
    case "edit_design": {
      const p = EditInput.safeParse(input);
      if (!p.success) return invalid(p.error);
      const before = useDesign.getState().source;
      const { src, errors } = applyTextEdits(before, p.data.edits);
      if (errors.length) {
        return { isError: true, content: `No edits were applied.\n${errors.join("\n")}`, card: { title: "Edit could not be applied", detail: errors[0], status: "error" } };
      }
      if (src.length > MAX_SOURCE_CHARS) return { isError: true, content: "The design would exceed the 300,000 character limit.", card: { title: "Edit too large", status: "error" } };
      return applySource(src, p.data.summary, p.data.unlock_ok);
    }
    case "write_design": {
      const p = WriteInput.safeParse(input);
      if (!p.success) return invalid(p.error);
      return applySource(p.data.source.replace(/\r\n/g, "\n"), p.data.summary, p.data.unlock_ok);
    }
    case "run_checks": {
      const s = await whenChecked();
      if (s.kernelStatus === "error") return { isError: true, content: `The geometry kernel is unavailable: ${s.kernelError}`, card: { title: "Geometry kernel unavailable", status: "error" } };
      const r = s.report;
      const c = r?.counts;
      const fw = firmwareSummary(s.model);
      return {
        content: `${modelSummary(s.model)}\n\n${reportSummary(r)}${fw.text ? `\n${fw.text}` : ""}\nBuild: ${s.timings.built} solid(s) built, ${s.timings.reused} reused, ${Math.round(s.timings.buildMs)} ms; checks ${Math.round(s.timings.checksMs)} ms.${s.checksError ? `\nChecks error: ${s.checksError}` : ""}`,
        card: {
          title: c ? (c.fail ? `${c.fail} check${c.fail > 1 ? "s" : ""} failing` : `All ${c.pass} checks pass`) : "Checks unavailable",
          detail: c ? `${c.pass} pass · ${c.fail} fail · ${c.warn} warn${fw.warnings ? ` · ${fw.warnings} firmware warning${fw.warnings > 1 ? "s" : ""}` : ""}` : undefined,
          status: c && c.fail === 0 ? "done" : "error",
        },
      };
    }
    case "explore_fixes": {
      const p = FixInput.safeParse(input ?? {});
      if (!p.success) return invalid(p.error);
      const hold = p.data.hold ?? [];
      const { source, model } = useDesign.getState();
      const unknown = hold.filter((h) => !model?.params.some((q) => q.name === h));
      const conflict = await solveWith(source, hold);
      if (!conflict) return { content: "Every hard parametric requirement already passes; there is nothing to fix.", card: { title: "No conflict to resolve" } };
      const lines = [
        `Failing hard requirements: ${conflict.failing.map((f) => `${f.label} (${f.detail})`).join("; ")}`,
        `Adjustable parameters (unlocked, not held, upstream of the failures): ${conflict.adjustable.join(", ") || "none"}`,
      ];
      if (unknown.length) lines.push(`Note: hold names not found as parameters: ${unknown.join(", ")}`);
      if (conflict.infeasible) lines.push("No change to the adjustable parameters satisfies every hard requirement. This is a true conflict: the user must relax a requirement, unlock something, or change the concept.");
      else conflict.options.forEach((o, i) => lines.push(`Option ${i + 1}: ${o.summary}`));
      return {
        content: lines.join("\n"),
        card: { title: conflict.infeasible ? "No parameter change resolves the conflict" : `Found ${conflict.options.length} way${conflict.options.length > 1 ? "s" : ""} to resolve the conflict`, detail: conflict.options.map((o) => o.summary).join("\n") || conflict.failing.map((f) => f.label).join(", ") },
      };
    }
    case "capture_view": {
      const p = ViewInput.safeParse(input);
      if (!p.success) return invalid(p.error);
      const vp = viewport();
      if (!vp) return { isError: true, content: "The 3D view is not available right now.", card: { title: "View unavailable", status: "error" } };
      await whenChecked(30_000);
      const ids = expandNames(p.data.highlight ?? []);
      const url = await vp.capture({ view: p.data.view, width: 1024, height: 704, focus: ids, section: p.data.section, mime: "image/jpeg", quality: 0.85 });
      const data = url.split(",")[1] ?? "";
      return {
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data } },
          { type: "text", text: `Rendered ${p.data.view} view${p.data.section ? `, sectioned across ${p.data.section}` : ""}${ids.length ? `, highlighting ${p.data.highlight!.join(", ")}` : ""}. Z is up; X is red, Y is green in the axis triad.` },
        ],
        card: { title: `Looked at the ${p.data.view} view`, image: url },
      };
    }
    case "ask_user": {
      const p = AskInput.safeParse(input);
      if (!p.success) return invalid(p.error);
      return { content: "", card: { title: p.data.question }, ask: { question: p.data.question, options: p.data.options } };
    }
    case "catalog_lookup": {
      const p = LookupInput.safeParse(input ?? {});
      if (!p.success) return invalid(p.error);
      return catalogLookup(p.data);
    }
    case "engineering_calc": {
      const p = CalcInput.safeParse(input);
      if (!p.success) return invalid(p.error);
      return engineeringCalc(p.data.name, p.data.args ?? {});
    }
  }
  return { isError: true, content: `Unknown tool ${name}`, card: { title: `Unknown tool ${name}`, status: "error" } };
}

function expandNames(names: string[]): string[] {
  const m = useDesign.getState().model;
  if (!m) return [];
  return m.parts.filter((p) => names.some((n) => p.name === n || p.id === n || p.id.startsWith(n + "#") || p.id.startsWith(n + "."))).map((p) => p.id);
}

function invalid(e: z.ZodError): ToolOutcome {
  const msg = e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
  return { isError: true, content: `Invalid tool input: ${msg}`, card: { title: "Invalid tool input", detail: msg, status: "error" } };
}

export const TOOL_TITLES: Record<string, string> = {
  get_design: "Reading the design",
  edit_design: "Editing the design",
  write_design: "Writing the design",
  run_checks: "Building and checking",
  explore_fixes: "Searching for fixes",
  capture_view: "Looking at the model",
  ask_user: "Asking you",
  catalog_lookup: "Looking up parts",
  engineering_calc: "Calculating",
};

// ---------- parts catalog ----------

const oneLine = (p: CatalogPart) => `${p.id} | ${p.name} | ${p.summary.split(/(?<=\.)\s+/).slice(0, 2).join(" ")}${p.price_usd ? ` | ~$${p.price_usd}` : ""}`;
const usage = (p: CatalogPart) => `Use as: lib.${p.kind}("${p.id}"${p.cut_to_length ? ", length: <mm>" : ""}) or lib.part("${p.id}")`;

export function catalogLookup(q: { id?: string; query?: string; kind?: string; limit?: number }): ToolOutcome {
  if (q.id?.trim()) {
    const id = q.id.trim();
    const p = catalogPart(id);
    if (!p) {
      const near = searchCatalog(id.replace(/[_-]+/g, " "), undefined, 6);
      return {
        isError: true,
        content: `No catalog part has the id "${id}".${near.length ? ` Closest matches:\n${near.map(oneLine).join("\n")}` : ""}`,
        card: { title: `No catalog part "${id}"`, status: "error" },
      };
    }
    return { content: `${usage(p)}\n${describePart(p)}`, card: { title: `Looked up ${p.name}`, detail: `${p.id} · ${p.kind}${p.price_usd ? ` · about $${p.price_usd}` : ""}` } };
  }
  const kind = q.kind?.trim() || undefined;
  if (kind && !CATALOG_KINDS.includes(kind as CatalogPart["kind"])) {
    return { isError: true, content: `"${kind}" is not a catalog kind. Kinds: ${CATALOG_KINDS.join(", ")}.`, card: { title: `Unknown part kind "${kind}"`, status: "error" } };
  }
  const query = q.query?.trim() ?? "";
  if (!query && !kind) return { isError: true, content: "Give an id, a query or a kind.", card: { title: "Nothing to look up", status: "error" } };
  const found = searchCatalog(query, kind, 40);
  const what = [query && `"${query}"`, kind && `kind ${kind}`].filter(Boolean).join(", ");
  if (!found.length) {
    return {
      content: `No catalog part matches ${what}. Kinds in the catalog: ${CATALOG_KINDS.join(", ")}. If the design needs a part the catalog lacks, search the web for a real product (maker, part number, price, product page) and add it as a buy item.`,
      card: { title: `No catalog match for ${what}`, detail: "Not in the catalog" },
    };
  }
  const full = Math.min(found.length, q.limit ?? (query ? 3 : 0));
  const parts = [`${found.length} catalog part${found.length === 1 ? "" : "s"} match ${what}.`];
  for (const p of found.slice(0, full)) parts.push(`${usage(p)}\n${describePart(p)}`);
  if (found.length > full) parts.push(`${full ? "Other matches" : "Matches"} (look one up by id for its pins and specs):\n${found.slice(full).map(oneLine).join("\n")}`);
  return { content: parts.join("\n\n---\n\n"), card: { title: `Searched the parts catalog: ${what}`, detail: found.slice(0, 6).map((p) => p.id).join(", ") + (found.length > 6 ? ", …" : "") } };
}

// ---------- engineering calculators ----------

const num4 = (n: number) => (Number.isFinite(n) ? String(Number(n.toPrecision(4))) : String(n));

function specFields(p: CatalogPart): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const [k, v] of Object.entries(p.specs)) out[k] = typeof v === "boolean" ? (v ? 1 : 0) : v;
  return { ...out, catalog_id: p.id, price: p.price_usd ?? 0 };
}

/** Read one literal the way the language does (units, true/false, simple arithmetic). */
function readLiteral(text: string): { value: Value } | { error: string } {
  if (!text || /[\n\r{};]/.test(text)) return { error: "write one value, such as 9.5m or 10.8Nm" };
  const m = evaluate(`param v = ${text}\n`, { skipGeometry: true });
  const err = m.diagnostics.find((d) => d.severity === "error");
  if (err) return { error: err.message };
  const p = m.params.find((x) => x.name === "v");
  return p ? { value: p.value } : { error: "not a value" };
}

/** A catalog part from an id, or from a component of that name in the current design. */
function partFor(text: string): { part: CatalogPart; label: string; ref: string } | null {
  const direct = catalogPart(text);
  if (direct) return { part: direct, label: direct.name, ref: `<your lib.${direct.kind}("${direct.id}") component>` };
  const mc = useDesign.getState().model?.machine?.components.find((c) => c.name === text);
  const p = mc && catalogPart(mc.catalogId);
  return p ? { part: p, label: text, ref: text } : null;
}

const COMPONENT_ARGS = new Set(["motor", "battery", "actuator"]);

export function engineeringCalc(name: string, args: Record<string, number | string | boolean>): ToolOutcome {
  const fn = CALC_FNS[name];
  if (!fn) return { isError: true, content: `There is no calc.${name}. Calculators: ${Object.keys(CALC_FNS).join(", ")}.`, card: { title: `No calculator ${name}`, status: "error" } };
  const accepts = calcParams(name);
  const fail = (msg: string): ToolOutcome => ({ isError: true, content: `calc.${name}: ${msg}${accepts.length ? `\nIt accepts: ${accepts.join(", ")}. ${fn.doc ?? ""}` : ""}`, card: { title: `calc.${name} could not run`, detail: msg, status: "error" } });
  const unknown = Object.keys(args).filter((k) => accepts.length && !accepts.includes(k));
  if (unknown.length) return fail(`no argument${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `"${k}"`).join(", ")}`);

  const named: Record<string, Value> = {};
  const shown: string[] = [];
  for (const [k, raw] of Object.entries(args)) {
    if (typeof raw === "number") {
      if (!Number.isFinite(raw)) return fail(`${k} must be a finite number`);
      named[k] = raw;
      shown.push(`${k}: ${raw}`);
      continue;
    }
    if (typeof raw === "boolean") {
      named[k] = raw;
      shown.push(`${k}: ${raw}`);
      continue;
    }
    const text = raw.trim();
    const comp = partFor(text);
    if (comp) {
      named[k] = new Obj(specFields(comp.part), "component", comp.label);
      shown.push(`${k}: ${comp.ref}`);
      continue;
    }
    if (COMPONENT_ARGS.has(k)) return fail(`${k}: "${text}" is not a catalog id or a catalog component in the design`);
    if (k === "bearing") {
      if (!BEARINGS[text]) return fail(`unknown bearing "${text}". Codes: ${Object.keys(BEARINGS).join(", ")}`);
      named[k] = text;
      shown.push(`${k}: "${text}"`);
      continue;
    }
    const lit = readLiteral(text);
    if ("error" in lit) return fail(`could not read ${k}: "${text}" (${lit.error})`);
    named[k] = lit.value;
    shown.push(`${k}: ${text}`);
  }

  let result: Value;
  try {
    result = fn.call([], named, {
      error: (msg: string) => {
        throw new Error(msg);
      },
      geo: () => 0,
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  if (!isCalc(result)) return fail("did not return a calculation");
  const t = result.trace;
  const line = (l: { label: string; value: number; unit: string; note?: string }) => `  - ${l.label}: ${num4(l.value)}${l.unit ? ` ${l.unit}` : ""}${l.note ? ` (${l.note})` : ""}`;
  const fields = Object.entries(result.fields)
    .map(([k, v]) => `${k} = ${typeof v === "number" ? num4(v) : typeof v === "string" ? JSON.stringify(v) : String(v)}`)
    .join(", ");
  const call = `calc.${name}(${shown.join(", ")})`;
  const text = [
    call,
    `${t.title} (confidence: ${t.confidence})`,
    "Inputs:",
    ...t.inputs.map(line),
    "Results:",
    ...t.outputs.map(line),
    "Method:",
    ...t.method.map((m) => `  - ${m}`),
    "Assumptions:",
    ...t.assumptions.map((a) => `  - ${a}`),
    t.verify ? `Confirm with a physical test: ${t.verify}` : "",
    `Result fields in base units (mm, N, N·mm, MPa, V, A, W, s), for other calculations and the design: ${fields}`,
    `To record it in the design: let <name> = ${call}`,
  ].filter(Boolean);
  return {
    content: text.join("\n"),
    card: { title: t.title, detail: t.outputs.slice(0, 3).map((l) => `${l.label.trim()} ${num4(l.value)}${l.unit ? ` ${l.unit}` : ""}`).join(" · ") },
  };
}
