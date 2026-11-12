// Assistant tools for manufacturing processes: the rules to design a part
// to before modelling it, and a ranking of processes for a built part.

import { z } from "zod";
import { whenChecked } from "../core/engine";
import { MAX_DIRECTIONS, MAX_TOOLS, PROCESSES, PROCESS_IDS, sortTools, uniqueDirs } from "../mfg/profiles";
import { specOnMachine } from "../mfg/machines";
import { userMachines } from "../mfg/userMachines";
import { processGuideText } from "../mfg/guide";
import { compareProcesses } from "../mfg/compare";
import { processFromText } from "../mfg/spec";
import { PlanError, planDesign, planPart, projectAccess } from "../mfg/plan";
import { defaultTiers, designText, designTotals, planText, type Tier } from "../mfg/advisor";
import { availabilityText } from "../mfg/availability";
import { money } from "../materials/advise";
import { bomRows, bomTotal } from "../persist/files";
import { useSettings } from "../app/settings";
import { dfaFor } from "../mfg/dfaRuntime";
import { dfaText, fmtTime } from "../mfg/dfa";
import type { ProcessId, SettingValue, Tool } from "../mfg/types";
import type { V3 } from "../kernel/recipe";
import type { ToolOutcome } from "./tools";

export const PROCESS_TOOL_DEFS = [
  {
    name: "process_guide",
    description:
      "Design rules for one manufacturing process, to follow while modelling a part for it: wall thickness, draft, inside radii, hole sizes, overhangs and print orientation, bend radii, machine size, usual materials, how to model it in Kerf, the process: source line, and the numbers requirements can read from it. Call before modelling a part, and when the user changes how a part is made.",
    input_schema: {
      type: "object" as const,
      properties: {
        process: { type: "string", enum: [...PROCESS_IDS], description: "Process id." },
        material: { type: "string", description: "Material name, e.g. ABS or Aluminum 6061. Defaults to the process's usual material." },
        settings: {
          type: "object",
          description: 'Optional process settings by name, e.g. {"tool_d": 2, "setups": ["Z", "-Z", "X"]} or {"build": "-Z"}. Directions are axis names or [x, y, z]; tools are [[diameter, reach], ...].',
          additionalProperties: true,
        },
        machine: { type: "string", description: "A machine from Settings → Making (or a preset such as \"Prusa MK4S\") to check against. Defaults to the one chosen for this process." },
      },
      required: ["process"],
      additionalProperties: false,
    },
  },
  {
    name: "compare_processes",
    description:
      "Check one built part against every manufacturing process (or the ones listed) and rank them by failing and warning rules, with the main issues for each. Use when the user asks how a part should be made, or when a part fails its process badly.",
    input_schema: {
      type: "object" as const,
      properties: {
        part: { type: "string", description: "Part name as in the source." },
        processes: { type: "array", items: { type: "string", enum: [...PROCESS_IDS] }, maxItems: PROCESS_IDS.length, description: "Limit the comparison to these processes." },
      },
      required: ["part"],
      additionalProperties: false,
    },
  },
  {
    name: "plan_manufacturing",
    description:
      "How to make a part (or every part of the design) at a prototype, a small batch and production quantity, within the processes the user has or can order: for each quantity the recommended process and material, the cheapest and the best-quality way, cost per part with setup and tooling, total, lead time and what limits the pick; the quantity where each process becomes the cheapest; and every process with its geometry checks and costs. Without a part it totals the whole design (made parts, bought parts, assembly). Use when the user asks how to make something, what it costs, which process or material to use, or for a different quantity or budget. Costs are estimates for comparing, not quotes.",
    input_schema: {
      type: "object" as const,
      properties: {
        part: { type: "string", description: "Part name as in the source. Leave out to plan the whole design." },
        quantities: { type: "array", items: { type: "integer", minimum: 1, maximum: 10000000 }, maxItems: 5, description: "Numbers of designs to plan for, e.g. [1, 20, 2000]. Defaults to 1, 50 and 5000, plus the brief's quantity." },
        processes: { type: "array", items: { type: "string", enum: [...PROCESS_IDS] }, maxItems: PROCESS_IDS.length, description: "Only consider these processes." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "review_assembly",
    description:
      "Design for assembly review of the whole design (Boothroyd–Dewhurst): how many parts, bought parts and fasteners it has against the theoretical minimum, the estimated hand assembly time per unit and what it is spent on, the DFA index, the fastener sizes, the directions parts go in from, parts that could be combined, loose nuts and washers, and joints held by many screws. Use when the user asks about assembly, part count, fasteners or build time, and before simplifying a design.",
    input_schema: { type: "object" as const, properties: {}, additionalProperties: false },
  },
];

export const PROCESS_TOOL_TITLES: Record<string, string> = { process_guide: "Reading the process rules", compare_processes: "Comparing processes", plan_manufacturing: "Planning how to make it", review_assembly: "Reviewing the assembly" };

const ProcessIdSchema = z.string().refine((s) => !!processFromText(s), { message: `use one of ${PROCESS_IDS.join(", ")}` });
const GuideInput = z.object({ process: ProcessIdSchema, material: z.string().max(80).optional(), settings: z.record(z.string(), z.unknown()).optional(), machine: z.string().max(80).optional() });
const CompareInput = z.object({ part: z.string().min(1).max(120), processes: z.array(ProcessIdSchema).max(PROCESS_IDS.length).optional() });
const PlanInput = z.object({ part: z.string().min(1).max(120).optional(), quantities: z.array(z.number().int().min(1).max(1e7)).max(5).optional(), processes: z.array(ProcessIdSchema).max(PROCESS_IDS.length).optional() });

/** A name for a number of designs. */
const tierName = (qty: number) => (qty === 1 ? "Prototype" : qty <= 200 ? "Small batch" : qty <= 2000 ? "Batch" : "Production");

/** Tiers for the quantities Claude asked about. */
function tiersFor(qs: number[] | undefined, briefQty: number | undefined): Tier[] {
  if (!qs?.length) return defaultTiers(briefQty);
  return [...new Set(qs)].sort((a, b) => a - b).map((qty) => ({ qty, label: qty === 1 ? "Prototype" : `${tierName(qty)} of ${qty.toLocaleString("en-US")}`, brief: qty === briefQty }));
}

const AXES: Record<string, V3> = { X: [1, 0, 0], "-X": [-1, 0, 0], Y: [0, 1, 0], "-Y": [0, -1, 0], Z: [0, 0, 1], "-Z": [0, 0, -1] };

function toDir(v: unknown): V3 | null {
  if (typeof v === "string") return AXES[v.trim().toUpperCase()] ?? null;
  if (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x))) {
    const l = Math.hypot(v[0], v[1], v[2]);
    return l > 1e-9 ? [v[0] / l, v[1] / l, v[2] / l] : null;
  }
  return null;
}

const isTools = (v: unknown): v is Tool[] =>
  Array.isArray(v) && v.length > 0 && v.length <= MAX_TOOLS && v.every((t) => Array.isArray(t) && t.length === 2 && t.every((x) => typeof x === "number" && Number.isFinite(x) && x > 0));

/** Validate settings the way mfg.*() does, with errors the assistant can act on. */
function parseSettings(id: ProcessId, raw: Record<string, unknown>): { settings: Record<string, SettingValue>; errors: string[] } {
  const settings: Record<string, SettingValue> = {};
  const errors: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    const sd = PROCESSES[id].settings.find((s) => s.key === k);
    if (!sd) {
      errors.push(`${id} has no setting "${k}" (it has ${PROCESSES[id].settings.map((s) => s.key).join(", ")})`);
      continue;
    }
    if (sd.kind === "number" && typeof v === "number" && v >= 0) settings[k] = v;
    else if (sd.kind === "bool" && typeof v === "boolean") settings[k] = v;
    else if (sd.kind === "dir" && toDir(v)) settings[k] = toDir(v)!;
    else if (sd.kind === "dirs" && Array.isArray(v) && v.length && v.every((d) => toDir(d))) {
      const dirs = uniqueDirs(v.map((d) => toDir(d)!));
      if (dirs.length > MAX_DIRECTIONS) errors.push(`${k}: at most ${MAX_DIRECTIONS} different directions`);
      else settings[k] = dirs;
    } else if (sd.kind === "size" && Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && x > 0)) settings[k] = v as V3;
    else if (sd.kind === "choice" && typeof v === "string" && sd.options?.includes(v)) settings[k] = v;
    else if (sd.kind === "tools" && isTools(v)) settings[k] = sortTools(v);
    else
      errors.push(
        `${k}: expected ${
          sd.kind === "dirs"
            ? "a list of directions"
            : sd.kind === "dir"
              ? 'a direction such as "Z"'
              : sd.kind === "size"
                ? "[x, y, z] sizes"
                : sd.kind === "bool"
                  ? "true or false"
                  : sd.kind === "choice"
                    ? `one of ${sd.options?.join(", ")}`
                    : sd.kind === "tools"
                      ? `up to ${MAX_TOOLS} [diameter, reach] pairs in mm`
                      : sd.kind === "plies"
                        ? 'plies written in the design, like process: mfg.carbon_layup(plies: [plies("[0/±45/90]s")]) (edit the part\'s source)'
                        : "a non-negative number"
        }`,
      );
  }
  return { settings, errors };
}

