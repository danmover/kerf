// The Kerf language reference given to Claude, generated from the same
// builtin tables the evaluator uses so it cannot drift from the code.

import { SHAPE_FNS, MATH_FNS, modifierDocs, GEO_FNS } from "../lang/builtins";
import { LIBRARY } from "../library/components";
import { THREADS, BEARINGS, MATERIALS } from "../library/standards";

const geoDocs: Record<string, string> = {
  min_distance: "min_distance(a, b) — smallest gap in mm between the built solids of two parts or components (0 when touching). Resolved by the kernel after the build.",
  volume: "volume(a) — solid volume in mm³.",
  mass: "mass(a) — mass in grams from volume and material density.",
  bbox_min: 'bbox_min(a, "x"|"y"|"z") — lowest world coordinate of the built solid.',
  bbox_max: 'bbox_max(a, "x"|"y"|"z") — highest world coordinate.',
  size: 'size(a, "x"|"y"|"z") — overall extent along an axis.',
};

export function languageReference(): string {
  const shapes = Object.values(SHAPE_FNS)
    .map((f) => `- ${f.doc ?? f.name}`)
    .join("\n");
  const math = Object.values(MATH_FNS)
    .map((f) => `- ${f.doc ?? f.name}`)
    .join("\n");
  const mods = Object.values(modifierDocs)
    .map((d) => `- ${d}`)
    .join("\n");
  const geo = GEO_FNS.map((g) => `- ${geoDocs[g] ?? g}`).join("\n");
  const lib = Object.entries(LIBRARY)
    .map(([k, e]) => `### lib.${k}\n${e.signature}\n${e.doc}`)
    .join("\n\n");
  const threads = Object.entries(THREADS)
    .map(([k, t]) => `${k}: d ${t.d}, clearance ${t.clearance}, close ${t.close}, tap ${t.tap}, head_d ${t.head_d}, head_h ${t.head_h}, key_size ${t.key}, nut_af ${t.nut_af}, nut_h ${t.nut_h}, insert_d ${t.insert_d}, insert_l ${t.insert_l}`)
    .join("\n");
  const bearings = Object.entries(BEARINGS)
    .map(([k, b]) => `${k} (${b.bore}×${b.od}×${b.width})`)
    .join(", ");
  const materials = Object.keys(MATERIALS).map((m) => `"${m}"`).join(", ");

  return `# Kerf design language (.kerf)

A design is one text file. It is the single source of truth: the app evaluates it, builds exact B-rep solids with OpenCASCADE, runs checks and renders the result. Every manual edit and every AI edit is an edit to this text.

Units: millimetres and degrees. Literals may carry units (2cm, 0.5in, 1.5rad) which convert to mm/deg. World axes: X right, Y back, Z up. Constants X, Y, Z are unit vectors; ORIGIN is (0, 0, 0). Points are (x, y) or (x, y, z) with fields .x .y .z. Lists use [a, b, c] and index with [i] (0-based). Comments: // and /* */. Colors: #4f7cff.

## Statements (top level, evaluated in order; a name must be defined before it is used)
design "Name"
note "Free text shown to the user"
param name = expr [range lo .. hi] ["description"] [locked]   // tunable inputs; locked means the user froze it
let name = expr                                              // derived values: layout skeleton, positions, lists of points
interface name { field = expr, ... }                          // named contract between parts (screw size, boss size); read as name.field
component name = lib.kind(args) { props and flags }           // standard parts from the library
part name { props, body/add/cut/intersect shapes, modifiers, for/if/let }   // custom solid
require "Label" [hard|soft]: condition                         // checked every rebuild; hard by default
decision name "Title" { ask, chose, by, why, option ... }      // a recorded design choice and its alternatives (below)

Operators: + - * / ^, comparisons == != < <= > >=, && || !, cond ? a : b. Vectors add, subtract and scale. Lists and ranges work with for.

## Part blocks
part bracket {
  color: #4f7cff
  material: "PETG"            // one of ${materials}
  group: "Housing"            // groups parts in the structure tree
  body box(40, 20, 5)         // first solid
  add cylinder(d: 10, h: 12, at: (0, 0, 5))
  cut hole(M4, through: true, at: (12, 0, 5))
  fillet(1, edges: "vertical")
  for x in [-12, 12] { cut hole(M3, depth: 6, at: (x, 0, 5)) }
  if wall > 2 { add box(4, 4, 4) } else { add box(3, 3, 3) }
}
Part props: color, material, group, label, at (translate the finished part), rotate ((rx, ry, rz) degrees), turns_with (moves with a component or part), spin (driver ratio), axis and axis_at (rotation axis for spin). Flags: locked, hidden, removable (removable parts such as lids or covers are ignored by the tool-access check, meaning "removed for assembly").
Order matters: shell/fillet/chamfer apply to the body built so far, so put them right after the body and before bosses and holes. A part is limited to 600 operations.

### Shape functions (use after body/add/cut/intersect)
${shapes}

### Modifiers (inside a part)
${mods}

### Math and helpers
${math}

### Geometric quantities (only inside require; resolved after the build)
${geo}

## Components
component name = lib.kind(args) { at: point, axis: dir, ... }
Props: at (a point, or a LIST of points to make a pattern of identical instances: name#1..n; use name.all[i] or name.count), axis (orientation for axial parts), facing (horizontal direction for connectors), rotate, spin (drives the mechanism: spin: 1), mesh (gears: mesh with another spur_gear; the phase and speed are computed so teeth interleave), turns_with (locks to another component's rotation, e.g. a gear on a motor shaft), color, group, material, label. Flags: locked, hidden, removable.
Component fields are world-space after placement (motor.holes is a list of world points). Moving components get .speed (rotation ratio relative to the driver). Pattern components expose fields of the first instance plus .all and .count; shape fields (like usb.opening) become lists so \`cut usb.opening\` works.

${lib}

## Standard data
Threads (use M3 etc. directly as values: M3.clearance, M3.tap, M3.head_d, or pass M3 to hole() and lib.screw()):
${threads}
Bearings for lib.bearing(code): ${bearings}

## Decisions
A decision block records a design choice: what was asked, the alternatives, which was chosen, by whom and why. It does not change geometry; the parameters do. The app lists decisions in a Decisions panel where the user can preview another option live, switch to it in one click, or fine-tune the chosen values.
decision lid_fastening "Lid fastening" {
  ask: "How should the lid attach?"            // optional: the question as it was put
  chose: "M3 screws into inserts"              // the label of the chosen option
  by: "claude"                                 // "you" (the user) or "claude"
  why: "Re-openable many times without wearing the plastic."
  option "M3 screws into inserts" "Strong and re-openable; adds four inserts and screws."
  option "Snap fit" "No hardware, but the clips wear after a few dozen openings."
}
decision wall_thickness "Wall thickness" {
  chose: "2.0 mm"
  by: "claude"
  why: "Five perimeters at 0.4 mm: stiff enough for a hand-held box."
  option "1.6 mm" { wall: 1.6mm } "Lighter and faster to print; flexes more."
  option "2.0 mm" { wall: 2mm } "Balanced."
  option "2.4 mm" { wall: 2.4mm } "Stiffer and heavier."
}
An option's { param: value } list names parameters only; switching to that option writes those values into the params. Options without values are structural (switching them needs a design change). The chosen option's values should match the params; the panel shows any difference as "adjusted".

## Checks the app runs automatically
- every require statement (hard fails block "valid"; soft fails warn), with margins
- exact solid interference between every pair of nearby parts (OpenCASCADE booleans); parts of one multi-solid component are not checked against each other; gears are checked by tooth geometry instead
- tool access: a hex-key cylinder from every screw head outward must not hit non-removable parts
- swept envelopes of rotating gears against static parts
- gear meshing: same module, exact centre distance, face overlap, and tooth clearance through a rotation
- build errors (a modelling step the kernel could not perform)
Hard parametric requirements also feed a feasibility solver: when they cannot all hold, it searches the unlocked parameters for the smallest changes that satisfy every hard requirement.
Things geometry cannot prove (strength, torque, heat, tolerances on a real printer) are reported as "needs analysis".
`;
}
