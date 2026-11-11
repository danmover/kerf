// Tools Claude uses to read, edit and verify the design. Every edit goes
// through the same source-text path as manual edits, and every input is
// validated before it touches the design.

import { z } from "zod";
import { useDesign, whenChecked, whenRefined, solveWith, evaluateOnly, meshes, meshOf } from "../core/engine";
import { planExplode } from "../core/explode";
import { findHolds } from "../core/holds";
import { whenWiringChecked } from "../machine/harness/runtime";
import { whenSwept } from "../core/sweepRuntime";
import { applyTextEdits, diffStats } from "../core/sourceEdit";
import { decisionsSummary } from "../core/decisions";
import type { Model } from "../core/model";
import { useSettings } from "../app/settings";
import { projectAccess } from "../mfg/plan";
import { availabilityText } from "../mfg/availability";
import { machinesText } from "../mfg/machines";
import { userMachines } from "../mfg/userMachines";
import type { CheckReport } from "../core/checks";
import { commitSource } from "../app/project";
import { viewport } from "../app/viewportApi";
import { MAX_SOURCE_CHARS } from "../persist/files";
import { fmtNum, Obj, type Value } from "../lang/values";
import { lineCol } from "../lang/lexer";
import { evaluate } from "../lang/evaluator";
import { BEARINGS } from "../library/standards";
import { CATALOG_KINDS, catalogPart, describePart, isHad, searchCatalog } from "../machine/catalog";
import { CALC_FNS, isCalc } from "../machine/calcs";
import { generateFirmware } from "../machine/firmware";
import type { CatalogPart } from "../machine/types";
import { calcParams } from "./reference";
import { PROCESS_TOOL_DEFS, PROCESS_TOOL_TITLES, runProcessTool } from "./processTools";
import { SIM_TOOL_DEFS, SIM_TOOL_TITLES, runSimTool } from "./simTools";
import { PROCESSES } from "../mfg/profiles";
import { processFromText } from "../mfg/spec";
import { pmiNote, sheetFor, useDrawings } from "../drawing/engine";
import { describeSheet, sheetToPng } from "../drawing/export";
import { BUILD_TOOL, runBuildTool } from "../agents/tool";
import { PLAN_TOOL, runPlanTool } from "./planTool";
import { COMPARE_TOOL, COMPARE_TITLE, alternativeSource, compareDesigns } from "./compare";
import { measureIsolated, pool } from "../agents/isolated";
import { solveOnce } from "../analysis/runtime";
import { REVIEW_TOOL } from "./review/tool";
import { useProject } from "../app/project";
import { assetBlock } from "../persist/assets";
import { briefContext, briefData, briefHasErrors, emptyBrief, FIELDS, openAssumptions, protectedBriefChanges, validId, writeBrief, keepBrief, type BriefData, type FieldKey } from "../core/brief";
import { IMPORT_TOOL_DEFS, IMPORT_TOOL_TITLES, importsSummary, runImportTool } from "./importTools";
import { MATERIAL_TOOL_DEFS, MATERIAL_TOOL_TITLES, runMaterialTool } from "./materialTools";
import { FASTEN_TOOL_DEFS, FASTEN_TOOL_TITLES, runFastenTool } from "./fastenTool";
import { VIEW_TOOL_DEFS, VIEW_TOOL_TITLES, runViewTool } from "./viewTools";
import { partGroups } from "../app/partGroups";
import { sketchStatusText } from "../sketch/evaluate";
import type { EvalSketch } from "../sketch/types";
import { useAnalysis, whenAnalyzed, runFine, runAccuracyCheck, showResults, type ResultField } from "../analysis/runtime";
import { startStudy, studyStatus, studySummary } from "../analysis/studyRuntime";
import type { AnalysisSpec, StudySpec } from "../analysis/spec";
import { structuralSummary, drivetrainSummary, analysisLine, structuralVerdict, uciSummary, uciItems, uciVerdict } from "../analysis/summary";
import { airflowItems, showAirflow, startAirflowNow, useAirflow, whenAirflowDone, type SurfaceShown } from "../analysis/aeroRuntime";
import { airflowSummary } from "../analysis/aeroSummary";
import { evaluateSelector } from "../lang/evaluator";
import { kernel } from "../kernel/client";
import { inspectText } from "../kernel/inspectText";
import { inverseXforms } from "../kernel/recipe";
import { buildChecksRequest } from "../core/checks";
import type { GeoQuery } from "../lang/values";
import { ASKS_TOOL, AsksInput, asksState, asksText, remeasure, setAsks } from "./asks";
import { EXAMPLE_TOOL, ExampleInput, exampleText } from "./examples";
import { LESSON_TOOL, LessonInput, saveLesson } from "./lessons";
import { DEFERRED, ReferenceInput, referenceText } from "./leanReference";

// no generated code: the page CSP forbids eval
z.config({ jitless: true });

export const VIEW_NAMES = ["iso", "front", "back", "top", "bottom", "left", "right"] as const;

