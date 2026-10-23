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
        'For a simple two-plate tool, or a printed mould to cast resin in, add the halves as parts of their own with mould(part, half: "top") and mould(part, half: "bottom"), pulled along the same direction.',
      ];
    case "metal_print":
      return [
        "Model the part the way it will be built, or set build: on the process to the direction that points up in the printer. Faces lower than 45° get supports, which are cut away and leave rough witness marks.",
        "Use chamfer() or 45° roofs instead of flat ceilings, and keep horizontal holes small or teardrop shaped. Hollow and lighten freely, but open every hollow to the outside with escape holes of at least 2 mm for the powder.",
        "Leave about 0.5 mm extra on faces, bores and threads that must be accurate or smooth: they are machined after printing. Note them on the drawing.",
      ];
    case "vacuum_cast":
      return [
        rich
          ? "Model the finished part as for moulding: an even 1.5 to 3 mm wall from shell(t, open: …), and rib(from, to, t: …, h: …) instead of thick sections. No draft is needed and undercuts are fine, because the silicone mould flexes and is cut open."
          : "Model the finished part as for moulding: an even 1.5 to 3 mm wall from shell(t, open: …), and ribs instead of thick sections. No draft is needed and undercuts are fine, because the silicone mould flexes and is cut open.",
        'Set material: "Polyurethane" and say which plastic the grade should imitate (ABS-, PP-, PC- or rubber-like) and its colour. A printed master is made from the model, and each silicone mould casts about 20 to 25 parts.',
        'To cast a few parts at home instead, add a printed two-part mould with mould(part, half: "top") and mould(part, half: "bottom") as parts of their own; then the part does need to release along the pull, without undercuts.',
      ];
    case "sand_cast":
      return [
        rich
          ? `Model the casting as it comes out of the sand: walls of ${fmt(rules.wall?.warn ?? 4)} mm or more, as even as possible, with shell(t, open: …) and rib(…) instead of solid blocks, and fillet(r, edges: "concave") of at least R${fmt(rules.innerRadius?.min ?? 3)} or half the wall on every inside corner.`
          : `Model the casting as it comes out of the sand: walls of ${fmt(rules.wall?.warn ?? 4)} mm or more, as even as possible, with shell(t, open: …) and ribs instead of solid blocks, and fillet() of at least R${fmt(rules.innerRadius?.min ?? 3)} or half the wall on every inside corner.`,
        draft,
        "Add 2 to 3 mm of machining allowance on faces that must be flat, square or accurate, and leave holes under Ø10, threads and bores to be drilled and machined afterwards. Put those on the drawing.",
        "Hollows, side openings and internal passages need sand cores, each adding cost: open internal cavities to the outside, ideally in two places, so a core can be held and shaken out.",
      ];
    case "investment_cast":
      return [
        `Model the finished shape: fine detail, lettering, thin fins and undercuts are fine, and no draft is needed. Keep walls of ${fmt(rules.wall?.warn ?? 1.5)} mm or more and as even as possible, and blend thick into thin with tapers and fillets.`,
        rich
          ? 'fillet(r, edges: "concave") every inside corner to at least R0.5, more where sections join.'
          : "fillet() every inside corner to at least R0.5, more where sections join.",
        "Holes under Ø2.5 mm, threads and precise bores are drilled or machined after casting: leave about 0.5 mm on faces that will be machined, and note them on the drawing.",
      ];
    case "carbon_layup":
      return [
        "Model the outer surface of the finished part as a solid: Kerf treats it as a laminate of wall: mm laid over that surface, hollow inside. aero_path() and aero_tube() make smooth tubes that change section along their length; let them overlap where they join so the part is one piece.",
        `Every face must come away from one of the two mould halves along ${axisName(rules.reach?.dirs[0] ?? [0, 0, 1])}, or from a slide listed in slides: (the core between a frame's rear stays pulls out backwards). Put the parting line on the centre plane of symmetric parts.`,
        "Leave a way in for the bladder or core at the ends of every hollow (the bottom bracket shell, head tube and seat tube on a frame), and bond in metal for threads, bearings and axles rather than tapping the carbon. Note the joints, bearing seats and dropouts that need extra plies.",
      ];
    case "sheet_metal":
      return [
        'Model the part with body sheet(base, t: …, r: …, flanges: [flange("front", h), …]): one thickness throughout, real bends at the bend radius, corner gaps and reliefs made for you, and a flat pattern with a bend table and DXF. Then cut holes and cut-outs.',
        "Make flanges at least 4t long outside, and keep holes at least 2t from edges and 2t plus the bend radius from bends.",
      ];
    case "laser_cut":
      return ["Model a flat plate: body prism(points, h: t) or box, then cut through-holes and outline notches only. No pockets, steps or chamfers."];
  }
}

/** The process_guide tool's text for one process, material and settings. */
/** The machine a guide was written for: its name, or a name Settings → Making does not have. */
export interface GuideMachine {
  name?: string;
  missing?: string;
}