/** How Claude chooses processes, materials and quantities with the user (static: the live process list is in the brief summary). */
export function makingPromptSection(): string {
  return `## How it is made, and what it costs
The user says which processes they have (their own printer, a laser cutter...) and which they can order, in Settings → Making or in the brief (workshop: and can_order: lists of process ids). The brief summary lists them. Recommend only processes they can use, prefer their own machines for prototypes, and mention a much cheaper process they cannot use yet only as an option.
- plan_manufacturing answers "how should I make this", "what will it cost" and "what if I made 500": for a part (or the whole design without one) it gives the recommended process and material at a prototype, a small batch and production (or the quantities you pass), the cheapest and best-quality ways, cost per part with setup and tooling, lead time, the quantity where each process becomes cheapest, and every process's geometry checks. Use it instead of guessing costs, and pass the user's own quantities and budget.
- A cheaper or better route that fails its geometry checks needs design changes first: say which (from its issues) and offer to make them with process_guide's rules.
- The make tab shows the same plan, with Use buttons. Switch a part's process or material yourself only when the user asked for it; otherwise give the recommendation and its cost difference and let them choose.
- Costs are estimates for comparing ways to make it, not quotes: say so once, and suggest a quote from a shop before committing to tooling.

## Can it really be made
Every made part is tested on each edit (process findings in the checks) against the user's machine for its process, chosen in Settings → Making and listed with the brief, or a typical shop when none is chosen. process: mfg.cnc_mill(machine: "Shop VMC") picks another machine; settings on the part override the machine's. The tests: printing checks overhangs and whether every support can be got out (support-trapped, support-narrow, support-deep), gaps that fuse shut, bed size and whether the printer reaches the material's temperature or needs an enclosure; milling checks tool-reach (each pocket and inside corner against the machine's tools, diameter × reach), setups for 3, 4 or 5 axes, travel, vise, spindle speed for the smallest tool and whether the frame cuts the material, and plans the setups; turning checks size, slenderness, bores and live tooling; moulding and die casting check draft, walls, undercuts, clamp force, shot size and flow length; casting checks the envelope and pour weight; sheet and cutting check bends, brake length and tonnage, plate thickness, bed size and whether the cutter cuts the material.
- Design to the machine from the start: process_guide gives its rules. Inside corners a little larger than the tool that reaches that depth, pockets no deeper than that tool reaches, features reachable in few setups, ceilings inside printed cavities at 45° (chamfers, teardrop or diamond holes) rather than flat.
- Do not show a design while a process check fails. Trapped or narrow supports: make the ceiling self-supporting, open the cavity, turn the part (the finding offers a better build direction) or split it; soluble support only when the printer has it. Tool reach: bigger radii, shallower or wider pockets, or a split into machinable pieces. Press, pour, brake or cutter limits: fewer cavities, a lighter part, or another process. Fix cheap warnings and explain the rest in a line.
- When a result hangs on a machine the user has not chosen, say what was assumed and that Settings → Making can set theirs.`;
}

