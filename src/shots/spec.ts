// Product shots: what a `shot` block in the design source asks for. A shot is
// art direction written down: where the camera stands, which lens and
// aperture, the lighting, what the product sits on, what is exploded, cut,
// hidden or ghosted, scale props, callouts and an optional camera move. Shots
// live in the design file, so they re-render after every revision and come
// with the design wherever it goes.

import type { Span } from "../lang/ast";
import type { V3 } from "../kernel/recipe";

/** What a shot is for. Each kind has its own defaults (see KIND_DEFAULTS). */
export const SHOT_KINDS = ["hero", "exploded", "section", "detail", "in_use", "scale", "angle"] as const;
export type ShotKind = (typeof SHOT_KINDS)[number];

export const KIND_LABELS: Record<ShotKind, string> = {
  hero: "Hero",
  exploded: "Exploded",
  section: "Section",
  detail: "Detail",
  in_use: "In use",
  scale: "Scale",
  angle: "Angle",
};

export const ASPECTS = ["16:9", "3:2", "4:3", "1:1", "4:5", "2:3", "9:16", "21:9"] as const;
export type ShotAspect = (typeof ASPECTS)[number];

/** Width over height of an aspect such as "16:9". */
export function aspectRatio(a: ShotAspect | string): number {
  const [w, h] = a.split(":").map(Number);
  return w > 0 && h > 0 ? w / h : 16 / 9;
}

export const BACKDROPS = ["studio", "seamless", "surface", "transparent"] as const;
export type Backdrop = (typeof BACKDROPS)[number];

export const BACKDROP_LABELS: Record<Backdrop, string> = {
  studio: "Studio set",
  seamless: "Seamless paper",
  surface: "On a surface",
  transparent: "Transparent",
};

/** Surfaces a product can stand on, drawn procedurally (no image files). */
export const SURFACES = ["walnut", "oak", "concrete", "slate", "marble", "steel", "cutting_mat", "paper", "felt"] as const;
export type SurfaceId = (typeof SURFACES)[number];

export const SURFACE_LABELS: Record<SurfaceId, string> = {
  walnut: "Walnut desk",
  oak: "Oak bench",
  concrete: "Concrete",
  slate: "Slate",
  marble: "Marble",
  steel: "Brushed steel",
  cutting_mat: "Cutting mat",
  paper: "White paper",
  felt: "Grey felt",
};

/** Everyday objects of known size that show how big the product is. Sizes in mm. */
export const PROPS = {
  coin: { label: "Coin", size: "Ø 23.25 mm", note: "A one-euro coin" },
  card: { label: "Bank card", size: "85.6 × 54 mm", note: "A credit card (ISO/IEC 7810 ID-1)" },
  pen: { label: "Pen", size: "140 mm", note: "A ballpoint pen" },
  battery: { label: "AA battery", size: "Ø 14.5 × 50.5 mm", note: "An AA cell" },
  ruler: { label: "Ruler", size: "150 mm", note: "A 150 mm steel rule with millimetre marks" },
  mug: { label: "Mug", size: "Ø 82 × 95 mm", note: "A coffee mug" },
  phone: { label: "Phone", size: "147 × 71 mm", note: "A smartphone" },
} as const;
export type PropId = keyof typeof PROPS;
export const PROP_IDS = Object.keys(PROPS) as PropId[];

/** Camera moves and things that move during an animated shot. */
export const MOTIONS = ["none", "turntable", "orbit", "push_in", "explode", "assemble", "mechanism", "section_sweep"] as const;
export type MotionKind = (typeof MOTIONS)[number];

export const MOTION_LABELS: Record<MotionKind, string> = {
  none: "Still",
  turntable: "Turntable",
  orbit: "Orbit",
  push_in: "Push in",
  explode: "Explode and back",
  assemble: "Assemble",
  mechanism: "Mechanism",
  section_sweep: "Section sweep",
};

export const LIGHTINGS = ["studio", "showroom", "blueprint", "workshop", "daylight"] as const;

export interface Callout {
  /** a part or component name, or a point in assembly coordinates */
  target: string | V3;
  text: string;
  span?: Span;
}

export interface ShotSection {
  axis: "x" | "y" | "z";
  /** where the plane crosses the axis (mm); null cuts through the middle of the subject */
  at: number | null;
}

