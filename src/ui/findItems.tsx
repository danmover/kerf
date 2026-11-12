// Everything the find palette (FindPalette) can find: the panels, views and
// tools, every kind of analysis, the making and machine features, every
// export, the design's own parts and failing checks, the templates and the
// settings. Built fresh each time the palette opens, from what the open
// design has. A feature the design doesn't have yet is still listed: it
// drafts a request for Claude to add it, so the list doubles as a map of
// what Kerf can do.
//
// New panels and exports appear here by themselves (from DOCK_TABS,
// LEFT_TABS and EXPORT_FORMATS); give them other names in TAB_FIND so they
// can be found by the words people use.

import type { ReactNode } from "react";
import type { Findable } from "../app/find";
import { useDesign } from "../core/engine";
import { turns } from "../core/model";
import { useView, requestCamera, select, toggleCode, showGroups, soloGroup, type ViewPreset } from "../app/view";
import { partGroups } from "../app/partGroups";
import { useSettings, updateSettings, LIGHTING_IDS, SPEEDS } from "../app/settings";
import { openSettings, useUi, toast, type SettingsTab } from "../app/ui";
import { undo, redo, closeProject, duplicateProject, flushPending, useProject, createProject, openProject, openBranch, projectBranches } from "../app/project";
import { openBranchNamed, startMerge, startNewBranch } from "./left/Branches";
import { currentTheme, setTheme } from "../app/theme";
import { EXPORT_FORMATS, EXPORT_GROUPS, runExport } from "../app/exportFormats";
import { showConfiguration } from "../app/configs";
import { openFilmMaker } from "../film/store";
import { openFrameDialog } from "./FrameDialog";
import { openCam } from "../cam/job";
import { openSheets } from "../cam/sheetJob";
import { startMatePick } from "./viewport/PickLayer";
import { fastenFrames } from "../app/frameFasten";
import { importStepFiles } from "../app/imports";
import { placeDesignHere } from "../app/placeDesign";
import { DXF_ACCEPT, importDxfFiles, insertDxfIntoSketch, pickDxf } from "../app/dxf";
import { TEMPLATES } from "../demos/templates";
import { openDrawings, closeDrawings, useDrawings } from "../drawing/engine";
import { ANALYSIS_KINDS, kindsFor } from "./analysisKinds";
import { openAnalysis } from "./AnalysisPanel";
import { CATEGORY_LABEL } from "./ChecksPanel";
import { DOCK_TABS } from "./Dock";
import { openApp } from "../apps/session";
import { AppGlyph, newAppInDesign } from "./apps/actions";
import { BUILD_APP_ASK } from "./apps/AppsPanel";
import { ScriptGlyph, SCRIPT_ASK } from "./scripts/ScriptsPanel";
import { addScript, openScripts, runSaved } from "../scripts/runtime";
import { projectScripts } from "../app/project";
import { LEFT_TABS } from "./LeftPanel";
import { toggleMarkup } from "./Markup";
import { toggleWiring } from "./wiringView";
import { openSchematic } from "./MachinePanel";
import { openPrintPlates } from "./make/MakePanel";
import { RulerIcon, toggleMeasure } from "./viewport/MeasureTool";
import { FilterIcon, openSetNamer, recallSet } from "./viewport/PickLayer";
import { toggleHandles, useHandles } from "./viewport/HandlesLayer";
import { FILTERS, FILTER_WORD, savedSets, setFilter, toggleBox, usePicks } from "../app/picks";
import { playFitting, useFitView } from "./FitLayer";
import { togglePmi, usePmiView } from "./PmiLayer";
import { hasFitting } from "../analysis/fitting";
import { exitSketch, setTool, startPicking, useSketch } from "./sketch/session";
import { STEP_ACCEPT } from "./ImportsPanel";
import { FIX_IT_UP, MAKE_BUILDABLE, openModelTool } from "./ModelTools";
import { askClaude, REVIEW_ASK } from "./chatDraft";
import { Icon } from "./icons";
import { openViewportMenu } from "./viewport/contextMenus";
import { T } from "./sketch/glyphs";

export type FindGroup = "Panels" | "View" | "Model" | "Analyse" | "Make" | "Machines" | "Export" | "Parts" | "Checks" | "New design" | "Project" | "Settings";

/** the order groups are listed in when nothing is typed */
export const GROUP_ORDER: FindGroup[] = ["Checks", "Panels", "Model", "Analyse", "Make", "Machines", "View", "Export", "Parts", "Project", "New design", "Settings"];

export interface FindItem extends Findable {
  id: string;
  group: FindGroup;
  icon: ReactNode;
  /** the key that does the same, shown on the right */
  keys?: string;
  /** ask: Claude adds it (a draft in the chat) · on: a view that is on now · here: the design has it */
  tag?: "ask" | "on" | "here";
  /** where the result shows on a phone, which has one panel at a time */
  pane?: "chat" | "model" | "panel";
  run: () => void;
}

/** What the palette knows when it opens. */
export interface FindContext {
  inWorkspace: boolean;
  /** dock tabs shown for this design, by id */
  dockShown: Record<string, boolean>;
}

const ask = (id: string, group: FindGroup, title: string, detail: string, keywords: string, prompt: string, icon: ReactNode): FindItem => ({ id, group, title, detail, keywords, icon, tag: "ask", pane: "chat", run: () => askClaude(prompt) });

