// The CAD viewport scene: shared geometry per solid hash, realistic
// materials, studio lighting, selection, ghosting, section cuts, exploded
// views, gear motion, interference highlights and the animations between
// states. Frames are built by RenderPipeline and only rendered on demand:
// while the view is still, the image refines and then the GPU rests.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { EvalPart } from "../../core/model";
import type { MeshEntry } from "../../core/engine";
import type { MeshData } from "../../kernel/build";
import type { Interference } from "../../kernel/protocol";
import { xformMatrix } from "../../kernel/recipe";
import type { ViewPreset } from "../../app/view";
import { appearanceFor, type Appearance } from "./render/appearance";
import { applyAppearance, capMaterial, partUniforms, patchPartMaterial, type PartUniforms } from "./render/partShader";
import { RenderPipeline, SAMPLES, type Quality } from "./render/pipeline";
import { StudioEnvironments, concentricDisc, dirFrom, halton, lightingPreset, type LightingPreset } from "./render/studio";
import type { PhotoRenderer, PhotoPart, PhotoQuality, PhotoStage } from "./render/photoreal";
import { MeasureOverlay } from "./measure";

const ACCENT = new THREE.Color("#6d8bff");
/** how long a finger or pen is held still to open the spot chat, ms */
const HOLD_MS = 550;
const HOVER = new THREE.Color("#a9bcff");

/** Layers used to draw subsets of the parts (selection mask). */
const L_OPAQUE = 1;
const L_SEL = 2;
const L_HOVER = 3;
/** process marks, drawn again over the photoreal image (which has none of its own) */
const L_MARKS = 4;

interface GeoEntry {
  mesh: THREE.BufferGeometry;
  edges: THREE.BufferGeometry;
  users: number;
}

interface Spring {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  /** time before which the spring holds still (staggered starts) */
  hold: number;
}

interface PartObj {
  id: string;
  part: EvalPart;
  group: THREE.Group;
  mesh: THREE.Mesh;
  cap: THREE.Mesh;
  edges: THREE.LineSegments;
  mat: THREE.MeshPhysicalMaterial;
  u: PartUniforms;
  cap$: ReturnType<typeof capMaterial>;
  edgeMat: THREE.LineBasicMaterial;
  geoKey: string;
  hash: string;
  look: Appearance;
  placement: THREE.Matrix4;
  /** local-space centre, for the explode direction */
  center: THREE.Vector3;
  explode: Spring;
  reveal: { t0: number; dur: number; zMin: number; zMax: number; plane: THREE.Plane } | null;
  /** dissolve in after a rebuild, or out on removal */
  dissolve: { t0: number; dur: number; out: boolean } | null;
  flash: { t0: number; dur: number } | null;
  removing: boolean;
  opacity: number;
  opacityTarget: number;
  /** last state that affects the rendered image (for resetting the accumulation) */
  sig: string;
}

/** The previous geometry of a rebuilt part, dissolving away. */
interface Ghost {
  group: THREE.Group;
  mat: THREE.MeshPhysicalMaterial;
  u: PartUniforms;
  edgeMat: THREE.LineBasicMaterial;
  geoKey: string;
  t0: number;
  dur: number;
}

/** What is under a point on screen: the part, and the spot on it in the part's own frame and in the assembly. */
export interface Hit {
  id: string;
  /** in the part's own frame, before its placement */
  local: [number, number, number];
  /** in assembly coordinates, without explode or motion */
  point: [number, number, number];
  /** outward face normal, in assembly coordinates */
  normal: [number, number, number];
}

const tuple = (v: THREE.Vector3): [number, number, number] => [v.x, v.y, v.z];

/**
 * Something drawn on top of the model by another module (analysis results,
 * for example). The scene owns the render loop; an overlay only adds its
 * objects, says which parts it draws in their place, and animates on tick.
 * Overlays are drawn after the accumulated image, lit by a simple rig, and
 * hidden where the remaining opaque parts are in front of them.
 */
export interface SceneOverlay {
  readonly object: THREE.Object3D;
  /** part ids the overlay draws instead of the normal solids */
  readonly replaces: ReadonlySet<string>;
  /** advance animations; return true while more frames are needed */
  tick?(now: number, dt: number): boolean;
  /** the section planes in use, or null */
  setClipping?(planes: THREE.Plane[] | null): void;
  /** jump to the end state of any animation, for a still image */
  still?(): void;
}

export interface DisplayState {
  hidden: Set<string>;
  selected: Set<string>;
  hovered: string | null;
  focus: Set<string>;
  isolate: boolean;
  xray: boolean;
  edges: boolean;
  grid: boolean;
  reduceMotion: boolean;
}

export interface RenderSettings {
  lighting: string;
  /** degrees the lighting is turned about the vertical axis */
  lightAngle: number;
  quality: Quality;
  /** path trace the view while it is still */
  photoreal: boolean;
  /** the app theme: a dark lighting set swaps to a pale backdrop in the light theme */
  theme?: "dark" | "light";
}

/** What the photoreal view is doing, for the viewport's status line. */
export interface PhotoStatus {
  state: "off" | "paused" | "waiting" | "preparing" | "rendering" | "done";
  /** why it is paused, as a line to show */
  reason?: string;
  samples: number;
  max: number;
}

const PHOTO_QUALITY: Record<Quality, (pixelRatio: number) => PhotoQuality> = {
  draft: () => ({ maxSamples: 96, scale: 0.5, bounces: 3 }),
  // trace at CSS pixels on high-density screens
  balanced: (pr) => ({ maxSamples: 512, scale: Math.min(1, 1 / pr), bounces: 5 }),
  high: () => ({ maxSamples: 2048, scale: 1, bounces: 8 }),
};
/** interactive samples drawn under the photoreal view before path tracing starts */
const PHOTO_PREVIEW = 8;
/** stillness before path tracing starts, ms */
const PHOTO_DELAY = 250;
/** samples by which the path traced image has fully replaced the interactive one */
const PHOTO_TAKEOVER = 12;
/** longest the trace waits for a model to finish building, ms: detail builds can take a while, but one that stalls must not hold it for good */
const PHOTO_SETTLE_MAX = 60_000;

/** The GPU is emulated on the CPU: fine for the interactive view, far too slow to path trace. */
function softwareRenderer(gl: WebGLRenderingContext | WebGL2RenderingContext): boolean {
  try {
    // for testing in a headless browser: localStorage["kerf.photoreal.software"] = "allow"
    if (localStorage.getItem("kerf.photoreal.software") === "allow") return false;
  } catch {
    /* storage blocked */
  }
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? "");
  return /swiftshader|llvmpipe|softpipe|lavapipe|software|basic render/i.test(name);
}

/** Temporary look shown while hovering a material in the picker. */
export interface AppearanceOverride {
  material: string;
  finish?: string;
  color: string;
}

