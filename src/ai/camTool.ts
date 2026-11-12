// cnc_toolpaths: the assistant plans CNC milling toolpaths for a part with the same planner as the toolpaths
// panel (src/cam), reads what a router or mill can really cut from the part's solid, and can open the plan in
// the panel for the user to watch, change and save as G-code. sheet_layout does the same for flat parts cut from
// sheet on a laser, plasma table or waterjet, with the sheet cutting panel's nester.

import { z } from "zod";
import { useDesign } from "../core/engine";
import { camParts, gcodeFiles, jobFor, jobKey, planJob, setupName, useCam, type CamJob } from "../cam/job";
import { POSTS, type Post } from "../cam/gcode";
import type { CamResult } from "../cam/compute";
import type { EvalPart } from "../core/model";
import type { ToolOutcome } from "./tools";
import { CUTTERS, type Cutter } from "../cam/sheet";
import { cutterStart, gatherSheets, groupName, jobForGroup, layOut, planKey, sheetSummary, totals, useSheets, type SheetGroup, type SheetJob } from "../cam/sheetJob";

const DIRS: Record<string, [number, number, number]> = { "+Z": [0, 0, 1], "-Z": [0, 0, -1], "+X": [1, 0, 0], "-X": [-1, 0, 0], "+Y": [0, 1, 0], "-Y": [0, -1, 0] };
const HOLD_WORDS = { tabs: "a sheet held by tabs", base: "a block in a vise, leaving a base under the part", none: "cut right through" } as const;
const FRAME_WORDS = { router: "a CNC router", benchtop: "a benchtop mill", vmc: "a machining centre" } as const;

