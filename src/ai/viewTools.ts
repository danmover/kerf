// Assistant tools for what the user's 3D view shows: a group of parts on its
// own (the nozzle, the electronics), and the wiring with parts solid or covers
// see-through. These change only the view, never the design. group_parts writes `group:` into the design so parts can
// be shown, hidden and coloured together.

import { z } from "zod";
import { useDesign } from "../core/engine";
import { commitSource } from "../app/project";
import { diffStats } from "../core/sourceEdit";
import { useView } from "../app/view";
import { updateSettings } from "../app/settings";
import { partGroups } from "../app/partGroups";
import { withGroup, cleanGroupName } from "../app/groups";
import { toggleWiring } from "../ui/wiringView";
import type { ToolOutcome } from "./tools";

export const VIEW_TOOL_DEFS = [
  {
    name: "set_view",
    description:
      "Change what the user's 3D view shows, without changing the design: show only some groups of parts (the rest hidden, e.g. the nozzle or the electronics), turn the wiring view on or off (with every part solid and hidden cables showing through, or with covers see-through), or put it all back. Use it when the user asks to see a group, a subassembly or the wiring. Parts are grouped by their group: property; when the parts the user means are not one group yet, call group_parts first.",
    input_schema: {
      type: "object" as const,
      properties: {
        groups: { type: "array", items: { type: "string" }, maxItems: 20, description: "Show only these groups (names as the design writes them). An empty list shows every group again." },
        wiring: { type: "string", enum: ["off", "solid", "see-through"], description: "The wiring view: solid keeps every part solid and draws cables behind parts faintly through them; see-through fades the covers over the wiring." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "group_parts",
    description:
      "Put part and component blocks into a named group (sets group: on each block) so the user can show that group on its own, hide it or colour it, and the parts list gathers it under one heading. To make subassemblies easy to tell apart, also give their parts distinct color: values with edit_design. A block belongs to one group, so this moves it out of its old one. Use the names the user would use (\"Nozzle\", \"Power\", \"Frame\"). Changes only grouping, never geometry.",
    input_schema: {
      type: "object" as const,
      properties: {
        parts: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 60, description: "Part or component block names (an instance id like screw#2 counts as its block)." },
        group: { type: "string", description: "The group's name, e.g. \"Nozzle\"." },
        show: { type: "boolean", description: "Also show this group on its own in the user's view." },
      },
      required: ["parts", "group"],
      additionalProperties: false,
    },
  },
];

export const VIEW_TOOL_TITLES: Record<string, string> = { set_view: "Changing the view", group_parts: "Grouping parts" };

const SetViewInput = z.object({
  groups: z.array(z.string().min(1).max(80)).max(20).optional(),
  wiring: z.enum(["off", "solid", "see-through"]).optional(),
});
const GroupInput = z.object({
  parts: z.array(z.string().min(1).max(120)).min(1).max(60),
  group: z.string().min(1).max(80),
  show: z.boolean().optional(),
});

const err = (content: string, title: string): ToolOutcome => ({ isError: true, content, card: { title, detail: content, status: "error" } });
const issues = (e: z.ZodError) => err(e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "), "Invalid tool input");

/** The design's groups as a line for a tool result. */
function groupsLine(): string {
  const model = useDesign.getState().model;
  const gs = model ? partGroups(model.parts) : [];
  return gs.length ? `Groups: ${gs.map((g) => `${g.name} (${g.blocks.join(", ")})`).join("; ")}.` : "The design has no parts yet.";
}


export async function runViewTool(name: string, input: unknown): Promise<ToolOutcome | null> {
  switch (name) {
    case "set_view": {
      const p = SetViewInput.safeParse(input ?? {});
      if (!p.success) return issues(p.error);
      const model = useDesign.getState().model;
      if (!model) return err("No design is loaded.", "No design");
      const said: string[] = [];
      if (p.data.groups) {
        const all = partGroups(model.parts).map((g) => g.name);
        const lower = new Map(all.map((g) => [g.toLowerCase(), g]));
        const found = p.data.groups.map((g) => lower.get(g.trim().toLowerCase())).filter((g): g is string => !!g);
        const unknown = p.data.groups.filter((g) => !lower.has(g.trim().toLowerCase()));
        if (p.data.groups.length && !found.length) return err(`No group named ${unknown.map((g) => `"${g}"`).join(", ")}. ${groupsLine()} Use group_parts to make one.`, "Group not found");
        useView.setState({ soloGroups: [...new Set(found)] });
        said.push(found.length ? `showing only ${found.join(", ")}` : "showing every group");
        if (unknown.length) said.push(`no group named ${unknown.join(", ")}`);
      }
      if (p.data.wiring) {
        const hasWires = !!model.machine && model.machine.wires.length + model.machine.nets.length > 0;
        if (p.data.wiring !== "off" && !hasWires) said.push("the design has no wiring to show");
        else {
          if (p.data.wiring !== "off") updateSettings({ wiringSolid: p.data.wiring === "solid" });
          toggleWiring(p.data.wiring !== "off");
          said.push(p.data.wiring === "off" ? "wiring hidden" : p.data.wiring === "solid" ? "wiring shown with every part solid (hidden cables show faintly through)" : "wiring shown with covers see-through");
        }
      }
      if (!said.length) return err("Say what to show: groups or wiring.", "Nothing to change");
      const text = said.join("; ");
      return { content: `The user's view now has ${text}. This changed only the view, not the design. ${groupsLine()}`, card: { title: `View: ${text}` } };
    }
    case "group_parts": {
      const p = GroupInput.safeParse(input);
      if (!p.success) return issues(p.error);
      const { source, model } = useDesign.getState();
      if (!model) return err("No design is loaded.", "No design");
      const group = cleanGroupName(p.data.group);
      if (!group) return err("Give the group a name.", "No group name");
      const blocks = [...new Set(p.data.parts.map((b) => model.parts.find((x) => x.id === b)?.name ?? b))];
      const unknown = blocks.filter((b) => !model.parts.some((x) => x.name === b));
      if (unknown.length) return err(`No part or component named ${unknown.map((u) => `"${u}"`).join(", ")}.`, "Part not found");
      const r = withGroup(source, model, blocks, group);
      const shown = !!p.data.show;
      if (!r.changed.length) {
        if (shown) useView.setState({ soloGroups: [group] });
        const why = r.missing.length ? `${r.missing.join(", ")} ${r.missing.length === 1 ? "is" : "are"} not a top-level block (made in a loop or inside another block): set group: where ${r.missing.length === 1 ? "it is" : "they are"} written, with edit_design.` : `${blocks.join(", ")} ${blocks.length === 1 ? "is" : "are"} already in ${group}.`;
        return { content: `No change: ${why}${shown ? ` Showing ${group} on its own.` : ""}`, card: { title: "No change needed" } };
      }
      const summary = `Grouped ${r.changed.join(", ")} as ${group}`;
      const next = commitSource(r.src, "claude", summary);
      if (shown) useView.setState({ soloGroups: [group] });
      const errors = next.diagnostics.filter((d) => d.severity === "error").length;
      const stats = diffStats(source, r.src);
      return {
        content: [
          `${summary}.`,
          r.missing.length ? `Not changed: ${r.missing.join(", ")} (made in a loop or inside another block; set group: there with edit_design).` : "",
          shown ? `The user's view shows ${group} on its own.` : `Show it with set_view groups: ["${group}"].`,
          errors ? `The source now has ${errors} error(s); fix them with edit_design.` : "",
        ]
          .filter(Boolean)
          .join(" "),
        card: { title: summary, detail: `+${stats.added} −${stats.removed} lines`, diff: { before: source, after: r.src }, status: errors ? "error" : "done" },
      };
    }
  }
  return null;
}