export interface ShotSpec {
  /** block name, or "auto:<kind>" for a suggested shot not yet in the source */
  name: string;
  title: string;
  kind: ShotKind;
  /** [turn, height] in degrees: turn from the front (looking along +Y) toward the right side, height above the floor */
  angle: [number, number];
  /** 35 mm-equivalent focal length, mm */
  lens: number;
  /** f-number; null renders everything sharp (as if focus stacked) */
  aperture: number | null;
  /** what is in focus: a part name, a point, or null for the subject's centre */
  focus: string | V3 | null;
  /** parts the camera frames; empty frames everything shown */
  frame: string[];
  /** how much of the frame the subject fills, 0.2..1 */
  fill: number;
  /** subject offset in the frame as a fraction of its width and height (right and up are positive) */
  offset: [number, number];
  /** camera roll, degrees */
  roll: number;
  aspect: ShotAspect;
  lighting: string;
  /** degrees the lighting is turned; null keeps the preset's own angle */
  lightAngle: number | null;
  backdrop: Backdrop;
  /** seamless paper colour, sRGB hex; null picks one from the lighting */
  color: string | null;
  surface: SurfaceId;
  /** 0 assembled, 1 fully exploded */
  explode: number;
  section: ShotSection | null;
  hide: string[];
  ghost: string[];
  props: PropId[];
  callouts: Callout[];
  motion: MotionKind;
  /** animation length, seconds */
  duration: number;
  /** why the shot looks the way it does (art direction, for people and Claude) */
  note: string;
  locked: boolean;
  /** suggested by Kerf, not yet written in the source */
  auto: boolean;
  span: Span | null;
  /** what keeps this shot from rendering as written (missing parts, nothing to frame); shown as flags */
  problems: string[];
  /** properties written in the block (the rest are the kind's defaults) */
  set: string[];
}

/** The properties a shot block takes. */
export const SHOT_PROPS = [
  "title",
  "kind",
  "angle",
  "lens",
  "aperture",
  "focus",
  "frame",
  "fill",
  "offset",
  "roll",
  "aspect",
  "lighting",
  "light_angle",
  "backdrop",
  "color",
  "surface",
  "explode",
  "hide",
  "ghost",
  "props",
  "motion",
  "duration",
  "note",
] as const;
export type ShotProp = (typeof SHOT_PROPS)[number];

/** Calls a shot block takes, with their arguments in order. */
export const SHOT_CALLS: Record<string, string[]> = {
  callout: ["target", "text"],
  section: ["axis", "at"],
};

type KindDefaults = Pick<ShotSpec, "angle" | "lens" | "aperture" | "fill" | "offset" | "aspect" | "lighting" | "backdrop" | "surface" | "explode" | "props" | "motion" | "duration"> & { section: ShotSection | null };

/**
 * Starting points for each kind of shot, the way a product photographer would
 * set up: a long lens and a low three-quarter angle for the hero, a flatter
 * light and more room for an exploded view, a desk and a familiar object for
 * scale. Every value can be overridden in the block.
 */
export const KIND_DEFAULTS: Record<ShotKind, KindDefaults> = {
  hero: { angle: [35, 18], lens: 85, aperture: null, fill: 0.72, offset: [0, -0.02], aspect: "16:9", lighting: "showroom", backdrop: "seamless", surface: "walnut", explode: 0, props: [], motion: "none", duration: 6, section: null },
  exploded: { angle: [35, 24], lens: 70, aperture: null, fill: 0.86, offset: [0, 0], aspect: "16:9", lighting: "studio", backdrop: "studio", surface: "walnut", explode: 0.6, props: [], motion: "none", duration: 5, section: null },
  section: { angle: [30, 20], lens: 70, aperture: null, fill: 0.78, offset: [0, 0], aspect: "16:9", lighting: "studio", backdrop: "studio", surface: "walnut", explode: 0, props: [], motion: "none", duration: 5, section: { axis: "x", at: null } },
  detail: { angle: [40, 28], lens: 100, aperture: 4, fill: 0.92, offset: [0, 0], aspect: "4:3", lighting: "showroom", backdrop: "seamless", surface: "walnut", explode: 0, props: [], motion: "none", duration: 5, section: null },
  in_use: { angle: [28, 26], lens: 50, aperture: 8, fill: 0.55, offset: [-0.06, 0], aspect: "3:2", lighting: "daylight", backdrop: "surface", surface: "walnut", explode: 0, props: ["pen"], motion: "none", duration: 6, section: null },
  scale: { angle: [20, 38], lens: 50, aperture: null, fill: 0.62, offset: [0, 0], aspect: "3:2", lighting: "daylight", backdrop: "surface", surface: "cutting_mat", explode: 0, props: ["coin", "ruler"], motion: "none", duration: 5, section: null },
  angle: { angle: [35, 22], lens: 70, aperture: null, fill: 0.75, offset: [0, 0], aspect: "16:9", lighting: "studio", backdrop: "studio", surface: "walnut", explode: 0, props: [], motion: "none", duration: 6, section: null },
};

/** A shot of a kind with every value at its default. */
export function defaultShot(name: string, kind: ShotKind = "hero", title?: string): ShotSpec {
  const d = KIND_DEFAULTS[kind];
  return {
    name,
    title: title ?? KIND_LABELS[kind],
    kind,
    angle: [...d.angle],
    lens: d.lens,
    aperture: d.aperture,
    focus: null,
    frame: [],
    fill: d.fill,
    offset: [...d.offset],
    roll: 0,
    aspect: d.aspect,
    lighting: d.lighting,
    lightAngle: null,
    backdrop: d.backdrop,
    color: null,
    surface: d.surface,
    explode: d.explode,
    section: d.section ? { ...d.section } : null,
    hide: [],
    ghost: [],
    props: [...d.props],
    callouts: [],
    motion: d.motion,
    duration: d.duration,
    note: "",
    locked: false,
    auto: false,
    span: null,
    problems: [],
    set: [],
  };
}

