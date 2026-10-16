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
  section?: "x" | "y" | "z";
  mime?: "image/png" | "image/jpeg" | "image/webp";
  quality?: number;
  /** frame this box instead of the whole model */
  box?: Box;
  /** look from this direction instead of the preset's */
  dir?: Vec3;
}

export interface ViewportApi {
  capture(opts: CaptureOptions): Promise<string>;
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
export const registerViewport = (a: ViewportApi | null) => {
  api = a;
};
export const viewport = () => api;
