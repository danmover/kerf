// Tools Claude uses to read, edit and verify the design. Every edit goes
// through the same source-text path as manual edits, and every input is
// validated before it touches the design.

import { z } from "zod";
import { useDesign, whenChecked, solveWith, evaluateOnly } from "../core/engine";
import { applyTextEdits, diffStats } from "../core/sourceEdit";
import { decisionsSummary } from "../core/decisions";
import type { Model } from "../core/model";
import type { CheckReport } from "../core/checks";
import { commitSource } from "../app/project";
import { viewport } from "../app/viewportApi";
import { MAX_SOURCE_CHARS } from "../persist/files";
import { fmtNum } from "../lang/values";
import { lineCol } from "../lang/lexer";
import { BUILD_TOOL, runBuildTool } from "../agents/tool";
import { PLAN_TOOL, runPlanTool } from "./planTool";
import { REVIEW_TOOL } from "./review/tool";
import { useProject } from "../app/project";
import { assetBlock } from "../persist/assets";
import { briefContext, briefData, briefHasErrors, emptyBrief, FIELDS, openAssumptions, protectedBriefChanges, validId, writeBrief, type BriefData, type FieldKey } from "../core/brief";
import { IMPORT_TOOL_DEFS, IMPORT_TOOL_TITLES, importsSummary, runImportTool } from "./importTools";

// no generated code: the page CSP forbids eval
z.config({ jitless: true });

export const VIEW_NAMES = ["iso", "front", "back", "top", "bottom", "left", "right"] as const;

