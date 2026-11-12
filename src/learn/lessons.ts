// Learning Kerf in Kerf: tutorials that start from a design of their own and watch what you do, a step at a time,
// and feature samples, finished designs that each show one thing with a short tour of where to look. Both are
// starting points on the home screen (Tutorials and Feature samples); opening one starts its steps beside the model.
// The steps' checks read a snapshot of the app (LearnState), so they are plain functions the tests can run.

import type { Model } from "../core/model";
import type { CheckReport } from "../core/checks";
import shelf from "../demos/shelf.kerf?raw";
import enclosure from "../demos/enclosure.kerf?raw";
import weldment from "../demos/samples/frame-weldment.kerf?raw";
import cnc from "../demos/samples/cnc-toolpaths.kerf?raw";
import nesting from "../demos/samples/laser-nesting.kerf?raw";
import sheetEnclosure from "../demos/samples/sheet-metal-enclosure.kerf?raw";
import split from "../demos/samples/split-for-printing.kerf?raw";
import shaking from "../demos/samples/shaking.kerf?raw";
import plies from "../demos/samples/carbon-ply-book.kerf?raw";
import configs from "../demos/samples/configurations.kerf?raw";
import mates from "../demos/samples/mates-drag.kerf?raw";
import fillets from "../demos/samples/variable-fillets.kerf?raw";
import ownFeatures from "../demos/samples/own-features.kerf?raw";
import topology from "../demos/samples/topology.kerf?raw";

/** What a step's check can see of the app. */
export interface LearnState {
  source: string;
  model: Model | null;
  report: CheckReport | null;
  /** parameter values in base units (mm, degrees, g), by name */
  params: Record<string, number | string | boolean>;
  view: { dockTab: string; dockOpen: boolean; leftTab: string; selected: string[]; xray: boolean; section: boolean; explode: number };
  /** the centre shows the drawings */
  drawings: boolean;
  /** the sketch being edited, or "" while a plane is being picked, or null */
  sketch: string | null;
  /** each analysis run by its name: idle, waiting, running, done or error */
  analyses: Record<string, string>;
  /** versions Claude made since the lesson started */
  claudeVersions: number;
  scripts: { count: number; onChange: number; done: string[] };
}

export interface LessonStep {
  title: string;
  /** what to do, and why; `code` in backticks */
  body: string;
  /** the element to point at (a CSS selector) */
  target?: string;
  /** done when this is true; a step without one moves on with Next */
  done?: (s: LearnState) => boolean;
  /** what Show me does besides pointing: opens the panel the step is about */
  show?: string;
  /** a step that writes code can do it for you: the source with this step's change */
  apply?: (source: string) => string;
}

export interface Lesson {
  id: string;
  kind: "tutorial" | "sample";
  name: string;
  /** one line for the card */
  about: string;
  minutes: number;
  /** the design it starts from */
  source: string;
  /** the Kerf features it shows, as short tags */
  shows: string[];
  /** steps that need Claude: without a key the lesson says so first */
  needsKey?: boolean;
  /** asks suggested in the chat while it is open */
  prompts: string[];
  steps: LessonStep[];
}

/** the design's own name in its source, so the project is named after the lesson */
const named = (src: string, name: string) => (/^\s*design\s+"[^"]*"/m.test(src) ? src.replace(/^(\s*design\s+)"[^"]*"/m, `$1"${name}"`) : `design "${name}"\n${src}`);
const tab = (s: LearnState, id: string) => s.view.dockOpen && s.view.dockTab === id;
const num = (s: LearnState, name: string) => (typeof s.params[name] === "number" ? (s.params[name] as number) : NaN);
const madeParts = (s: LearnState) => s.model?.parts.filter((p) => p.kind === "part" && !p.imported) ?? [];
const errors = (s: LearnState) => s.model?.diagnostics.some((d) => d.severity === "error") ?? true;
/** insert text after the first line that matches, or at the end */
const after = (src: string, re: RegExp, text: string) => {
  const m = re.exec(src);
  if (!m) return `${src.trimEnd()}\n${text}\n`;
  const end = src.indexOf("\n", m.index + m[0].length);
  return end < 0 ? `${src}\n${text}\n` : `${src.slice(0, end + 1)}${text}\n${src.slice(end + 1)}`;
};
const dockTarget = (id: string) => `.dock-head [data-tab="${id}"]`;

