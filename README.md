# Kerf

Mechanical CAD where Claude does the modelling and you direct the design.

You describe a part or a mechanism, give the dimensions and constraints that matter, and Claude writes it as a parametric design. Kerf builds exact solids with OpenCASCADE, checks them for fit, interference, screw access, gear meshing, motion and strength, and shows you the result. You can then ask for changes, drag parameter sliders, or edit the design file by hand. All three edit the same source, with full version history and undo.

This is version 0.1, a working prototype: every screen and button works, and it runs entirely in the browser.

## Run it

You need Node 20.19 or newer.

```bash
npm install
npm run dev          # http://localhost:5173
```

For a production build served with the same security headers it will have when deployed:

```bash
npm run build
npm run preview      # http://localhost:4173
```

The build in `dist/` is a static site. Any static host works. `public/_headers` sets the security headers on Netlify and Cloudflare Pages; on other hosts, copy those headers into the host's config.

Chatting with Claude needs an Anthropic API key from the [Claude Console](https://platform.claude.com/). Kerf asks for it during first-run setup, or later under Settings → Claude. Everything else works without a key.

### Checks

```bash
npm test             # 59 unit tests: language, gears, conflict solver, edits, imports, stress solver, drivetrain checks
npm run typecheck
```

## What you can do in 0.1

**Design with Claude**
- Chat in the right panel with your own API key (Opus 5.5, Sonnet 5.5 or Haiku 5.5, with an effort setting).
- Claude reads the design, edits it, reruns the checks, looks at rendered views of the model, and asks you when a choice is yours to make, as a card with options.
- Each Claude turn ends with a summary bar showing what changed, with Review and one-click Revert.
- Locked parameters and parts are protected: Claude's edits to them are refused unless you asked for that change.

**The design itself**
- One design file in the Kerf language: parameters with units, ranges and locks, derived values, interfaces, library components, custom parts built from solids with add, cut and intersect, loops, and requirements.
- Requirements can be numeric (`require "Board fits": inner_w - pcb.w >= 2`) or measured on the real geometry (`min_distance(pcb, lid) >= 2`).
- Standard hardware library: ISO 4762 screws, nuts and heat-set inserts (M2 to M6), deep-groove bearings (623 to 6801), involute spur gears, a NEMA 17 stepper, a PCB, a USB-C connector, generic connectors and dowels.

**Checking**
- Every change runs the full pipeline: evaluate, build (only the parts that changed), check, then refine the meshes.
- Checks cover requirements, solid interference, tool access to every screw, gear mesh and ratio, and motion.
- When a change breaks a requirement, the conflict solver proposes the smallest parameter changes that fix it. You can hold parameters fixed, and it tells you when no fix exists.

**Strength analysis**
- An `analysis` block in the design says how parts are held (`fix: face(bracket, -Y)`, bolt-hole zones, rollers) and what loads them (forces, pressures, torques, gravity). After every change Kerf re-runs it in a background worker and adds strength and stiffness checks.
- Results: von Mises stress, principal strain, deflection and factor of safety against yield, fatigue (with `cycles:`) or the weaker bond between print layers (with `printed` and `build:`). A peak sitting right on an idealised support is flagged, with the value a short way off.
- The viewport colours the model by any of those fields, shows the deformed shape (exaggerated, animated, or true scale) over a ghost of the original, with load arrows, support markers and hot spots. Hover the model to read the value under the cursor.
- The strength tab shows the key numbers, the set-up as solved (with support reactions), accuracy notes and the solver's convergence. "Run fine" re-runs at about 110,000 elements.
- Gear trains get a drivetrain block (`drive:`, `torque:`, `speed:`, `life:`) that checks tooth bending (Lewis), bearing L10 life and shaft torsion for every gear and bearing the driver turns.
- Claude sets analyses up from the part's intended use, runs them, looks at the results, strengthens weak spots and reports before-and-after numbers.

**Working in the app**
- 3D viewport with selection, section view, exploded view, x-ray, isolate, mechanism playback and camera presets.
- Code editor with highlighting, autocomplete and inline errors. Clicking a part jumps to its code.
- Parameter panel with live-preview sliders, a structure tree, version history with diffs and restore, a dependency graph and a parts list.
- Projects save automatically in the browser. You can rename, duplicate, delete, import and back them up.
- Exports: STEP (exact), STL (whole model or selection), PNG, bill of materials CSV, the design source and a project file with history.
- First-run setup, settings, keyboard shortcuts (press `?`), and draft Terms, Privacy and Acceptable use pages.

Three complete examples ship with it: a sensor-hub enclosure (21 solids), a printed wall-shelf bracket with a stress analysis (3 solids), and a two-stage 12:1 gear reducer with a drivetrain duty (26 solids). All pass every check. Each comes with suggested prompts for a substantial revision.

## Not in 0.1

- **Sketch and direct modelling tools.** Manual editing today is through parameters and the design file, not 2D sketches with constraints or push and pull on faces.
- **Parallel generation.** One Claude conversation designs the whole assembly, and one kernel worker builds it. Parallel sub-agents per subassembly and a multi-worker kernel are the next step for large assemblies.
- **More analysis.** The stress solver is linear elastic on a voxel grid: no contact between parts, buckling, large deflection, creep, vibration or thermal analysis, and features smaller than a grid cell are smoothed over. Drivetrain checks leave out tooth pitting, wear and heat. There are no tolerance stack-ups yet. Treat results as a design guide and test parts that matter.
- **Drawings and measurement.** No 2D drawings or interactive measuring tool yet.
- **Importing geometry.** STEP or STL files cannot be brought in as references.
- **Accounts and sharing.** No server, sign-in, sync or collaboration. A hosted version would need a server-side key proxy, rate limits and billing.
- A larger hardware library, a light theme, and a layout for phones and tablets.

## How it works

```
src/lang/       Kerf language: lexer, parser, evaluator (no eval, step-limited)
src/library/    Standard parts, thread and bearing tables, involute gears
src/kernel/     OpenCASCADE (WebAssembly) in a Web Worker; content-hashed build cache
src/core/       Pipeline (engine), checks, conflict solver (separate worker), source edits
src/analysis/   Stress solver (voxel hex8 FEA, multigrid CG, separate worker), drivetrain checks, analysis blocks
src/ai/         Claude tools, system prompt, language reference, chat loop
src/app/        Projects and history, settings, view state, exports
src/persist/    IndexedDB storage, encrypted key vault, import and export formats
src/ui/         Viewport (three.js), editor (CodeMirror), panels, chat, dialogs
src/screens/    Onboarding, projects, workspace, legal pages
src/demos/      The example designs
tests/          Vitest unit tests
```

The stress solver meshes the parts' surface triangles into a box-fitted voxel grid (8-node hexahedra with incompatible modes, so thin walls bend correctly) and solves with conjugate gradients preconditioned by geometric multigrid. A 30,000-element model solves in about a second. The tests compare it with beam theory: a steel cantilever's tip deflection comes out 0.4 % from the textbook value. The renderer only sees results through a small overlay hook, so the solver and the viewport can change independently.

The design file is the single source of truth. Chat, sliders, the editor, restore and undo all produce a new version of that text. Parts are identified by a hash of their geometry recipe. A change rebuilds only parts whose recipe changed, and identical parts (eight inserts, four screws) are built once and instanced.

## Security

- **No server.** Designs, history, chats and settings stay in the browser (IndexedDB and localStorage). Chat messages go straight from the browser to `api.anthropic.com`.
- **API key.** By default the key is held in memory only. If you choose "Remember on this device", it is encrypted with a non-exportable AES-GCM key generated by the browser before it is stored. It never appears in logs or error messages, and it is never written to the repository.
- **Content Security Policy.** The page can load only its own files and connect only to itself and `api.anthropic.com`, with no `eval`. The OpenCASCADE worker is the only code allowed `eval` (its Emscripten bindings need it), and its own policy gives it no network access beyond Kerf's files. The conflict solver and stress analysis workers get no network access at all. Framing, plugins, forms and base-URL changes are blocked.
- **Untrusted input.** AI output is rendered as React elements, never as HTML. Design files run in a purpose-built interpreter with a step limit. Imports are size-limited and schema-validated. CSV exports neutralise spreadsheet formulas.
- `npm audit` reports no known vulnerabilities.

## Legal

The Terms of Service, Privacy notice and Acceptable use policy in the app are **drafts that need legal review before launch**. They are marked as drafts on every page.

Kerf uses Open CASCADE Technology (LGPL 2.1 with the OCCT exception) through `replicad-opencascadejs`, loaded as a separate, replaceable WebAssembly module. The other dependencies are MIT-licensed, and the IBM Plex fonts use the SIL Open Font License. See the in-app Open-source licences page.