export const TOOL_DEFS = [
  PLAN_TOOL,
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
    name: "update_brief",
    description:
      "Record or change the design brief, saved at the top of the design file: what the design is for, its uses, the given dimensions of things it meets, where it lives, how it is made, its limits, references and assumptions. The app turns the brief into automatic checks and shows it to the user, who can edit it. Call this before modelling a new design, and whenever the user tells you something about any of these. Entries in uses, givens, references and assumptions merge by id, name or text: an entry you send replaces the one with the same key, and remove: true deletes it. Mark what you decided or estimated yourself as assumed so the user can confirm it. Changing or removing something the user stated is refused unless the user asked for that change in this conversation (then set user_asked).",
    input_schema: {
      type: "object" as const,
      properties: {
        summary: { type: "string", description: "One short line for the version history, e.g. 'Recorded the brief for the tube bracket'." },
        fields: {
          type: "object",
          description: "Brief fields to set.",
          properties: {
            purpose: { type: "string", description: "What the design is for, in one or two sentences." },
            setting: { type: "string", description: "Where and how it is used and handled, and by whom." },
            priorities: { type: "array", items: { type: "string" }, maxItems: 8, description: "Most important first, e.g. strength, low weight, print time, looks, low cost." },
            look: { type: "string", description: "Appearance and finish." },
            temp: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "Service temperature range in °C: [lowest, highest]." },
            outdoor: { type: "boolean" },
            exposure: { type: "array", items: { type: "string" }, maxItems: 12, description: "What it is exposed to, e.g. sunlight, rain, humidity, oil, chemicals, food contact, dust, impacts, vibration." },
            process: { type: "string", description: "How it is made: FDM print, Resin print, SLS print, CNC machined, Laser cut, Sheet metal, Injection moulded or another process." },
            material: { type: "string", description: "Preferred material for made parts." },
            quantity: { type: "integer", minimum: 1 },
            build_volume: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3, description: "Printer build volume in mm (X, Y, Z)." },
            max_size: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3, description: "The whole design must fit within this box, in mm (X, Y, Z)." },
            max_mass: { type: "number", description: "Maximum total mass in grams." },
          },
          additionalProperties: false,
        },
        clear_fields: { type: "array", items: { type: "string", enum: FIELDS.map((f) => f.key) }, description: "Fields to remove from the brief." },
        assumed_fields: { type: "array", items: { type: "string", enum: FIELDS.map((f) => f.key) }, description: "Fields set in this call that are your assumption rather than the user's words. Fields set without being listed here count as stated by the user." },
        uses: {
          type: "array",
          maxItems: 30,
          description: "What the design must do or survive, one entry each. Every use should later be covered by requirements written as require \"...\" for <id>: ....",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Short name, letters, digits and _, e.g. hold_tube." },
              text: { type: "string", description: "The use in the user's terms, e.g. 'Holds a 25 mm tube without slipping'." },
              assumed: { type: "boolean" },
              load_n: { type: "number", description: "Force in newtons. Convert masses with 9.81 m/s² (2 kg hanging = 19.6 N)." },
              load_dir: { type: "string", enum: ["-Z", "Z", "-X", "X", "-Y", "Y"], description: "Direction the load acts along (-Z is down)." },
              on: { type: "string", description: "Part or component the load acts on." },
              cycles: { type: "integer", minimum: 1, description: "How many times it happens over the design's life." },
              note: { type: "string" },
              remove: { type: "boolean" },
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
        givens: {
          type: "array",
          maxItems: 40,
          description: "Fixed facts about the world the design must fit: sizes of the things it holds, mounts to or sits in. Each becomes a name the design can read, like a locked parameter.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Name the design uses, e.g. tube_d." },
              value: { type: "string", description: "The value as Kerf source with units, e.g. \"25mm\" or \"1.5in\"." },
              description: { type: "string", description: "What it is and where it came from, e.g. 'Tube outside diameter, measured with calipers'." },
              assumed: { type: "boolean" },
              remove: { type: "boolean" },
            },
            required: ["name"],
            additionalProperties: false,
          },
        },
        references: {
          type: "array",
          maxItems: 30,
          description: "Notes on reference images, drawings, PDFs and links. Files the user attaches are added as references automatically; use this to give them a title and record what they show.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              notes: { type: "string", description: "What it shows that matters: dimensions read or estimated (say how), features to match, constraints." },
              url: { type: "string" },
              remove: { type: "boolean" },
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
        assumptions: {
          type: "array",
          maxItems: 30,
          description: "Free-form assumptions that are not a field, use or given, e.g. 'Wood screws, not machine screws'. Matched by text.",
          items: {
            type: "object",
            properties: { text: { type: "string" }, confirmed: { type: "boolean", description: "True when the user confirmed it." }, remove: { type: "boolean" } },
            required: ["text"],
            additionalProperties: false,
          },
        },
        user_asked: { type: "boolean", description: "Set true only when the user explicitly asked in this conversation to change or remove something they stated in the brief." },
      },
      required: ["summary"],
      additionalProperties: false,
    },
  },
  {
    name: "view_reference",
    description: "Look at a reference file from the brief again (a photo, sketch or PDF the user attached), with its notes. Use it when an earlier image has dropped out of the conversation or you need to check a detail.",
    input_schema: {
      type: "object" as const,
      properties: { id: { type: "string", description: "The reference id from the brief, e.g. photo1." } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "ask_user",
    description:
      "Ask the user to decide between options (a tradeoff, a conflict, a missing dimension). Shows a choice card and ends your turn; the user's choice comes back as this tool's result. Use when the decision changes their goal or a visible outcome. Give 2 to 4 options, each with a one-line consequence, and mark the one you recommend. When an option comes down to parameter values, give them in set: the user can then preview each option live in the 3D view with its checks, fine-tune the values, and Kerf applies them when they choose. Kerf records the answer as a decision block in the source.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Two to four words naming the decision for the decision log, e.g. 'Enclosure width'." },
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
              set: {
                type: "object",
                description: "Parameter values this option means, by parameter name, in mm and degrees, e.g. {\"width\": 77, \"corner_r\": 5}. Only unlocked params. Leave out for options that need other changes.",
                additionalProperties: { type: ["number", "string", "boolean"] },
              },
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
  BUILD_TOOL,
  REVIEW_TOOL,
  {
    name: "suggest_next_steps",
    description:
      "Offer the user two to four likely follow-ups as one-click chips under your reply: a refinement they will probably want, a check or view worth seeing, or the next part of the design. Each prompt is sent as the user's message when clicked, so write it in their voice and make it specific to this design. Call it once, in the same response as your final reply, after the text. It ends your turn. Skip it after a plain answer to a question.",
    input_schema: {
      type: "object" as const,
      properties: {
        suggestions: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Two to six words, e.g. 'Add a cable notch'." },
              prompt: { type: "string", description: "The full message sent when clicked, e.g. 'Add a 10 × 6 mm cable notch to the back wall, centred.'" },
            },
            required: ["label", "prompt"],
            additionalProperties: false,
          },
        },
      },
      required: ["suggestions"],
      additionalProperties: false,
    },
  },
  ...IMPORT_TOOL_DEFS,
];

