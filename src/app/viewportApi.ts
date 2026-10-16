// A narrow handle the viewport registers so other modules (AI tools,
// thumbnails, exports) can capture images without touching three.js.

import type { ViewPreset } from "./view";

export interface CaptureOptions {
  view: ViewPreset | "current";
  width: number;
  height: number;
  focus?: string[];
  section?: "x" | "y" | "z";
  mime?: "image/png" | "image/jpeg" | "image/webp";
  quality?: number;
  /** draw overlays such as analysis results (default true) */
  overlays?: boolean;
}

export interface ViewportApi {
  capture(opts: CaptureOptions): Promise<string>;
}

let api: ViewportApi | null = null;
export const registerViewport = (a: ViewportApi | null) => {
  api = a;
};
export const viewport = () => api;
