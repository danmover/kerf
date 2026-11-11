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
  /** show the design exploded this far (0 to 1, stepping through the plan in core/explode.ts), framed to fit */
  explode?: number;
  /** draw only these parts (ids), framed to fit; the rest are hidden */
  only?: string[];
}

/** What the photoreal view is doing (ui/viewport/scene's PhotoStatus). */
export interface PhotoState {
  state: "off" | "paused" | "waiting" | "preparing" | "rendering" | "done";
  reason?: string;
  samples: number;
  max: number;
}

/** One picture of a film: the camera and what the design is doing (src/film/timeline.ts writes these). */
export interface FilmShot {
  camera: { pos: Vec3; target: Vec3; fov: number };
  /** how far exploded along the plan, 0 to 1 */
  explode: number;
  /** assembly progress 0 to 1 (parts arrive in the plan's order), or null */
  build: number | null;
  /** turning parts' driver angle, degrees */
  angle: number;
  section: { axis: "x" | "y" | "z"; t: number; flip: boolean } | null;
  /** parts kept solid, the rest ghosted */
  focus: string[] | null;
  /** draw the overlays on (wiring, analysis results, a simulation) */
  overlays: boolean;
  /** seconds into the shot, for the overlays' own animations */
  clock: number;
}

/** Where everything is, for planning a film's shots. */
export interface FilmLayout {
  box: Box;
  parts: Map<string, Box>;
  /** each part's centre with the design fully exploded */
  exploded: Map<string, Vec3>;
  explodedBox: Box | null;
  /** the order parts go together in */
  order: string[];
  /** the shown simulation's box (its world), when one is on */
  simBox: Box | null;
}

/** The viewport handed to the film maker: the interactive view pauses until end(). */
export interface FilmView {
  readonly width: number;
  readonly height: number;
  layout(): FilmLayout;
  /** draw one picture, rows top first; with `to`, what moves is blurred toward that state across the samples */
  render(shot: FilmShot, samples: number, to?: FilmShot): ImageData;
  resize(width: number, height: number): void;
  /** the time the simulation overlay shows, seconds */
  simTime(t: number): void;
  /** start the overlays' own animations again (at the start of a shot) */
  restartOverlays(): void;
  end(): void;
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
  hitAt(clientX: number, clientY: number): { id: string; local: Vec3; point: Vec3; normal: Vec3; localNormal: Vec3 } | null;
  /** what the photoreal view is doing */
  photoStatus(): PhotoState;
  /** why the photoreal view couldn't run now (software graphics, section view, ...), or null */
  photoBlocker(): string | null;
  /** an export needs at least this photoreal quality until it ends (null) */
  photoFloor(q: { maxSamples: number; scale: number; bounces: number } | null): void;
  /** the finished photoreal image on screen, without the selection outline; null until it has converged */
  photoSnapshot(): string | null;
  /** frame these parts from the current direction */
  focus(ids: string[]): void;
  /** the section that best shows the inside at a spot on a face: its axis, where along it (0 to 1) and which side is cut away */
  sectionThrough(point: Vec3, normal: Vec3): { axis: "x" | "y" | "z"; t: number; flip: boolean };
  /** hand the view to the film maker, drawing at this size in this lighting (a LIGHTING id) */
  film(opts: { width: number; height: number; look?: string; fine?: boolean }): FilmView;
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