const err = (content: string, title: string): ToolOutcome => ({ isError: true, content, card: { title, detail: content, status: "error" } });

export async function runProcessTool(name: string, input: unknown): Promise<ToolOutcome | null> {
  switch (name) {
    case "process_guide": {
      const p = GuideInput.safeParse(input);
      if (!p.success) return err(p.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "), "Invalid tool input");
      const id = processFromText(p.data.process)!;
      const { settings, errors } = parseSettings(id, p.data.settings ?? {});
      if (errors.length) return err(`Settings not applied: ${errors.join("; ")}`, "Invalid process settings");
      const on = specOnMachine({ id, settings, ...(p.data.machine ? { machine: p.data.machine } : {}) }, userMachines());
      return {
        content: processGuideText(on.spec, p.data.material, { name: on.machine, missing: on.missing }),
        card: { title: `Read the ${PROCESSES[id].label} rules`, detail: p.data.material ? `for ${p.data.material}` : undefined },
      };
    }
    case "compare_processes": {
      const p = CompareInput.safeParse(input);
      if (!p.success) return err(p.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "), "Invalid tool input");
      const s = await whenChecked();
      if (s.kernelStatus === "error") return err(`The geometry kernel is unavailable: ${s.kernelError}`, "Geometry kernel unavailable");
      const part = s.model?.parts.find((q) => q.kind === "part" && (q.name === p.data.part || q.id === p.data.part));
      if (!part) {
        const names = [...new Set((s.model?.parts ?? []).filter((q) => q.kind === "part").map((q) => q.name))];
        return err(`No custom part named "${p.data.part}". Parts: ${names.join(", ") || "none"}. Library components are bought, not made.`, "Part not found");
      }
      if (s.buildErrors.has(part.hash)) return err(`${part.name} does not build, so it cannot be checked: ${s.buildErrors.get(part.hash)}`, "Part does not build");
      const ids = p.data.processes?.map((x) => processFromText(x)!) ?? PROCESS_IDS;
      const options = await compareProcesses(part, ids);
      const current = part.process?.id;
      const lines = [`${part.name} (${part.material}) against ${options.length} processes, best fit first${current ? `; it is set to ${current}` : ""}:`];
      for (const o of options) {
        const d = PROCESSES[o.id];
        if (!o.summary) {
          lines.push(`- ${o.id} (${d.label}): could not check (${o.result.error ?? "unknown error"})`);
          continue;
        }
        const top = o.result.findings
          .filter((f) => f.status === "fail" || f.status === "warn")
          .sort((a, b) => (a.status === b.status ? 0 : a.status === "fail" ? -1 : 1))
          .slice(0, 4)
          .map((f) => `[${f.status}] ${f.title}: ${f.detail}${f.alt ? ` (option: ${f.alt.label})` : ""}`);
        lines.push(`- ${o.id} (${d.label}): ${o.summary.fail} fail, ${o.summary.warn} warn, ${o.summary.pass} pass.${top.length ? "\n    " + top.join("\n    ") : ""}`);
      }
      lines.push("Directions are in the part's own frame, as modelled. A process that fits the geometry may still be wrong for the quantity, cost or material; weigh those with the user.");
      const best = options.filter((o) => o.summary).slice(0, 3);
      return {
        content: lines.join("\n"),
        card: { title: `Compared ${options.length} processes for ${part.label}`, detail: best.map((o) => `${PROCESSES[o.id].short}: ${o.summary!.fail} fail · ${o.summary!.warn} warn`).join("\n") },
      };
    }
    case "plan_manufacturing": {
      const p = PlanInput.safeParse(input);
      if (!p.success) return err(p.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "), "Invalid tool input");
      const s = await whenChecked();
      const model = s.model;
      if (!model) return err("There is no design yet.", "No design");
      const tiers = tiersFor(p.data.quantities, model.brief?.quantity);
      const only = p.data.processes?.map((x) => processFromText(x)!);
      const { access, fromBrief } = projectAccess(model.brief);
      const avail = `Processes: ${availabilityText(access, fromBrief)}`;
      if (p.data.part) {
        const name = model.parts.find((q) => q.id === p.data.part)?.name ?? p.data.part;
        try {
          const { plan } = await planPart(name, { tiers, only });
          return {
            content: `${planText(plan)}\n${avail}`,
            card: {
              title: `Planned how to make ${plan.label}`,
              detail: plan.tiers.map((t) => `${t.label}: ${t.recommended ? `${PROCESSES[t.recommended.process].short}, ${t.recommended.materialLabel}, ${money(t.recommended.costs[plan.tiers.indexOf(t)]!.unit)} each` : "no usable way"}`).join("\n"),
            },
          };
        } catch (e) {
          if (e instanceof PlanError) {
            const names = [...new Set(model.parts.filter((q) => q.kind === "part" && !q.imported).map((q) => q.name))];
            return err(`${e.message}${/No part named/.test(e.message) ? ` Made parts: ${names.join(", ") || "none"}.` : ""}`, "Cannot plan this part");
          }
          throw e;
        }
      }
      const design = await planDesign({ tiers });
      const plans = design.parts.map((x) => x.plan);
      const extras = { bought: bomTotal(bomRows(model)).total, labour: useSettings.getState().labourRate };
      const totals = designTotals(plans, tiers, extras);
      const per = plans.map((pl) => `${pl.part}: ${pl.tiers.map((t) => (t.recommended ? `${t.qty}→${t.recommended.process}` : `${t.qty}→none`)).join(", ")}`);
      return {
        content: [designText(plans, totals, extras), design.skipped.length ? `Not planned: ${design.skipped.map((x) => `${x.label} (${x.why})`).join("; ")}` : "", `Picks by part (designs→process): ${per.join("; ")}`, avail, "Call plan_manufacturing with a part for its full comparison. Costs are estimates for comparing, not quotes."].filter(Boolean).join("\n"),
        card: { title: `Planned how to make the design`, detail: totals.map((t) => `${t.label}: ${money(t.each)} per design`).join("\n") },
      };
    }
    case "review_assembly": {
      const s = await whenChecked();
      if (!s.model) return err("There is no design yet.", "No design");
      const r = dfaFor(s.model, s.buildErrors);
      return {
        content: dfaText(r),
        card: { title: "Reviewed the assembly", detail: r.counts.items ? `${r.counts.items} items, minimum ${r.minimumParts}\nabout ${fmtTime(r.time.seconds)} to assemble` : "nothing to assemble yet" },
      };
    }
  }
  return null;
}