// ---------- tutorials ----------

const BASICS: Lesson = {
  id: "learn-basics",
  kind: "tutorial",
  prompts: ["Make it hold 20 kg with a safety factor of 3", "Add a lip along the front of the arm so things can't slide off", "Make it as light as it can be while it still passes"],
  name: "Kerf in five minutes",
  about: "Turn the model, change a size, see the checks follow, undo, and find the design file underneath it all.",
  minutes: 5,
  source: named(shelf, "Kerf in five minutes"),
  shows: ["start here", "parameters", "checks"],
  steps: [
    {
      title: "Look around",
      body: "This is a wall shelf bracket, printed in PETG. Drag in the 3D view to turn it, right-drag to pan and scroll to zoom. The cube in the corner turns it to a standard view.",
      target: ".vp-cube",
    },
    {
      title: "Open the parameters",
      body: "The sizes that shape the design are its parameters. Open the params tab on the left.",
      target: "#lp-tab-params",
      show: "params",
      done: (s) => s.view.leftTab === "params",
    },
    {
      title: "Make the arm longer",
      body: "Drag `arm_len` to 200 mm or more, or click its number and type 200. The bracket rebuilds and every check runs again.",
      target: '[data-param="arm_len"]',
      show: "params",
      done: (s) => num(s, "arm_len") >= 200,
    },
    {
      title: "See what the checks say",
      body: "Open the checks tab below the model. Each line is a check on the design: fits, printability, the strength analysis and the requirements written in the design. A longer arm bends more, so watch the strength lines.",
      target: dockTarget("checks"),
      show: "checks",
      done: (s) => tab(s, "checks"),
    },
    {
      title: "Undo",
      body: "Press Ctrl+Z (Cmd+Z on a Mac), or the undo arrow at the top, to put the arm back to 150 mm. Every change is a version you can go back to; the history tab on the left lists them.",
      target: '[aria-label="Undo"]',
      done: (s) => Math.abs(num(s, "arm_len") - 150) < 0.01,
    },
    {
      title: "Find the design file",
      body: "Everything you just did edited one text file, design.kerf. Press C, or click design.kerf at the end of the tab row, to read it: the parameters at the top, then the part, its screws and the analysis.",
      target: dockTarget("code"),
      show: "code",
      done: (s) => tab(s, "code"),
    },
    {
      title: "Make it yours",
      body: "Change anything: a size in the parameters, a line in the file, or ask Claude in the chat on the right. Export at the top right saves STL, STEP, drawings and more.",
      target: ".tb-export",
    },
  ],
};

