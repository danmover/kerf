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
import { useView, requestCamera, select, toggleCode, type ViewPreset } from "../app/view";
import { useSettings, updateSettings, LIGHTING_IDS } from "../app/settings";
import { openSettings, useUi, toast, type SettingsTab } from "../app/ui";
import { undo, redo, closeProject, duplicateProject, flushPending, useProject, createProject, openProject } from "../app/project";
import { currentTheme, setTheme } from "../app/theme";
import { EXPORT_FORMATS, EXPORT_GROUPS, runExport } from "../app/exportFormats";
import { pluginOn } from "../plugins";
import { openCreatureDialog } from "../plugins/organic/CreatureDialog";
import { importStepFiles } from "../app/imports";
import { TEMPLATES } from "../demos/templates";
import { openDrawings, closeDrawings, useDrawings } from "../drawing/engine";
import { ANALYSIS_KINDS, kindsFor } from "./analysisKinds";
import { openAnalysis } from "./AnalysisPanel";
import { CATEGORY_LABEL } from "./ChecksPanel";
import { DOCK_TABS } from "./Dock";
import { LEFT_TABS } from "./LeftPanel";
import { toggleMarkup } from "./Markup";
import { toggleWiring } from "./wiringView";
import { RulerIcon, toggleMeasure } from "./viewport/MeasureTool";
import { playFitting, useFitView } from "./FitLayer";
import { hasFitting } from "../analysis/fitting";
import { exitSketch, startPicking, useSketch } from "./sketch/session";
import { STEP_ACCEPT } from "./ImportsPanel";
import { FIX_IT_UP, MAKE_BUILDABLE } from "./ModelTools";
import { askClaude, REVIEW_ASK } from "./chatDraft";
import { Icon } from "./icons";
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
  analysis: { detail: "Strength, drop, vibration, airflow, gear and bike rule runs", keywords: "fea stress airflow aero wind results analyses" },
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
  make: { detail: "How each part is made: process, machine limits, cost and time", keywords: "manufacturing manufacture dfm process cost print cnc quote factory production" },
  bom: { detail: "Quantities, make or buy, prices and where to buy", keywords: "bom bill of materials buy shopping order cost price suppliers" },
  graph: { detail: "How the parts and features depend on each other", keywords: "dependencies dependency structure network" },
  code: { title: "Design file (design.kerf)", detail: "The design as text: edit it by hand", keywords: "code source editor text script file kerf language" },
  structure: { title: "Parts", detail: "Every part and component, grouped as in the design", keywords: "tree structure components assembly hierarchy outline" },
  params: { title: "Parameters", detail: "The sizes you can scrub, grouped as in the design", keywords: "params dimensions sizes variables sliders values" },
  sketches: { detail: "2D profiles with dimensions and constraints", keywords: "sketch profile 2d constraints outline" },
  decisions: { title: "Design decisions", detail: "The choices made, and the options not taken", keywords: "options alternatives choices tradeoffs trade offs" },
  history: { detail: "Every version: compare and restore", keywords: "versions undo restore compare timeline revisions changes" },
};