export const TOOL_DEFS = [
  PLAN_TOOL,
  ASKS_TOOL,
  LESSON_TOOL,
  {
    name: "get_design",
    description:
      "Read the current design: full source with line numbers (the numbers are not part of the text), the evaluated parameters, parts and requirements, and the latest check results. Call before your first edit and whenever the user may have changed the source, unless the context note already holds the current source.",
    input_schema: { type: "object" as const, properties: {}, additionalProperties: false },
  },
  EXAMPLE_TOOL,
  {
    name: "edit_design",
    description:
      "Apply exact text replacements to the design source, in order. Each old_text must match the current source exactly once (copy it from get_design or the source in the context note, without the line-number prefix). The design is rebuilt and checked, and the result comes back with every check (when one response makes several changes, the last one carries the checks). Prefer several small edits over large ones. To apply an alternative from your last compare_designs as it was measured, give its label as alternative instead of edits.",
    eager_input_streaming: true,
    input_schema: {
      type: "object" as const,
      properties: {
        summary: { type: "string", description: "One short line for the version history, in the user's terms, e.g. 'Narrowed the enclosure to 77 mm and moved the bosses'." },
        edits: {
          type: "array",
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
        alternative: { type: "string", description: "Label of an alternative from your last compare_designs call: applies its edits and values (leave edits out)." },
        unlock_ok: { type: "boolean", description: "Set true only when the user explicitly asked to change a locked parameter or component." },
      },
      required: ["summary"],
      additionalProperties: false,
    },
  },
  {
    name: "write_design",
    description:
      "Replace the whole design source. Use for a brand-new design or a rewrite of most of the file; otherwise use edit_design. Leave the brief block out of the source to keep the current brief (record or change it with update_brief). Like edit_design, the result comes back with every check.",
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
    name: "get_sketch",
    description:
      "Read one sketch as solved: its plane, every point's solved position and how free it still is, the curves, each constraint with its status (ok, redundant, conflict), and the closed regions of its profile. Sketch coordinates in the source are starting guesses; use this to see where things actually are, which points still need a dimension, and what the user is pointing at.",
    input_schema: {
      type: "object" as const,
      properties: { name: { type: "string", description: "The sketch's name." } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "run_checks",
    description:
      "Wait for the geometry kernel to build the current design, then return every check: requirements with margins, solid interference, fastener tool access, gear meshing, swept motion envelopes, build errors, and for machines the electrical rules, motor loads, the physical test plan and a summary of the generated firmware with its warnings. Edits already return these, so call it only to look again, for example once the detailed geometry has finished.",
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
  COMPARE_TOOL,
  {
    name: "catalog_lookup",
    description:
      "Look up purchasable parts in Kerf's parts catalog. Give id for one part in full: specs, every pin with its electrical type and ratings, shape and fields, notes, the physical tests it usually needs, and where to buy it. Or search with query (for example \"15 A motor driver\", \"NEMA 17\", \"3S LiPo\") and/or kind: the best matches come back in full and the rest as one line each. With only kind, every part of that kind is listed in one line each. Call it before choosing or wiring a catalog part: only catalog parts have pins.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "A catalog id, e.g. \"pololu_g2_18v17\"." },
        query: { type: "string", description: "Words to search ids, names, makers, part numbers, summaries and specs." },
        kind: { type: "string", enum: [...CATALOG_KINDS], description: "Only parts of this kind." },
        limit: { type: "integer", minimum: 0, maximum: 12, description: "How many matches to return in full (default 3 for a query, 0 for a kind listing)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "run_analysis",
    description:
      "Wait for the design to build, then run its analysis blocks and return the results. Structural analyses solve a finite-element model of the named parts and report the lowest factor of safety and what it is judged against (yield, fatigue or print-layer strength), peak von Mises stress and where, deflection, strain, mass, hot spots, support reactions and accuracy notes. Analyses with modes:, excite: or ringing: also report natural frequencies, how each mode moves and whether anything shakes it at resonance; drop: and tip: analyses report the fall, peak g on landing and the stresses it causes. Heat analyses (heat: or hold:) report each part's hottest point against its limit, where the heat comes from and goes, and for a warm-up (time:) when a part passes its limit; with fix: they also report the thermal stress, with hot plastics weakened. Analyses with buckling report how many times the loads it takes to buckle the parts and where. Analyses with cycles: over 1000 or history: also report fatigue: the lowest fatigue safety factor, the shortest life and where, and which load cycles do the damage. Drivetrain analyses report gear tooth bending, bearing life and shaft torsion. Airflow analyses (airflow: 45kmh) put the parts in a wind tunnel (lattice-Boltzmann LES on the GPU, rolling road, spinning wheels, an optional standard rider) and report drag, drag area CdA, side force, lift and watts at each yaw angle, the drag of each part, the surface patches that cause the most drag (pressure on fronts, suction behind backs, friction) and the change from the previous version; they take from under a minute to several minutes, and if one is still running when this returns, call run_analysis again later. The results are shown on the user's model. Add or change an analysis block with edit_design first. Pass fine: true to re-run a structural analysis at about 110,000 elements to confirm a close call, or check: true for an accuracy check (it solves again with 1.5× smaller elements and says how far each answer moved, and whether a peak stress is a singularity at a support). A design study (an analysis with vary:) runs only when named with label: it builds, checks and solves up to its runs: designs and returns the best one that passes, every design tried and how much each parameter matters; apply a design with edit_design alternative: \"<study> #<n>\".",
    input_schema: {
      type: "object" as const,
      properties: {
        label: { type: "string", description: "Run only the analysis with this label; default all except design studies, which run only when named." },
        fine: { type: "boolean", description: "Re-run structural analyses at the fine resolution (slower, closer answer)." },
        check: { type: "boolean", description: "Accuracy check: solve structural and heat analyses twice, the second time with smaller elements, and report how far the answers moved (about 4× the time)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "engineering_calc",
    description:
      "Run one engineering calculator (calc.<name>) outside the design and get its full working: inputs, results, method, assumptions, confidence and what a physical test should confirm, plus every result field in base units. Use it to size a machine before choosing parts, to compare options, or to check a number; then record the calculation you rely on in the design as `let x = calc.<name>(...)`. Arguments are named, as in the language reference. Values: numbers in base units (mm, N, N·mm, MPa, V, A, W, s, g), or text with a unit such as \"9.5m\", \"10.8Nm\", \"32deg\", \"12kPa\"; true or false for flags; a catalog id (\"gobilda_5203_188\") or the name of a catalog component in the current design for motor, battery and actuator arguments; a bearing code (\"6808\") for bearing.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", enum: Object.keys(CALC_FNS), description: "The calculator." },
        args: {
          type: "object",
          description: "Named arguments, e.g. {\"depth\": \"9.5m\", \"box_w\": \"1m\"}.",
          additionalProperties: { anyOf: [{ type: "number" }, { type: "string" }, { type: "boolean" }] },
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "capture_view",
    description:
      "Render the current model from a camera angle and return the image so you can look at it. Optionally highlight parts, cut a section, or colour the model by a structural analysis result (with the deformed shape exaggerated, load arrows and support markers).",
    input_schema: {
      type: "object" as const,
      properties: {
        view: { type: "string", enum: [...VIEW_NAMES], description: "Camera direction. iso is a 3/4 view from the front right." },
        highlight: { type: "array", items: { type: "string" }, maxItems: 30, description: "Part or component names to emphasise; others are ghosted." },
        section: { type: "string", enum: ["x", "y", "z"], description: "Cut the model in half across this axis to see inside. With results, the cut face is coloured by the field inside the parts, so you can see whether stress or heat runs through the section or stays at the surface." },
        results: { type: "string", enum: ["stress", "safety", "disp", "strain", "temp", "life"], description: "Colour by an analysis result: von Mises stress, factor of safety (red below 1, amber below the target, green above), deflection, principal strain, temperature (heat analyses) or fatigue life (analyses with cycles: or history:). Run run_analysis first." },
        analysis: { type: "string", description: "Which structural analysis to draw with results; default the one shown or the first." },
        airflow: { type: "string", enum: ["pressure", "friction", "streamlines", "wake", "eddies"], description: "Draw an airflow analysis's result: surface pressure (red: pushed on, blue: suction), skin friction, streamlines coloured by speed, the wake (where the air lost its total pressure) or the eddies. Run run_analysis first." },
        yaw: { type: "number", description: "With airflow: the yaw angle to draw (default the first)." },
        exploded: { description: "Show the design exploded: true for all the way, or 0 to 1 to step part way through taking it apart (screws out first). The result says which way each part came off, so you can check the assembly order and fix a part sent the wrong way with explode: on it.", anyOf: [{ type: "boolean" }, { type: "number", minimum: 0, maximum: 1 }] },
        groups: { type: "array", items: { type: "string" }, maxItems: 20, description: "Draw only these groups of parts (by their group: names), framed to fit, e.g. to look at the nozzle on its own." },
      },
      required: ["view"],
      additionalProperties: false,
    },
  },
  {
    name: "inspect_part",
    description:
      "Look inside one built part before choosing fillets, chamfers, drafts or shells: its size, named features (from `add ... as name`) with how many faces and root/tip edges each has, and how many sharp convex and concave edges it has. Pass select to test a selector exactly as you would write it in the source (e.g. `boss.root`, `both(lid.edges, \"top\")`, `near((0, 12, 20), 1)`), and see what it picks; pass at (a world point, e.g. where the user clicked) to get the face and edge there and selectors that name them. Coordinates in results are in the part's own frame, the same frame its selectors use.",
    input_schema: {
      type: "object" as const,
      properties: {
        part: { type: "string", description: "Part or component name (or instance id like screw#2)." },
        select: { type: "string", description: "A selector expression to evaluate against the part." },
        kind: { type: "string", enum: ["edges", "faces"], description: "What the selector picks (default edges; shell open and draft use faces)." },
        at: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3, description: "A point in world coordinates to identify." },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["part"],
      additionalProperties: false,
    },
  },
  {
    name: "view_drawing",
    description:
      "Look at an engineering drawing of the design: returns the sheet as an image and a list of its views, dimensions (with ids such as d3 and the parameter each one shows), notes and warnings. Without a name it shows the drawing the user has open, or the first one. Automatic drawings (names starting auto:) are generated from the model; the result includes a drawing block to start from when one needs changing.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Drawing block name, auto:<part> for an automatic drawing, or a drawing title." },
      },
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
            process: { type: "string", description: "How it is made: FDM print, Resin print, SLS print, Metal 3D print, CNC machined, Laser cut, Sheet metal, Injection moulded, Vacuum cast, Die cast, Sand cast, Investment cast or another process, or a process with settings like mfg.fdm(layer: 0.2). It becomes the default process of every part." },
            material: { type: "string", description: "Preferred material for made parts." },
            quantity: { type: "integer", minimum: 1 },
            build_volume: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3, description: "Printer build volume in mm (X, Y, Z)." },
            workshop: { type: "array", items: { type: "string" }, maxItems: 16, description: "Processes the user has themselves for this project, by id or plain name, e.g. [\"fdm\", \"laser_cut\"]. Replaces their Settings for this design; set only when the user says so." },
            can_order: { type: "array", items: { type: "string" }, maxItems: 16, description: "Processes the user can order from a shop or online service for this project. Replaces their Settings for this design; set only when the user says so." },
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
  ...PROCESS_TOOL_DEFS,
  ...SIM_TOOL_DEFS,
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
  ...MATERIAL_TOOL_DEFS,
  ...FASTEN_TOOL_DEFS,
  ...VIEW_TOOL_DEFS,
];

const EditInput = z
  .object({
    summary: z.string().min(1).max(300),
    edits: z.array(z.object({ old_text: z.string().max(MAX_SOURCE_CHARS), new_text: z.string().max(MAX_SOURCE_CHARS) })).max(40).optional(),
    alternative: z.string().trim().min(1).max(40).optional(),
    unlock_ok: z.boolean().optional(),
  })
  .refine((e) => !!e.edits?.length !== !!e.alternative, { message: "give either edits or alternative (the label of one from compare_designs)", path: ["edits"] });
const WriteInput = z.object({ summary: z.string().min(1).max(300), source: z.string().min(1).max(MAX_SOURCE_CHARS), unlock_ok: z.boolean().optional() });
const FixInput = z.object({ hold: z.array(z.string().max(80)).max(50).optional() });
const ViewInput = z.object({
  view: z.enum(VIEW_NAMES),
  highlight: z.array(z.string().max(80)).max(30).optional(),
  section: z.enum(["x", "y", "z"]).optional(),
  results: z.enum(["stress", "safety", "disp", "strain", "temp", "life"]).optional(),
  analysis: z.string().max(200).optional(),
  airflow: z.enum(["pressure", "friction", "streamlines", "wake", "eddies"]).optional(),
  yaw: z.number().finite().optional(),
  exploded: z.union([z.boolean(), z.number().min(0).max(1)]).optional(),
  groups: z.array(z.string().min(1).max(80)).max(20).optional(),
});
/** how long run_analysis waits for airflow runs before reporting them as still running */
const AIRFLOW_WAIT_MS = 8 * 60_000;
const AnalysisInput = z.object({ label: z.string().max(200).optional(), fine: z.boolean().optional(), check: z.boolean().optional() });
const DrawingInput = z.object({ name: z.string().max(120).optional() });
const SetInput = z.record(z.string().min(1).max(80), z.union([z.number().finite(), z.string().max(200), z.boolean()]));
const InspectInput = z.object({
  part: z.string().min(1).max(120),
  select: z.string().max(2000).optional(),
  kind: z.enum(["edges", "faces"]).optional(),
  at: z.array(z.number().finite()).length(3).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
const AskInput = z.object({
  title: z.string().max(80).optional(),
  question: z.string().min(1).max(500),
  options: z
    .array(z.object({ label: z.string().min(1).max(80), consequence: z.string().max(300), recommended: z.boolean().optional(), set: SetInput.optional() }))
    .min(2)
    .max(4)
    .refine((os) => new Set(os.map((o) => o.label)).size === os.length, "option labels must be different"),
});

const LookupInput = z.object({ id: z.string().max(80).optional(), query: z.string().max(200).optional(), kind: z.string().max(40).optional(), limit: z.number().int().min(0).max(12).optional() });
const CalcInput = z.object({
  name: z.string().min(1).max(60),
  args: z.record(z.string().max(60), z.union([z.number(), z.string().max(200), z.boolean()])).optional(),
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
      process: z.string().max(200),
      material: z.string().max(80),
      quantity: z.number().int().min(1).max(10_000_000),
      build_volume: z.tuple([Num.positive(), Num.positive(), Num.positive()]),
      workshop: z.array(z.string().max(60)).max(16),
      can_order: z.array(z.string().max(60)).max(16),
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
  for (const [k, prop] of [
    ["workshop", "workshop"],
    ["can_order", "canOrder"],
  ] as const) {
    const v = f[k];
    if (!v) continue;
    const names = v.map((x) => x.trim()).filter(Boolean);
    const unknown = names.filter((x) => !processFromText(x));
    if (unknown.length) errors.push(`fields.${k}: ${unknown.map((x) => `"${x}"`).join(", ")} ${unknown.length > 1 ? "are not processes" : "is not a process"} Kerf knows`);
    d[prop] = names.map((x) => processFromText(x) ?? x);
  }
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
  const machine = machineSummary(m);
  if (machine) lines.push(machine);
  const made = m.parts.filter((p) => p.kind === "part");
  if (made.length) {
    const how = made.filter((p) => p.process).map((p) => `${p.name}: ${PROCESSES[p.process!.id].short} in ${p.material}${p.processInherited ? " (from the brief)" : ""}`);
    const unset = made.filter((p) => !p.process).map((p) => p.name);
    lines.push(`How parts are made: ${[...how, unset.length ? `no process set: ${unset.join(", ")}` : ""].filter(Boolean).join("; ")}`);
  }
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
  if (m.sketches.length) lines.push("Sketches:\n" + m.sketches.map((sk) => `  - ${sk.name} on ${sk.planeText}: ${sketchStatusText(sk)}${sk.usedBy.length ? `; shapes ${sk.usedBy.join(", ")}` : "; not used by a part yet"}`).join("\n"));
  if (m.analyses.length) {
    const a = useAnalysis.getState();
    const air = useAirflow.getState();
    lines.push("Analyses:\n" + m.analyses.map((x) => `  - ${analysisLine(x, a.runs.get(x.label), a.drivetrain.get(x.label), useDesign.getState().report?.items, air.runs.get(x.label), x.kind === "study" ? studyStatus(x) : undefined)}`).join("\n"));
  }
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
  const brief = briefContext(briefData(model.brief), (id) => {
    const it = report?.items.find((i) => i.id === `use:${id}`);
    if (!it) return undefined;
    return it.detail.startsWith("No check") ? "not checked yet" : `${it.status}: ${it.detail}`;
  });
  return [brief, processesSummary(model.brief), onHandSummary()].filter(Boolean).join("\n");
}

/** What the user has on hand (Settings → Making), for Claude to prefer. */
function onHandSummary(): string {
  const have = useSettings.getState().onHand;
  if (!have.length) return "";
  return `Parts the user has on hand (prefer them when they fit; calc.fastener and calc.motor_select get them as have: from engineering_calc, and the design's calls should carry the same have: list): ${have.slice(0, 120).join("; ")}${have.length > 120 ? `; and ${have.length - 120} more` : ""}`;
}

/** Which processes the user can use, for Claude: from the brief's lists or Settings. */
function processesSummary(brief: Model["brief"]): string {
  const saved = useSettings.getState().processAccess;
  const { access, fromBrief } = projectAccess(brief);
  const machines = userMachines();
  const machineLine = Object.keys(machines.machineFor).length ? `\n${machinesText(machines)}` : "";
  if (!fromBrief && !Object.keys(saved).length) return `Manufacturing processes: the user has not said which they own, so every process counts as one they can order (Settings → Making, or the brief's workshop: and can_order:, change this).${machineLine}`;
  return `Manufacturing processes: ${availabilityText(access, fromBrief)}${machineLine}`;
}

/** A sketch as solved, for get_sketch. */
/** How many of each kind get_sketch lists before summarising the rest. */
export const SKETCH_DETAIL_MAX = { points: 150, curves: 150, constraints: 200 };

export function sketchDetail(sk: EvalSketch): string {
  const f = (v: number) => fmtNum(v, 3);
  const v3 = (v: number[]) => `(${v.map(f).join(", ")})`;
  const lines = [`Sketch ${sk.name} on ${sk.planeText}: ${sketchStatusText(sk)}${sk.usedBy.length ? `; shapes ${sk.usedBy.join(", ")}` : ""}.`];
  lines.push(`Plane: origin ${v3(sk.frame.o)}, sketch x → world ${v3(sk.frame.u)}, sketch y → world ${v3(sk.frame.v)}, normal ${v3(sk.frame.n)}.`);
  if (sk.message) lines.push(`Problem: ${sk.message}`);
  if (sk.profile.error) lines.push(`Profile problem: ${sk.profile.error.message}`);
  if (sk.profile.open) lines.push(`Open curves: ${sk.profile.open.message}`);
  const aliases = new Map<string, string[]>();
  for (const [a, id] of Object.entries(sk.aliases)) aliases.set(id, [...(aliases.get(id) ?? []), a]);
  const freeText = (p: EvalSketch["points"][number]) =>
    p.status === "conflict" ? "in conflict" : p.freedom.kind === "fixed" ? "fixed" : p.freedom.kind === "defined" ? "defined" : p.freedom.kind === "line" ? `free along (${f(p.freedom.dir[0])}, ${f(p.freedom.dir[1])})` : "free";
  // big sketches: list the first entries of each kind, and name the ones that still need attention
  const list = <T,>(title: string, items: T[], max: number, text: (x: T) => string, attention: (x: T) => string | null) => {
    lines.push(title);
    for (const x of items.slice(0, max)) lines.push(`  ${text(x)}`);
    if (items.length <= max) return;
    const rest = items.slice(max).map(attention).filter((x): x is string => !!x);
    lines.push(`  … ${items.length - max} more not listed${rest.length ? `; of those, these are not fully defined or have problems: ${rest.slice(0, 40).join(", ")}${rest.length > 40 ? ", …" : ""}` : ""}. Read the sketch block in the source for the rest.`);
  };
  const points = sk.points.filter((p) => p.id !== "x_axis.end" && p.id !== "y_axis.end");
  list(
    "Points (solved sketch coordinates):",
    points,
    SKETCH_DETAIL_MAX.points,
    (p) => `${[p.id, ...(aliases.get(p.id) ?? [])].join(" = ")}: (${f(p.x)}, ${f(p.y)}) ${freeText(p)}${p.external ? ", projected from another sketch" : ""}`,
    (p) => (p.status === "free" || p.status === "conflict" ? p.id : null),
  );
  const byId = new Map(sk.points.map((p) => [p.id, p]));
  const at = (id: string) => byId.get(id)!;
  list(
    "Curves:",
    sk.curves,
    SKETCH_DETAIL_MAX.curves,
    (c) => {
      const extra = c.kind === "circle" ? ` r ${f(c.r ?? 0)}` : c.kind === "line" ? ` length ${f(Math.hypot(at(c.pts[1]).x - at(c.pts[0]).x, at(c.pts[1]).y - at(c.pts[0]).y))}` : "";
      return `${c.construction ? "construction " : ""}${c.kind} ${c.id} [${c.pts.join(", ")}]${extra} ${c.status}${c.external ? " (reference)" : ""}`;
    },
    (c) => (c.status === "free" || c.status === "conflict" ? c.id : null),
  );
  if (sk.constraints.length) {
    const text = (c: EvalSketch["constraints"][number]) => `${c.kind} ${c.args.join(", ")}${c.valueText ? ` = ${c.valueText}${c.value !== undefined && c.valueText.trim() !== String(c.value) ? ` (= ${f(c.value)})` : ""}` : ""}${c.status !== "ok" ? ` [${c.status}]` : ""}`;
    list("Constraints:", sk.constraints, SKETCH_DETAIL_MAX.constraints, text, (c) => (c.status !== "ok" ? text(c) : null));
  }
  const regions = sk.profile.regions;
  lines.push(regions.length ? `Profile: ${regions.length} closed region(s), ${regions.reduce((n, r) => n + r.holes.length, 0)} hole(s), area ${f(sk.profile.area)} mm².` : "Profile: no closed region yet.");
  return lines.join("\n");
}

export function reportSummary(r: CheckReport | null, limit = 60): string {
  if (!r) return "Checks have not run yet.";
  const c = r.counts;
  const head = `Checks: ${c.pass} pass, ${c.fail} fail, ${c.warn} warn, ${c.pending} pending, ${c.info} info.`;
  const notable = r.items.filter((i) => i.status !== "pass");
  // machine checks say how they were established: rules, calculation or a physical test still to do
  const basis = (i: CheckReport["items"][number]) => (i.basis === "electrical rules" || i.basis === "calculation" || i.basis === "physical test" || i.basis === "virtual test" ? `; ${i.basis}` : "");
  const body = notable
    .slice(0, limit)
    .map((i) => `  - [${i.status}] (${i.category}${basis(i)}) ${i.title}: ${i.detail}${i.fix ? ` Fix: ${i.fix}` : ""}${i.action ? ` One-click option: ${i.action.label} (${i.action.setting} on the part's process).` : ""}${i.parts?.length ? ` [parts: ${i.parts.join(", ")}]` : ""}`);
  if (notable.length > limit) body.push(`  - … and ${notable.length - limit} more not shown (fix the ones above, then check again)`);
  const passed = r.items.filter((i) => i.status === "pass").map((i) => i.title);
  return [head, ...body, passed.length ? `Passing: ${passed.slice(0, 60).join("; ")}${passed.length > 60 ? `; … (${passed.length - 60} more)` : ""}` : ""].filter(Boolean).join("\n");
}

/** Purchased parts, wiring and calculations at a glance. */
export function machineSummary(m: Model): string {
  const mm = m.machine;
  if (!mm) return "";
  let cost = 0;
  for (const c of mm.components) cost += (c.price ?? catalogPart(c.catalogId)?.price_usd ?? 0) * c.count;
  for (const it of mm.items) cost += (it.price ?? 0) * it.qty;
  const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
  const lines = [
    `Machine: ${n(mm.components.reduce((s, c) => s + c.count, 0), "catalog part")}, ${n(mm.wires.length, "wire")}, ${n(mm.nets.length, "net")}, ${n(mm.calcs.length, "calculation")}, ${n(mm.firmware.length, "firmware block")}, ${n(mm.tests.length, "test")}, ${n(mm.items.length, "buy item")}; parts about $${Math.round(cost)}.`,
  ];
  if (mm.calcs.length) lines.push("Calculations: " + mm.calcs.map((c) => `${c.name} (${c.title}; ${c.confidence})`).join("; "));
  return lines.join("\n");
}

/** What the firmware generators make of the design, and what they warn about. */
export function firmwareSummary(m: Model | null): { text: string; warnings: number } {
  const mm = m?.machine;
  if (!m || !mm?.firmware.length) return { text: "", warnings: 0 };
  try {
    const outs = generateFirmware(mm, m.name);
    const warnings = outs.reduce((s, o) => s + o.warnings.length, 0);
    const lines = outs.map((o) => {
      const head = `  - ${o.name} (board ${o.board || "?"}): ${o.target === "none" ? "no code generated" : o.target === "arduino" ? "Arduino sketch" : o.target === "marlin" ? "Marlin config" : o.target === "reprapfirmware" ? "RepRapFirmware config" : "Klipper config"}. ${o.summary}. ${o.files.length} file${o.files.length === 1 ? "" : "s"}, ${o.pinTable.length} wired signal${o.pinTable.length === 1 ? "" : "s"}.`;
      return o.warnings.length ? `${head}\n    Warnings:\n${o.warnings.map((w) => `    * ${w}`).join("\n")}` : `${head} No warnings.`;
    });
    return { text: ["Firmware:", ...lines].join("\n"), warnings };
  } catch (e) {
    return { text: `Firmware: the generator failed (${e instanceof Error ? e.message : String(e)}).`, warnings: 1 };
  }
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
  // a locked part must also keep its shape and place when a parameter it uses changes
  for (const p of a.parts) {
    if (!p.locked) continue;
    const owner = `${p.kind} ${p.name}`;
    if (out.includes(owner)) continue;
    const q = b.parts.find((x) => x.id === p.id);
    const how = !q ? "removes it" : q.hash !== p.hash ? "changes its shape" : JSON.stringify(q.xf) !== JSON.stringify(p.xf) ? "moves it" : "";
    if (how) out.push(`${owner} (the edit ${how})`);
  }
  // what the user stated in the brief is held like a lock
  for (const c of protectedBriefChanges(briefData(a.brief), briefData(b.brief))) out.push(`the brief's ${c}`);
  return out;
}

/**
 * How an edit's result deals with the checks: undefined asks Claude to call run_checks, "later" says another change in
 * the same response carries them, "now" leaves the design summary to the check results added after the edit.
 */
type CheckMode = "now" | "later" | undefined;

function evalFeedback(m: Model, before: Model | null, mode: CheckMode): string {
  const lines = mode === "now" ? [] : [modelSummary(m)];
  if (before) {
    const changed = m.parts.filter((p) => {
      const q = before.parts.find((x) => x.id === p.id);
      return !q || q.hash !== p.hash || JSON.stringify(q.xf) !== JSON.stringify(p.xf);
    });
    const removed = before.parts.filter((p) => !m.parts.some((x) => x.id === p.id));
    lines.push(`Geometry to rebuild: ${changed.length} solid(s)${changed.length ? ` (${changed.slice(0, 20).map((p) => p.id).join(", ")})` : ""}; removed: ${removed.length}. Unchanged solids are reused from cache.`);
  }
  if (mode === undefined) lines.push("Next: call run_checks to build and check the geometry.");
  else if (mode === "later") lines.push("The build and check results come after your last change in this response.");
  return lines.join("\n");
}

function applySource(next: string, summary: string, unlockOk: boolean | undefined, mode: CheckMode): ToolOutcome {
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
    content: evalFeedback(model, beforeModel, mode),
    card: {
      title: summary,
      detail: `+${stats.added} −${stats.removed} lines${errors ? ` · ${errors} source error${errors > 1 ? "s" : ""}` : ""}`,
      diff: { before, after: next },
      status: errors ? "error" : "done",
    },
  };
}

/** compare_designs builds alternatives in the agents' geometry workers and solves their analyses in a worker of its own. */
const compareDeps = {
  current: async () => {
    await whenChecked(60_000);
    const s = useDesign.getState();
    return { source: s.source, model: s.model, report: s.report };
  },
  measure: measureIsolated,
  solve: (input: Parameters<typeof solveOnce>[0], signal?: AbortSignal) => solveOnce(input, undefined, signal),
  locked: (before: string, after: string) => lockedChanges(before, after),
};

// ---------- handlers ----------

/** Tools that change the source: given check, the result carries the build and check results of the change. */
const SOURCE_TOOLS = new Set(["edit_design", "write_design", "update_brief", "set_material", "place_fasteners"]);

interface ToolContext {
  signal?: AbortSignal;
  toolUseId?: string;
  /**
   * For a tool that changes the source: true waits for the build and checks and returns them with the result, so
   * Claude needs no run_checks step; false says a later change in the same response carries them.
   */
  check?: boolean;
}

export async function runTool(name: string, input: unknown, ctx: ToolContext = {}): Promise<ToolOutcome> {
  const before = useDesign.getState().source;
  const out = await runOne(name, input, ctx);
  if (!ctx.check || !SOURCE_TOOLS.has(name) || out.isError || useDesign.getState().source === before) return out;
  const c = await checkResults(ctx.signal);
  const asks = await measuredAsks(ctx.signal);
  const text = `Built and checked:\n${c.text}${asks ? `\n\nThe user's asks, measured after this change:\n${asks}` : ""}`;
  return {
    ...out,
    content: typeof out.content === "string" ? `${out.content}\n\n${text}` : [...out.content, { type: "text", text }],
    card: { ...out.card, detail: [out.card.detail, c.title].filter(Boolean).join(" · ") },
  };
}

/** Geometric quantities for the asks, from the kernel: only the parts the queries name are placed, so it costs little. */
export async function kernelGeo(queries: GeoQuery[]) {
  const s = useDesign.getState();
  if (!s.model) return { geo: {}, geoErrors: {} };
  const named = new Set(queries.flatMap((q) => (q.q === "min_distance" ? [q.a, q.b] : [q.a])));
  const req = buildChecksRequest(s.model, new Set(s.model.parts.map((p) => p.hash).filter((h) => meshes.has(h))));
  const placed = req.placed.filter((p) => named.has(p.name) || named.has(p.id));
  return kernel.checks({ placed, queries, access: [], envelopes: [], ignorePairs: [] });
}

/** The asks measured on the design as it is now, as Claude reads them; empty when nothing was asked. */
async function measuredAsks(signal?: AbortSignal): Promise<string> {
  if (!asksState().asks.length || signal?.aborted) return "";
  const s = useDesign.getState();
  if (s.kernelStatus === "error") return "";
  return asksText(await remeasure({ source: s.source, model: s.model }, kernelGeo));
}

const orAbort = (p: Promise<unknown>, signal?: AbortSignal) =>
  signal ? Promise.race([p, new Promise<void>((r) => (signal.aborted ? r() : signal.addEventListener("abort", () => r(), { once: true })))]) : p;

/** Wait for the current source's build and checks (and briefly for its detailed geometry), then report them. */
async function checkResults(signal?: AbortSignal): Promise<{ text: string; title: string; detail?: string; ok: boolean; kernelDown?: boolean }> {
  await orAbort(whenChecked(), signal);
  let s = useDesign.getState();
  // detailed geometry (threads, knurls, cosmetic steps) builds after the checks; wait a little for it so its problems are seen
  let refining = false;
  if (s.model?.parts.some((p) => p.detail) && s.kernelStatus !== "error" && !signal?.aborted) {
    await orAbort(whenRefined(20_000), signal);
    s = useDesign.getState();
    refining = s.stage !== "done";
  }
  if (s.kernelStatus === "error") return { text: `The geometry kernel is unavailable: ${s.kernelError}`, title: "Geometry kernel unavailable", ok: false, kernelDown: true };
  // the wiring and mounting checks route the cables in a worker after the build; wait a little for them
  if (!signal?.aborted) {
    await orAbort(whenWiringChecked(s.model, 20_000), signal);
    // the motion sweep works through moving parts a slice at a time
    await orAbort(whenSwept(20_000), signal);
    s = useDesign.getState();
  }
  const r = s.report;
  const c = r?.counts;
  const fw = firmwareSummary(s.model);
  return {
    text: `${modelSummary(s.model)}\n\n${reportSummary(r)}${fw.text ? `\n${fw.text}` : ""}\nBuild: ${s.timings.built} solid(s) built, ${s.timings.reused} reused, ${Math.round(s.timings.buildMs)} ms; checks ${Math.round(s.timings.checksMs)} ms.${refining ? "\nThe detailed geometry (threads, knurls, cosmetic steps) is still building; its problems, if any, show in a later run_checks." : ""}${s.checksError ? `\nChecks error: ${s.checksError}` : ""}`,
    title: c ? (c.fail ? `${c.fail} check${c.fail > 1 ? "s" : ""} failing` : `All ${c.pass} checks pass`) : "Checks unavailable",
    detail: c ? `${c.pass} pass · ${c.fail} fail · ${c.warn} warn${fw.warnings ? ` · ${fw.warnings} firmware warning${fw.warnings > 1 ? "s" : ""}` : ""}` : undefined,
    ok: !!c && c.fail === 0,
  };
}

async function runOne(name: string, input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const mode: CheckMode = ctx.check === undefined ? undefined : ctx.check ? "now" : "later";
  switch (name) {
    case "build_subassemblies":
      return runBuildTool(input, ctx);
    case "update_plan":
      return runPlanTool(input);
    case "record_asks": {
      const p = AsksInput.safeParse(input);
      if (!p.success) return invalid(p.error);
      setAsks(p.data.asks);
      // measured now as a baseline, which also shows a measure that cannot be read; not waiting long for a build in flight
      await orAbort(whenChecked(20_000), ctx.signal);
      const measured = await measuredAsks(ctx.signal);
      const n = p.data.asks.length;
      return {
        content: `Recorded ${n} ask${n > 1 ? "s" : ""}. Kerf measures them after every change and lists parts that change though no ask names them. As the design is now, before your change:\n${measured}`,
        card: { title: `Noted ${n} ask${n > 1 ? "s" : ""}` },
      };
    }
    case "save_lesson": {
      const p = LessonInput.safeParse(input);
      if (!p.success) return invalid(p.error);
      const r = saveLesson(p.data.lesson, p.data.replaces);
      return { content: r.text, card: r.saved ? { title: "Saved a lesson", detail: `${p.data.lesson} · Settings → AI → Lessons lists them` } : { title: "Lesson not saved", detail: r.text } };
    }
    case "get_example": {
      const p = ExampleInput.safeParse(input);
      if (!p.success) return invalid(p.error);
      const r = exampleText(p.data.id, p.data.part);
      if ("error" in r) return { isError: true, content: r.error, card: { title: "Example not found", detail: r.error, status: "error" } };
      return { content: r.text, card: { title: "Read a worked example", detail: r.title } };
    }
    case "read_reference": {
      const p = ReferenceInput.safeParse(input);
      if (!p.success) return invalid(p.error);
      const d = DEFERRED.find((x) => x.id === p.data.section)!;
      return { content: referenceText(p.data.section), card: { title: "Read the reference", detail: d.heading.replace(/^## /, "") } };
    }
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
      if (p.data.alternative) {
        const alt = alternativeSource(p.data.alternative, before);
        if (alt.error) return { isError: true, content: alt.error, card: { title: "Alternative not applied", detail: alt.error, status: "error" } };
        return applySource(alt.src!, p.data.summary, p.data.unlock_ok, mode);
      }
      const { src, errors } = applyTextEdits(before, p.data.edits!);
      if (errors.length) {
        return { isError: true, content: `No edits were applied.\n${errors.join("\n")}`, card: { title: "Edit could not be applied", detail: errors[0], status: "error" } };
      }
      if (src.length > MAX_SOURCE_CHARS) return { isError: true, content: "The design would exceed the 300,000 character limit.", card: { title: "Edit too large", status: "error" } };
      return applySource(src, p.data.summary, p.data.unlock_ok, mode);
    }
    case "write_design": {
      const p = WriteInput.safeParse(input);
      if (!p.success) return invalid(p.error);
      const { source, model } = useDesign.getState();
      return applySource(keepBrief(p.data.source.replace(/\r\n/g, "\n"), source, model), p.data.summary, p.data.unlock_ok, mode);
    }
    case "get_sketch": {
      const parsed = z.object({ name: z.string().min(1).max(200) }).strict().safeParse(input);
      if (!parsed.success) return invalid(parsed.error);
      const m = useDesign.getState().model;
      const sk = m?.sketches.find((x) => x.name === parsed.data.name);
      if (!sk) return { content: `There is no sketch named ${parsed.data.name}. Sketches: ${m?.sketches.map((x) => x.name).join(", ") || "none"}.`, isError: true, card: { title: `No sketch ${parsed.data.name}`, status: "error" } };
      return { content: sketchDetail(sk), card: { title: `Read sketch ${sk.name}`, detail: sketchStatusText(sk), status: "done" } };
    }
    case "run_checks": {
      const c = await checkResults(ctx.signal);
      if (c.kernelDown) return { isError: true, content: c.text, card: { title: c.title, status: "error" } };
      return { content: c.text, card: { title: c.title, detail: c.detail, status: c.ok ? "done" : "error" } };
    }
    case "compare_designs":
      try {
        return await compareDesigns(input, compareDeps, ctx.signal);
      } finally {
        // each geometry worker holds a few hundred MB
        pool.closeSoon();
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
    case "run_analysis": {
      const p = AnalysisInput.safeParse(input ?? {});
      if (!p.success) return invalid(p.error);
      const s = await whenChecked();
      if (s.kernelStatus === "error") return { isError: true, content: `The geometry kernel is unavailable: ${s.kernelError}`, card: { title: "Geometry kernel unavailable", status: "error" } };
      const all = s.model?.analyses ?? [];
      if (!all.length)
        return {
          isError: true,
          content: "This design has no analysis block yet. Add one with edit_design (see Analysis blocks in the language reference), then call run_analysis.",
          card: { title: "No analysis to run", status: "error" },
        };
      const named = p.data.label ? all.filter((a) => a.label === p.data.label) : all;
      if (!named.length) return { isError: true, content: `No analysis is labelled "${p.data.label}". Analyses: ${all.map((a) => `"${a.label}"`).join(", ")}.`, card: { title: "Analysis not found", status: "error" } };
      // a design study builds many designs, so it runs only when it is named
      const study = p.data.label ? named.find((a): a is StudySpec => a.kind === "study") : undefined;
      if (study) {
        const st = await startStudy(study.label);
        const r = st.result;
        const best = r && r.best !== null ? r.runs[r.best] : null;
        return {
          isError: st.status === "error" || undefined,
          content: studySummary(study, st),
          card: { title: best ? `${study.label}: best of ${r!.runs.length} designs` : `${study.label}: ${st.status === "error" ? "could not run" : "no design passes"}`, detail: studyStatus(study), status: st.status === "error" ? "error" : "done" },
        };
      }
      const studies = named.filter((a) => a.kind === "study");
      const targets = named.filter((a): a is Exclude<AnalysisSpec, StudySpec> => a.kind !== "study");
      if (!targets.length)
        return { isError: true, content: `Only design studies here (${studies.map((a) => `"${a.label}"`).join(", ")}); they build many designs, so they run only when named: run_analysis label: "<study>".`, card: { title: "Name the study to run", status: "error" } };
      if (p.data.fine) for (const a of targets) if (a.kind === "structural" && !useAnalysis.getState().runs.get(a.label)?.fine) runFine(a.label);
      if (p.data.check) for (const a of targets) if (a.kind === "structural" && !useAnalysis.getState().runs.get(a.label)?.check) runAccuracyCheck(a.label);
      if (targets.some((a) => a.kind === "airflow")) {
        startAirflowNow();
        await whenAirflowDone(AIRFLOW_WAIT_MS);
      }
      if (targets.some((a) => a.kind !== "airflow")) await whenAnalyzed();
      const st = useAnalysis.getState();
      const report = useDesign.getState().report?.items ?? [];
      const air = useAirflow.getState();
      const model = useDesign.getState().model;
      const text = targets
        .map((a) =>
          a.kind === "airflow"
            ? airflowSummary(a, air.runs.get(a.label), air.versions.get(a.label))
            : a.kind === "structural"
              ? structuralSummary(a, st.runs.get(a.label))
              : a.kind === "uci"
                ? uciSummary(a, report)
                : drivetrainSummary(a, st.drivetrain.get(a.label)),
        )
        .join("\n\n");
      const verdicts = targets.map((a) => {
        if (a.kind === "uci") {
          const v = uciVerdict(uciItems(a, report));
          return v === "pending" ? "fail" : v;
        }
        if (a.kind === "airflow") {
          const items = model ? airflowItems(a, air.runs.get(a.label), model) : [];
          return items.some((i) => i.status === "fail") ? "fail" : items.some((i) => i.status === "warn" || i.status === "pending") ? "warn" : "pass";
        }
        if (a.kind === "drivetrain") {
          const r = st.drivetrain.get(a.label);
          return !r || r.error || r.items.some((i) => i.status === "fail") ? "fail" : r.items.some((i) => i.status === "warn") ? "warn" : "pass";
        }
        const r = st.runs.get(a.label);
        return r?.result && r.status === "done" ? structuralVerdict(a, r.result) : "fail";
      });
      const firstShown = targets.find((a) => a.kind === "structural" && st.runs.get(a.label)?.result);
      if (firstShown) showResults(firstShown.label);
      const airShown = targets.find((a) => a.kind === "airflow" && air.runs.get(a.label)?.result);
      if (airShown) showAirflow(airShown.label);
      const fails = verdicts.filter((v) => v === "fail").length;
      let title: string;
      if (targets.length === 1) {
        const a = targets[0];
        const r = a.kind === "structural" ? st.runs.get(a.label)?.result : undefined;
        const ar = a.kind === "airflow" ? air.runs.get(a.label)?.result : undefined;
        title = r
          ? `${a.label}: safety ${fmtNum(r.minSafety.value, 2)} (target ${fmtNum(a.kind === "structural" ? a.safety : 0, 1)})`
          : ar
            ? `${a.label}: CdA ${fmtNum(ar.yaws.reduce((t, y) => t + y.cda, 0) / ar.yaws.length, 3)} m²`
            : `${a.label}: ${verdicts[0] === "fail" ? "fails" : verdicts[0] === "warn" ? "needs a look" : "passes"}`;
      } else title = fails ? `${fails} of ${targets.length} analyses failing` : `All ${targets.length} analyses pass`;
      return {
        content:
          text +
          (firstShown ? `\n\nThe results of "${firstShown.label}" are now shown on the user's model. Use capture_view with results to look at them.` : "") +
          (airShown ? `\n\nThe airflow of "${airShown.label}" is shown on the user's model. Use capture_view with airflow: "pressure", "streamlines" or "wake" to look at it.` : "") +
          (studies.length ? `\n\nDesign studies (${studies.map((a) => `"${a.label}"`).join(", ")}) were not run: each builds many designs, so it runs only when named, with run_analysis label: "<study>".` : ""),
        card: { title, detail: verdicts.map((v, i) => `${targets[i].label}: ${v}`).join(" · "), status: fails ? "error" : "done" },
      };
    }
    case "capture_view": {
      const p = ViewInput.safeParse(input);
      if (!p.success) return invalid(p.error);
      const vp = viewport();
      if (!vp) return { isError: true, content: "The 3D view is not available right now.", card: { title: "View unavailable", status: "error" } };
      await whenChecked(30_000);
      let resultNote = "";
      if (p.data.results) {
        await whenAnalyzed(60_000);
        const st = useAnalysis.getState();
        const temp = p.data.results === "temp";
        const life = p.data.results === "life";
        const specs = (useDesign.getState().model?.analyses ?? []).filter((a) => a.kind === "structural" && st.runs.get(a.label)?.result && (!temp || st.runs.get(a.label)?.result?.ranges.temp) && (!life || st.runs.get(a.label)?.result?.ranges.life));
        const pick = specs.find((a) => a.label === p.data.analysis) ?? specs.find((a) => a.label === st.shown) ?? specs[0];
        if (!pick)
          return {
            isError: true,
            content: temp
              ? "No analysis has temperatures to draw. Add one with heat: (see Analysis blocks) and call run_analysis first."
              : life
                ? "No analysis has a fatigue life to draw. Give one cycles: over 1000 or history: (see Analysis blocks) and call run_analysis first."
                : "No structural analysis has results to draw. Add an analysis block and call run_analysis first.",
            card: { title: "No results to show", status: "error" },
          };
        if (p.data.analysis && pick.label !== p.data.analysis) resultNote = ` (no results for "${p.data.analysis}")`;
        useAnalysis.setState({ field: p.data.results as ResultField });
        showResults(pick.label);
        // let the viewport attach the overlay before capturing
        await new Promise((r) => setTimeout(r, 120));
        const fieldText = {
          stress: "von Mises stress (blue low, red high)",
          safety: "factor of safety (red below 1, amber below the target, green to blue above)",
          disp: "deflection (blue none, red most)",
          strain: "principal strain (blue compression, red tension)",
          temp: "temperature (blue coolest, red hottest)",
          life: "fatigue life against the target (red breaks before it, amber within 10× of it, green and blue last)",
        }[p.data.results];
        resultNote = `, coloured by ${fieldText} from "${pick.label}"${resultNote}, deformed shape exaggerated with the unloaded outline ghosted; orange arrows are loads, teal cones are fixed or moved supports (spheres are rollers, pins and springs), rings mark hot spots${p.data.section ? "; the cut face shows the field inside the parts" : ""}`;
      }
      if (p.data.airflow) {
        const air = useAirflow.getState();
        const specs = (useDesign.getState().model?.analyses ?? []).filter((a) => a.kind === "airflow" && air.runs.get(a.label)?.result);
        const pick = specs.find((a) => a.label === p.data.analysis) ?? specs.find((a) => a.label === air.shown) ?? specs[0];
        if (!pick) return { isError: true, content: "No airflow analysis has results to draw. Add one (airflow: 45kmh) and call run_analysis first.", card: { title: "No airflow to show", status: "error" } };
        const r = air.runs.get(pick.label)!.result!;
        let yi = 0;
        if (p.data.yaw !== undefined) yi = r.yaws.reduce((b, y, i) => (Math.abs(y.yaw - p.data.yaw!) < Math.abs(r.yaws[b].yaw - p.data.yaw!) ? i : b), 0);
        const kind = p.data.airflow;
        const surface: SurfaceShown = kind === "pressure" ? "cp" : kind === "friction" ? "cf" : "none";
        useAirflow.setState({ shown: pick.label, yaw: yi, surface: kind === "eddies" ? "cp" : surface, lines: kind === "streamlines", wake: kind === "wake", vortices: kind === "eddies", slice: "off" });
        await new Promise((r) => setTimeout(r, 160));
        const what = {
          pressure: "surface pressure coefficient (red: the air pushes on it, blue: suction)",
          friction: "skin friction (dark: little, bright: most)",
          streamlines: "streamlines from upstream, coloured by speed (blue slow, red fast)",
          wake: "the wake: the surface where the air has lost all its total pressure, coloured by speed",
          eddies: "the eddies at the end of the run (Q-criterion), coloured by speed",
        }[kind];
        resultNote = `, showing ${what} from "${pick.label}" at ${fmtNum(r.yaws[yi].yaw, 1)}° yaw (the wind comes from the right at positive yaw)`;
      }
      const ids = expandNames(p.data.highlight ?? []);
      const explode = p.data.exploded === true ? 1 : typeof p.data.exploded === "number" && p.data.exploded > 0 ? p.data.exploded : undefined;
      if (explode) resultNote += explodeNote(explode);
      // a group on its own
      const vm = useDesign.getState().model;
      let only: string[] | undefined;
      if (p.data.groups?.length && vm) {
        const want = new Set(p.data.groups.map((g) => g.trim().toLowerCase()));
        const gs = partGroups(vm.parts).filter((g) => want.has(g.name.toLowerCase()));
        if (!gs.length) return { isError: true, content: `No group named ${p.data.groups.map((g) => `"${g}"`).join(", ")}. Groups: ${partGroups(vm.parts).map((g) => g.name).join(", ")}. Use group_parts to make one.`, card: { title: "Group not found", status: "error" } };
        only = gs.flatMap((g) => g.ids);
        resultNote += `, only ${gs.map((g) => g.name).join(", ")}`;
      }
      const url = await vp.capture({ view: p.data.view, width: 1024, height: 704, focus: ids, section: p.data.section, mime: "image/jpeg", quality: 0.85, samples: 24, overlays: !!p.data.results || !!p.data.airflow, explode, only });
      const data = url.split(",")[1] ?? "";
      return {
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data } },
          { type: "text", text: `Rendered ${p.data.view} view${p.data.section ? `, sectioned across ${p.data.section}` : ""}${ids.length ? `, highlighting ${p.data.highlight!.join(", ")}` : ""}${resultNote}. Z is up; X is red, Y is green in the axis triad.` },
        ],
        card: { title: p.data.results ? `Looked at the ${p.data.results === "disp" ? "deflection" : p.data.results} results` : p.data.airflow ? `Looked at the airflow (${p.data.airflow})` : explode ? `Looked at the exploded ${p.data.view} view` : `Looked at the ${p.data.view} view`, image: url },
      };
    }
    case "view_drawing": {
      const p = DrawingInput.safeParse(input ?? {});
      if (!p.success) return invalid(p.error);
      try {
        const sheet = await sheetFor(p.data.name ?? useDrawings.getState().active ?? undefined, { signal: ctx.signal });
        const url = await sheetToPng(sheet, 1568);
        return {
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: url.split(",")[1] ?? "" } },
            { type: "text", text: [describeSheet(sheet), pmiNote(sheet.name)].filter(Boolean).join("\n") },
          ],
          card: { title: `Looked at the ${sheet.title} drawing`, detail: `${sheet.size} · ${sheet.views.length} views · ${sheet.dims.length} dimensions`, image: url },
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { isError: true, content: msg, card: { title: "Drawing unavailable", detail: msg, status: "error" } };
      }
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
      const out = applySource(next, p.data.summary, p.data.user_asked, mode);
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
        return pending ? `${rs.length - pending} of ${rs.length} requirements pass; ${pending} measured after the build (see ${mode === "now" ? "the checks below" : "run_checks"})` : `pass (${rs.length} requirement${rs.length === 1 ? "" : "s"})`;
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
    case "inspect_part": {
      const p = InspectInput.safeParse(input);
      if (!p.success) return invalid(p.error);
      const m = useDesign.getState().model;
      const part = m?.parts.find((q) => q.id === p.data.part) ?? m?.parts.find((q) => q.name === p.data.part);
      if (!m || !part) return { isError: true, content: `No part or component named "${p.data.part}". Parts: ${(m?.parts ?? []).slice(0, 60).map((q) => q.id).join(", ")}`, card: { title: "Part not found", detail: p.data.part, status: "error" } };
      let sel;
      if (p.data.select) {
        const r = evaluateSelector(p.data.select, (part.features ?? []).map((f) => f.name), useDesign.getState().source);
        if (!r.sel) return { isError: true, content: `The selector did not evaluate: ${r.error}`, card: { title: "Selector error", detail: r.error, status: "error" } };
        sel = r.sel;
      }
      const at = p.data.at ? inverseXforms(p.data.at as V3, part.xf) : undefined;
      try {
        await kernel.ready();
        const res = await kernel.inspectPart({ hash: part.hash, recipe: part.recipe, label: part.id, sel, selKind: p.data.kind, at, limit: p.data.limit });
        const text = inspectText(part.id, res, p.data.select);
        const cosmetic = (part.features ?? []).filter((f) => f.cosmetic).map((f) => f.name);
        return {
          content: text + (cosmetic.length ? `\nCosmetic features (only in detailed builds, not inspected here): ${cosmetic.join(", ")}` : ""),
          card: { title: `Inspected ${part.id}`, detail: res.selection ? `${p.data.select} → ${res.selection.count} ${res.selection.kind}` : `${res.features.length} named features · ${res.edgeStats.convex + res.edgeStats.concave} sharp edges` },
        };
      } catch (e) {
        return { isError: true, content: `Could not inspect ${part.id}: ${(e as Error).message}`, card: { title: "Inspection failed", status: "error" } };
      }
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
    case "catalog_lookup": {
      const p = LookupInput.safeParse(input ?? {});
      if (!p.success) return invalid(p.error);
      return catalogLookup(p.data);
    }
    case "engineering_calc": {
      const p = CalcInput.safeParse(input);
      if (!p.success) return invalid(p.error);
      return engineeringCalc(p.data.name, p.data.args ?? {});
    }
  }
  const processOutcome = await runProcessTool(name, input);
  if (processOutcome) return processOutcome;
  const simOutcome = await runSimTool(name, input, ctx);
  if (simOutcome) return simOutcome;
  const imported = await runImportTool(name, input);
  if (imported) return imported;
  const material = await runMaterialTool(name, input, ctx);
  if (material) return material;
  const fasten = await runFastenTool(name, input, ctx);
  if (fasten) return fasten;
  const viewed = await runViewTool(name, input);
  if (viewed) return viewed;
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
  record_asks: "Noting what you asked for",
  get_example: "Reading a worked example",
  read_reference: "Reading the language reference",
  save_lesson: "Saving a lesson",
  get_design: "Reading the design",
  edit_design: "Editing the design",
  write_design: "Writing the design",
  run_checks: "Building and checking",
  explore_fixes: "Searching for fixes",
  compare_designs: COMPARE_TITLE,
  ...MATERIAL_TOOL_TITLES,
  ...FASTEN_TOOL_TITLES,
  ...VIEW_TOOL_TITLES,
  get_sketch: "Reading a sketch",
  capture_view: "Looking at the model",
  view_drawing: "Looking at the drawing",
  inspect_part: "Inspecting a part",
  update_brief: "Updating the brief",
  view_reference: "Looking at a reference",
  run_analysis: "Running the analysis",
  ask_user: "Asking you",
  catalog_lookup: "Looking up parts",
  engineering_calc: "Calculating",
  ...PROCESS_TOOL_TITLES,
  ...SIM_TOOL_TITLES,
  build_subassemblies: "Building subassemblies in parallel",
  review_design: "Reviewing the design",
  suggest_next_steps: "Suggesting next steps",
  ...IMPORT_TOOL_TITLES,
};

// ---------- parts catalog ----------

const onHandMark = (p: CatalogPart) => (isHad(p, useSettings.getState().onHand) ? " | ON HAND (the user has it)" : "");
const oneLine = (p: CatalogPart) => `${p.id} | ${p.name} | ${p.summary.split(/(?<=\.)\s+/).slice(0, 2).join(" ")}${p.price_usd ? ` | ~$${p.price_usd}` : ""}${onHandMark(p)}`;
const usage = (p: CatalogPart) => `Use as: lib.${p.kind}("${p.id}"${p.cut_to_length ? ", length: <mm>" : ""}) or lib.part("${p.id}")`;

export function catalogLookup(q: { id?: string; query?: string; kind?: string; limit?: number }): ToolOutcome {
  if (q.id?.trim()) {
    const id = q.id.trim();
    const p = catalogPart(id);
    if (!p) {
      const near = searchCatalog(id.replace(/[_-]+/g, " "), undefined, 6);
      return {
        isError: true,
        content: `No catalog part has the id "${id}".${near.length ? ` Closest matches:\n${near.map(oneLine).join("\n")}` : ""}`,
        card: { title: `No catalog part "${id}"`, status: "error" },
      };
    }
    return { content: `${usage(p)}${onHandMark(p) ? "\nThe user has this part on hand." : ""}\n${describePart(p)}`, card: { title: `Looked up ${p.name}`, detail: `${p.id} · ${p.kind}${p.price_usd ? ` · about $${p.price_usd}` : ""}` } };
  }
  const kind = q.kind?.trim() || undefined;
  if (kind && !CATALOG_KINDS.includes(kind as CatalogPart["kind"])) {
    return { isError: true, content: `"${kind}" is not a catalog kind. Kinds: ${CATALOG_KINDS.join(", ")}.`, card: { title: `Unknown part kind "${kind}"`, status: "error" } };
  }
  const query = q.query?.trim() ?? "";
  if (!query && !kind) return { isError: true, content: "Give an id, a query or a kind.", card: { title: "Nothing to look up", status: "error" } };
  const found = searchCatalog(query, kind, 40);
  const what = [query && `"${query}"`, kind && `kind ${kind}`].filter(Boolean).join(", ");
  if (!found.length) {
    return {
      content: `No catalog part matches ${what}. Kinds in the catalog: ${CATALOG_KINDS.join(", ")}. If the design needs a part the catalog lacks, search the web for a real product (maker, part number, price, product page) and add it as a buy item.`,
      card: { title: `No catalog match for ${what}`, detail: "Not in the catalog" },
    };
  }
  const full = Math.min(found.length, q.limit ?? (query ? 3 : 0));
  const parts = [`${found.length} catalog part${found.length === 1 ? "" : "s"} match ${what}.`];
  for (const p of found.slice(0, full)) parts.push(`${usage(p)}\n${describePart(p)}`);
  if (found.length > full) parts.push(`${full ? "Other matches" : "Matches"} (look one up by id for its pins and specs):\n${found.slice(full).map(oneLine).join("\n")}`);
  return { content: parts.join("\n\n---\n\n"), card: { title: `Searched the parts catalog: ${what}`, detail: found.slice(0, 6).map((p) => p.id).join(", ") + (found.length > 6 ? ", …" : "") } };
}

// ---------- engineering calculators ----------

const num4 = (n: number) => (Number.isFinite(n) ? String(Number(n.toPrecision(4))) : String(n));

function specFields(p: CatalogPart): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const [k, v] of Object.entries(p.specs)) out[k] = typeof v === "boolean" ? (v ? 1 : 0) : v;
  return { ...out, catalog_id: p.id, price: p.price_usd ?? 0 };
}

/** Read one literal the way the language does (units, true/false, simple arithmetic). */
function readLiteral(text: string): { value: Value } | { error: string } {
  if (!text || /[\n\r{};]/.test(text)) return { error: "write one value, such as 9.5m or 10.8Nm" };
  const m = evaluate(`param v = ${text}\n`, { skipGeometry: true });
  const err = m.diagnostics.find((d) => d.severity === "error");
  if (err) return { error: err.message };
  const p = m.params.find((x) => x.name === "v");
  return p ? { value: p.value } : { error: "not a value" };
}

/** A catalog part from an id, or from a component of that name in the current design. */
function partFor(text: string): { part: CatalogPart; label: string; ref: string } | null {
  const direct = catalogPart(text);
  if (direct) return { part: direct, label: direct.name, ref: `<your lib.${direct.kind}("${direct.id}") component>` };
  const mc = useDesign.getState().model?.machine?.components.find((c) => c.name === text);
  const p = mc && catalogPart(mc.catalogId);
  return p ? { part: p, label: text, ref: text } : null;
}

const COMPONENT_ARGS = new Set(["motor", "battery", "actuator"]);
/** Words the hardware choosers take as text: a thread size like "1/4-20" must not be read as arithmetic. */
const TEXT_ARGS: Record<string, Set<string>> = {
  fastener: new Set(["into", "material", "clamped", "head", "grade", "env", "size", "min", "max"]),
  motor_select: new Set(["kind", "prefer"]),
};
/** Choosers that prefer what the user has: their on-hand list goes in as have: when the call does not give one. */
const HAVE_CALCS = new Set(["fastener", "motor_select"]);
const listOf = (text: string) =>
  text
    .split(/[\n;,]+/)
    .map((x) => x.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);

export function engineeringCalc(name: string, args: Record<string, number | string | boolean>): ToolOutcome {
  const fn = CALC_FNS[name];
  if (!fn) return { isError: true, content: `There is no calc.${name}. Calculators: ${Object.keys(CALC_FNS).join(", ")}.`, card: { title: `No calculator ${name}`, status: "error" } };
  const accepts = calcParams(name);
  const fail = (msg: string): ToolOutcome => ({ isError: true, content: `calc.${name}: ${msg}${accepts.length ? `\nIt accepts: ${accepts.join(", ")}. ${fn.doc ?? ""}` : ""}`, card: { title: `calc.${name} could not run`, detail: msg, status: "error" } });
  const unknown = Object.keys(args).filter((k) => accepts.length && !accepts.includes(k));
  if (unknown.length) return fail(`no argument${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `"${k}"`).join(", ")}`);

  const named: Record<string, Value> = {};
  const shown: string[] = [];
  for (const [k, raw] of Object.entries(args)) {
    if (typeof raw === "number") {
      if (!Number.isFinite(raw)) return fail(`${k} must be a finite number`);
      named[k] = raw;
      shown.push(`${k}: ${raw}`);
      continue;
    }
    if (typeof raw === "boolean") {
      named[k] = raw;
      shown.push(`${k}: ${raw}`);
      continue;
    }
    const text = raw.trim();
    if (TEXT_ARGS[name]?.has(k)) {
      named[k] = text.replace(/^["']|["']$/g, "");
      shown.push(`${k}: ${JSON.stringify(named[k])}`);
      continue;
    }
    if (k === "have" && HAVE_CALCS.has(name)) {
      named[k] = listOf(text);
      shown.push(`${k}: ${JSON.stringify(named[k])}`);
      continue;
    }
    const comp = partFor(text);
    if (comp) {
      named[k] = new Obj(specFields(comp.part), "component", comp.label);
      shown.push(`${k}: ${comp.ref}`);
      continue;
    }
    if (COMPONENT_ARGS.has(k)) return fail(`${k}: "${text}" is not a catalog id or a catalog component in the design`);
    if (k === "bearing") {
      if (!BEARINGS[text]) return fail(`unknown bearing "${text}". Codes: ${Object.keys(BEARINGS).join(", ")}`);
      named[k] = text;
      shown.push(`${k}: "${text}"`);
      continue;
    }
    const lit = readLiteral(text);
    if ("error" in lit) return fail(`could not read ${k}: "${text}" (${lit.error})`);
    named[k] = lit.value;
    shown.push(`${k}: ${text}`);
  }

  // what the user has on hand, so the choice prefers it; the design must say it too to evaluate the same everywhere
  const onHand = useSettings.getState().onHand;
  let haveNote = "";
  if (HAVE_CALCS.has(name) && !("have" in args) && onHand.length) {
    named.have = [...onHand];
    shown.push(`have: ${JSON.stringify(onHand)}`);
    haveNote = "The user's parts on hand were passed as have:. Keep have: in the call when you record it in the design.";
  }

  let result: Value;
  try {
    result = fn.call([], named, {
      error: (msg: string) => {
        throw new Error(msg);
      },
      geo: () => 0,
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  if (!isCalc(result)) return fail("did not return a calculation");
  const t = result.trace;
  const line = (l: { label: string; value: number; unit: string; note?: string }) => `  - ${l.label}: ${num4(l.value)}${l.unit ? ` ${l.unit}` : ""}${l.note ? ` (${l.note})` : ""}`;
  const fields = Object.entries(result.fields)
    .map(([k, v]) => `${k} = ${typeof v === "number" ? num4(v) : typeof v === "string" ? JSON.stringify(v) : String(v)}`)
    .join(", ");
  const call = `calc.${name}(${shown.join(", ")})`;
  const text = [
    call,
    `${t.title} (confidence: ${t.confidence})`,
    "Inputs:",
    ...t.inputs.map(line),
    "Results:",
    ...t.outputs.map(line),
    "Method:",
    ...t.method.map((m) => `  - ${m}`),
    "Assumptions:",
    ...t.assumptions.map((a) => `  - ${a}`),
    t.verify ? `Confirm with a physical test: ${t.verify}` : "",
    `Result fields in base units (mm, N, N·mm, MPa, V, A, W, s), for other calculations and the design: ${fields}`,
    `To record it in the design: let <name> = ${call}`,
    haveNote,
  ].filter(Boolean);
  return {
    content: text.join("\n"),
    card: { title: t.title, detail: t.outputs.slice(0, 3).map((l) => `${l.label.trim()} ${num4(l.value)}${l.unit ? ` ${l.unit}` : ""}`).join(" · ") },
  };
}

/** What an exploded capture shows: how many steps, what came off which way, and how to steer it. */
function explodeNote(f: number): string {
  const model = useDesign.getState().model;
  if (!model) return "";
  const plan = planExplode(model, { holds: findHolds(model, meshOf), mesh: meshOf });
  const label = new Map(model.parts.map((p) => [p.id, p.label]));
  const dir = (d: number[]) => {
    const k = d.findIndex((x) => Math.abs(x) > 0.999);
    return k >= 0 ? `${d[k] > 0 ? "+" : "-"}${"XYZ"[k]}` : `(${d.map((x) => fmtNum(x, 2)).join(", ")})`;
  };
  const moving = [...plan.moves.values()].filter((m) => m.dist > 0);
  const hw = moving.filter((m) => m.via === "screw" || m.via === "nut" || m.via === "washer" || m.via === "set").length;
  const parts = moving.filter((m) => m.via !== "screw" && m.via !== "nut" && m.via !== "washer" && m.via !== "set");
  const bases = [...plan.moves.values()].filter((m) => m.via === "base").map((m) => label.get(m.id) ?? m.id);
  const list = parts
    .slice(0, 14)
    .map((m) => `${label.get(m.id) ?? m.id} ${dir(m.dir)} off ${label.get(m.from ?? "") ?? m.from}${m.via === "contact" ? " (only touching)" : m.via === "fit" ? " (fit)" : ""}`)
    .join("; ");
  return `, exploded ${f >= 1 ? "all the way" : `${fmtNum(f * 100, 0)}% of the way`} in ${plan.stages} step${plan.stages === 1 ? "" : "s"}: ${bases.join(", ") || "nothing"} stays; ${hw} screws, nuts and washers back out along their axes${parts.length ? `; ${list}${parts.length > 14 ? `; and ${parts.length - 14} more` : ""}` : ""}. explode: (x, y, z) on a part sends it another way, explode: false keeps it on what it sits on`;
}
