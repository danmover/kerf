// branches: the assistant keeps lines of work apart as the user does in History. It can start a branch to try a bigger
// change without touching the design's main line, switch between branches, see how one differs from the branch it
// came from, and merge it back (or take that branch's changes) with the same three-way merge, settling places both
// changed the way the user would in the merge dialog.

import { z } from "zod";
import { applyMerge, createBranch, findBranch, openBranch, planMerge, projectBranches, switchBranch, useProject } from "../app/project";
import { MAIN, branchOf, mergeState, mergedText, type MergeChoice } from "../core/branches";
import { changesBetween } from "../core/changes";
import { diffStats } from "../core/sourceEdit";
import { useDesign } from "../core/engine";
import type { BranchRecord } from "../persist/db";
import type { ToolOutcome } from "./tools";

export const BRANCH_TOOL_DEFS = [
  {
    name: "branches",
    description:
      "The design's branches, as the user has them in History: lines of work that each keep their own versions. A branch is made from another branch's design; edits made on it stay off that branch until it is merged back, so a bigger idea can be tried without losing what works. list: every branch, which is open, and whether each has changes its parent lacks or is behind it. create: a new branch from the design as it is, opened at once (your next edits go there). switch: open another branch; the design becomes its latest. compare: what a branch changed against the branch it came from (parts, parameters, lines). merge: bring a branch's changes into the branch it came from (that one opens). take: bring the parent's changes into the branch. A merge where both changed the same lines stops with the conflicts; call again with keep (one choice for each conflict, in order) or leave them for the user to settle in History. Use branches when the user asks for them, or to try an alternative they asked to keep apart; don't branch for ordinary edits.",
    input_schema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["list", "create", "switch", "compare", "merge", "take"] },
        name: { type: "string", maxLength: 60, description: "create: the new branch's name (short, about the idea: 'three arms'). switch, compare, merge, take: an existing branch (default: the open one)." },
        keep: {
          type: "array",
          maxItems: 60,
          items: { type: "string", enum: ["ours", "theirs", "both"] },
          description: "merge and take: what to keep at each conflict, in the order they were listed: ours (the branch merged into keeps its lines), theirs (the incoming branch's lines), both (ours then theirs).",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
];

export const BRANCH_TOOL_TITLES: Record<string, string> = { branches: "Working with branches" };

const Input = z.object({
  action: z.enum(["list", "create", "switch", "compare", "merge", "take"]),
  name: z.string().min(1).max(60).optional(),
  keep: z.array(z.enum(["ours", "theirs", "both"])).max(60).optional(),
});

const err = (content: string, title: string): ToolOutcome => ({ isError: true, content, card: { title, detail: content, status: "error" } });
const called = (b: { id: string; name: string } | undefined) => (!b ? "that branch" : b.id === MAIN ? "main" : `“${b.name}”`);
const clip = (lines: string[]) => {
  const shown = lines.slice(0, 12).join("\n");
  return lines.length > 12 ? `${shown}\n… ${lines.length - 12} more lines` : shown || "(nothing: removed there)";
};

/** One line for a branch in a list. */
function line(b: BranchRecord, list: BranchRecord[], counts: Map<string, number>, open: string): string {
  const parent = b.from ? list.find((x) => x.id === b.from) : undefined;
  const bits = [`${counts.get(b.id) ?? 0} versions`];
  if (parent) {
    bits.unshift(`made from ${called(parent)}`);
    const st = mergeState(b, parent.head, b.head);
    if (st.ahead) bits.push(`has changes ${called(parent)} lacks`);
    if (st.behind) bits.push(`${called(parent)} has changed since`);
    if (!st.ahead && !st.behind) bits.push(`same as ${called(parent)}`);
  }
  return `- ${called(b)}${b.id === open ? " (open)" : ""}: ${bits.join(", ")}`;
}

function listText(): string {
  const list = projectBranches();
  const open = openBranch();
  const counts = new Map<string, number>();
  for (const v of useProject.getState().versions) counts.set(branchOf(v), (counts.get(branchOf(v)) ?? 0) + 1);
  return `Branches:\n${list.map((b) => line(b, list, counts, open)).join("\n")}`;
}

/** What changed from one design to another, in parts, parameters and lines. */
function changeText(before: string, after: string): string {
  if (before === after) return "No differences.";
  const { parts, params } = changesBetween(before, after);
  const stats = diffStats(before, after);
  const out: string[] = [];
  if (parts.length) out.push(`Parts: ${parts.slice(0, 30).map((p) => `${{ added: "+", removed: "−", changed: "~", moved: "→" }[p.kind]}${p.label}`).join(", ")}${parts.length > 30 ? ` and ${parts.length - 30} more` : ""}.`);
  if (params.length) out.push(`Parameters: ${params.slice(0, 20).map((p) => `${p.name} ${p.from === undefined ? "added" : `${JSON.stringify(p.from)} → ${JSON.stringify(p.to)}`}`).join(", ")}.`);
  out.push(`Lines: +${stats.added} −${stats.removed}.`);
  return out.join(" ");
}

export async function runBranchTool(name: string, input: unknown): Promise<ToolOutcome | null> {
  if (name !== "branches") return null;
  const p = Input.safeParse(input ?? {});
  if (!p.success) return err(p.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "), "Invalid tool input");
  if (!useProject.getState().current) return err("No design is open.", "No design");
  const { action, name: key, keep } = p.data;
  const pick = (): BranchRecord | ToolOutcome => {
    const b = key ? findBranch(key) : projectBranches().find((x) => x.id === openBranch());
    return b ?? err(`No branch called “${key}”. ${listText()}`, "No such branch");
  };

  switch (action) {
    case "list":
      return { content: listText(), card: { title: "Branches" } };

    case "create": {
      if (!key) return err("Give the new branch a name.", "No name");
      const from = projectBranches().find((b) => b.id === openBranch());
      const why = await createBranch(key);
      if (why) return err(why, "Didn't make the branch");
      const made = projectBranches().find((b) => b.id === openBranch());
      return { content: `Made the branch ${called(made)} from ${called(from)} and opened it. Edits now go on ${called(made)}; ${called(from)} stays as it was until this is merged into it.`, card: { title: `New branch ${called(made)}` } };
    }

    case "switch": {
      const b = pick();
      if ("content" in b) return b;
      const why = await switchBranch(b.id);
      if (why) return err(why, "Didn't switch");
      const n = useDesign.getState().model?.parts.length ?? 0;
      return { content: `Opened ${called(b)}: the design is its latest now (${n} parts). Call get_design before editing.`, card: { title: `Opened ${called(b)}` } };
    }

    case "compare": {
      const b = pick();
      if ("content" in b) return b;
      const parent = b.from ? projectBranches().find((x) => x.id === b.from) : undefined;
      if (!parent) return { content: `${called(b)} is the design's main line; it wasn't made from another branch. ${listText()}`, card: { title: "Nothing to compare" } };
      return { content: `${called(b)} against ${called(parent)}: ${changeText(parent.head, b.head)}`, card: { title: `Compared ${called(b)} with ${called(parent)}` } };
    }

    case "merge":
    case "take": {
      const b = pick();
      if ("content" in b) return b;
      const parent = b.from ? projectBranches().find((x) => x.id === b.from) : undefined;
      if (!parent) return err(`${called(b)} wasn't made from another branch, so there is nothing to merge it into.`, "Nothing to merge");
      const [from, into] = action === "merge" ? [b, parent] : [parent, b];
      const plan = planMerge(from.id, into.id);
      if (typeof plan === "string") return err(plan, "Can't merge");
      if (plan.upToDate) return { content: `${called(into)} already has everything from ${called(from)}.`, card: { title: "Already merged" } };
      const n = plan.result.conflicts.length;
      if (n && (!keep || keep.length !== n)) {
        const list = plan.result.conflicts
          .map((c, i) => `${i + 1}. ${c.where ? `In ${c.where}` : "Near the top"}, line ${c.line}.\n  ours (${called(into)}):\n${clip(c.ours)}\n  theirs (${called(from)}):\n${clip(c.theirs)}`)
          .join("\n");
        return {
          content: `${n} place${n > 1 ? "s were" : " was"} changed on both branches. Nothing merged yet. Call again with keep: one of ours, theirs or both for each, in order${keep ? ` (you gave ${keep.length})` : ""}, or ask the user, who can settle them in History's merge dialog.\n${list}`,
          card: { title: `Merge stopped: ${n} conflict${n > 1 ? "s" : ""}`, status: "error" },
          isError: true,
        };
      }
      const text = mergedText(plan.result, (_, i) => (keep?.[i] ?? "ours") as MergeChoice);
      const why = await applyMerge(plan, text);
      if (why) return err(why, "Didn't merge");
      const e = useDesign.getState().model?.diagnostics.find((d) => d.severity === "error");
      const took = `${plan.result.fromTheirs} change${plan.result.fromTheirs === 1 ? "" : "s"} came in from ${called(from)}${n ? `, ${n} conflict${n > 1 ? "s" : ""} settled as you chose` : ""}`;
      return {
        content: `Merged ${called(from)} into ${called(into)}, which is open now: ${took}. ${e ? `The merged design has an error to fix: ${e.message}` : "It reads cleanly; run the checks."} The user can undo the merge.`,
        card: { title: `Merged ${called(from)} into ${called(into)}` },
      };
    }
  }
}