const EditInput = z.object({
  summary: z.string().min(1).max(300),
  edits: z.array(z.object({ old_text: z.string().max(MAX_SOURCE_CHARS), new_text: z.string().max(MAX_SOURCE_CHARS) })).min(1).max(40),
  unlock_ok: z.boolean().optional(),
});
const WriteInput = z.object({ summary: z.string().min(1).max(300), source: z.string().min(1).max(MAX_SOURCE_CHARS), unlock_ok: z.boolean().optional() });
const FixInput = z.object({ hold: z.array(z.string().max(80)).max(50).optional() });
const ViewInput = z.object({ view: z.enum(VIEW_NAMES), highlight: z.array(z.string().max(80)).max(30).optional(), section: z.enum(["x", "y", "z"]).optional() });
const SetInput = z.record(z.string().min(1).max(80), z.union([z.number().finite(), z.string().max(200), z.boolean()]));
const AskInput = z.object({
  title: z.string().max(80).optional(),
  question: z.string().min(1).max(500),
  options: z
    .array(z.object({ label: z.string().min(1).max(80), consequence: z.string().max(300), recommended: z.boolean().optional(), set: SetInput.optional() }))
    .min(2)
    .max(4)
    .refine((os) => new Set(os.map((o) => o.label)).size === os.length, "option labels must be different"),
});

const Num = z.number().finite();
const BriefInput = z.object({
  summary: z.string().min(1).max(300),
  fields: z
    .object({
      purpose: z.string().max(600),
      setting: z.string().max(800),
      priorities: z.array(z.string().max(60)).max(8),
      look: z.string().max(300),
      temp: z.tuple([Num.min(-200).max(1500), Num.min(-200).max(1500)]),
      outdoor: z.boolean(),
      exposure: z.array(z.string().max(60)).max(12),
      process: z.string().max(80),
      material: z.string().max(80),
      quantity: z.number().int().min(1).max(10_000_000),
      build_volume: z.tuple([Num.positive(), Num.positive(), Num.positive()]),
      max_size: z.tuple([Num.positive(), Num.positive(), Num.positive()]),
      max_mass: Num.positive(),
    })
    .partial()
    .strict()
    .optional(),
  clear_fields: z.array(z.string()).max(20).optional(),
  assumed_fields: z.array(z.string()).max(20).optional(),
  uses: z
    .array(
      z.object({
        id: z.string().max(40),
        text: z.string().min(1).max(300).optional(),
        assumed: z.boolean().optional(),
        load_n: Num.positive().max(1e7).optional(),
        load_dir: z.enum(["-Z", "Z", "-X", "X", "-Y", "Y"]).optional(),
        on: z.string().max(80).optional(),
        cycles: z.number().int().min(1).max(1e12).optional(),
        note: z.string().max(300).optional(),
        remove: z.boolean().optional(),
      }),
    )
    .max(30)
    .optional(),
  givens: z
    .array(z.object({ name: z.string().max(40), value: z.string().min(1).max(120).optional(), description: z.string().max(200).optional(), assumed: z.boolean().optional(), remove: z.boolean().optional() }))
    .max(40)
    .optional(),
  references: z
    .array(z.object({ id: z.string().max(40), title: z.string().min(1).max(160).optional(), notes: z.string().max(1500).optional(), url: z.string().max(500).optional(), remove: z.boolean().optional() }))
    .max(30)
    .optional(),
  assumptions: z.array(z.object({ text: z.string().min(1).max(300), confirmed: z.boolean().optional(), remove: z.boolean().optional() })).max(30).optional(),
  user_asked: z.boolean().optional(),
});
const RefInput = z.object({ id: z.string().max(40) });

