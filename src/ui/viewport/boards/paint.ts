// Paints a board face into texture maps: colour (solder mask, the copper
// showing through it, plated pads, white silkscreen, holes cut out), a
// "coat" map (R: clearcoat where the mask is, G: roughness, B: metalness)
// and a normal map from the copper and silkscreen relief, so traces catch the
// light the way they do on a real board.

import * as THREE from "three";
import type { BoardLayout, Face, Pad } from "../../../machine/boards3d/layout";
import { textLines } from "../../../machine/boards3d/layout";

export interface FaceMaps {
  map: THREE.CanvasTexture;
  coat: THREE.CanvasTexture;
  normal: THREE.CanvasTexture;
}

/** Pixels per mm, keeping the long side within the texture budget (the underside is seen less, so it gets half). */
export const pxPerMm = (w: number, d: number, side: "top" | "bottom" = "top") => Math.min(14, 1280 / Math.max(w, d)) * (side === "top" ? 1 : 0.5);

const FINISH = { hasl: "#c4c6c2", enig: "#d6b25c" };

/** Mixes two colours as they are written (sRGB), the way paint and ink layer, not in linear light. */
function mix(a: string, b: string, t: number, k = 1): string {
  const c = srgb(a).lerp(srgb(b), t).multiplyScalar(k);
  return `#${new THREE.Color().setRGB(Math.min(1, c.r), Math.min(1, c.g), Math.min(1, c.b), THREE.SRGBColorSpace).getHexString()}`;
}

/** A colour's sRGB components, in a Color for its arithmetic. */
function srgb(hex: string): THREE.Color {
  const c = new THREE.Color();
  new THREE.Color(hex).getRGB(c, THREE.SRGBColorSpace);
  return c;
}

/** How much copper shows through a mask: plainly under light masks, hardly at all under black. */
function copperShow(mask: string): number {
  const c = srgb(mask);
  const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return 0.03 + Math.min(0.15, lum * 0.5);
}

/** Board coordinates (mm, y up, origin at the board's centre) on a canvas. */
function surface(L: BoardLayout, px: number) {
  const cw = Math.max(4, Math.round(L.w * px));
  const ch = Math.max(4, Math.round(L.d * px));
  const make = () => {
    const c = document.createElement("canvas");
    c.width = cw;
    c.height = ch;
    const g = c.getContext("2d")!;
    g.setTransform(cw / L.w, 0, 0, -ch / L.d, cw / 2, ch / 2);
    g.lineCap = "round";
    g.lineJoin = "round";
    return { c, g };
  };
  return { make, cw, ch };
}

type G = CanvasRenderingContext2D;
type P2 = [number, number];

// Everything of one kind goes into one path and is drawn with one call: a big
// board has thousands of traces and silkscreen strokes, and a call each is slow.

function addLine(g: G, pts: P2[]) {
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
}

function addCircle(g: G, x: number, y: number, r: number) {
  g.moveTo(x + r, y);
  g.arc(x, y, r, 0, Math.PI * 2);
}

/** Strokes polylines, one call per line width. */
function strokeAll(g: G, lines: { pts: P2[]; w: number }[]) {
  const byW = new Map<number, P2[][]>();
  for (const l of lines) if (l.pts.length) byW.set(l.w, [...(byW.get(l.w) ?? []), l.pts.length === 1 ? [l.pts[0], [l.pts[0][0] + 0.001, l.pts[0][1]]] : l.pts]);
  for (const [w, ls] of byW) {
    g.lineWidth = w;
    g.beginPath();
    for (const l of ls) addLine(g, l);
    g.stroke();
  }
}

function fillCircles(g: G, pts: P2[], r: number) {
  if (!pts.length) return;
  g.beginPath();
  for (const [x, y] of pts) addCircle(g, x, y, r);
  g.fill();
}

