# Kerf

Mechanical CAD where Claude does the modelling and you direct the design.

You describe a part or a mechanism, give the dimensions and constraints that matter, and Claude writes it as a parametric design. Kerf builds exact solids with OpenCASCADE, checks them for fit, interference, screw access, gear meshing, motion and strength, and shows you the result. You can then ask for changes, scrub parameter values, or edit the design file by hand. All three edit the same source, with full version history and undo.

This is version 0.1, a working prototype: every screen and button works, and it runs entirely in the browser. An optional Kerf server adds accounts, so projects sync between devices and the Claude key can live on the account instead of in the browser.

## Run it

You need Node 22.13 or newer. The app on its own also runs on Node 20.19; the server and its tests need 22.13.

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

### With accounts

```bash
npm run dev:full     # the app and the Kerf server together, on http://localhost:5173
```

This adds sign-in, project sync and the option to keep the Claude key on your account. In development, account emails are printed in the terminal. To host Kerf with accounts, use the `Dockerfile` (one container serves the app and the server). [server/README.md](server/README.md) covers configuration, deploying to Fly.io or any Docker host, admin commands and backups.

Without the server, nothing changes: the static build works on its own, and Settings → Account says so.

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
- On a phone, the workspace shows the 3D view on top and the chat below, with Model and Overview one tap away. Turn the phone on its side and the 3D view and the panel sit side by side.
- On a tablet held upright, the 3D view runs across the top with the model panel and the chat side by side below it. Held sideways, the model panel folds into a rail of tabs so the 3D view keeps its room; tap a tab to open it. Splitters have finger-sized grips, and pressing and holding the model opens the spot chat.
- Locked parameters and parts are protected: Claude's edits to them are refused unless you asked for that change.

**The brief**
- Every design can start from a brief: what it is for, where and how it is used, priorities, temperatures and exposure, process, material, quantity, size and mass limits, the fixed sizes of things it meets (givens), references and assumptions. It lives in the Brief tab and in a `brief { }` block at the top of the design file, so it has history and undo like everything else.
- Each use links to the requirements that check it (`require "Grips the tube" for hold_tube: ...`). The brief turns into checks: uses no requirement covers, materials against the temperature range, sunlight, wet and impact exposure, printed parts against the build volume, and the whole design against its size and mass limits. Loads are listed as needing strength analysis.
- Claude records the brief before it models, marks what it assumed for you to confirm, uses the givens by name, and updates the design when you change the brief.
- Attach photos, screenshots, PDF drawings or a quick sketch in the chat or the Brief tab. They are kept with the project as references, Claude reads them and notes the dimensions it finds, and they travel in project files.

**Iterating on a design**
- **Decisions you can see and change.** Choices that matter (fastening method, wall thickness, a gear split) are recorded in the design as `decision` blocks with the options, who chose and why. The Decisions tab lists them. Preview any option in 3D, see at once whether it breaks a requirement, switch to it, or drag its values to fine-tune. A manual edit that moves a decided value shows as "adjusted", with Keep and Restore.
- **Questions you can try before answering.** When Claude asks, each option can be previewed in 3D with its checks, its values adjusted, and a note added for Claude. The answer is applied and recorded as a decision.
- **Right-click to talk about a spot.** Right-click the model (or press and hold it on a touch screen) to open a small chat pinned to that place. Claude gets the part, the point and the face direction. Quick asks ("Make it thicker", "Add a hole here"), the values that shape that part, its decisions and failing checks are all in the same card, and the reply, any question and the change show there too.
- **Draw on the view.** Press `M` (or the pen in the toolbar) to circle, point or scribble on the model and send it with a note. Claude gets the picture and the names of the parts under your marks.
- **See what changed.** Each reply that edits the design gets a change card: a before/after picture you can wipe across, the parts that were added, reshaped, moved or removed (hover to highlight them in 3D), the values Claude set (drag to fine-tune them), a Before/After toggle in 3D, the diff and one-click Revert.
- **Next steps.** Claude can offer two to four follow-ups as one-click chips under its reply.
- **Previews never cost a version.** Previewing an option, an old version from History or the design before Claude's change shows it in 3D with a banner; `Esc` goes back. Hovering a parameter highlights the parts it shapes. A failing check offers "Ask Claude to fix".

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

