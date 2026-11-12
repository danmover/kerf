// Every export Kerf offers, in one list the Export panel draws from. A
// feature with its own export (drawings, a build pack) adds an entry here
// that calls its own code, the way features add left-panel tabs through
// LEFT_TABS, so there is one place to find every file Kerf can make.

import { create } from "zustand";
import {
  copyViewImage,
  export3mfPlate,
  exportBom,
  exportBuildPack,
  exportGerbers,
  exportGlb,
  exportObj,
  exportPhotoreal,
  exportPng,
  exportPngSized,
  exportProjectFile,
  exportReport,
  exportSource,
  exportStep,
  exportStepWithPmi,
  exportStl,
  exportStlParts,
  exportUsdz,
  exportViewSheet,
} from "./exports";
import { errorText, toast } from "./ui";
import { useDesign } from "../core/engine";
import { viewport } from "./viewportApi";
import { exportDrawingsPdf, exportFlatPatternsDxf } from "../drawing/export";
import { useAnalysis } from "../analysis/runtime";
import { fileStem, outlineDxf, shapeStl } from "../analysis/topologyExport";
import { download } from "../persist/files";

async function exportDrawings() {
  await exportDrawingsPdf();
  toast({ kind: "success", title: "Drawings exported", detail: "Every sheet in one PDF, with dimensions and tolerances." });
}

/** The shapes the design's topology optimisations have found, with each one's plate profile when it has one. */
function topologyShapes() {
  const runs = useAnalysis.getState().runs;
  return (useDesign.getState().model?.analyses ?? []).flatMap((a) => {
    const r = a.kind === "structural" && a.topology ? runs.get(a.label)?.result : undefined;
    return r?.topology ? [{ label: a.label, r, dxf: outlineDxf(r) }] : [];
  });
}

/** The same files the Analysis tab's STL and DXF profile buttons give, one per topology optimisation. */
function exportTopology(kind: "stl" | "dxf") {
  const shapes = topologyShapes().filter((s) => kind === "stl" || s.dxf);
  for (const s of shapes) {
    if (kind === "stl") download(shapeStl(s.r, `Kerf: ${s.label}`), `${fileStem(s.label)}.stl`, "model/stl");
    else download(s.dxf!, `${fileStem(s.label)}.dxf`, "application/dxf");
  }
  const what = kind === "stl" ? "shape" : "profile";
  toast({ kind: "success", title: shapes.length === 1 ? `Topology ${what} exported` : `${shapes.length} topology ${what}s exported`, detail: kind === "stl" ? "The shape found, in millimetres, to print or to model over." : "The profile 1:1 in millimetres, for a laser, waterjet or router." });
}

export type ExportGroup = "model" | "print" | "image" | "document" | "project";

export const EXPORT_GROUPS: { id: ExportGroup; label: string }[] = [
  { id: "model", label: "3D model" },
  { id: "print", label: "Make" },
  { id: "image", label: "Images" },
  { id: "document", label: "Documents" },
  { id: "project", label: "Project" },
];

export interface ExportFormat {
  id: string;
  group: ExportGroup;
  label: string;
  /** one line: what it is for */
  detail: string;
  /** shown as a badge: ".step" */
  ext: string;
  /** a key of ui/icons Icon */
  icon: string;
  /** can export just the selected parts */
  selection?: boolean;
  /** greys the entry out with this reason */
  unavailable?: () => string | null;
  /** leaves the entry out when this returns false (formats only some designs have) */
  shown?: () => boolean;
  run: (o: { selectionOnly: boolean }) => unknown;
}

