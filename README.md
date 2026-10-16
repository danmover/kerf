# Kerf

Mechanical CAD where Claude does the modelling and you direct the design.

You describe a part or a mechanism, give the dimensions and constraints that matter, and Claude writes it as a parametric design. Kerf builds exact solids with OpenCASCADE, checks them for fit, interference, screw access, gear meshing and motion, and shows you the result. You can then ask for changes, drag parameter sliders, or edit the design file by hand. All three edit the same source, with full version history and undo.

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
npm test             # 70 tests: language, gears, conflict solver, edits, imports, and the server
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
- With a Kerf server: an account, sync of projects, history and chats between browsers (offline edits merge when you reconnect, and the other device's version stays in history), the Claude key kept encrypted on the account, a usage chart, signed-in devices, recent security activity, and a download of everything in the account.
- Exports: STEP (exact), STL (whole model or selection), PNG, bill of materials CSV, the design source and a project file with history.
- First-run setup, settings, keyboard shortcuts (press `?`), and draft Terms, Privacy and Acceptable use pages.

Two complete examples ship with it: a sensor-hub enclosure (21 solids) and a two-stage 12:1 gear reducer (26 solids). Both pass every check. Each comes with suggested prompts for a substantial revision.

## Not in 0.1

- **Sketch and direct modelling tools.** Manual editing today is through parameters and the design file, not 2D sketches with constraints or push and pull on faces.
- **Parallel generation.** One Claude conversation designs the whole assembly, and one kernel worker builds it. Parallel sub-agents per subassembly and a multi-worker kernel are the next step for large assemblies.
- **Engineering analysis.** No stress, deflection or thermal analysis, and no tolerance stack-ups. The checks are geometric.
- **Drawings and measurement.** No 2D drawings or interactive measuring tool yet.
- **Importing geometry.** STEP or STL files cannot be brought in as references.
- **Sharing and collaboration.** Accounts sync your own projects between your devices. Sharing a project with someone else, editing together, and billing for a hosted service are not there yet.
- A larger hardware library, a light theme, and a layout for phones and tablets.

## How it works

```
src/lang/       Kerf language: lexer, parser, evaluator (no eval, step-limited)
src/library/    Standard parts, thread and bearing tables, involute gears
src/kernel/     OpenCASCADE (WebAssembly) in a Web Worker; content-hashed build cache
src/core/       Pipeline (engine), checks, conflict solver (separate worker), source edits
src/ai/         Claude tools, system prompt, language reference, chat loop
src/app/        Projects and history, settings, view state, exports
src/persist/    IndexedDB storage, encrypted key vault, import and export formats
src/cloud/      Account state, server API client, project sync
src/ui/         Viewport (three.js), editor (CodeMirror), panels, chat, dialogs
src/screens/    Onboarding, projects, workspace, legal pages
src/demos/      The example designs
tests/          Vitest unit tests
server/         The optional Kerf server (Hono, SQLite): accounts, sync, Claude proxy
```

The design file is the single source of truth. Chat, sliders, the editor, restore and undo all produce a new version of that text. Parts are identified by a hash of their geometry recipe. A change rebuilds only parts whose recipe changed, and identical parts (eight inserts, four screws) are built once and instanced.

## Security

- **No server by default.** Designs, history, chats and settings stay in the browser (IndexedDB and localStorage). Chat messages go straight from the browser to `api.anthropic.com`.
- **With a Kerf server.** Passwords are hashed with scrypt. Sessions are HttpOnly, Secure, SameSite=Strict cookies, and only their hashes are stored. Sign-ins are rate-limited, and requests from other origins are refused. A key saved to an account is encrypted with AES-256-GCM, and the server adds it to Claude requests, so it never returns to a browser. The browser then talks only to its own server. Details are in [server/README.md](server/README.md#security).
- **API key.** By default the key is held in memory only. If you choose "Remember on this device", it is encrypted with a non-exportable AES-GCM key generated by the browser before it is stored. It never appears in logs or error messages, and it is never written to the repository.
- **Content Security Policy.** The page can load only its own files and connect only to itself and `api.anthropic.com`, with no `eval`. The OpenCASCADE worker is the only code allowed `eval` (its Emscripten bindings need it), and its own policy gives it no network access beyond Kerf's files. Framing, plugins, forms and base-URL changes are blocked.
- **Untrusted input.** AI output is rendered as React elements, never as HTML. Design files run in a purpose-built interpreter with a step limit. Imports are size-limited and schema-validated. CSV exports neutralise spreadsheet formulas.
- `npm audit` reports no known vulnerabilities.

## Legal

The Terms of Service, Privacy notice and Acceptable use policy in the app are **drafts that need legal review before launch**. They are marked as drafts on every page.

Kerf uses Open CASCADE Technology (LGPL 2.1 with the OCCT exception) through `replicad-opencascadejs`, loaded as a separate, replaceable WebAssembly module. The other dependencies are MIT-licensed (Nodemailer, in the server, is MIT-0), SQLite is public domain, and the IBM Plex fonts use the SIL Open Font License. See the in-app Open-source licences page.
