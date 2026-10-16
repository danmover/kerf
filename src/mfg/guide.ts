// What the assistant is told about manufacturing processes: the working
// method for its system prompt, the language reference, and the per-process
// guide its process_guide tool returns. Generated from the same tables the
// checks use, so the advice and the checks cannot drift apart.

import { MODIFIER_PARAMS } from "../lang/builtins";
import { PROCESSES, PROCESS_IDS, axisName, fmt, generalToleranceFor, guideLines, resolveRules, ruleFields, specToSource } from "./profiles";
import { defaultMaterial, materialFit, suggestMaterials } from "./materials";
import type { ProcessId, ProcessSpec, Rules } from "./types";

/**
 * Whether the language has the richer modelling features yet: draft(), rib()
 * and gusset(), and edge selections such as "concave" (they arrive together,
 * so draft stands for all of them).
 */
const richModelling = () => "draft" in MODIFIER_PARAMS;

/** The faces a pull slides along, as a selection in the language. */
function draftFaces(pull: string): string {
  const axis = pull.replace("-", "");
  if (axis === "Z") return '"vertical"';
  if (axis === "X" || axis === "Y") {
    return ["X", "Y", "Z"]
      .filter((a) => a !== axis)
      .flatMap((a) => [`facing(${a})`, `facing(-${a})`])
      .join(" + ");
  }
  return "the faces that run along the pull";
}

/** How to get each process's shapes out of the Kerf language as it stands. */
function modellingTips(id: ProcessId, rules: Rules): string[] {
  const rich = richModelling();
  const pull = rules.draft ? axisName(rules.draft.pull) : "Z";
  const draft = rich
    ? `Draft every face along the pull with draft(${fmt(rules.draft?.warn ?? 1)}, faces: ${draftFaces(pull)}, pull: ${pull}), before fillets. faces: takes any selection: "vertical" is every face parallel to Z, flat or round; facing(X) is flat faces only; a named feature's .faces picks its own.`
    : "Kerf has no draft modifier yet: build drafted round features with cone() and revolve(), and drafted straight walls as prism() profiles with the taper in the outline (extrude sideways with dir: X or Y). Where a face cannot be drafted, say so and leave the draft finding for the toolmaker.";
  switch (id) {
    case "fdm":
    case "sla":
    case "sls":
      return [
        "Model the part in the orientation you want it printed, or set build: on the process to the direction that points up on the printer.",
        'Use chamfer(…, edges: "bottom") rather than fillets on edges that face the bed; fillets there overhang.',
        'Size holes for fasteners with hole(M3, fit: "insert") for heat-set inserts or fit: "tap" for self-tapping screws.',
      ];
    case "cnc_mill":
      return [
        "Start from the stock block and cut pockets, slots and holes from the setup directions.",
        rich
          ? 'Give inside corners the tool radius: fillet(r, edges: both("vertical", "concave")) after cutting pockets from Z rounds only the corners a flat end mill leaves round, not the pocket floors. Pocket outlines drawn with rrect() or slot() at corner radius ≥ the tool radius work too.'
          : 'fillet(r, edges: "vertical") right after the body puts the tool radius in vertical inside corners; for cut pockets, use rrect() or slot() outlines with corner radius ≥ the tool radius instead of sharp boxes.',
        "Keep features open to a setup direction; anything hidden needs another setup.",
      ];
    case "cnc_lathe":
      return ["Model the part with revolve() or stacked cylinder()/cone()/tube() on the spindle axis.", "Keep every hole on the axis; cross holes and flats are second operations."];
    case "injection":
    case "die_cast":
      return [
        rich
          ? "Hollow the part with shell(t, open: …) for one uniform wall (for a lofted shape use loft(…, wall: t), since shell fails on lofts). Instead of thick sections, add rib(from, to, t: …, h: …) about 0.5–0.7× the wall thick and add gusset(at, along: X, size: …, t: …) at bosses and corners."
          : "Hollow the part with shell(t, open: …) for one uniform wall, then add ribs about 0.6× the wall thick instead of thick sections.",
        draft,
        rich
          ? 'fillet(r, edges: "concave") rounds inside corners to at least half the wall; make bosses as tube() with the wall of the part, joined by ribs.'
          : "fillet() inside corners to at least half the wall; make bosses as tube() with the wall of the part, joined by ribs.",
        "Point holes and openings along the pull; side holes need side actions.",
      ];
    case "sheet_metal":
      return [
        "Model one thickness t throughout: flat flanges joined by real bends, each bend a quarter tube(od: 2·(r+t), id: 2·r, …) intersected to 90°, never a sharp corner.",
        "Keep holes at least 2t from edges and bends.",
      ];
    case "laser_cut":
      return ["Model a flat plate: body prism(points, h: t) or box, then cut through-holes and outline notches only. No pockets, steps or chamfers."];
  }
}

