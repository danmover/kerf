// Connector bodies for the 3D wiring, modelled on the real parts at their
// real sizes: JST XH and PH housings and headers, Dupont housings on pin
// headers, ferrules in screw terminals, fork and ring crimps, USB plugs, XT60,
// DC barrel plugs, and wires soldered to pads and lugs. Each is drawn in its plug frame: x along the contacts,
// z the way it goes in (out of the part), y = z × x; z = 0 is where it meets
// the part.

import type { Frame } from "../../../machine/harness/harness";
import { contactX } from "../../../machine/harness/harness";
import type { PlugKind, PlugSpec } from "../../../machine/harness/plugs";
import { PITCH } from "../../../machine/harness/plugs";
import type { MeshBuilder } from "./builder";

const CREAM = "#ece3cb";
const CREAM_DARK = "#d9cdb0";
const BLACK = "#1b1d21";
const TERMINAL = "#2c6e49";
const GOLD = "#d4a83a";
const TIN = "#c9ccd1";
const STEEL = "#9aa0a8";
const DARK = "#0d0e10";

/** Crimp insulation colours by wire size (the usual red, blue and yellow ranges). */
function crimpColor(d: number): string {
  if (d >= 3.3) return "#e1b928";
  if (d >= 2.3) return "#2f63c8";
  return "#c73a32";
}

/** Bootlace ferrule collar colours (DIN 46228 part 4) by wire size. */
function ferruleColor(d: number): string {
  if (d >= 2.7) return "#2f63c8"; // 2.5 mm²
  if (d >= 2.2) return BLACK; // 1.5 mm²
  if (d >= 1.8) return "#c73a32"; // 1.0 mm²
  if (d >= 1.5) return "#8e939b"; // 0.75 mm²
  return "#f2f2ef"; // 0.5 mm²
}

export interface PlugLook {
  spec: PlugSpec;
  /** wires in the cable, in contact order */
  wires: { d: number; color: string }[];
}

const housingWidth = (spec: PlugSpec, n: number, pitch: number) => (Math.max(spec.ways ?? n, n) - 1) * pitch;