/** Other names for the panels, so "bom" finds the parts list and "pcb" the build tab. */
const TAB_FIND: Record<string, { title?: string; detail: string; keywords: string; ask?: string; askTitle?: string }> = {
  overview: { detail: "Status, the brief, the design at a glance and recent changes", keywords: "summary status dashboard home at a glance" },
  brief: { detail: "What it's for, where it's used and what it must survive: each becomes a check", keywords: "requirements uses spec specification purpose goals constraints" },
  checks: { detail: "Every check on the design, and why it passes or fails", keywords: "tests problems errors warnings failing issues interference validate verify" },
  analysis: { detail: "Strength (frames as beams, carbon layups and sheet metal as shells, composite plies checked by Tsai–Wu), contact between touching parts, tightened bolts, fatigue life, drop, vibration (sine sweeps and random shaking), heat and current (Joule heating), buckling, topology optimisation, design studies, airflow, air loads from an airflow run into strength, gear and bike rule runs", keywords: "air load air loads aero loads aerodynamic loads wind load from airflow pressure map fluid structure interaction fsi one-way fsi one way coupling cfd to fea cfd loads pressure mapping map pressures surface pressure loads gust factor downforce on wing spoiler load sign wind load fairing load preload bolt preload bolt tension pretension pre-tension tightened bolts tightening torque bolted joint clamp load clamping force joint separation joint opening joint slip slip resistance proof load vdi 2230 contact touching parts touch frictional frictionless friction coefficient mu sliding slip separation gap lift off no separation rough bonded glued contact pressure contact status nonlinear contact assembly contact topology optimisation optimization generative design lightweighting lighten remove material truss organic shape simp preserve min member dxf profile fea stress airflow aero wind results analyses thermal temperature heat buckling accuracy mesh convergence check accuracy design study optimise optimize sweep fatigue life cycles s-n sn curve endurance goodman rainflow load history miner durability infill walls perimeters print settings printed layers anisotropic orthotropic pin hinge pinned support bearing load bore spring elastic support rubber feet pad foundation set displacement prescribed displacement push snap fit clip force to push large deflection geometric nonlinearity nonlinear geometry big deflection flexure bending far corotational beam elements beams frame analysis truss weldment analysis member forces axial force bending moment euler buckling strut column shell elements shells thin wall thin-walled laminate carbon layup composite monocoque carbon frame stiffness sheet metal bracket stress panel buckling plate buckling skin ripple wrinkling joule heating electric current busbar bus bar resistance resistive heating heater element i2r i²r voltage drop current density ampacity fuse wire harmonic response frequency response sine sweep sine vibration shaker table shake test resonance dwell transmissibility base excitation random vibration psd power spectral density grms g rms navmat truck transport ride vibration test steinberg three band miles equation 3 sigma vibration fatigue composite plies ply layup lay-up stacking sequence ply book ply schedule ply angle fibre direction fiber direction fibre orientation fiber orientation tsai-wu tsai wu first ply failure first-ply failure lamination theory classical laminate theory clt abd matrix unidirectional ud prepreg woven twill 3k quasi-isotropic quasi isotropic 0/45/90 ply drop reinforcement patch t700 t800 m40j e-glass glass fibre fibreglass aramid kevlar matrix cracking fibre breakage" },
  build: {
    title: "Build: electronics and wiring",
    detail: "Wiring, boards, power, calculations, firmware and tests for a machine",
    keywords: "electronics wiring circuit firmware arduino microcontroller power battery pcb board cables klipper motor driver",
    ask: "Make this a working machine: choose the controller, motors and sensors it needs, power and wiring, and write the firmware, then add them to the design and check it all works.",
    askTitle: "Add electronics and wiring",
  },
  sim: {
    title: "Simulate",
    detail: "Run the firmware and the physics: moves, loads, power and faults",
    keywords: "simulation physics firmware run scenario test virtual prototype",
    ask: "Add a simulation scenario for this design: what it should do in use and how we would know it worked, then run it and tell me what you find.",
    askTitle: "Add a simulation",
  },
  apps: {
    title: "Apps: live views and controls",
    detail: "Your own programs for the machine: live numbers, charts, controls, a console and the design in 3D, on its simulated twin or the real one over USB; save one as a program of its own",
    keywords: "app apps control room dashboard hmi gui interface telemetry live data serial monitor plotter usb twin digital twin standalone program software desktop exe gauges readouts",
    ask: BUILD_APP_ASK,
    askTitle: "Build a control app",
  },
  make: { detail: "How each part is made: process, machine limits, cost and time", keywords: "manufacturing manufacture dfm process cost print cnc quote factory production" },
  bom: { detail: "Quantities, make or buy, prices and where to buy", keywords: "bom bill of materials buy shopping order cost price suppliers" },
  graph: { detail: "How the parts and features depend on each other", keywords: "dependencies dependency structure network" },
  scripts: {
    title: "Scripts",
    detail: "JavaScript that works the design through the kerf API: try a size at many values, export every part or configuration, tables and files of your own, and checks that run after each change",
    keywords: "script scripts scripting javascript js macro macros automation automate api batch batch export loop sweep parameter sweep design table run code program custom check custom rule rules own checks console plugin featurescript ilogic vba python api add-in addin",
  },
  code: { title: "Design file (design.kerf)", detail: "The design as text: edit it by hand", keywords: "code source editor text script file kerf language" },
  structure: { title: "Parts", detail: "Every part and component, grouped as in the design: show a group on its own or hide it", keywords: "tree structure components assembly hierarchy outline groups grouping solo only subassembly" },
  features: {
    title: "Feature tree",
    detail: "Each part's steps in build order: type over a value, suppress, reorder, delete, roll back, pattern or mirror a step",
    keywords: "features feature tree history timeline steps operations suppress rollback roll back reorder edit dimensions parametric manual cad",
  },
  params: { title: "Parameters", detail: "The sizes you can scrub, grouped as in the design", keywords: "params dimensions sizes variables sliders values" },
  sketches: { detail: "2D profiles with dimensions and constraints", keywords: "sketch profile 2d constraints outline" },
  decisions: { title: "Design decisions", detail: "The choices made, and the options not taken", keywords: "options alternatives choices tradeoffs trade offs" },
  history: { detail: "Every version: compare and restore, and branches to try things on and merge", keywords: "versions undo restore compare timeline revisions changes branch branches merge" },
};

const SETTINGS_FIND: { tab: SettingsTab; title: string; detail: string; keywords: string }[] = [
  { tab: "ai", title: "AI: key, model and cost", detail: "Your Claude or OpenAI key, the model, effort, self-review, lessons, the bench and cost", keywords: "claude openai gpt api key model effort review cost tokens claude code mcp plan bench benchmark measure accuracy test speed compare lessons corrections learn remember rules slimmer prompt lean reference" },
  { tab: "account", title: "Account and sync", detail: "Sign in to sync projects between devices", keywords: "sign in login cloud sync devices" },
  { tab: "voice", title: "Voice input", detail: "Talk to Claude instead of typing", keywords: "speech microphone dictate talk" },
  { tab: "app", title: "Display", detail: "Theme, viewport, motion and graphics card", keywords: "theme dark light viewport graphics gpu motion animation" },
  { tab: "making", title: "Making: your tools and parts", detail: "Processes you can use, your machines, parts you have and costs", keywords: "workshop 3d printer cnc laser own machines processes parts on hand inventory labour" },
  { tab: "data", title: "Data and backups", detail: "Back up or import every project", keywords: "backup export import storage restore" },
  { tab: "about", title: "About Kerf", detail: "Version, licences and help", keywords: "version licence license help" },
];

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

function pickStep() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = STEP_ACCEPT;
  input.multiple = true;
  input.onchange = () => void importStepFiles([...(input.files ?? [])]);
  input.click();
}

function pickDxfSketch() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = DXF_ACCEPT;
  input.multiple = true;
  input.onchange = () => void importDxfFiles([...(input.files ?? [])]);
  input.click();
}

function duplicateOpen() {
  const id = useProject.getState().current?.id;
  if (id) void duplicateProject(id);
}

