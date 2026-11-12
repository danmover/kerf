// Making a film: the viewport draws each frame's pictures (two while one
// shot fades into the next), the 2D canvas puts the graphics over them, the
// soundtrack is rendered, and the browser's encoders write the MP4. The
// preview in the film maker draws the same frames small and fast.

import { viewport, type FilmShot, type FilmView } from "../app/viewportApi";
import { safeFileName } from "../persist/files";
import { gatherFacts } from "./gather";
import { chooseCodecs, FilmEncoder } from "./encode";
import { drawChrome, drawLayerGraphics, drawPicture, FILM_FONTS, type FilmStyle } from "./graphics";
import { soundtrack } from "./music";
import { restoreOverlays, saveOverlays, sameNeed, setOverlay } from "./overlays";
import { CROSSFADE, filmSize, QUALITY_SAMPLES, type FilmSpec } from "./spec";
import { frameAt, planFilm, shotAt, type FilmPlan, type FrameLayer, type OverlayNeed, type ShotView } from "./timeline";
import type { FilmFacts } from "./facts";

type Canvas = HTMLCanvasElement | OffscreenCanvas;
type Ctx2 = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function canvas(w: number, h: number): Canvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}
const ctx2d = (c: Canvas) => c.getContext("2d") as Ctx2;

export async function loadFilmFonts() {
  if (typeof document === "undefined" || !document.fonts) return;
  await Promise.all(FILM_FONTS.map((f) => document.fonts.load(f).catch(() => null)));
}

const toShot = (v: ShotView, overlays: boolean): FilmShot => ({ camera: v.camera, explode: v.explode, build: v.build, angle: v.angle, section: v.section, focus: v.focus, overlays, clock: v.clock });

/**
 * Draws a film's frames through one viewport session: the film itself and the
 * preview both use one of these.
 */
export class FrameDrawer {
  private out: Canvas;
  private raw: Canvas[] = [];
  private layers: Canvas[] = [];
  /** the overlay on now, and the overlay of the shot that asked for it */
  private active: OverlayNeed | null = null;
  private activeShot = -1;
  plan!: FilmPlan;
  facts!: FilmFacts;
  style!: FilmStyle;

  constructor(
    readonly view: FilmView,
    public spec: FilmSpec,
  ) {
    this.out = canvas(view.width, view.height);
    this.replan(spec);
  }

  get canvas(): Canvas {
    return this.out;
  }

  replan(spec: FilmSpec) {
    this.spec = spec;
    this.facts = gatherFacts(this.view.layout(), spec.look);
    this.plan = planFilm(spec, this.facts, this.view.width / this.view.height);
    this.style = { accent: spec.accent, light: this.facts.light, width: this.view.width, height: this.view.height };
  }

  resize(w: number, h: number) {
    this.view.resize(w, h);
    if (this.out.width !== w || this.out.height !== h) this.out = canvas(w, h);
    this.raw = [];
    this.layers = [];
    this.style = { ...this.style, width: w, height: h };
    this.plan = planFilm(this.spec, this.facts, w / h);
  }

  /** The overlay to have on at t: the last shot that has fully faded in decides it. */
  private wantedAt(t: number): { need: OverlayNeed | null; shot: number } {
    let shot = this.plan.shots[0];
    for (const s of this.plan.shots) if (s.start + CROSSFADE <= t + 1e-6 || s.index === 0) shot = s;
    return { need: shotAt(this.plan, shot, Math.min(shot.section.seconds, Math.max(0, t - shot.start))).view.overlay, shot: shot.index };
  }

  /** Put on the overlay frame t needs (it takes the app a few frames to show one). */
  async prepare(t: number) {
    const w = this.wantedAt(t);
    if (!sameNeed(w.need, this.active)) {
      await setOverlay(w.need);
      this.active = w.need;
    }
    // each shot starts the overlay's own animations again (streamlines flowing in)
    if (w.shot !== this.activeShot) this.view.restartOverlays();
    this.activeShot = w.shot;
  }

