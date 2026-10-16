// Drawing files and pictures: PDF of every sheet, SVG and DXF of one, a PNG
// for the assistant to look at, and a plain-text account of a sheet.

import { useDesign } from "../core/engine";
import { download, safeFileName } from "../persist/files";
import { dismissToast, errorText, toast } from "../app/ui";
import { allSheets, drawingSpecs, sheetFor, useDrawings } from "./engine";
import { sheetsToPdf, sheetToDxf, sheetToSvg } from "./render";
import type { Sheet } from "./sheet";
import { blockNameFor, specToSource } from "./source";
import { scaleText } from "./spec";

const designName = () => useDesign.getState().model?.name || "design";

export async function exportDrawingsPdf() {
  const sheets = await allSheets();
  if (!sheets.length) throw new Error("This design has no parts to draw yet");
  download(sheetsToPdf(sheets, designName()), safeFileName(`${designName()} drawings`, "pdf"), "application/pdf");
}

/** Every drawing as one PDF, reporting problems as a toast (for menus). */
export async function exportAllDrawings() {
  const t = toast({ kind: "info", title: "Preparing the drawings…" }, 0);
  try {
    await exportDrawingsPdf();
  } catch (e) {
    toast({ kind: "error", title: "Could not export the drawings", detail: errorText(e) });
  } finally {
    dismissToast(t);
  }
}

async function current(): Promise<Sheet> {
  return sheetFor(useDrawings.getState().active ?? undefined);
}

export async function exportDrawingSvg() {
  const s = await current();
  download(sheetToSvg(s), safeFileName(s.title, "svg"), "image/svg+xml");
}

export async function exportDrawingDxf() {
  const s = await current();
  download(sheetToDxf(s), safeFileName(s.title, "dxf"), "application/dxf");
}

export async function exportDrawingPdf() {
  const s = await current();
  download(sheetsToPdf([s], s.title), safeFileName(s.title, "pdf"), "application/pdf");
}

/** A PNG data URL of a sheet on white paper, for the assistant. */
export async function sheetToPng(sheet: Sheet, width = 1600): Promise<string> {
  const svg = sheetToSvg(sheet);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("The drawing could not be rendered"));
      img.src = url;
    });
    const height = Math.round((width * sheet.h) / sheet.w);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext("2d");
    if (!g) throw new Error("No 2D canvas");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, width, height);
    g.drawImage(img, 0, 0, width, height);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** What is on a sheet, with dimension ids, for the assistant. */
export function describeSheet(sheet: Sheet): string {
  const model = useDesign.getState().model;
  const lines = [`Drawing "${sheet.title}" (${sheet.name}${sheet.auto ? ", automatic" : ", drawing block in the source"}): ${sheet.size} ${sheet.orientation}, scale ${scaleText(sheet.scale)}.`];
  lines.push(`Views: ${sheet.views.map((v, i) => `v${i} ${v.label || v.name}${v.scale !== sheet.scale ? ` (${scaleText(v.scale)})` : ""}${v.state !== "ready" ? ` [${v.state}${v.error ? `: ${v.error}` : ""}]` : ""}`).join("; ")}`);
  if (sheet.dims.length) {
    lines.push('Dimensions and callouts (key [view] description = text, then the id tol("id", …) takes for an automatic one):');
    for (const [i, d] of sheet.dims.entries()) {
      const tol = d.tol ? ` tol ${d.tol[0]}/${d.tol[1]}` : d.general ? ` (general ±${d.general})` : "";
      lines.push(`  d${i} [${sheet.views[d.view]?.name ?? "?"}] ${d.label} = ${d.text}${tol}${d.param ? ` → param ${d.param}` : ""}${d.auto ? (d.id ? ` id "${d.id}"` : "") : " (from the drawing block)"}`);
    }
  }
  if (sheet.bom.length) lines.push(`Parts list: ${sheet.bom.map((b) => `${b.item}. ${b.qty}× ${b.name}`).join("; ")}`);
  if (sheet.notes.length) lines.push(`Notes: ${sheet.notes.map((n, i) => `${i + 1}. ${n}`).join(" ")}`);
  if (sheet.warnings.length) lines.push(`Warnings: ${sheet.warnings.join("; ")}`);
  const spec = drawingSpecs(model).find((s) => s.name === sheet.name);
  if (spec?.auto && model) lines.push(`This drawing is generated automatically. To change it, add a drawing block to the end of the source and edit that; for example:\n${specToSource(spec, blockNameFor(spec, model))}`);
  return lines.join("\n");
}
