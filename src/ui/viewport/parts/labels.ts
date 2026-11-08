// Printed labels for bought electronics, painted on a canvas: a LiPo pack's
// shrink-wrap print, an ESC's label band, a servo's sticker and the moulded
// lettering on plugs and fuse holders. Pure 2D drawing in millimetres; the
// decorator (decorate.ts) puts them on the parts.

import * as THREE from "three";

export interface LabelSpec {
  /** size of the face in mm: across (canvas x) and up (canvas y) */
  w: number;
  h: number;
  draw: (g: CanvasRenderingContext2D, mm: (v: number) => number, W: number, H: number) => void;
  /** transparent where nothing is drawn (moulded lettering), else a full label */
  clear?: boolean;
}

const FONT = '"IBM Plex Sans", "Segoe UI", Arial, sans-serif';

/** Paint a label at about 12 px per mm (at most 1024 px a side). */
export function labelTexture(spec: LabelSpec): THREE.CanvasTexture {
  const ppm = Math.min(12, 1024 / Math.max(spec.w, spec.h));
  const W = Math.max(8, Math.round(spec.w * ppm));
  const H = Math.max(8, Math.round(spec.h * ppm));
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  spec.draw(g, (v) => v * ppm, W, H);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export const font = (weight: number, px: number) => `${weight} ${Math.max(1, px).toFixed(1)}px ${FONT}`;

/** Text squeezed to fit a width, like a printed label's condensed type. */
export function fitText(g: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number) {
  const w = g.measureText(text).width;
  if (w <= maxW || w === 0) return g.fillText(text, x, y);
  g.save();
  const k = maxW / w;
  // scaled about the anchor, so left, centre and right alignment all hold
  g.translate(x, y);
  g.scale(k, 1);
  g.fillText(text, 0, 0);
  g.restore();
}

/** Fine print: rows of tiny grey lines of text, as on any battery's warning panel. */
export function finePrint(g: CanvasRenderingContext2D, x: number, y: number, w: number, rows: number, px: number, color: string) {
  const words = ["CAUTION", "Charge with a LiPo balance charger only.", "Never leave charging unattended.", "Do not puncture, short or overheat.", "Store at 3.8 V per cell.", "Keep away from children."];
  g.fillStyle = color;
  g.font = font(400, px);
  g.textAlign = "left";
  g.textBaseline = "top";
  for (let i = 0; i < rows; i++) fitText(g, words.slice(i % words.length).concat(words).slice(0, 3).join("  "), x, y + i * px * 1.35, w);
}

/** Specs printed on a LiPo, from the catalog's specs and name. */
export interface PackText {
  brand: string;
  model: string;
  mah: number;
  volts: number;
  cells: number;
  c: number;
}

const tidy = (v: number) => (Math.round(v * 10) / 10).toString();

/** The pack's top: an accent band, the capacity big, voltage and cell count, the C rating, and the warning panel. */
export function packTop(w: number, d: number, accent: string, t: PackText): LabelSpec {
  return {
    w,
    h: d,
    draw: (g, mm, W, H) => {
      const bg = g.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, "#1b1d21");
      bg.addColorStop(0.5, "#24272c");
      bg.addColorStop(1, "#16181b");
      g.fillStyle = bg;
      g.fillRect(0, 0, W, H);
      // a slanted accent band near the lead end's far side, and a thin rule
      g.fillStyle = accent;
      g.beginPath();
      g.moveTo(W * 0.06, 0);
      g.lineTo(W * 0.06 + mm(9), 0);
      g.lineTo(W * 0.06 + mm(9) - H * 0.35, H);
      g.lineTo(W * 0.06 - H * 0.35, H);
      g.closePath();
      g.fill();
      g.fillRect(W * 0.18, H * 0.83, W * 0.74, Math.max(1, mm(0.35)));
      const x0 = W * 0.2;
      const span = W * 0.74;
      const big = Math.min(mm(d * 0.26), mm(11));
      g.textBaseline = "alphabetic";
      g.textAlign = "left";
      g.fillStyle = "#f2f2f0";
      if (t.brand) {
        g.font = font(700, big * 0.42);
        fitText(g, t.brand.toUpperCase(), x0, H * 0.2, span * 0.55);
        if (t.model) {
          g.fillStyle = accent;
          g.font = font(600, big * 0.36);
          fitText(g, t.model.toUpperCase(), x0 + Math.min(span * 0.56, g.measureText(t.brand.toUpperCase()).width * 1.25 + mm(2)), H * 0.2, span * 0.4);
        }
      }
      g.fillStyle = "#f7f7f5";
      g.font = font(700, big);
      fitText(g, `${t.mah}mAh`, x0, H * 0.52, span * 0.62);
      g.font = font(600, big * 0.45);
      g.fillStyle = "#c9ccd1";
      fitText(g, `${tidy(t.volts)}V  ${t.cells}S1P  LiPo`, x0, H * 0.72, span * 0.62);
      // the C rating in the accent colour on the right
      g.textAlign = "right";
      g.fillStyle = accent;
      g.font = font(800, big * 1.05);
      fitText(g, `${t.c}C`, x0 + span, H * 0.6, span * 0.34);
      g.font = font(500, big * 0.3);
      g.fillStyle = "#9aa0a8";
      fitText(g, `${tidy((t.mah * t.volts) / 1000)}Wh`, x0 + span, H * 0.75, span * 0.3);
      finePrint(g, x0, H * 0.86, span, 2, Math.max(2, mm(0.9)), "#7d828a");
    },
  };
}