export const EXPORT_FORMATS: ExportFormat[] = [
  { id: "step", group: "model", label: "STEP assembly", detail: "Exact solids for any CAD tool", ext: ".step", icon: "Cube", selection: true, run: (o) => exportStep(o.selectionOnly) },
  { id: "step-pmi", group: "model", label: "STEP with PMI (AP242)", detail: "Solids with each part's dimensions, fits, datums and tolerances on their faces, for CAM and inspection", ext: ".step", icon: "Target", selection: true, run: (o) => exportStepWithPmi(o.selectionOnly) },
  { id: "glb", group: "model", label: "glTF with materials", detail: "Blender, the web, game engines", ext: ".glb", icon: "Material", selection: true, run: (o) => exportGlb(o.selectionOnly) },
  { id: "usdz", group: "model", label: "USDZ for AR", detail: "Place it on your desk with an iPhone", ext: ".usdz", icon: "Orbit", selection: true, run: (o) => exportUsdz(o.selectionOnly) },
  { id: "obj", group: "model", label: "OBJ + materials", detail: "Renderers and mesh tools", ext: ".zip", icon: "Box", selection: true, run: (o) => exportObj(o.selectionOnly) },

  { id: "build-pack", group: "print", label: "Build pack", detail: "Parts to buy and make, wiring, firmware and tests", ext: ".zip", icon: "Wrench", shown: () => !!useDesign.getState().model?.machine, run: () => exportBuildPack() },
  { id: "gerbers", group: "print", label: "Circuit board Gerbers", detail: "Copper, mask, silkscreen and drill files for a board house", ext: ".zip", icon: "Chip", shown: () => !!useDesign.getState().model?.machine?.boards.length, run: () => exportGerbers() },
  {
    id: "flat-patterns",
    group: "print",
    label: "Flat patterns",
    detail: "Sheet-metal blanks at 1:1 with bend lines, for the laser or punch",
    ext: ".dxf",
    icon: "Scissors",
    shown: () => !!useDesign.getState().model?.parts.some((p) => p.sheet),
    run: async () => {
      const n = await exportFlatPatternsDxf();
      toast({ kind: "success", title: n === 1 ? "Flat pattern exported" : `${n} flat patterns exported`, detail: "Outlines and holes on the CUT layer, bend lines on BEND, 1:1 in millimetres." });
    },
  },
  { id: "3mf-plate", group: "print", label: "Print plate", detail: "Every part to make, turned to print, in colour", ext: ".3mf", icon: "Grid", selection: true, run: (o) => export3mfPlate(o.selectionOnly) },
  { id: "stl-parts", group: "print", label: "STL per part", detail: "One file per part, named with how many", ext: ".zip", icon: "Layers", selection: true, run: (o) => exportStlParts(o.selectionOnly) },
  { id: "stl", group: "print", label: "STL, one mesh", detail: "The whole assembly in place", ext: ".stl", icon: "Layers", selection: true, run: (o) => exportStl(o.selectionOnly) },
  { id: "topology-stl", group: "print", label: "Topology shape", detail: "The shape a topology optimisation found, to print or to model over", ext: ".stl", icon: "Wand", shown: () => topologyShapes().length > 0, run: () => exportTopology("stl") },
  { id: "topology-dxf", group: "print", label: "Topology profile", detail: "The found shape's plate profile 1:1, for a laser, waterjet or router", ext: ".dxf", icon: "Wand", shown: () => topologyShapes().some((s) => s.dxf), run: () => exportTopology("dxf") },

  { id: "png", group: "image", label: "Picture of this view", detail: "1920 × 1200, fully refined", ext: ".png", icon: "Eye", run: () => exportPng() },
  { id: "png-4k", group: "image", label: "4K picture", detail: "3840 × 2400 for print and slides", ext: ".png", icon: "Eye", run: () => exportPngSized(3840, 2400, "4K") },
  { id: "photoreal", group: "image", label: "Photoreal picture", detail: "Path traced until clean, at the view's size", ext: ".png", icon: "Aperture", unavailable: () => viewport()?.photoBlocker() ?? null, run: () => exportPhotoreal() },
  { id: "sheet", group: "image", label: "Four-view sheet", detail: "Iso, front, top and right on one image", ext: ".png", icon: "Grid", run: () => exportViewSheet() },
  { id: "copy", group: "image", label: "Copy view", detail: "Paste into a chat, doc or email", ext: "clipboard", icon: "Copy", run: () => copyViewImage() },

  { id: "drawings", group: "document", label: "Engineering drawings", detail: "Every sheet, dimensioned, in one PDF", ext: ".pdf", icon: "Doc", run: () => exportDrawings() },
  { id: "report", group: "document", label: "Design report", detail: "Brief, views, checks and parts; prints to PDF", ext: ".html", icon: "Doc", run: () => exportReport() },
  { id: "bom", group: "document", label: "Parts list", detail: "Quantities, make or buy, materials", ext: ".csv", icon: "List", run: () => exportBom() },

  {
    id: "app-html",
    group: "project",
    label: "App as a program",
    detail: "The design's app in one file that runs on its own in Chrome or Edge: the simulated twin and USB",
    ext: ".html",
    icon: "Graph",
    shown: () => !!useDesign.getState().model?.apps?.length,
    run: async () => (await import("../apps/export")).exportStandaloneApp(),
  },
  {
    id: "app-desktop",
    group: "project",
    label: "App as a desktop program",
    detail: "An Electron project around the app, to run on its own or build an installer from",
    ext: ".zip",
    icon: "Box",
    shown: () => !!useDesign.getState().model?.apps?.length,
    run: async () => (await import("../apps/export")).exportDesktopApp(),
  },
  { id: "project", group: "project", label: "Project with history", detail: "Every version, references and imports", ext: ".kerfproj", icon: "Doc", run: () => exportProjectFile() },
  { id: "source", group: "project", label: "Design source", detail: "The design.kerf file", ext: ".kerf", icon: "Code", run: () => exportSource() },
];

const LAST_KEY = "kerf.export.last";
const readLast = () => {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
};

interface ExportState {
  /** the export in progress */
  running: string | null;
  /** the last export that finished, for the button's done flash */
  done: { id: string; at: number } | null;
  /** the format used last, offered first next time */
  last: string | null;
}

export const useExports = create<ExportState>(() => ({ running: null, done: null, last: readLast() }));

export const exportFormat = (id: string | null) => EXPORT_FORMATS.find((f) => f.id === id) ?? null;

export async function runExport(id: string, opts: { selectionOnly?: boolean } = {}) {
  const f = exportFormat(id);
  if (!f || useExports.getState().running) return;
  const why = f.unavailable?.();
  if (why) return toast({ kind: "warn", title: `${f.label} isn't available`, detail: why });
  useExports.setState({ running: id, last: id });
  try {
    localStorage.setItem(LAST_KEY, id);
  } catch {
    /* remembering is a nicety */
  }
  try {
    await f.run({ selectionOnly: !!opts.selectionOnly && !!f.selection });
    useExports.setState({ done: { id, at: Date.now() } });
  } catch (e) {
    toast({ kind: "error", title: `${f.label} failed`, detail: errorText(e) }, 9000);
  } finally {
    useExports.setState({ running: null });
  }
}
