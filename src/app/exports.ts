// Export actions shared by the top bar menu and keyboard shortcuts.

import { kernel } from "../kernel/client";
import { meshes, useDesign, whenChecked, whenRefined } from "../core/engine";
import { bomCsv, download, safeFileName, writeStl } from "../persist/files";
import { exportProject, useProject } from "./project";
import { useView } from "./view";
import { viewport } from "./viewportApi";
import { toast, errorText, dismissToast } from "./ui";

function visibleParts(selectionOnly: boolean) {
  const { model } = useDesign.getState();
  if (!model) return [];
  const { hiddenIds, selected } = useView.getState();
  return model.parts.filter((p) => !p.hidden && !hiddenIds.includes(p.id) && (!selectionOnly || selected.includes(p.id)));
}

const baseName = () => useProject.getState().current?.name ?? useDesign.getState().model?.name ?? "design";

export async function exportStep(selectionOnly = false) {
  const parts = visibleParts(selectionOnly);
  if (!parts.length) return toast({ kind: "warn", title: "Nothing to export", detail: selectionOnly ? "Select one or more parts first." : "The design has no visible parts." });
  const t = toast({ kind: "info", title: "Preparing STEP…", detail: "Exporting exact B-rep solids from the kernel." }, 0);
  try {
    await whenChecked();
    const items = parts.filter((p) => meshes.has(p.hash)).map((p) => ({ hash: p.hash, xf: p.xf, name: p.id, color: p.color }));
    const data = await kernel.exportStep(items);
    download(data, safeFileName(baseName() + (selectionOnly ? " selection" : ""), "step"), "application/step");
    toast({ kind: "success", title: "STEP exported", detail: `${items.length} solids in millimetres, ready for other CAD tools.` });
  } catch (e) {
    toast({ kind: "error", title: "STEP export failed", detail: errorText(e) }, 9000);
  } finally {
    dismissToast(t);
  }
}

export async function exportStl(selectionOnly = false) {
  const parts = visibleParts(selectionOnly);
  if (!parts.length) return toast({ kind: "warn", title: "Nothing to export", detail: selectionOnly ? "Select one or more parts first." : "The design has no visible parts." });
  await whenRefined();
  const items = parts.map((p) => ({ mesh: meshes.get(p.hash)?.final ?? meshes.get(p.hash)?.preview, xf: p.xf })).filter((x): x is { mesh: NonNullable<typeof x.mesh>; xf: typeof x.xf } => !!x.mesh);
  if (!items.length) return toast({ kind: "warn", title: "The geometry is still building", detail: "Try again in a moment." });
  download(writeStl(items, `Kerf: ${baseName()}`), safeFileName(baseName() + (selectionOnly ? " selection" : ""), "stl"), "model/stl");
  toast({ kind: "success", title: "STL exported", detail: `${items.length} solids, fine tessellation, millimetres.` });
}

export function exportSource() {
  const { source } = useDesign.getState();
  download(source, safeFileName(baseName(), "kerf"), "text/plain");
}

export function exportBom() {
  const { model } = useDesign.getState();
  if (model) download(bomCsv(model), safeFileName(baseName() + " BOM", "csv"), "text/csv");
}

export async function exportPng() {
  const vp = viewport();
  if (!vp) return;
  const url = await vp.capture({ view: "current", width: 1920, height: 1200, mime: "image/png" });
  const bin = atob(url.split(",")[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  download(bytes, safeFileName(baseName(), "png"), "image/png");
}

export async function exportProjectFile() {
  const id = useProject.getState().current?.id;
  if (id) await exportProject(id);
}