/** The plug on the cable's end. Plastic goes to `p`, metal to `m`. */
export function plugBody(p: MeshBuilder, m: MeshBuilder, f: Frame, look: PlugLook) {
  const { spec, wires } = look;
  const n = wires.length;
  const pitch = spec.pitch ?? PITCH[spec.kind];
  const span = housingWidth(spec, n, pitch);
  const xs = wires.map((_, i) => contactX(spec, i, n));
  switch (spec.kind) {
    case "xh": {
      const w = span / 2 + 2.45;
      p.box(f, -w, w, -2.85, 2.85, 1.5, 9.8, CREAM);
      // the latch ramp the header's lock catches on
      p.box(f, -1.3, 1.3, 2.85, 3.55, 3.5, 8.2, CREAM);
      // each wire enters through its own slot on the back
      for (const x of xs) p.box(f, x - 0.9, x + 0.9, -1.1, 1.1, 9.8, 9.9, CREAM_DARK);
      return;
    }
    case "ph": {
      const w = span / 2 + 1.95;
      p.box(f, -w, w, -2.25, 2.25, 1, 8.2, CREAM);
      p.box(f, -w + 0.4, w - 0.4, 2.25, 2.7, 5, 7.6, CREAM);
      return;
    }
    case "dupont": {
      const w = Math.max(1, spec.ways ?? n) * 1.27;
      p.box(f, -w, w, -1.27, 1.27, 2.5, 16.5, BLACK);
      // a lighter line between housings in a row, as each contact has its own shell
      for (let i = 1; i < (spec.ways ?? n); i++) p.box(f, -w + i * 2.54 - 0.06, -w + i * 2.54 + 0.06, -1.29, 1.29, 2.6, 16.4, "#2c2f35");
      return;
    }
    case "ferrule": {
      wires.forEach((wi, i) => {
        const x = xs[i];
        m.cyl(f, x, 0, -6.5, 0.6, Math.max(0.55, wi.d * 0.36), TIN, 10);
        p.cyl(f, x, 0, 0.6, 6, wi.d * 0.62, ferruleColor(wi.d), 12, "z", wi.d * 0.55);
        p.cyl(f, x, 0, 6, 8, wi.d * 0.55, ferruleColor(wi.d), 12);
      });
      return;
    }
    case "fork":
    case "ring": {
      wires.forEach((wi, i) => {
        const x = xs[i];
        if (spec.kind === "fork") {
          // two prongs either side of the screw
          m.box(f, x - 3.2, x - 1.9, -0.4, 0.4, -5, 1, TIN);
          m.box(f, x + 1.9, x + 3.2, -0.4, 0.4, -5, 1, TIN);
          m.box(f, x - 3.2, x + 3.2, -0.4, 0.4, 1, 4.5, TIN);
        } else {
          m.cyl(f, x, 0, -0.4, 0.4, 3.6, TIN, 16, "y");
          m.box(f, x - 1.6, x + 1.6, -0.4, 0.4, 0, 4.5, TIN);
        }
        p.cyl(f, x, 0, 4.5, 13, Math.max(2, wi.d * 0.85), crimpColor(wi.d), 14, "z", Math.max(1.8, wi.d * 0.7));
      });
      return;
    }
    case "usb_c": {
      m.box(f, -4.15, 4.15, -1.3, 1.3, -6.5, 0.2, TIN);
      p.box(f, -6, 6, -3.3, 3.3, 0, 19, BLACK);
      p.cyl(f, 0, 0, 19, 23, 2.6, BLACK, 14, "z", 2.1);
      return;
    }
    case "usb_a": {
      // the steel tongue shell in the socket, the moulded grip with its strain relief
      m.box(f, -6, 6, -2.25, 2.25, -12, 0.2, TIN);
      p.box(f, -8, 8, -4.2, 4.2, 0, 24, BLACK);
      p.cyl(f, 0, 0, 24, 28, 2.8, BLACK, 14, "z", 2.3);
      return;
    }
    case "usb_micro": {
      m.box(f, -3.5, 3.5, -0.9, 0.9, -5, 0.2, TIN);
      p.box(f, -5.3, 5.3, -3, 3, 0, 14.5, BLACK);
      p.cyl(f, 0, 0, 14.5, 18, 2.4, BLACK, 14, "z", 2);
      return;
    }
    case "xt60": {
      p.box(f, -7.8, 7.8, -4, 4, 0, 16, "#e8b923");
      p.box(f, -7.2, 7.2, -3.4, 3.4, -4, 0, "#e8b923");
      return;
    }
    case "spade": {
      wires.forEach((wi, i) => {
        const x = xs[i];
        p.box(f, x - 3.7, x + 3.7, -2.3, 2.3, 0, 9, crimpColor(wi.d));
        p.cyl(f, x, 0, 9, 15, Math.max(1.8, wi.d * 0.8), crimpColor(wi.d), 12);
      });
      return;
    }
    case "lead": {
      // a sleeve where the leads leave the part
      const r = Math.max(1.4, span / 2 + Math.max(...wires.map((w) => w.d)) * 0.6);
      p.cyl(f, 0, 0, -0.5, 3, r, DARK, 14, "z", r * 0.92);
      return;
    }
    case "solder": {
      wires.forEach((wi, i) => {
        const x = xs[i];
        m.box(f, x - 1.6, x + 1.6, -1.6, 1.6, -0.06, 0.06, GOLD);
        m.blob(f, x, 0, 0.35, Math.max(0.9, wi.d * 0.62), 0.55, TIN);
        p.cyl(f, x, 0, 1.2, 9, wi.d * 0.62, BLACK, 12);
      });
      return;
    }
    case "lug": {
      // the joint on the lug's tip, and heatshrink pulled back over the lug
      wires.forEach((wi, i) => {
        const x = xs[i];
        m.blob(f, x, 0, 0.4, Math.max(1, wi.d * 0.65), 0.6, TIN);
        p.cyl(f, x, 0, -4, 6, Math.max(1.7, wi.d * 0.8), BLACK, 12);
      });
      return;
    }
    case "barrel": {
      // the sleeve sits in the jack; the moulded body and the cord's strain relief stand out of it
      m.cyl(f, 0, 0, -9.5, 0, 2.75, STEEL, 16);
      p.cyl(f, 0, 0, 0, 14, 5, BLACK, 20);
      p.cyl(f, 0, 0, 14, 26, 3.4, BLACK, 16, "z", 2.1);
      return;
    }
    case "sh": {
      // the little JST SH housing: its nose goes into the socket, the wires leave the back through their slots
      const w = span / 2 + 1.5;
      p.box(f, -w + 0.3, w - 0.3, -1.1, 1.1, -2.9, 0, "#2a2c31");
      p.box(f, -w, w, -1.45, 1.45, 0, 4.6, "#2a2c31");
      p.box(f, -w + 0.5, w - 0.5, 1.45, 1.75, 0.6, 3.6, "#2a2c31");
      for (let i = 0; i < Math.max(spec.ways ?? n, n); i++) p.box(f, -span / 2 + i * pitch - 0.3, -span / 2 + i * pitch + 0.3, -0.45, 0.45, 4.6, 4.68, "#0f1012");
      return;
    }
    case "lever":
    case "bare": {
      // the stripped end: tinned strands going into the clamp
      const deep = spec.kind === "lever" ? 11 : 6;
      wires.forEach((wi, i) => m.cyl(f, xs[i], 0, -deep, 0.6, Math.max(0.3, wi.d * 0.3), spec.kind === "lever" ? "#c98d5a" : TIN, 10));
      return;
    }
  }
}