export const CAM_TOOL_DEFS = [
  {
    name: "cnc_toolpaths",
    description:
      "Plan CNC milling toolpaths (2.5D) for one of the design's own parts, one setup at a time, with the planner behind the user's CNC toolpaths panel: facing the stock top, roughing level by level, rest machining with smaller end mills, finishing the walls, and cutting out a sheet held by tabs or leaving a base in a vise. It reads the part's real solid, so it shows what a router or mill can really cut: material left where no tool fits (inside corners, narrow slots, holes smaller than the smallest end mill), cuts deeper than the tools reach, and how long the cutting takes. Returns the operations with their tools, spindle speeds, feeds and times, the warnings, and the G-code's files and size. Defaults come from the part's cnc_mill process (its tools, machine and first setup) or else a hobby router with 6 and 3 mm end mills. With open: true the panel opens on this plan so the user sees the paths and the stock being cut on the model, can change anything, and saves the G-code (only the user saves files). Use it to check a part is millable as designed and to set up the job for the user.",
    input_schema: {
      type: "object" as const,
      properties: {
        part: { type: "string", description: "The part, by name or id (default: the first CNC-milled part)." },
        setup: { type: "string", enum: Object.keys(DIRS), description: "Which way the tool comes from, in the part's own axes (default: the process's first setup, else +Z, from the top). Each other side to cut is another setup." },
        hold: { type: "string", enum: ["tabs", "base", "none"], description: "tabs: cut out of a sheet and held by tabs; base: a block in a vise, with a base left under the part; none: cut right through (vacuum table or tape)." },
        tools: {
          type: "array",
          maxItems: 6,
          description: "End mills to use, largest first: diameter and how deep each can cut below the stock top (mm). Add twist drills (drill: true) for round holes smaller than the smallest end mill: each drills the holes its own size.",
          items: { type: "object", properties: { d: { type: "number", exclusiveMinimum: 0, maximum: 60 }, reach: { type: "number", exclusiveMinimum: 0, maximum: 300 }, drill: { type: "boolean" } }, required: ["d"], additionalProperties: false },
        },
        material: { type: "string", description: "The stock's material (default the part's): it sets speeds and feeds." },
        machine: { type: "string", enum: ["router", "benchtop", "vmc"] },
        rpm: { type: "number", minimum: 100, maximum: 60000, description: "The spindle's top speed." },
        controller: { type: "string", enum: POSTS.map((p) => p.id), description: "grbl writes a file per tool (no tool changer); linuxcnc and mach3 write one file with tool changes." },
        margin: { type: "number", minimum: 0, maximum: 200, description: "Stock on each side of the part, mm." },
        above: { type: "number", minimum: 0, maximum: 100, description: "Stock above the part's top, mm (faced off first)." },
        below: { type: "number", minimum: 0, maximum: 200, description: "Stock under the part with hold base, mm." },
        open: { type: "boolean", description: "Open the CNC toolpaths panel on this plan." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "sheet_layout",
    description:
      "Lay the design's flat parts out on sheets for a laser, plasma table or waterjet, with the nester behind the user's sheet cutting panel. Plates (laser_cut parts, or any part the same thickness all through) and sheet-metal parts (by their flat patterns) are grouped by material and thickness, each group its own sheet stock. Each part's true shape is nested without touching, small parts in big parts' holes, turned to fit unless rotate is false; the cuts are offset half the kerf into the scrap, holes before the outline round them, each pierced in the scrap and led in. Returns the groups, the parts and how many of each, the sheets used and how full, what did not fit, the cutting length, pierces and time, and warnings (a cutter that cannot cut the material, parts with pockets or steps a through cut cannot make). Defaults come from the parts' laser_cut process and its machine. Saves (by the user) DXF and SVG at 1:1 for laser software, or G-code for GRBL lasers and plasma or waterjet tables. With open: true the panel opens on this layout so the user sees the sheets, plays the cutting, changes anything and saves the files (only the user saves files). Use it to check a design's flat parts fit the user's sheet or bed, count sheets for a quote, and set the job up for the user.",
    input_schema: {
      type: "object" as const,
      properties: {
        group: { type: "string", description: 'Which material and thickness: words from it ("plywood 6", "steel 3") or a part in it (default: the first group of parts made by cutting).' },
        qty: { type: "object", additionalProperties: { type: "integer", minimum: 0, maximum: 500 }, description: 'How many of each part a set has, by part name: {"side": 2, "shelf": 0}. 0 leaves one out. Default: as many as the design uses.' },
        sets: { type: "integer", minimum: 1, maximum: 100, description: "How many sets of the parts to cut (default 1)." },
        cutter: { type: "string", enum: CUTTERS.map((c) => c.id), description: "What cuts (default: the process's source, else what suits the material). It sets the speeds, kerf, lead-ins and gap." },
        sheet: { type: "array", items: { type: "number", minimum: 10, maximum: 10000 }, minItems: 2, maxItems: 2, description: "The sheet or the machine's bed, [x, y] mm (default: the machine's bed, else a common size the parts fit)." },
        gap: { type: "number", minimum: 0, maximum: 50, description: "Least space between parts, mm." },
        margin: { type: "number", minimum: 0, maximum: 100, description: "Least space from the sheet's edges, mm." },
        rotate: { type: "boolean", description: "Turn parts a quarter at a time to fit (false keeps wood grain or a brushed finish one way)." },
        kerf: { type: "number", minimum: 0, maximum: 5, description: "The cut's width, mm." },
        lead: { type: "number", minimum: 0, maximum: 20, description: "Lead-in length from the pierce, mm (0 pierces on the line)." },
        speed: { type: "number", minimum: 10, maximum: 50000, description: "Cutting speed, mm/min." },
        power: { type: "number", minimum: 1, maximum: 100, description: "Laser power, %." },
        passes: { type: "integer", minimum: 1, maximum: 20, description: "Times round each cut." },
        open: { type: "boolean", description: "Open the sheet cutting panel on this layout." },
      },
      additionalProperties: false,
    },
  },
];

export const CAM_TOOL_TITLES: Record<string, string> = { cnc_toolpaths: "Planning CNC toolpaths", sheet_layout: "Laying parts out on sheets" };

const SheetInput = z.object({
  group: z.string().max(200).optional(),
  qty: z.record(z.string().max(200), z.number().int().min(0).max(500)).optional(),
  sets: z.number().int().min(1).max(100).optional(),
  cutter: z.enum(["diode", "co2", "fiber", "plasma", "waterjet"]).optional(),
  sheet: z.tuple([z.number().min(10).max(10000), z.number().min(10).max(10000)]).optional(),
  gap: z.number().min(0).max(50).optional(),
  margin: z.number().min(0).max(100).optional(),
  rotate: z.boolean().optional(),
  kerf: z.number().min(0).max(5).optional(),
  lead: z.number().min(0).max(20).optional(),
  speed: z.number().min(10).max(50000).optional(),
  power: z.number().min(1).max(100).optional(),
  passes: z.number().int().min(1).max(20).optional(),
  open: z.boolean().optional(),
});

/** A group by a part in it, else by words from its material and its thickness ("plywood 6", "3mm steel"). */
export function findGroup(groups: SheetGroup[], q: string): SheetGroup | undefined {
  const low = q.trim().toLowerCase();
  const byPart = groups.find((g) => g.items.some((i) => i.names.includes(q) || i.ids.includes(q) || i.label.toLowerCase() === low));
  if (byPart) return byPart;
  const words = low
    .replace(/(\d)\s*mm\b/g, "$1")
    .split(/[\s,]+/)
    .filter((w) => w && w !== "mm");
  return groups.find((g) => words.every((w) => (/^\d+(\.\d+)?$/.test(w) ? Math.abs(parseFloat(w) - g.thickness) < 0.05 : g.material.toLowerCase().includes(w))));
}

async function runSheetTool(input: unknown): Promise<ToolOutcome> {
  const p = SheetInput.safeParse(input ?? {});
  if (!p.success) return err(p.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "), "Invalid tool input");
  const a = p.data;
  let groups: SheetGroup[];
  try {
    groups = await gatherSheets();
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e), "Couldn't read the flat parts");
  }
  if (!groups.length) return err("The design has no flat parts to cut from sheet: plates (process: laser_cut, or the same thickness all through) or sheet() parts. Bought parts come made.", "No flat parts");
  const g = a.group ? findGroup(groups, a.group) : groups[0];
  if (!g) return err(`No material and thickness matches "${a.group}". There are: ${groups.map(groupName).join("; ")}.`, "Group not found");
  let job: SheetJob = jobForGroup(g);
  if (a.cutter) {
    const c = cutterStart(a.cutter as Cutter, g.material, g.thickness);
    job = { ...job, ...c, margin: Math.max(job.margin, c.gap) };
  }
  const qty: Record<string, number> = {};
  const unknown: string[] = [];
  for (const [name, n] of Object.entries(a.qty ?? {})) {
    const it = g.items.find((i) => i.names.includes(name) || i.ids.includes(name) || i.label.toLowerCase() === name.toLowerCase());
    if (it) qty[it.key] = n;
    else unknown.push(name);
  }
  if (unknown.length) return err(`No part in ${groupName(g)} is called ${unknown.join(", ")}. Its parts: ${g.items.map((i) => i.names[0]).join(", ")}.`, "Part not found");
  job = {
    ...job,
    qty,
    sets: a.sets ?? job.sets,
    sheet: a.sheet ?? job.sheet,
    gap: a.gap ?? job.gap,
    margin: a.margin ?? job.margin,
    rotate: a.rotate ?? job.rotate,
    kerf: a.kerf ?? job.kerf,
    lead: a.lead ?? job.lead,
    speed: a.speed ?? job.speed,
    power: a.power ?? job.power,
    passes: a.passes ?? job.passes,
  };
  let r;
  try {
    r = await layOut(job, g);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e), "Couldn't lay out the sheets");
  }
  if (a.open) {
    useCam.setState({ open: false });
    useSheets.setState({ open: true, groups, job, result: r, planned: planKey(job, g), busy: false, gathering: false, error: "", sheet: 0, t: 1 });
  }
  const text = sheetSummary(job, g, r, groups);
  const n = r.nest.sheets.length;
  const detail = n ? `${n} sheet${n > 1 ? "s" : ""}, ${Math.round(r.nest.used * 100)}% used, about ${mins(totals(job, r).seconds)}${r.nest.unplaced.length ? `, ${r.nest.unplaced.reduce((x, u) => x + u.count, 0)} too big` : ""}` : "Nothing laid out";
  return { content: a.open ? `${text}\nThe sheet cutting panel is open on this layout: the user can play the cutting, change it and save the files.` : text, card: { title: `Sheets for ${groupName(g)}`, detail } };
}

