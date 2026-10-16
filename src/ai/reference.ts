// The Kerf language reference given to Claude, generated from the same
// builtin tables the evaluator uses so it cannot drift from the code.

import { SHAPE_FNS, MATH_FNS, modifierDocs, GEO_FNS } from "../lang/builtins";
import { LIBRARY } from "../library/components";
import { THREADS, BEARINGS, MATERIALS } from "../library/standards";
import { processReference } from "../mfg/guide";
import { FINISHES, MATERIAL_LIST } from "../library/materials";
import { importsReference } from "./importTools";
import { CONSTRAINTS } from "../sketch/evaluate";
import { SKETCH_FNS } from "../sketch/fns";
import { ANALYSIS_FNS } from "../analysis/lang";
import { MECH } from "../analysis/materials";

const geoDocs: Record<string, string> = {
  min_distance: "min_distance(a, b) — smallest gap in mm between the built solids of two parts or components (0 when touching). Resolved by the kernel after the build.",
  volume: "volume(a) — solid volume in mm³.",
  mass: "mass(a) — mass in grams from volume and material density.",
  bbox_min: 'bbox_min(a, "x"|"y"|"z") — lowest world coordinate of the built solid.',
  bbox_max: 'bbox_max(a, "x"|"y"|"z") — highest world coordinate.',
  size: 'size(a, "x"|"y"|"z") — overall extent along an axis.',
};