const FIRST_PART: Lesson = {
  id: "learn-first-part",
  kind: "tutorial",
  prompts: ["Add a slot for a cable tie between the holes", "Countersink the holes for M4 flat-head screws", "Turn this plate into a wall hook"],
  name: "Your first part, in the design file",
  about: "Write a part from scratch: a plate, a size you can change, holes, rounded edges, a material and a requirement.",
  minutes: 8,
  source: `design "My first part"\n`,
  shows: ["design file", "holes", "requirements"],
  steps: [
    {
      title: "Open the design file",
      body: "A Kerf design is a short text file. Press C, or click design.kerf at the end of the tab row below the model.",
      target: dockTarget("code"),
      show: "code",
      done: (s) => tab(s, "code"),
    },
    {
      title: "Add a part",
      body: "Under the design line, type:\n`part plate {`\n`  body box(80, 50, 6)`\n`}`\nA plate 80 × 50 × 6 mm appears. Sizes are millimetres unless you say otherwise.",
      done: (s) => madeParts(s).length > 0 && !errors(s),
      apply: (src) => `${src.trimEnd()}\n\npart plate {\n  body box(80, 50, 6)\n}\n`,
    },
    {
      title: "Name a size",
      body: "Above the part, add `param width = 80mm`, then use it in the box: `box(width, 50, 6)`. Now width is a slider in the params tab.",
      done: (s) => typeof s.params.width === "number" && /box\(\s*width\b/.test(s.source) && !errors(s),
      apply: (src) => after(src, /^design .*$/m, "\nparam width = 80mm range 40 .. 160 \"Plate width\"").replace(/box\(\s*80\s*,/, "box(width,"),
    },
    {
      title: "Drill two holes",
      body: "Inside the part, after the body, add holes for M4 screws, through the plate at each end:\n`for x in [-width / 2 + 10, width / 2 - 10] { cut hole(M4, through: true, at: (x, 0, 6)) }`",
      done: (s) => /cut\s+hole\(/.test(s.source) && !errors(s),
      apply: (src) => after(src, /^\s*body box\(width.*$/m, "  for x in [-width / 2 + 10, width / 2 - 10] { cut hole(M4, through: true, at: (x, 0, 6)) }"),
    },
    {
      title: "Round the corners",
      body: "Give the box rounded corners with `r:`: `body box(width, 50, 6, r: 6)`. Then round its top edges with a fillet on the line after it: `fillet(1, edges: \"top\")`.",
      done: (s) => /fillet\(/.test(s.source) && !errors(s),
      apply: (src) => after(src.replace(/box\(width, 50, 6\)/, "box(width, 50, 6, r: 6)"), /^\s*body box\(width.*$/m, '  fillet(1, edges: "top")'),
    },
    {
      title: "Pick a material",
      body: "Add `material: \"PETG\"` as the first line inside the part. The parts list, mass and every check now use PETG; the make tab says how to print it.",
      // a part without one is printed in the default material, so the check is for the line itself
      done: (s) => /^\s*material:\s*"[^"]+"/m.test(s.source) && madeParts(s).length > 0 && !errors(s),
      apply: (src) => after(src, /^part plate \{$/m, '  material: "PETG"'),
    },
    {
      title: "Write a requirement",
      body: "At the end of the file add `require \"Lighter than 40 g\": mass(plate) < 40g`. It joins the checks, and it is checked again after every change: make the plate wider and watch it.",
      done: (s) => !!s.report?.items.some((i) => i.category === "requirement" && /lighter than 40/i.test(i.title)),
      apply: (src) => `${src.trimEnd()}\n\nrequire "Lighter than 40 g": mass(plate) < 40g\n`,
    },
    {
      title: "That's a part",
      body: "Body, holes, rounds, a material and a check of your own: most designs grow from these. Next, sketch a profile by hand, or ask Claude to build on this.",
    },
  ],
};

const SKETCH: Lesson = {
  id: "learn-sketch",
  kind: "tutorial",
  prompts: ["Turn my sketch into a part with two mounting holes", "Revolve a knob profile instead of extruding", "Explain the sketch's lines in design.kerf"],
  name: "Sketch and extrude by hand",
  about: "Model without writing code: sketch an outline on a plane, give it sizes, and make it a solid.",
  minutes: 6,
  source: `design "Sketched part"\n`,
  shows: ["sketches", "dimensions", "extrude"],
  steps: [
    {
      title: "Start a sketch",
      body: "Click Sketch in the toolbar above the model.",
      target: '[aria-label="Sketch"]',
      show: "sketch",
      done: (s) => s.sketch !== null || (s.model?.sketches.length ?? 0) > 0,
    },
    {
      title: "Pick a plane",
      body: "Click the plane to draw on: the floor (XY) is a good start.",
      done: (s) => !!s.sketch || (s.model?.sketches.length ?? 0) > 0,
    },
    {
      title: "Draw an outline",
      body: "Pick the rectangle on the tool palette at the left (or press R), click one corner and then the other. Any closed outline works: lines that meet, a circle, a slot.",
      target: ".sk-tools",
      done: (s) => !!s.model?.sketches.some((k) => k.profile.regions.length > 0),
    },
    {
      title: "Give it a size",
      body: "Pick the dimension tool (D), click an edge, and type a length such as 60. Sizes make a sketch exact; the header says how many ways it can still move.",
      target: ".sk-tools",
      done: (s) => !!s.model?.sketches.some((k) => k.constraints.some((c) => c.value !== undefined)),
    },
    {
      title: "Make it solid",
      body: "Click Make solid in the sketch's header, pick Extrude, give it a depth such as 10 mm and create it. Then click Done.",
      target: ".sk-header",
      done: (s) => !!s.model?.sketches.some((k) => k.usedBy.length > 0),
    },
    {
      title: "Change the sketch, change the part",
      body: "Click the part, then the sketch it is built from to edit it again: drag a size and the solid follows. The sketch and the extrude are lines in design.kerf too.",
    },
  ],
};

const STRENGTH: Lesson = {
  id: "learn-strength",
  kind: "tutorial",
  prompts: ["Make it hold 25 kg with a safety factor of 3, as light as it can be", "Why is the stress highest where the gusset meets the arm?", "Try it in PA-CF and tell me what changes"],
  name: "Is it strong enough?",
  about: "Read a strength analysis: stress, how far it bends and the safety factor, then load it up and make it stronger.",
  minutes: 6,
  source: named(shelf, "Is it strong enough"),
  shows: ["strength analysis", "safety factor"],
  steps: [
    {
      title: "Open the analysis tab",
      body: "The bracket has a strength analysis, Shelf load, written in its design: where it is held, what pushes on it and what it must survive. Open the analysis tab.",
      target: dockTarget("analysis"),
      show: "analysis",
      done: (s) => tab(s, "analysis"),
    },
    {
      title: "Let it solve",
      body: "It runs by itself after each change, in a few seconds. When it is done the model shows the stress in colour: red works hardest, blue hardly at all.",
      done: (s) => s.analyses["Shelf load"] === "done",
    },
    {
      title: "Read the numbers",
      body: "The safety factor is how many times the load it could take before the plastic gives. The design asks for 2.5, and for no more than 1 mm of bending at the tip.",
    },
    {
      title: "Load it up",
      body: "In the params tab, put `load_kg` up to 25 or more. It solves again; watch the safety factor fall and the strength checks change.",
      target: '[data-param="load_kg"]',
      show: "params",
      done: (s) => num(s, "load_kg") >= 25 && s.analyses["Shelf load"] === "done",
    },
    {
      title: "Make it stronger",
      body: "Thicken it: put `t` (the plate and arm thickness) up to 11 mm or `gusset_t` up to 9. Thicker sections bend less, and the analysis says by how much.",
      target: '[data-param="t"]',
      show: "params",
      done: (s) => (num(s, "t") >= 11 || num(s, "gusset_t") >= 9) && s.analyses["Shelf load"] === "done",
    },
    {
      title: "Check it",
      body: "Open the checks tab: the strength lines say whether it passes now. The analysis tab also tries drops, shaking, heat and airflow; Add analysis lists them.",
      target: dockTarget("checks"),
      show: "checks",
      done: (s) => tab(s, "checks"),
    },
  ],
};

const MAKE: Lesson = {
  id: "learn-make",
  kind: "tutorial",
  prompts: ["Price the parts list for 10 of these", "Make the lid print without supports", "Add a drawing of the lid with its hole sizes"],
  name: "From design to parts",
  about: "The parts list with prices, how each part is made, drawings for the workshop, and the files to send.",
  minutes: 5,
  source: named(enclosure, "From design to parts"),
  shows: ["parts list", "make", "drawings"],
  steps: [
    {
      title: "The parts list",
      body: "Open the parts list tab: every part to make and every part to buy (screws, inserts, the board), with quantities, prices and where to buy them.",
      target: dockTarget("bom"),
      show: "bom",
      done: (s) => tab(s, "bom"),
    },
    {
      title: "How each part is made",
      body: "Open the make tab: each printed part on its printer with its settings, time and cost, and what the process rules found.",
      target: dockTarget("make"),
      show: "make",
      done: (s) => tab(s, "make"),
    },
    {
      title: "Drawings",
      body: "Click Drawings at the top left of the model: views, sizes and the parts table on a sheet, drawn from the design and updated when it changes.",
      target: ".dwg-switch",
      done: (s) => s.drawings,
    },
    {
      title: "Back to 3D",
      body: "Click 3D next to Drawings to come back to the model.",
      target: ".dwg-switch",
      done: (s) => !s.drawings,
    },
    {
      title: "Files to send",
      body: "Export at the top right has them all: STL or 3MF for the printer, STEP for any other CAD tool, PDF drawings, the parts list and a build pack with everything at once.",
      target: ".tb-export",
    },
  ],
};

const SCRIPTS: Lesson = {
  id: "learn-scripts",
  kind: "tutorial",
  prompts: ["Write a script that tables mass and safety factor for arm lengths from 100 to 250 mm", "Add a check of my own: the bracket must fit in a 160 mm cube", "Write a script that exports an STL of every part"],
  name: "Automate it with a script",
  about: "JavaScript on the design: try a size at many values without changing it, and checks of your own after each change.",
  minutes: 5,
  source: named(shelf, "Automate it"),
  shows: ["scripts", "automation", "own checks"],
  steps: [
    {
      title: "Open the scripts tab",
      body: "Press Ctrl+K, type scripts and press Enter. Scripts work the design through the kerf API, in a sandbox of their own.",
      show: "scripts",
      target: dockTarget("scripts"),
      done: (s) => tab(s, "scripts"),
    },
    {
      title: "Try an example",
      body: "Mass and size by a parameter is open. Click Try it: it builds the bracket at five arm lengths without changing yours, and tables the mass, size and failing checks.",
      target: ".kscripts-main .btn.primary",
      done: (s) => s.scripts.done.includes("example:sweep"),
    },
    {
      title: "Keep a script of your own",
      body: "Pick My own checks under Examples and click Use: it is now one of this design's scripts, saved with it, to change as you like.",
      target: ".kscripts-list",
      done: (s) => s.scripts.count > 0,
    },
    {
      title: "Run it after each change",
      body: "Turn on After each change. Its kerf.check results join the design's checks and run again whenever the design changes.",
      target: ".kscripts-auto",
      done: (s) => s.scripts.onChange > 0,
    },
    {
      title: "See your checks",
      body: "Open the checks tab: Lighter than 500 g and Fits a 256 mm printer bed are there with the design's own. Make the arm longer and they run again.",
      target: dockTarget("checks"),
      show: "checks",
      done: (s) => tab(s, "checks") && !!s.report?.items.some((i) => i.id.startsWith("script:")),
    },
  ],
};

const CLAUDE: Lesson = {
  id: "learn-claude",
  kind: "tutorial",
  prompts: ["Add a lip along the front of the arm so the shelf can't slide off", "Make it lighter without letting the safety factor drop below 2.5", "Why does the arm bend most at the tip?"],
  name: "Design with Claude",
  about: "Describe what you want and Claude models it, checks it and tells you what it found; you steer and undo.",
  minutes: 5,
  source: named(shelf, "Design with Claude"),
  shows: ["Claude", "chat", "versions"],
  needsKey: true,
  steps: [
    {
      title: "Ask for a change",
      body: "In the chat on the right, ask for something, for example: Add a lip along the front of the arm so the shelf can't slide off. Claude edits the design, builds it and runs the checks before it answers.",
      target: "#chat-input",
      done: (s) => s.claudeVersions > 0,
    },
    {
      title: "See what changed",
      body: "The change card in the chat shows the lines Claude changed and what the checks said. Open the history tab on the left: Claude's change is a version like yours.",
      target: "#lp-tab-history",
      show: "history",
      done: (s) => s.view.leftTab === "history",
    },
    {
      title: "Steer it",
      body: "Say what you'd like different (thicker, lighter, another material) or undo it with Ctrl+Z. Claude reads the checks, so asking it to fix a failing one works well.",
    },
  ],
};

export const TUTORIALS: Lesson[] = [BASICS, FIRST_PART, SKETCH, STRENGTH, MAKE, SCRIPTS, CLAUDE];

// ---------- feature samples ----------

interface SampleDef {
  id: string;
  name: string;
  about: string;
  source: string;
  shows: string[];
  steps: LessonStep[];
}

const SAMPLE_DEFS: SampleDef[] = [
  {
    id: "sample-weldment",
    name: "Welding table frame",
    about: "A frame of 40 × 40 box section trimmed where members meet, with its cut list, analysed as beams.",
    source: weldment,
    shows: ["frames", "cut list", "beams"],
    steps: [
      { title: "The frame", body: "The members and their joints are drawn from one frame block: a box of 40 × 40 × 2 section with a shelf rail round the bottom, trimmed where they meet." },
      { title: "The cut list", body: "Open the parts list tab: under the parts, the cut list gives each member's length, its end cuts and the bars to buy.", target: dockTarget("bom"), show: "bom", done: (s) => tab(s, "bom") },
      { title: "Analysed as beams", body: "Open the analysis tab: Table load solves the frame as beams in a blink, with each member's stress drawn on it.", target: dockTarget("analysis"), show: "analysis", done: (s) => tab(s, "analysis") },
      { title: "Resize it", body: "Drag width or height in the params tab and the frame, its joints and its cut list follow.", target: "#lp-tab-params", show: "params" },
    ],
  },
  {
    id: "sample-cnc",
    name: "CNC motor plate",
    about: "An aluminium plate milled with a 6 mm and a 3 mm end mill: toolpaths, the cut played on the stock, and G-code.",
    source: cnc,
    shows: ["CNC", "toolpaths", "G-code"],
    steps: [
      { title: "Plan the toolpaths", body: "Show me opens CNC toolpaths (or Ctrl+K, CNC toolpaths). It plans facing, roughing, finishing and rest passes in about two seconds.", show: "cam" },
      { title: "Watch it cut", body: "Press Space to play the cut on the stock and scrub the slider; then Save G-code for GRBL, LinuxCNC or Mach." },
    ],
  },
  {
    id: "sample-nesting",
    name: "Flat-pack shelf on sheets",
    about: "Plywood parts nested on 800 × 600 sheets for a CO2 laser, and steel plates on a fibre laser sheet of their own.",
    source: nesting,
    shows: ["laser cutting", "nesting", "DXF"],
    steps: [
      { title: "Nest the parts", body: "Show me opens Laser, plasma or waterjet sheets (or Ctrl+K, laser). Each material gets sheets of its own with the kerf allowed for.", show: "sheets" },
      { title: "Watch the cut and save it", body: "Press Space to watch the cut; save DXF, SVG or G-code for the cutter." },
    ],
  },
  {
    id: "sample-sheet-metal",
    name: "Vented sheet metal enclosure",
    about: "One aluminium sheet bent into an enclosure, with hemmed and rolled edges, ten louvres and a cable hole.",
    source: sheetEnclosure,
    shows: ["sheet metal", "hems", "louvres"],
    steps: [
      { title: "Hems and louvres", body: "Turn the model to see the louvres under the floor and on the back wall, and the hemmed and rolled edges." },
      { title: "Cut it open", body: "Press S for a section view: it cuts across the hems and the louvres' hoods.", done: (s) => s.view.section },
      { title: "Made from one sheet", body: "Open the make tab: one 1.2 mm sheet, two hems and ten louvres, each checked against the bending rules.", target: dockTarget("make"), show: "make", done: (s) => tab(s, "make") },
    ],
  },
  {
    id: "sample-split",
    name: "Monitor riser split to print",
    about: "A 560 mm riser cut into pieces that fit a 256 mm bed, lined up on steel dowels.",
    source: split,
    shows: ["split for printing", "dowels"],
    steps: [
      { title: "Three pieces", body: "The riser is too long for the printer, so it is split in three, with a seam at each cut." },
      { title: "See the dowels", body: "Press X for X-ray to see the steel dowels that line the pieces up across each cut.", done: (s) => s.view.xray },
      { title: "Each piece prints", body: "Open the make tab: each piece fits the printer and prints upside down, so the tunnel needs no support.", target: dockTarget("make"), show: "make", done: (s) => tab(s, "make") },
    ],
  },
  {
    id: "sample-shaking",
    name: "Bracket on a shaker table",
    about: "A sensor bracket swept from 10 to 500 Hz at 2 g: its response, its mode shapes and its fatigue life.",
    source: shaking,
    shows: ["vibration", "sine sweep", "fatigue"],
    steps: [
      { title: "Shake it", body: "Open the analysis tab: Shaker table solves in about ten seconds.", target: dockTarget("analysis"), show: "analysis", done: (s) => tab(s, "analysis") },
      { title: "Read the sweep", body: "The response peaks at the first mode, near 220 Hz; the mode shapes play on the model, and its fatigue life is given for two hours of shaking." },
    ],
  },
  {
    id: "sample-plies",
    name: "Carbon seatpost ply book",
    about: "A carbon seatpost laid up ply by ply, with extra plies at the clamps, each ply checked by Tsai–Wu.",
    source: plies,
    shows: ["composite plies", "Tsai–Wu"],
    steps: [
      { title: "The ply book", body: "Open the make tab: the laminate line opens the ply book, ply by ply from the outside in.", target: dockTarget("make"), show: "make", done: (s) => tab(s, "make") },
      { title: "Every ply checked", body: "Open the analysis tab: Rider load checks every ply and names the weakest.", target: dockTarget("analysis"), show: "analysis", done: (s) => tab(s, "analysis") },
    ],
  },
  {
    id: "sample-configurations",
    name: "Drawer organiser in three sizes",
    about: "One design, three configurations: Small, Medium and Large, each built and checked.",
    source: configs,
    shows: ["configurations", "design table"],
    steps: [
      { title: "Switch sizes", body: "Open the params tab and click Small, Medium or Large above the parameters: the tray resizes. Each chip's dot says whether that size passes its checks.", target: "#lp-tab-params", show: "params", done: (s) => s.view.leftTab === "params" },
    ],
  },
  {
    id: "sample-mates",
    name: "Hinged box",
    about: "A printed box whose lid swings on two knuckle hinges with steel pins: drag it and it moves as it would.",
    source: mates,
    shows: ["mates", "joints", "drag"],
    steps: [
      { title: "Swing the lid", body: "Click the lid to select it, then drag it up: it swings round the hinge and stops at 110°.", done: (s) => s.view.selected.length > 0 },
      { title: "Keep or put back", body: "Let go to look. Keep here writes the pose into the design, Put back returns it, and Esc while dragging cancels." },
    ],
  },
  {
    id: "sample-fillets",
    name: "Rounds that change along an edge",
    about: "A fillet growing from 2 to 10 mm along a rib's root, the rib's top fully rounded, and an uneven chamfer.",
    source: fillets,
    shows: ["variable fillets", "full rounds", "chamfers"],
    steps: [
      { title: "Look along the rib", body: "Turn the model to look along the rib: its root fillet widens toward the front." },
      { title: "Each round's sizes", body: "Open the features tab on the left: each round's sizes are there to type over.", target: "#lp-tab-features", show: "features", done: (s) => s.view.leftTab === "features" },
    ],
  },
  {
    id: "sample-own-features",
    name: "Case with its own features",
    about: "Four screw bosses from the design's own boss() feature, and a wall thickness from a function.",
    source: ownFeatures,
    shows: ["own features", "functions"],
    steps: [
      { title: "One feature, four times", body: "Open the features tab: the case's steps show boss four times, each with its own fields.", target: "#lp-tab-features", show: "features", done: (s) => s.view.leftTab === "features" },
      { title: "Change it once", body: "Press C for design.kerf and change `d: 8` to `d: 12` in the feature line: all four bosses grow.", target: dockTarget("code"), show: "code", done: (s) => tab(s, "code") },
    ],
  },
  {
    id: "sample-topology",
    name: "Lighter post bracket",
    about: "A bracket carrying 20 kg, cut down to 35 % of its material by topology optimisation.",
    source: topology,
    shows: ["topology optimisation", "lightweighting"],
    steps: [
      { title: "Find the shape", body: "Open the analysis tab and click Find the shape on Lighter. The shape forms on the model as it solves, in about a minute.", target: dockTarget("analysis"), show: "analysis", done: (s) => tab(s, "analysis") },
      { title: "Use it", body: "DXF profile saves the outline for a waterjet, or redraw the bracket around it." },
    ],
  },
];

export const SAMPLES: Lesson[] = SAMPLE_DEFS.map((d) => ({
  ...d,
  kind: "sample" as const,
  minutes: 2,
  prompts: [`Explain how this design's ${d.shows[0]} is written, a line at a time`, "What would you change to make it cheaper to make?", "Change it to suit my own use, and say what you changed"],
}));

export const LESSONS: Lesson[] = [...TUTORIALS, ...SAMPLES];

export const lessonById = (id: string | undefined) => LESSONS.find((l) => l.id === id);

/** The tutorial after this one, for the last step's button. */
export function nextTutorial(id: string): Lesson | undefined {
  const at = TUTORIALS.findIndex((t) => t.id === id);
  return at >= 0 ? TUTORIALS[at + 1] : undefined;
}