const ease = (k: number) => (k <= 0 ? 0 : k >= 1 ? 1 : 1 - Math.pow(1 - k, 3));
const easeInOut = (k: number) => (k <= 0 ? 0 : k >= 1 ? 1 : k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

export class SceneController {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private pipe: RenderPipeline;
  private envs: StudioEnvironments;
  private preset: LightingPreset = lightingPreset("studio");
  private render$: RenderSettings = { lighting: "studio", lightAngle: 0, quality: "balanced", photoreal: false };
  private photo: PhotoRenderer | null = null;
  /** how much of the frame is the path traced image (fades in) */
  private photoMix = 0;
  private photoStatusKey = "";
  private photoStatusAt = 0;
  /** photoreal status changed (throttled) */
  onPhotoStatus: (s: PhotoStatus) => void = () => undefined;
  private photoLookOn = false;
  /** the last frame only traced: its length is the tracer's cost */
  private traceOnly = false;
  /** the path tracer's code is loading (it is only fetched when first used) */
  private photoLoading = false;
  private photoError = "";
  /** the GPU is emulated in software (SwiftShader, llvmpipe): far too slow to path trace */
  private softwareGL = false;
  private sketching = false;
  /** process issues are marked on the parts; the traced image has no marks of its own */
  private processMarks = false;
  /** when the model started building again (ms), or null once it has settled */
  private settlingSince: number | null = null;
  private photoHeld = false;
  private root = new THREE.Group();
  private overlay = new THREE.Scene();
  private interGroup = new THREE.Group();
  private parts = new Map<string, PartObj>();
  private ghosts: Ghost[] = [];
  private geos = new Map<string, GeoEntry>();
  private seenHashByPart = new Map<string, string>();
  private grid: THREE.Mesh;
  private gridMat: THREE.ShaderMaterial;
  private ground: THREE.Mesh;
  private groundMat: THREE.ShadowMaterial;
  private key: THREE.DirectionalLight;
  private keyDir = new THREE.Vector3();
  private triadScene = new THREE.Scene();
  private triadCam = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);
  private sectionFrame: THREE.LineLoop;
  private sectionFill: THREE.Mesh;
  private depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false });
  private maskMat = new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
  /** something in the scene changed: restart the accumulation */
  private changed = true;
  private maskDirty = true;
  private needComposite = true;
  private raf = 0;
  private last = performance.now();
  private camAnim: { t0: number; dur: number; fromDir: THREE.Vector3; toDir: THREE.Vector3; fromDist: number; toDist: number; fromTarget: THREE.Vector3; toTarget: THREE.Vector3 } | null = null;
  private display: DisplayState = { hidden: new Set(), selected: new Set(), hovered: null, focus: new Set(), isolate: false, xray: false, edges: true, grid: true, reduceMotion: false };
  private section = { on: false, axis: "x" as "x" | "y" | "z", t: 0.5, flip: false };
  /** animated section position: slides in from the edge when switched on */
  private sectionAnim = { t: 1, on: false, fade: 0 };
  private sectionPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
  private explodeAmt = 0;
  private assembly: { t0: number; order: string[] } | null = null;
  private playing = false;
  private speed = 1;
  private angle = 0;
  private bounds = new THREE.Box3(new THREE.Vector3(-50, -50, 0), new THREE.Vector3(50, 50, 40));
  private hasFitted = false;
  private interferences: { obj: THREE.Mesh; id: string }[] = [];
  private focusCheck: string | null = null;
  private ro: ResizeObserver;
  private raycaster = new THREE.Raycaster();
  private selAmt = 0;
  private swatchPipe: RenderPipeline | null = null;
  /** selection fill, faded out while materials are being chosen so parts show their true colour */
  private selFill = 1;
  private materialMode = false;
  private hoverAmt = 0;
  private selKey = "";
  private hoverKey = "";
  private overrides = new Map<string, AppearanceOverride>();
  private turntable = false;
  private lightDrag: { x: number; angle: number } | null = null;
  private swatchCache = new Map<string, string>();
  private disposed = false;
  private measure = new MeasureOverlay();
  private overlays = new Set<SceneOverlay>();
  /** parts drawn by an overlay instead of as solids */
  private replaced = new Set<string>();
  /** lights for lit overlays: the studio lighting only reaches the accumulated scene */
  private overlayLights = new THREE.Group();
  private overlayKey = new THREE.DirectionalLight(0xffffff, 2.2);
  debugReason = "";
  onHover: (id: string | null) => void = () => undefined;
  onPick: (id: string | null, additive: boolean) => void = () => undefined;
  onDoublePick: (id: string | null) => void = () => undefined;
  /** a right-click without dragging: what is under the pointer, and where on screen */
  onContext: (hit: Hit | null, clientX: number, clientY: number) => void = () => undefined;
  /** a finger or pen held still on the view, in client pixels, and null when it lifts, moves or completes */
  onHold: (at: { x: number; y: number } | null) => void = () => undefined;
  onFirstFrame: () => void = () => undefined;
  /** the user turned the lighting by dragging with Alt held */
  onLightAngle: (deg: number) => void = () => undefined;
  /** the turntable stopped because the user took the camera */
  onTurntableStop: () => void = () => undefined;
  private renderListeners = new Set<() => void>();
  /** until the user moves the camera, the first complete build re-frames the model */
  private autoFit = true;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // tone mapping happens in the pipeline's composite pass
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.localClippingEnabled = true;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.autoClear = false;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.classList.add("vp-canvas");
    this.softwareGL = softwareRenderer(this.renderer.getContext());
    // a GPU that resets mid-trace must not be sent straight back into it
    this.renderer.domElement.addEventListener("webglcontextlost", () => {
      if (!this.photo && !this.photoLoading) return;
      this.photoError = "The graphics card reset during the photoreal render, so it stopped";
      this.dropPhoto();
    });
    this.pipe = new RenderPipeline(this.renderer);
    this.pipe.look.selColor.copy(ACCENT);
    this.pipe.look.hoverColor.copy(HOVER);
    this.envs = new StudioEnvironments(this.renderer);

    this.camera = new THREE.PerspectiveCamera(32, 1, 0.5, 20000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(220, -260, 190);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = true;
    this.controls.autoRotateSpeed = 1.1;
    this.controls.addEventListener("start", () => {
      this.camAnim = null;
      this.autoFit = false;
      if (this.turntable) {
        this.turntable = false;
        this.controls.autoRotate = false;
        this.onTurntableStop();
      }
    });

    this.key = new THREE.DirectionalLight(0xffffff, 2);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.bias = -0.0002;
    this.scene.add(this.key, this.key.target);

    this.gridMat = gridMaterial();
    this.grid = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.gridMat);
    this.grid.renderOrder = -1;
    this.scene.add(this.grid);
    this.groundMat = new THREE.ShadowMaterial({ opacity: 0.5, transparent: true });
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.groundMat);
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    this.scene.add(this.root);
    this.overlay.add(this.interGroup);
    const frameGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.5, -0.5, 0), new THREE.Vector3(0.5, -0.5, 0), new THREE.Vector3(0.5, 0.5, 0), new THREE.Vector3(-0.5, 0.5, 0)]);
    this.sectionFrame = new THREE.LineLoop(frameGeo, new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0, depthTest: false }));
    this.sectionFill = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
    this.sectionFrame.matrixAutoUpdate = false;
    this.sectionFill.matrixAutoUpdate = false;
    this.overlay.add(this.sectionFill, this.sectionFrame);
    this.overlay.add(this.measure.group);
    const hemi = new THREE.HemisphereLight(0xf2f5ff, 0x2a2f3a, 1.5);
    hemi.position.set(0, 0, 1);
    this.overlayLights.add(hemi, this.overlayKey);
    this.overlay.add(this.overlayLights);
    this.buildTriad();
    this.applyLighting();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    this.layoutStage();

    const el = this.renderer.domElement;
    let down: { x: number; y: number } | null = null;
    // Alt-drag turns the lighting; it must run before the orbit controls see the press
    el.addEventListener(
      "pointerdown",
      (e) => {
        if (e.altKey && e.button === 0) {
          this.controls.enabled = false;
          this.lightDrag = { x: e.clientX, angle: this.render$.lightAngle };
          el.setPointerCapture(e.pointerId);
        }
      },
      { capture: true },
    );
    // On a touch screen or with a pen, pressing and holding is the right click:
    // it opens the spot chat on what is under the finger. A second finger
    // (a pinch) or a move of more than a few pixels cancels it.
    let hold: { timer: number; x: number; y: number } | null = null;
    const endHold = () => {
      if (!hold) return;
      clearTimeout(hold.timer);
      hold = null;
      this.onHold(null);
    };
    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" || !e.isPrimary) return endHold();
      const { clientX: x, clientY: y } = e;
      hold = {
        x,
        y,
        timer: window.setTimeout(() => {
          endHold();
          down = null;
          // the finger lifts over the card that just opened: that is not a tap on
          // it. Swallow the click the lift makes, until the next press
          const swallow = (ev: Event) => (ev.stopPropagation(), ev.preventDefault(), done());
          const done = () => {
            window.removeEventListener("click", swallow, true);
            window.removeEventListener("pointerdown", done, true);
          };
          window.addEventListener("click", swallow, true);
          window.addEventListener("pointerdown", done, true);
          this.onContext(this.hitAt(x, y), x, y);
        }, HOLD_MS),
      };
      this.onHold({ x, y });
    });
    el.addEventListener("pointermove", (e) => {
      if (hold && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 8) endHold();
    });
    el.addEventListener("pointercancel", endHold);
    el.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
    el.addEventListener("pointerup", (e) => {
      endHold();
      if (this.lightDrag) {
        this.lightDrag = null;
        this.controls.enabled = true;
        down = null;
        return;
      }
      const still = down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5;
      if (still && e.button === 0) this.onPick(this.pick(e), e.shiftKey || e.metaKey || e.ctrlKey);
      else if (still && e.button === 2) this.onContext(this.hitAt(e.clientX, e.clientY), e.clientX, e.clientY);
      down = null;
    });
    let pending: PointerEvent | null = null;
    el.addEventListener("pointermove", (e) => {
      if (this.lightDrag) {
        const deg = (((this.lightDrag.angle + (e.clientX - this.lightDrag.x) * 0.5) % 360) + 360) % 360;
        this.onLightAngle(Math.round(deg));
        return;
      }
      if (e.buttons) return;
      if (!pending)
        requestAnimationFrame(() => {
          if (pending) this.onHover(this.pick(pending));
          pending = null;
        });
      pending = e;
    });
    el.addEventListener("pointerleave", () => this.onHover(null));
    el.addEventListener("dblclick", (e) => this.onDoublePick(this.pick(e)));

    const loop = () => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    this.raf = requestAnimationFrame(loop);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.controls.dispose();
    for (const p of [...this.parts.values()]) this.disposePart(p);
    for (const g of [...this.ghosts]) this.disposeGhost(g);
    this.measure.clear();
    for (const g of this.geos.values()) {
      g.mesh.dispose();
      g.edges.dispose();
    }
    this.pipe.dispose();
    this.swatchPipe?.dispose();
    this.photo?.dispose();
    this.envs.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ---------- lighting and quality ----------

  setRenderSettings(s: RenderSettings) {
    const prev = this.render$;
    this.render$ = { ...s };
    if (prev.lighting !== s.lighting || prev.lightAngle !== s.lightAngle || prev.theme !== s.theme) this.applyLighting();
    if (prev.photoreal !== s.photoreal) {
      if (!s.photoreal) {
        // free the path tracer's buffers and scene copy; turning it back on rebuilds them
        this.dropPhoto();
        this.photoError = "";
      }
    }
    if (this.photo && prev.quality !== s.quality) {
      this.photo.quality = PHOTO_QUALITY[s.quality](this.renderer.getPixelRatio());
      this.photo.restart(performance.now());
    }
    if (prev.quality !== s.quality) {
      this.pipe.maxSamples = SAMPLES[s.quality];
      this.key.shadow.mapSize.setScalar(s.quality === "high" ? 4096 : 2048);
      this.key.shadow.map?.dispose();
      this.key.shadow.map = null;
    }
    this.changed = true;
  }

  private applyLighting() {
    const p = (this.preset = lightingPreset(this.render$.lighting, this.render$.theme));
    this.scene.environment = this.envs.get(p);
    this.scene.environmentIntensity = p.envIntensity;
    const rot = THREE.MathUtils.degToRad(this.render$.lightAngle);
    this.scene.environmentRotation.set(0, 0, rot);
    this.keyDir.copy(dirFrom(p.key.az + this.render$.lightAngle, p.key.el));
    this.key.color.set(p.key.color);
    this.key.intensity = p.key.i;
    this.overlayKey.position.copy(this.keyDir);
    this.groundMat.opacity = p.shadow;
    const look = this.pipe.look;
    look.exposure = p.exposure;
    look.bloom = p.bloom;
    look.vignette = p.vignette;
    look.bgTop.set(p.backdrop.top);
    look.bgBottom.set(p.backdrop.bottom);
    look.bgGlow.set(p.backdrop.glow);
    look.glowAmt = p.backdrop.glowAmt;
    this.gridMat.uniforms.uMinor.value.set(p.grid.minor);
    this.gridMat.uniforms.uMajor.value.set(p.grid.major);
    this.gridMat.uniforms.uAlpha.value = p.grid.alpha;
    for (const o of this.parts.values()) {
      o.edgeMat.color.set(p.edge.color);
      this.applyMaterial(o);
    }
    this.paintTriad(!!p.light);
    this.placeKey(0);
    this.swatchCache.clear();
    this.changed = true;
  }

  /** Position the key light for sample i: the centre for i = 0, then spread over the light's area. */
  private placeKey(i: number) {
    const size = Math.max(this.bounds.getSize(new THREE.Vector3()).length(), 20);
    const c = this.bounds.getCenter(new THREE.Vector3());
    const d = this.keyDir.clone();
    if (i > 0) {
      const [x, y] = concentricDisc(halton(i, 5), halton(i, 7));
      const t1 = new THREE.Vector3().crossVectors(d, new THREE.Vector3(0, 0, 1));
      if (t1.lengthSq() < 1e-6) t1.set(1, 0, 0);
      t1.normalize();
      const t2 = new THREE.Vector3().crossVectors(d, t1).normalize();
      const k = Math.tan(THREE.MathUtils.degToRad(this.preset.key.size));
      d.addScaledVector(t1, x * k).addScaledVector(t2, y * k).normalize();
    }
    this.key.position.copy(c).addScaledVector(d, size * 2);
    this.key.target.position.copy(c);
    this.key.updateMatrixWorld();
    this.key.target.updateMatrixWorld();
  }

  /** Accumulated samples so far and the target (for tests and diagnostics). */
  get progress() {
    return { samples: this.pipe.samples, max: this.pipe.maxSamples };
  }

  setTurntable(on: boolean) {
    this.turntable = on;
    this.controls.autoRotate = on;
    if (on) this.autoFit = false;
  }

  // ---------- hooks for 2D overlays (sketch editing) ----------

  /** Call fn after each frame drawn to the canvas, so 2D overlays can follow the camera. Returns the way to stop. */
  onRendered(fn: () => void): () => void {
    this.renderListeners.add(fn);
    // draw once more so a new overlay sees the camera as it is now, even if nothing moves again
    this.needComposite = true;
    return () => void this.renderListeners.delete(fn);
  }

  /** In sketch mode the left button belongs to the sketch tools: middle orbits, right pans. */
  setSketchMode(on: boolean) {
    this.sketching = on;
    this.controls.mouseButtons = on ? { LEFT: -1 as THREE.MOUSE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN } : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  }

  /** World point to pixels in the viewport; `front` is false behind the camera. */
  toScreen(p: [number, number, number]): { x: number; y: number; front: boolean } {
    const v = new THREE.Vector3(p[0], p[1], p[2]).project(this.camera);
    return { x: ((v.x + 1) / 2) * this.container.clientWidth, y: ((1 - v.y) / 2) * this.container.clientHeight, front: v.z < 1 };
  }

  /** The ray through a pixel of the viewport. */
  rayAt(x: number, y: number): { o: [number, number, number]; d: [number, number, number] } {
    const ndc = new THREE.Vector2((x / Math.max(1, this.container.clientWidth)) * 2 - 1, -(y / Math.max(1, this.container.clientHeight)) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const { origin: o, direction: d } = this.raycaster.ray;
    return { o: [o.x, o.y, o.z], d: [d.x, d.y, d.z] };
  }

  /** The part surface under a pixel: its point and outward normal, for sketching on a face. */
  surfaceAt(x: number, y: number): { partId: string; point: [number, number, number]; normal: [number, number, number] } | null {
    const ndc = new THREE.Vector2((x / Math.max(1, this.container.clientWidth)) * 2 - 1, -(y / Math.max(1, this.container.clientHeight)) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const meshes = [...this.parts.values()].filter((p) => p.group.visible && !p.removing).map((p) => p.mesh);
    for (const h of this.raycaster.intersectObjects(meshes, false)) {
      if (this.sectionAnim.on && this.sectionPlane.distanceToPoint(h.point) < 0) continue;
      if (!h.face) continue;
      const n = h.face.normal.clone().transformDirection(h.object.matrixWorld);
      return { partId: h.object.userData.partId as string, point: [h.point.x, h.point.y, h.point.z], normal: [n.x, n.y, n.z] };
    }
    return null;
  }

  /** Turn to look straight at a plane (normal n toward the viewer, v pointing up). */
  viewPlane(n: [number, number, number], v: [number, number, number], center: [number, number, number], radius: number) {
    const dir = new THREE.Vector3(...n).normalize().addScaledVector(new THREE.Vector3(...v), -1e-4).normalize();
    const fov = (this.camera.fov * Math.PI) / 180;
    const dist = Math.max(radius, 5) / Math.sin(Math.min(fov, fov * this.camera.aspect) / 2);
    const target = new THREE.Vector3(...center);
    this.autoFit = false;
    this.moveCamera(target.clone().addScaledVector(dir, dist * 1.1), target, 650);
  }

  /** Half the diagonal of the model's bounding box (for framing). */
  modelRadius() {
    return this.bounds.getSize(new THREE.Vector3()).length() / 2;
  }

  cameraState() {
    return { pos: this.camera.position.toArray() as [number, number, number], target: this.controls.target.toArray() as [number, number, number] };
  }

  restoreCamera(s: { pos: [number, number, number]; target: [number, number, number] }) {
    this.moveCamera(new THREE.Vector3(...s.pos), new THREE.Vector3(...s.target), 600);
  }

  /** Swing the camera to a position and target (at once with reduced motion). */
  private moveCamera(pos: THREE.Vector3, target: THREE.Vector3, dur: number) {
    if (this.display.reduceMotion) {
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.controls.update();
      this.camAnim = null;
    } else {
      const fromOff = this.camera.position.clone().sub(this.controls.target);
      const toOff = pos.clone().sub(target);
      this.camAnim = { t0: performance.now(), dur, fromDir: fromOff.clone().normalize(), toDir: toOff.clone().normalize(), fromDist: fromOff.length(), toDist: toOff.length(), fromTarget: this.controls.target.clone(), toTarget: target.clone() };
    }
    this.changed = true;
  }

  // ---------- parts ----------

  setParts(parts: EvalPart[], meshes: Map<string, MeshEntry>) {
    const want = new Set<string>();
    const now = performance.now();
    const motion = !this.display.reduceMotion;
    let fresh = 0;
    for (const part of parts) {
      const entry = meshes.get(part.hash);
      const data = entry?.final ?? entry?.preview;
      if (!data) continue;
      want.add(part.id);
      const quality = entry?.final ? "final" : "preview";
      const geoKey = `${part.hash}:${quality}`;
      let obj = this.parts.get(part.id);
      const prevHash = this.seenHashByPart.get(part.id);
      const isNewGeometry = prevHash !== part.hash;
      if (obj && obj.removing) {
        this.disposePart(obj);
        obj = undefined;
      }
      if (!obj) {
        obj = this.createPart(part, geoKey, data);
        this.parts.set(part.id, obj);
        obj.placement.fromArray(xformMatrix(part.xf));
        if (motion && isNewGeometry) {
          if (prevHash) this.startDissolveIn(obj, now);
          else this.startReveal(obj, now + Math.min(fresh++ * 45, 900));
        }
      } else if (obj.geoKey !== geoKey) {
        if (motion && isNewGeometry) this.spawnGhost(obj, now);
        this.swapGeometry(obj, geoKey, data);
        if (motion && isNewGeometry) this.startDissolveIn(obj, now);
      }
      obj.part = part;
      obj.hash = part.hash;
      obj.placement.fromArray(xformMatrix(part.xf));
      this.applyMaterial(obj);
      if (isNewGeometry) this.seenHashByPart.set(part.id, part.hash);
    }
    for (const [id, obj] of this.parts) {
      if (want.has(id) || obj.removing) continue;
      if (!motion) this.disposePart(obj);
      else {
        obj.removing = true;
        obj.reveal = null;
        obj.dissolve = { t0: now, dur: 420, out: true };
        obj.mesh.castShadow = false;
      }
    }
    this.computeBounds();
    if (!this.hasFitted && this.parts.size) {
      this.hasFitted = true;
      this.fit("iso", false);
      this.onFirstFrame();
    }
    this.changed = true;
  }

  private geometry(key: string, data: MeshData): GeoEntry {
    let g = this.geos.get(key);
    if (!g) {
      const mesh = new THREE.BufferGeometry();
      mesh.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
      mesh.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
      mesh.setIndex(new THREE.BufferAttribute(data.indices, 1));
      // imported bodies whose faces carry their own colours
      if (data.colors) mesh.setAttribute("color", new THREE.BufferAttribute(data.colors, 3, true));
      mesh.computeBoundingBox();
      mesh.computeBoundingSphere();
      const edges = new THREE.BufferGeometry();
      edges.setAttribute("position", new THREE.BufferAttribute(data.edges, 3));
      g = { mesh, edges, users: 0 };
      this.geos.set(key, g);
    }
    g.users++;
    return g;
  }

  private release(key: string) {
    const g = this.geos.get(key);
    if (!g) return;
    g.users--;
    if (g.users <= 0) {
      g.mesh.dispose();
      g.edges.dispose();
      this.geos.delete(key);
    }
  }

  private lookFor(part: EvalPart): Appearance {
    const o = this.overrides.get(part.id);
    return o ? appearanceFor(o.material, o.finish, o.color) : appearanceFor(part.material, part.finish, part.color);
  }

  private newPartMaterial(look: Appearance) {
    const mat = new THREE.MeshPhysicalMaterial({ polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    const u = partUniforms();
    patchPartMaterial(mat, u);
    applyAppearance(mat, u, look);
    return { mat, u };
  }

  private createPart(part: EvalPart, geoKey: string, data: MeshData): PartObj {
    const g = this.geometry(geoKey, data);
    const look = this.lookFor(part);
    const { mat, u } = this.newPartMaterial(look);
    const cap$ = capMaterial();
    const edgeMat = new THREE.LineBasicMaterial({ color: this.preset.edge.color, transparent: true, opacity: this.preset.edge.alpha, depthWrite: false });
    const mesh = new THREE.Mesh(g.mesh, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.partId = part.id;
    const cap = new THREE.Mesh(g.mesh, cap$.mat);
    cap.visible = false;
    const edges = new THREE.LineSegments(g.edges, edgeMat);
    edges.renderOrder = 1;
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.add(mesh, cap, edges);
    this.root.add(group);
    const center = new THREE.Vector3();
    g.mesh.boundingBox!.getCenter(center);
    u.uNoiseScale.value = 7 / Math.max(g.mesh.boundingSphere!.radius * 2, 1);
    return {
      id: part.id,
      part,
      group,
      mesh,
      cap,
      edges,
      mat,
      u,
      cap$,
      edgeMat,
      geoKey,
      hash: part.hash,
      look,
      placement: new THREE.Matrix4(),
      center,
      explode: { pos: new THREE.Vector3(), vel: new THREE.Vector3(), hold: 0 },
      reveal: null,
      dissolve: null,
      flash: null,
      removing: false,
      opacity: 1,
      opacityTarget: 1,
      sig: "",
    };
  }

  private swapGeometry(obj: PartObj, geoKey: string, data: MeshData) {
    const g = this.geometry(geoKey, data);
    this.release(obj.geoKey);
    obj.geoKey = geoKey;
    obj.mesh.geometry = g.mesh;
    obj.cap.geometry = g.mesh;
    obj.edges.geometry = g.edges;
    g.mesh.boundingBox!.getCenter(obj.center);
    obj.u.uNoiseScale.value = 7 / Math.max(g.mesh.boundingSphere!.radius * 2, 1);
  }

  private disposePart(obj: PartObj) {
    this.root.remove(obj.group);
    obj.mat.dispose();
    obj.cap$.mat.dispose();
    obj.edgeMat.dispose();
    this.release(obj.geoKey);
    this.parts.delete(obj.id);
  }

  /** Keep the old geometry of a rebuilt part on screen, dissolving away. */
  private spawnGhost(obj: PartObj, now: number) {
    const g = this.geos.get(obj.geoKey);
    if (!g) return;
    g.users++;
    const { mat, u } = this.newPartMaterial(obj.look);
    u.uNoiseScale.value = obj.u.uNoiseScale.value;
    u.uDetail.value.copy(obj.u.uDetail.value);
    mat.clippingPlanes = obj.mat.clippingPlanes;
    const mesh = new THREE.Mesh(g.mesh, mat);
    mesh.castShadow = true;
    const edgeMat = obj.edgeMat.clone();
    const edges = new THREE.LineSegments(g.edges, edgeMat);
    edges.renderOrder = 1;
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.matrix.copy(obj.group.matrix);
    group.add(mesh, edges);
    this.root.add(group);
    this.ghosts.push({ group, mat, u, edgeMat, geoKey: obj.geoKey, t0: now, dur: 520 });
  }

  private disposeGhost(g: Ghost) {
    this.root.remove(g.group);
    g.mat.dispose();
    g.edgeMat.dispose();
    this.release(g.geoKey);
    this.ghosts = this.ghosts.filter((x) => x !== g);
  }

  private startReveal(obj: PartObj, t0: number) {
    const box = new THREE.Box3().setFromBufferAttribute(obj.mesh.geometry.getAttribute("position") as THREE.BufferAttribute).applyMatrix4(obj.placement);
    const pad = Math.max(0.5, (box.max.z - box.min.z) * 0.02);
    obj.reveal = { t0, dur: 760, zMin: box.min.z - pad, zMax: box.max.z + pad, plane: new THREE.Plane(new THREE.Vector3(0, 0, -1), box.min.z - pad) };
    obj.u.uScan.value.set(1, box.min.z - pad, Math.max(0.6, (box.max.z - box.min.z) * 0.06));
    this.updateClipping(obj);
  }

  private startDissolveIn(obj: PartObj, now: number) {
    obj.reveal = null;
    obj.dissolve = { t0: now + 90, dur: 620, out: false };
    obj.u.uDissolve.value = 1;
    obj.flash = { t0: now + 300, dur: 1100 };
  }

  /** While the material picker is open the selection keeps its outline but drops its tint. */
  setMaterialMode(on: boolean) {
    this.materialMode = on;
    this.needComposite = true;
  }

  /** Show a material on parts without changing the design (material picker hover). */
  setOverride(ids: string[], o: AppearanceOverride | null) {
    this.overrides.clear();
    if (o) for (const id of ids) this.overrides.set(id, o);
    // applyMaterial flags a redraw only for parts whose look actually changed
    for (const obj of this.parts.values()) this.applyMaterial(obj);
  }

  private applyMaterial(obj: PartObj) {
    const d = this.display;
    const p = obj.part;
    const look = this.lookFor(p);
    // imported bodies whose faces carry their own colours keep them, except while a material is previewed
    const faceColors = !!p.imported?.faceColors && !!obj.mesh.geometry.getAttribute("color") && !this.overrides.has(p.id);
    if (look !== obj.look || obj.mat.vertexColors !== faceColors) {
      const recompile = (look.transmission > 0) !== (obj.look.transmission > 0) || obj.mat.vertexColors !== faceColors;
      obj.look = look;
      applyAppearance(obj.mat, obj.u, look);
      obj.mat.vertexColors = faceColors;
      if (faceColors) obj.mat.color.set(0xffffff);
      if (recompile) obj.mat.needsUpdate = true;
      this.changed = true;
    }
    const selected = d.selected.has(obj.id);
    const hovered = d.hovered === obj.id;
    const focusSet = d.focus.size ? d.focus : d.isolate && d.selected.size ? d.selected : null;
    const ghost = (focusSet && !focusSet.has(obj.id)) || (d.xray && !selected);
    obj.opacityTarget = ghost ? (d.xray ? 0.2 : 0.08) : 1;
    if (d.reduceMotion) obj.opacity = obj.opacityTarget;
    const visible = !d.hidden.has(obj.id) && !p.hidden && !this.replaced.has(obj.id);
    obj.group.visible = visible;
    obj.edges.visible = (d.edges && !this.photoLookOn) || selected || hovered;
    obj.mesh.layers.set(0);
    if (visible && obj.opacityTarget >= 1 && !obj.removing) {
      obj.mesh.layers.enable(L_OPAQUE);
      if (selected) obj.mesh.layers.enable(L_SEL);
      if (hovered && !selected) obj.mesh.layers.enable(L_HOVER);
    }
    this.applyOpacity(obj);
    this.updateClipping(obj);
    const sig = `${visible}|${obj.opacityTarget}|${obj.edges.visible}`;
    if (sig !== obj.sig) {
      obj.sig = sig;
      this.changed = true;
    }
  }

  private applyOpacity(obj: PartObj) {
    const o = obj.opacity;
    const transparent = o < 0.999;
    if (obj.mat.transparent !== transparent) {
      obj.mat.transparent = transparent;
      obj.mat.needsUpdate = true;
    }
    obj.mat.opacity = o;
    obj.mat.depthWrite = !transparent;
    obj.mesh.castShadow = !transparent && !obj.removing;
    obj.edgeMat.opacity = this.preset.edge.alpha * (transparent ? Math.min(1, o * 1.4) : 1);
  }

  private updateClipping(obj: PartObj) {
    const planes: THREE.Plane[] = [];
    if (this.sectionAnim.on) planes.push(this.sectionPlane);
    if (obj.reveal) planes.push(obj.reveal.plane);
    const changed = (obj.mat.clippingPlanes?.length ?? 0) !== planes.length;
    obj.mat.clippingPlanes = planes.length ? planes : null;
    obj.edgeMat.clippingPlanes = planes.length ? planes : null;
    obj.cap$.mat.clippingPlanes = planes.length ? planes : null;
    obj.cap.visible = (this.sectionAnim.on || !!obj.reveal) && obj.opacity >= 0.999;
    obj.cap$.uGlowAmt.value = obj.reveal ? 1 : 0;
    obj.cap$.mat.color.set(obj.part.color).multiplyScalar(0.85);
    if (changed) {
      obj.mat.needsUpdate = true;
      obj.edgeMat.needsUpdate = true;
      obj.cap$.mat.needsUpdate = true;
    }
  }

  setDisplay(d: DisplayState) {
    this.display = d;
    for (const obj of this.parts.values()) this.applyMaterial(obj);
    const grid = d.grid && !this.photoLookOn;
    if (this.grid.visible !== grid) this.changed = true;
    this.grid.visible = grid;
    this.updateInterferenceLook();
    const sk = [...d.selected].sort().join(",");
    if (sk !== this.selKey) {
      // a new selection pops in
      this.selAmt = sk ? Math.min(this.selAmt, 0.25) : this.selAmt;
      this.selKey = sk;
      this.maskDirty = true;
    }
    const hk = d.hovered ?? "";
    if (hk !== this.hoverKey) {
      this.hoverAmt = 0;
      this.hoverKey = hk;
      this.maskDirty = true;
    }
    this.needComposite = true;
  }

  setSection(s: { on: boolean; axis: "x" | "y" | "z"; t: number; flip: boolean }) {
    const wasOn = this.section.on;
    const axisChanged = s.axis !== this.section.axis || s.flip !== this.section.flip;
    this.section = { ...s };
    if (s.on && (!wasOn || axisChanged)) {
      // slide in from the uncut side
      this.sectionAnim.t = s.flip ? 0 : 1;
      if (this.display.reduceMotion) this.sectionAnim.t = s.t;
    }
    if (s.on) this.sectionAnim.on = true;
    if (!s.on && this.display.reduceMotion) this.sectionAnim.on = false;
    this.placeSection();
    for (const obj of this.parts.values()) this.updateClipping(obj);
    this.clipOverlays();
    this.changed = true;
  }

  // ---------- overlays ----------

  addOverlay(o: SceneOverlay) {
    this.overlays.add(o);
    this.overlay.add(o.object);
    this.syncOverlays();
  }

  removeOverlay(o: SceneOverlay) {
    if (!this.overlays.delete(o)) return;
    this.overlay.remove(o.object);
    this.syncOverlays();
  }

  private syncOverlays() {
    this.replaced = new Set([...this.overlays].flatMap((o) => [...o.replaces]));
    // applyMaterial restarts the accumulation for parts that appear or disappear
    for (const obj of this.parts.values()) this.applyMaterial(obj);
    this.clipOverlays();
    this.needComposite = true;
  }

  private clipOverlays() {
    for (const o of this.overlays) o.setClipping?.(this.sectionAnim.on ? [this.sectionPlane] : null);
  }

  /** Redraw the overlays (the accumulated image of the model stays as it is). */
  invalidate() {
    this.needComposite = true;
  }

  /** A raycaster from the camera through a point on screen, in client coordinates. */
  raycasterAt(clientX: number, clientY: number): THREE.Raycaster {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const r = new THREE.Raycaster();
    r.setFromCamera(ndc, this.camera);
    return r;
  }

  /** The section plane while a section is on, so overlays can skip what it cuts away. */
  activeSection(): THREE.Plane | null {
    return this.sectionAnim.on ? this.sectionPlane : null;
  }

  /** Fill the depth buffer of the current target with the visible opaque parts, so overlays hide behind them. */
  private overlayDepth() {
    const r = this.renderer;
    const cam = this.camera;
    const prevMask = cam.layers.mask;
    const prevClip = r.clippingPlanes;
    const saveShadow = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false;
    r.clearDepth();
    r.clippingPlanes = this.sectionAnim.on ? [this.sectionPlane] : [];
    this.scene.overrideMaterial = this.depthOnly;
    cam.layers.set(L_OPAQUE);
    r.render(this.scene, cam);
    this.scene.overrideMaterial = null;
    cam.layers.mask = prevMask;
    r.clippingPlanes = prevClip;
    r.shadowMap.autoUpdate = saveShadow;
  }

  private placeSection() {
    const ax = this.section.axis === "x" ? 0 : this.section.axis === "y" ? 1 : 2;
    const lo = this.bounds.min.getComponent(ax);
    const hi = this.bounds.max.getComponent(ax);
    const pad = (hi - lo) * 0.002 + 0.01;
    const c = lo - pad + (hi - lo + 2 * pad) * this.sectionAnim.t;
    const n = new THREE.Vector3();
    n.setComponent(ax, this.section.flip ? 1 : -1);
    this.sectionPlane.set(n, this.section.flip ? -c : c);
    // the outline drawn where the plane cuts the model's bounds
    const size = this.bounds.getSize(new THREE.Vector3()).multiplyScalar(1.12);
    const center = this.bounds.getCenter(new THREE.Vector3());
    center.setComponent(ax, c);
    const m = new THREE.Matrix4();
    if (ax === 0) m.makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)).scale(new THREE.Vector3(size.y, size.z, 1));
    else if (ax === 1) m.makeBasis(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)).scale(new THREE.Vector3(size.x, size.z, 1));
    else m.scale(new THREE.Vector3(size.x, size.y, 1));
    m.setPosition(center);
    this.sectionFrame.matrix.copy(m);
    this.sectionFill.matrix.copy(m);
    this.sectionFrame.matrixWorldNeedsUpdate = true;
    this.sectionFill.matrixWorldNeedsUpdate = true;
  }

  setExplode(f: number) {
    const big = Math.abs(f - this.explodeAmt) > 0.15;
    this.explodeAmt = f;
    this.assembly = null;
    if (big && !this.display.reduceMotion) this.staggerExplode(f > 0);
    this.changed = true;
  }

  /** Parts start moving one after another: outermost first when opening, innermost first when closing. */
  private staggerExplode(opening: boolean) {
    const c = this.bounds.getCenter(new THREE.Vector3());
    const list = [...this.parts.values()].map((o) => ({ o, d: o.center.clone().applyMatrix4(o.placement).distanceTo(c) }));
    list.sort((a, b) => (opening ? b.d - a.d : a.d - b.d));
    const now = performance.now();
    const step = Math.min(28, 420 / Math.max(1, list.length));
    list.forEach((x, i) => (x.o.explode.hold = now + i * step));
  }

  /** Animate the assembly: start exploded, then bring the parts home one by one in design order. */
  playAssembly() {
    const order = [...this.parts.values()].filter((o) => !o.removing).map((o) => o.id);
    if (!order.length) return;
    const now = performance.now();
    for (const o of this.parts.values()) o.explode.hold = 0;
    this.assembly = { t0: now + 450, order };
    this.changed = true;
  }

  setMotion(playing: boolean, speed: number) {
    this.playing = playing;
    this.speed = speed;
    this.changed = true;
  }

  /** The group carrying a part's placement, explode offset and motion, for overlays that should move with it. */
  partGroup(id: string): THREE.Group | undefined {
    const obj = this.parts.get(id);
    return obj && !obj.removing ? obj.group : undefined;
  }

  /** A part's clipping planes and opacity, so overlays cut and ghost with it. */
  partLook(id: string): { planes: THREE.Plane[] | null; opacity: number } | undefined {
    const obj = this.parts.get(id);
    return obj ? { planes: obj.mat.clippingPlanes, opacity: obj.mat.opacity } : undefined;
  }

  /** Redraw on the next frame (after an overlay changes). */
  requestRender() {
    this.changed = true;
  }

  setInterferences(list: Interference[], focus: string | null) {
    for (const i of this.interferences) {
      this.interGroup.remove(i.obj);
      i.obj.geometry.dispose();
      (i.obj.material as THREE.Material).dispose();
    }
    this.interferences = [];
    this.focusCheck = focus;
    for (const it of list) {
      if (!it.mesh) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(it.mesh.positions, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(it.mesh.normals, 3));
      g.setIndex(new THREE.BufferAttribute(it.mesh.indices, 1));
      const m = new THREE.MeshBasicMaterial({ color: 0xff3b5c, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false });
      const obj = new THREE.Mesh(g, m);
      obj.renderOrder = 10;
      this.interGroup.add(obj);
      this.interferences.push({ obj, id: `int:${it.a}|${it.b}` });
    }
    this.updateInterferenceLook();
    this.needComposite = true;
  }

  /** Show the closest points between two parts (null hides the line). */
  setMeasure(m: { a: [number, number, number]; b: [number, number, number] } | null) {
    const size = new THREE.Vector3();
    this.bounds.getSize(size);
    this.measure.set(m, Math.max(size.x, size.y, size.z, 20));
    this.needComposite = true;
  }

  private updateInterferenceLook() {
    for (const i of this.interferences) {
      const m = i.obj.material as THREE.MeshBasicMaterial;
      m.opacity = !this.focusCheck || this.focusCheck === i.id ? 0.85 : 0.25;
    }
  }

  // ---------- camera ----------

  private computeBounds() {
    const box = new THREE.Box3();
    for (const obj of this.parts.values()) {
      if (obj.removing || (!obj.group.visible && !this.replaced.has(obj.id))) continue;
      const g = obj.mesh.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      box.union(g.boundingBox!.clone().applyMatrix4(obj.placement));
    }
    if (!box.isEmpty()) this.bounds.copy(box);
    this.layoutStage();
    this.placeSection();
  }

  private layoutStage() {
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    this.bounds.getSize(size);
    this.bounds.getCenter(center);
    const r = Math.max(size.x, size.y, size.z, 20);
    const zFloor = this.bounds.min.z - Math.max(0.5, r * 0.004);
    const span = r * 14;
    this.grid.scale.set(span, span, 1);
    this.grid.position.set(center.x, center.y, zFloor);
    this.ground.scale.set(r * 8, r * 8, 1);
    this.ground.position.set(center.x, center.y, zFloor + 0.01);
    const cell = Math.pow(10, Math.floor(Math.log10(r / 4)));
    this.gridMat.uniforms.uCell.value = Math.max(cell, 1);
    this.gridMat.uniforms.uFade.value = r * 3.5;
    this.gridMat.uniforms.uCenter.value.set(center.x, center.y, zFloor);
    const diag = size.length();
    const sc = this.key.shadow.camera as THREE.OrthographicCamera;
    const ext = Math.max(diag, 20) * 0.85;
    sc.left = -ext;
    sc.right = ext;
    sc.top = ext;
    sc.bottom = -ext;
    sc.near = Math.max(diag, 20) * 0.2;
    sc.far = Math.max(diag, 20) * 4;
    sc.updateProjectionMatrix();
    this.key.shadow.normalBias = Math.max(0.02, r * 0.0025);
    this.placeKey(0);
    this.pipe.look.aoRadius = THREE.MathUtils.clamp(r * 0.06, 0.8, 60);
    this.camera.near = Math.max(0.1, r / 400);
    this.camera.far = r * 60;
    this.camera.updateProjectionMatrix();
  }

  private presetDir(p: ViewPreset): THREE.Vector3 {
    switch (p) {
      case "front":
        return new THREE.Vector3(0, -1, 0.0001);
      case "back":
        return new THREE.Vector3(0, 1, 0.0001);
      case "left":
        return new THREE.Vector3(-1, 0, 0.0001);
      case "right":
        return new THREE.Vector3(1, 0, 0.0001);
      case "top":
        return new THREE.Vector3(0, -0.0001, 1);
      case "bottom":
        return new THREE.Vector3(0, -0.0001, -1);
      default:
        return new THREE.Vector3(0.9, -1.25, 0.85).normalize();
    }
  }

  /** Called when a build completes: frames the whole model once, unless the user already moved the camera. */
  settle() {
    if (!this.autoFit || !this.parts.size) return;
    this.autoFit = false;
    this.fit("iso", true);
  }

  /** Frame the given parts from the current viewing direction. */
  focusOn(ids: string[]) {
    const box = new THREE.Box3();
    for (const id of ids) {
      const p = this.parts.get(id);
      if (p && !p.removing) box.expandByObject(p.group);
    }
    if (box.isEmpty()) return;
    this.fit("current", true, box);
  }

  private framing(p: ViewPreset | "current", aspect: number, box: THREE.Box3 = this.bounds, viewDir?: THREE.Vector3) {
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius, box === this.bounds ? 5 : 2);
    const dir = viewDir ? viewDir.clone().normalize() : p === "current" ? this.camera.position.clone().sub(this.controls.target).normalize() : this.presetDir(p);
    const fov = (this.camera.fov * Math.PI) / 180;
    const fit = r / Math.sin(Math.min(fov, fov * aspect) / 2);
    return { pos: sphere.center.clone().add(dir.multiplyScalar(fit * 1.08)), target: sphere.center.clone() };
  }

  fit(p: ViewPreset | "current" = "current", animate = true, box?: THREE.Box3) {
    const { pos, target } = this.framing(p, this.camera.aspect, box);
    if (!animate || this.display.reduceMotion) {
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.controls.update();
      this.camAnim = null;
    } else {
      // swing around the target along an arc rather than cutting through the model
      const fromOff = this.camera.position.clone().sub(this.controls.target);
      const toOff = pos.clone().sub(target);
      const angle = fromOff.angleTo(toOff);
      this.camAnim = {
        t0: performance.now(),
        dur: 520 + Math.min(1, angle / Math.PI) * 420,
        fromDir: fromOff.clone().normalize(),
        toDir: toOff.clone().normalize(),
        fromDist: fromOff.length(),
        toDist: toOff.length(),
        fromTarget: this.controls.target.clone(),
        toTarget: target,
      };
    }
    this.changed = true;
  }

  // ---------- picking ----------

  private pick(e: MouseEvent): string | null {
    return this.rayHit(e.clientX, e.clientY)?.object.userData.partId ?? null;
  }

  private rayHit(clientX: number, clientY: number): THREE.Intersection | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    // parts drawn by an overlay (analysis results) are hidden but still pickable
    const pickable = (p: PartObj) => p.group.visible || (this.replaced.has(p.id) && !this.display.hidden.has(p.id) && !p.part.hidden);
    const meshes = [...this.parts.values()].filter((p) => pickable(p) && !p.removing && p.opacityTarget > 0.5).map((p) => p.mesh);
    const hits = this.raycaster.intersectObjects(meshes, false);
    for (const h of hits) {
      if (this.sectionAnim.on && this.sectionPlane.distanceToPoint(h.point) < 0) continue;
      if (h.object.userData.partId) return h;
    }
    return null;
  }

  /** The part and spot under a screen position. */
  hitAt(clientX: number, clientY: number): Hit | null {
    const h = this.rayHit(clientX, clientY);
    const obj = h && this.parts.get(h.object.userData.partId as string);
    if (!h || !obj) return null;
    const local = h.point.clone().applyMatrix4(h.object.matrixWorld.clone().invert());
    const n = (h.face?.normal ?? new THREE.Vector3(0, 0, 1)).clone();
    return { id: obj.id, local: tuple(local), point: tuple(local.clone().applyMatrix4(obj.placement)), normal: tuple(n.transformDirection(obj.placement)) };
  }

  /**
   * Where a spot on a part shows in the viewport, in CSS pixels from its top
   * left, following the camera, explode and motion. Without a spot, the part's
   * centre. Null when the part is not on screen.
   */
  anchor(id: string, local?: [number, number, number]): { x: number; y: number; front: boolean } | null {
    const obj = this.parts.get(id);
    if (!obj || obj.removing) return null;
    const v = (local ? new THREE.Vector3(...local) : obj.center.clone()).applyMatrix4(obj.mesh.matrixWorld);
    const front = v.clone().sub(this.camera.position).dot(this.camera.getWorldDirection(new THREE.Vector3())) > 0;
    v.project(this.camera);
    return { x: ((v.x + 1) / 2) * this.container.clientWidth, y: ((1 - v.y) / 2) * this.container.clientHeight, front };
  }

  /** The view exactly as it is on screen, as a PNG data URL. */
  snapshot(): string {
    // draw the current accumulated image and read it back in the same task, before the browser clears the canvas
    this.present(performance.now());
    return this.renderer.domElement.toDataURL("image/png");
  }

  /** The model's bounds in assembly coordinates. */
  modelBounds(): [[number, number, number], [number, number, number]] {
    return [tuple(this.bounds.min), tuple(this.bounds.max)];
  }

  /** The direction from the view's target toward the camera. */
  viewDir(): [number, number, number] {
    return tuple(this.camera.position.clone().sub(this.controls.target).normalize());
  }

  // ---------- frame ----------

  private resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + "px";
    this.renderer.domElement.style.height = h + "px";
    this.pipe.setSize(w, h, this.renderer.getPixelRatio());
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.changed = true;
  }

  /** Advance every animation by one frame. Returns true while anything is still moving. */
  private animate(now: number, dt: number): boolean {
    let moving = false;
    const rm = this.display.reduceMotion;

    if (this.camAnim) {
      const a = this.camAnim;
      const k = Math.min(1, (now - a.t0) / a.dur);
      const e = easeInOut(k);
      const dir = slerpDir(a.fromDir, a.toDir, e);
      const dist = Math.exp(THREE.MathUtils.lerp(Math.log(a.fromDist), Math.log(a.toDist), e));
      this.controls.target.lerpVectors(a.fromTarget, a.toTarget, e);
      this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
      this.controls.update();
      if (k >= 1) this.camAnim = null;
      moving = true;
    }

    if (this.playing) {
      this.angle += dt * 90 * this.speed;
      moving = true;
    }

    // section plane slides in and out
    const sa = this.sectionAnim;
    const tTarget = this.section.on ? this.section.t : this.section.flip ? 0 : 1;
    if (Math.abs(sa.t - tTarget) > 1e-4) {
      sa.t = rm ? tTarget : sa.t + (tTarget - sa.t) * Math.min(1, dt * 9);
      if (Math.abs(sa.t - tTarget) < 1e-3) sa.t = tTarget;
      this.placeSection();
      moving = true;
    } else if (!this.section.on && sa.on) {
      sa.on = false;
      for (const obj of this.parts.values()) this.updateClipping(obj);
      this.clipOverlays();
      moving = true;
    }
    const fadeTarget = this.section.on ? 1 : 0;
    if (Math.abs(sa.fade - fadeTarget) > 1e-3) {
      sa.fade += (fadeTarget - sa.fade) * Math.min(1, dt * 8);
      this.needComposite = true;
    }
    (this.sectionFrame.material as THREE.LineBasicMaterial).opacity = sa.fade * 0.85;
    (this.sectionFill.material as THREE.MeshBasicMaterial).opacity = sa.fade * 0.05;

    // assembly playback: each part springs home in turn
    let assemblyDone = true;
    const asm = this.assembly;

    const bc = this.bounds.getCenter(new THREE.Vector3());
    const size = this.bounds.getSize(new THREE.Vector3()).length();
    for (const obj of [...this.parts.values()]) {
      // reveal sweep
      if (obj.reveal) {
        const k = (now - obj.reveal.t0) / obj.reveal.dur;
        if (k >= 1) {
          obj.reveal = null;
          obj.u.uScan.value.x = 0;
          this.updateClipping(obj);
        } else {
          const e = ease(Math.max(0, k));
          const z = obj.reveal.zMin + (obj.reveal.zMax - obj.reveal.zMin) * e;
          obj.reveal.plane.constant = z;
          obj.u.uScan.value.y = z;
        }
        moving = true;
      }
      // dissolve in or out
      if (obj.dissolve) {
        const k = (now - obj.dissolve.t0) / obj.dissolve.dur;
        if (k >= 1) {
          obj.dissolve = null;
          obj.u.uDissolve.value = 0;
          if (obj.removing) {
            this.disposePart(obj);
            moving = true;
            continue;
          }
        } else {
          const e = easeInOut(Math.max(0, k));
          obj.u.uDissolve.value = obj.dissolve.out ? e : 1 - e;
        }
        moving = true;
      }
      if (obj.flash) {
        const k = (now - obj.flash.t0) / obj.flash.dur;
        obj.u.uFlash.value = k < 0 ? 0 : k >= 1 ? 0 : Math.sin(Math.PI * Math.min(1, k * 1.6)) * (1 - k);
        if (k >= 1) obj.flash = null;
        moving = true;
      }
      // ghosting fades
      if (Math.abs(obj.opacity - obj.opacityTarget) > 1e-3) {
        obj.opacity = rm ? obj.opacityTarget : obj.opacity + (obj.opacityTarget - obj.opacity) * Math.min(1, dt * 12);
        if (Math.abs(obj.opacity - obj.opacityTarget) < 0.01) obj.opacity = obj.opacityTarget;
        this.applyOpacity(obj);
        this.updateClipping(obj);
        moving = true;
      }

      // explode target
      let amount = this.explodeAmt;
      if (asm) {
        const idx = asm.order.indexOf(obj.id);
        const step = Math.min(160, 2600 / Math.max(1, asm.order.length));
        const home = asm.t0 + Math.max(0, idx) * step;
        amount = now < home ? Math.max(this.explodeAmt, 0.6) : this.explodeAmt;
        if (now < home) assemblyDone = false;
      }
      const target = new THREE.Vector3();
      if (amount > 0) {
        const worldC = obj.center.clone().applyMatrix4(obj.placement);
        target.copy(worldC).sub(bc);
        if (target.lengthSq() < 1e-6) target.set(0, 0, 1);
        target.normalize().multiplyScalar(amount * size * 0.45 * (0.4 + worldC.distanceTo(bc) / (size || 1)));
      }
      const sp = obj.explode;
      if (rm) {
        sp.pos.copy(target);
        sp.vel.set(0, 0, 0);
      } else if (now >= sp.hold && (sp.pos.distanceToSquared(target) > 1e-6 || sp.vel.lengthSq() > 1e-6)) {
        // slightly underdamped spring: parts settle with a hint of overshoot
        const kStiff = 170;
        const damp = 2 * Math.sqrt(kStiff) * 0.78;
        const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
        const h = dt / steps;
        for (let s = 0; s < steps; s++) {
          const acc = target.clone().sub(sp.pos).multiplyScalar(kStiff).addScaledVector(sp.vel, -damp);
          sp.vel.addScaledVector(acc, h);
          sp.pos.addScaledVector(sp.vel, h);
        }
        if (sp.pos.distanceToSquared(target) < 1e-4 * Math.max(1, size) && sp.vel.lengthSq() < 1e-3) {
          sp.pos.copy(target);
          sp.vel.set(0, 0, 0);
        }
        moving = true;
      } else if (now < sp.hold) moving = true;

      // motion about the part's axis
      const m = new THREE.Matrix4().makeTranslation(sp.pos.x, sp.pos.y, sp.pos.z);
      const mo = obj.part.motion;
      if (mo && Math.abs(this.angle) > 1e-9 && mo.ratio) {
        const o = new THREE.Vector3(...mo.origin);
        const rot = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(...mo.axis).normalize(), THREE.MathUtils.degToRad(this.angle * mo.ratio));
        m.multiply(new THREE.Matrix4().makeTranslation(o.x, o.y, o.z)).multiply(rot).multiply(new THREE.Matrix4().makeTranslation(-o.x, -o.y, -o.z));
      }
      m.multiply(obj.placement);
      if (!m.equals(obj.group.matrix)) {
        obj.group.matrix.copy(m);
        obj.group.matrixWorldNeedsUpdate = true;
        moving = true;
      }
    }
    if (asm && assemblyDone) this.assembly = null;

    for (const g of [...this.ghosts]) {
      const k = (now - g.t0) / g.dur;
      if (k >= 1) this.disposeGhost(g);
      else g.u.uDissolve.value = easeInOut(k);
      moving = true;
    }
    return moving;
  }

  private frame() {
    const now = performance.now();
    const frameMs = now - this.last;
    const dt = Math.min(0.05, frameMs / 1000);
    this.last = now;
    const controlsMoved = this.controls.update();
    const moving = this.animate(now, dt) || controlsMoved;
    if (import.meta.env.DEV && (moving || this.changed)) this.debugReason = `${moving ? "moving " : ""}${controlsMoved ? "controls " : ""}${this.changed ? "changed" : ""}`;
    if (moving) this.changed = true;
    this.camera.updateMatrixWorld();
    // the photoreal look hides CAD edges and the grid, but only while it can run
    const look = this.render$.photoreal && !this.photoBlocked();
    if (look !== this.photoLookOn) {
      this.photoLookOn = look;
      for (const o of this.parts.values()) this.applyMaterial(o);
      this.grid.visible = this.display.grid && !look;
      this.changed = true;
    }
    if (this.pipe.cameraMoved(this.camera)) {
      if (import.meta.env.DEV) this.debugReason += " camera";
      this.changed = true;
    }
    let restarted = false;
    if (this.changed) {
      this.changed = false;
      this.pipe.reset();
      this.maskDirty = true;
      restarted = true;
    }
    let photo = this.photoActive();
    // while the model builds, the trace waits for its final meshes instead of restarting on each
    const held = !!photo && this.settlingSince !== null && now - this.settlingSince < PHOTO_SETTLE_MAX;
    if (photo && !held && (restarted || !photo.samples || this.photoHeld)) {
      const parts = this.photoParts();
      photo.sync(parts, this.photoStage(parts), now);
    }
    this.photoHeld = held;
    if (this.maskDirty) {
      this.renderMask();
      this.maskDirty = false;
      this.needComposite = true;
    }
    // selection outline and hover fade in
    const selTarget = this.display.selected.size ? 1 : 0;
    const hovTarget = this.display.hovered && !this.display.selected.has(this.display.hovered) ? 1 : 0;
    const fillTarget = this.materialMode ? 0 : 1;
    if (Math.abs(this.selAmt - selTarget) > 0.004 || Math.abs(this.hoverAmt - hovTarget) > 0.004 || Math.abs(this.selFill - fillTarget) > 0.004) {
      const k = this.display.reduceMotion ? 1 : Math.min(1, dt * 14);
      this.selAmt += (selTarget - this.selAmt) * k;
      this.hoverAmt += (hovTarget - this.hoverAmt) * k;
      this.selFill += (fillTarget - this.selFill) * k;
      this.needComposite = true;
    }
    if (this.interferences.length) this.needComposite = true;
    // overlays animate on top of the accumulated image without restarting it
    for (const o of this.overlays) if (o.tick?.(now, dt)) this.needComposite = true;

    // under the photoreal view the interactive image is only a preview
    const rasterMax = photo ? Math.min(this.pipe.maxSamples, PHOTO_PREVIEW) : this.pipe.maxSamples;
    let rastered = false;
    if (this.pipe.samples < rasterMax) {
      this.pipe.renderSample(this.scene, this.camera, (i) => this.placeKey(i));
      this.needComposite = true;
      rastered = true;
    }
    // anything that moves restarts the photo image, so waiting on the restart covers motion too
    let traced = false;
    if (photo && !held && now - photo.changedAt > PHOTO_DELAY && this.pipe.samples >= 1) {
      // the last frame's length sizes the tracer's tiles, when tracing was all that frame did
      if (photo.render(this.traceOnly ? frameMs : undefined)) this.needComposite = true;
      traced = true;
      if (photo.failed) {
        console.warn("Photoreal: the path tracing shader did not compile on this GPU");
        this.photoError = "The photoreal view doesn't run on this graphics card";
        this.dropPhoto();
        photo = null;
        this.needComposite = true;
      }
    }
    // the path traced image takes over as its noise clears, and leaves at once when anything moves
    const mixTarget = photo && !held && photo.samples >= 2 ? Math.min(1, (photo.samples - 1) / PHOTO_TAKEOVER) : 0;
    if (!mixTarget) {
      if (this.photoMix) this.needComposite = true;
      this.photoMix = 0;
    } else if (this.photoMix < mixTarget - 1e-3) {
      this.photoMix = this.display.reduceMotion ? mixTarget : Math.min(mixTarget, this.photoMix + dt * 4);
      this.needComposite = true;
    }
    this.reportPhoto(photo, held, now);
    this.traceOnly = traced && !rastered && !this.needComposite;
    if (!this.needComposite) return;
    this.needComposite = false;
    if (photo && this.photoMix > 0) this.pipe.photo(photo.texture, { mix: this.photoMix, samples: photo.samples, near: this.camera.near, far: this.camera.far });
    else this.pipe.photo(null);
    this.present(now);
    for (const fn of this.renderListeners) fn();
  }

  // ---------- photoreal ----------

  /** the layer ProcessOverlay puts its marks on as well */
  readonly markLayer = L_MARKS;

  /** Process issues are marked on the model: they are drawn over the photoreal image too. */
  setProcessMarks(on: boolean) {
    if (on !== this.processMarks) this.needComposite = true;
    this.processMarks = on;
  }

  /** The model is being built, checked or refined. Photoreal waits for the final meshes rather than restarting on each. */
  setModelSettling(on: boolean) {
    if (on === (this.settlingSince !== null)) return;
    this.settlingSince = on ? performance.now() : null;
    if (!on) this.changed = true;
  }

  /** Why the photoreal view can't run right now, as a line for the status pill. */
  private photoBlocked(): string | null {
    const d = this.display;
    if (this.photoError) return this.photoError;
    if (this.softwareGL) return "Photoreal needs hardware graphics, and this browser draws in software";
    if (this.sketching) return "Photoreal pauses while you sketch";
    if (this.section.on) return "Photoreal pauses in section view";
    if (d.xray) return "Photoreal pauses in x-ray";
    if (d.focus.size || (d.isolate && d.selected.size)) return "Photoreal pauses while parts are isolated";
    if (!this.parts.size) return "Nothing to render yet";
    return null;
  }

  /** Free the path tracer and its buffers. */
  private dropPhoto() {
    this.photoMix = 0;
    try {
      this.photo?.dispose();
    } catch (e) {
      console.warn("Photoreal: freeing the path tracer failed", e);
    }
    this.photo = null;
    this.pipe.releasePhoto();
    this.envs.releaseCubes();
  }

  private photoActive(): PhotoRenderer | null {
    if (!this.render$.photoreal || this.photoBlocked()) return null;
    if (!this.photo && !this.photoLoading) {
      this.photoLoading = true;
      import("./render/photoreal")
        .then((m) => {
          if (this.disposed || !this.render$.photoreal || this.photo || this.photoError) return;
          this.photo = new m.PhotoRenderer(this.renderer, this.camera);
          this.photo.quality = PHOTO_QUALITY[this.render$.quality](this.renderer.getPixelRatio());
          this.changed = true;
        })
        .catch((e) => {
          console.warn("Photoreal view unavailable", e);
          this.photoError = "This device can't run the photoreal view";
        })
        .finally(() => {
          this.photoLoading = false;
        });
    }
    return this.photo;
  }

  private photoParts(): PhotoPart[] {
    this.root.updateMatrixWorld(true);
    const out: PhotoPart[] = [];
    for (const o of this.parts.values()) {
      if (o.removing || !o.group.visible || o.opacityTarget < 1) continue;
      out.push({ id: o.id, geoKey: o.geoKey, geometry: o.mesh.geometry, matrix: o.mesh.matrixWorld, look: o.look });
    }
    return out;
  }

  private photoStage(parts: PhotoPart[]): PhotoStage {
    const p = this.preset;
    const size = this.bounds.getSize(new THREE.Vector3());
    // the floor is solid in the photo: drop it under parts exploded below the grid
    let floorZ = this.grid.position.z;
    const box = new THREE.Box3();
    for (const q of parts) {
      if (!q.geometry.boundingBox) q.geometry.computeBoundingBox();
      box.copy(q.geometry.boundingBox!).applyMatrix4(q.matrix);
      floorZ = Math.min(floorZ, box.min.z - 0.01);
    }
    return {
      floorZ,
      center: this.bounds.getCenter(new THREE.Vector3()),
      radius: Math.max(size.x, size.y, size.z, 20),
      floor: new THREE.Color(p.backdrop.bottom),
      shadow: p.shadow,
      env: this.envs.cube(p),
      envIntensity: p.envIntensity,
      envRotation: THREE.MathUtils.degToRad(this.render$.lightAngle),
      key: { dir: this.keyDir.clone(), color: this.key.color.clone(), intensity: p.key.i, size: p.key.size },
      below: this.camera.position.z < floorZ,
    };
  }

  private reportPhoto(photo: PhotoRenderer | null, held: boolean, now: number) {
    let s: PhotoStatus;
    if (!this.render$.photoreal) s = { state: "off", samples: 0, max: 0 };
    else if (!photo) {
      const reason = this.photoBlocked();
      s = reason ? { state: "paused", reason, samples: 0, max: 0 } : { state: "preparing", samples: 0, max: 0 };
    } else if (held) {
      s = { state: "waiting", reason: "Photoreal starts when the model finishes building", samples: 0, max: photo.quality.maxSamples };
    } else {
      const max = photo.quality.maxSamples;
      const samples = Math.floor(photo.samples);
      // "preparing" goes out before the first trace, so it is on screen while the shader compiles
      const state = photo.done ? "done" : photo.preparing ? "preparing" : now - photo.changedAt <= PHOTO_DELAY ? "waiting" : "rendering";
      s = { state, samples, max };
    }
    const key = `${s.state}|${s.reason ?? ""}`;
    // state changes go out at once; sample counts at most a few times a second
    if (key === this.photoStatusKey && (now - this.photoStatusAt < 250 || s.state !== "rendering")) return;
    this.photoStatusKey = key;
    this.photoStatusAt = now;
    this.onPhotoStatus(s);
  }

  /** Composite the accumulated image to the canvas, then overlays and the axis triad. */
  private present(now: number) {
    const r = this.renderer;
    if (this.interferences.length) {
      const pulse = 0.55 + 0.35 * Math.sin(now / 220);
      for (const i of this.interferences) {
        const mm = i.obj.material as THREE.MeshBasicMaterial;
        if (!this.focusCheck || this.focusCheck === i.id) mm.opacity = pulse;
      }
    }
    this.pipe.composite(null, { mask: true, selAmt: this.selAmt, selFill: this.selFill, hoverAmt: this.hoverAmt, time: now / 1000 });
    r.setRenderTarget(null);
    const marks = this.processMarks && this.photoMix > 0;
    if (this.overlays.size || marks) this.overlayDepth();
    if (marks) {
      // the path traced image covers the process marks drawn in the interactive pass: draw them over it
      const cam = this.camera;
      const prevMask = cam.layers.mask;
      const saveShadow = r.shadowMap.autoUpdate;
      r.shadowMap.autoUpdate = false;
      cam.layers.set(L_MARKS);
      r.render(this.scene, cam);
      cam.layers.mask = prevMask;
      r.shadowMap.autoUpdate = saveShadow;
    }
    r.render(this.overlay, this.camera);
    // axis triad in the corner
    const s = 86;
    r.clearDepth();
    r.setScissorTest(true);
    r.setScissor(10, 10, s, s);
    r.setViewport(10, 10, s, s);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.triadCam.position.copy(dir.multiplyScalar(4));
    this.triadCam.up.copy(this.camera.up);
    this.triadCam.lookAt(0, 0, 0);
    r.render(this.triadScene, this.triadCam);
    r.setScissorTest(false);
    r.setViewport(0, 0, this.container.clientWidth, this.container.clientHeight);
  }

  /** Selection mask: red = selected and visible, blue = selected but hidden behind others, green = hovered. */
  private renderMask() {
    const r = this.renderer;
    const cam = this.camera;
    const prevMask = cam.layers.mask;
    const prevClip = r.clippingPlanes;
    r.setRenderTarget(this.pipe.maskRT);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    if (this.display.selected.size || this.display.hovered) {
      const saveShadow = r.shadowMap.autoUpdate;
      r.shadowMap.autoUpdate = false;
      r.clippingPlanes = this.sectionAnim.on ? [this.sectionPlane] : [];
      this.scene.overrideMaterial = this.depthOnly;
      cam.layers.set(L_OPAQUE);
      r.render(this.scene, cam);
      this.scene.overrideMaterial = this.maskMat;
      this.maskMat.color.setRGB(1, 0, 0);
      this.maskMat.depthFunc = THREE.LessEqualDepth;
      cam.layers.set(L_SEL);
      r.render(this.scene, cam);
      this.maskMat.color.setRGB(0, 0, 1);
      this.maskMat.depthFunc = THREE.GreaterDepth;
      r.render(this.scene, cam);
      this.maskMat.color.setRGB(0, 1, 0);
      this.maskMat.depthFunc = THREE.LessEqualDepth;
      cam.layers.set(L_HOVER);
      r.render(this.scene, cam);
      this.scene.overrideMaterial = null;
      r.shadowMap.autoUpdate = saveShadow;
    }
    cam.layers.mask = prevMask;
    r.clippingPlanes = prevClip;
    r.setRenderTarget(null);
  }

  private triad: { line: THREE.LineBasicMaterial; tip: THREE.MeshBasicMaterial; ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture; label: string; axis: number }[] = [];

  private buildTriad() {
    const axes: [THREE.Vector3, string][] = [
      [new THREE.Vector3(1, 0, 0), "X"],
      [new THREE.Vector3(0, 1, 0), "Y"],
      [new THREE.Vector3(0, 0, 1), "Z"],
    ];
    axes.forEach(([v, label], axis) => {
      const line = new THREE.LineBasicMaterial();
      const tip = new THREE.MeshBasicMaterial();
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), v.clone().multiplyScalar(0.9)]);
      this.triadScene.add(new THREE.Line(g, line));
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), tip);
      ball.position.copy(v.clone().multiplyScalar(0.9));
      this.triadScene.add(ball);
      const c = document.createElement("canvas");
      c.width = c.height = 64;
      const tex = new THREE.CanvasTexture(c);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
      sp.position.copy(v.clone().multiplyScalar(1.28));
      sp.scale.setScalar(0.5);
      this.triadScene.add(sp);
      this.triad.push({ line, tip, ctx: c.getContext("2d")!, tex, label, axis });
    });
    this.paintTriad(false);
  }

  /** Axis colours: the bright set on a dark backdrop, deeper ones that hold up on a light backdrop. */
  private paintTriad(light: boolean) {
    const colors = light ? ["#d63a4a", "#12985f", "#4763e6"] : ["#ff5d6c", "#3ddc97", "#6d8bff"];
    for (const t of this.triad) {
      const color = colors[t.axis];
      t.line.color.set(color);
      t.tip.color.set(color);
      t.ctx.clearRect(0, 0, 64, 64);
      t.ctx.fillStyle = color;
      t.ctx.font = "600 40px 'IBM Plex Mono', monospace";
      t.ctx.textAlign = "center";
      t.ctx.textBaseline = "middle";
      t.ctx.fillText(t.label, 32, 34);
      t.tex.needsUpdate = true;
    }
  }

  // ---------- capture ----------

  /** Render a finished, converged image of the model at any size, without touching the on-screen view. */
  async capture(opts: { view: ViewPreset | "current"; width: number; height: number; focus?: string[]; frame?: "model" | "focus"; section?: "x" | "y" | "z"; mime?: string; quality?: number; samples?: number; box?: [[number, number, number], [number, number, number]]; dir?: [number, number, number]; overlays?: boolean }): Promise<string> {
    const prev = { pos: this.camera.position.clone(), target: this.controls.target.clone(), aspect: this.camera.aspect, display: this.display, section: this.section, sectionAnim: { ...this.sectionAnim }, replaced: this.replaced };
    // overlays (analysis results) are drawn unless the caller asks for the plain model
    const showOverlays = opts.overlays !== false && this.overlays.size > 0;
    const hideOverlays = !showOverlays && this.overlays.size > 0;
    if (hideOverlays) {
      for (const o of this.overlays) o.object.visible = false;
      this.replaced = new Set();
      for (const obj of this.parts.values()) this.applyMaterial(obj);
    }
    for (const o of this.overlays) o.still?.();
    // captures are the interactive view, CAD edges and grid included (the next frame puts the photoreal look back)
    if (this.photoLookOn) {
      this.photoLookOn = false;
      for (const obj of this.parts.values()) this.applyMaterial(obj);
      this.grid.visible = this.display.grid;
    }
    const pipe = new RenderPipeline(this.renderer);
    Object.assign(pipe.look, this.pipe.look);
    pipe.setSize(opts.width, opts.height, 1);
    // lit overlays need depth to hide behind the parts in front of them
    const out = new THREE.WebGLRenderTarget(opts.width, opts.height, { type: THREE.UnsignedByteType, depthBuffer: showOverlays });
    out.texture.colorSpace = THREE.SRGBColorSpace;
    // let pending reveal animations finish first
    for (const o of this.parts.values()) {
      if (o.reveal) {
        o.reveal = null;
        o.u.uScan.value.x = 0;
        this.updateClipping(o);
      }
    }
    try {
      this.camera.aspect = opts.width / opts.height;
      let box: THREE.Box3 | undefined = opts.box ? new THREE.Box3(new THREE.Vector3(...opts.box[0]), new THREE.Vector3(...opts.box[1])) : undefined;
      if (!box && opts.frame === "focus" && opts.focus?.length) {
        box = new THREE.Box3();
        for (const id of opts.focus) {
          const p = this.parts.get(id);
          if (p && !p.removing) box.expandByObject(p.group);
        }
        if (box.isEmpty()) box = undefined;
      }
      const { pos, target } = this.framing(opts.view, this.camera.aspect, box, opts.dir && new THREE.Vector3(...opts.dir));
      this.camera.position.copy(this.tighten(pos, target, box ?? this.bounds));
      this.controls.target.copy(target);
      this.camera.lookAt(target);
      this.camera.updateProjectionMatrix();
      this.camera.updateMatrixWorld();
      if (opts.focus?.length) {
        this.setDisplay({ ...this.display, focus: new Set(opts.focus), hovered: null });
        for (const o of this.parts.values()) {
          o.opacity = o.opacityTarget;
          this.applyOpacity(o);
          this.updateClipping(o);
        }
      }
      if (opts.section) {
        // cut away the half nearer the camera, so the cut face looks at it
        const ax = opts.section === "x" ? 0 : opts.section === "y" ? 1 : 2;
        const mid = (this.bounds.min.getComponent(ax) + this.bounds.max.getComponent(ax)) / 2;
        this.section = { on: true, axis: opts.section, t: 0.5, flip: this.camera.position.getComponent(ax) < mid };
        this.sectionAnim = { t: 0.5, on: true, fade: 0 };
        this.placeSection();
        for (const o of this.parts.values()) this.updateClipping(o);
        this.clipOverlays();
      }
      this.frameMatricesOnly();
      const n = opts.samples ?? Math.max(16, Math.min(96, this.pipe.maxSamples));
      for (let i = 0; i < n; i++) pipe.renderSample(this.scene, this.camera, (k) => this.placeKey(k));
      pipe.composite(out, { time: 0 });
      this.renderer.setRenderTarget(out);
      if (showOverlays) this.overlayDepth();
      this.renderer.render(this.overlay, this.camera);
      const px = new Uint8Array(opts.width * opts.height * 4);
      this.renderer.readRenderTargetPixels(out, 0, 0, opts.width, opts.height, px);
      return toDataUrl(px, opts.width, opts.height, opts.mime ?? "image/png", opts.quality ?? 0.9);
    } finally {
      pipe.dispose();
      out.dispose();
      this.renderer.setRenderTarget(null);
      this.placeKey(0);
      this.camera.position.copy(prev.pos);
      this.controls.target.copy(prev.target);
      this.camera.aspect = prev.aspect;
      this.camera.updateProjectionMatrix();
      this.section = prev.section;
      this.sectionAnim = prev.sectionAnim;
      this.placeSection();
      if (hideOverlays) {
        for (const o of this.overlays) o.object.visible = true;
        this.replaced = prev.replaced;
      }
      this.clipOverlays();
      this.setDisplay(prev.display);
      for (const o of this.parts.values()) {
        o.opacity = o.opacityTarget;
        this.applyOpacity(o);
        this.updateClipping(o);
      }
      this.controls.update();
      this.changed = true;
    }
  }

  /** Move the camera along its line of sight until the box's corners fill the frame (captures only). */
  private tighten(pos: THREE.Vector3, target: THREE.Vector3, box: THREE.Box3): THREE.Vector3 {
    if (box.isEmpty()) return pos;
    const cam = this.camera;
    const corners = Array.from({ length: 8 }, (_, i) => new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
    const offset = pos.clone().sub(target);
    const p = new THREE.Vector3();
    for (let k = 0; k < 3; k++) {
      cam.position.copy(target).add(offset);
      cam.lookAt(target);
      cam.updateMatrixWorld();
      cam.updateProjectionMatrix();
      let m = 0;
      for (const c of corners) {
        p.copy(c).project(cam);
        // a corner behind the camera: back off
        m = p.z > 1 ? 2 : Math.max(m, Math.abs(p.x), Math.abs(p.y));
        if (m >= 2) break;
      }
      if (m <= 0 || Math.abs(m - 0.88) < 0.02) break;
      offset.multiplyScalar(Math.min(2, Math.max(0.3, m / 0.88)));
    }
    return target.clone().add(offset);
  }

  /** update part matrices without advancing animations (for captures) */
  private frameMatricesOnly() {
    for (const obj of this.parts.values()) {
      const p = obj.explode.pos;
      const m = new THREE.Matrix4().makeTranslation(p.x, p.y, p.z);
      obj.group.matrix.copy(m.multiply(obj.placement));
      obj.group.matrixWorldNeedsUpdate = true;
    }
  }

  // ---------- material swatches ----------

  /** A rendered ball of a material under the current lighting, as a data URL with a transparent background. */
  swatch(material: string, finish: string | undefined, color: string, size = 96): string {
    const look = appearanceFor(material, finish, color);
    const key = `${look.key}|${this.preset.id}|${size}`;
    const hit = this.swatchCache.get(key);
    if (hit) return hit;
    const r = this.renderer;
    const scene = new THREE.Scene();
    scene.environment = this.scene.environment;
    scene.environmentIntensity = this.scene.environmentIntensity;
    scene.environmentRotation.copy(this.scene.environmentRotation);
    const { mat, u } = this.newPartMaterial(look);
    u.uNoiseScale.value = 0.3;
    const ball = new THREE.Mesh(new THREE.SphereGeometry(10, 64, 48), mat);
    // turn the ball so printed layers and brushing run across the view
    ball.rotation.set(0.35, 0, 0.6);
    scene.add(ball);
    const key2 = new THREE.DirectionalLight(this.key.color, this.key.intensity);
    // same angle to the camera as the key light has to the default view
    key2.position.copy(dirFrom(this.preset.key.az - 36, this.preset.key.el)).multiplyScalar(50);
    scene.add(key2);
    if (look.transmission > 0) {
      // something behind a clear material to see through it
      const back = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshBasicMaterial({ color: 0x8a93a6 }));
      back.position.set(0, 30, 0);
      back.rotation.x = Math.PI / 2;
      const checker = new THREE.Mesh(new THREE.PlaneGeometry(8, 60), new THREE.MeshBasicMaterial({ color: 0x2a2f3a }));
      checker.position.set(0, 29.9, 0);
      checker.rotation.x = Math.PI / 2;
      scene.add(back, checker);
    }
    const cam = new THREE.PerspectiveCamera(24, 1, 1, 400);
    cam.up.set(0, 0, 1);
    cam.position.set(0, -52, 14);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    // one small pipeline reused for every swatch
    const pipe = (this.swatchPipe ??= new RenderPipeline(r));
    Object.assign(pipe.look, this.pipe.look);
    pipe.look.ao = 0;
    pipe.look.bloom = 0;
    pipe.setSize(size, size, 1);
    pipe.reset();
    const out = new THREE.WebGLRenderTarget(size, size, { type: THREE.UnsignedByteType, depthBuffer: false });
    try {
      for (let i = 0; i < 12; i++) pipe.renderSample(scene, cam);
      pipe.composite(out, { transparent: !look.transmission });
      const px = new Uint8Array(size * size * 4);
      r.readRenderTargetPixels(out, 0, 0, size, size, px);
      if (look.transmission > 0) {
        // clear materials render over a backdrop to show refraction; cut that back to the ball
        const rad = (Math.tan(Math.asin(10 / cam.position.length())) / Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) * (size / 2);
        for (let y = 0; y < size; y++)
          for (let x = 0; x < size; x++) {
            const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
            const i = (y * size + x) * 4 + 3;
            px[i] = Math.round(px[i] * Math.min(1, Math.max(0, rad - d + 0.5)));
          }
      }
      const url = toDataUrl(px, size, size, "image/png", 1);
      this.swatchCache.set(key, url);
      return url;
    } finally {
      pipe.dispose();
      out.dispose();
      ball.geometry.dispose();
      mat.dispose();
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh && o !== ball) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
      r.setRenderTarget(null);
      this.needComposite = true;
    }
  }
}

