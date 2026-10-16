// The lead assistant's build_subassemblies tool.

import { z } from "zod";
import type { ToolOutcome } from "../ai/tools";
import { startBuild } from "./orchestrator";

z.config({ jitless: true });

export const BUILD_TOOL = {
  name: "build_subassemblies",
  description:
    "Build or revise several subassemblies at the same time, one agent per subassembly. Write the layout (params, skeleton lets, interfaces) first. Each agent writes only its own marked section of the design file, checks it in its own geometry worker, and reports back; the user reviews the plan and its cost first and can steer agents while they work. Returns each agent's report, their change requests and the checks for the integrated design. Listing an id that already has a section revises it; sections you do not list stay as they are.",
  input_schema: {
    type: "object" as const,
    properties: {
      title: { type: "string", description: "A short name for this build, e.g. 'Desk fan, first build'." },
      goal: { type: "string", description: "The overall design intent every agent reads: what the assembly is for, the user's priorities and constraints." },
      subassemblies: {
        type: "array",
        minItems: 1,
        maxItems: 12,
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "snake_case id, e.g. gear_train. Used in the section markers." },
            name: { type: "string", description: "Short display name, e.g. 'Gear train'." },
            brief: { type: "string", description: "What to build: purpose, parts, key dimensions, the layout names and interfaces it must use, and how it meets its neighbours. For a revision, what to change." },
            after: { type: "array", items: { type: "string" }, description: "Ids whose built parts this one needs first. Leave empty when the layout holds every shared number." },
            uses: { type: "array", items: { type: "string" }, description: "Layout names and interfaces it implements or reads." },
          },
          required: ["id", "name", "brief"],
          additionalProperties: false,
        },
      },
      integration: { type: "string", description: "Kerf require statements that span subassemblies, placed after every section and checked once all are merged. Replaces the current integration block when given." },
    },
    required: ["title", "goal", "subassemblies"],
    additionalProperties: false,
  },
};

const Input = z.object({
  title: z.string().min(1).max(200),
  goal: z.string().min(1).max(8000),
  subassemblies: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        name: z.string().min(1).max(120),
        brief: z.string().min(1).max(8000),
        after: z.array(z.string().max(40)).max(12).optional(),
        uses: z.array(z.string().max(80)).max(40).optional(),
      }),
    )
    .min(1)
    .max(12),
  integration: z.string().max(40_000).optional(),
});

export async function runBuildTool(input: unknown, ctx: { signal?: AbortSignal; toolUseId?: string }): Promise<ToolOutcome> {
  const p = Input.safeParse(input);
  if (!p.success) {
    const msg = p.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return { isError: true, content: `Invalid tool input: ${msg}`, card: { title: "Invalid tool input", detail: msg, status: "error" } };
  }
  const d = p.data;
  return startBuild({ title: d.title, goal: d.goal, integration: d.integration, subassemblies: d.subassemblies.map((s) => ({ id: s.id, name: s.name, brief: s.brief, after: s.after ?? [], uses: s.uses ?? [] })) }, ctx);
}