export function languageReference(): string {
  const shapes = Object.values({ ...SHAPE_FNS, extrude: SKETCH_FNS.extrude, revolve: SKETCH_FNS.revolve })
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
  const materialTable = MATERIAL_LIST.map((m) => `"${m.name}" (${m.density} g/cm³): ${m.note} Finishes: ${m.finishes.map((f) => `"${f}"`).join(", ")} (default "${m.finishes[0]}").`).join("\n");
  const finishTable = Object.values(FINISHES)
    .map((f) => `"${f.id}": ${f.note}`)
    .join("; ");
  const constraints = Object.values(CONSTRAINTS)
    .map((c) => `- ${c.doc}`)
    .join("\n");
  const analysisFns = Object.values(ANALYSIS_FNS)
    .map((f) => `- ${f.doc ?? f.name}`)
    .join("\n");
  const mech = Object.entries(MECH)
    .map(([k, m]) => `${k}: E ${m.E / 1000} GPa, yield ${m.yield} MPa, fatigue ${m.fatigue} MPa${m.layerFactor < 1 ? `, layers ${Math.round(m.layerFactor * 100)} %` : ""}`)
    .join("; ");

  return `# Kerf design language (.kerf)

A design is one text file. It is the single source of truth: the app evaluates it, builds exact B-rep solids with OpenCASCADE, runs checks and renders the result. Every manual edit and every AI edit is an edit to this text.

Units: millimetres and degrees. Literals may carry units (2cm, 0.5in, 1.5rad) which convert to mm/deg; 10N, 2kg, 50g and 40C are also read (forces in N, masses in g, temperatures in °C). World axes: X right, Y back, Z up. Constants X, Y, Z are unit vectors; ORIGIN is (0, 0, 0). Points are (x, y) or (x, y, z) with fields .x .y .z. Lists use [a, b, c] and index with [i] (0-based). Comments: // and /* */. Colors: #4f7cff.

## Statements (top level, evaluated in order; a name must be defined before it is used)
design "Name"
note "Free text shown to the user"
param name = expr [range lo .. hi] ["description"] [locked]   // tunable inputs; locked means the user froze it. The description is the label the user reads in the params panel; a "// ── Title ──" comment above a run of params becomes its heading there
sketch name { plane, geometry, constraints }                  // constrained 2D profile (see Sketches)
let name = expr                                              // derived values: layout skeleton, positions, lists of points
interface name { field = expr, ... }                          // named contract between parts (screw size, boss size); read as name.field
component name = lib.kind(args) { props and flags }           // standard parts from the library
part name { props, body/add/cut/intersect shapes, modifiers, for/if/let }   // custom solid
require "Label" [hard|soft] [for use_id, ...]: condition      // checked every rebuild; hard by default; for links it to brief uses
brief { ... }                                                 // the design brief, once, near the top (see below)
decision name "Title" { ask, chose, by, why, option ... }      // a recorded design choice and its alternatives (below)
analysis "Label" { props }                                     // a strength analysis or drivetrain duty, re-run after every change (see Analysis blocks)

Operators: + - * / ^, comparisons == != < <= > >=, && || !, cond ? a : b. Vectors add, subtract and scale. Lists and ranges work with for.

## The brief
brief {
  purpose: "Hold a 25 mm handlebar light on a bike"
  setting: "Clamped to the handlebar, removed weekly"
  priorities: ["strength", "print time"]
  look: "Matte black, rounded edges" assumed

  temp: -10C .. 45C                      // service temperature in °C, lowest first
  outdoor: true
  exposure: ["sunlight", "rain", "vibration"]

  process: "FDM print"                   // the default process of every part; text, or a value like mfg.fdm(layer: 0.2)
  material: "PETG"
  quantity: 2
  build_volume: (220, 220, 250)          // printer bed, mm; the bed of every printed part

  max_size: (80, 60, 50)                 // the whole design must fit in this box, mm
  max_mass: 60g

  use hold_light "Holds a 150 g light over rough roads" { load: 15N, dir: -Z, on: mount, cycles: 100000 }
  use swap "Comes off without tools" assumed

  given bar_d = 25.4mm "Handlebar diameter, measured"
  given light_w = 32mm "Light body width, read from photo1" assumed

  reference photo1 "Light from the side" { file: "ast_ab12cd", notes: "Mount rail 32 mm wide" }
  reference datasheet "Light manual" { url: "https://example.com/light.pdf" }

  assume "Rider weight is not carried by this part"
  assume "Printed with 4 walls" confirmed
}
A trailing assumed marks what Claude estimated; the user confirms it. Fields: purpose, setting, look (text), priorities, exposure (lists of text), temp (range with C), outdoor (true/false), process (text or an mfg.* process), material (text), quantity (integer), build_volume, max_size (three sizes in mm), max_mass (mass). use id "text" { load (force in N, or a mass in kg or g read as its weight), dir (direction: X, -Z or a vector), on (part or component name), cycles, note }. given name = value ["description"] defines a fixed name the design reads like a locked param (bar_d above). reference id "title" { file (an attached file id), url, notes }. Unknown fields are kept and warned about.
The brief's process is the default for every custom part with no process of its own, unless the part's own material cannot be made that way (a steel shaft in a printed design); parts naming no material take the brief's material. Put process: on a part only where it differs.
Requirements link to uses with for: require "Clamp grips the bar" for hold_light: clamp_gap < bar_d.
Brief checks the app adds: uses no requirement covers, loads that need strength analysis, the material against the temperature range, sunlight, wet and impact exposure, food contact on printed parts, the whole design against max_size and max_mass, and givens nothing uses.

## Part blocks
part bracket {
  color: #4f7cff
  material: "PETG"            // one of ${materials}
  finish: "printed"           // optional surface finish for that material (see Materials and finishes)
  group: "Housing"            // groups parts in the parts panel
  body box(40, 20, 5)         // first solid
  add cylinder(d: 10, h: 12, at: (0, 0, 5))
  cut hole(M4, through: true, at: (12, 0, 5))
  fillet(1, edges: "vertical")
  for x in [-12, 12] { cut hole(M3, depth: 6, at: (x, 0, 5)) }
  if wall > 2 { add box(4, 4, 4) } else { add box(3, 3, 3) }
}
Part props: color, material, finish, process (how it is made, see Manufacturing processes), group, label, at (translate the finished part), rotate ((rx, ry, rz) degrees), turns_with (moves with a component or part), spin (driver ratio), axis and axis_at (rotation axis for spin). Flags: locked, hidden, removable (removable parts such as lids or covers are ignored by the tool-access check, meaning "removed for assembly").
Order matters: shell/fillet/chamfer apply to the body built so far, so put them right after the body and before bosses and holes. A part is limited to 600 operations.

### Shape functions (use after body/add/cut/intersect)
${shapes}

### Modifiers (inside a part)
${mods}

### Math and helpers
${math}

### Geometric quantities (only inside require; resolved after the build)
${geo}

## Sketches
A sketch is a constrained 2D outline on a plane; extrude() or revolve() turns its closed profile into a solid. Users draw and edit sketches by hand in the sketch editor, and those edits change the same text, so write sketches the way a careful CAD user would: fully defined, dimensioned from parameters.
sketch side {
  plane: XZ                    // XY (top, x→X y→Y), XZ (front, x→X y→Z), YZ (right, x→Y y→Z); -XY etc. flips; or ${SKETCH_FNS.plane.doc}
  offset: 5                    // moves the plane along its normal
  line l1 = (0, 0) -> (50, 0)
  arc a1 = l1.end -> (50, 20), center: (50, 10)   // counter-clockwise from start to end; l1.end shares the point, so the outline is connected
  line l2 = a1.end -> (0, 20)
  line l3 = l2.end -> l1.start  // back to the start: a closed loop
  circle c1 = a1.center, d: 8  // or r:; the size is a starting guess until a dimension holds it
  point p = (0, 10)
  construction line centre = p -> a1.center   // guides only, not part of the profile
  coincident l1.start, origin
  horizontal l1, l2
  vertical l3
  tangent l1, a1
  tangent a1, l2
  length l1 = base_len         // dimensions take any expression; params make them sliders
  length l3 = 20
  diameter c1 = 8
  midpoint p, l3
  fillet l3, l1 = 2            // rounds the corner in the profile; dimensions still measure to the sharp corner
}
Every sketch has origin, x_axis and y_axis (fixed). Coordinates are starting guesses: the solver moves points as little as possible to satisfy the constraints, so write them close to the intended shape. Refer to points as l1.start, l1.end, a1.center, c1.center or named points. Geometry of an earlier sketch can be referenced (side.l3.end, side.l3); it is projected onto this sketch's plane as a fixed reference, so this sketch follows it.
Constraints and dimensions (refs are names, the value after = is any expression):
${constraints}
A good sketch is fully defined (0 degrees of freedom): every point is fixed by constraints, usually by dimensions driven from params plus horizontal/vertical/coincident relations and one point tied to the origin. Redundant constraints are warned about; conflicting ones fail and name the culprit. A closed profile is one or more non-crossing loops; inner loops become holes. Sketch values expose .area, .plane, .normal and each named entity in world coordinates (side.l1.mid, side.c1.center), so other statements can position things from a sketch.
Use sketches for profiles that are awkward to build from primitives (bent plates, cams, levers, gussets, custom outlines, turned parts) and whenever the user wants to edit a profile by hand. Primitives are still fine for plain boxes, cylinders and holes.

${processReference()}

## Components
component name = lib.kind(args) { at: point, axis: dir, ... }
Props: at (a point, or a LIST of points to make a pattern of identical instances: name#1..n; use name.all[i] or name.count), axis (orientation for axial parts), facing (horizontal direction for connectors), rotate, spin (drives the mechanism: spin: 1), mesh (gears: mesh with another spur_gear; the phase and speed are computed so teeth interleave), turns_with (locks to another component's rotation, e.g. a gear on a motor shaft), color, group, material, finish, label. Flags: locked, hidden, removable.
Component fields are world-space after placement (motor.holes is a list of world points). Moving components get .speed (rotation ratio relative to the driver). Pattern components expose fields of the first instance plus .all and .count; shape fields (like usb.opening) become lists so \`cut usb.opening\` works.

${lib}

${importsReference()}

## Standard data
Threads (use M3 etc. directly as values: M3.clearance, M3.tap, M3.head_d, or pass M3 to hole() and lib.screw()):
${threads}
Bearings for lib.bearing(code): ${bearings}

## Materials and finishes
material: sets density (mass, the parts list) and how the part renders. finish: sets the surface; leave it out to get the material's default. color: is the base colour (filament, anodizing or paint colour; for bare metals keep a realistic metal grey or the brass/copper tone). Library hardware already has realistic finishes (black-oxide screws, zinc-plated nuts, machined brass inserts).
${materialTable}
Finish meanings: ${finishTable}.

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

## Analysis blocks
A structural analysis says how parts are held and what loads them. After every build the app solves a finite-element model of the named parts (bonded where they touch) and adds strength and stiffness checks.
analysis "Shelf load" {
  parts: [bracket, gusset]                  // optional: defaults to the parts that face() names
  fix: face(bracket, -Y)                    // held in every direction (screwed or glued to the wall)
  fix: zone(at: hole_pos, d: M4.clearance + 2, axis: Z, length: 5)   // a bolt hole: the bore surface
  fix: roller(face(bracket, -Z), Z)         // only stops movement along Z (resting on a surface)
  load: force(face(bracket, +Z), (0, 0, -shelf_kg * 9.81N))   // total force spread over the region
  load: pressure(face(lid, +Z), 0.02MPa)
  load: torque(zone(at: hub_pos, d: 8, axis: Z, length: 6), 0.5Nm, axis: Z)
  gravity                                   // self-weight; or accel: (0, 0, -3) for 3 g
  material: "PETG"                          // optional: overrides the parts' material
  printed                                   // FDM part: layer bonds are weaker; build: Z gives the stacking direction (default Z)
  cycles: 1e5                               // repeated loading: judged against fatigue strength
  safety: 2                                 // required lowest factor of safety (default 2)
  max_deflection: 0.5mm                     // optional stiffness limit
  resolution: "standard"                    // "draft" ~8k elements, "standard" ~30k (default), "fine" ~110k, or a cell size like 0.6mm
}
fix: and load: may repeat or take lists. Units: N, kN, lbf, kgf (weight of a kilogram: 5kgf = 49 N; kg is a mass in grams, so never kg × 9.81N), Nm, Nmm, MPa, kPa, bar, psi, GPa. Inside an analysis block these functions exist:
${analysisFns}
A drivetrain analysis gives a gear train's duty instead; the app checks tooth bending (Lewis), bearing L10 life and shaft torsion for every gear and bearing the driver turns:
analysis "Gearbox duty" {
  drive: motor_gear        // the component that drives the train
  torque: 0.3Nm            // input torque
  speed: 3000rpm           // input speed
  life: 2000h              // required running life (sets fatigue cycles and the bearing life target)
  safety: 1.5
}
Strength data: ${mech}. Parts in PLA, PETG, ABS, ASA or Nylon count as FDM-printed by default; write printed: false for a moulded or machined plastic part.

## Checks the app runs automatically
- every require statement (hard fails block "valid"; soft fails warn), with margins
- exact solid interference between every pair of nearby parts (OpenCASCADE booleans); parts of one multi-solid component are not checked against each other; gears are checked by tooth geometry instead
- tool access: a hex-key cylinder from every screw head outward must not hit non-removable parts
- swept envelopes of rotating gears against static parts
- gear meshing: same module, exact centre distance, face overlap, and tooth clearance through a rotation
- build errors (a modelling step the kernel could not perform)
- every analysis block: structural strength (factor of safety) and stiffness, or the drivetrain's tooth, bearing and shaft checks
- manufacturing: every part with a process: is checked against that process's rules on its exact geometry (walls by ray casting, draft and undercuts along the pull, tool reach per setup, inside corner radii, slots, overhangs and orientation, turning, sheet thickness and bends, flat profiles, holes, voids, machine size), plus whether its material suits the process
Hard parametric requirements also feed a feasibility solver: when they cannot all hold, it searches the unlocked parameters for the smallest changes that satisfy every hard requirement.
Things geometry cannot prove are reported as "needs analysis" until an analysis block covers them; heat and real printer tolerances are not analysed.
`;
}
