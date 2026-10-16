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
  /** accumulation samples: more gives softer shadows and cleaner edges */
  samples?: number;
}

export interface ViewportApi {
  capture(opts: CaptureOptions): Promise<string>;
  /** a rendered ball of a material under the current lighting (data URL, transparent background) */
  swatch(material: string, finish: string | undefined, color: string, size?: number): string;
  /** show a material on parts without changing the design; null restores them */
  preview(ids: string[], look: { material: string; finish?: string; color: string } | null): void;
  /** the material picker is open: show selected parts in their true colours */
  materialMode(on: boolean): void;
}

let api: ViewportApi | null = null;
const waiting: (() => void)[] = [];
export const registerViewport = (a: ViewportApi | null) => {
  api = a;
  if (a) for (const cb of waiting.splice(0)) cb();
};
export const viewport = () => api;
/** Run `cb` once a viewport exists (now, if one already does). */
export const whenViewport = (cb: () => void) => {
  if (api) cb();
  else waiting.push(cb);
};