/** Every item the palette can show now. */
export function findItems(ctx: FindContext): FindItem[] {
  const out: FindItem[] = [];
  const push = (...xs: FindItem[]) => out.push(...xs);
  const d = useDesign.getState();
  const model = d.model;
  const v = useView.getState();
  const s = useSettings.getState();

  if (ctx.inWorkspace) {
    // ── checks that need attention ──
    const items = d.report?.items ?? [];
    for (const it of items.filter((i) => i.status === "fail").slice(0, 12))
      push({
        id: `check:${it.id}`,
        group: "Checks",
        title: it.title,
        detail: `Failing · ${CATEGORY_LABEL[it.category] ?? it.category}`,
        keywords: "failing fail problem error broken fix",
        icon: <Icon.Alert size={14} style={{ color: "var(--fail)" }} />,
        pane: "panel",
        run: () => useView.setState({ dockTab: "checks", dockOpen: true, focusCheck: it.id, focusParts: it.parts ?? [] }),
      });
    if (d.report?.counts.fail)
      push(ask("ask:fix-checks", "Checks", "Fix every failing check", "Claude works through them, most important first", "repair resolve failing problems errors", "Fix every failing check, the most important first, and tell me what you changed and anything you couldn't fix without my call.", <Icon.Sparkle size={14} />));

    // ── panels ──
    for (const t of DOCK_TABS) {
      const f = TAB_FIND[t.id];
      const shown = ctx.dockShown[t.id] ?? true;
      if (!shown && !f?.ask) continue;
      if (!shown)
        push(ask(`tab:${t.id}`, "Machines", f!.askTitle ?? f!.title ?? cap(t.label), f!.detail, `${f!.keywords} ${t.label}`, f!.ask!, t.icon));
      else
        push({
          id: `tab:${t.id}`,
          group: "Panels",
          title: f?.title ?? cap(t.label),
          detail: f?.detail,
          keywords: f?.keywords,
          icon: t.icon,
          keys: t.id === "code" ? "C" : undefined,
          pane: "panel",
          run: () => (t.id === "code" ? (v.dockTab === "code" && v.dockOpen ? undefined : toggleCode()) : useView.setState({ dockTab: t.id, dockOpen: true })),
        });
    }
    // ── apps: the design's own, and a new one ──
    for (const a of model?.apps ?? [])
      push({ id: `app:${a.name}`, group: "Machines", title: a.name, detail: a.about ?? `An app with ${a.panels.length} panel${a.panels.length === 1 ? "" : "s"}`, keywords: "app control room live view dashboard run twin usb telemetry", icon: <AppGlyph size={14} />, tag: "here", run: () => openApp(a.name) });
    if (model?.machine || model?.apps?.length)
      push({ id: "app:new", group: "Machines", title: "New app", detail: "A starter control app from the machine's firmware and simulation, to build on", keywords: "app control room dashboard new create make gui hmi live view", icon: <AppGlyph size={14} />, run: newAppInDesign });
    // ── scripts: the tab (shown once there is one), a new one, the design's own ──
    if (!(ctx.dockShown.scripts ?? true))
      push({ id: "tab:scripts", group: "Panels", title: TAB_FIND.scripts.title!, detail: TAB_FIND.scripts.detail, keywords: TAB_FIND.scripts.keywords, icon: <ScriptGlyph size={14} />, pane: "panel", run: () => openScripts() });
    push({
      id: "scripts:new",
      group: "Model",
      title: "New script",
      detail: "JavaScript on the design through the kerf API, with examples to start from",
      keywords: "script new script javascript macro automation automate batch sweep api code",
      icon: <ScriptGlyph size={14} />,
      pane: "panel",
      run: () => {
        const r = addScript();
        if ("error" in r) toast({ kind: "error", title: "No new script", detail: r.error });
      },
    });
    push(ask("ask:script", "Model", "Ask Claude for a script", "Claude writes one in the Scripts tab and runs it", "script macro automate automation batch sweep javascript write", SCRIPT_ASK, <Icon.Sparkle size={14} />));
    for (const sc of projectScripts())
      push({
        id: `scripts:run:${sc.id}`,
        group: "Model",
        title: `Run the script “${sc.name}”`,
        detail: sc.onChange ? "It runs after each change too; its checks are in the Checks tab" : "Its output shows in the Scripts tab",
        keywords: "script run macro automation execute",
        icon: <Icon.Play size={14} />,
        tag: "here",
        pane: "panel",
        run: () => {
          openScripts(`script:${sc.id}`);
          runSaved(sc.id).catch((e: unknown) => toast({ kind: "error", title: "The script didn't run", detail: e instanceof Error ? e.message : String(e) }));
        },
      });
    for (const t of LEFT_TABS) {
      const f = TAB_FIND[t.id];
      push({ id: `left:${t.id}`, group: "Panels", title: f?.title ?? cap(t.label), detail: f?.detail, keywords: f?.keywords, icon: t.icon, pane: "model", run: () => useView.setState({ leftTab: t.id }) });
    }

    // ── branches ──
    const proj = useProject.getState().current;
    if (proj) {
      const list = projectBranches(proj);
      const open = openBranch(proj);
      const here = list.find((b) => b.id === open);
      const toHistory = () => useView.setState({ leftTab: "history" });
      push({
        id: "branch:new",
        group: "Project",
        title: "New branch",
        detail: "Try something on a branch of its own: what you do there stays off this line until you merge it back",
        keywords: "branch branches new branch fork try idea experiment alternative variant option workspace sandbox git version control what if",
        icon: <Icon.Branch size={14} />,
        pane: "model",
        run: () => (toHistory(), startNewBranch()),
      });
      for (const b of list)
        if (b.id !== open)
          push({ id: `branch:open:${b.id}`, group: "Project", title: `Switch to the branch “${b.name}”`, detail: b.from ? `Made from ${list.find((x) => x.id === b.from)?.name ?? "main"}` : "The design's main line", keywords: "branch switch checkout open change branch", icon: <Icon.Branch size={14} />, pane: "model", run: () => (toHistory(), void openBranchNamed(b.id)) });
      const parent = here?.from ? list.find((b) => b.id === here.from) : undefined;
      if (here && parent) {
        push(
          { id: "branch:merge", group: "Project", title: `Merge “${here.name}” into ${parent.name}`, detail: "Bring what changed on this branch into the one it came from; places both changed ask which to keep", keywords: "merge branch merge into main combine bring back integrate pull request three way 3-way", icon: <Icon.Merge size={14} />, pane: "model", run: () => (toHistory(), void startMerge(here.id, parent.id)) },
          { id: "branch:take", group: "Project", title: `Take ${parent.name}'s changes into “${here.name}”`, detail: "Bring what changed on the branch this came from into it, so it stays up to date", keywords: "update branch rebase sync pull merge from main catch up", icon: <Icon.Merge size={14} />, pane: "model", run: () => (toHistory(), void startMerge(parent.id, here.id)) },
        );
      }
    }

    // ── modelling ──
    const sketching = useSketch.getState();
    push(
      { id: "model:tools", group: "Model", title: "Modelling tools", detail: "Box, cylinder, hole, fillet, chamfer, shell, move, turn, copy, pattern, mirror, cut out: model it yourself, with or without Claude", keywords: "advanced manual direct edit extrude cad tools hand without ai offline", icon: <Icon.Wrench size={14} />, tag: s.advanced ? "on" : undefined, run: () => updateSettings({ advanced: !s.advanced }) },
      { id: "model:pattern", group: "Model", title: "Pattern parts", detail: "Copies of the selected parts in a row or round an axis (a hole or boss inside a part: the feature tree)", keywords: "pattern array linear circular polar repeat copies rectangular radial duplicate", icon: <Icon.Pattern size={14} />, run: () => openModelTool("pattern") },
      { id: "model:mirror", group: "Model", title: "Mirror a part", detail: "The other hand of a part, linked so it follows every change", keywords: "mirror symmetric symmetry flip reflect opposite left right hand", icon: <Icon.Mirror size={14} />, run: () => openModelTool("mirror") },
      { id: "model:subtract", group: "Model", title: "Cut one part out of another", detail: "A pocket or opening exactly where another part sits, linked to it", keywords: "subtract boolean combine difference cut out pocket cavity recess negative", icon: <Icon.Subtract size={14} />, run: () => openModelTool("subtract") },
      { id: "model:sketch", group: "Model", title: sketching.active || sketching.picking ? "Leave the sketch" : "New sketch", detail: "Draw a 2D profile on a face or plane, with dimensions, and extrude or revolve it: a depth, up to the next face or through all, with a taper or as a thin wall", keywords: "sketch draw profile 2d extrude revolve constraint boss cut pocket taper draft angle thin wall feature up to next face through all two sided mid plane rectangle centre center rectangle 3 point rotated rectangle polygon hexagon octagon slot circle arc spline bezier curve freeform smooth curve aerofoil airfoil ellipse oval trim extend offset mirror pattern circular pattern linear pattern bolt circle project edges convert entities include geometry", icon: <T.Sketch size={14} />, run: () => (sketching.active || sketching.picking ? exitSketch() : startPicking()) },
      { id: "model:refplane", group: "Model", title: "Sketch on a reference plane", detail: "Pick a plane or face, then move it off by a distance, tilt it by an angle, or put it midway between two parallel faces. In code, plane() also goes through three points, square to a path or tilted about an edge", keywords: "reference plane datum plane work plane construction plane offset plane angled plane tilted plane inclined plane midplane mid plane between two faces three points normal to path perpendicular to line at angle", icon: <T.Sketch size={14} />, run: () => startPicking() },
      ...(sketching.active
        ? [
            { id: "sketch:trim", group: "Model" as const, title: "Trim", detail: "Cut a curve back to where others cross it, or delete one nothing crosses", keywords: "trim cut break split power trim delete segment", icon: <T.Trim size={14} />, keys: "T", run: () => setTool("trim") },
            { id: "sketch:extend", group: "Model" as const, title: "Extend", detail: "Run a loose end of a line or arc on to the next curve", keywords: "extend lengthen stretch reach", icon: <T.Extend size={14} />, keys: "E", run: () => setTool("extend") },
            { id: "sketch:offset", group: "Model" as const, title: "Offset", detail: "A copy of an outline a set distance in or out, that follows it", keywords: "offset parallel copy wall thickness clearance inset outset", icon: <T.Offset size={14} />, keys: "F", run: () => setTool("offset") },
            { id: "sketch:mirror", group: "Model" as const, title: "Mirror in the sketch", detail: "Copy geometry across a line or axis, kept symmetric", keywords: "mirror symmetric symmetry flip reflect half", icon: <T.Mirror size={14} />, keys: "M", run: () => setTool("mirror") },
            { id: "sketch:pattern", group: "Model" as const, title: "Pattern in the sketch", detail: "Repeat geometry in a row, a grid or a ring round a point", keywords: "pattern array linear circular polar grid bolt circle repeat holes", icon: <T.Pattern size={14} />, keys: "K", run: () => setTool("pattern") },
            { id: "sketch:project", group: "Model" as const, title: "Project a face", detail: "Bring the edges of a part's face into the sketch, fixed, to draw from", keywords: "project convert entities include use edges reference geometry outline from part face", icon: <T.Project size={14} />, keys: "J", run: () => setTool("project") },
            { id: "sketch:dxf", group: "Model" as const, title: "Insert a DXF drawing", detail: "Add a drawing's lines, arcs, circles and curves to this sketch, joined and fixed where they were drawn", keywords: "insert import dxf dwg drawing outline profile autocad librecad inkscape illustrator laser cut file vector 2d trace logo", icon: <T.Insert size={14} />, keys: "I", run: () => pickDxf((f) => void insertDxfIntoSketch(f)) },
          ]
        : []),
      { id: "model:markup", group: "Model", title: "Draw on the view for Claude", detail: "Circle or scribble on the model and say what to change there", keywords: "markup annotate scribble sketch on screen pen highlight", icon: <Icon.Edit size={14} />, keys: "M", run: () => toggleMarkup() },
      { id: "model:frame", group: "Model", title: "New frame", detail: "A box frame or rectangle of 2020 extrusion or steel box, tube or angle: members cut to fit where they meet, with a cut list", keywords: "frame weldment weldments structural members 2020 2040 extrusion v-slot t-slot aluminium profile steel box section rhs shs square tube round tube chs angle iron flat bar chassis stand table cube cage rack trim extend mitre miter cope cut list", icon: <Icon.Grid size={14} />, run: () => openFrameDialog() },
      { id: "model:mate", group: "Model", title: "Mate two parts", detail: "Click a face, hole or corner on the part that moves, then one on the part it meets, and choose how they meet: against, flush, in line, at a distance or an angle", keywords: "mate mates mating assembly assemble constraint constraints joint joints align alignment concentric coaxial coincident flush against parallel perpendicular tangent distance angle insert hinge pin revolute slider prismatic cylindrical planar ball socket position place parts together lock rigid fix", icon: <Icon.Assemble size={14} />, run: () => startMatePick() },
      { id: "model:drag-parts", group: "Model", title: "Drag parts the ways they move", detail: "Select a part its mates leave free (a hinged lid, a carriage) or one the mechanism turns, then drag it in the 3D view; Keep here writes the pose into the design", keywords: "drag move moving parts through joints mates free motion degrees of freedom dof hinge open swing slide carriage crank turn rotate mechanism pose position capture position revert put back", icon: <Icon.Orbit size={14} />, run: () => toast({ kind: "info", title: "Select a part with mates or a motion, then drag it in the 3D view: it moves only the ways they let it" }, 5000) },
      { id: "model:fasten-frames", group: "Model", title: "Fasten frame joints", detail: "Corner brackets with screws and T-nuts at every 2020 or 2040 frame joint nothing holds yet, without Claude", keywords: "fasten frame joints corner brackets gusset t-nuts tee nuts screws extrusion v-slot 2020 2040 join profiles", icon: <Icon.Screw size={14} />, run: () => void fastenFrames() },
      { id: "model:cutlist", group: "Model", title: "Cut list", detail: "Lengths to cut for every frame, their end cuts and the bars to buy (under the parts list)", keywords: "cut list cutting list saw lengths stock bars frame members weldment extrusion", icon: <Icon.List size={14} />, run: () => useView.setState({ dockTab: "bom", dockOpen: true }) },
      { id: "model:step", group: "Model", title: "Import a STEP file", detail: "Bring in a part from another CAD tool to design around", keywords: "import step stp cad file part load open", icon: <Icon.Upload size={14} />, run: pickStep },
      // another of your designs, placed in this one as a subassembly
      ...useProject
        .getState()
        .projects.filter((p) => p.id !== useProject.getState().current?.id)
        .slice(0, 30)
        .map(
          (p): FindItem => ({
            id: `model:place:${p.id}`,
            group: "Model",
            title: `Place ${p.name} in this design`,
            detail: "As one subassembly that updates when you change it, read with the sizes you give it",
            keywords: `place insert put add design project subassembly sub-assembly assembly reuse reused another existing derived part component module library ${p.name}`,
            icon: <Icon.Layers size={14} />,
            run: () => placeDesignHere(p.id),
          }),
        ),
      ask(
        "ask:place-design",
        "Model",
        "Make part of this a design of its own",
        "Split out a subassembly you want to reuse (a motor mount, a wheel module) so other designs can place it",
        "subassembly sub-assembly assembly module reuse reusable library derived part shared part split out extract another project design",
        'Pick the subassembly in this design that would be worth reusing in other designs (say which and why), and tell me how to make it a design of its own: its parameters, what stays here, and the component mount = design("...") line that places it back here.',
        <Icon.Layers size={14} />,
      ),
      { id: "model:dxf", group: "Model", title: "Import a DXF drawing as a sketch", detail: "A laser-cut part, a flat pattern or an outline from another CAD tool: its lines, arcs, circles and curves come in joined and fixed, ready to make solid", keywords: "import dxf dwg drawing 2d outline profile sketch autocad librecad qcad inkscape illustrator laser cut cnc router waterjet plasma flat pattern sheet vector logo trace extrude plate", icon: <Icon.Upload size={14} />, run: pickDxfSketch },
      { id: "model:mesh", group: "Model", title: "Import a mesh (STL, OBJ or 3MF)", detail: "A downloaded model, a print or a scan: Kerf repairs the mesh, makes it a solid you can cut, fasten to and check, and finds its holes", keywords: "import mesh stl obj 3mf wavefront triangles printables thingiverse makerworld download scan scanned 3d scan photogrammetry bambu prusa slicer model print convert mesh to solid brep repair fix holes", icon: <Icon.Upload size={14} />, run: pickStep },
      ask("ask:fix-up", "Model", "Fix it up", "After modelling by hand: Claude makes it fit, build and pass the checks", "tidy clean repair hand made manual", FIX_IT_UP, <Icon.Sparkle size={14} />),
      ask("ask:buildable", "Model", "Make it a buildable product", "Real fasteners and fits, processes you have, an assembly order and where to buy each part", "product real manufacture production ready buildable", MAKE_BUILDABLE, <Icon.Sparkle size={14} />),
      ask("ask:fasteners", "Model", "Choose and place fasteners", "Real screws, nuts and inserts sized for the loads, with room for the tools", "screws bolts nuts inserts hardware fasteners fixings", "Choose and place real fasteners for every joint in this design, sized for the loads it will see, using parts I have where they fit, and check each one can be reached with its tool.", <Icon.Screw size={14} />),
      ask("ask:motor", "Machines", "Pick a motor", "A motor sized for what it drives, with a mount that really fits it", "motor stepper servo dc brushless actuator drive", "Choose a motor for what this design has to drive, with a mount that really fits it, and check its torque, speed and heat.", <Icon.Bolt size={14} />),
      ask("ask:review", "Model", "Review the design", "A careful engineer's read: what would fail, be hard to make or cost too much", "critique feedback review audit risks improve second opinion", REVIEW_ASK, <Icon.Shield size={14} />),
      ask("ask:explain", "Model", "Explain how it works", "Part by part, for someone new to it", "explain teach learn how why understand student", "Explain how this design works and why it is shaped the way it is, part by part, for someone new to it.", <Icon.Info size={14} />),
    );

    // ── analyses: the ones the design has, then each kind Claude can add ──
    for (const a of model?.analyses ?? []) {
      const k = ANALYSIS_KINDS.find((x) => x.is(a));
      const I = Icon[k?.icon ?? "Stress"];
      push({ id: `analysis:${a.label}`, group: "Analyse", title: a.label, detail: `${k?.label ?? "Analysis"} · ${k?.detail ?? ""}`, keywords: `${k?.keywords ?? ""} analysis results`, icon: <I size={14} />, tag: "here", pane: "panel", run: () => openAnalysis(a.label) });
    }
    for (const k of kindsFor(model)) {
      const I = Icon[k.icon];
      push(ask(`ask:analysis:${k.id}`, "Analyse", `Add ${k.id === "uci" ? "a UCI rules check" : k.id === "study" ? "a design study" : `a${/^[aeiou]/i.test(k.label) ? "n" : ""} ${k.label.toLowerCase()} analysis`}`, k.detail, `${k.keywords} analysis analyse test`, k.ask, <I size={14} />));
    }

    // ── making ──
    push(
      ask("ask:mould", "Make", "Make a mould", "A two-part printed mould made from the part with mould(): keys, bolts, pour hole and vents", "mould mold casting cast resin silicone urethane polyurethane", "Make a two-part mould for the part I want to cast (ask me which if it isn't clear) with mould(): registration keys, clamping bolts, a pour hole and vents, split where it releases cleanly, and check it opens.", <Icon.Factory size={14} />),
      ask("ask:rounds", "Make", "Fillets that change, full rounds and uneven chamfers", "fillet([1, 4]) grows along an edge, full_round() rounds a rib or rim right over, between() rounds where two sets of faces meet, chamfer((3, 1), on:) or angle: cuts an uneven bevel", "variable radius fillet varying fillet changing radius taper fillet full round fillet round over bullnose rib top rounded rim face fillet between faces blend asymmetric chamfer unequal chamfer distance angle chamfer two distance chamfer setback", "Look at the parts' edges and rib tops: round rib tops, rims and handles right over with full_round(), make fillets grow where a load or flow needs it with a list of radii, blend face sets with between(), and use uneven chamfers where one face needs a longer lead-in.", <Icon.Fillet size={14} />),
      ask("ask:configs", "Model", "Make sizes or variants of the design", "Keep S, M and L (or left and right, 2 or 4 bays) in one file as configurations, each checked and exported", "configurations configuration variants variant sizes size range family table family of parts design table small medium large versions options models S M L left hand right hand", "Turn this design into a family of configurations: pick the parameters that make the variants worth having (sizes, counts, hands), add a configs block with a row for each and a note on what each is for, show the main one, then check every configuration reads cleanly and fix any that fails.", <Icon.Layers size={14} />),
      ask("ask:ownfeatures", "Model", "Make your own feature or function", "Write a detail you use again and again (a boss, a tab, a vent row) once, then use it in any part with its own sizes", "custom feature custom features user feature user defined feature library feature featurescript udf user defined function function functions fn macro reuse reusable repeat same detail template snippet boss tab mounting tab vent row helper formula", "Find the details this design repeats (screw bosses, tabs, ribs with their fillets, hole patterns) and write each once as a feature (or a value worked out the same way as a fn), with parameters for what changes, then use them in the parts where they go, keep each part's look and checks the same, and tell me what you made.", <Icon.Layers size={14} />),
      ask("ask:split", "Make", "Split a part to fit the printer", "Cut a part too big for the bed into pieces with split:, lined up on dowel pins placed where it is solid", "split cut into pieces too big for the bed too large build volume print in pieces sections segments halves join dowel pins alignment pins glue together split body split part multi-body bodies", "Find the parts too big for their printer's bed and make each in pieces with split: (the fewest that fit, joined on dowel pins), choosing cuts where the part is solid and plain, then check every piece fits and every joint has its pins.", <Icon.Factory size={14} />),
      ask("ask:enclosure", "Make", "Make an enclosure", "Two printed shells with a lip and groove, screw posts, vents and openings for the connectors", "enclosure case box housing shell lid lip groove tongue joint parting line vents honeycomb fan grille", "Make a printed enclosure for the electronics in this design (ask me which board if it isn't clear): two shells split where it assembles easily, joined with lip_groove(), screw_boss posts with inserts, vents() where parts get warm, openings for every connector, and check every board mounts and fits.", <Icon.Cube size={14} />),
      ask("ask:sheet", "Make", "Make it from sheet metal", "Bent parts with sheet(): bend radii, reliefs, flat patterns and a laser DXF", "sheet metal bend fold brake laser flat pattern dxf aluminium steel chassis", "Rebuild the parts that suit it as bent sheet metal with sheet(): real bend radii and reliefs, flat patterns with bend tables and a DXF for laser cutting, and check every bend and flange.", <Icon.Layers size={14} />),
      ask("ask:sheetforms", "Make", "Hem, roll, jog or add louvres to sheet metal", "Folded-back safe edges, curled edges, flanges stepped past a mating part, and vents pressed into the sheet", "hem hems hemmed edge folded edge safe edge teardrop hem open hem closed hem roll rolled edge curl curled edge hinge knuckle jog joggle offset flange stepped flange louvre louvres louver louvers vent vents pressed vent cooling slots enclosure ventilation turret punch form tool forming tool sheet metal", "Finish the sheet() parts' edges and vents as a fabricator would: hem or roll the exposed edges people handle, jog flanges that lap over a mating part, and give enclosures louvres instead of cut slots where they need air, then check the flat patterns and the room round every form.", <Icon.Layers size={14} />),
      ask("ask:carbon", "Make", "Plan a carbon fibre layup", "Ply book, orientations, weights and how it comes out of the mould", "carbon fibre fiber composite layup ply prepreg monocoque ply schedule ply book plies stacking sequence reinforcement", "Plan the carbon fibre layup for the carbon parts: give each its ply schedule with plies: on its process (orientations, materials and the zones built up at joints and bearings), where the mould splits, and how each part comes out of it, then check the ply book, the weight and each ply's strength.", <Icon.Layers size={14} />),
      ask("ask:factory", "Make", "Get it ready for a factory", "Drawings, materials, tolerances and a list of what to send for a quote", "factory quote manufacturer production supplier rfq send order batch", "Get this design ready to send to a factory for a quote: the processes and materials, drawings with the tolerances that matter, quantities, and a list of what to send and what to ask them.", <Icon.Factory size={14} />),
      { id: "make:toolpaths", group: "Make", title: "CNC toolpaths", detail: "Plan the cuts for a part on a router or mill, watch them on the model and save G-code for GRBL, LinuxCNC or Mach", keywords: "cnc cam toolpath toolpaths tool path g-code gcode nc ngc tap mill milling router routing grbl linuxcnc mach3 mach4 shapeoko x-carve onefinity 3018 pocket pocketing facing roughing finishing contour profile cut out rest machining tabs vise spoilboard end mill feeds speeds post processor simulate simulation stock machining", icon: <Icon.EndMill size={14} />, run: () => openCam() },
      { id: "make:plates", group: "Make", title: "Print plates", detail: "Your printed parts packed onto as many plates as your printer takes, by material, with the supports they need, their filament and time; a 3MF a plate", keywords: "print plate plates build plate bed arrange auto arrange autoarrange pack packing nest nesting multi plate multiple plates 3mf slicer bambu studio orca orcaslicer prusaslicer cura supports support material support volume overhang overhangs bridge bridging filament grams weight print time how long to print estimate cost two nozzles dual nozzle second nozzle idex multi material h2d x2d x1c p1s a1 prusa ender voron", icon: <Icon.Grid size={14} />, run: () => openPrintPlates() },
      { id: "make:sheets", group: "Make", title: "Laser, plasma or waterjet sheets", detail: "Nest the flat parts on sheets with kerf offset and lead-ins, watch the cut and save DXF, SVG or G-code", keywords: "laser cut cutting lasercut nest nesting sheet sheets plate plates plasma waterjet water jet fiber fibre co2 diode kerf lead-in lead in pierce dxf svg g-code gcode lightburn xtool glowforge lasergrbl sheetcam flat pattern sheet metal plywood acrylic offcut layout true shape", icon: <Icon.LaserCut size={14} />, run: () => void openSheets() },
      { id: "make:tools", group: "Make", title: "Tools you have", detail: "Your printer, laser, CNC and the processes you can order, so the checks fit what you can really make", keywords: "workshop machines processes own printer 3d printer cnc laser parts on hand inventory", icon: <Icon.Wrench size={14} />, run: () => openSettings("making") },
    );

    // ── views ──
    const hasMotion = !!model?.parts.some((p) => turns(p.motion));
    const hasWires = !!model?.machine && model.machine.wires.length + model.machine.nets.length > 0;
    const drawings = useDrawings.getState().open;
    const cams: [ViewPreset, string, string?][] = [["iso", "Iso"], ["front", "Front", "2"], ["back", "Back", "Shift+2"], ["left", "Left", "Shift+3"], ["right", "Right", "3"], ["top", "Top", "4"], ["bottom", "Bottom", "Shift+4"]];
    push(
      { id: "view:fit", group: "View", title: "Fit to view", detail: "Frame the whole model", keywords: "zoom all frame reset camera", icon: <Icon.Fit size={14} />, keys: "F", run: () => requestCamera("fit") },
      {
        id: "view:context",
        group: "View",
        title: "Right-click menus",
        detail: "Right-click a part for what you can do at that spot (ask Claude, zoom, look square at the face, section here, hide, sketch on it, hole, fillet, material, lock, delete), empty space for the view, or a row of the parts list",
        keywords: "context menu right click marking menu actions shortcut menu lock unlock part locked hide show only section here look at face normal to sketch on face",
        icon: <Icon.List size={14} />,
        run: () => {
          const r = document.querySelector(".viewport")?.getBoundingClientRect();
          if (r) openViewportMenu(null, r.left + r.width / 2, r.top + r.height / 2);
        },
      },
      { id: "view:cube", group: "View", title: "View cube", detail: "Bottom left of the view: click a face, edge or corner to look from that side, drag it to turn the view, the arrows step to the next face, the house goes home", keywords: "viewcube view cube navigation cube orientation home view standard views corner edge isometric look from turn rotate orbit next face", icon: <Icon.Cube size={14} />, run: () => requestCamera("iso") },
      ...cams.map(([p, label, k]): FindItem => ({ id: `view:cam:${p}`, group: "View", title: `${label} view`, detail: "Camera", keywords: "camera angle look from orientation", icon: <Icon.Cube size={14} />, keys: p === "iso" ? "1" : k, run: () => requestCamera(p) })),
      { id: "view:section", group: "View", title: "Section view", detail: "Cut the model open along X, Y or Z; with results showing, the cut face shows the values inside", keywords: "cut cross section slice clip inside section through results stress inside interior cut plane internal stress temperature inside", icon: <Icon.Scissors size={14} />, keys: "S", tag: v.section.on ? "on" : undefined, run: () => useView.setState({ section: { ...v.section, on: !v.section.on } }) },
      { id: "view:explode", group: "View", title: "Exploded view", detail: "Take it apart step by step: screws out along their axes, then each part off what it sits on", keywords: "explode exploded apart spread assembly disassemble take apart steps smart exploded view fasteners screws out", icon: <Icon.Explode size={14} />, keys: "E", tag: v.explode > 0 ? "on" : undefined, run: () => useView.setState({ explode: v.explode > 0 ? 0 : 1 }) },
      { id: "view:assembly", group: "View", title: "Play the assembly", detail: "Watch the parts go together in the order they fit, screws once both sides are on", keywords: "assemble animation build order instructions", icon: <Icon.Assemble size={14} />, keys: "A", run: () => useView.setState({ explode: 0, assemblyRequest: v.assemblyRequest + 1 }) },
      { id: "view:xray", group: "View", title: "X-ray", detail: "See through the parts", keywords: "transparent see through ghost inside", icon: <Icon.Xray size={14} />, keys: "X", tag: v.xray ? "on" : undefined, run: () => useView.setState({ xray: !v.xray }) },
      { id: "view:measure", group: "View", title: "Measure", detail: "Distances, angles and sizes between what you click", keywords: "ruler distance dimension size gap angle", icon: <RulerIcon size={14} />, keys: "R", run: () => toggleMeasure() },
      ...FILTERS.map((f): FindItem => ({
        id: `view:pick:${f}`,
        group: "View",
        title: f === "part" ? "Pick whole parts" : `Pick ${FILTER_WORD[f]}`,
        detail: f === "part" ? "Clicks select parts again (the selection filter)" : `Clicks pick ${FILTER_WORD[f]} of the parts: fillet or chamfer the picked edges, push, pull, delete or move picked faces, sketch on a flat one, copy them as near() selectors or ask Claude about them`,
        keywords: "selection filter select faces edges corners vertices vertex bodies parts pick face pick edge pick corner sub-part sub part entity topology filter faces only edges only",
        icon: <FilterIcon filter={f} box={false} size={14} />,
        keys: "Q",
        tag: usePicks.getState().filter === f ? "on" : undefined,
        run: () => setFilter(f),
      })),
      ...(
        [
          ["push-pull", "Push or pull faces", "Pick faces, give a distance and Push/pull: the faces round them stretch to follow, a hole or boss gets bigger or smaller. Imported STEP and mesh files too", "push pull press pull offset face move face direct edit direct modelling direct editing thicken extend lengthen shorten resize hole resize boss taper draft imported step edit dumb solid", <Icon.Move size={14} key="i" />],
          ["delete-faces", "Delete faces and heal", "Pick a feature's faces and Delete: a hole or pocket is filled, a boss cut off, a round or chamfer made a sharp edge again", "delete face remove face remove feature defeature defeaturing heal fill hole remove hole remove fillet remove round remove chamfer remove boss simplify direct edit imported step", <Icon.Trash size={14} key="i" />],
          ["move-faces", "Move or copy a feature by its faces", "Pick a hole's, pocket's or boss's faces and Move…: it moves by x, y, z and closes up where it was, or copy leaves the original", "move face move faces move hole move feature copy feature reposition relocate shift hole direct edit imported step", <Icon.Move size={14} key="i" />],
        ] as const
      ).map(([id, title, detail, keywords, icon]): FindItem => ({
        id: `model:${id}`,
        group: "Model",
        title,
        detail,
        keywords,
        icon,
        run: () => {
          setFilter("face");
          toast({ kind: "info", title: "Click the faces to change (Shift adds more), then use the buttons on the card", detail: "Picks faces for now: Q changes what a click picks" }, 6000);
        },
      })),
      { id: "view:handles", group: "View", title: "Drag handles", detail: "With a part selected: arrows on its sizes to pull them (or click a value on the model to type it) and arrows in its middle to slide it along X, Y or Z", keywords: "drag handles push pull press pull instant3d arrows resize stretch on-model dimensions edit dimension on model triad move manipulator gizmo slide", icon: <Icon.Move size={14} />, keys: "H", tag: useHandles.getState().on ? "on" : undefined, run: () => toggleHandles() },
      { id: "view:boxselect", group: "View", title: "Box select", detail: "Drag a box to pick parts, faces, edges or corners: left to right takes what is wholly inside, right to left whatever it touches", keywords: "box select window selection crossing selection drag select marquee rubber band lasso area select many multiple", icon: <FilterIcon filter={usePicks.getState().filter} box size={14} />, keys: "B", tag: usePicks.getState().box ? "on" : undefined, run: () => toggleBox() },
      { id: "view:drawings", group: "View", title: drawings ? "Back to the 3D view" : "Engineering drawings", detail: drawings ? "Leave the drawing sheets" : "Dimensioned sheets for each part, ready to print or send", keywords: "drawing drawings blueprint 2d dimensions sheet pdf tolerance print", icon: <Icon.Doc size={14} />, keys: "D", run: () => (drawings ? closeDrawings() : openDrawings()) },
      { id: "view:drawings-gdt", group: "View", title: "Datums and GD&T on drawings", detail: "Geometric tolerances, fits for bearing seats and dowels, gear centre distances", keywords: "gd&t gdt geometric tolerancing datum datums feature control frame position flatness perpendicularity runout basic dimension fit fits h7 k6 bearing seat dowel centre distance backlash iso 1101 asme y14.5 surface finish ra", icon: <Icon.Doc size={14} />, run: () => openDrawings() },
      { id: "view:drawings-annotate", group: "View", title: "Radii, chamfers, angles and ordinates on drawings", detail: "Read off the views; dim_style: ordinate or chain, or write angle(), radius(), chamfer(), arc_length()", keywords: "angle angular dimension radius radii fillet round chamfer bevel ordinate baseline chain dimensioning arc length datum dimension style", icon: <Icon.Doc size={14} />, run: () => openDrawings() },
      { id: "view:drawings-tables", group: "View", title: "Hole tables, revisions, welds and surface finish on drawings", detail: "+ on the drawing toolbar: hole table, revision table, surface texture and weld symbols", keywords: "hole table hole chart tag revision table rev block change history weld symbol welding fillet weld iso 2553 surface finish texture roughness ra rz iso 1302 21920 lay machining symbol", icon: <Icon.Doc size={14} />, run: () => openDrawings() },
      { id: "view:pmi", group: "View", title: "PMI on the 3D model", detail: "Each part's drawing dimensions, fits, datums and GD&T on the model; export STEP AP242 with them", keywords: "pmi mbd model based definition 3d annotations dimensions on the model gd&t gdt datums tolerances fits feature control frame step ap242 semantic pmi cam inspection", icon: <Icon.Dimension size={14} />, tag: usePmiView.getState().on ? "on" : undefined, run: () => togglePmi() },
      { id: "view:drawings-views", group: "View", title: "Broken, auxiliary, crop, broken-out and exploded views", detail: "+ on the drawing toolbar, or break_view(), aux_view(), broken_out() and view(crop:, exploded:) in the drawing block", keywords: "broken view break long part shorten conventional break auxiliary view aux inclined face true size crop view partial view broken-out section local section partial section cutaway cut away exploded view explode assembly drawing", icon: <Icon.Doc size={14} />, run: () => openDrawings() },
      { id: "view:photo", group: "View", title: "Photoreal view", detail: "Path-traced light, reflections and soft shadows", keywords: "render rendering realistic ray trace pretty photo", icon: <Icon.Aperture size={14} />, keys: "P", tag: s.photoreal ? "on" : undefined, run: () => updateSettings({ photoreal: !s.photoreal }) },
      { id: "view:turntable", group: "View", title: "Turntable", detail: "Slowly orbit the model, for showing it off", keywords: "spin rotate orbit present show", icon: <Icon.Orbit size={14} />, keys: "T", tag: v.turntable ? "on" : undefined, run: () => useView.setState({ turntable: !v.turntable }) },
      ...LIGHTING_IDS.map((id): FindItem => ({ id: `view:light:${id}`, group: "View", title: `${cap(id)} lighting`, detail: "Lighting preset", keywords: "lighting light lights backdrop environment scene look", icon: <Icon.Sun size={14} />, keys: id === LIGHTING_IDS[0] ? "L" : undefined, tag: s.lighting === id ? "on" : undefined, run: () => updateSettings({ lighting: id }) })),
      { id: "view:grid", group: "View", title: "Grid", detail: "The floor grid under the model", keywords: "floor grid", icon: <Icon.Grid size={14} />, tag: s.grid ? "on" : undefined, run: () => updateSettings({ grid: !s.grid }) },
      { id: "view:edges", group: "View", title: "Edges", detail: "Outline every edge of the model", keywords: "outline lines wireframe", icon: <Icon.Box size={14} />, tag: s.edges ? "on" : undefined, run: () => updateSettings({ edges: !s.edges }) },
    );
    if (model) {
      const shownGroups = v.soloGroups;
      for (const g of partGroups(model.parts))
        push({
          id: `view:group:${g.name}`,
          group: "View",
          title: `Show ${g.name} on its own`,
          detail: `${g.ids.length} solid${g.ids.length === 1 ? "" : "s"}: ${g.blocks.slice(0, 5).join(", ")}${g.blocks.length > 5 ? "…" : ""}`,
          keywords: "group groups only solo isolate subassembly sub-assembly assembly show hide part grouping section system",
          icon: <Icon.Layers size={14} />,
          tag: shownGroups.includes(g.name) ? "on" : undefined,
          run: () => soloGroup(g.name),
        });
      if (shownGroups.length) push({ id: "view:group:all", group: "View", title: "Show every group", detail: `Now showing ${shownGroups.join(", ")}`, keywords: "group groups all unhide show everything reset", icon: <Icon.Eye size={14} />, run: () => showGroups([]) });
    }
    if (model) {
      for (const set of savedSets(model.name))
        push({ id: `view:set:${set.name}`, group: "View", title: `Pick the set “${set.name}”`, detail: "A saved selection set", keywords: "selection set saved selection named selection group of faces edges recall", icon: <FilterIcon filter={set.parts?.length ? "part" : (set.picks?.[0]?.kind ?? "part")} box={false} size={14} />, run: () => recallSet(set) });
      if (v.selected.length || usePicks.getState().picks.length) push({ id: "view:set:save", group: "View", title: "Save the selection as a set", detail: "Name it, to pick the same parts, faces or edges again later", keywords: "selection set save selection named selection remember group", icon: <Icon.Plus size={14} />, run: () => openSetNamer() });
    }
    if (v.selected.length || v.isolate) push({ id: "view:isolate", group: "View", title: "Isolate the selection", detail: "Show only the selected parts", keywords: "hide others solo only focus", icon: <Icon.Target size={14} />, keys: "I", tag: v.isolate ? "on" : undefined, run: () => useView.setState({ isolate: !v.isolate }) });
    if (hasMotion) push({ id: "view:play", group: "View", title: v.playing ? "Stop the mechanism" : "Run the mechanism", detail: "Turn the input and watch everything that moves", keywords: "play animate motion move run gears", icon: v.playing ? <Icon.Pause size={14} /> : <Icon.Play size={14} />, keys: "Space", tag: v.playing ? "on" : undefined, run: () => useView.setState({ playing: !v.playing }) });
    if (hasWires)
      push(
        { id: "view:wiring", group: "Machines", title: "Wiring view", detail: "Every cable and plug, in place", keywords: "wires cables harness plugs connectors electrical", icon: <Icon.Plug size={14} />, keys: "W", run: () => toggleWiring() },
        {
          id: "view:wiring-solid",
          group: "Machines",
          title: s.wiringSolid ? "Wiring with see-through covers" : "Wiring with solid parts",
          detail: s.wiringSolid ? "Covers over the wiring fade so the plugs under them show" : "Every part stays solid; cables behind parts show faintly through them",
          keywords: "wires cables wiring solid opaque transparent see through x-ray xray hidden behind show through whole complete covers fade",
          icon: <Icon.Plug size={14} />,
          run: () => {
            updateSettings({ wiringSolid: !s.wiringSolid });
            toggleWiring(true);
          },
        },
      );
    if (model?.machine?.components.length)
      push({
        id: "build:schematic",
        group: "Machines",
        title: "Schematic",
        detail: "The circuit as a schematic sheet: drag symbols, click two pins to wire them, save as SVG",
        keywords: "schematic circuit diagram symbols schematic capture ecad eda electrical drawing netlist draw wire connect pins kicad",
        icon: <Icon.Chip size={14} />,
        run: () => openSchematic(),
      });
    if (model && hasFitting(model)) push({ id: "view:fitting", group: "View", title: "How it goes on", detail: "Watch it fitted, and what keeps it there", keywords: "fit fitting mount install clip band attach", icon: <Icon.Assemble size={14} />, tag: useFitView.getState().on ? "on" : undefined, run: () => (useFitView.getState().on ? useFitView.setState({ on: false }) : playFitting()) });

    // ── exports ──
    if (model?.parts.length)
      push({ id: "film:make", group: "Export", title: "Make a showcase film", detail: "A short film of the design with captions, cards and music: pick the sections, then render an MP4", keywords: "film video showcase movie animation trailer reel promo turntable mp4 linkedin youtube instagram tiktok shorts reels presentation demo render animation exploded assembly", icon: <Icon.Film size={14} />, run: () => openFilmMaker() });
    for (const f of EXPORT_FORMATS) {
      if (f.shown && !f.shown()) continue;
      const I = (Icon as Record<string, (p: { size?: number }) => JSX.Element>)[f.icon] ?? Icon.Download;
      const g = EXPORT_GROUPS.find((x) => x.id === f.group)?.label ?? "";
      push({ id: `export:${f.id}`, group: "Export", title: `Export ${f.label.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())}`, detail: `${f.detail} · ${f.ext}`, keywords: `export download save file ${f.ext.replace(".", "")} ${g}`, icon: <I size={14} />, run: () => void runExport(f.id) });
    }

    // ── the design's configurations ──
    const configs = model?.configs;
    for (const r of configs?.rows ?? [])
      push({ id: `config:${r.label}`, group: "Model", title: `Show configuration “${r.label}”`, detail: r.note ?? (r.sets.map((s) => `${s.param} ${s.text}`).join(", ") || "No values of its own"), keywords: `configuration variant size ${configs!.title} ${r.label}`, icon: <Icon.Layers size={14} />, tag: r.label === configs!.active ? "on" : undefined, run: () => showConfiguration(r.label) });
    if (configs?.active !== undefined) push({ id: "config:none", group: "Model", title: "Show the parameters as written", detail: "No configuration: every parameter's own value", keywords: "configuration variant as written default no configuration", icon: <Icon.Layers size={14} />, run: () => showConfiguration(null) });

    // ── the design's parts ──
    const seen = new Set<string>();
    for (const p of model?.parts ?? []) {
      if (seen.has(p.name) || seen.size >= 200) continue;
      seen.add(p.name);
      const ids = model!.parts.filter((x) => x.name === p.name).map((x) => x.id);
      push({ id: `part:${p.name}`, group: "Parts", title: p.label, detail: `${p.kind === "component" ? "Bought part" : "Part"}${ids.length > 1 ? ` · ${ids.length} of them` : ""}${p.material ? ` · ${p.material}` : ""}`, keywords: p.name.replace(/_/g, " "), icon: <span className="find-swatch" style={{ background: p.color }} />, pane: "model", run: () => (select(ids), useView.setState({ leftTab: "structure" })) });
    }

    // ── the project ──
    push(
      { id: "proj:undo", group: "Project", title: "Undo", detail: "The last change, by you or Claude", keywords: "back revert", icon: <Icon.Undo size={14} />, keys: "Ctrl Z", run: undo },
      { id: "proj:redo", group: "Project", title: "Redo", keywords: "again forward", icon: <Icon.Redo size={14} />, keys: "Ctrl ⇧ Z", run: redo },
      { id: "proj:save", group: "Project", title: "Save now", detail: "Kerf also saves after every change", keywords: "save store keep", icon: <Icon.Check size={14} />, run: () => void flushPending().then(() => toast({ kind: "success", title: "Saved" }, 2000)) },
      { id: "proj:rename", group: "Project", title: "Rename the project", keywords: "name title", icon: <Icon.Edit size={14} />, run: () => requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".project-name")?.select()) },
      { id: "proj:duplicate", group: "Project", title: "Duplicate the project", detail: "A copy to try something on", keywords: "copy clone fork branch variant", icon: <Icon.Copy size={14} />, run: duplicateOpen },
      { id: "proj:home", group: "Project", title: "All projects", detail: "Back to the projects page", keywords: "home projects open close exit", icon: <Icon.Home size={14} />, run: () => void closeProject() },
    );
  }

  // ── starting points ──
  for (const t of TEMPLATES)
    push({ id: `new:${t.id}`, group: "New design", title: t.id === "blank" ? "New blank design" : `New: ${t.name}`, detail: t.tagline, keywords: `new create start template example ${t.stats} ${(t.shows ?? []).join(" ")}`, icon: <Icon.Plus size={14} />, run: () => void createProject(t.id).then((p) => openProject(p.id)) });

  // ── settings and help ──
  for (const x of SETTINGS_FIND) push({ id: `set:${x.tab}`, group: "Settings", title: x.title, detail: x.detail, keywords: `settings preferences options ${x.keywords}`, icon: <Icon.Settings size={14} />, run: () => openSettings(x.tab) });
  for (const x of SPEEDS) push({ id: `set:speed:${x.value}`, group: "Settings", title: `${x.label} speed`, detail: x.d, keywords: "speed fast quick slow careful thorough effort think claude ai", icon: <Icon.Bolt size={14} />, tag: s.speed === x.value ? "on" : undefined, run: () => updateSettings({ speed: x.value }) });
  push(
    { id: "set:options-first", group: "Settings", title: "Options first", detail: "Claude lays out two to four ways to do it for you to pick, before it builds anything", keywords: "options choices alternatives approaches choose pick ask first plan before building compare ideas variants claude ai", icon: <Icon.Fork size={14} />, tag: s.optionsFirst ? "on" : undefined, pane: "chat", run: () => updateSettings({ optionsFirst: !s.optionsFirst }) },
    { id: "set:thinking", group: "Settings", title: "Claude's reasoning", detail: "Show a summary of Claude's thinking at each step of its work", keywords: "thinking reasoning thought process steps why explain show hide claude ai", icon: <Icon.Bulb size={14} />, tag: s.showThinking ? "on" : undefined, run: () => updateSettings({ showThinking: !s.showThinking }) },
  );
  const light = currentTheme() === "light";
  push(
    { id: "set:theme", group: "Settings", title: light ? "Dark theme" : "Light theme", detail: "Switch the colours", keywords: "theme dark light mode night day colours colors", icon: <Icon.Sun size={14} />, run: () => setTheme(light ? "dark" : "light") },
    { id: "help:keys", group: "Settings", title: "Keyboard shortcuts", detail: "Every key Kerf knows", keywords: "keys shortcuts hotkeys keyboard help", icon: <Icon.Keyboard size={14} />, keys: "?", run: () => useUi.setState({ shortcutsOpen: true }) },
  );
  return out;
}