export function processGuideText(spec: ProcessSpec, material?: string, machine: GuideMachine = {}): string {
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
    machine.name
      ? `Machine: ${machine.name}, from Settings → Making. Its settings fill in whatever the part's process leaves out, and the rules below are for it.`
      : `Machine: ${machine.missing ? `Settings → Making has no machine called "${machine.missing}", so` : "none chosen in Settings → Making, so"} the rules below assume a typical shop. Where the machine decides the design (a mill's tools and travel, a printer's temperature and supports, a press's tonnage), say what you assumed.`,
    "",
    "## Rules the part is checked against",
    ...guideLines(rules).map((l) => `- ${l}`),
    "",
    "## Modelling it in Kerf",
    ...modellingTips(spec.id, rules).map((l) => `- ${l}`),
    "",
    "## Source",
    `process: ${specToSource(spec)}`,
    `Settings (* = set by the machine profile unless the part sets it): ${def.settings.map((s) => `${s.key}${s.machine ? "*" : ""} (${s.doc}; default ${s.def === null ? (s.kind === "tools" ? "standard sizes" : "from the geometry") : Array.isArray(s.def) ? (Array.isArray(s.def[0]) ? (s.def as [number, number, number][]).map(axisName).join(", ") : s.kind === "dir" ? axisName(s.def as [number, number, number]) : (s.def as number[]).join(" × ")) : String(s.def)})`).join("; ") || "none, only material:"}.`,
    `Numbers a requirement can read from the process value: ${Object.entries(fields)
      .map(([k, v]) => `.${k} = ${fmt(v)}`)
      .join(", ")}.`,
  ];
  return lines.join("\n");
}

/** The working method, for the assistant's system prompt. */
export function processPromptSection(): string {
  return `## Design for manufacture
Every custom part is made somehow, and its design has to suit that process. The brief's process is every part's default; set process: on a part (see "Manufacturing processes" in the language reference) only where it is made differently. Choose from the brief: quantity, material, accuracy, budget, and what the user owns (such as a 3D printer). When the brief does not say, pick the sensible default (FDM printing for prototypes and one-offs, CNC milling for precise metal parts, sheet metal for metal brackets and covers, injection moulding only for thousands of plastic parts) and say which you chose. Castings and metal printing fit narrower cases: sand casting for one-off to hundreds of large or rough metal parts that are machined on their critical faces, investment casting for detailed steel or stainless parts in hundreds to thousands, vacuum casting for 10 to 100 production-like plastic parts before a steel mould pays off, and metal printing for complex metal parts in ones and tens that would be hard to machine.
1. Design to the process from the start. Before modelling a part, call process_guide for its process and material and follow those rules while you model: wall thickness, draft along the pull, inside radii no tighter than the tool, hole sizes, bend radii, print orientation and overhangs.
2. When parts share a process, put it in a let (let printed = mfg.fdm(layer: 0.2)) and drive dimensions from its numbers with requirements, for example require "Printable wall": wall >= printed.min_wall. The feasibility solver then keeps them valid when other dimensions change.
3. The checks (returned with every edit, and by run_checks) report process findings in the "process" category, each with the faces it flags on the model and a suggested fix. Fix failures before you finish. Some findings offer a one-click option, which is a setting on the part's process (for example build: -Z to print upside down). Warnings are judgement calls: fix the cheap ones and explain the rest.
4. Use compare_processes when the user asks how a part should be made, or when a part fails its process badly: it ranks every process for the geometry as it stands. Put a process change that alters cost or material to the user with ask_user.
5. Say what the checks cannot prove: real machine tolerances, sink marks and warping, weld lines, surface finish and cost. Recommend a test print or a supplier's DFM review for parts that matter.`;
}

/** The language reference section for processes. */
export function processReference(): string {
  const rows = PROCESS_IDS.map((id) => {
    const d = PROCESSES[id];
    return `- mfg.${id}(${d.settings.map((s) => `${s.key}:`).join(" ")}${d.settings.length ? " " : ""}material:) — ${d.label}.${d.settings.length ? ` ${d.settings.map((s) => `${s.key}: ${s.doc}`).join("; ")}.` : ""} Default material ${defaultMaterial(id)}.`;
  }).join("\n");
  return `## Manufacturing processes
part bracket {
  process: mfg.cnc_mill(tool_d: 3, setups: [Z, -Z])   // or process: "cnc_mill" for the defaults
  material: "Aluminum 6061"
  ...
}
A part's process sets the rules it is checked against (part props: process). All settings are named and optional; directions are in the part's own frame before at/rotate. material: inside the call is used when the part names none; with neither, the part gets the process's usual material. Library components are bought, so they take no process. A process value can live in a let and be shared; its fields give the rule numbers for requirements: .min_wall, .max_wall, .draft, .min_inner_r, .tool_d, .max_overhang, .min_hole, .tolerance (and .t, .bend_r for sheet when t is set), plus every setting by name.
Plain names also work: process: "injection", "laser_cut", "sheet_metal"… The project brief's process is the default for parts with none; process: false marks a part that is bought or made by hand, so it is not checked.
${rows}`;
}