**Detailed modelling**
- 2D profiles (`outline` with arcs and splines, `curve`, `rounded`, `offset`, `text`, and `+`/`-` between them) turned into solids with `extrude` (twist, taper), `revolve`, `sweep`/`pipe` along paths and helices, and `loft` (hollow with `wall:`).
- Real helical threads (`thread()`, ISO, trapezoid, square and buttress, multi-start, left-hand, threaded tubes) and threaded holes (`hole(M5, fit: "thread")`); knurls, draft, embossed and engraved lettering, O-ring grooves, ribs and gussets.
- Ready-made features that size themselves: `screw_boss` (insert, tapped or threaded, with gussets) and `snap_hook`, whose bending strain is checked against the material.
- Name what you add (`add ... as boss`) and round or break edges by meaning: `fillet(1.5, edges: boss.root)`, `both(base.edges, "vertical")`, `near()`, `facing()`. Claude can inspect a part's features and test a selection before using it.
- `cosmetic { }` steps (edge breaks, lettering) and real threads and knurls appear in the detailed build, which runs in a second kernel worker; checks use the simple shape, so editing stays fast. Library screws and nuts show real ISO threads.

**Checking**
- Every change runs the full pipeline: evaluate, build (only the parts that changed), check, then refine the meshes.
- Checks cover requirements, solid interference, tool access to every screw, gear mesh and ratio, and motion.
- When a change breaks a requirement, the conflict solver proposes the smallest parameter changes that fix it. You can hold parameters fixed, and it tells you when no fix exists.
- Each custom part can say how it is made (`process: mfg.cnc_mill(tool_d: 3)`): FDM, SLA or SLS printing, CNC milling or turning, injection moulding, die casting, sheet metal or laser cutting. Kerf checks the part against that process's rules (walls, draft, undercuts, inside corners, tool reach, overhangs, bends), marks the problem faces on the model with a suggested fix, and can rank every process for a part. Claude designs to the chosen process from the start.

**Strength analysis**
- An `analysis` block in the design says how parts are held (`fix: face(bracket, -Y)`, bolt-hole zones, rollers) and what loads them (forces, pressures, torques, gravity). After every change Kerf re-runs it in a background worker and adds strength and stiffness checks.
- Results: von Mises stress, principal strain, deflection and factor of safety against yield, fatigue (with `cycles:`) or the weaker bond between print layers (with `printed` and `build:`). A peak sitting right on an idealised support is flagged, with the value a short way off.
- The viewport colours the model by any of those fields, shows the deformed shape (exaggerated, animated, or true scale) over a ghost of the original, with load arrows, support markers and hot spots. Hover the model to read the value under the cursor.
- The strength tab shows the key numbers, the set-up as solved (with support reactions), accuracy notes and the solver's convergence. "Run fine" re-runs at about 110,000 elements.
- Gear trains get a drivetrain block (`drive:`, `torque:`, `speed:`, `life:`) that checks tooth bending (Lewis), bearing L10 life and shaft torsion for every gear and bearing the driver turns.
- Claude sets analyses up from the part's intended use, runs them, looks at the results, strengthens weak spots and reports before-and-after numbers.

**Drawings and measuring**
- Every part and the assembly get an engineering drawing automatically: first-angle ISO views, a section through the main features, an isometric view, dimensions with hole and slot callouts, general tolerances (ISO 2768), a title block and, for the assembly, balloons and a parts list. Sheet size and scale are chosen to fit.
- Drawings update with the design. Click any dimension, view, part or the title block to change it (a parameter, a tolerance or fit, title fields, hidden lines) or to ask Claude about it. Changes are written into a `drawing` block in the design file, so undo, history and Claude see them, and tolerances stay with their dimension when the design changes.
- Claude can look at a drawing and edit it like the rest of the design.
- Export drawings as PDF (all sheets), SVG or DXF.
- Measure in the 3D view (press `R`): click a face, edge or corner for its exact size, and a second one for the distance, angle and centre distance between them. A measurement can be added to the part's drawing as a dimension.

