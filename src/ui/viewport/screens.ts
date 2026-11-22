// Light from a simulation run on the parts that make it: an SSD1306 OLED's
// glass shows what the firmware drew there, pixel for pixel, as playback
// passes each frame; and an LED board lights what is around it in the colour
// and brightness its LEDs show.

import * as THREE from "three";
import type { EvalPart } from "../../core/model";
import type { CatalogPart } from "../../machine/types";
import type { DisplayFrame, DisplayRun } from "../../sim/engine/run";
import { boardOrigin } from "./boards/decorate";

/** how a lit OLED pixel and the panel between them look (as the Simulation tab's screen draws them) */
const LIT = [214, 236, 255];
const DARK = [5, 7, 10];
/** how much brighter than white a lit pixel reads, so the panel glows against the lit scene */
const GLOW = 1.6;
/** an LED at full brightness, in candela for scene units of mm: it lights what is a few cm away, as a WS2812 does */
const LED_CD = 60;

/** The frame on screen at t: the last one recorded at or before it. */
function frameAt(d: DisplayRun, t: number): DisplayFrame | undefined {
  const f = d.frames;
  let lo = 0;
  let hi = f.length - 1;
  if (hi < 0 || f[0].t > t) return undefined;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (f[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return f[lo];
}

/**
 * Where an OLED module's active area lies in its part's frame: centre, size, and the pixel grid. Its glass is the
 * board's "oled" module (catalog feature 0) as the board model draws it, pixel rows across X with row 0 at +Y (the
 * header side, the way up the usual driver setup draws).
 */
export function oledScreen(p: EvalPart, c: CatalogPart): { at: THREE.Vector3; w: number; h: number; px: [number, number] } | null {
  const s = c.specs;
  if (s.driver !== "SSD1306" || c.geom.g !== "board") return null;
  const d = c.geom.dims ?? {};
  const f = c.geom.features?.[0] as { kind?: string; x?: number; y?: number; d?: number; h?: number; rot?: number } | undefined;
  const w = Number(d.w);
  const dd = Number(d.d);
  const t = Number(d.t ?? 1.6);
  if (!f || f.kind !== "module" || f.rot || !(w > 0 && dd > 0)) return null;
  const at = boardOrigin(p.recipe, w, dd);
  if (!at) return null;
  // the glass runs 2.4 mm in from the module's ribbon edge (-Y) and 1.2 mm from the far one: its centre is 0.6 mm toward +Y
  const aw = Number(s.active_w ?? 21.74);
  const ah = Number(s.active_h ?? 10.86);
  const fh = Number(f.h ?? 1.5);
  return {
    at: new THREE.Vector3(at[0] + Number(f.x ?? 0), at[1] + Number(f.y ?? 0) + 0.6, at[2] + t + fh + 0.06),
    w: aw,
    h: ah,
    px: [Number(s.w_px ?? 128), Number(s.h_px ?? 64)],
  };
}

interface Screen {
  name: string;
  canvas: HTMLCanvasElement;
  tex: THREE.CanvasTexture;
  mesh: THREE.Mesh;
  shown: DisplayFrame | undefined | null;
}

/** The OLEDs of a run, each drawn on its own module's glass. */
export class SimScreens {
  private screens: Screen[] = [];
  private runs = new Map<string, DisplayRun>();

  /** A screen on the part `name` (a component), placed by `m` (the part's frame) in `group`. */
  add(name: string, p: EvalPart, c: CatalogPart, m: THREE.Matrix4, group: THREE.Object3D) {
    if (typeof document === "undefined") return;
    const sc = oledScreen(p, c);
    if (!sc) return;
    const canvas = document.createElement("canvas");
    canvas.width = sc.px[0];
    canvas.height = sc.px[1];
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    const mat = new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(GLOW, GLOW, GLOW), polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(sc.w, sc.h), mat);
    mesh.position.copy(sc.at);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.matrix.premultiply(m);
    mesh.castShadow = false;
    group.add(mesh);
    const s: Screen = { name, canvas, tex, mesh, shown: null };
    this.screens.push(s);
    this.paint(s, undefined);
  }

  /** The run's displays, by the component each belongs to. */
  setRuns(runs: DisplayRun[] | undefined) {
    this.runs = new Map((runs ?? []).filter((d) => d.look?.kind !== "lcd").map((d) => [d.name, d]));
    for (const s of this.screens) s.shown = null;
  }

  /** Each screen as it was at time t. */
  show(t: number) {
    for (const s of this.screens) {
      const d = this.runs.get(s.name);
      const f = d && d.w === s.canvas.width && d.h === s.canvas.height ? frameAt(d, t) : undefined;
      if (f !== s.shown) this.paint(s, f);
    }
  }

  private paint(s: Screen, f: DisplayFrame | undefined) {
    s.shown = f;
    const g = s.canvas.getContext("2d");
    if (!g) return;
    const W = s.canvas.width;
    const H = s.canvas.height;
    const img = g.createImageData(W, H);
    const row = W >> 3;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const lit = f ? (f.px[y * row + (x >> 3)] & (0x80 >> (x & 7))) !== 0 : false;
        const c = lit ? LIT : DARK;
        const i = (y * W + x) * 4;
        img.data[i] = c[0];
        img.data[i + 1] = c[1];
        img.data[i + 2] = c[2];
        img.data[i + 3] = 255;
      }
    g.putImageData(img, 0, 0);
    s.tex.needsUpdate = true;
  }

  dispose() {
    for (const s of this.screens) {
      s.mesh.removeFromParent();
      s.mesh.geometry.dispose();
      (s.mesh.material as THREE.Material).dispose();
      s.tex.dispose();
    }
    this.screens = [];
  }
}

/** A light at an LED board's LEDs that takes their colour and brightness, so they light what is around them. */
export function ledLight(points: THREE.Vector3[]): THREE.PointLight {
  const box = new THREE.Box3().setFromPoints(points);
  const span = box.getSize(new THREE.Vector3()).length();
  const l = new THREE.PointLight(0xffffff, 0, Math.max(80, span * 3), 2);
  box.getCenter(l.position);
  l.castShadow = false;
  return l;
}

/** Set an LED light from its LEDs' colours (linear, 0 for off), each at its own brightness. */
export function setLedLight(l: THREE.PointLight, colors: (THREE.Color | null)[]) {
  let r = 0;
  let g = 0;
  let b = 0;
  for (const c of colors) {
    if (!c) continue;
    r += c.r;
    g += c.g;
    b += c.b;
  }
  const sum = Math.max(r, g, b);
  if (sum <= 1e-4) {
    l.intensity = 0;
    return;
  }
  l.color.setRGB(r / sum, g / sum, b / sum);
  l.intensity = LED_CD * sum;
}