/** Pads in the current fill colour, grown by `grow` on every side. */
function fillPads(g: G, pads: Pad[], grow = 0) {
  const caps: { pts: P2[]; w: number }[] = [];
  const polys: P2[][] = [];
  g.beginPath();
  for (const p of pads) {
    const s = p.shape;
    if (!s) {
      if (p.round) addCircle(g, p.x, p.y, Math.max(p.w, p.h) / 2 + grow);
      else g.rect(p.x - p.w / 2 - grow, p.y - p.h / 2 - grow, p.w + 2 * grow, p.h + 2 * grow);
    } else if (s.k === "cap") {
      if (s.a[0] === s.b[0] && s.a[1] === s.b[1]) addCircle(g, s.a[0], s.a[1], s.r + grow);
      else caps.push({ pts: [s.a, s.b], w: 2 * (s.r + grow) });
    } else {
      addLine(g, s.pts);
      g.closePath();
      if (grow > 0) polys.push([...s.pts, s.pts[0]]);
    }
  }
  g.fill();
  if (!caps.length && !polys.length) return;
  g.save();
  g.strokeStyle = g.fillStyle;
  g.lineCap = "round";
  strokeAll(g, [...caps, ...polys.map((pts) => ({ pts, w: 2 * grow }))]);
  g.restore();
}

/**
 * Draws one face's layers with a colour per layer. Used three times with
 * different colours, so the colour, coat and height maps line up exactly.
 */
function drawFace(g: G, L: BoardLayout, f: Face, mirror: boolean, c: { base: string; copper: string; gap: string; pad: string; silk: string; via: string }) {
  g.fillStyle = c.base;
  g.fillRect(-L.w / 2, -L.d / 2, L.w, L.d);
  const viaR = (f.via?.pad ?? 0.6) / 2;
  if (f.polys?.length) {
    // a routed board's pour, already cut back round the other copper
    g.fillStyle = c.copper;
    g.beginPath();
    for (const ring of f.polys) addLine(g, ring);
    g.fill("evenodd");
  } else if (f.pour) {
    g.fillStyle = c.copper;
    g.fillRect(-L.w / 2 + 0.5, -L.d / 2 + 0.5, L.w - 1, L.d - 1);
  }
  // the pour stands back from every trace, pad and via
  const tracesOf = (extra: number, color: string) => {
    g.strokeStyle = color;
    g.fillStyle = color;
    strokeAll(g, f.traces.map((t) => ({ pts: t.pts, w: t.w + extra })));
    fillCircles(g, f.vias, viaR + extra / 2);
    fillPads(g, f.pads, extra / 2);
  };
  if (f.pour && !f.polys?.length) tracesOf(0.5, c.gap);
  tracesOf(0, c.copper);
  // tented via holes show as dimples
  g.fillStyle = c.via;
  fillCircles(g, f.vias, (f.via?.drill ?? 0.3) / 2);
  // plated pads
  g.fillStyle = c.pad;
  fillPads(g, f.pads);
  g.beginPath();
  for (const h of L.holes) if (h.ring) addCircle(g, h.x, h.y, h.ring / 2);
  g.fill();
  // silkscreen, kept off the pads
  g.strokeStyle = c.silk;
  g.fillStyle = c.silk;
  strokeAll(g, [
    ...f.silk.map((pts) => ({ pts, w: L.silkW })),
    ...(f.strokes ?? []),
    ...f.texts.flatMap((t) => textLines(t, mirror).map((pts) => ({ pts, w: Math.max(0.12, t.size * 0.13) }))),
  ]);
  for (const [x, y, s] of f.blocks) g.fillRect(x, y, s, s);
  g.fillStyle = c.pad;
  fillPads(g, f.pads.filter((p) => p.round));
}

/** Holes cut out of the colour map's alpha. */
function cutHoles(g: G, L: BoardLayout) {
  g.save();
  g.globalCompositeOperation = "destination-out";
  g.fillStyle = "#000";
  g.strokeStyle = "#000";
  g.lineCap = "round";
  g.beginPath();
  for (const h of L.holes) if (!h.to) addCircle(g, h.x, h.y, h.d / 2);
  g.fill();
  strokeAll(g, L.holes.filter((h) => h.to).map((h) => ({ pts: [[h.x, h.y], h.to!], w: h.d })));
  // rounded corners
  const r = L.corner;
  if (r > 0) {
    for (const [sx, sy] of [
      [1, 1],
      [-1, 1],
      [-1, -1],
      [1, -1],
    ]) {
      const cx = sx * (L.w / 2 - r);
      const cy = sy * (L.d / 2 - r);
      g.beginPath();
      g.moveTo(sx * (L.w / 2 + 0.1), sy * (L.d / 2 + 0.1));
      g.lineTo(sx * (L.w / 2 + 0.1), cy);
      g.arc(cx, cy, r, sx > 0 ? (sy > 0 ? 0 : -Math.PI / 2) : sy > 0 ? Math.PI / 2 : Math.PI, sx > 0 ? (sy > 0 ? Math.PI / 2 : 0) : sy > 0 ? Math.PI : (Math.PI * 3) / 2);
      g.lineTo(sx * (L.w / 2 + 0.1), sy * (L.d / 2 + 0.1));
      g.fill();
    }
  }
  g.restore();
}