**Working in the app**
- 3D viewport with selection, section view, exploded view, x-ray, isolate, mechanism playback and camera presets.
- Kerf's own renderer on WebGL: soft area-light shadows, ambient occlusion, clean anti-aliased edges and gentle bloom that refine when the view is still. Five studio lighting presets, a turnable key light (Alt-drag), and draft/balanced/high quality.
- Realistic materials and finishes (printed layer lines, brushed and machined metal, anodizing, carbon weave, wood grain, clear plastics). Pick them from a material picker that previews on the model as you hover, or write `material:` and `finish:` in the design.
- Animations: parts sweep in when built, dissolve and re-form when they change, spring apart when exploded, assemble in order, and turn on a turntable (T). The camera glides between views.
- The bottom panel opens on an overview: whether the design passes its checks and what needs a look, how far it meets its brief, its size, mass, parts and materials, the selected part with a peek at its code, and the latest changes (click one to preview it). The brief, checks, parts list and dependency graph sit next to it.
- design.kerf, the code behind it all, is one click away at the end of the panel's tabs, or press `C` (again to go back). The editor has highlighting, autocomplete and inline errors, and clicking a part jumps to its code.
- A model panel with three tabs. Parts lists every part grouped as the design groups it, says what each one is, and follows the viewport selection. Params lists the driving values under the design's own section headings: drag a value sideways to scrub it, click to type, or open it for a slider, the parts it moves and the checks it feeds. History shows every version with who made it, a diff, a 3D preview and one-click restore.
- Projects save automatically in the browser. You can rename, duplicate, delete, import and back them up.
- With a Kerf server: an account, sync of projects, history, chats, imported STEP files and reference images between browsers (offline edits merge when you reconnect, and the other device's version stays in history), the Claude key kept encrypted on the account, a usage chart, signed-in devices, recent security activity, and a download of everything in the account.
- Export from one panel in the top bar, grouped by what you want to do, with "Again" for the last one and "only the selected parts" where it applies:
  - 3D models: STEP (exact solids), glTF with materials (.glb) for Blender and the web, USDZ to place it in a room with an iPhone, and OBJ with a material library.
  - Printing: a 3MF print plate with every part to make turned to print on a flat face (as the build pack turns them), centred on the bed, in colour, one STL per part in a zip (named with how many to print), or one STL of the assembly.
  - Images: the current view at 1920 × 1200 or 4K, a four-view sheet (iso, front, top, right) with the design's size, mass and check result, or copy the view to paste into a chat or email.
  - Documents: engineering drawings as PDF, a design report (brief, views, checks, driving values and parts list on one page that prints to PDF), the parts list as CSV and, for machines, the build pack.
  - The project file with history, and the design source.
- Dark and light themes. Dark is the default; switch with the sun and moon button or in Settings → Display, where Match device follows your system. In the light theme the lighting presets with a dark set show a pale backdrop instead.
- First-run setup, settings, keyboard shortcuts (press `?`), and draft Terms, Privacy and Acceptable use pages.

Seven complete examples ship with it: a sensor-hub enclosure (21 solids), a printed wall-shelf bracket with a stress analysis (3 solids), a two-stage 12:1 gear reducer with a drivetrain duty (26 solids), a shaft support bracket built entirely from five constrained sketches, a screw-top canister with real, phased two-start threads, a knurled lid and an O-ring seal, a sand tunnelling robot (91 solids) and a 3D printer (96 solids). All pass every hard check, and the enclosure, the reducer, the canister and the tunneller carry a brief. The enclosure's brief flags a real problem as a soft warning: its USB-C port sits 9.4 mm behind the outside wall, too deep for a standard plug to seat. Each comes with suggested prompts for a substantial revision.

## Complete machines from a brief

Type what the machine has to do, for example "a drill powered by an Arduino that drives forwards and turns, and gets through a 2 m long sand pit along the bottom, under 5 m of sand". Claude designs the whole machine, not just the shape:

- **Real parts.** A catalog of purchasable parts with their dimensions, pins and ratings: Arduino and ESP32 boards, motor and stepper drivers, goBILDA gearmotors, NEMA 17 steppers, actuators, batteries, power supplies, regulators, fuses, connectors, sensors, hot ends, heated beds, extrusions, rails, lead screws, pulleys and seals. Each part links to where to buy it. With web search on (Settings → Claude), Claude checks current prices and stock with the Claude API's web search and web fetch, and cites the pages.
- **Sizing calculations.** `calc.` functions Claude and you can call from the design: soil pressure in a sand box or pit (Janssen), screw burrowing torque and thrust, motor operating point, battery runtime, screw conveying, hinge steering moment, actuator force through a cam slot, stepper axis torque and speed, lead screw drive, heater warm-up, print speed, wire gauge and bearing life. Each shows its inputs, method, assumptions and how far to trust it, and requirements can use the results.
- **Wiring.** `wire` and `net` statements connect component pins. An electrical rules check catches wrong voltages, overloaded pins and supplies, missing grounds, motors on logic pins, encoders on non-interrupt pins, and undersized wire. It works out the current in every wire, motor lead and ground return, and checks each fuse (its `rating:`) against the thinnest wire after it.
- **Firmware.** A `firmware` block generates an Arduino sketch whose pin map comes from the wiring (with a serial console to test every motor and sensor, and an autonomous run mode for the tunneller), or a Klipper `printer.cfg` for 3D printer boards.
- **Build pack.** The Build tab says whether the machine is ready to order and build, then downloads a zip: STL files oriented for printing (the way each part's process says it prints, when it says), STEP, the parts list with buy links and prices, a cut list, a wiring diagram and wire list, the firmware, the calculations, the check results, an assembly order and a test plan.
- **Honest about what is proven.** Geometry, wiring and the arithmetic are checked by Kerf. Anything that depends on the real world (how sand behaves, how a print holds up, motor heating) is marked as an estimate and goes in the test plan with what to measure and what counts as a pass.

The numbers in the request go into the design's brief, and the sizing reads them from there. The tunneller's brief holds the pit as givens (`pit_l = 2m`, `pit_depth = 5m`, and `pit_w = 0.5m`, confirmed by dan) and ties each requirement to a use with `for`: cross, steer and reserve. Change a given and the checks show what has to change. For example, in a 1 m wide pit the walls carry less of the sand. The motors then run above half their stall torque, the battery covers neither two crossings nor giving up and backing out, and the push to start it is more than one person can give, so those five checks fail until the design changes.

The Simulation thread runs the generated firmware against the pit. Its first runs led to three changes. The steering sign is now a setting in the firmware block (`steer_sign`). Breakthrough is read from the front motor's current alone. When there is no breakthrough by twice the expected distance or the give-up time, the drill backs out instead of trusting its turn count. The runs also showed that the front screw can't pull the body in from the wall hole alone, so the drill now comes with a push cup for a broom handle, and a check sizes the push needed. The second round found that the G2 drivers' current sense reads 0 V between PWM pulses, which made the readings 20 % low and let the breakthrough reference follow the current down. The firmware now skips those samples and keeps a slow reference that a falling current can't drag down. It also estimates each motor's heating from its current, backing out when the motors get warm without a breakthrough and resting if they get hot. In the simulation, the expected and optimistic runs now stop at breakthrough. The pessimistic run, which can't get past the wall, backs out after about four minutes with the front motor at 74 °C, where before it spun in place for nine minutes and reached 186 °C.

`src/machine/briefs.ts` holds a benchmark of briefs, each with what a complete answer must contain, and a scorer that reports what a design is missing. A brief that gives numbers also requires them to be written into the design's brief, with a requirement for every use. The tunneller answers both drill briefs completely.

## Not in 0.1

- **Direct modelling.** Push and pull on faces, and sketching on curved faces, are not there yet; profiles come from sketches on flat planes.
- **Parallel generation.** One Claude conversation designs the whole assembly, and one kernel worker builds the geometry that checks use (a second one makes the detailed build). Parallel sub-agents per subassembly and a multi-worker kernel are the next step for large assemblies.
- **More analysis.** The stress solver is linear elastic on a voxel grid: no contact between parts, buckling, large deflection, creep, vibration or thermal analysis, and features smaller than a grid cell are smoothed over. Drivetrain checks leave out tooth pitting, wear and heat. There are no tolerance stack-ups yet. The machine sizing calculations are first-pass hand formulas with their assumptions listed. Treat results as a design guide and test parts that matter.
- **Importing geometry.** STEP or STL files cannot be brought in as references.
- **Sharing and collaboration.** Accounts sync your own projects between your devices. Sharing a project with someone else, editing together, and billing for a hosted service are not there yet.
- A larger hardware library.

## How it works

```
src/lang/       Kerf language: lexer, parser, evaluator (no eval, step-limited)
src/sketch/     Sketch evaluation, constraint solver, profiles, and the text edits the sketch editor makes
src/library/    Standard parts, thread and bearing tables, involute gears
src/kernel/     OpenCASCADE (WebAssembly) in Web Workers (fast builds and checks; detailed builds and STEP); content-hashed build cache
src/core/       Pipeline (engine), checks, conflict solver (separate worker), source edits
src/analysis/   Stress solver (voxel hex8 FEA, multigrid CG, separate worker), drivetrain checks, analysis blocks
src/mfg/        Manufacturing processes: rules, materials, geometry analysis, findings
src/drawing/    Engineering drawings: view planning, dimensions, sheet layout, PDF/SVG/DXF
src/machine/    Parts catalog, calculators, wiring rules, firmware generators, build pack
src/ai/         Claude tools, system prompt, language reference, chat loop, web search
src/app/        Projects, history and previews, settings, view state, spots, exports
src/persist/    IndexedDB storage, encrypted key vault, import and export formats
src/cloud/      Account state, server API client, project sync
src/ui/         Viewport (three.js and Kerf's render pipeline in ui/viewport/render), sketch editor, code editor (CodeMirror), panels, chat, dialogs
src/screens/    Onboarding, projects, workspace, legal pages
src/demos/      The example designs
tests/          Vitest unit tests
server/         The optional Kerf server (Hono, SQLite): accounts, sync, Claude proxy
```

Styles name colour tokens rather than colours: the dark theme's are at the top of `src/styles/app.css` and the light theme's in `src/styles/theme.css`. `node scripts/theme-colors.mjs` lists any raw colour left in the CSS, and `--fix` moves the ones that match a token onto it. The workspace picks its layout (phone, tablet upright, tablet sideways or desktop) in `src/app/layout.ts`.

The stress solver meshes the parts' surface triangles into a box-fitted voxel grid (8-node hexahedra with incompatible modes, so thin walls bend correctly) and solves with conjugate gradients preconditioned by geometric multigrid. A 30,000-element model solves in about a second. The tests compare it with beam theory: a steel cantilever's tip deflection comes out 0.4 % from the textbook value. The renderer only sees results through a small overlay hook, so the solver and the viewport can change independently.

The design file is the single source of truth. Chat, sliders, the editor, decisions, restore and undo all produce a new version of that text. A preview shows a temporary version in 3D without recording it; any edit made during a preview adopts it. Parts are identified by a hash of their geometry recipe. A change rebuilds only parts whose recipe changed, and identical parts (eight inserts, four screws) are built once and instanced.

## Security

- **No server by default.** Designs, history, chats, reference files and settings stay in the browser (IndexedDB and localStorage). Chat messages go straight from the browser to `api.anthropic.com`.
- **With a Kerf server.** Passwords are hashed with scrypt. Sessions are HttpOnly, Secure, SameSite=Strict cookies, and only their hashes are stored. Sign-ins are rate-limited, and requests from other origins are refused. A key saved to an account is encrypted with AES-256-GCM, and the server adds it to Claude requests, so it never returns to a browser. The browser then talks only to its own server. Details are in [server/README.md](server/README.md#security).
- **API key.** By default the key is held in memory only. If you choose "Remember on this device", it is encrypted with a non-exportable AES-GCM key generated by the browser before it is stored. It never appears in logs or error messages, and it is never written to the repository.
- **Voice input.** The microphone is allowed only on Kerf's own page (`Permissions-Policy: microphone=(self)`) and only while you are talking. Kerf uses the browser's speech recognition and never records or uploads audio itself. It prefers on-device recognition; the browser's online speech service (Google, Apple or Microsoft) is used only after you allow it, because the page's CSP cannot govern the browser's own services.
- **Content Security Policy.** The page can load only its own files and connect only to itself and `api.anthropic.com`, with no `eval`. The OpenCASCADE worker is the only code allowed `eval` (its Emscripten bindings need it), and its own policy gives it no network access beyond Kerf's files. The conflict solver and stress analysis workers get no network access at all. Framing, plugins, forms and base-URL changes are blocked.
- **Untrusted input.** AI output is rendered as React elements, never as HTML. Design files run in a purpose-built interpreter with a step limit. Imports are size-limited and schema-validated. CSV exports neutralise spreadsheet formulas.
- `npm audit` reports no known vulnerabilities.

## Legal

The Terms of Service, Privacy notice and Acceptable use policy in the app are **drafts that need legal review before launch**. They are marked as drafts on every page.

Kerf uses Open CASCADE Technology (LGPL 2.1 with the OCCT exception) through `replicad-opencascadejs`, loaded as a separate, replaceable WebAssembly module. The other dependencies are MIT-licensed (Nodemailer, in the server, is MIT-0), SQLite is public domain, and the IBM Plex fonts use the SIL Open Font License. See the in-app Open-source licences page.