const AXIS_DIRS: Record<string, V3> = { X: [1, 0, 0], "-X": [-1, 0, 0], Y: [0, 1, 0], "-Y": [0, -1, 0], Z: [0, 0, 1], "-Z": [0, 0, -1] };

/** Applies an update_brief call to brief data. Returns the new data or the reasons it cannot apply. */
export function applyBriefInput(before: BriefData | null, input: z.infer<typeof BriefInput>): { data: BriefData; errors: string[] } {
  const d: BriefData = before ? structuredClone(before) : emptyBrief();
  const errors: string[] = [];
  const keys = new Set(FIELDS.map((f) => f.key as string));
  const f = input.fields ?? {};
  const setKeys = Object.keys(f) as FieldKey[];
  if (f.purpose !== undefined) d.purpose = f.purpose.trim() || undefined;
  if (f.setting !== undefined) d.setting = f.setting.trim() || undefined;
  if (f.look !== undefined) d.look = f.look.trim() || undefined;
  if (f.priorities) d.priorities = f.priorities.map((x) => x.trim()).filter(Boolean);
  if (f.temp) {
    if (f.temp[0] > f.temp[1]) errors.push("fields.temp: give the lowest temperature first");
    d.temp = [f.temp[0], f.temp[1]];
  }
  if (f.outdoor !== undefined) d.outdoor = f.outdoor;
  if (f.exposure) d.exposure = f.exposure.map((x) => x.trim()).filter(Boolean);
  if (f.process !== undefined) d.process = f.process.trim() || undefined;
  if (f.material !== undefined) d.material = f.material.trim() || undefined;
  if (f.quantity !== undefined) d.quantity = f.quantity;
  if (f.build_volume) d.buildVolume = [...f.build_volume];
  if (f.max_size) d.maxSize = [...f.max_size];
  if (f.max_mass !== undefined) d.maxMass = f.max_mass;
  for (const k of input.clear_fields ?? []) {
    const field = FIELDS.find((x) => x.key === k);
    if (!field) {
      errors.push(`clear_fields: there is no field "${k}"`);
      continue;
    }
    if (field.prop === "priorities" || field.prop === "exposure") d[field.prop] = [];
    else (d as unknown as Record<string, unknown>)[field.prop] = undefined;
    d.assumed = d.assumed.filter((x) => x !== k);
  }
  const assumed = new Set(input.assumed_fields ?? []);
  for (const k of assumed) if (!keys.has(k)) errors.push(`assumed_fields: there is no field "${k}"`);
  for (const k of setKeys) {
    d.assumed = d.assumed.filter((x) => x !== k);
    if (assumed.has(k)) d.assumed.push(k);
  }
  d.assumed = FIELDS.map((x) => x.key as string).filter((k) => d.assumed.includes(k));
  for (const u of input.uses ?? []) {
    if (!validId(u.id)) {
      errors.push(`uses: "${u.id}" is not a valid id (letters, digits and _, starting with a letter)`);
      continue;
    }
    const i = d.uses.findIndex((x) => x.id === u.id);
    if (u.remove) {
      if (i >= 0) d.uses.splice(i, 1);
      continue;
    }
    const cur = i >= 0 ? d.uses[i] : null;
    if (!cur && !u.text) {
      errors.push(`uses: new use "${u.id}" needs text`);
      continue;
    }
    const next = { ...(cur ?? { id: u.id, text: u.text!, assumed: false }) };
    if (u.text) next.text = u.text.trim();
    if (u.assumed !== undefined) next.assumed = u.assumed;
    else if (!cur) next.assumed = false;
    if (u.load_n !== undefined) next.load = u.load_n;
    if (u.load_dir) next.dir = AXIS_DIRS[u.load_dir];
    if (u.on !== undefined) next.on = u.on.trim() || undefined;
    if (u.cycles !== undefined) next.cycles = u.cycles;
    if (u.note !== undefined) next.note = u.note.trim() || undefined;
    if (cur) d.uses[i] = next;
    else d.uses.push(next);
  }
  for (const g of input.givens ?? []) {
    if (!validId(g.name)) {
      errors.push(`givens: "${g.name}" is not a valid name`);
      continue;
    }
    const i = d.givens.findIndex((x) => x.name === g.name);
    if (g.remove) {
      if (i >= 0) d.givens.splice(i, 1);
      continue;
    }
    const cur = i >= 0 ? d.givens[i] : null;
    if (!cur && !g.value) {
      errors.push(`givens: new given "${g.name}" needs a value`);
      continue;
    }
    if (g.value && /[\n{}]/.test(g.value)) {
      errors.push(`givens: the value of "${g.name}" should be one expression such as 25mm`);
      continue;
    }
    const next = { ...(cur ?? { name: g.name, text: g.value!, assumed: false }) };
    if (g.value) next.text = g.value.trim();
    if (g.description !== undefined) next.desc = g.description.trim() || undefined;
    if (g.assumed !== undefined) next.assumed = g.assumed;
    else if (!cur) next.assumed = false;
    if (cur) d.givens[i] = next;
    else d.givens.push(next);
  }
  for (const r of input.references ?? []) {
    if (!validId(r.id)) {
      errors.push(`references: "${r.id}" is not a valid id`);
      continue;
    }
    const i = d.refs.findIndex((x) => x.id === r.id);
    if (r.remove) {
      if (i >= 0) d.refs.splice(i, 1);
      continue;
    }
    if (r.url !== undefined && r.url && !/^https?:\/\/\S+$/i.test(r.url)) {
      errors.push(`references: the url of "${r.id}" should start with https://`);
      continue;
    }
    const cur = i >= 0 ? d.refs[i] : null;
    if (!cur && !r.title) {
      errors.push(`references: new reference "${r.id}" needs a title`);
      continue;
    }
    const next = { ...(cur ?? { id: r.id, title: r.title! }) };
    if (r.title) next.title = r.title.trim();
    if (r.notes !== undefined) next.notes = r.notes.trim() || undefined;
    if (r.url !== undefined) next.url = r.url.trim() || undefined;
    if (cur) d.refs[i] = next;
    else d.refs.push(next);
  }
  for (const a of input.assumptions ?? []) {
    const i = d.assumptions.findIndex((x) => x.text === a.text.trim());
    if (a.remove) {
      if (i >= 0) d.assumptions.splice(i, 1);
      continue;
    }
    if (i >= 0) d.assumptions[i] = { ...d.assumptions[i], confirmed: a.confirmed ?? d.assumptions[i].confirmed };
    else d.assumptions.push({ text: a.text.trim(), confirmed: a.confirmed ?? false });
  }
  return { data: d, errors };
}