function slerpDir(a: THREE.Vector3, b: THREE.Vector3, t: number): THREE.Vector3 {
  const dot = THREE.MathUtils.clamp(a.dot(b), -1, 1);
  const theta = Math.acos(dot);
  if (theta < 1e-4) return a.clone().lerp(b, t).normalize();
  if (Math.PI - theta < 1e-3) {
    // opposite directions: go over the top
    const mid = new THREE.Vector3(0, 0, 1);
    return t < 0.5 ? slerpDir(a, mid, t * 2) : slerpDir(mid, b, t * 2 - 1);
  }
  const s = Math.sin(theta);
  return a
    .clone()
    .multiplyScalar(Math.sin((1 - t) * theta) / s)
    .addScaledVector(b, Math.sin(t * theta) / s)
    .normalize();
}

/** Pixels read back from WebGL are bottom-up; flip them into a canvas and encode. */
function toDataUrl(px: Uint8Array, w: number, h: number, mime: string, quality: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  const row = w * 4;
  for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL(mime, quality);
}

function gridMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uCell: { value: 10 },
      uFade: { value: 400 },
      uCenter: { value: new THREE.Vector3() },
      uMinor: { value: new THREE.Color("#2a3142") },
      uMajor: { value: new THREE.Color("#3d4a66") },
      uAlpha: { value: 0.9 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      uniform float uCell;
      uniform float uFade;
      uniform vec3 uCenter;
      uniform vec3 uMinor;
      uniform vec3 uMajor;
      uniform float uAlpha;
      float line(vec2 p, float cell) {
        vec2 q = p / cell;
        vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q);
        return 1.0 - min(min(g.x, g.y), 1.0);
      }
      void main() {
        vec2 p = vWorld.xy;
        float minor = line(p, uCell);
        float major = line(p, uCell * 10.0);
        float d = length(p - uCenter.xy);
        float fade = 1.0 - smoothstep(uFade * 0.25, uFade, d);
        vec3 col = mix(uMinor, uMajor, major);
        float a = max(minor * 0.45, major * 0.8);
        float ax = 1.0 - min(abs(p.y) / fwidth(p.y) / 1.5, 1.0);
        float ay = 1.0 - min(abs(p.x) / fwidth(p.x) / 1.5, 1.0);
        col = mix(col, vec3(0.9, 0.18, 0.22), ax);
        col = mix(col, vec3(0.12, 0.72, 0.36), ay);
        a = max(a, max(ax, ay) * 0.75);
        gl_FragColor = vec4(col, a * fade * uAlpha);
      }`,
  });
}