  /** Draw frame t into the drawer's canvas. `samples` per picture; `shutter` seconds of motion blur (0 for none). */
  draw(t: number, samples: number, shutter: number): Canvas {
    const f = frameAt(this.plan, t);
    const W = this.view.width;
    const H = this.view.height;
    const main = ctx2d(this.out);
    main.globalAlpha = 1;
    main.filter = "none";
    main.clearRect(0, 0, W, H);
    f.layers.forEach((layer, i) => {
      const img = this.picture(layer, samples, shutter);
      if (!this.raw[i]) this.raw[i] = canvas(W, H);
      if (!this.layers[i]) this.layers[i] = canvas(W, H);
      ctx2d(this.raw[i]).putImageData(img, 0, 0);
      const lc = ctx2d(this.layers[i]);
      lc.globalAlpha = 1;
      lc.clearRect(0, 0, W, H);
      drawPicture(lc, this.style, this.raw[i], layer);
      main.globalAlpha = i === 0 ? 1 : layer.weight;
      main.drawImage(this.layers[i], 0, 0);
    });
    main.globalAlpha = 1;
    for (const layer of f.layers) drawLayerGraphics(main, this.style, layer, this.spec.badge);
    drawChrome(main, this.style, f, this.spec.badge, true);
    return this.out;
  }

  private picture(layer: FrameLayer, samples: number, shutter: number): ImageData {
    const shot = this.plan.shots[layer.shot];
    const need = layer.view.overlay;
    const on = !!need && sameNeed(need, this.active);
    if (on && need?.kind === "sim") this.view.simTime(need.t);
    const s = toShot(layer.view, on);
    let to: FilmShot | undefined;
    if (shutter > 0) {
      const next = shotAt(this.plan, shot, Math.min(shot.section.seconds, layer.view.clock + shutter)).view;
      to = toShot(next, on);
    }
    return this.view.render(s, samples, to);
  }

  /** Put the overlays back as they were before the film. */
  async finish(saved: ReturnType<typeof saveOverlays>) {
    await restoreOverlays(saved);
  }
}

export interface FilmProgress {
  stage: "preparing" | "sound" | "frames" | "finishing";
  frame: number;
  frames: number;
  /** ms since the start */
  elapsed: number;
  /** ms left, once a few frames have been timed */
  left: number | null;
}

export interface FilmResult {
  blob: Blob;
  name: string;
  seconds: number;
  width: number;
  height: number;
  /** e.g. "H.264 + AAC" */
  codecs: string;
  ms: number;
  /** small JPEG stills of the frames asked for, base64 */
  stills: { t: number; data: string; width: number; height: number }[];
}

export interface FilmJobOptions {
  onProgress?: (p: FilmProgress) => void;
  /** called now and then with the frame just drawn, for a live picture */
  onFrame?: (c: Canvas) => void;
  signal?: AbortSignal;
  /** times (seconds) to keep a small still of, for the assistant to look at */
  stills?: number[];
}

/** A canvas as a small JPEG, base64. */
export async function jpegOf(c: Canvas, maxW: number): Promise<{ data: string; width: number; height: number }> {
  const k = Math.min(1, maxW / c.width);
  const w = Math.max(1, Math.round(c.width * k));
  const h = Math.max(1, Math.round(c.height * k));
  const small = canvas(w, h);
  ctx2d(small).drawImage(c, 0, 0, w, h);
  let blob: Blob;
  if ("convertToBlob" in small) blob = await small.convertToBlob({ type: "image/jpeg", quality: 0.84 });
  else blob = await new Promise<Blob>((res, rej) => (small as HTMLCanvasElement).toBlob((b) => (b ? res(b) : rej(new Error("No image"))), "image/jpeg", 0.84));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { data: btoa(bin), width: w, height: h };
}

const CODEC_NAMES: Record<string, string> = { avc: "H.264", vp9: "VP9", aac: "AAC", opus: "Opus" };

