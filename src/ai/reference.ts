// The Kerf language reference given to Claude, generated from the same
// builtin tables the evaluator uses so it cannot drift from the code.

import { SHAPE_FNS, MATH_FNS, modifierDocs, GEO_FNS } from "../lang/builtins";
import { FEATURE_FNS, PATH_FNS, PROFILE_FNS, SELECT_FNS, SOLID_FNS } from "../lang/modelling";
import { SEL_PRESETS } from "../kernel/recipe";
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
  const docs = (fns: Record<string, { doc?: string; name: string }>, skip: string[] = []) =>
    Object.entries(fns)
      .filter(([k]) => !skip.includes(k))
      .map(([, f]) => `- ${f.doc ?? f.name}`)
      .join("\n");
  // revolve() is listed once, with both forms, among the profile solids
  const shapes = docs(SHAPE_FNS, ["revolve"]);
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

Operators: + - * / ^, comparisons == != < <= > >=, && || !, cond ? a : b. Vectors add, subtract and scale. Lists and ranges work with for.

## Part blocks
part bracket {
  color: #4f7cff
  material: "PETG"            // one of ${materials}
  group: "Housing"            // groups parts in the structure tree
  body box(40, 20, 5, r: 2) as plate      // first solid, named so its edges can be picked
  add cylinder(d: 10, h: 12, at: (0, 0, 5)) as boss
  fillet(1.5, edges: boss.root)           // round where the boss meets the plate
  cut hole(M4, through: true, at: (12, 0, 5))
  for x in [-12, 12] { cut hole(M3, depth: 6, at: (x, 0, 5)) }
  if wall > 2 { add box(4, 4, 4) } else { add box(3, 3, 3) }
  cosmetic { chamfer(0.4, edges: boss.tip) }   // full-quality detail only
}
Part props: color, material, group, label, at (translate the finished part), rotate ((rx, ry, rz) degrees), turns_with (moves with a component or part), spin (driver ratio), axis and axis_at (rotation axis for spin). Flags: locked, hidden, removable (removable parts such as lids or covers are ignored by the tool-access check, meaning "removed for assembly").
Order matters: each modifier applies to the body as built so far. Shell right after the body (before bosses, ribs and holes). Fillet a joint right after adding the feature it rounds (fillet(r, edges: boss.root)); fillet outer edges before cutting holes that cross them. A part is limited to 600 operations.

### Shape functions (use after body/add/cut/intersect)
${shapes}

### Modifiers (inside a part)
${mods}

## Detailed modelling

### 2D profiles (flat outlines; combine with + and -, move(p, by:), rotate(p, angle))
${docs(PROFILE_FNS)}

### 3D paths (for sweep and pipe)
${docs(PATH_FNS)}

### Solids from profiles, threads, grips, lettering, ribs
${docs(SOLID_FNS)}

### Ready-made features (use with add; each adds and cuts what it needs and rounds its own root)
${docs(FEATURE_FNS)}

### Naming features and picking edges
Name any step with \`as\`: \`body box(80, 50, 30) as shell\`, \`add cylinder(d: 8, h: 10, at: p) as boss\`, \`cut hole(M3, through: true) as bore\`. Using the same name again (for example inside a for loop) adds to the same feature. A name then picks geometry by meaning, however the part changes later:
- boss.root: edges where the feature meets the rest of the part (fillet these for strength)
- boss.tip: sharp edges between two faces of the feature itself (the top rim of a boss)
- boss.edges / boss.faces: all of its edges or faces; boss.convex / boss.concave: only outside or inside corners
Presets: ${SEL_PRESETS.map((p) => `"${p}"`).join(", ")} ("convex" = sharp outside edges, "concave" = sharp inside corners, "sharp" = both; top/bottom = at the part's highest/lowest z).
Selector functions (coordinates are the part's own, before its at:/rotate:):
${docs(SELECT_FNS)}
Combine: a list or + takes everything in either, - removes, both(a, b) keeps the overlap. Example: fillet(0.6, edges: shell.convex - shell.root).
Use inspect_part to see a part's features and to test a selector before you rely on it.

### Cosmetic detail
cosmetic { ... } holds steps that only build in the full-quality pass (final meshes, renders, STEP export): small chamfers, edge breaks, lettering, decorative grooves. Fast builds (previews, interference and clearance checks, measurements) skip them, and if one fails it is left out with a warning instead of breaking the part. Threads and knurls are always detailed in the full-quality pass and plain cylinders in fast builds. A step outside cosmetic must not refer to a feature named inside it.

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