export type ToolResultContent =
  | string
  | ({ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: "image/jpeg" | "image/png"; data: string } } | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string }; title?: string })[];

type V3 = [number, number, number];

const SuggestInput = z.object({
  suggestions: z.array(z.object({ label: z.string().min(1).max(60), prompt: z.string().min(1).max(600) })).min(1).max(4),
});

export interface AskOption {
  label: string;
  consequence: string;
  recommended?: boolean;
  set?: Record<string, number | string | boolean>;
}


export interface ToolOutcome {
  content: ToolResultContent;
  isError?: boolean;
  /** what the chat shows on the tool card */
  card: { title: string; detail?: string; diff?: { before: string; after: string }; image?: string; status?: "done" | "error" };
  /** ends the turn and waits for the user */
  ask?: { title?: string; question: string; options: AskOption[] };
  /** follow-ups to show as chips; ends the turn without another request */
  suggest?: { label: string; prompt: string }[];
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
  const imports = importsSummary(m);
  if (imports) lines.push(imports);
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
  const decisions = decisionsSummary(m);
  if (decisions) lines.push(decisions);
  const errs = m.diagnostics.filter((d) => d.severity === "error");
  if (errs.length) lines.push("Source errors:\n" + errs.map((d) => `  - line ${lineCol(useDesign.getState().source, d.start).line}: ${d.message}`).join("\n"));
  const warns = m.diagnostics.filter((d) => d.severity === "warning");
  if (warns.length) lines.push("Warnings:\n" + warns.map((d) => `  - ${d.message}`).join("\n"));
  return lines.join("\n");
}

