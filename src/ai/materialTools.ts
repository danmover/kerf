// Assistant tools for materials: rank the materials for a part against its
// brief, loads, analysis, process, cost and mass, and write a choice into the
// design (with the process it needs).

import { z } from "zod";
import { useDesign, whenChecked } from "../core/engine";
import { commitSource } from "../app/project";
import { diffStats } from "../core/sourceEdit";
import { MATERIAL_DB, materialRecord } from "../library/materialDb";
import { PROCESS_IDS } from "../mfg/profiles";
import { NEEDS, adviceText, processLabel, type Need } from "../materials/advise";
import { adviseFor } from "../materials/context";
import { blockPart, withMaterial } from "../materials/apply";
import { useMaterials } from "../materials/store";
import { fmtNum } from "../lang/values";
import type { ProcessId } from "../mfg/types";
import type { ToolOutcome } from "./tools";

const NAMES = MATERIAL_DB.map((m) => m.name);

export const MATERIAL_TOOL_DEFS = [
  {
    name: "compare_materials",
    description:
      "Rank materials for one part (or for the design when part is left out) against what the brief says it must survive (temperature, sunlight, water, salt, oil, food, impacts), its loads and latest strength analysis (safety factor and deflection scaled to each material), its process, priorities, mass limit and material cost. Returns each option's numbers and why, the ones that need a different process, and the ones ruled out. Call it before choosing or changing the material of any part that carries load, lives outdoors or hot, touches food, rubs or flexes; cite its numbers rather than material facts from memory.",
    input_schema: {
      type: "object" as const,
      properties: {
        part: { type: "string", description: "Part block name as in the source. Leave out to rank materials for the design as a whole from the brief." },
        needs: { type: "array", items: { type: "string", enum: [...NEEDS] }, maxItems: 8, description: "What this part needs that the brief does not say, from what it does: a seal is soft, a hinge flexible, a gear low friction and wear resistant, a window clear." },
        candidates: { type: "array", items: { type: "string", enum: NAMES }, maxItems: 12, description: "Compare only these materials (the current one is always included)." },
        allow_process_change: { type: "boolean", description: "Also rank materials the part's own process cannot make (they switch process). Default false when the part sets its own process." },
        limit: { type: "integer", minimum: 1, maximum: 10, description: "How many options to describe in full (default 5)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "set_material",
    description:
      "Set the material of one or more part blocks, with a finish and colour that suit it, as one undoable change. When the part's process cannot make the material, its process switches too (the one compare_materials named, or the process given). Prefer this over edit_design for material changes. The result comes back with the checks; afterwards call run_analysis for analyses that include the part.",
    input_schema: {
      type: "object" as const,
      properties: {
        parts: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20, description: "Part block names." },
        material: { type: "string", enum: NAMES },
        finish: { type: "string", description: "One of the material's finishes. Defaults to what suits the process and conditions." },
        color: { type: "string", description: "#rrggbb. Defaults to the part's colour for plastics and the material's own tone for metals." },
        process: { type: "string", enum: [...PROCESS_IDS], description: "Only when the material needs a different process and you want a specific one." },
        summary: { type: "string", description: "One line for the history, e.g. \"Bracket in ASA: PLA softens in the sun\"." },
        user_asked: { type: "boolean", description: "The user explicitly asked for this material on a part they locked." },
      },
      required: ["parts", "material", "summary"],
      additionalProperties: false,
    },
  },
];

export const MATERIAL_TOOL_TITLES: Record<string, string> = { compare_materials: "Comparing materials", set_material: "Changing the material" };

const CompareInput = z.object({
  part: z.string().min(1).max(120).optional(),
  needs: z.array(z.enum(NEEDS)).max(8).optional(),
  candidates: z.array(z.string()).max(12).optional(),
  allow_process_change: z.boolean().optional(),
  limit: z.number().int().min(1).max(10).optional(),
});
const SetInput = z.object({
  parts: z.array(z.string().min(1).max(120)).min(1).max(20),
  material: z.string(),
  finish: z.string().max(40).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "use #rrggbb")
    .optional(),
  process: z.enum(PROCESS_IDS as [ProcessId, ...ProcessId[]]).optional(),
  summary: z.string().min(1).max(200),
  user_asked: z.boolean().optional(),
});

const err = (content: string, title: string): ToolOutcome => ({ isError: true, content, card: { title, detail: content, status: "error" } });
const issues = (e: z.ZodError) => err(e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "), "Invalid tool input");
const unknownMaterials = (names: string[]) => names.filter((n) => !materialRecord(n));
const blockNames = () => [...new Set((useDesign.getState().model?.parts ?? []).filter((p) => !p.id.startsWith(`${p.name}.`)).map((p) => p.name))];

export async function runMaterialTool(name: string, input: unknown, ctx: { toolUseId?: string; check?: boolean } = {}): Promise<ToolOutcome | null> {
  switch (name) {
    case "compare_materials": {
      const p = CompareInput.safeParse(input ?? {});
      if (!p.success) return issues(p.error);
      const bad = unknownMaterials(p.data.candidates ?? []);
      if (bad.length) return err(`Unknown material${bad.length > 1 ? "s" : ""} ${bad.join(", ")}. Materials: ${NAMES.join(", ")}.`, "Unknown material");
      // volumes come from the built geometry
      const s = await whenChecked();
      const model = s.model;
      if (!model) return err("No design is loaded.", "No design");
      if (p.data.part && !blockPart(model, p.data.part)) return err(`No part block named "${p.data.part}". Parts: ${blockNames().join(", ") || "none"}.`, "Part not found");
      const advice = adviseFor(p.data.part ?? null, { needs: p.data.needs as Need[] | undefined, candidates: p.data.candidates, keepProcess: p.data.allow_process_change ? false : undefined, model });
      if (!advice) return err("Could not read the part.", "Part not found");
      if (ctx.toolUseId) useMaterials.getState().record(ctx.toolUseId, { part: p.data.part ?? null, advice });
      const top = advice.options.filter((o) => o.verdict !== "unsuitable").slice(0, 3);
      return {
        content: `${adviceText(advice, p.data.limit ?? 5)}\nTo use one, call set_material with the part, the material, and the finish shown. Give the user the reason in a sentence with the deciding numbers.`,
        card: { title: `Compared materials for ${advice.subject}`, detail: top.map((o) => `${o.verdict === "recommended" ? "★ " : ""}${o.label}: ${o.summary}`).join("\n") || "Nothing suits it yet" },
      };
    }
    case "set_material": {
      const p = SetInput.safeParse(input);
      if (!p.success) return issues(p.error);
      const rec = materialRecord(p.data.material);
      if (!rec) return err(`Unknown material ${p.data.material}. Materials: ${NAMES.join(", ")}.`, "Unknown material");
      if (p.data.finish && !rec.finishes.includes(p.data.finish)) return err(`${rec.label} has no "${p.data.finish}" finish; it has ${rec.finishes.join(", ")}.`, "Finish not available");
      if (p.data.process && !rec.processes.includes(p.data.process)) return err(`${processLabel(p.data.process)} cannot make ${rec.label}; it is made by ${rec.processes.map(processLabel).join(", ")}.`, "Process cannot make it");
      const { source, model } = useDesign.getState();
      if (!model) return err("No design is loaded.", "No design");
      const blocks = [...new Set(p.data.parts)];
      const missing = blocks.filter((b) => !blockPart(model, b));
      if (missing.length) return err(`No part block named ${missing.map((m) => `"${m}"`).join(", ")}. Parts: ${blockNames().join(", ")}.`, "Part not found");
      const locked = blocks.filter((b) => blockPart(model, b)!.locked);
      if (locked.length && !p.data.user_asked) return err(`Rejected: the user locked ${locked.join(", ")}. Keep its material, or ask the user; retry with user_asked only if they asked for this change.`, "Part is locked");
      // later blocks first, so the earlier ones' spans still match the text
      const ordered = blocks.sort((a, b) => blockPart(model, b)!.span.start - blockPart(model, a)!.span.start);
      let src = source;
      const lines: string[] = [];
      const warnings: string[] = [];
      for (const b of ordered) {
        const advice = adviseFor(b, { candidates: [rec.name], keepProcess: false, model });
        const opt = advice?.options.find((o) => o.name === rec.name);
        const part = blockPart(model, b)!;
        const choice = {
          material: rec.name,
          finish: p.data.finish ?? opt?.finish ?? rec.finishes[0],
          color: p.data.color ?? opt?.color ?? rec.color,
          process: p.data.process ?? opt?.processChange?.to,
        };
        const r = withMaterial(src, model, b, choice);
        src = r.src;
        lines.unshift(`${b}: ${r.changes.join(", ") || "no change"}`);
        if (opt?.verdict === "unsuitable") warnings.push(`${b}: the advisor rates ${rec.label} unsuitable here (${opt.criteria.filter((k) => k.grade === "fail").map((k) => k.why).join("; ")}).`);
        else if (opt?.cons.length) warnings.push(`${b}: weak points in ${rec.label}: ${opt.cons.join(", ")}.`);
        if (opt?.estimate) warnings.push(`${b}: the latest analysis scaled to ${rec.label} gives a safety factor of about ${fmtNum(opt.estimate.safety, 2)} (target ${fmtNum(opt.estimate.target, 1)}); re-run it to confirm.`);
        if (part.kind === "component") warnings.push(`${b} is a library component: only its look changes, not what is bought.`);
      }
      if (src === source) return { content: `No change: ${blocks.join(", ")} already ${blocks.length > 1 ? "use" : "uses"} ${rec.label} with that finish and colour.`, card: { title: "No change needed" } };
      const brief = model.brief;
      if (brief?.material && brief.material !== rec.name && !brief.assumed.includes("material")) warnings.push(`The brief says the material is ${brief.material}. Tell the user why ${blocks.join(", ")} ${blocks.length > 1 ? "differ" : "differs"}, or update the brief if they agree.`);
      const next = commitSource(src, "claude", p.data.summary);
      const errors = next.diagnostics.filter((d) => d.severity === "error").length;
      const stats = diffStats(source, src);
      return {
        content: [`Set ${rec.label}:`, ...lines.map((l) => `- ${l}`), ...warnings, errors ? `The source now has ${errors} error(s); fix them with edit_design.` : "", ctx.check ? "The checks below use the new material. Next: run_analysis for any analysis that includes these parts." : ctx.check === false ? "The checks come after your last change in this response; then run_analysis for any analysis that includes these parts." : "Next: call run_checks (the process checks use the new material), then run_analysis for any analysis that includes these parts."].filter(Boolean).join("\n"),
        card: {
          title: p.data.summary,
          detail: `${lines.join("\n")} · +${stats.added} −${stats.removed} lines`,
          diff: { before: source, after: src },
          status: errors ? "error" : "done",
        },
      };
    }
  }
  return null;
}

/** How Claude chooses materials, for the system prompt. */
export function materialPromptSection(): string {
  return `## Materials
Choose each part's material for what that part does, not out of habit, and say what decided it.
- Before choosing or changing the material of a part that carries load, lives outdoors or hot, gets wet, touches food, rubs, flexes, must be light or must be clear, call compare_materials for it, with needs: from what the part does (a seal is soft, a hinge flexible, a gear low friction and wear resistant). It ranks materials against the brief, the part's loads, its latest analysis, its process, the mass limit and material cost. Cite its numbers (service temperature, safety factor and deflection in each material, mass, cost) instead of material facts from memory.
- Keep the part's process unless the user wants another. Options marked as made another way change how the part is made; offer them with ask_user when they are clearly better, rather than switching.
- Apply a choice with set_material, which picks a finish that suits the process, keeps the part's colour where it can, and switches the process only when the current one cannot make the material. Its result carries the checks; then run_analysis for analyses that include the part, and report the numbers before and after.
- Fix strength with geometry first. Change the material when the conditions rule it out (heat, sunlight, water, salt, chemicals, food) or when geometry cannot reach the target in the space there is. When the user or the brief chose the material, propose the change with ask_user and the numbers instead of switching.
- Record the material of each part that matters as a decision with the runner-up as an alternative.
- The checks also flag different metals touching in a wet design (galvanic corrosion: isolate them or change one), plastic parts that carry a constant load near their creep limit, and screws driven straight into printed plastic (use heat-set inserts). Fix those like any other check.`;
}