const SETTINGS_FIND: { tab: SettingsTab; title: string; detail: string; keywords: string }[] = [
  { tab: "ai", title: "AI: key, model and cost", detail: "Your Claude or OpenAI key, the model, effort, self-review and cost", keywords: "claude openai gpt api key model effort review cost tokens claude code mcp plan" },
  { tab: "account", title: "Account and sync", detail: "Sign in to sync projects between devices", keywords: "sign in login cloud sync devices" },
  { tab: "voice", title: "Voice input", detail: "Talk to Claude instead of typing", keywords: "speech microphone dictate talk" },
  { tab: "app", title: "Display", detail: "Theme, viewport, motion and graphics card", keywords: "theme dark light viewport graphics gpu motion animation" },
  { tab: "making", title: "Making: your tools and parts", detail: "Processes you can use, your machines, parts you have and costs", keywords: "workshop 3d printer cnc laser own machines processes parts on hand inventory labour" },
  { tab: "plugins", title: "Plugins", detail: "Switch Kerf's plugins on or off: creatures and characters", keywords: "plugins extensions add-ons creatures characters animals organic" },
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
    for (const t of LEFT_TABS) {
      const f = TAB_FIND[t.id];
      push({ id: `left:${t.id}`, group: "Panels", title: f?.title ?? cap(t.label), detail: f?.detail, keywords: f?.keywords, icon: t.icon, pane: "model", run: () => useView.setState({ leftTab: t.id }) });
    }

    // ── modelling ──
    const sketching = useSketch.getState();
    push(
      { id: "model:tools", group: "Model", title: "Modelling tools", detail: "Box, cylinder, hole, fillet, chamfer, shell, move, turn, copy: model it yourself, then let Claude fix it up", keywords: "advanced manual direct edit extrude cad tools hand", icon: <Icon.Wrench size={14} />, tag: s.advanced ? "on" : undefined, run: () => updateSettings({ advanced: !s.advanced }) },
      { id: "model:sketch", group: "Model", title: sketching.active || sketching.picking ? "Leave the sketch" : "New sketch", detail: "Draw a 2D profile on a face or plane, with dimensions, and extrude or revolve it", keywords: "sketch draw profile 2d extrude revolve constraint", icon: <T.Sketch size={14} />, run: () => (sketching.active || sketching.picking ? exitSketch() : startPicking()) },
      { id: "model:markup", group: "Model", title: "Draw on the view for Claude", detail: "Circle or scribble on the model and say what to change there", keywords: "markup annotate scribble sketch on screen pen highlight", icon: <Icon.Edit size={14} />, keys: "M", run: () => toggleMarkup() },
      { id: "model:step", group: "Model", title: "Import a STEP file", detail: "Bring in a part from another CAD tool to design around", keywords: "import step stp cad file part load open", icon: <Icon.Upload size={14} />, run: pickStep },
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
      push(ask(`ask:analysis:${k.id}`, "Analyse", `Add ${k.id === "uci" ? "a UCI rules check" : `a${/^[aeiou]/i.test(k.label) ? "n" : ""} ${k.label.toLowerCase()} analysis`}`, k.detail, `${k.keywords} analysis analyse test`, k.ask, <I size={14} />));
    }

    // ── making ──
    push(
      ask("ask:mould", "Make", "Make a mould", "A two-part printed mould made from the part with mould(): keys, bolts, pour hole and vents", "mould mold casting cast resin silicone urethane polyurethane", "Make a two-part mould for the part I want to cast (ask me which if it isn't clear) with mould(): registration keys, clamping bolts, a pour hole and vents, split where it releases cleanly, and check it opens.", <Icon.Factory size={14} />),
      ask("ask:sheet", "Make", "Make it from sheet metal", "Bent parts with sheet(): bend radii, reliefs, flat patterns and a laser DXF", "sheet metal bend fold brake laser flat pattern dxf aluminium steel chassis", "Rebuild the parts that suit it as bent sheet metal with sheet(): real bend radii and reliefs, flat patterns with bend tables and a DXF for laser cutting, and check every bend and flange.", <Icon.Layers size={14} />),
      ask("ask:carbon", "Make", "Plan a carbon fibre layup", "Ply book, orientations, weights and how it comes out of the mould", "carbon fibre fiber composite layup ply prepreg monocoque", "Plan the carbon fibre layup for the carbon parts: a ply book with orientations and weights, where the mould splits, and how each part comes out of it.", <Icon.Layers size={14} />),
      ask("ask:factory", "Make", "Get it ready for a factory", "Drawings, materials, tolerances and a list of what to send for a quote", "factory quote manufacturer production supplier rfq send order batch", "Get this design ready to send to a factory for a quote: the processes and materials, drawings with the tolerances that matter, quantities, and a list of what to send and what to ask them.", <Icon.Factory size={14} />),
      { id: "make:tools", group: "Make", title: "Tools you have", detail: "Your printer, laser, CNC and the processes you can order, so the checks fit what you can really make", keywords: "workshop machines processes own printer 3d printer cnc laser parts on hand inventory", icon: <Icon.Wrench size={14} />, run: () => openSettings("making") },
    );

    // ── views ──
    const hasMotion = !!model?.parts.some((p) => turns(p.motion));
    const hasWires = !!model?.machine && model.machine.wires.length + model.machine.nets.length > 0;
    const drawings = useDrawings.getState().open;
    const cams: [ViewPreset, string, string?][] = [["iso", "Iso"], ["front", "Front", "2"], ["back", "Back"], ["left", "Left"], ["right", "Right", "3"], ["top", "Top", "4"], ["bottom", "Bottom"]];
    push(
      { id: "view:fit", group: "View", title: "Fit to view", detail: "Frame the whole model", keywords: "zoom all frame reset camera", icon: <Icon.Fit size={14} />, keys: "F", run: () => requestCamera("fit") },
      ...cams.map(([p, label, k]): FindItem => ({ id: `view:cam:${p}`, group: "View", title: `${label} view`, detail: "Camera", keywords: "camera angle look from orientation", icon: <Icon.Cube size={14} />, keys: p === "iso" ? "1" : k, run: () => requestCamera(p) })),
      { id: "view:section", group: "View", title: "Section view", detail: "Cut the model open along X, Y or Z", keywords: "cut cross section slice clip inside", icon: <Icon.Scissors size={14} />, keys: "S", tag: v.section.on ? "on" : undefined, run: () => useView.setState({ section: { ...v.section, on: !v.section.on } }) },
      { id: "view:explode", group: "View", title: "Exploded view", detail: "Pull the parts apart", keywords: "explode apart spread assembly", icon: <Icon.Explode size={14} />, keys: "E", tag: v.explode > 0 ? "on" : undefined, run: () => useView.setState({ explode: v.explode > 0 ? 0 : 0.5 }) },
      { id: "view:assembly", group: "View", title: "Play the assembly", detail: "Watch the parts go together in design order", keywords: "assemble animation build order instructions", icon: <Icon.Assemble size={14} />, keys: "A", run: () => useView.setState({ explode: 0, assemblyRequest: v.assemblyRequest + 1 }) },
      { id: "view:xray", group: "View", title: "X-ray", detail: "See through the parts", keywords: "transparent see through ghost inside", icon: <Icon.Xray size={14} />, keys: "X", tag: v.xray ? "on" : undefined, run: () => useView.setState({ xray: !v.xray }) },
      { id: "view:measure", group: "View", title: "Measure", detail: "Distances, angles and sizes between what you click", keywords: "ruler distance dimension size gap angle", icon: <RulerIcon size={14} />, keys: "R", run: () => toggleMeasure() },
      { id: "view:drawings", group: "View", title: drawings ? "Back to the 3D view" : "Engineering drawings", detail: drawings ? "Leave the drawing sheets" : "Dimensioned sheets for each part, ready to print or send", keywords: "drawing drawings blueprint 2d dimensions sheet pdf tolerance print", icon: <Icon.Doc size={14} />, keys: "D", run: () => (drawings ? closeDrawings() : openDrawings()) },
      { id: "view:photo", group: "View", title: "Photoreal view", detail: "Path-traced light, reflections and soft shadows", keywords: "render rendering realistic ray trace pretty photo", icon: <Icon.Aperture size={14} />, keys: "P", tag: s.photoreal ? "on" : undefined, run: () => updateSettings({ photoreal: !s.photoreal }) },
      { id: "view:turntable", group: "View", title: "Turntable", detail: "Slowly orbit the model, for showing it off", keywords: "spin rotate orbit present show", icon: <Icon.Orbit size={14} />, keys: "T", tag: v.turntable ? "on" : undefined, run: () => useView.setState({ turntable: !v.turntable }) },
      ...LIGHTING_IDS.map((id): FindItem => ({ id: `view:light:${id}`, group: "View", title: `${cap(id)} lighting`, detail: "Lighting preset", keywords: "lighting light lights backdrop environment scene look", icon: <Icon.Sun size={14} />, keys: id === LIGHTING_IDS[0] ? "L" : undefined, tag: s.lighting === id ? "on" : undefined, run: () => updateSettings({ lighting: id }) })),
      { id: "view:grid", group: "View", title: "Grid", detail: "The floor grid under the model", keywords: "floor grid", icon: <Icon.Grid size={14} />, tag: s.grid ? "on" : undefined, run: () => updateSettings({ grid: !s.grid }) },
      { id: "view:edges", group: "View", title: "Edges", detail: "Outline every edge of the model", keywords: "outline lines wireframe", icon: <Icon.Box size={14} />, tag: s.edges ? "on" : undefined, run: () => updateSettings({ edges: !s.edges }) },
    );
    if (v.selected.length || v.isolate) push({ id: "view:isolate", group: "View", title: "Isolate the selection", detail: "Show only the selected parts", keywords: "hide others solo only focus", icon: <Icon.Target size={14} />, keys: "I", tag: v.isolate ? "on" : undefined, run: () => useView.setState({ isolate: !v.isolate }) });
    if (hasMotion) push({ id: "view:play", group: "View", title: v.playing ? "Stop the mechanism" : "Run the mechanism", detail: "Turn the input and watch everything that moves", keywords: "play animate motion move run gears", icon: v.playing ? <Icon.Pause size={14} /> : <Icon.Play size={14} />, keys: "Space", tag: v.playing ? "on" : undefined, run: () => useView.setState({ playing: !v.playing }) });
    if (hasWires) push({ id: "view:wiring", group: "Machines", title: "Wiring view", detail: "Every cable and plug, in place", keywords: "wires cables harness plugs connectors electrical", icon: <Icon.Plug size={14} />, keys: "W", run: () => toggleWiring() });
    if (model && hasFitting(model)) push({ id: "view:fitting", group: "View", title: "How it goes on", detail: "Watch it fitted, and what keeps it there", keywords: "fit fitting mount install clip band attach", icon: <Icon.Assemble size={14} />, tag: useFitView.getState().on ? "on" : undefined, run: () => (useFitView.getState().on ? useFitView.setState({ on: false }) : playFitting()) });

    // ── exports ──
    for (const f of EXPORT_FORMATS) {
      if (f.shown && !f.shown()) continue;
      const I = (Icon as Record<string, (p: { size?: number }) => JSX.Element>)[f.icon] ?? Icon.Download;
      const g = EXPORT_GROUPS.find((x) => x.id === f.group)?.label ?? "";
      push({ id: `export:${f.id}`, group: "Export", title: `Export ${f.label.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())}`, detail: `${f.detail} · ${f.ext}`, keywords: `export download save file ${f.ext.replace(".", "")} ${g}`, icon: <I size={14} />, run: () => void runExport(f.id) });
    }

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
  if (pluginOn("organic"))
    push({ id: "new:creature", group: "New design", title: "Make a creature", detail: "Describe an animal, person or pet, or drop in a reference sheet, and Claude models it", keywords: "creature animal pet character person people organic sculpt meshy tripo roblox game low poly figurine", icon: <Icon.Sparkle size={14} />, run: openCreatureDialog });
  for (const t of TEMPLATES)
    push({ id: `new:${t.id}`, group: "New design", title: t.id === "blank" ? "New blank design" : `New: ${t.name}`, detail: t.tagline, keywords: `new create start template example ${t.stats} ${(t.shows ?? []).join(" ")}`, icon: <Icon.Plus size={14} />, run: () => void createProject(t.id).then((p) => openProject(p.id)) });

  // ── settings and help ──
  for (const x of SETTINGS_FIND) push({ id: `set:${x.tab}`, group: "Settings", title: x.title, detail: x.detail, keywords: `settings preferences options ${x.keywords}`, icon: <Icon.Settings size={14} />, run: () => openSettings(x.tab) });
  const light = currentTheme() === "light";
  push(
    { id: "set:theme", group: "Settings", title: light ? "Dark theme" : "Light theme", detail: "Switch the colours", keywords: "theme dark light mode night day colours colors", icon: <Icon.Sun size={14} />, run: () => setTheme(light ? "dark" : "light") },
    { id: "help:keys", group: "Settings", title: "Keyboard shortcuts", detail: "Every key Kerf knows", keywords: "keys shortcuts hotkeys keyboard help", icon: <Icon.Keyboard size={14} />, keys: "?", run: () => useUi.setState({ shortcutsOpen: true }) },
  );
  return out;
}