/** The header, terminal or barrier cell on the part that a plug goes into. */
export function socketBody(p: MeshBuilder, m: MeshBuilder, f: Frame, kind: PlugKind, ways: number, pitch: number, used: boolean) {
  const span = (ways - 1) * pitch;
  const xs = Array.from({ length: ways }, (_, i) => (i - (ways - 1) / 2) * pitch);
  switch (kind) {
    case "xh": {
      const w = span / 2 + 2.45 + 0.35;
      // a shroud with a floor, open on top, with the lock slot in its wall
      p.box(f, -w, w, -3.2, 3.2, 0, 1.3, CREAM_DARK);
      p.box(f, -w, -w + 0.55, -3.2, 3.2, 1.3, 7, CREAM_DARK);
      p.box(f, w - 0.55, w, -3.2, 3.2, 1.3, 7, CREAM_DARK);
      p.box(f, -w + 0.55, w - 0.55, -3.2, -2.65, 1.3, 7, CREAM_DARK);
      p.box(f, -w + 0.55, -1.6, 2.65, 3.2, 1.3, 7, CREAM_DARK);
      p.box(f, 1.6, w - 0.55, 2.65, 3.2, 1.3, 7, CREAM_DARK);
      if (!used) for (const x of xs) m.box(f, x - 0.32, x + 0.32, -0.32, 0.32, 1.3, 6.2, GOLD);
      return;
    }
    case "ph": {
      const w = span / 2 + 1.95 + 0.3;
      p.box(f, -w, w, -2.6, 2.6, -4.5, 1, CREAM_DARK);
      p.box(f, -w, -w + 0.45, -2.6, 2.6, 1, 6, CREAM_DARK);
      p.box(f, w - 0.45, w, -2.6, 2.6, 1, 6, CREAM_DARK);
      p.box(f, -w + 0.45, w - 0.45, -2.6, -2.15, 1, 6, CREAM_DARK);
      p.box(f, -w + 0.45, w - 0.45, 2.15, 2.6, 1, 4.6, CREAM_DARK);
      return;
    }
    case "dupont": {
      const w = ways * 1.27;
      p.box(f, -w, w, -1.27, 1.27, 0, 2.5, BLACK);
      for (const x of xs) m.box(f, x - 0.32, x + 0.32, -0.32, 0.32, 2.5, used ? 4 : 8.5, GOLD);
      return;
    }
    case "ferrule": {
      // screw terminal block: wire entries on the z = 0 face, screws on top (+y)
      const w = (ways * pitch) / 2;
      p.box(f, -w, w, -5, 5, -7.6, 0, TERMINAL);
      for (const x of xs) {
        p.box(f, x - 1.7, x + 1.7, -2.6, 1.2, -0.05, 0.01, DARK);
        m.cyl(f, x, -3.6, 5, 5.7, 1.65, STEEL, 12, "y");
        p.box(f, x - 1.5, x + 1.5, 5.62, 5.75, -3.85, -3.35, DARK);
        // the clamp's lift between the blocks
        if (ways > 1) p.box(f, x + pitch / 2 - 0.2, x + pitch / 2 + 0.2, -5.05, 5.05, -7.6, 0, "#245c3c");
      }
      return;
    }
    case "fork": {
      // one cell of a barrier strip: walls either side, the screw on top
      const w = pitch / 2;
      p.box(f, -w, w, -7, -0.45, -9, 3, BLACK);
      p.box(f, -w, -w + 0.9, -7, 3.5, -9, 3, BLACK);
      p.box(f, w - 0.9, w, -7, 3.5, -9, 3, BLACK);
      m.box(f, -3.3, 3.3, -0.45, -0.1, -7, 2, TIN);
      m.cyl(f, 0, 0, 0.45, 2.9, 3, STEEL, 16, "y");
      p.box(f, -2.6, 2.6, 2.85, 3, -0.3, 0.3, DARK);
      p.box(f, -0.3, 0.3, 2.85, 3, -2.6, 2.6, DARK);
      return;
    }
  }
}