// ---------- lens and depth of field ----------

/** Diagonal of a full-frame (35 mm) sensor, mm: focal lengths are equivalent to it for every aspect. */
export const SENSOR_DIAGONAL = 43.267;
/** Circle of confusion for a full-frame sensor, mm. */
export const COC = 0.03;

export const LENS_RANGE: [number, number] = [14, 400];
export const APERTURE_RANGE: [number, number] = [1.2, 32];
export const FILL_RANGE: [number, number] = [0.15, 1];

/** Sensor width and height (mm) for an aspect, keeping the full-frame diagonal. */
export function sensorSize(aspect: number): [number, number] {
  const k = SENSOR_DIAGONAL / Math.hypot(aspect, 1);
  return [aspect * k, k];
}

/** Vertical field of view (degrees) of a lens on that sensor. */
export function verticalFov(lens: number, aspect: number): number {
  const [, h] = sensorSize(aspect);
  return (2 * Math.atan(h / (2 * lens)) * 180) / Math.PI;
}

/** Horizontal field of view (degrees). */
export function horizontalFov(lens: number, aspect: number): number {
  const [w] = sensorSize(aspect);
  return (2 * Math.atan(w / (2 * lens)) * 180) / Math.PI;
}

/** Diameter of the entrance pupil, mm. Scene units are mm, so this is also the camera jitter for depth of field. */
export function apertureDiameter(lens: number, fNumber: number): number {
  return lens / fNumber;
}

/**
 * Near and far limits of acceptable sharpness (mm from the camera) when focused
 * at `focus` mm. The far limit is Infinity beyond the hyperfocal distance.
 */
export function depthOfField(lens: number, fNumber: number, focus: number): { near: number; far: number; hyperfocal: number } {
  const f = lens;
  const H = (f * f) / (fNumber * COC) + f;
  const s = Math.max(focus, f * 1.01);
  const near = (s * (H - f)) / (H + s - 2 * f);
  const far = s >= H ? Infinity : (s * (H - f)) / (H - s);
  return { near, far, hyperfocal: H };
}

/**
 * Diameter of the blur disc (as a fraction of the image height) of a point at
 * distance `d` when focused at `focus`, for the thin-lens model.
 */
export function blurFraction(lens: number, fNumber: number, focus: number, d: number, aspect: number): number {
  const f = lens;
  const s = Math.max(focus, f * 1.01);
  const b = ((f * f) / (fNumber * (s - f))) * (Math.abs(d - s) / Math.max(d, 1e-6));
  return b / sensorSize(aspect)[1];
}

/** "f/5.6" */
export function fStopText(n: number | null): string {
  if (n === null) return "all sharp";
  return `f/${n >= 10 ? Math.round(n) : Math.round(n * 10) / 10}`;
}

/** Standard full stops, for stepping the aperture in the UI. */
export const F_STOPS = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16, 22, 32];
/** Common prime lenses, for stepping the focal length. */
export const LENSES = [24, 35, 50, 70, 85, 100, 135, 200];

/** Unit vector from the subject toward the camera for a shot angle. Z is up; turn 0 looks from the front (-Y). */
export function viewDirection(turn: number, height: number): V3 {
  const a = (turn * Math.PI) / 180;
  const e = (height * Math.PI) / 180;
  return [Math.sin(a) * Math.cos(e), -Math.cos(a) * Math.cos(e), Math.sin(e)];
}

/** The shot angle [turn, height] of a direction from the subject toward the camera. */
export function angleOf(dir: V3): [number, number] {
  const l = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const e = Math.asin(Math.max(-1, Math.min(1, dir[2] / l)));
  let a = Math.atan2(dir[0], -dir[1]);
  if (Math.abs(Math.cos(e)) < 1e-6) a = 0;
  return [(a * 180) / Math.PI, (e * 180) / Math.PI];
}

/** A short line describing the camera, e.g. "85 mm · f/8 · from the front right, slightly above". */
export function cameraText(s: Pick<ShotSpec, "lens" | "aperture" | "angle">): string {
  return `${Math.round(s.lens)} mm · ${fStopText(s.aperture)} · ${angleText(s.angle)}`;
}

/** Words for a shot angle. */
export function angleText([turn, height]: [number, number]): string {
  const t = ((turn % 360) + 540) % 360 - 180;
  const at = Math.abs(t);
  const side = at < 12 ? "front" : at > 168 ? "back" : at > 78 && at < 102 ? (t > 0 ? "right side" : "left side") : `${at < 90 ? "front" : "back"} ${t > 0 ? "right" : "left"}`;
  const h = height > 70 ? "from above" : height > 40 ? "high" : height > 12 ? "slightly above" : height > -5 ? "at eye level" : "from below";
  return `${side}, ${h}`;
}