const Input = z.object({
  part: z.string().max(200).optional(),
  setup: z.enum(["+Z", "-Z", "+X", "-X", "+Y", "-Y"]).optional(),
  hold: z.enum(["tabs", "base", "none"]).optional(),
  tools: z
    .array(z.object({ d: z.number().positive().max(60), reach: z.number().positive().max(300).optional(), drill: z.boolean().optional() }))
    .min(1)
    .max(8)
    .optional(),
  material: z.string().min(1).max(80).optional(),
  machine: z.enum(["router", "benchtop", "vmc"]).optional(),
  rpm: z.number().min(100).max(60000).optional(),
  controller: z.enum(["grbl", "linuxcnc", "mach3"]).optional(),
  margin: z.number().min(0).max(200).optional(),
  above: z.number().min(0).max(100).optional(),
  below: z.number().min(0).max(200).optional(),
  open: z.boolean().optional(),
});

const err = (content: string, title: string): ToolOutcome => ({ isError: true, content, card: { title, detail: content, status: "error" } });

const n = (x: number, d = 2) => String(+x.toFixed(d));
const mins = (s: number) => (s < 90 ? `${Math.max(1, Math.round(s))} s` : `${n(s / 60, 1)} min`);

/** The plan in words, for the assistant. */
export function camSummary(job: CamJob, r: CamResult, part: EvalPart): string {
  const p = r.plan;
  const st = p.stock;
  const lines: string[] = [];
  const axis = Object.entries(DIRS).find(([, d]) => d.every((x, i) => x === job.setup[i]))?.[0] ?? job.setup.join(",");
  lines.push(`CNC toolpaths for ${part.label}, ${setupName(job, part)} (tool from ${axis}), ${HOLD_WORDS[job.hold]}, on ${FRAME_WORDS[job.frame]} (spindle to ${job.rpm} rpm), in ${job.material}.`);
  lines.push(`Stock ${n(st.hi[0] - st.lo[0], 1)} × ${n(st.hi[1] - st.lo[1], 1)} × ${n(st.top - st.bottom, 1)} mm; the part as set up is ${r.size.map((x) => n(x, 1)).join(" × ")} mm. Work zero: X0 Y0 at the stock's front-left corner, Z0 on its top.`);
  if (!p.ops.length) lines.push("Nothing to cut.");
  p.ops.forEach((o, i) => lines.push(o.kind === "drill" ? `${i + 1}. ${o.label}: T${o.tool + 1} Ø${n(o.d)} mm drill, ${o.cut.rpm} rpm, feed ${o.cut.feed} mm/min, ${mins(o.seconds)}.` : `${i + 1}. ${o.label}: T${o.tool + 1} Ø${n(o.d)} mm, ${o.cut.flutes} flutes, ${o.cut.rpm} rpm, feed ${o.cut.feed} mm/min (plunge ${o.cut.plunge}), ${n(o.length / 1000, 2)} m of cutting, ${mins(o.seconds)}.`));
  if (p.ops.length) lines.push(`About ${mins(p.seconds)} of cutting in all, levels from ${n(p.levels[0] ?? st.top)} down to ${n(p.levels[p.levels.length - 1] ?? st.bottom)} mm.`);
  if (p.tabs.length) lines.push(`${p.tabs.length} tabs, ${n(job.tabs.width)} mm wide and ${n(job.tabs.height)} mm tall, hold the part in the sheet: cut them after.`);
  if (p.warnings.length) lines.push(`Warnings: ${p.warnings.join(" ")}`);
  else lines.push("No warnings: every face the tool can see from this side is cut, and the simulated cut never goes into the part.");
  if (p.ops.length) {
    const files = gcodeFiles(job, r, part);
    const count = files.reduce((a, f) => a + f.text.split("\n").length - 1, 0);
    lines.push(`G-code for ${POSTS.find((x) => x.id === job.post)?.label ?? job.post}: ${files.length === 1 ? `one file, ${files[0].name}` : `${files.length} files, a file per tool (${files.map((f) => f.name).join(", ")})`}, ${count} lines.`);
  }
  return lines.join("\n");
}

