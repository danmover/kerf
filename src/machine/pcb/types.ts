// Printed circuit boards: footprints, placement, nets, routing and the files a
// board house needs. Coordinates are millimetres with y up (Gerber's frame):
// the board runs from (0, 0) at its bottom-left corner to (w, h), seen from
// the top (component) side.

export type Layer = "F" | "B";

export interface Pad {
  /** the pin id this pad belongs to (several pads may share one, e.g. mounting tabs) */
  pin: string;
  /** number printed beside it, when it differs from the pin id */
  num?: string;
  /** centre, in footprint coordinates */
  x: number;
  y: number;
  shape: "circle" | "rect" | "oval";
  /** copper size; for "oval" the long side is the larger of w and h */
  w: number;
  h: number;
  /** plated hole diameter (every pad is through-hole for now) */
  drill: number;
  /** a plated slot instead of a round hole: total slot length along the pad's long side */
  slot?: number;
}

export interface Footprint {
  name: string;
  pads: Pad[];
  /** outline of the part body for the silkscreen and overlap checks, footprint coordinates */
  body: { shape: "rect"; x0: number; y0: number; x1: number; y1: number } | { shape: "circle"; cx: number; cy: number; r: number };
  /** non-plated holes (mounting) */
  holes?: { x: number; y: number; d: number }[];
  /** polarity or pin-1 mark for the silkscreen */
  mark?: { x: number; y: number; kind: "pin1" | "plus" | "band" };
  /** body height above the board, mm (clearance checks and 3D) */
  height: number;
}

export interface PlacedPart {
  /** reference designator printed on the board: R1, C3, U2 */
  ref: string;
  /** value or part number printed beside it: 10k, 100n, TL072 */
  value: string;
  fp: Footprint;
  /** footprint origin on the board */
  x: number;
  y: number;
  /** degrees counter-clockwise, seen from the top */
  rot: number;
  /** "bottom" parts are mirrored left-right as seen from the top and are soldered from the top */
  side: "top" | "bottom";
}

export interface BoardNet {
  name: string;
  pins: { ref: string; pin: string }[];
  /** track width in mm (rules.track when omitted) */
  width?: number;
  /** fill the free copper of both layers with this net (ground) */
  pour?: boolean;
}

export interface BoardRules {
  /** copper to copper, mm */
  clearance: number;
  /** default track width, mm */
  track: number;
  via: { pad: number; drill: number };
  /** routing grid pitch, mm */
  grid: number;
  /** copper kept this far from the board edge, mm */
  edge: number;
}

export const DEFAULT_RULES: BoardRules = { clearance: 0.3, track: 0.4, via: { pad: 1.2, drill: 0.6 }, grid: 0.3175, edge: 0.6 };

export interface BoardSpec {
  name: string;
  w: number;
  h: number;
  /** corner radius of the outline */
  corner?: number;
  /** mounting holes (non-plated) */
  holes: { x: number; y: number; d: number }[];
  parts: PlacedPart[];
  nets: BoardNet[];
  rules?: Partial<BoardRules>;
  /** extra silkscreen text */
  texts?: { x: number; y: number; text: string; size: number; side: Layer }[];
}

export interface Track {
  net: string;
  layer: Layer;
  w: number;
  pts: [number, number][];
}

export interface Via {
  net: string;
  x: number;
  y: number;
  pad: number;
  drill: number;
}

export interface Pour {
  net: string;
  layer: Layer;
  /** closed rings; the first of each group is an outline and the rings after it with opposite winding are holes */
  polys: [number, number][][];
}

export interface DrcItem {
  kind: "unrouted" | "clearance" | "overlap" | "offboard" | "short" | "drill" | "pin";
  message: string;
  x: number;
  y: number;
  refs?: string[];
  nets?: string[];
}

export interface RoutedBoard {
  spec: BoardSpec;
  rules: BoardRules;
  tracks: Track[];
  vias: Via[];
  pours: Pour[];
  /** connections the router could not make */
  unrouted: { net: string; a: { ref: string; pin: string }; b: { ref: string; pin: string } }[];
  /** design rule check of the finished board (empty when clean) */
  drc: DrcItem[];
  stats: { connections: number; routed: number; vias: number; trackLength: number; ms: number };
}

export interface BoardFile {
  path: string;
  content: string;
}
