// Feeds and speeds for carbide end mills: spindle speed from the material's cutting speed, feed from a chip load
// per tooth that grows with the tool, and how deep and wide each pass takes, softened for a router's frame.
// Starting points from common tables, for a machine that cuts cleanly; the panel and the design can change them.

import { millClass, type CutClass } from "../mfg/materials";

export type Frame = "router" | "benchtop" | "vmc";

export interface Cutting {
  rpm: number;
  /** mm/min along the cut */
  feed: number;
  /** mm/min straight down */
  plunge: number;
  /** mm/min down a ramp */
  ramp: number;
  /** deepest pass when roughing, mm */
  stepdown: number;
  /** sideways step between passes when roughing, mm */
  stepover: number;
  /** ramp angle into material, degrees */
  rampDeg: number;
  flutes: number;
  /** chip load per tooth, mm */
  chip: number;
}

/** Chip load per tooth as a share of the tool's diameter, by material, and the share of it a frame takes. */
const CHIP: Record<CutClass, number> = { wood: 0.02, plastic: 0.016, "light metal": 0.006, steel: 0.004, "tough metal": 0.003 };
const FRAME_CHIP: Record<Frame, number> = { router: 0.8, benchtop: 0.9, vmc: 1 };
/** depth of a roughing pass as a share of the diameter */
const DEPTH: Record<Frame, Record<CutClass, number>> = {
  router: { wood: 1, plastic: 0.75, "light metal": 0.25, steel: 0.1, "tough metal": 0.05 },
  benchtop: { wood: 1, plastic: 1, "light metal": 0.5, steel: 0.3, "tough metal": 0.2 },
  vmc: { wood: 1.5, plastic: 1.5, "light metal": 1, steel: 0.5, "tough metal": 0.3 },
};
/** fastest feed and rapid each frame moves, mm/min */
export const FRAME_SPEED: Record<Frame, { feed: number; rapid: number; minRpm: number }> = {
  router: { feed: 5000, rapid: 5000, minRpm: 8000 },
  benchtop: { feed: 2000, rapid: 2500, minRpm: 300 },
  vmc: { feed: 10000, rapid: 20000, minRpm: 100 },
};

export const asFrame = (v: unknown): Frame => (v === "router" || v === "benchtop" ? v : "vmc");

/** Cutting values for a tool of diameter d in a material on a frame, the spindle no faster than rpmMax. */
export function cutting(d: number, material: string, frame: Frame, rpmMax: number, opts: { stepover?: number; stepdown?: number; flutes?: number } = {}): Cutting {
  const { cls, speed } = millClass(material);
  const flutes = opts.flutes ?? (cls === "steel" || cls === "tough metal" ? (frame === "router" ? 2 : 4) : cls === "light metal" && frame === "vmc" ? 3 : 2);
  const lim = FRAME_SPEED[frame];
  const ideal = (speed * 1000) / (Math.PI * d);
  const rpm = Math.round(Math.max(Math.min(ideal, rpmMax), Math.min(lim.minRpm, rpmMax)));
  // a slower spindle than the material wants keeps the same chip, so the feed drops with it
  const chip = Math.max(0.005, Math.min(0.25, CHIP[cls] * d * FRAME_CHIP[frame]));
  const feed = Math.round(Math.min(lim.feed, rpm * flutes * chip));
  const stepdown = opts.stepdown ?? Math.max(0.1, +(d * DEPTH[frame][cls]).toFixed(2));
  const stepover = +(d * (opts.stepover ?? 0.4)).toFixed(3);
  const metal = cls !== "wood" && cls !== "plastic";
  return { rpm, feed, plunge: Math.round(feed * (metal ? 0.25 : 0.35)), ramp: Math.round(feed * 0.6), stepdown, stepover, rampDeg: metal ? 3 : 8, flutes, chip: +chip.toFixed(4) };
}

/** feed per revolution of a twist drill as a share of its diameter, by material */
const DRILL_FEED: Record<CutClass, number> = { wood: 0.02, plastic: 0.015, "light metal": 0.012, steel: 0.008, "tough metal": 0.005 };

/** Cutting values for a twist drill of diameter d: slower than an end mill, fed straight down in pecks. */
export function drilling(d: number, material: string, frame: Frame, rpmMax: number): Cutting {
  const { cls, speed } = millClass(material);
  const lim = FRAME_SPEED[frame];
  const ideal = (speed * 0.6 * 1000) / (Math.PI * d);
  const rpm = Math.round(Math.max(Math.min(ideal, rpmMax), Math.min(lim.minRpm, rpmMax)));
  const perRev = Math.max(0.01, DRILL_FEED[cls] * d);
  const feed = Math.round(Math.min(lim.feed * 0.25, rpm * perRev));
  // wood and plastic clear chips easily: deeper pecks
  const peck = +(d * (cls === "wood" || cls === "plastic" ? 3 : 1.5)).toFixed(2);
  return { rpm, feed, plunge: feed, ramp: feed, stepdown: peck, stepover: 0, rampDeg: 90, flutes: 2, chip: +(perRev / 2).toFixed(4) };
}
