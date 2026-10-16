// A narrow handle the viewport registers so other modules (AI tools,
// thumbnails, exports) can capture images without touching three.js.

import type { ViewPreset } from "./view";

export interface CaptureOptions {
  view: ViewPreset | "current";
  width: number;
  height: number;
  focus?: string[];
  /** frame the focused parts instead of the whole model (for close-ups) */
  frame?: "model" | "focus";
  section?: "x" | "y" | "z";
  mime?: "image/png" | "image/jpeg" | "image/webp";
  quality?: number;
}

export interface ViewportApi {
  capture(opts: CaptureOptions): Promise<string>;
}

let api: ViewportApi | null = null;
export const registerViewport = (a: ViewportApi | null) => {
  api = a;
};
export const viewport = () => api;