/** A box blur of one channel, `r` pixels each way, along rows then columns. */
function blur(src: Uint8ClampedArray, w: number, h: number, r: number): Float32Array {
  const a = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) a[i] = src[i * 4];
  if (r < 1) return a;
  const b = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += a[y * w + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      b[y * w + x] = sum / n;
      sum += a[y * w + Math.min(w - 1, x + r + 1)] - a[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += b[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      a[y * w + x] = sum / n;
      sum += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x];
    }
  }
  return a;
}

/** A tangent-space normal map from a height canvas, softened by `r` pixels so edges read as slopes. */
function normalsFrom(src: HTMLCanvasElement, strength: number, r: number): HTMLCanvasElement {
  const w = src.width;
  const h = src.height;
  const hd = blur(src.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, w, h).data, w, h, r);
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const g = out.getContext("2d")!;
  const img = g.createImageData(w, h);
  const H = (x: number, y: number) => hd[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  const o = img.data;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      // canvas rows run down the board (-y), so the row slope flips sign
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
      const dy = -(H(x, y + 1) - H(x, y - 1)) * strength;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      o[i] = ((-dx / l) * 0.5 + 0.5) * 255;
      o[i + 1] = ((-dy / l) * 0.5 + 0.5) * 255;
      o[i + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      o[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  return out;
}

function texture(c: HTMLCanvasElement, color: boolean): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** The three maps for one face of a laid-out board. */
export function paintFace(L: BoardLayout, side: "top" | "bottom"): FaceMaps {
  const px = pxPerMm(L.w, L.d, side);
  const s = surface(L, px);
  const f = side === "top" ? L.top : L.bottom;
  const mirror = side === "bottom";
  const mask = L.style.mask;
  const pad = FINISH[L.style.finish];
  const col = s.make();
  drawFace(col.g, L, f, mirror, {
    base: mix(mask, "#000000", 0.18),
    copper: mix(mask, "#c08a4a", copperShow(mask), 1.05),
    gap: mix(mask, "#000000", 0.18),
    pad,
    silk: L.style.silk,
    via: mix(mask, "#000000", 0.45),
  });
  cutHoles(col.g, L);
  // R: clearcoat (the mask is glossy), G: roughness, B: metalness
  const coat = s.make();
  drawFace(coat.g, L, f, mirror, { base: "#ff5c00", copper: "#ff5000", gap: "#ff5c00", pad: L.style.finish === "enig" ? "#0038ff" : "#0050ff", silk: "#00c400", via: "#ff6600" });
  const height = s.make();
  drawFace(height.g, L, f, mirror, { base: "#000000", copper: "#5a5a5a", gap: "#000000", pad: "#6e6e6e", silk: "#c8c8c8", via: "#202020" });
  const normal = normalsFrom(height.c, 0.012, Math.max(1, Math.round(px * 0.05)));
  return { map: texture(col.c, true), coat: texture(coat.c, false), normal: texture(normal, false) };
}

/** A chip's laser marking: light grey text on a transparent square, for a decal on its top. */
export function markingTexture(text: string, w: number, d: number, dark: boolean): THREE.CanvasTexture {
  const px = 40;
  const c = document.createElement("canvas");
  c.width = Math.max(8, Math.round(w * px));
  c.height = Math.max(8, Math.round(d * px));
  const g = c.getContext("2d")!;
  const lines = text.split("\n");
  const size = Math.min((d * px) / (lines.length + 1.6), ((w * px) / Math.max(...lines.map((l) => l.length))) * 1.55);
  g.font = `600 ${size}px "Roboto Condensed", "Arial Narrow", Arial, sans-serif`;
  g.fillStyle = dark ? "rgba(40,40,44,0.92)" : "rgba(200,200,196,0.78)";
  g.textAlign = "center";
  g.textBaseline = "middle";
  lines.forEach((l, i) => g.fillText(l, c.width / 2, c.height / 2 + (i - (lines.length - 1) / 2) * size * 1.15));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
