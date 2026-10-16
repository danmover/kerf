// The update_plan tool: Claude keeps the live to-do tree current with it.

import { z } from "zod";
import { checkSteps, progress, updatePlanFromClaude, usePlan, STEP_STATUSES } from "./plan";
import type { ToolOutcome } from "./tools";

export const PLAN_TOOL = {
  name: "update_plan",
  description:
    "Show the user your plan as a live to-do tree beside the chat, and keep it current. For any request that takes more than a couple of actions, call this first with every step, then again as each step starts, finishes or changes; send it in the same response as your next action so it costs no extra turn. Send the whole plan each time. Keep one step doing at a time, nest sub-steps with parent, and name the parts a step works on so the user can see them. The user can rename, annotate, skip, reorder, add and pause on steps while you work. Their changes reach you as a <plan-changes> note after your tool results and come before your plan.",
  input_schema: {
    type: "object" as const,
    properties: {
      goal: { type: "string", description: "The request in a few words, in the user's terms, e.g. 'Narrow the enclosure by 20%'." },
      new_plan: { type: "boolean", description: "True when this plan is for a new request, so the previous plan is cleared. Leave out when updating the current plan." },
      steps: {
        type: "array",
        maxItems: 80,
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Short stable id, e.g. s1, s2a. Keep ids the same across updates, and keep the ids of steps the user added." },
            title: { type: "string", description: "What the step does, a few words in the user's terms." },
            status: { type: "string", enum: [...STEP_STATUSES], description: "todo, doing (the step you are on), done, skipped, or blocked (waiting on the user or on something you cannot fix)." },
            detail: { type: "string", description: "Optional one line: what you found, decided or what is in the way." },
            parts: { type: "array", items: { type: "string" }, maxItems: 30, description: "Optional part or component names this step works on." },
            parent: { type: "string", description: "Optional id of the step this is a sub-step of; it must come earlier in the list." },
          },
          required: ["id", "title", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["steps"],
    additionalProperties: false,
  },
};

const PlanInput = z.object({
  goal: z.string().max(300).optional(),
  new_plan: z.boolean().optional(),
  steps: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        title: z.string().min(1).max(300),
        status: z.enum(STEP_STATUSES),
        detail: z.string().max(1000).optional(),
        parts: z.array(z.string().max(80)).max(30).optional(),
        parent: z.string().max(40).optional(),
      }),
    )
    .max(80),
});

export function runPlanTool(input: unknown): ToolOutcome {
  const p = PlanInput.safeParse(input);
  if (!p.success) {
    const msg = p.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return { isError: true, content: `The plan was not updated. Invalid input: ${msg}`, card: { title: "Plan not updated", detail: msg, status: "error" } };
  }
  const problem = checkSteps(p.data.steps);
  if (problem) return { isError: true, content: `The plan was not updated: ${problem}`, card: { title: "Plan not updated", detail: problem, status: "error" } };
  updatePlanFromClaude({ goal: p.data.goal, steps: p.data.steps, newPlan: p.data.new_plan });
  const plan = usePlan.getState();
  const pr = progress(plan);
  const mine = plan.steps.filter((s) => s.owner === "main" && s.kind === "step");
  const count = (st: string) => mine.filter((s) => s.status === st).length;
  const doing = mine.filter((s) => s.status === "doing").length;
  const lines = [`Plan shown to the user: ${mine.length} step${mine.length === 1 ? "" : "s"} (${count("done")} done, ${doing} doing, ${count("todo")} to do${count("skipped") ? `, ${count("skipped")} skipped` : ""}${count("blocked") ? `, ${count("blocked")} blocked` : ""}).`];
  if (doing > 1) lines.push("More than one step is marked doing; keep one doing at a time unless the work really runs in parallel.");
  const kept = mine.filter((s) => s.by === "you" && !p.data.steps.some((x) => x.id === s.id));
  if (kept.length) lines.push(`Kept step${kept.length > 1 ? "s" : ""} the user added that your list left out: ${kept.map((s) => `${s.id} "${s.title}"`).join(", ")}. Include ${kept.length > 1 ? "them" : "it"} next time.`);
  const branches = plan.steps.filter((s) => s.kind !== "step");
  if (branches.length) lines.push(`Branches reported by sub-agents (not yours to list): ${branches.map((b) => `${b.title} [${b.status}]`).join(", ")}.`);
  return {
    content: lines.join("\n"),
    card: { title: pr.current ? `Plan · ${pr.current.title}` : `Plan · ${pr.done}/${pr.total} done`, detail: plan.goal || undefined },
  };
}
