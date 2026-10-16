// Tools Claude uses to read, edit and verify the design. Every edit goes
// through the same source-text path as manual edits, and every input is
// validated before it touches the design.

import { z } from "zod";
import { useDesign, whenChecked, whenRefined, solveWith, evaluateOnly } from "../core/engine";
import { applyTextEdits, diffStats } from "../core/sourceEdit";
import type { Model } from "../core/model";
import type { CheckReport } from "../core/checks";
import { commitSource } from "../app/project";
import { viewport } from "../app/viewportApi";
import { MAX_SOURCE_CHARS } from "../persist/files";
import { fmtNum } from "../lang/values";
import { lineCol } from "../lang/lexer";
import { evaluateSelector } from "../lang/evaluator";
import { kernel } from "../kernel/client";
import { inspectText } from "../kernel/inspectText";
import { inverseXforms, type V3 } from "../kernel/recipe";

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
      "Wait for the geometry kernel to build the current design, then return every check: requirements with margins, solid interference, fastener tool access, gear meshing, swept motion envelopes and build errors.",
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
    name: "inspect_part",
    description:
      "Look inside one built part before choosing fillets, chamfers, drafts or shells: its size, named features (from `add ... as name`) with how many faces and root/tip edges each has, and how many sharp convex and concave edges it has. Pass select to test a selector exactly as you would write it in the source (e.g. `boss.root`, `both(lid.edges, \"top\")`, `near((0, 12, 20), 1)`), and see what it picks; pass at (a world point, e.g. where the user clicked) to get the face and edge there and selectors that name them. Coordinates in results are in the part's own frame, the same frame its selectors use.",
    input_schema: {
      type: "object" as const,
      properties: {
        part: { type: "string", description: "Part or component name (or instance id like screw#2)." },
        select: { type: "string", description: "A selector expression to evaluate against the part." },
        kind: { type: "string", enum: ["edges", "faces"], description: "What the selector picks (default edges; shell open and draft use faces)." },
        at: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3, description: "A point in world coordinates to identify." },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["part"],
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
const InspectInput = z.object({
  part: z.string().min(1).max(120),
  select: z.string().max(2000).optional(),
  kind: z.enum(["edges", "faces"]).optional(),
  at: z.array(z.number().finite()).length(3).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
const AskInput = z.object({
  question: z.string().min(1).max(500),
  options: z.array(z.object({ label: z.string().min(1).max(80), consequence: z.string().max(300), recommended: z.boolean().optional() })).min(2).max(4),
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
  const body = notable.slice(0, limit).map((i) => `  - [${i.status}] (${i.category}) ${i.title}: ${i.detail}${i.parts?.length ? ` [parts: ${i.parts.join(", ")}]` : ""}`);
  const passed = r.items.filter((i) => i.status === "pass").map((i) => i.title);
  return [head, ...body, passed.length ? `Passing: ${passed.slice(0, 60).join("; ")}` : ""].filter(Boolean).join("\n");
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
      let s = await whenChecked();
      // detailed geometry (threads, knurls, cosmetic steps) builds after the checks; wait a little for it so its problems are seen
      let refining = false;
      if (s.model?.parts.some((p) => p.detail) && s.kernelStatus !== "error") {
        await whenRefined(20_000);
        s = useDesign.getState();
        refining = s.stage !== "done";
      }
      if (s.kernelStatus === "error") return { isError: true, content: `The geometry kernel is unavailable: ${s.kernelError}`, card: { title: "Geometry kernel unavailable", status: "error" } };
      const r = s.report;
      const c = r?.counts;
      return {
        content: `${modelSummary(s.model)}\n\n${reportSummary(r)}\nBuild: ${s.timings.built} solid(s) built, ${s.timings.reused} reused, ${Math.round(s.timings.buildMs)} ms; checks ${Math.round(s.timings.checksMs)} ms.${refining ? "\nThe detailed geometry (threads, knurls, cosmetic steps) is still building; its problems, if any, show in a later run_checks." : ""}${s.checksError ? `\nChecks error: ${s.checksError}` : ""}`,
        card: {
          title: c ? (c.fail ? `${c.fail} check${c.fail > 1 ? "s" : ""} failing` : `All ${c.pass} checks pass`) : "Checks unavailable",
          detail: c ? `${c.pass} pass · ${c.fail} fail · ${c.warn} warn` : undefined,
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
    case "inspect_part": {
      const p = InspectInput.safeParse(input);
      if (!p.success) return invalid(p.error);
      const m = useDesign.getState().model;
      const part = m?.parts.find((q) => q.id === p.data.part) ?? m?.parts.find((q) => q.name === p.data.part);
      if (!m || !part) return { isError: true, content: `No part or component named "${p.data.part}". Parts: ${(m?.parts ?? []).slice(0, 60).map((q) => q.id).join(", ")}`, card: { title: "Part not found", detail: p.data.part, status: "error" } };
      let sel;
      if (p.data.select) {
        const r = evaluateSelector(p.data.select, (part.features ?? []).map((f) => f.name), useDesign.getState().source);
        if (!r.sel) return { isError: true, content: `The selector did not evaluate: ${r.error}`, card: { title: "Selector error", detail: r.error, status: "error" } };
        sel = r.sel;
      }
      const at = p.data.at ? inverseXforms(p.data.at as V3, part.xf) : undefined;
      try {
        await kernel.ready();
        const res = await kernel.inspect({ hash: part.hash, recipe: part.recipe, label: part.id, sel, selKind: p.data.kind, at, limit: p.data.limit });
        const text = inspectText(part.id, res, p.data.select);
        const cosmetic = (part.features ?? []).filter((f) => f.cosmetic).map((f) => f.name);
        return {
          content: text + (cosmetic.length ? `\nCosmetic features (only in detailed builds, not inspected here): ${cosmetic.join(", ")}` : ""),
          card: { title: `Inspected ${part.id}`, detail: res.selection ? `${p.data.select} → ${res.selection.count} ${res.selection.kind}` : `${res.features.length} named features · ${res.edgeStats.convex + res.edgeStats.concave} sharp edges` },
        };
      } catch (e) {
        return { isError: true, content: `Could not inspect ${part.id}: ${(e as Error).message}`, card: { title: "Inspection failed", status: "error" } };
      }
    }
    case "ask_user": {
      const p = AskInput.safeParse(input);
      if (!p.success) return invalid(p.error);
      return { content: "", card: { title: p.data.question }, ask: { question: p.data.question, options: p.data.options } };
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
  inspect_part: "Inspecting a part",
  ask_user: "Asking you",
};
