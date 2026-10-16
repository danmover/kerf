// A narrow handle the viewport registers so other modules (AI tools,
// thumbnails, exports, change cards, spot chat) can capture images and find
// things on screen without touching three.js.

import type { ViewPreset } from "./view";

export type Vec3 = [number, number, number];
export type Box = [Vec3, Vec3];

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
  /** accumulation samples: more gives softer shadows and cleaner edges */
  samples?: number;
  /** frame this box instead of the whole model */
  box?: Box;
  /** look from this direction instead of the preset's */
  dir?: Vec3;
  /** draw overlays such as analysis results (default true) */
  overlays?: boolean;
}

export interface ViewportApi {
  capture(opts: CaptureOptions): Promise<string>;
  /** a rendered ball of a material under the current lighting (data URL, transparent background) */
  swatch(material: string, finish: string | undefined, color: string, size?: number): string;
  /** show a material on parts without changing the design; null restores them */
  preview(ids: string[], look: { material: string; finish?: string; color: string } | null): void;
  /** the material picker is open: show selected parts in their true colours */
  materialMode(on: boolean): void;
  /** the model's bounds, in assembly coordinates */
  bounds(): Box;
  /** from the view's target toward the camera */
  viewDir(): Vec3;
  /** where a spot on a part shows, in pixels from the viewport's top left; null when off screen */
  anchor(partId: string, local?: Vec3): { x: number; y: number; front: boolean } | null;
  /** the view exactly as it is on screen */
  snapshot(): string;
  /** the part (and spot on it) under a point in page coordinates */
  hitAt(clientX: number, clientY: number): { id: string; local: Vec3; point: Vec3; normal: Vec3 } | null;
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