/** Render and encode a whole film. */
export async function makeFilm(spec: FilmSpec, opts: FilmJobOptions = {}): Promise<FilmResult> {
  const vp = viewport();
  if (!vp) throw new Error("The 3D view isn't open");
  const t0 = performance.now();
  const { width, height } = filmSize(spec.aspect, spec.size);
  const progress = (p: Omit<FilmProgress, "elapsed">) => opts.onProgress?.({ ...p, elapsed: performance.now() - t0 });
  progress({ stage: "preparing", frame: 0, frames: 0, left: null });
  const codecs = await chooseCodecs(width, height, spec.fps, spec.music !== "off");
  await loadFilmFonts();
  const saved = saveOverlays();
  await setOverlay(null);
  const view = vp.film({ width, height, look: spec.look, fine: spec.quality !== "draft" });
  const enc = new FilmEncoder(codecs, width, height, spec.fps);
  try {
    const d = new FrameDrawer(view, spec);
    if (!d.plan.shots.length) throw new Error("The film has no sections");
    const frames = Math.max(1, Math.round(d.plan.duration * spec.fps));
    progress({ stage: "sound", frame: 0, frames, left: null });
    const sound = await soundtrack(d.plan, spec.music);
    if (sound) await enc.addAudio(sound);
    const samples = QUALITY_SAMPLES[spec.quality];
    // a shutter open for half the frame, when there are samples enough to smooth it
    const shutter = spec.motionBlur && samples >= 6 ? 0.5 / spec.fps : 0;
    const start = performance.now();
    const want = new Map((opts.stills ?? []).map((t) => [Math.min(frames - 1, Math.max(0, Math.round(t * spec.fps))), t]));
    const stills: FilmResult["stills"] = [];
    for (let i = 0; i < frames; i++) {
      if (opts.signal?.aborted) throw new DOMException("The film was stopped", "AbortError");
      const t = i / spec.fps;
      await d.prepare(t);
      const c = d.draw(t, samples, shutter);
      await enc.addFrame(c);
      if (want.has(i)) stills.push({ t: want.get(i)!, ...(await jpegOf(c, 640)) });
      if (i % 3 === 0 || i === frames - 1) {
        const per = (performance.now() - start) / (i + 1);
        progress({ stage: "frames", frame: i + 1, frames, left: i >= 4 ? per * (frames - i - 1) : null });
      }
      if (opts.onFrame && i % 6 === 0) opts.onFrame(c);
      // let the page breathe: progress and the Stop button stay live
      if (i % 2 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    progress({ stage: "finishing", frame: frames, frames, left: 0 });
    const blob = await enc.finish();
    const names = [CODEC_NAMES[codecs.video.kind], codecs.audio && sound ? CODEC_NAMES[codecs.audio.kind] : ""].filter(Boolean).join(" + ");
    return { blob, name: safeFileName(spec.title || "design", "mp4"), seconds: frames / spec.fps, width, height, codecs: names, ms: performance.now() - t0, stills };
  } finally {
    enc.close();
    view.end();
    await restoreOverlays(saved);
  }
}

const openPreviews = new Set<FilmPreview>();

/** The film maker's preview: the film's frames, small and quick, drawn on demand. */
export class FilmPreview {
  private drawer: FrameDrawer;
  private saved: ReturnType<typeof saveOverlays>;
  private busy = false;
  private queued: number | null = null;
  private closed = false;
  private look: string;

  private constructor(
    private view: FilmView,
    spec: FilmSpec,
    saved: ReturnType<typeof saveOverlays>,
    private onDrawn: (c: Canvas, t: number) => void,
  ) {
    this.saved = saved;
    this.drawer = new FrameDrawer(view, spec);
    this.look = spec.look;
  }

  static async open(spec: FilmSpec, onDrawn: (c: Canvas, t: number) => void): Promise<FilmPreview> {
    const vp = viewport();
    if (!vp) throw new Error("The 3D view isn't open");
    await loadFilmFonts();
    const saved = saveOverlays();
    await setOverlay(null);
    const { width, height } = previewSize(spec);
    const p = new FilmPreview(vp.film({ width, height, look: spec.look }), spec, saved, onDrawn);
    openPreviews.add(p);
    return p;
  }

  /** Close every open preview (a render needs the view to itself). */
  static async closeAll() {
    await Promise.all([...openPreviews].map((p) => p.close()));
  }

  get plan(): FilmPlan {
    return this.drawer.plan;
  }

  get facts(): FilmFacts {
    return this.drawer.facts;
  }

  /** A changed film: a new look needs the view handed over again in that lighting. */
  update(spec: FilmSpec) {
    if (this.closed) return;
    if (spec.look !== this.look) {
      const vp = viewport();
      this.view.end();
      const { width, height } = previewSize(spec);
      this.view = vp!.film({ width, height, look: spec.look });
      this.drawer = new FrameDrawer(this.view, spec);
      this.look = spec.look;
      return;
    }
    const { width, height } = previewSize(spec);
    if (width !== this.view.width || height !== this.view.height) this.drawer.resize(width, height);
    this.drawer.replan(spec);
  }

  /** Draw time t (the latest asked for wins while one is drawing). */
  async show(t: number) {
    if (this.closed) return;
    if (this.busy) {
      this.queued = t;
      return;
    }
    this.busy = true;
    try {
      let next: number | null = t;
      while (next !== null && !this.closed) {
        const at: number = next;
        this.queued = null;
        await this.drawer.prepare(at);
        if (this.closed) break;
        this.onDrawn(this.drawer.draw(at, 1, 0), at);
        next = this.queued;
      }
    } finally {
      this.busy = false;
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    openPreviews.delete(this);
    this.view.end();
    await this.drawer.finish(this.saved);
  }
}

/** The preview's size: the film's shape, 360 pixels on its short side. */
export function previewSize(spec: FilmSpec) {
  return filmSize(spec.aspect, 360);
}