/** The brief as Claude reads it, with each use's check status from the latest report. */
export function briefSummary(): string {
  const { model, report } = useDesign.getState();
  if (!model) return "";
  return briefContext(briefData(model.brief), (id) => {
    const it = report?.items.find((i) => i.id === `use:${id}`);
    if (!it) return undefined;
    return it.detail.startsWith("No check") ? "not checked yet" : `${it.status}: ${it.detail}`;
  });
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

export function numbered(src: string) {
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
  // what the user stated in the brief is held like a lock
  for (const c of protectedBriefChanges(briefData(a.brief), briefData(b.brief))) out.push(`the brief's ${c}`);
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
        content: `Rejected: this edit changes items the user locked or stated in the brief (${locked.join(", ")}). Find a solution that keeps them, or ask the user. Only if the user explicitly asked for this change, retry with unlock_ok (edit_design, write_design) or user_asked (update_brief).`,
        card: { title: "Edit blocked: touches what you locked or stated", detail: locked.join(", "), status: "error" },
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

export async function runTool(name: string, input: unknown, ctx: { signal?: AbortSignal; toolUseId?: string } = {}): Promise<ToolOutcome> {
  switch (name) {
    case "build_subassemblies":
      return runBuildTool(input, ctx);
    case "update_plan":
      return runPlanTool(input);
    case "get_design": {
      const { source, model, report } = useDesign.getState();
      return {
        content: `<source>\n${numbered(source)}\n</source>\n\n${modelSummary(model)}\n\n${briefSummary()}\n\n${reportSummary(report)}`,
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
      return {
        content: `${modelSummary(s.model)}\n\n${reportSummary(r)}\nBuild: ${s.timings.built} solid(s) built, ${s.timings.reused} reused, ${Math.round(s.timings.buildMs)} ms; checks ${Math.round(s.timings.checksMs)} ms.${s.checksError ? `\nChecks error: ${s.checksError}` : ""}`,
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
      const url = await vp.capture({ view: p.data.view, width: 1024, height: 704, focus: ids, section: p.data.section, mime: "image/jpeg", quality: 0.85, samples: 24 });
      const data = url.split(",")[1] ?? "";
      return {
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data } },
          { type: "text", text: `Rendered ${p.data.view} view${p.data.section ? `, sectioned across ${p.data.section}` : ""}${ids.length ? `, highlighting ${p.data.highlight!.join(", ")}` : ""}. Z is up; X is red, Y is green in the axis triad.` },
        ],
        card: { title: `Looked at the ${p.data.view} view`, image: url },
      };
    }
    case "update_brief": {
      const p = BriefInput.safeParse(input);
      if (!p.success) return invalid(p.error);
      const { source, model } = useDesign.getState();
      if (briefHasErrors(source, model)) {
        return { isError: true, content: "The brief block in the source has a syntax error, so it cannot be updated as data. Fix it with edit_design first (see the source errors from get_design).", card: { title: "Brief has a syntax error", status: "error" } };
      }
      const { data, errors } = applyBriefInput(briefData(model?.brief), p.data);
      if (errors.length) return { isError: true, content: `The brief was not changed.\n${errors.join("\n")}`, card: { title: "Brief update rejected", detail: errors[0], status: "error" } };
      const next = writeBrief(source, model, data);
      if (next.length > MAX_SOURCE_CHARS) return { isError: true, content: "The design would exceed the 300,000 character limit.", card: { title: "Brief too large", status: "error" } };
      const out = applySource(next, p.data.summary, p.data.user_asked);
      if (out.isError || typeof out.content !== "string") return out;
      const m = useDesign.getState().model;
      const open = openAssumptions(briefData(m?.brief));
      const uncovered = (m?.brief?.uses ?? []).filter((u) => !m!.requirements.some((r) => r.uses.includes(u.id)));
      // the geometry checks rerun after this edit, so report what the parameters already show
      const useStatus = (id: string) => {
        const rs = m?.requirements.filter((r) => r.uses.includes(id)) ?? [];
        if (!rs.length) return "no requirement yet";
        const failing = rs.filter((r) => r.status === "fail");
        if (failing.length) return `fail: ${failing.map((r) => `${r.label} (${r.detail})`).join("; ")}`;
        const pending = rs.filter((r) => r.status === "pending").length;
        return pending ? `${rs.length - pending} of ${rs.length} requirements pass; ${pending} measured after the build (see run_checks)` : `pass (${rs.length} requirement${rs.length === 1 ? "" : "s"})`;
      };
      const notes = [
        briefContext(briefData(m?.brief), useStatus),
        uncovered.length ? `Uses with no requirement yet: ${uncovered.map((u) => u.id).join(", ")}. Add require "..." for <id>: ... statements once the geometry exists.` : "",
        out.content,
      ];
      return {
        ...out,
        content: notes.filter(Boolean).join("\n\n"),
        card: { ...out.card, detail: [`${data.uses.length} use${data.uses.length === 1 ? "" : "s"}`, `${data.givens.length} given${data.givens.length === 1 ? "" : "s"}`, open.length ? `${open.length} to confirm` : ""].filter(Boolean).join(" · ") },
      };
    }
    case "view_reference": {
      const p = RefInput.safeParse(input);
      if (!p.success) return invalid(p.error);
      const ref = useDesign.getState().model?.brief?.refs.find((r) => r.id === p.data.id);
      if (!ref) return { isError: true, content: `The brief has no reference "${p.data.id}". References: ${(useDesign.getState().model?.brief?.refs ?? []).map((r) => r.id).join(", ") || "none"}.`, card: { title: "Reference not found", status: "error" } };
      const about = `Reference ${ref.id}: “${ref.title}”${ref.url ? ` <${ref.url}>` : ""}${ref.notes ? `\nNotes: ${ref.notes}` : ""}`;
      const projectId = useProject.getState().current?.id;
      const block = ref.file && projectId ? await assetBlock(projectId, ref.file, ref.title) : null;
      if (!block) return { content: `${about}\n${ref.file ? "The stored file is missing from this browser." : "This reference has no stored file."}${ref.url ? " Kerf cannot open web links for you; ask the user for what you need from it." : ""}`, card: { title: `Read reference “${ref.title}”` } };
      return { content: [{ type: "text", text: about }, block], card: { title: `Looked at “${ref.title}”` } };
    }
    case "ask_user": {
      const p = AskInput.safeParse(input);
      if (!p.success) return invalid(p.error);
      // option values must name unlocked parameters of the right type
      const model = useDesign.getState().model;
      const problems: string[] = [];
      for (const o of p.data.options) {
        for (const [k, v] of Object.entries(o.set ?? {})) {
          const q = model?.params.find((x) => x.name === k);
          if (!q) problems.push(`option "${o.label}" sets "${k}", which is not a parameter`);
          else if (q.locked) problems.push(`option "${o.label}" sets "${k}", which the user locked`);
          else if (typeof q.value !== typeof v) problems.push(`option "${o.label}" gives "${k}" a ${typeof v}, but it is a ${typeof q.value}`);
        }
        if (Object.keys(o.set ?? {}).length > 20) problems.push(`option "${o.label}" sets more than 20 parameters`);
      }
      if (problems.length) return { isError: true, content: `The question was not shown: ${problems.join("; ")}. Fix the option values (or leave set out for that option) and ask again.`, card: { title: "Question needs fixing", detail: problems[0], status: "error" } };
      return { content: "", card: { title: p.data.question }, ask: { title: p.data.title, question: p.data.question, options: p.data.options } };
    }
    case "suggest_next_steps": {
      const p = SuggestInput.safeParse(input);
      if (!p.success) return invalid(p.error);
      return { content: "Shown to the user as chips. A click sends that prompt as their next message.", card: { title: "Suggested next steps" }, suggest: p.data.suggestions };
    }
  }
  const imported = await runImportTool(name, input);
  if (imported) return imported;
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
  update_plan: "Updating the plan",
  get_design: "Reading the design",
  edit_design: "Editing the design",
  write_design: "Writing the design",
  run_checks: "Building and checking",
  explore_fixes: "Searching for fixes",
  capture_view: "Looking at the model",
  update_brief: "Updating the brief",
  view_reference: "Looking at a reference",
  ask_user: "Asking you",
  build_subassemblies: "Building subassemblies in parallel",
  review_design: "Reviewing the design",
  suggest_next_steps: "Suggesting next steps",
  ...IMPORT_TOOL_TITLES,
};
