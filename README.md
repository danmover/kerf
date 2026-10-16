# Kerf

Mechanical CAD where Claude does the modelling and you direct the design.

You describe a part or a mechanism, give the dimensions and constraints that matter, and Claude writes it as a parametric design. Kerf builds exact solids with OpenCASCADE, checks them for fit, interference, screw access, gear meshing and motion, and shows you the result. You can then ask for changes, drag parameter sliders, or edit the design file by hand. All three edit the same source, with full version history and undo.

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
npm test             # 29 unit tests: language, gears, conflict solver, edits, imports
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

**Sketches**
- Constrained 2D sketches on the XY, XZ or YZ plane, an offset or custom plane, or a flat face of a part (pencil button in the viewport, or the Sketches list under the parts).
- Draw lines, rectangles, circles, arcs, slots and points. Snapping to points, midpoints, curves and the axes adds the matching relation, and nearly horizontal or vertical lines become exactly so. Type a length, `w,h` or a diameter while drawing for an exact size.
- Click geometry to get the relations and dimensions that fit it (with keyboard shortcuts), plus construction, delete and "Ask Claude". Dimensions are edited in place, accept formulas such as `base_len - 2 * wall`, and can be scrubbed by dragging their label.
- Drag points and curves while the solver keeps every constraint holding. Free points show which way they can still move, the header counts the remaining degrees of freedom, and a conflicting constraint is named with a one-click fix.
- Fillets and chamfers on profile corners, and references to an earlier sketch's geometry (`side.l3.end`) so one profile follows another.
- Make solid: extrude (new part, add to or cut from an existing one, through all, either or both directions, depth kept as a slider parameter) or revolve about a sketch line.
- Every action is a text edit of the design file, so undo, history and Claude all work on sketches too. Claude can read a sketch as solved with `get_sketch`.

**Checking**
- Every change runs the full pipeline: evaluate, build (only the parts that changed), check, then refine the meshes.
- Checks cover requirements, solid interference, tool access to every screw, gear mesh and ratio, and motion.
- When a change breaks a requirement, the conflict solver proposes the smallest parameter changes that fix it. You can hold parameters fixed, and it tells you when no fix exists.

**Working in the app**
- 3D viewport with selection, section view, exploded view, x-ray, isolate, mechanism playback and camera presets.
- Code editor with highlighting, autocomplete and inline errors. Clicking a part jumps to its code.
- Parameter panel with live-preview sliders, a structure tree, version history with diffs and restore, a dependency graph and a parts list.
- Projects save automatically in the browser. You can rename, duplicate, delete, import and back them up.
- Exports: STEP (exact), STL (whole model or selection), PNG, bill of materials CSV, the design source and a project file with history.
- First-run setup, settings, keyboard shortcuts (press `?`), and draft Terms, Privacy and Acceptable use pages.

Three complete examples ship with it: a sensor-hub enclosure (21 solids), a two-stage 12:1 gear reducer (26 solids) and a shaft support bracket built entirely from five constrained sketches. All pass every check. Each comes with suggested prompts for a substantial revision.

## Not in 0.1

- **Direct modelling.** Push and pull on faces, and sketching on curved faces, are not there yet; profiles come from sketches on flat planes.
- **Parallel generation.** One Claude conversation designs the whole assembly, and one kernel worker builds it. Parallel sub-agents per subassembly and a multi-worker kernel are the next step for large assemblies.
- **Engineering analysis.** No stress, deflection or thermal analysis, and no tolerance stack-ups. The checks are geometric.
- **Drawings and measurement.** No 2D drawings or interactive measuring tool yet.
- **Importing geometry.** STEP or STL files cannot be brought in as references.
- **Accounts and sharing.** No server, sign-in, sync or collaboration. A hosted version would need a server-side key proxy, rate limits and billing.
- A larger hardware library, a light theme, and a layout for phones and tablets.

## How it works

```
src/lang/       Kerf language: lexer, parser, evaluator (no eval, step-limited)
src/sketch/     Sketch evaluation, constraint solver, profiles, and the text edits the sketch editor makes
src/library/    Standard parts, thread and bearing tables, involute gears
src/kernel/     OpenCASCADE (WebAssembly) in a Web Worker; content-hashed build cache
src/core/       Pipeline (engine), checks, conflict solver (separate worker), source edits
src/ai/         Claude tools, system prompt, language reference, chat loop
src/app/        Projects and history, settings, view state, exports
src/persist/    IndexedDB storage, encrypted key vault, import and export formats
src/ui/         Viewport (three.js), sketch editor, code editor (CodeMirror), panels, chat, dialogs
src/screens/    Onboarding, projects, workspace, legal pages
src/demos/      The example designs
tests/          Vitest unit tests
```

The design file is the single source of truth. Chat, sliders, the editor, restore and undo all produce a new version of that text. Parts are identified by a hash of their geometry recipe. A change rebuilds only parts whose recipe changed, and identical parts (eight inserts, four screws) are built once and instanced.

## Security

- **No server.** Designs, history, chats and settings stay in the browser (IndexedDB and localStorage). Chat messages go straight from the browser to `api.anthropic.com`.
- **API key.** By default the key is held in memory only. If you choose "Remember on this device", it is encrypted with a non-exportable AES-GCM key generated by the browser before it is stored. It never appears in logs or error messages, and it is never written to the repository.
- **Content Security Policy.** The page can load only its own files and connect only to itself and `api.anthropic.com`, with no `eval`. The OpenCASCADE worker is the only code allowed `eval` (its Emscripten bindings need it), and its own policy gives it no network access beyond Kerf's files. Framing, plugins, forms and base-URL changes are blocked.
- **Untrusted input.** AI output is rendered as React elements, never as HTML. Design files run in a purpose-built interpreter with a step limit. Imports are size-limited and schema-validated. CSV exports neutralise spreadsheet formulas.
- `npm audit` reports no known vulnerabilities.

## Legal

The Terms of Service, Privacy notice and Acceptable use policy in the app are **drafts that need legal review before launch**. They are marked as drafts on every page.

Kerf uses Open CASCADE Technology (LGPL 2.1 with the OCCT exception) through `replicad-opencascadejs`, loaded as a separate, replaceable WebAssembly module. The other dependencies are MIT-licensed, and the IBM Plex fonts use the SIL Open Font License. See the in-app Open-source licences page.
