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
npm test             # language, gears, conflict solver, edits, imports, machines
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

**Working in the app**
- 3D viewport with selection, section view, exploded view, x-ray, isolate, mechanism playback and camera presets.
- Code editor with highlighting, autocomplete and inline errors. Clicking a part jumps to its code.
- Parameter panel with live-preview sliders, a structure tree, version history with diffs and restore, a dependency graph and a parts list.
- Projects save automatically in the browser. You can rename, duplicate, delete, import and back them up.
- Exports: STEP (exact), STL (whole model or selection), PNG, bill of materials CSV, the design source and a project file with history.
- First-run setup, settings, keyboard shortcuts (press `?`), and draft Terms, Privacy and Acceptable use pages.

Four complete examples ship with it: a sensor-hub enclosure (21 solids), a two-stage 12:1 gear reducer (26 solids), a sand tunnelling robot and a 3D printer. All pass every check. Each comes with suggested prompts for a substantial revision.

## Complete machines from a brief

Type what the machine has to do, for example "a drill powered by an Arduino that drives forwards and turns, and passes through a metre of sand in a 10 m tall box". Claude designs the whole machine, not just the shape:

- **Real parts.** A catalog of purchasable parts with their dimensions, pins and ratings: Arduino and ESP32 boards, motor and stepper drivers, goBILDA gearmotors, NEMA 17 steppers, actuators, batteries, power supplies, regulators, fuses, connectors, sensors, hot ends, heated beds, extrusions, rails, lead screws, pulleys and seals. Each part links to where to buy it. With web search on (Settings → Claude), Claude checks current prices and stock with the Claude API's web search and web fetch, and cites the pages.
- **Sizing calculations.** `calc.` functions Claude and you can call from the design: soil pressure in a sand box (Janssen), screw burrowing torque and thrust, motor operating point, battery runtime, screw conveying, hinge steering moment, actuator force through a cam slot, wire gauge and bearing life. Each shows its inputs, method, assumptions and how far to trust it, and requirements can use the results.
- **Wiring.** `wire` and `net` statements connect component pins. An electrical rules check catches wrong voltages, overloaded pins and supplies, missing grounds, motors on logic pins, encoders on non-interrupt pins and undersized wire.
- **Firmware.** A `firmware` block generates an Arduino sketch whose pin map comes from the wiring (with a serial console to test every motor and sensor, and an autonomous run mode for the tunneller), or a Klipper `printer.cfg` for 3D printer boards.
- **Build pack.** The Build tab says whether the machine is ready to order and build, then downloads a zip: STL files oriented for printing, STEP, the parts list with buy links and prices, a cut list, a wiring diagram and wire list, the firmware, the calculations, the check results, an assembly order and a test plan.
- **Honest about what is proven.** Geometry, wiring and the arithmetic are checked by Kerf. Anything that depends on the real world (how sand behaves, how a print holds up, motor heating) is marked as an estimate and goes in the test plan with what to measure and what counts as a pass.

`src/machine/briefs.ts` holds a benchmark of briefs, each with what a complete answer must contain, and a scorer that reports what a design is missing. The tunneller answers the first brief completely.

## Not in 0.1

- **Sketch and direct modelling tools.** Manual editing today is through parameters and the design file, not 2D sketches with constraints or push and pull on faces.
- **Parallel generation.** One Claude conversation designs the whole assembly, and one kernel worker builds it. Parallel sub-agents per subassembly and a multi-worker kernel are the next step for large assemblies.
- **Engineering analysis.** No stress, deflection or thermal analysis, and no tolerance stack-ups. The checks are geometric, plus the sizing calculations for machines.
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
src/machine/    Parts catalog, calculators, wiring rules, firmware generators, build pack
src/ai/         Claude tools, system prompt, language reference, chat loop, web search
src/app/        Projects and history, settings, view state, exports
src/persist/    IndexedDB storage, encrypted key vault, import and export formats
src/ui/         Viewport (three.js), editor (CodeMirror), panels, chat, dialogs
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