/** The process_guide tool's text for one process, material and settings. */
export function processGuideText(spec: ProcessSpec, material?: string): string {
  const def = PROCESSES[spec.id];
  const mat = material ?? spec.material ?? defaultMaterial(spec.id);
  const rules = resolveRules(spec, mat);
  const fit = materialFit(mat, spec.id);
  const fields = ruleFields(rules);
  const lines = [
    `# ${def.label}`,
    def.summary,
    `Best for: ${def.bestFor}. Typical tolerance ±${fmt(def.tolerance)} mm (drawings state ${generalToleranceFor(spec)}). The maker needs: ${def.output}.`,
    `Material ${mat}: ${fit.detail}${fit.status === "pass" ? "" : ` (${fit.status})`}. Usual materials: ${suggestMaterials(spec.id).join(", ") || "see supplier"}.`,
    "",
    "## Rules the part is checked against",
    ...guideLines(rules).map((l) => `- ${l}`),
    "",
    "## Modelling it in Kerf",
    ...modellingTips(spec.id, rules).map((l) => `- ${l}`),
    "",
    "## Source",
    `process: ${specToSource(spec)}`,
    `Settings: ${def.settings.map((s) => `${s.key} (${s.doc}; default ${s.def === null ? "from the geometry" : Array.isArray(s.def) ? (Array.isArray(s.def[0]) ? (s.def as [number, number, number][]).map(axisName).join(", ") : s.kind === "dir" ? axisName(s.def as [number, number, number]) : (s.def as number[]).join(" × ")) : String(s.def)})`).join("; ")}.`,
    `Numbers a requirement can read from the process value: ${Object.entries(fields)
      .map(([k, v]) => `.${k} = ${fmt(v)}`)
      .join(", ")}.`,
  ];
  return lines.join("\n");
}

/** The working method, for the assistant's system prompt. */
export function processPromptSection(): string {
  return `## Design for manufacture
Every custom part is made somehow, and its design has to suit that process. Set it on each part with process: (see "Manufacturing processes" in the language reference). Choose from the brief: quantity, material, accuracy, budget, and what the user owns (such as a 3D printer). When the brief does not say, pick the sensible default (FDM printing for prototypes and one-offs, CNC milling for precise metal parts, sheet metal for metal brackets and covers, injection moulding only for thousands of plastic parts) and say which you chose.
1. Design to the process from the start. Before modelling a part, call process_guide for its process and material and follow those rules while you model: wall thickness, draft along the pull, inside radii no tighter than the tool, hole sizes, bend radii, print orientation and overhangs.
2. When parts share a process, put it in a let (let printed = mfg.fdm(layer: 0.2)) and drive dimensions from its numbers with requirements, for example require "Printable wall": wall >= printed.min_wall. The feasibility solver then keeps them valid when other dimensions change.
3. run_checks reports process findings in the "process" category, each with the faces it flags on the model and a suggested fix. Fix failures before you finish. Some findings offer a one-click option, which is a setting on the part's process (for example build: -Z to print upside down). Warnings are judgement calls: fix the cheap ones and explain the rest.
4. Use compare_processes when the user asks how a part should be made, or when a part fails its process badly: it ranks every process for the geometry as it stands. Put a process change that alters cost or material to the user with ask_user.
5. Say what the checks cannot prove: real machine tolerances, sink marks and warping, weld lines, surface finish and cost. Recommend a test print or a supplier's DFM review for parts that matter.`;
}

/** The language reference section for processes. */
export function processReference(): string {
  const rows = PROCESS_IDS.map((id) => {
    const d = PROCESSES[id];
    return `- mfg.${id}(${d.settings.map((s) => `${s.key}:`).join(" ")}${d.settings.length ? " " : ""}material:) — ${d.label}. ${d.settings.map((s) => `${s.key}: ${s.doc}`).join("; ")}${d.settings.length ? "." : ""} Default material ${defaultMaterial(id)}.`;
  }).join("\n");
  return `## Manufacturing processes
part bracket {
  process: mfg.cnc_mill(tool_d: 3, setups: [Z, -Z])   // or process: "cnc_mill" for the defaults
  material: "Aluminum 6061"
  ...
}
A part's process sets the rules it is checked against (part props: process). All settings are named and optional; directions are in the part's own frame before at/rotate. material: inside the call is used when the part names none; with neither, the part gets the process's usual material. Library components are bought, so they take no process. A process value can live in a let and be shared; its fields give the rule numbers for requirements: .min_wall, .max_wall, .draft, .min_inner_r, .tool_d, .max_overhang, .min_hole, .tolerance (and .t, .bend_r for sheet when t is set), plus every setting by name.
Plain names also work: process: "injection", "laser_cut", "sheet_metal"…
${rows}`;
}
