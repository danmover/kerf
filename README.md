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
- Locked parameters and parts are protected: Claude's edits to them are refused unless you asked for that change.

**Iterating on a design**
- **Decisions you can see and change.** Choices that matter (fastening method, wall thickness, a gear split) are recorded in the design as `decision` blocks with the options, who chose and why. The Decisions tab lists them. Preview any option in 3D, see at once whether it breaks a requirement, switch to it, or drag its values to fine-tune. A manual edit that moves a decided value shows as "adjusted", with Keep and Restore.
- **Questions you can try before answering.** When Claude asks, each option can be previewed in 3D with its checks, its values adjusted, and a note added for Claude. The answer is applied and recorded as a decision.
- **Right-click to talk about a spot.** Right-click the model to open a small chat pinned to that place. Claude gets the part, the point and the face direction. Quick asks ("Make it thicker", "Add a hole here"), the values that shape that part, its decisions and failing checks are all in the same card, and the reply, any question and the change show there too.
- **Draw on the view.** Press `M` (or the pen in the toolbar) to circle, point or scribble on the model and send it with a note. Claude gets the picture and the names of the parts under your marks.
- **See what changed.** Each reply that edits the design gets a change card: a before/after picture you can wipe across, the parts that were added, reshaped, moved or removed (hover to highlight them in 3D), the values Claude set (drag to fine-tune them), a Before/After toggle in 3D, the diff and one-click Revert.
- **Next steps.** Claude can offer two to four follow-ups as one-click chips under its reply.
- **Previews never cost a version.** Previewing an option, an old version from History or the design before Claude's change shows it in 3D with a banner; `Esc` goes back. Hovering a parameter highlights the parts it shapes. A failing check offers "Ask Claude to fix".

**The design itself**
- One design file in the Kerf language: parameters with units, ranges and locks, derived values, interfaces, library components, custom parts built from solids with add, cut and intersect, loops, and requirements.
- Requirements can be numeric (`require "Board fits": inner_w - pcb.w >= 2`) or measured on the real geometry (`min_distance(pcb, lid) >= 2`).
- Standard hardware library: ISO 4762 screws, nuts and heat-set inserts (M2 to M6), deep-groove bearings (623 to 6801), involute spur gears, a NEMA 17 stepper, a PCB, a USB-C connector, generic connectors and dowels.

**Checking**
- Every change runs the full pipeline: evaluate, build (only the parts that changed), check, then refine the meshes.
- Checks cover requirements, solid interference, tool access to every screw, gear mesh and ratio, and motion.
- When a change breaks a requirement, the conflict solver proposes the smallest parameter changes that fix it. You can hold parameters fixed, and it tells you when no fix exists.

**Working in the app**
- 3D viewport with selection, section view, exploded view, x-ray, isolate, mechanism playback and camera presets.
- Code editor with highlighting, autocomplete and inline errors. Clicking a part jumps to its code.
- Parameter panel with live-preview sliders, a structure tree, version history with diffs, previews and restore, a dependency graph and a parts list.
- Projects save automatically in the browser. You can rename, duplicate, delete, import and back them up.
- Exports: STEP (exact), STL (whole model or selection), PNG, bill of materials CSV, the design source and a project file with history.
- First-run setup, settings, keyboard shortcuts (press `?`), and draft Terms, Privacy and Acceptable use pages.

Two complete examples ship with it: a sensor-hub enclosure (21 solids) and a two-stage 12:1 gear reducer (26 solids). Both pass every check. Each comes with suggested prompts for a substantial revision.

## Not in 0.1

- **Sketch and direct modelling tools.** Manual editing today is through parameters and the design file, not 2D sketches with constraints or push and pull on faces.
- **Parallel generation.** One Claude conversation designs the whole assembly, and one kernel worker builds it. Parallel sub-agents per subassembly and a multi-worker kernel are the next step for large assemblies.
- **Engineering analysis.** No stress, deflection or thermal analysis, and no tolerance stack-ups. The checks are geometric.
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
src/ai/         Claude tools, system prompt, language reference, chat loop
src/app/        Projects, history and previews, settings, view state, spots, exports
src/persist/    IndexedDB storage, encrypted key vault, import and export formats
src/ui/         Viewport (three.js), editor (CodeMirror), panels, chat, dialogs
src/screens/    Onboarding, projects, workspace, legal pages
src/demos/      The example designs
tests/          Vitest unit tests
```

The design file is the single source of truth. Chat, sliders, the editor, decisions, restore and undo all produce a new version of that text. A preview shows a temporary version in 3D without recording it; any edit made during a preview adopts it. Parts are identified by a hash of their geometry recipe. A change rebuilds only parts whose recipe changed, and identical parts (eight inserts, four screws) are built once and instanced.

## Security

- **No server.** Designs, history, chats and settings stay in the browser (IndexedDB and localStorage). Chat messages go straight from the browser to `api.anthropic.com`.
- **API key.** By default the key is held in memory only. If you choose "Remember on this device", it is encrypted with a non-exportable AES-GCM key generated by the browser before it is stored. It never appears in logs or error messages, and it is never written to the repository.
- **Content Security Policy.** The page can load only its own files and connect only to itself and `api.anthropic.com`, with no `eval`. The OpenCASCADE worker is the only code allowed `eval` (its Emscripten bindings need it), and its own policy gives it no network access beyond Kerf's files. Framing, plugins, forms and base-URL changes are blocked.
- **Untrusted input.** AI output is rendered as React elements, never as HTML. Design files run in a purpose-built interpreter with a step limit. Imports are size-limited and schema-validated. CSV exports neutralise spreadsheet formulas.
- `npm audit` reports no known vulnerabilities.

## Legal

The Terms of Service, Privacy notice and Acceptable use policy in the app are **drafts that need legal review before launch**. They are marked as drafts on every page.

Kerf uses Open CASCADE Technology (LGPL 2.1 with the OCCT exception) through `replicad-opencascadejs`, loaded as a separate, replaceable WebAssembly module. The other dependencies are MIT-licensed, and the IBM Plex fonts use the SIL Open Font License. See the in-app Open-source licences page.
