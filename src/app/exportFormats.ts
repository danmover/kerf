// Every export Kerf offers, in one list the Export panel draws from. A
// feature with its own export (drawings, a build pack) adds an entry here
// that calls its own code, the way features add left-panel tabs through
// LEFT_TABS, so there is one place to find every file Kerf can make.

import { create } from "zustand";
import {
  copyViewImage,
  export3mfPlate,
  exportBom,
  exportGlb,
  exportObj,
  exportPng,
  exportPngSized,
  exportProjectFile,
  exportReport,
  exportSource,
  exportStep,
  exportStl,
  exportStlParts,
  exportUsdz,
  exportViewSheet,
} from "./exports";
import { errorText, toast } from "./ui";

export type ExportGroup = "model" | "print" | "image" | "document" | "project";

export const EXPORT_GROUPS: { id: ExportGroup; label: string }[] = [
  { id: "model", label: "3D model" },
  { id: "print", label: "Print" },
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
  run: (o: { selectionOnly: boolean }) => unknown;
}

export const EXPORT_FORMATS: ExportFormat[] = [
  { id: "step", group: "model", label: "STEP assembly", detail: "Exact solids for any CAD tool", ext: ".step", icon: "Cube", selection: true, run: (o) => exportStep(o.selectionOnly) },
  { id: "glb", group: "model", label: "glTF with materials", detail: "Blender, the web, game engines", ext: ".glb", icon: "Material", selection: true, run: (o) => exportGlb(o.selectionOnly) },
  { id: "usdz", group: "model", label: "USDZ for AR", detail: "Place it on your desk with an iPhone", ext: ".usdz", icon: "Orbit", selection: true, run: (o) => exportUsdz(o.selectionOnly) },
  { id: "obj", group: "model", label: "OBJ + materials", detail: "Renderers and mesh tools", ext: ".zip", icon: "Box", selection: true, run: (o) => exportObj(o.selectionOnly) },

  { id: "3mf-plate", group: "print", label: "Print plate", detail: "Every part to make, on its flattest side, in colour", ext: ".3mf", icon: "Grid", selection: true, run: (o) => export3mfPlate(o.selectionOnly) },
  { id: "stl-parts", group: "print", label: "STL per part", detail: "One file per part, named with how many", ext: ".zip", icon: "Layers", selection: true, run: (o) => exportStlParts(o.selectionOnly) },
  { id: "stl", group: "print", label: "STL, one mesh", detail: "The whole assembly in place", ext: ".stl", icon: "Layers", selection: true, run: (o) => exportStl(o.selectionOnly) },

  { id: "png", group: "image", label: "Picture of this view", detail: "1920 × 1200, fully refined", ext: ".png", icon: "Eye", run: () => exportPng() },
  { id: "png-4k", group: "image", label: "4K picture", detail: "3840 × 2400 for print and slides", ext: ".png", icon: "Eye", run: () => exportPngSized(3840, 2400, "4K") },
  { id: "sheet", group: "image", label: "Four-view sheet", detail: "Iso, front, top and right on one image", ext: ".png", icon: "Grid", run: () => exportViewSheet() },
  { id: "copy", group: "image", label: "Copy view", detail: "Paste into a chat, doc or email", ext: "clipboard", icon: "Copy", run: () => copyViewImage() },

  { id: "report", group: "document", label: "Design report", detail: "Brief, views, checks and parts; prints to PDF", ext: ".html", icon: "Doc", run: () => exportReport() },
  { id: "bom", group: "document", label: "Parts list", detail: "Quantities, make or buy, materials", ext: ".csv", icon: "List", run: () => exportBom() },

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
