// Export actions shared by the top bar menu and keyboard shortcuts.

import { detailKernel, kernel } from "../kernel/client";
import { meshes, useDesign, whenChecked, whenRefined } from "../core/engine";
import { detailImportsLoaded, recipeUsesImport } from "../core/imports";
import { bomCsv, download, safeFileName, writeStl } from "../persist/files";
import { buildPack } from "../machine/pack";
import { boardSpecs } from "../machine/boards";
import { routeFor } from "../machine/pcb/runtime";
import { zip } from "../machine/zip";
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

/** Exact STEP of placed parts, with their full detail; the STEP export and the build pack share it. */
async function stepOf(parts: ReturnType<typeof visibleParts>) {
  await whenRefined();
  const items = parts.filter((p) => meshes.has(p.hash)).map((p) => ({ hash: p.hash, xf: p.xf, name: p.id, color: p.color, recipe: p.recipe }));
  // the detail worker holds the real threads and cosmetic detail; the main one builds them if it has to
  if (detailKernel.status !== "error") detailKernel.start();
  // imported STEP bodies are exported from the detail worker too, so it needs the files
  if (detailKernel.status !== "error" && parts.some((p) => p.imported || recipeUsesImport(p.recipe))) await detailImportsLoaded();
  return { data: await (detailKernel.status === "error" ? kernel : detailKernel).exportStep(items), count: items.length };
}

export async function exportStep(selectionOnly = false) {
  const parts = visibleParts(selectionOnly);
  if (!parts.length) return toast({ kind: "warn", title: "Nothing to export", detail: selectionOnly ? "Select one or more parts first." : "The design has no visible parts." });
  const t = toast({ kind: "info", title: "Preparing STEP…", detail: "Exporting exact B-rep solids from the kernel." }, 0);
  try {
    const { data, count } = await stepOf(parts);
    download(data, safeFileName(baseName() + (selectionOnly ? " selection" : ""), "step"), "application/step");
    toast({ kind: "success", title: "STEP exported", detail: `${count} solids in millimetres, ready for other CAD tools.` });
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

/** The build pack name keeps spaces, unlike other exports, so it reads well in a downloads folder. */
const packName = (s: string) => s.replace(/[^A-Za-z0-9 _.()-]+/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "design";

let packBusy: Promise<void> | null = null;

/** Everything needed to order, make, wire, program and test the machine, as one zip. */
export function exportBuildPack(): Promise<void> {
  packBusy ??= makeBuildPack().finally(() => (packBusy = null));
  return packBusy;
}

async function makeBuildPack() {
  if (!useDesign.getState().model?.machine) {
    toast({ kind: "warn", title: "No build pack for this design", detail: "Build packs are for machines: designs with catalog parts, wiring or firmware." });
    return;
  }
  const t = toast({ kind: "info", title: "Preparing the build pack…", detail: "Waiting for the final geometry and checks, then writing every file." }, 0);
  try {
    await whenRefined();
    await whenChecked();
    const { model, report } = useDesign.getState();
    if (!model?.machine) throw new Error("The design changed and no longer has machine data.");
    const parts = visibleParts(false).filter((p) => meshes.has(p.hash));
    let step: ArrayBuffer | undefined;
    let stepNote = "";
    if (parts.length) {
      try {
        step = (await stepOf(parts)).data;
      } catch (e) {
        stepNote = ` The STEP file was left out: ${errorText(e)}`;
      }
    }
    const name = baseName();
    // the board runtime's finished routes; a board still routing is routed by the pack itself (about a second)
    const boards = boardSpecs(model.machine).flatMap(({ spec }) => {
      const r = routeFor(spec);
      return r.status === "done" ? [r.board] : [];
    });
    const files = buildPack(model, report, { name, step, boards, meshFor: (p) => meshes.get(p.hash)?.final ?? meshes.get(p.hash)?.preview });
    const folder = `${packName(name)} build pack`;
    const data = zip(files.map((f) => ({ path: `${folder}/${f.path}`, data: f.data })));
    download(data, `${folder}.zip`, "application/zip");
    const stl = files.filter((f) => f.path.endsWith(".stl")).length;
    toast({ kind: "success", title: "Build pack downloaded", detail: `${files.length} files${stl ? `, ${stl} to print or make` : ""}. Start with README.md.${stepNote}` }, stepNote ? 9000 : undefined);
  } catch (e) {
    toast({ kind: "error", title: "Could not make the build pack", detail: errorText(e) }, 9000);
  } finally {
    dismissToast(t);
  }
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
  const url = await vp.capture({ view: "current", width: 1920, height: 1200, mime: "image/png", samples: 64 });
  const bin = atob(url.split(",")[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  download(bytes, safeFileName(baseName(), "png"), "image/png");
}

export async function exportProjectFile() {
  const id = useProject.getState().current?.id;
  if (id) await exportProject(id);
}
