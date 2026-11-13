// How the mouse moves the 3D view: Kerf's own way, or the way SolidWorks,
// Fusion or Onshape do it, so hands trained on one keep working (Settings →
// Mouse). Kept free of three.js; the viewport maps the actions to its controls.

/** what dragging with a button does to the view; with Ctrl or Shift held, rotate and pan swap */
export type MouseAction = "rotate" | "pan" | "zoom" | "none";

export type MouseScheme = "kerf" | "solidworks" | "fusion" | "onshape";

export interface MouseSchemeInfo {
  label: string;
  /** one line for Settings */
  d: string;
  left: MouseAction;
  middle: MouseAction;
  right: MouseAction;
  /** a left drag that starts off the parts draws a selection box */
  leftBox: boolean;
  /** the shortcut sheet's rows: what to do, and what it does */
  rows: [string[], string][];
}

export const MOUSE_SCHEMES: Record<MouseScheme, MouseSchemeInfo> = {
  kerf: {
    label: "Kerf",
    d: "Left drag turns the view, right drag pans, the wheel zooms. B makes left drag draw a selection box.",
    left: "rotate",
    middle: "zoom",
    right: "pan",
    leftBox: false,
    rows: [
      [["Left drag"], "Orbit"],
      [["Right drag"], "Pan (or ⇧ left drag)"],
      [["Wheel"], "Zoom"],
    ],
  },
  solidworks: {
    label: "SolidWorks",
    d: "Middle drag turns the view, Ctrl+middle drag pans, the wheel zooms, and left drag off the parts draws a selection box, as in SolidWorks.",
    left: "none",
    middle: "rotate",
    right: "pan",
    leftBox: true,
    rows: [
      [["Middle drag"], "Orbit"],
      [["Ctrl", "Middle drag"], "Pan (right drag too)"],
      [["Wheel"], "Zoom"],
      [["Left drag"], "Off the parts: box select"],
    ],
  },
  fusion: {
    label: "Fusion",
    d: "Middle drag pans, Shift+middle drag turns the view, the wheel zooms, and left drag off the parts draws a selection box, as in Fusion and Inventor.",
    left: "none",
    middle: "pan",
    right: "none",
    leftBox: true,
    rows: [
      [["Middle drag"], "Pan"],
      [["⇧", "Middle drag"], "Orbit"],
      [["Wheel"], "Zoom"],
      [["Left drag"], "Off the parts: box select"],
    ],
  },
  onshape: {
    label: "Onshape",
    d: "Right drag turns the view, middle drag (or Ctrl+right drag) pans, the wheel zooms, and left drag off the parts draws a selection box, as in Onshape.",
    left: "none",
    middle: "pan",
    right: "rotate",
    leftBox: true,
    rows: [
      [["Right drag"], "Orbit"],
      [["Middle drag"], "Pan (or Ctrl right drag)"],
      [["Wheel"], "Zoom"],
      [["Left drag"], "Off the parts: box select"],
    ],
  },
};

export const MOUSE_SCHEME_IDS = Object.keys(MOUSE_SCHEMES) as MouseScheme[];

export const isMouseScheme = (v: unknown): v is MouseScheme => typeof v === "string" && v in MOUSE_SCHEMES;

/** The buttons while sketching: the left button belongs to the sketch tools, and something must still turn the view. */
export function sketchButtons(s: MouseScheme): { left: MouseAction; middle: MouseAction; right: MouseAction } {
  const m = MOUSE_SCHEMES[s];
  if (m.left !== "rotate") return { left: "none", middle: m.middle, right: m.right };
  return { left: "none", middle: "rotate", right: "pan" };
}