export async function runCamTool(name: string, input: unknown): Promise<ToolOutcome | null> {
  if (name === "sheet_layout") return runSheetTool(input);
  if (name !== "cnc_toolpaths") return null;
  const p = Input.safeParse(input ?? {});
  if (!p.success) return err(p.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "), "Invalid tool input");
  const a = p.data;
  const list = camParts(useDesign.getState().model);
  if (!list.length) return err("The design has none of its own parts to machine (bought parts come made).", "No parts to machine");
  const part = a.part ? list.find((x) => x.id === a.part || x.name === a.part || x.label === a.part || x.id.startsWith(`${a.part}#`) || x.id.startsWith(`${a.part}.`)) : list[0];
  if (!part) return err(`No part of the design's own is called ${a.part}. Parts: ${list.map((x) => x.name).slice(0, 30).join(", ")}.`, "Part not found");
  const base = jobFor(part);
  const hold = a.hold ?? base.hold;
  const job: CamJob = {
    ...base,
    setup: a.setup ? DIRS[a.setup] : base.setup,
    hold,
    tools: a.tools ? a.tools.map((t) => ({ d: t.d, reach: t.reach ?? Math.round((t.drill ? 8 : 4) * t.d), ...(t.drill ? { drill: true } : {}) })) : base.tools,
    material: a.material ?? base.material,
    frame: a.machine ?? base.frame,
    rpm: a.rpm ?? base.rpm,
    post: (a.controller as Post | undefined) ?? useCam.getState().job?.post ?? base.post,
    margin: a.margin ?? (hold === base.hold ? base.margin : hold === "base" ? 3 : 6),
    above: a.above ?? (hold === "base" ? Math.max(base.above, 1) : 0),
    below: a.below ?? (hold === "base" ? (base.below > 0 ? base.below : 5) : 0),
  };
  let r: CamResult;
  try {
    r = await planJob(job, part);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e), "Couldn't plan the toolpaths");
  }
  if (a.open) useCam.setState({ open: true, job, result: r, planned: `${jobKey(job)}|${part.hash}`, busy: false, error: "", t: 1 });
  const text = camSummary(job, r, part);
  const detail = r.plan.ops.length ? `${r.plan.ops.length} operations, about ${mins(r.plan.seconds)}${r.plan.warnings.length ? `, ${r.plan.warnings.length} warning${r.plan.warnings.length > 1 ? "s" : ""}` : ""}` : "Nothing to cut";
  return { content: a.open ? `${text}\nThe CNC toolpaths panel is open on this plan: the user can watch it, change it and save the G-code.` : text, card: { title: `Toolpaths for ${part.label}`, detail } };
}
