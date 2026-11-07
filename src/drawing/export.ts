// Drawing files and pictures: PDF of every sheet, SVG and DXF of one, a PNG
// for the assistant to look at, and a plain-text account of a sheet.

import { useDesign } from "../core/engine";
import { download, safeFileName } from "../persist/files";
import { dismissToast, errorText, toast } from "../app/ui";
import { allSheets, drawingSpecs, flatPatterns, sheetFor, useDrawings } from "./engine";
import { flatsToDxf } from "./flat";
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

/** Every sheet-metal part's flat pattern in one DXF at 1:1, outlines on CUT and bend lines on BEND, for the laser or punch. */
export async function exportFlatPatternsDxf(): Promise<number> {
  const flats = await flatPatterns();
  download(flatsToDxf(flats), safeFileName(`${designName()} flat patterns`, "dxf"), "application/dxf");
  return flats.length;
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
// keeps the assistant's tool result a sensible size on a busy assembly sheet
const MAX_DIM_LINES = 150;
const MAX_DESCRIPTION = 16_000;

export function describeSheet(sheet: Sheet): string {
  const model = useDesign.getState().model;
  const lines = [`Drawing "${sheet.title}" (${sheet.name}${sheet.auto ? ", automatic" : ", drawing block in the source"}): ${sheet.size} ${sheet.orientation}, scale ${scaleText(sheet.scale)}.`];
  lines.push(`Views: ${sheet.views.map((v, i) => `v${i} ${v.label || (v.kind === "aux" ? `auxiliary view ${v.name}` : v.name)}${v.scale !== sheet.scale ? ` (${scaleText(v.scale)})` : ""}${v.extras?.length ? ` (${v.extras.join(", ")})` : ""}${v.state !== "ready" ? ` [${v.state}${v.error ? `: ${v.error}` : ""}]` : ""}`).join("; ")}`);
  if (sheet.breaks?.length) lines.push(`Broken views: ${sheet.breaks.map((b) => `${"XYZ"[b.axis]} ${b.from} to ${b.to} taken out`).join("; ")}${sheet.breaks[0].auto ? " (chosen by Kerf for a long plain part; breaks: false keeps it whole, break_view(X, from, to) sets your own)" : ""}. Dimensions across a break keep their true length.`);
  if (sheet.dims.length) {
    lines.push('Dimensions and callouts (key [view] description = text, then the id tol("id", …) takes for an automatic one):');
    for (const [i, d] of sheet.dims.entries()) {
      if (i === MAX_DIM_LINES) {
        lines.push(`  … and ${sheet.dims.length - i} more (d${i} to d${sheet.dims.length - 1}); the image shows them all`);
        break;
      }
      const tol = d.tol ? ` tol ${d.tol[0]}/${d.tol[1]}` : d.general ? ` (general ±${d.general})` : "";
      const gd = `${d.basic ? " [basic]" : ""}${d.datum ? ` [datum ${d.datum}]` : ""}${d.frames?.length ? ` frames: ${d.frames.join("; ")}` : ""}`;
      lines.push(`  d${i} [${sheet.views[d.view]?.name ?? "?"}] ${d.label} = ${d.text}${tol}${gd}${d.param ? ` → param ${d.param}` : ""}${d.auto ? (d.id ? ` id "${d.id}"` : "") : " (from the drawing block)"}`);
    }
  }
  if (sheet.datums?.length) lines.push(`Datums: ${sheet.datums.map((d) => `${d.letter} = ${d.what}`).join("; ")}. Kerf picked them from how the part seats and how its features are located; gdt("id", "position", 0.2, "A B C") changes a frame, gdt: false removes them.`);
  if (sheet.holeTable) lines.push(`Hole table (${sheet.views[sheet.holeTable.view]?.name ?? "?"} view, ${sheet.holeTable.origin}): ${sheet.holeTable.rows.map((r) => `${r.tag} (${r.x}, ${r.y}) ${r.size}${r.frame ? ` [${r.frame}]` : ""}`).join("; ")}. hole_table: false in the block goes back to position dimensions.`);
  if (sheet.symbols.length) lines.push(`Symbols: ${sheet.symbols.map((s) => `${s.kind === "weld" ? "weld" : "surface texture"} ${s.text}${s.view !== undefined ? ` [${sheet.views[s.view]?.name ?? "?"}]` : ""}`).join("; ")}`);
  if (sheet.revisions.length) lines.push(`Revisions: ${sheet.revisions.map((r) => `${r.rev} ${r.text}${r.date ? ` (${r.date}${r.by ? `, ${r.by}` : ""})` : ""}`).join("; ")}`);
  if (sheet.bom.length) lines.push(`Parts list: ${sheet.bom.map((b) => `${b.item}. ${b.qty}× ${b.name}`).join("; ")}`);
  if (sheet.notes.length) lines.push(`Notes: ${sheet.notes.map((n, i) => `${i + 1}. ${n}`).join(" ")}`);
  if (sheet.warnings.length) lines.push(`Warnings: ${sheet.warnings.join("; ")}`);
  const spec = drawingSpecs(model).find((s) => s.name === sheet.name);
  if (spec?.auto && model) lines.push(`This drawing is generated automatically. To change it, add a drawing block to the end of the source and edit that; for example:\n${specToSource(spec, blockNameFor(spec, model))}`);
  const text = lines.join("\n");
  return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION)}\n… (cut to ${MAX_DESCRIPTION} characters)` : text;
}
