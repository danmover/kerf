// Renders for the review: a fixed set of views of the whole model, close-ups
// on request, and a labelled contact sheet of them all.

import type { Box, CaptureOptions } from "../../app/viewportApi";
import type { ViewPreset } from "../../app/view";
import type { ReviewView } from "./types";

export interface ViewSpec {
  view: ViewPreset;
  label: string;
  section?: "x" | "y" | "z";
}

/** Seven views: every side a person would look at, and one cut through the middle. */
export const REVIEW_VIEWS: ViewSpec[] = [
  { view: "iso", label: "3/4 view from front right" },
  { view: "front", label: "Front (looking along +Y)" },
  { view: "back", label: "Back" },
  { view: "right", label: "Right side" },
  { view: "top", label: "Top" },
  { view: "bottom", label: "Bottom" },
  { view: "front", label: "Section through the middle, seen from the front", section: "y" },
];

export type Capture = (o: CaptureOptions) => Promise<string>;

export const VIEW_W = 1024;
export const VIEW_H = 704;

const nameOf = (s: ViewSpec) => (s.section ? `section-${s.section}` : s.view);

/**
 * The review's views. With `subject` (the parts being designed, when they are small beside what they fit on), the
 * first view shows the whole model and the rest are framed on the subject, nothing ghosted.
 */
export async function captureViews(capture: Capture, ids: string[] | undefined, onView?: (v: ReviewView) => void, specs = REVIEW_VIEWS, subject?: Box): Promise<ReviewView[]> {
  const out: ReviewView[] = [];
  for (const [i, s] of specs.entries()) {
    const box = subject && i > 0 ? subject : undefined;
    const image = await capture({ view: s.view, width: VIEW_W, height: VIEW_H, section: s.section, focus: ids, frame: ids?.length ? "focus" : "model", box, mime: "image/jpeg", quality: 0.85, samples: 24, overlays: false });
    const label = subject ? (box ? `${s.label}, framed on the parts being designed` : `${s.label}, whole model`) : s.label;
    const v = { name: nameOf(s), label, image };
    out.push(v);
    onView?.(v);
    // let the page paint between captures
    await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}

export async function captureCloseup(capture: Capture, ids: string[], view: ViewPreset, section: "x" | "y" | "z" | undefined, why: string, parts: string[]): Promise<ReviewView> {
  const image = await capture({ view, width: VIEW_W, height: VIEW_H, section, focus: ids, frame: "focus", mime: "image/jpeg", quality: 0.88, samples: 24, overlays: false });
  const from = view === "iso" ? "3/4 view" : `from the ${view}`;
  return { name: `closeup-${view}${section ? `-${section}` : ""}`, label: `Close-up of ${parts.join(", ")}, ${from}${section ? `, cut across ${section.toUpperCase()}` : ""}`, image, closeup: { parts, why } };
}

/** Lay views out on one labelled JPEG. Returns "" when the browser cannot draw it. */
export async function contactSheet(views: ReviewView[], cellW = 400, cols = 3): Promise<string> {
  if (!views.length || typeof document === "undefined") return "";
  const cellH = Math.round((cellW * VIEW_H) / VIEW_W);
  const rows = Math.ceil(views.length / cols);
  const canvas = document.createElement("canvas");
  canvas.width = cellW * cols;
  canvas.height = cellH * rows;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.fillStyle = "#0d1016";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const imgs = await Promise.all(views.map((v) => loadImage(v.image)));
  imgs.forEach((img, i) => {
    const x = (i % cols) * cellW;
    const y = Math.floor(i / cols) * cellH;
    if (img) ctx.drawImage(img, x, y, cellW, cellH);
    ctx.strokeStyle = "#232a38";
    ctx.strokeRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);
    const label = `${i + 1}. ${views[i].label}`;
    ctx.font = "600 13px 'IBM Plex Sans', system-ui, sans-serif";
    const w = Math.min(cellW - 12, ctx.measureText(label).width + 12);
    ctx.fillStyle = "rgba(13,16,22,0.82)";
    ctx.fillRect(x + 6, y + 6, w, 22);
    ctx.fillStyle = "#dfe6f3";
    ctx.fillText(label, x + 12, y + 22, cellW - 24);
  });
  return canvas.toDataURL("image/jpeg", 0.85);
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** A smaller JPEG copy of an image, for thumbnails kept in the saved chat. */
export async function shrinkImage(dataUrl: string, width: number): Promise<string> {
  if (typeof document === "undefined") return dataUrl;
  const img = await loadImage(dataUrl);
  if (!img || img.naturalWidth <= width) return dataUrl;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.round((img.naturalHeight * width) / img.naturalWidth);
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.8);
}
