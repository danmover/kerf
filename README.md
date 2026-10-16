# Kerf

Mechanical CAD where Claude does the modelling and you direct the design.

You describe a part or a mechanism, give the dimensions and constraints that matter, and Claude writes it as a parametric design. Kerf builds exact solids with OpenCASCADE, checks them for fit, interference, screw access, gear meshing and motion, and shows you the result. You can then ask for changes, scrub parameter values, or edit the design file by hand. All three edit the same source, with full version history and undo.

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
npm test             # unit tests for every part of the app
npm run typecheck
```

## What you can do in 0.1

**Design with Claude**
- Chat in the right panel with your own API key (Opus 5.5, Sonnet 5.5 or Haiku 5.5, with an effort setting).
- Claude reads the design, edits it, reruns the checks, looks at rendered views of the model, and asks you when a choice is yours to make, as a card with options.
- Claude shows its plan as a live to-do tree above the chat and keeps it current as it works, with a pill in the 3D view for the step it is on. While it works you can rename, annotate, skip, reorder or add steps, or ask it to stop after one for your review. Your changes reach Claude after its current action, or at once with Apply now.
- Each Claude turn ends with a summary bar showing what changed, with Review and one-click Revert.
- Talk instead of typing: tap the mic (or press `V`) and say the change. Speech is turned into text on your device when the browser can; the browser's online speech service is used only if you allow it. You can review the words before sending, or have them sent when you stop talking.
- On a phone, the workspace shows the 3D view on top and the chat below, with Model and Code & checks one tap away.
- Locked parameters and parts are protected: Claude's edits to them are refused unless you asked for that change.

**The brief**
- Every design can start from a brief: what it is for, where and how it is used, priorities, temperatures and exposure, process, material, quantity, size and mass limits, the fixed sizes of things it meets (givens), references and assumptions. It lives in the Brief tab and in a `brief { }` block at the top of the design file, so it has history and undo like everything else.
- Each use links to the requirements that check it (`require "Grips the tube" for hold_tube: ...`). The brief turns into checks: uses no requirement covers, materials against the temperature range, sunlight, wet and impact exposure, printed parts against the build volume, and the whole design against its size and mass limits. Loads are listed as needing strength analysis.
- Claude records the brief before it models, marks what it assumed for you to confirm, uses the givens by name, and updates the design when you change the brief.
- Attach photos, screenshots, PDF drawings or a quick sketch in the chat or the Brief tab. They are kept with the project as references, Claude reads them and notes the dimensions it finds, and they travel in project files.

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
- Kerf's own renderer on WebGL: soft area-light shadows, ambient occlusion, clean anti-aliased edges and gentle bloom that refine when the view is still. Five studio lighting presets, a turnable key light (Alt-drag), and draft/balanced/high quality.
- Realistic materials and finishes (printed layer lines, brushed and machined metal, anodizing, carbon weave, wood grain, clear plastics). Pick them from a material picker that previews on the model as you hover, or write `material:` and `finish:` in the design.
- Animations: parts sweep in when built, dissolve and re-form when they change, spring apart when exploded, assemble in order, and turn on a turntable (T). The camera glides between views.
- Code editor with highlighting, autocomplete and inline errors. Clicking a part jumps to its code.
- A model panel with three tabs. Parts lists every part grouped as the design groups it, says what each one is, and follows the viewport selection. Params lists the driving values under the design's own section headings: drag a value sideways to scrub it, click to type, or open it for a slider, the parts it moves and the checks it feeds. History shows every version with who made it, a diff, a 3D preview and one-click restore.
- A dependency graph and a parts list in the bottom dock.
- Projects save automatically in the browser. You can rename, duplicate, delete, import and back them up.
- Exports: STEP (exact), STL (whole model or selection), PNG, bill of materials CSV, the design source and a project file with history.
- First-run setup, settings, keyboard shortcuts (press `?`), and draft Terms, Privacy and Acceptable use pages.

Four complete examples ship with it: a sensor-hub enclosure (21 solids), a two-stage 12:1 gear reducer (26 solids), a sand tunnelling robot (90 solids) and a 3D printer (96 solids). All pass every hard check. The enclosure, the reducer and the tunneller carry a brief. The enclosure's brief flags a real problem as a soft warning: its USB-C port sits 9.4 mm behind the outside wall, too deep for a standard plug to seat. Each comes with suggested prompts for a substantial revision.

## Complete machines from a brief

Type what the machine has to do, for example "a drill powered by an Arduino that drives forwards and turns, and gets through a 2 m long sand pit along the bottom, under 5 m of sand". Claude designs the whole machine, not just the shape:

- **Real parts.** A catalog of purchasable parts with their dimensions, pins and ratings: Arduino and ESP32 boards, motor and stepper drivers, goBILDA gearmotors, NEMA 17 steppers, actuators, batteries, power supplies, regulators, fuses, connectors, sensors, hot ends, heated beds, extrusions, rails, lead screws, pulleys and seals. Each part links to where to buy it. With web search on (Settings → Claude), Claude checks current prices and stock with the Claude API's web search and web fetch, and cites the pages.
- **Sizing calculations.** `calc.` functions Claude and you can call from the design: soil pressure in a sand box or pit (Janssen), screw burrowing torque and thrust, motor operating point, battery runtime, screw conveying, hinge steering moment, actuator force through a cam slot, stepper axis torque and speed, lead screw drive, heater warm-up, print speed, wire gauge and bearing life. Each shows its inputs, method, assumptions and how far to trust it, and requirements can use the results.
- **Wiring.** `wire` and `net` statements connect component pins. An electrical rules check catches wrong voltages, overloaded pins and supplies, missing grounds, motors on logic pins, encoders on non-interrupt pins and undersized wire.
- **Firmware.** A `firmware` block generates an Arduino sketch whose pin map comes from the wiring (with a serial console to test every motor and sensor, and an autonomous run mode for the tunneller), or a Klipper `printer.cfg` for 3D printer boards.
- **Build pack.** The Build tab says whether the machine is ready to order and build, then downloads a zip: STL files oriented for printing, STEP, the parts list with buy links and prices, a cut list, a wiring diagram and wire list, the firmware, the calculations, the check results, an assembly order and a test plan.
- **Honest about what is proven.** Geometry, wiring and the arithmetic are checked by Kerf. Anything that depends on the real world (how sand behaves, how a print holds up, motor heating) is marked as an estimate and goes in the test plan with what to measure and what counts as a pass.

The numbers in the request go into the design's brief, and the sizing reads them from there. The tunneller's brief holds the pit as givens (`pit_l = 2m`, `pit_depth = 5m`, and `pit_w = 0.5m`, confirmed by dan) and ties each requirement to a use with `for`: cross, steer and reserve. Change a given and the checks show what has to change. For example, in a 1 m wide pit the walls carry less of the sand. The motors then run above half their stall torque and the battery no longer covers two crossings, so those three checks fail until the design changes.

`src/machine/briefs.ts` holds a benchmark of briefs, each with what a complete answer must contain, and a scorer that reports what a design is missing. A brief that gives numbers also requires them to be written into the design's brief, with a requirement for every use. The tunneller answers both drill briefs completely.

## Not in 0.1

- **Sketch and direct modelling tools.** Manual editing today is through parameters and the design file, not 2D sketches with constraints or push and pull on faces.
- **Parallel generation.** One Claude conversation designs the whole assembly, and one kernel worker builds it. Parallel sub-agents per subassembly and a multi-worker kernel are the next step for large assemblies.
- **Engineering analysis.** No stress, deflection or thermal analysis, and no tolerance stack-ups. The checks are geometric, plus the sizing calculations for machines.
- **Drawings and measurement.** No 2D drawings or interactive measuring tool yet.
- **Importing geometry.** STEP or STL files cannot be brought in as references.
- **Accounts and sharing.** No server, sign-in, sync or collaboration. A hosted version would need a server-side key proxy, rate limits and billing.
- A larger hardware library, a light theme, and a tablet layout. The phone layout covers the 3D view, chat, model panel, code and settings.

## How it works

```
src/lang/       Kerf language: lexer, parser, evaluator (no eval, step-limited)
src/library/    Standard parts, thread and bearing tables, involute gears
src/kernel/     OpenCASCADE (WebAssembly) in a Web Worker; content-hashed build cache
src/core/       Pipeline (engine), checks, conflict solver (separate worker), source edits
src/machine/    Parts catalog, calculators, wiring rules, firmware generators, build pack
src/ai/         Claude tools, system prompt, language reference, chat loop, web search
src/app/        Projects, history and previews, settings, view state, spots, exports
src/persist/    IndexedDB storage, encrypted key vault, import and export formats
src/ui/         Viewport (three.js and Kerf's render pipeline in ui/viewport/render), editor (CodeMirror), panels, chat, dialogs
src/screens/    Onboarding, projects, workspace, legal pages
src/demos/      The example designs
tests/          Vitest unit tests
```

The design file is the single source of truth. Chat, sliders, the editor, decisions, restore and undo all produce a new version of that text. A preview shows a temporary version in 3D without recording it; any edit made during a preview adopts it. Parts are identified by a hash of their geometry recipe. A change rebuilds only parts whose recipe changed, and identical parts (eight inserts, four screws) are built once and instanced.

## Security

- **No server.** Designs, history, chats, reference files and settings stay in the browser (IndexedDB and localStorage). Chat messages go straight from the browser to `api.anthropic.com`.
- **API key.** By default the key is held in memory only. If you choose "Remember on this device", it is encrypted with a non-exportable AES-GCM key generated by the browser before it is stored. It never appears in logs or error messages, and it is never written to the repository.
- **Voice input.** The microphone is allowed only on Kerf's own page (`Permissions-Policy: microphone=(self)`) and only while you are talking. Kerf uses the browser's speech recognition and never records or uploads audio itself. It prefers on-device recognition; the browser's online speech service (Google, Apple or Microsoft) is used only after you allow it, because the page's CSP cannot govern the browser's own services.
- **Content Security Policy.** The page can load only its own files and connect only to itself and `api.anthropic.com`, with no `eval`. The OpenCASCADE worker is the only code allowed `eval` (its Emscripten bindings need it), and its own policy gives it no network access beyond Kerf's files. Framing, plugins, forms and base-URL changes are blocked.
- **Untrusted input.** AI output is rendered as React elements, never as HTML. Design files run in a purpose-built interpreter with a step limit. Imports are size-limited and schema-validated. CSV exports neutralise spreadsheet formulas.
- `npm audit` reports no known vulnerabilities.

## Legal

The Terms of Service, Privacy notice and Acceptable use policy in the app are **drafts that need legal review before launch**. They are marked as drafts on every page.

Kerf uses Open CASCADE Technology (LGPL 2.1 with the OCCT exception) through `replicad-opencascadejs`, loaded as a separate, replaceable WebAssembly module. The other dependencies are MIT-licensed, and the IBM Plex fonts use the SIL Open Font License. See the in-app Open-source licences page.
