// Assistant tool that fastens the design: plans real screws, nuts, T-nuts,
// washers, inserts, corner brackets and joining plates for every empty screw
// hole and every profile joint nothing holds (see core/autoFasten), and writes
// them into the source as one undoable change.

import { z } from "zod";
import { useDesign, whenChecked, meshOf, kernelResult } from "../core/engine";
import { commitSource } from "../app/project";
import { diffStats } from "../core/sourceEdit";
import { applyFastenPlan, planFasteners } from "../core/autoFasten";
import type { ToolOutcome } from "./tools";

export const FASTEN_TOOL_DEFS = [
  {
    name: "place_fasteners",
    description:
      "Fasten the design with real hardware, as one undoable change. For every empty screw hole it picks the screw a hardware store sells (metric, standard lengths), measured through the stack of parts it clamps, and what it goes into: a nut (nyloc on moving parts), a T-nut in an aluminium profile slot, a heat-set insert or tapped hole, with washers where the length needs them. Every pair of touching T-slot profiles that nothing joins gets a corner bracket, or a joining plate across the face where a bracket has no room, with its screws and T-nuts. It checks head room and hex-key access. Call it after the parts have their holes and are placed, then fix what it lists as not fastened (a hole the wrong size, a joint with no room). The result comes back with the checks.",
    input_schema: {
      type: "object" as const,
      properties: {
        parts: { type: "array", items: { type: "string" }, maxItems: 40, description: "Only these part blocks (their holes and the joints they are in). Leave out to fasten the whole design." },
        summary: { type: "string", description: "One line for the history. Default: \"Fastened the design\"." },
      },
      additionalProperties: false,
    },
  },
];

export const FASTEN_TOOL_TITLES: Record<string, string> = { place_fasteners: "Placing fasteners" };

const Input = z
  .object({
    parts: z.array(z.string().min(1).max(120)).max(40).optional(),
    summary: z.string().min(1).max(200).optional(),
  })
  .strict();

const err = (content: string, title: string): ToolOutcome => ({ isError: true, content, card: { title, detail: content, status: "error" } });

export async function runFastenTool(name: string, input: unknown, ctx: { check?: boolean } = {}): Promise<ToolOutcome | null> {
  if (name !== "place_fasteners") return null;
  const p = Input.safeParse(input ?? {});
  if (!p.success) return err(p.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "), "Invalid tool input");
  // the planner measures the built meshes and reads the kernel's contacts
  await whenChecked(120_000);
  const { source, model } = useDesign.getState();
  if (!model) return err("No design is loaded.", "No design");
  if (model.diagnostics.some((d) => d.severity === "error")) return err("The source has errors: fix them first, so the parts are where they will be.", "Source has errors");
  const names = p.data.parts ? [...new Set(p.data.parts)] : undefined;
  const missing = (names ?? []).filter((n) => !model.parts.some((q) => q.name === n || q.id === n));
  if (missing.length) return err(`No part named ${missing.join(", ")}.`, "Part not found");
  const plan = planFasteners(model, meshOf, { parts: names, kernel: kernelResult() });
  const skipped = plan.skipped.map((s) => `- ${s.part}: ${s.why}`);
  if (!plan.groups.length) {
    return {
      content: [`Nothing new to fasten${names ? ` in ${names.join(", ")}` : ""}.`, ...(skipped.length ? ["Not fastened:", ...skipped] : [])].join("\n"),
      card: { title: skipped.length ? `${skipped.length} place${skipped.length > 1 ? "s" : ""} could not be fastened` : "Already fastened", detail: plan.skipped.map((s) => `${s.part}: ${s.why}`).join("\n") || undefined, status: skipped.length ? "error" : "done" },
    };
  }
  const src = applyFastenPlan(source, model, plan);
  const summary = p.data.summary ?? "Fastened the design";
  const next = commitSource(src, "claude", summary);
  const errors = next.diagnostics.filter((d) => d.severity === "error").length;
  const stats = diffStats(source, src);
  const n = plan.groups.reduce((a, g) => a + g.at.length, 0);
  return {
    content: [
      `Added ${n} fastener${n > 1 ? "s" : ""} in ${plan.groups.length} group${plan.groups.length > 1 ? "s" : ""}:`,
      ...plan.done.map((d) => `- ${d.part}: ${d.text}`),
      ...(skipped.length ? ["Not fastened (fix these, then call place_fasteners again):", ...skipped] : []),
      errors ? `The source now has ${errors} error(s); fix them with edit_design.` : "",
      ctx.check ? "The checks below include the new hardware." : ctx.check === false ? "The checks come after your last change in this response." : "Next: call run_checks.",
    ]
      .filter(Boolean)
      .join("\n"),
    card: {
      title: summary,
      detail: `${n} fasteners · +${stats.added} −${stats.removed} lines${skipped.length ? ` · ${skipped.length} not fastened` : ""}`,
      diff: { before: source, after: src },
      status: errors ? "error" : "done",
    },
  };
}