/** A pack's long side: the band carried round, the specs on one line, and fine print. */
export function packSide(w: number, h: number, accent: string, t: PackText): LabelSpec {
  return {
    w,
    h,
    draw: (g, mm, W, H) => {
      g.fillStyle = "#1d1f23";
      g.fillRect(0, 0, W, H);
      g.fillStyle = accent;
      g.fillRect(W * 0.06 - H * 0.2, 0, mm(9), H);
      g.textBaseline = "middle";
      g.textAlign = "left";
      g.fillStyle = "#eceded";
      const px = Math.min(mm(h * 0.3), mm(6));
      g.font = font(700, px);
      fitText(g, `${t.brand ? t.brand.toUpperCase() + "  " : ""}${t.mah}mAh  ${tidy(t.volts)}V  ${t.c}C`, W * 0.2, H * 0.42, W * 0.74);
      finePrint(g, W * 0.2, H * 0.66, W * 0.74, 1, Math.max(2, mm(0.85)), "#80858d");
    },
  };
}

/** An ESC's label band: its name big, the rating under it. */
export function escBand(w: number, h: number, color: string, name: string, sub: string): LabelSpec {
  return {
    w,
    h,
    draw: (g, mm, W, H) => {
      g.fillStyle = color;
      g.fillRect(0, 0, W, H);
      const shade = g.createLinearGradient(0, 0, 0, H);
      shade.addColorStop(0, "rgba(255,255,255,0.12)");
      shade.addColorStop(0.5, "rgba(255,255,255,0)");
      shade.addColorStop(1, "rgba(0,0,0,0.18)");
      g.fillStyle = shade;
      g.fillRect(0, 0, W, H);
      g.fillStyle = "#ffffff";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.font = font(800, Math.min(mm(h * 0.42), mm(5)));
      fitText(g, name.toUpperCase(), W / 2, H * 0.4, W * 0.86);
      g.font = font(500, Math.min(mm(h * 0.2), mm(2.2)));
      g.fillStyle = "rgba(255,255,255,0.85)";
      fitText(g, sub, W / 2, H * 0.76, W * 0.86);
    },
  };
}

/** A servo's side sticker. */
export function servoSticker(w: number, h: number, model: string, sub: string): LabelSpec {
  return {
    w,
    h,
    draw: (g, mm, W, H) => {
      g.fillStyle = "#2b2f36";
      g.fillRect(0, 0, W, H);
      g.fillStyle = "#3f7fd8";
      g.fillRect(0, H * 0.78, W, H * 0.22);
      g.fillStyle = "#f4f5f6";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.font = font(800, Math.min(mm(h * 0.32), mm(5)));
      fitText(g, model.toUpperCase(), W / 2, H * 0.36, W * 0.88);
      g.font = font(500, Math.min(mm(h * 0.13), mm(1.8)));
      g.fillStyle = "#c9ced6";
      fitText(g, sub, W / 2, H * 0.62, W * 0.9);
      g.fillStyle = "#ffffff";
      g.font = font(600, Math.min(mm(h * 0.12), mm(1.6)));
      fitText(g, "METAL GEAR", W / 2, H * 0.89, W * 0.9);
    },
  };
}

/** Lettering moulded into a plastic part: only the letters, a shade darker than the plastic. */
export function moulded(w: number, h: number, lines: string[], ink: string): LabelSpec {
  return {
    w,
    h,
    clear: true,
    draw: (g, mm, W, H) => {
      g.fillStyle = ink;
      g.textAlign = "center";
      g.textBaseline = "middle";
      const n = lines.length;
      lines.forEach((l, i) => {
        const px = (i === 0 ? 0.36 : 0.22) * Math.min(H, (W / Math.max(3, l.length)) * 2.2);
        g.font = font(700, px);
        fitText(g, l, W / 2, (H * (i + 0.5)) / n, W * 0.9);
      });
      void mm;
    },
  };
}
