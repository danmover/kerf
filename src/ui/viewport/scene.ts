// The CAD viewport scene: shared geometry per solid hash, realistic
// materials, studio lighting, selection, ghosting, section cuts, exploded
// views, gear motion, interference highlights and the animations between
// states. Frames are built by RenderPipeline and only rendered on demand:
// while the view is still, the image refines and then the GPU rests.

import * as THREE from "three";
import { during, watchGl } from "../../app/stalls";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { turns, type EvalPart, type Motion } from "../../core/model";
import { driveAngle, motionPose } from "../../core/kinematics";
import { explodeOffsets, stepProgress, type ExplodePlan } from "../../core/explode";
import { ChainLinks } from "./chainLinks";
import { RopeLine } from "./ropeLine";
import { ropeLineAt } from "../../machine/ropes";
import type { RopeNode } from "../../machine/types";
import type { MeshEntry } from "../../core/engine";
import { workWaiting } from "../../core/slices";
import { shotTurn, type ShotWaiting } from "./shotTurn";
import { closeEnough, pickMesh, threadPitch } from "./threadLod";
import { prepareRay } from "./fastPick";
import type { MeshData } from "../../kernel/build";
import type { Interference } from "../../kernel/protocol";
import { xformMatrix } from "../../kernel/recipe";
import type { ViewPreset } from "../../app/view";
import type { FilmLayout, FilmShot, FilmView } from "../../app/viewportApi";
import { buildShare } from "../../film/timeline";
import { appearanceFor, Detail, makeFor, processFinish, type Appearance } from "./render/appearance";
import { applyAppearance, applyMake, capMaterial, FILL_ENV, FILL_ON, partUniforms, patchEdgeMaterial, patchPartMaterial, plyLayout, setBevelPixel, type PartUniforms } from "./render/partShader";
import { BevelBuilder, bevelGeometry, type BevelBands } from "./render/bevel";
import { ARRIVE_MS, DROP_LAND, arrivalKind, dropHeight, fillAt, fillAxis, screwLeft, screwTravel, traceAt, traceOrder } from "./arrival";
import { edgeSweep, editSweep, type Sweep } from "./editSweep";
import { RenderPipeline, SAMPLES, type Quality } from "./render/pipeline";
import { ChangeDepth } from "./render/changeDepth";
import { readPixelsLater } from "./render/readback";
import { ContactShadow } from "./render/contactShadow";
import { FloorMirror, Ground, mirrorPlane, shadowCatcher } from "./render/ground";
import { StudioEnvironments, concentricDisc, dirFrom, halton, lightSteps, lightingPreset, type LightingPreset } from "./render/studio";
import type { PhotoRenderer, PhotoPart, PhotoQuality, PhotoStage } from "./render/photoreal";
import { MOUSE_SCHEMES, sketchButtons, type MouseAction, type MouseScheme } from "../../app/mouse";
import { MeasureOverlay } from "./measure";

const ACCENT = new THREE.Color("#6d8bff");
/** how long a finger or pen is held still to open the spot chat, ms */
const HOLD_MS = 550;
const HOVER = new THREE.Color("#a9bcff");
/** how far a pixel of drag on the view cube turns the camera, radians */
const ORBIT_PER_PX = 0.012;

/** Layers used to draw subsets of the parts (selection mask). */
const L_OPAQUE = 1;
const L_SEL = 2;
const L_HOVER = 3;
/** process marks, drawn again over the photoreal image (which has none of its own) */
const L_MARKS = 4;

/** How many removed parts' materials are kept so their shaders stay compiled (see retire()). */
const RETIRED_MAX = 48;
/** frames in a row that may throw before the view counts as broken (about a third of a second) */
const FRAME_FAILS = 20;
/** How long a rebuilt part's new surfaces glow, and how long its lost ones take to dissolve, ms */
const CHANGE_MS = 1100;
const CHANGE_FADE_MS = 620;
/** A change that sweeps through its part: how long it shows, and how long its front takes to cross, ms */
const SWEEP_MS = 1350;
const SWEEP_FRONT_MS = 720;
/** Most parts one edit works a sweep out for from their edges (the rest show their change without one) */
const EDGE_SWEEPS_MAX = 4;
/** How long a check's result pulses on its parts, ms */
const PULSE_MS = 950;
/** A change the camera goes to see: how long it takes to get there, stays, and comes back, ms */
const VISIT_GO_MS = 650;
const VISIT_STAY_MS = 1100;
const VISIT_BACK_MS = 800;

/** How far apart two meshes of one surface can lie, by the mesh's quality (src/kernel/build.ts meshes preview at 0.25 mm, the rest at 0.03). */
const meshTolerance = (geoKey: string) => (geoKey.endsWith(":preview") ? 0.25 : 0.03);
/** How many material-ball materials are kept */
const SWATCH_MATS_MAX = 96;
/** The picture is held this long (ms) for shaders being built before the page says so: most builds are quicker. */
const SHADERS_TOLD_AFTER = 400;
/** How long a picture drawn between frames waits for the view to come to rest, unless told otherwise, ms. */
const SHOT_PATIENCE_MS = 500;
/** The longest the view's picture goes without a sample while work done a piece at a time is waiting for the page's turn, ms. */
const SAMPLE_WAIT_MS = 250;
/** what the freeze record calls drawing a material ball */
const SWATCH_WORK = "3D view: a material swatch";

interface GeoEntry {
  mesh: THREE.BufferGeometry;
  edges: THREE.BufferGeometry;
  /** (first point, point count, edge id) per B-rep edge, for the order the outline draws in (see traceOrder) */
  edgeGroups?: Int32Array;
  users: number;
  /** its rounded-edge bands (render/bevel.ts), once found; null when it has none */
  bevel?: THREE.BufferGeometry | null;
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
  /** a new part made in place: its outline traces, then it fills along dir (world) from sMin to sMax */
  reveal: { t0: number; dur: number; sMin: number; sMax: number; dir: THREE.Vector3; plane: THREE.Plane } | null;
  /** a bought part dropping in, or a screw spinning down its thread (in assembly coordinates) */
  arrive: { t0: number; dur: number; kind: "drop" | "screw"; travel: number; axis: THREE.Vector3; pivot: THREE.Vector3; turns: number; landed: boolean } | null;
  /** dissolve in after a rebuild, or out on removal */
  dissolve: { t0: number; dur: number; out: boolean } | null;
  flash: { t0: number; dur: number } | null;
  /** rebuilt: its new surfaces glowing, told apart from the old ones by ChangeDepth; swept through it when it has a sweep (part frame) */
  change: { t0: number; dur: number; sweep: Sweep | null; ghost: Ghost } | null;
  /** a check's result landing on it */
  pulse: { t0: number; dur: number } | null;
  /** a ring of light running out from where it was clicked */
  ripple: { t0: number; dur: number; reach: number } | null;
  removing: boolean;
  opacity: number;
  opacityTarget: number;
  /** last state that affects the rendered image (for resetting the accumulation) */
  sig: string;
  decor: Decor | null;
  /** its rounded edges, drawn with its own material (a child of mesh, so it shows and hides with it) */
  bevel: THREE.Mesh | null;
  /** a chain's links, drawn in place of its solid while the motion preview is turned */
  links?: ChainLinks | null;
  /** a rope's line, drawn in place of its solid while what it runs on is away from where it is drawn */
  line?: RopeLine | null;
}

/** A rope as the 3D view needs it to draw it moving: its nodes, and the part each is (or is tied to). */
export interface RopeDraw {
  nodes: RopeNode[];
  /** the rope's diameter and its length from end to end, mm */
  d: number;
  length: number;
  /** by node: the id of the drum or sheave, or of the part a tied end is on */
  on: (string | undefined)[];
}

/** Detail drawn with a part in its own frame: a bought circuit board's components, copper and silkscreen. */
export interface PartDecoration {
  readonly object: THREE.Object3D;
  /** parts it draws in full, hidden (but still pickable) while it is shown: a board's coarse component boxes */
  readonly hides?: readonly string[];
  /** free what belongs to this one decoration (shared geometry and textures stay with its maker) */
  dispose(): void;
}

/**
 * Makes decorations: `key` names the decoration a part gets (null for none), so
 * it is made again only when that changes. `make` may return null while it is
 * still building one; the part keeps its old decoration and is asked again on
 * the next redecorate().
 */
export interface Decorator {
  key(part: EvalPart, surface?: PartSurface): string | null;
  make(part: EvalPart, surface?: PartSurface): PartDecoration | null;
}

/** The part's mesh as drawn (in its own frame), for decorations laid on its surface; `key` changes with it. */
export interface PartSurface {
  key: string;
  geometry: THREE.BufferGeometry;
}

/** A picture on its way that the page is not held for: drawn a sample at a time between the view's frames (see SceneController.captureBetweenFrames). */
interface Shot extends ShotWaiting {
  view: ViewPreset | "current";
  width: number;
  height: number;
  /** what is framed (the whole model when none) and from which side (the view's own when none) */
  box?: THREE.Box3;
  dir?: THREE.Vector3;
  samples: number;
  mime: string;
  quality: number;
  /** a later picture with the same key takes this one's place */
  key?: string;
  /** false once nobody wants the picture any more */
  wanted?: () => boolean;
  /** where it is drawn from; null until its first sample */
  cam: THREE.PerspectiveCamera | null;
  done: (url: string | null) => void;
}

interface Decor {
  d: PartDecoration;
  key: string;
  meshes: THREE.Mesh[];
  mats: THREE.Material[];
}

/** The previous geometry of a rebuilt part, dissolving away. */
interface Ghost {
  group: THREE.Group;
  mesh: THREE.Mesh;
  mat: THREE.MeshPhysicalMaterial;
  u: PartUniforms;
  edgeMat: THREE.LineBasicMaterial;
  edgeAlpha: number;
  geoKey: string;
  t0: number;
  /** how long it is kept, and how long it takes to dissolve (kept longer for the new mesh to test against) */
  dur: number;
  fade: number;
  /** only the surfaces the new mesh doesn't cover dissolve (see startChange) */
  change: boolean;
  /** they go as the change's front passes instead (see the part shader's uSweep) */
  sweep: boolean;
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
  /** the same normal in the part's own frame */
  localNormal: [number, number, number];
}

const tuple = (v: THREE.Vector3): [number, number, number] => [v.x, v.y, v.z];

/** Something an overlay draws under the pointer, and how far along the ray it is. */
export interface OverlayHit {
  distance: number;
}

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
  /** parts shown faded while the overlay is on (covers over what it draws), with their opacity; they can't be picked */
  readonly ghosts?: ReadonlyMap<string, number>;
  /** what the overlay draws along a ray, so a click or hover there goes to it rather than to a part behind */
  hitTest?(ray: THREE.Raycaster): OverlayHit | null;
  /** a click on the overlay's hit, or null for a click anywhere else */
  pick?(hit: OverlayHit | null, additive: boolean): void;
  /** the pointer is over the overlay's hit, or null when it is not */
  hover?(hit: OverlayHit | null): void;
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
  /** the floor mirrors the model as much as the set's floor would (on unless false) */
  floorGloss?: boolean;
  /** once the view is still, the parts in front of and behind the selection soften a little (on unless false) */
  focusBlur?: boolean;
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
/** how long a path tracer turned off is kept ready (its shader compiled, its scene built), ms: turning photoreal back on meanwhile starts tracing at once */
const PHOTO_KEEP = 60_000;

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
  /** the photoreal view's state as of the last frame */
  private photoNow: PhotoStatus = { state: "off", samples: 0, max: 0 };
  /** an export needs at least this photoreal quality while it runs */
  private photoFloor: PhotoQuality | null = null;
  /** photoreal status changed (throttled) */
  onPhotoStatus: (s: PhotoStatus) => void = () => undefined;
  private photoLookOn = false;
  /** the last frame only traced: its length is the tracer's cost */
  private traceOnly = false;
  /** the path tracer's code is loading (it is only fetched when first used) */
  private photoLoading = false;
  private photoError = "";
  /** when photoreal was last turned off (ms): the path tracer is freed a while later */
  private photoOffAt = 0;
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
  private changeDepth: ChangeDepth | null = null;
  /** where the camera is drawing back to, to keep a design's arriving parts in view (see growView) */
  private growTo: { pos: THREE.Vector3; target: THREE.Vector3; at: number } | null = null;
  /** while Claude builds: the camera goes to see a change out of view and comes back (see visitChange) */
  private followChanges = false;
  private visit: { home: { pos: THREE.Vector3; target: THREE.Vector3 }; box: THREE.Box3; backAt: number; back: boolean } | null = null;
  /** depth of field on the selection (see focusLens), and the selection it was worked out for */
  private lens: { radius: number; focus: number } | null = null;
  private lensSel: ReadonlySet<string> | null = null;
  private geos = new Map<string, GeoEntry>();
  /** finds each refined mesh's rounded edges off the main thread */
  private bevels = new BevelBuilder((key, bands) => this.bevelReady(key, bands));
  private seenHashByPart = new Map<string, string>();
  /** the meshes the parts were last set from, for switching a part between its drawn and real threads */
  private lastMeshes: Map<string, MeshEntry> | null = null;
  /** parts the camera is close enough to that their real threads are shown */
  private closeUps = new Set<string>();
  /** when to look again at which parts are close (ms), once the camera has stopped; 0 when not due */
  private lodDue = 0;
  private grid: THREE.Mesh;
  private gridMat: THREE.ShaderMaterial;
  private ground: THREE.Mesh;
  /** soft darkening of the floor under the model, drawn again only when the model changes */
  private contact: ContactShadow;
  /**
   * Bumped whenever anything but the camera changes: each shadow-casting light redraws its map when the model changed
   * since it last drew it, or the light moved. While only the camera moves, the maps are reused.
   */
  private shadowStamp = 0;
  private groundMat: THREE.ShadowMaterial;
  /** each light's share of the light, for the shadow catcher (key first, then the casters) */
  private shadowWeights: { value: number[] };
  private key: THREE.DirectionalLight;
  private keyDir = new THREE.Vector3();
  /** the set's other shadow-casting lights (big softboxes, a window), and where each points from */
  private casters: THREE.DirectionalLight[] = [];
  private casterDirs: THREE.Vector3[] = [];
  /** a set's real ground (bench top, floor), and the model mirrored in a glossy floor */
  private groundLit: Ground;
  private mirror: FloorMirror;
  private mirrorPlane: { mesh: THREE.Mesh; fade: { value: THREE.Vector4 } };
  private floorZ = 0;
  private sectionFrame: THREE.LineLoop;
  private sectionFill: THREE.Mesh;
  private depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false });
  private maskMat = new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
  /** the selection mask tested against the view's kept depth (see keptMask): no depth pass of every part each frame */
  private keptMaskU = { tViewDepth: { value: null as THREE.Texture | null }, uRes: { value: new THREE.Vector2(1, 1) }, uHover: { value: 0 } };
  private keptMaskMat = keptMask(this.keptMaskU);
  /** something in the scene changed: restart the accumulation */
  private changed = true;
  /** since when the picture has been held for shaders the card is building; null when it is not */
  private shadersHeld: number | null = null;
  /** a light set chosen and not in place yet, while the card builds what its maps are baked with: says true once it has */
  private lightingDue: (() => boolean) | null = null;
  /** a light set is in place: the first waits for the card like any other, and nothing is drawn before it */
  private lit = false;
  private shadersTold = false;
  private maskDirty = true;
  private needComposite = true;
  private raf = 0;
  private last = performance.now();
  private camAnim: { t0: number; dur: number; fromDir: THREE.Vector3; toDir: THREE.Vector3; fromDist: number; toDist: number; fromTarget: THREE.Vector3; toTarget: THREE.Vector3 } | null = null;
  /** a mouse wheel's notch still to zoom, in wheel pixels, and where the pointer was */
  private zoomGlide: { left: number; x: number; y: number } | null = null;
  /** the mouse scheme (see app/mouse) and which way the wheel zooms (-1: reversed) */
  private mouseScheme: MouseScheme = "kerf";
  private wheelSign = 1;
  private display: DisplayState = { hidden: new Set(), selected: new Set(), hovered: null, focus: new Set(), isolate: false, xray: false, edges: true, grid: true, reduceMotion: false };
  private section = { on: false, axis: "x" as "x" | "y" | "z", t: 0.5, flip: false };
  /** animated section position: slides in from the edge when switched on */
  private sectionAnim = { t: 1, on: false, fade: 0 };
  private sectionPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
  private explodeAmt = 0;
  /** the explode amount on screen: eases to explodeAmt when the view is switched, so the parts come off step by step */
  private explodeShown = 0;
  private explodeTween: { from: number; to: number; t0: number; dur: number } | null = null;
  /** which way and in what order parts come off (core/explode.ts), made on first use after each model change */
  private explodePlanner: (() => ExplodePlan | null) | null = null;
  private plan: ExplodePlan | null = null;
  private planStale = true;
  private assembly: { t0: number; order: string[]; at: Map<string, number> } | null = null;
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
  /** pictures being drawn a sample at a time between the view's frames, the first in the list first (see captureBetweenFrames) */
  private shots: Shot[] = [];
  private shotPipe: RenderPipeline | null = null;
  /** when the view's picture last got a sample, and a picture drawn between frames last got one */
  private sampledAt = 0;
  private shotAt = 0;
  /** rounded edges arrived since the last frame (bevelReady) */
  private edgesCame = false;
  /** the camera the bevels' width and the floor's mirror were last set for (see beforeSample) */
  private viewOf: THREE.Camera | null = null;
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
  /** balls being drawn, by what they will be kept as, and the line they wait in */
  private swatchJobs = new Map<string, Promise<string>>();
  private swatchLine: Promise<unknown> = Promise.resolve();
  /** the material ball's scene, built once */
  private swatchStage: { scene: THREE.Scene; ball: THREE.Mesh; key: THREE.DirectionalLight; backdrop: THREE.Group; cam: THREE.PerspectiveCamera } | null = null;
  /** one ball material per look, kept so each look's shader compiles once */
  private swatchMats = new Map<string, THREE.MeshPhysicalMaterial>();
  /** materials of removed parts, kept unused so their compiled shaders stay ready */
  private retired: THREE.Material[] = [];
  private disposed = false;
  private measure = new MeasureOverlay();
  private overlays = new Set<SceneOverlay>();
  /** parts drawn by an overlay instead of as solids */
  private replaced = new Set<string>();
  private decorator: Decorator | null = null;
  private decorHiddenDirty = false;
  /** parts a decoration draws in full */
  private decorHidden = new Set<string>();
  /** parts an overlay shows faded */
  private ghosted = new Map<string, number>();
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
  /** the graphics card is building shaders the view needs, and the picture waits for them (true), or it has finished */
  onShaders: (building: boolean) => void = () => undefined;
  /** the graphics card reset and took the drawing context (true), or gave it back (false) */
  onContextChange: (lost: boolean) => void = () => undefined;
  /** frames keep failing to draw: the view is broken and needs replacing */
  onBroken: (e: Error) => void = () => undefined;
  /** the drawing context is gone until the browser gives it back */
  contextLost = false;
  /** frames that threw, in a row */
  private failedFrames = 0;
  /** the user turned the lighting by dragging with Alt held */
  onLightAngle: (deg: number) => void = () => undefined;
  /** the turntable stopped because the user took the camera */
  onTurntableStop: () => void = () => undefined;
  /** the camera turned (the view cube follows it) */
  onOrient: (q: THREE.Quaternion) => void = () => undefined;
  private orient = new THREE.Quaternion(NaN, NaN, NaN, NaN);
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
    // calls that wait for the graphics card (a shader compile, an image read back) are named in the freeze record
    watchGl(this.renderer.getContext());
    // a GPU that resets mid-trace must not be sent straight back into it
    this.renderer.domElement.addEventListener("webglcontextlost", () => {
      // dispose() gives the context back on purpose
      if (this.disposed) return;
      if (this.render$.photoreal && (this.photo || this.photoLoading)) this.photoError = "The graphics card reset during the photoreal render, so it stopped";
      // a path tracer kept ready while photoreal is off goes too
      if (this.photo) this.dropPhoto();
      this.contextLost = true;
      this.onContextChange(true);
    });
    // three.js gets the context back and uploads meshes and textures again, but
    // what was drawn into render targets is gone: draw the lighting again
    this.renderer.domElement.addEventListener("webglcontextrestored", () => {
      if (this.disposed) return;
      this.contextLost = false;
      this.contextRestored();
      this.onContextChange(false);
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
    // a mouse wheel's notch zooms over a few frames instead of in one jump; a
    // trackpad's stream of small steps is smooth already and goes straight through
    container.addEventListener("wheel", (e) => this.glideWheel(e), { capture: true, passive: false });
    this.controls.addEventListener("start", () => this.takeCamera());

    this.key = this.shadowLight(2048);

    this.gridMat = gridMaterial();
    this.grid = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.gridMat);
    this.grid.renderOrder = -1;
    this.scene.add(this.grid);
    const catcher = shadowCatcher();
    this.groundMat = catcher.mat;
    this.shadowWeights = catcher.weights;
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.groundMat);
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
    this.mirror = new FloorMirror(this.renderer);
    this.groundLit = new Ground(this.mirror);
    this.mirrorPlane = mirrorPlane(this.mirror);
    this.scene.add(this.groundLit.mesh, this.mirrorPlane.mesh);
    this.contact = new ContactShadow(this.renderer);
    this.scene.add(this.contact.mesh);

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
    el.addEventListener("pointerdown", (e) => {
      down = { x: e.clientX, y: e.clientY };
      // nothing is hovered while the view turns: that saves drawing the hover outline's passes every frame
      if (this.display.hovered) this.onHover(null);
    });
    el.addEventListener("pointerup", (e) => {
      endHold();
      if (this.lightDrag) {
        this.lightDrag = null;
        this.controls.enabled = true;
        down = null;
        return;
      }
      const still = down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5;
      if (still && e.button === 0) {
        const additive = e.shiftKey || e.metaKey || e.ctrlKey;
        const part = this.rayHit(e.clientX, e.clientY);
        const over = this.overlayHit(e.clientX, e.clientY, part?.distance);
        for (const o of this.overlays) o.pick?.(over?.o === o ? over.hit : null, additive);
        if (!over) {
          const id: string | null = part?.object.userData.partId ?? null;
          if (part && id) this.startRipple(id, part.point);
          this.onPick(id, additive);
        }
      }
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
          if (pending) {
            const part = this.rayHit(pending.clientX, pending.clientY);
            const over = this.overlayHit(pending.clientX, pending.clientY, part?.distance);
            for (const o of this.overlays) o.hover?.(over?.o === o ? over.hit : null);
            this.onHover(over ? null : (part?.object.userData.partId ?? null));
          }
          pending = null;
        });
      pending = e;
    });
    el.addEventListener("pointerleave", () => {
      for (const o of this.overlays) o.hover?.(null);
      this.onHover(null);
    });
    el.addEventListener("dblclick", (e) => this.onDoublePick(this.pick(e)));

    const loop = () => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      try {
        during("3D view: drawing a frame", () => this.frame());
        this.failedFrames = 0;
      } catch (e) {
        this.frameFailed(e);
      }
    };
    this.raf = requestAnimationFrame(loop);
  }

  /**
   * A frame threw. One bad frame is logged and the next tries again; a view that throws on every frame shows a frozen
   * or empty picture and ignores the mouse, so after a run of them the view says it is broken (the viewport then starts
   * a new one in its place).
   */
  private frameFailed(e: unknown) {
    this.failedFrames++;
    const err = e instanceof Error ? e : new Error(String(e));
    if (this.failedFrames === 1) console.error("The 3D view failed to draw a frame", err);
    if (this.failedFrames === FRAME_FAILS) {
      console.error(`The 3D view failed to draw ${FRAME_FAILS} frames in a row`);
      this.onBroken(err);
    }
  }

  /** The camera has framed the model (or the user took it): a view started in this one's place should keep it. */
  get framed() {
    return this.hasFitted || !this.autoFit;
  }

  /** Carry on from an earlier view of the same design (the 3D view was started again): its camera, and no framing of the first build. */
  adoptCamera(s: { pos: [number, number, number]; target: [number, number, number] }) {
    this.camera.position.set(...s.pos);
    this.controls.target.set(...s.target);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
    this.hasFitted = true;
    this.autoFit = false;
    this.changed = true;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.controls.dispose();
    for (const p of [...this.parts.values()]) this.disposePart(p);
    for (const g of [...this.ghosts]) this.disposeGhost(g);
    this.changeDepth?.dispose();
    this.measure.clear();
    for (const g of this.geos.values()) {
      g.mesh.dispose();
      g.edges.dispose();
      g.bevel?.dispose();
    }
    this.bevels.dispose();
    this.groundLit.dispose();
    this.mirror.dispose();
    this.mirrorPlane.mesh.geometry.dispose();
    (this.mirrorPlane.mesh.material as THREE.Material).dispose();
    this.pipe.dispose();
    this.contact.dispose();
    this.swatchPipe?.dispose();
    for (const t of [...this.shots]) t.done(null);
    this.shotPipe?.dispose();
    for (const m of [...this.retired, ...this.swatchMats.values()]) m.dispose();
    this.swatchStage?.ball.geometry.dispose();
    this.swatchStage?.backdrop.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.photo?.dispose();
    this.envs.dispose();
    this.renderer.dispose();
    // give the drawing context back now: a page may only hold a few, and one left for the garbage collector counts
    // until then (when there are too many, the browser takes one from a view that is still on screen)
    if (!this.contextLost) this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  // ---------- lighting and quality ----------

  setRenderSettings(s: RenderSettings) {
    const prev = this.render$;
    this.render$ = { ...s };
    if (prev.lighting !== s.lighting || prev.lightAngle !== s.lightAngle || prev.theme !== s.theme || prev.floorGloss !== s.floorGloss) this.applyLighting();
    if (prev.photoreal !== s.photoreal) {
      if (!s.photoreal) {
        // the image buffers go now; the compiled shader and scene copy are freed a minute later,
        // so a quick off and on doesn't compile and build it all again (on Windows a compile
        // takes many seconds), and nothing is freed while the GPU or the worker still uses it
        this.parkPhoto();
        this.photoError = "";
      }
    }
    if (this.photo && prev.quality !== s.quality) {
      this.photo.quality = this.photoQuality();
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

  /** The graphics card reset and three.js has a new context: the environment maps were drawn into the old one. */
  private contextRestored() {
    this.pipe.forgetShaders();
    this.envs.forget();
    this.applyLighting(false);
    this.maskDirty = true;
    // what was drawn of a picture between frames went with the context: each starts again
    for (const t of this.shots) t.cam = null;
  }

  /**
   * Puts the chosen light set in place. `wait`: a set whose maps are not baked yet is put in place a few frames on,
   * once the card has built the shaders they are baked with, instead of the page being held for those builds here
   * (frame() comes back when it has). Until then the set before stays, or at the start nothing is drawn.
   */
  private applyLighting(wait = true) {
    const p = lightingPreset(this.render$.lighting, this.render$.theme);
    if (wait && !this.envs.has(p)) {
      const before = this.lightingDue;
      // (nothing new for the card to build, and builds from a moment ago still going: those are waited for)
      this.lightingDue = this.pipe.rehearse(() => this.envs.rehearse(p)) ?? (before && !before() ? before : null);
      if (this.lightingDue) return;
    }
    this.lightingDue = null;
    this.lit = true;
    this.preset = p;
    this.scene.environment = this.envs.get(p);
    this.scene.environmentIntensity = p.envIntensity;
    const rot = THREE.MathUtils.degToRad(this.render$.lightAngle);
    this.scene.environmentRotation.set(0, 0, rot);
    this.keyDir.copy(dirFrom(p.key.az + this.render$.lightAngle, p.key.el));
    this.key.color.set(p.key.color);
    this.key.intensity = p.key.i;
    this.overlayKey.position.copy(this.keyDir);
    // the set's other shadow-casting lights; the parts take their fill light from the set without those panels
    const casters = p.casters ?? [];
    while (this.casters.length > casters.length) {
      const l = this.casters.pop()!;
      this.scene.remove(l, l.target);
      l.shadow.dispose();
      l.dispose();
    }
    while (this.casters.length < casters.length) this.casters.push(this.shadowLight(1024));
    this.casterDirs = casters.map((c) => dirFrom(c.az + this.render$.lightAngle, c.el));
    casters.forEach((c, k) => {
      this.casters[k].color.set(c.color);
      this.casters[k].intensity = c.i;
    });
    const total = p.key.i + casters.reduce((a, c) => a + c.i, 0);
    this.shadowWeights.value = [p.key.i, ...casters.map((c) => c.i), 0, 0, 0].slice(0, 4).map((i) => i / total);
    FILL_ENV.value = this.envs.fill(p);
    FILL_ON.value = p.panels.some((pn) => pn.cast) ? 1 : 0;
    // a set with a real ground stands the model on it; the others catch its shadows over their backdrop
    this.groundLit.set(p.ground ?? null);
    this.ground.visible = !p.ground;
    this.groundMat.opacity = p.shadow;
    this.contact.setStrength(p.contact?.near ?? 0.85, p.contact?.pool ?? 0.5, p.ground ? undefined : p.floorLight);
    this.shadowStamp++;
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
    this.placeKey(0);
    this.swatchCache.clear();
    this.changed = true;
  }

  /** Before each accumulated sample: the key light where that sample has it, and the floor's contact shadow on the first sample when the model changed (or always, for a capture or film frame that posed the model its own way). */
  private beforeSample(i: number, fresh = false, cam: THREE.PerspectiveCamera = this.camera, heightPx = this.pipe.height) {
    // a capture or film frame poses the model its own way: every shadow is drawn again for it
    if (i === 0 && fresh) this.shadowStamp++;
    // The bevels' width and the floor's mirror are of one camera: set at a picture's first sample, and again when a
    // sample of another camera's picture was drawn since (a small picture drawn between the view's frames).
    const anew = i === 0 || this.viewOf !== cam;
    this.viewOf = cam;
    if (anew) setBevelPixel(cam, heightPx);
    this.placeKey(i);
    this.prepareShadows();
    if (i === 0 && (fresh || this.contact.dirty)) this.contact.render(this.scene, L_OPAQUE, this.sectionAnim.on ? [this.sectionPlane] : []);
    if (anew) this.drawMirror(cam, heightPx);
  }

  /** A light that casts shadows, its map `size` square, redrawn only when told (prepareShadows). */
  private shadowLight(size: number): THREE.DirectionalLight {
    const l = new THREE.DirectionalLight(0xffffff, 1);
    l.castShadow = true;
    l.shadow.mapSize.set(size, size);
    l.shadow.bias = -0.0002;
    l.shadow.autoUpdate = false;
    l.userData.shadowAt = new THREE.Vector3(NaN, NaN, NaN);
    l.userData.shadowStamp = -1;
    // note where and for which model the map was last drawn, whoever drew it
    const shadow = l.shadow;
    const updateMatrices = shadow.updateMatrices.bind(shadow);
    shadow.updateMatrices = (light: THREE.Light) => {
      l.userData.shadowAt.copy(l.position);
      l.userData.shadowStamp = this.shadowStamp;
      updateMatrices(light);
    };
    this.scene.add(l, l.target);
    return l;
  }

  /** Ask for each shadow map that is not of the model as it is now, from where its light now is. */
  private prepareShadows() {
    for (const l of [this.key, ...this.casters]) {
      const fresh = !!l.shadow.map && l.userData.shadowStamp === this.shadowStamp && (l.userData.shadowAt as THREE.Vector3).equals(l.position);
      l.shadow.needsUpdate = !fresh;
    }
  }

  /** The model mirrored in a glossy floor, for this view (none when the floor is matte, glossy floors are off, or the camera is under the floor). */
  private drawMirror(cam: THREE.PerspectiveCamera, heightPx: number) {
    const p = this.preset;
    const gloss = this.render$.floorGloss === false ? 0 : (p.gloss ?? 0);
    const above = cam.position.z > this.floorZ;
    this.groundLit.mesh.visible = !!p.ground && above;
    this.mirrorPlane.mesh.visible = gloss > 0 && !p.ground && above;
    const on = gloss > 0 && above && (!!p.ground || this.mirrorPlane.mesh.visible);
    this.mirror.uniforms.uMirror.value.set(on ? gloss : 0, 0.004);
    if (!on) {
      if (this.mirror.ready) this.mirror.release();
      return;
    }
    const aspect = cam.aspect || 1;
    this.mirror.render(this.scene, cam, this.floorZ, L_OPAQUE, Math.round(heightPx * aspect), heightPx);
  }

  /**
   * Position the shadow-casting lights for sample i: each at its centre for i = 0, then spread over its area. With
   * casters, the key moves on even samples and the casters take turns on odd ones (lightSteps), so each sample
   * redraws one shadow map: a light put where it already stands keeps its map (prepareShadows). Every light is
   * placed, not only the one whose turn it is: a picture drawn between the view's frames has its own samples, and
   * each of the two would otherwise be lit in part by where the other's last sample left the lights.
   */
  private placeKey(i: number) {
    const at = lightSteps(i, this.casters.length);
    this.placeLight(this.key, this.keyDir, this.preset.key.size, at[0]);
    const sizes = this.preset.casters ?? [];
    this.casters.forEach((l, k) => this.placeLight(l, this.casterDirs[k], sizes[k]?.size ?? 10, at[k + 1]));
  }

  /** Put a light at sample `i` of its disc of angular radius `sizeDeg` (0: its centre). */
  private placeLight(l: THREE.DirectionalLight, dir: THREE.Vector3 | undefined, sizeDeg: number, i: number) {
    if (!dir) return;
    const size = Math.max(this.bounds.getSize(new THREE.Vector3()).length(), 20);
    const c = this.bounds.getCenter(new THREE.Vector3());
    const d = dir.clone();
    if (i > 0) {
      const [x, y] = concentricDisc(halton(i, 5), halton(i, 7));
      const t1 = new THREE.Vector3().crossVectors(d, new THREE.Vector3(0, 0, 1));
      if (t1.lengthSq() < 1e-6) t1.set(1, 0, 0);
      t1.normalize();
      const t2 = new THREE.Vector3().crossVectors(d, t1).normalize();
      const k = Math.tan(THREE.MathUtils.degToRad(sizeDeg));
      d.addScaledVector(t1, x * k).addScaledVector(t2, y * k).normalize();
    }
    l.position.copy(c).addScaledVector(d, size * 2);
    l.target.position.copy(c);
    l.updateMatrixWorld();
    l.target.updateMatrixWorld();
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

  /** In sketch mode the left button belongs to the sketch tools; the others turn and pan the view as the mouse scheme has them. */
  setSketchMode(on: boolean) {
    this.sketching = on;
    this.applyMouse();
  }

  /** How the mouse moves the view (see app/mouse), and which way the wheel zooms. */
  setMouse(scheme: MouseScheme, reverseWheel: boolean) {
    this.mouseScheme = scheme;
    this.wheelSign = reverseWheel ? -1 : 1;
    this.applyMouse();
  }

  private applyMouse() {
    const b = this.sketching ? sketchButtons(this.mouseScheme) : MOUSE_SCHEMES[this.mouseScheme];
    const act = (a: MouseAction) => (a === "rotate" ? THREE.MOUSE.ROTATE : a === "pan" ? THREE.MOUSE.PAN : a === "zoom" ? THREE.MOUSE.DOLLY : (-1 as THREE.MOUSE));
    this.controls.mouseButtons = { LEFT: act(b.left), MIDDLE: act(b.middle), RIGHT: act(b.right) };
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
    prepareRay(this.raycaster.ray, meshes);
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

  /** Slide the camera and its target together (a camera that follows something). */
  panBy(d: [number, number, number]) {
    const v = new THREE.Vector3(...d);
    if (this.camAnim) {
      // mid-swing: move where it is swinging from and to
      this.camAnim.fromTarget.add(v);
      this.camAnim.toTarget.add(v);
      this.changed = true;
      return;
    }
    this.camera.position.add(v);
    this.controls.target.add(v);
    this.controls.update();
    this.changed = true;
  }

  /** Take a mouse wheel's notch to zoom smoothly over the next frames (see animate). */
  private glideWheel(e: WheelEvent) {
    const c = this.controls as OrbitControls & { state?: number; _handleMouseWheel(e: { deltaY: number; clientX: number; clientY: number }): void };
    // a pinch on a trackpad comes as the wheel with Ctrl held: it zooms the way the fingers move, whatever the wheel does
    if (e.target !== this.renderer.domElement || !c.enabled || !c.enableZoom || e.ctrlKey || (c.state !== undefined && c.state !== -1)) return;
    // the same units the controls use: lines and pages as pixels; the other way round if the wheel is reversed
    const px = (e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 100 : e.deltaY) * this.wheelSign;
    if (Math.abs(px) < 40 || this.display.reduceMotion) {
      if (this.wheelSign > 0) return;
      // reversed: hand the controls the step turned round, in place of the one the wheel gave
      e.preventDefault();
      e.stopPropagation();
      c.dispatchEvent({ type: "start" });
      c._handleMouseWheel({ deltaY: px, clientX: e.clientX, clientY: e.clientY });
      c.dispatchEvent({ type: "end" });
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    c.dispatchEvent({ type: "start" });
    // turning the wheel the other way stops what is left of the last notch
    const left = this.zoomGlide && Math.sign(this.zoomGlide.left) === Math.sign(px) ? this.zoomGlide.left : 0;
    this.zoomGlide = { left: left + px, x: e.clientX, y: e.clientY };
    this.changed = true;
  }

  /** Swing the camera to a position and target (at once with reduced motion). Ends a visit to a change, unless it is one. */
  private moveCamera(pos: THREE.Vector3, target: THREE.Vector3, dur: number, visiting = false) {
    this.zoomGlide = null;
    this.growTo = null;
    if (!visiting) this.visit = null;
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

  /**
   * Show these parts with these meshes. While `building`, a part whose new shape has no mesh yet keeps showing its
   * old one, so an edited part stays put until it can show what changed; once the build is over, one still without
   * a mesh (its build failed) goes.
   */
  setParts(parts: EvalPart[], meshes: Map<string, MeshEntry>, opts: { building?: boolean } = {}) {
    this.lastMeshes = meshes;
    const want = new Set<string>();
    const now = performance.now();
    // a part's real threads may have just arrived while the camera is close to it
    if (!this.lodDue) this.lodDue = now + 200;
    const motion = !this.display.reduceMotion;
    // new parts arrive in turn: the made ones first, then what is bought, then the screws that hold them
    const fresh = { make: 0, drop: 0, screw: 0 };
    let edgeSweeps = 0;
    const seen = new THREE.Box3();
    for (const part of parts) {
      const pick = pickMesh(meshes.get(part.hash), this.realThreads(part.id));
      if (!pick) {
        if (opts.building && this.parts.get(part.id)?.removing === false) want.add(part.id);
        continue;
      }
      const { data, quality } = pick;
      want.add(part.id);
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
          else {
            const kind = arrivalKind(part);
            const n = fresh[kind]++;
            const delay = kind === "make" ? Math.min(n * 45, 900) : kind === "drop" ? 220 + Math.min(n * 40, 700) : 480 + Math.min(n * 35, 600);
            this.startReveal(obj, now + delay);
          }
          if (this.followChanges) seen.union(this.worldBox(obj));
        }
      } else if (obj.geoKey !== geoKey) {
        const oldKey = obj.geoKey;
        const ghost = motion && isNewGeometry ? this.spawnGhost(obj, now) : null;
        const oldEdges = ghost ? this.geos.get(oldKey)?.edges.getAttribute("position")?.array : undefined;
        const was = obj.part;
        this.swapGeometry(obj, geoKey, data);
        if (ghost) {
          // which way the change sweeps through it: from its recipe, else from where its edges moved
          let sweep = editSweep(was.recipe, part.recipe, this.localBox(ghost.mesh.geometry), this.localBox(obj.mesh.geometry));
          if (!sweep && oldEdges && edgeSweeps < EDGE_SWEEPS_MAX) {
            edgeSweeps++;
            sweep = edgeSweep(oldEdges, data.edges);
          }
          this.startChange(obj, ghost, oldKey, now, sweep);
          if (this.followChanges) seen.union(this.worldBox(obj));
        } else if (motion && isNewGeometry) this.startDissolveIn(obj, now);
      }
      obj.part = part;
      obj.hash = part.hash;
      obj.placement.fromArray(xformMatrix(part.xf));
      this.decorate(obj);
      this.applyMaterial(obj);
      if (isNewGeometry) this.seenHashByPart.set(part.id, part.hash);
    }
    if (this.decorHiddenDirty) this.syncOverlays();
    for (const [id, obj] of this.parts) {
      if (want.has(id) || obj.removing) continue;
      if (!motion) this.disposePart(obj);
      else {
        obj.removing = true;
        this.endReveal(obj);
        obj.arrive = null;
        obj.change = null;
        obj.u.uChange.value.x = 0;
        obj.dissolve = { t0: now, dur: 420, out: true };
        obj.mesh.castShadow = false;
        if (obj.decor) obj.decor.d.object.visible = false;
      }
    }
    this.computeBounds();
    if (!this.hasFitted && this.parts.size) {
      this.hasFitted = true;
      this.fit("iso", false);
      this.onFirstFrame();
    } else if (this.autoFit && this.parts.size) this.growView();
    else if (!seen.isEmpty()) this.visitChange(seen);
    this.changed = true;
  }

  /** A part's mesh box in its own frame. */
  private localBox(g: THREE.BufferGeometry): { min: [number, number, number]; max: [number, number, number] } {
    g.boundingBox ?? g.computeBoundingBox();
    const b = g.boundingBox!;
    return { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] };
  }

  /** Where a part sits in the assembly, as a box. */
  private worldBox(obj: PartObj): THREE.Box3 {
    obj.mesh.geometry.boundingBox ?? obj.mesh.geometry.computeBoundingBox();
    return obj.mesh.geometry.boundingBox!.clone().applyMatrix4(obj.placement);
  }

  /** Claude is building: changes out of view, or too small to see, are shown and the camera comes back. */
  setFollowChanges(on: boolean) {
    this.followChanges = on;
  }

  /**
   * Go and see a change (a box in the assembly) when it is out of view or too small to see from here: the camera
   * turns to it the way it already looks, stays a moment, and goes back (see animate). Moving the camera stops it
   * (takeCamera).
   */
  private visitChange(box: THREE.Box3) {
    if (this.display.reduceMotion || this.sketching || this.filming) return;
    const now = performance.now();
    if (this.visit) {
      // more while it is there (or on its way back): frame it all, and stay a while longer
      this.visit.box = this.visit.back ? box.clone() : this.visit.box.union(box);
    } else {
      if (this.camAnim || this.growTo || this.zoomGlide) return;
      this.camera.updateMatrixWorld();
      const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const dist = Math.max(1e-6, sphere.center.distanceTo(this.camera.position));
      const share = sphere.radius / (dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
      // in view and big enough to make out: nothing to go and see
      if (share > 0.05 && this.boxInView(box, frustum)) return;
      this.visit = { home: { pos: this.camera.position.clone(), target: this.controls.target.clone() }, box: box.clone(), backAt: 0, back: false };
    }
    const v = this.visit;
    v.back = false;
    v.backAt = now + VISIT_GO_MS + VISIT_STAY_MS;
    const sphere = v.box.getBoundingSphere(new THREE.Sphere());
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const fitDist = (sphere.radius * 1.4) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    // close enough to make it out, but never farther than the view was
    const homeDist = v.home.pos.distanceTo(v.home.target);
    const d = Math.min(homeDist, Math.max(fitDist, homeDist * 0.2, this.camera.near * 4));
    this.moveCamera(sphere.center.clone().addScaledVector(dir, d), sphere.center.clone(), VISIT_GO_MS, true);
  }

  /** Whether every corner of a box is in view. */
  private boxInView(box: THREE.Box3, frustum: THREE.Frustum): boolean {
    const c = new THREE.Vector3();
    for (let k = 0; k < 8; k++) {
      c.set(k & 1 ? box.max.x : box.min.x, k & 2 ? box.max.y : box.min.y, k & 4 ? box.max.z : box.min.z);
      if (!frustum.containsPoint(c)) return false;
    }
    return true;
  }



  /**
   * While a design opens and the camera is still the app's: the first parts are framed as they come, and the camera
   * draws back smoothly as more arrive, so none land out of view before the build finishes (settle() then frames it).
   */
  private growView() {
    if (this.camAnim) return;
    const { pos, target } = this.framing("current", this.camera.aspect);
    const off = this.camera.position.distanceTo(this.controls.target);
    const goal = this.growTo ?? { pos: this.camera.position, target: this.controls.target };
    // not for a nudge
    if (Math.abs(pos.distanceTo(target) - goal.pos.distanceTo(goal.target)) < off * 0.03 && target.distanceTo(goal.target) < off * 0.03) return;
    if (this.display.reduceMotion) {
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.controls.update();
      this.growTo = null;
    } else this.growTo = { pos, target, at: this.growTo?.at ?? performance.now() };
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
      // threads the part shader draws on their stand-in cylinders
      if (data.thread) mesh.setAttribute("aThread", new THREE.BufferAttribute(data.thread, 4));
      mesh.computeBoundingBox();
      mesh.computeBoundingSphere();
      const edges = new THREE.BufferGeometry();
      edges.setAttribute("position", new THREE.BufferAttribute(data.edges, 3));
      g = { mesh, edges, edgeGroups: data.edgeGroups, users: 0 };
      this.geos.set(key, g);
      // the coarse first mesh is soon replaced: only the refined ones get rounded edges
      if (!key.endsWith(":preview")) this.bevels.request(key, data);
    }
    g.users++;
    return g;
  }

  /** A mesh's rounded edges were found: every part showing it gets them. */
  private bevelReady(key: string, bands: BevelBands | null) {
    const g = this.geos.get(key);
    if (!g || this.disposed) return;
    g.bevel = bands ? bevelGeometry(bands) : null;
    for (const obj of this.parts.values()) if (obj.geoKey === key) this.attachBevel(obj);
    this.edgesCame = true;
  }

  /** Give a part its mesh's rounded edges (hidden until they are found, and while the part is see-through). */
  private attachBevel(obj: PartObj) {
    const geo = this.geos.get(obj.geoKey)?.bevel;
    if (!geo) {
      if (obj.bevel) obj.bevel.visible = false;
      return;
    }
    if (!obj.bevel) {
      const m = new THREE.Mesh(geo, obj.mat);
      m.castShadow = false;
      m.receiveShadow = true;
      m.userData.bevel = true;
      // picking and every pass but the colour one see the part's own mesh
      m.raycast = () => {};
      m.layers.set(0);
      obj.bevel = m;
      obj.mesh.add(m);
    } else obj.bevel.geometry = geo;
    obj.bevel.visible = !obj.mat.transparent;
  }

  private release(key: string) {
    const g = this.geos.get(key);
    if (!g) return;
    g.users--;
    if (g.users <= 0) {
      g.mesh.dispose();
      g.edges.dispose();
      g.bevel?.dispose();
      this.bevels.drop(key);
      this.geos.delete(key);
    }
  }

  private lookFor(part: EvalPart): Appearance {
    const o = this.overrides.get(part.id);
    return o ? appearanceFor(o.material, o.finish, o.color) : appearanceFor(part.material, part.finish ?? processFinish(part.material, part.process?.id), part.color);
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
    patchEdgeMaterial(edgeMat, u);
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
    u.uThreads.value = g.mesh.getAttribute("aThread") ? 1 : 0;
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
      arrive: null,
      dissolve: null,
      flash: null,
      change: null,
      pulse: null,
      ripple: null,
      removing: false,
      opacity: 1,
      opacityTarget: 1,
      sig: "",
      decor: null,
      bevel: null,
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
    obj.u.uThreads.value = g.mesh.getAttribute("aThread") ? 1 : 0;
    // refined while it is still drawing itself in
    if (obj.u.uTrace.value.y > 0) this.traceOrderFor(geoKey);
    obj.u.uKBox0.value.copy(g.mesh.boundingBox!.min);
    obj.u.uKBox1.value.copy(g.mesh.boundingBox!.max);
    this.attachBevel(obj);
  }

  /** Real threads for photoreal (the path tracer draws geometry, not the shader's threads), films and close-ups. */
  private realThreads(id: string): boolean {
    return this.photoLookOn || this.filming || this.closeUps.has(id);
  }

  /** Show each part's drawn or real threads as realThreads() now says. True when any part changed. */
  private repickMeshes(only?: Iterable<PartObj>): boolean {
    if (!this.lastMeshes) return false;
    let changed = false;
    for (const obj of only ?? this.parts.values()) {
      if (obj.removing) continue;
      const pick = pickMesh(this.lastMeshes.get(obj.hash), this.realThreads(obj.id));
      if (!pick) continue;
      const key = `${obj.hash}:${pick.quality}`;
      if (key === obj.geoKey) continue;
      this.swapGeometry(obj, key, pick.data);
      changed = true;
    }
    if (changed) this.changed = true;
    return changed;
  }

  /** Once the camera stops: the parts it is close enough to for their threads' ridges to show get the real ones. */
  private updateCloseUps() {
    if (!this.lastMeshes) return;
    const h = this.container.clientHeight || 1;
    const c = new THREE.Vector3();
    const flipped: PartObj[] = [];
    for (const obj of this.parts.values()) {
      const entry = this.lastMeshes.get(obj.hash);
      const was = this.closeUps.has(obj.id);
      const pitch = entry?.final ? threadPitch(entry.display) : 0;
      let close = false;
      if (pitch && !obj.removing && obj.group.visible) {
        c.copy(obj.center).applyMatrix4(obj.group.matrixWorld);
        close = closeEnough(pitch, c.distanceTo(this.camera.position), this.camera.fov, h, was);
      }
      if (close === was) continue;
      if (close) this.closeUps.add(obj.id);
      else this.closeUps.delete(obj.id);
      flipped.push(obj);
    }
    if (flipped.length) this.repickMeshes(flipped);
  }

  /**
   * Dispose of a removed part's material later. three.js deletes a shader program as soon as no material uses it,
   * and the part shader is big: compiling it again can hold up the page for seconds (Direct3D on Windows is the
   * slowest). Keeping the last few materials, unused, keeps the variants they compiled (reveal clipping, x-ray,
   * glass) ready for the next part, rebuild or design.
   */
  private retire(mat: THREE.Material) {
    this.retired.push(mat);
    if (this.retired.length > RETIRED_MAX) this.retired.shift()!.dispose();
  }

  /**
   * A chain shows its solid at the start of the motion and its moving links
   * once the drive turns. True when what is drawn changed.
   */
  /** Degrees the design's drive runs before it turns back, when a part's travel ends (every motion carries the same figure). */
  private driveRange(): number | undefined {
    for (const o of this.parts.values()) if (o.part.motion?.range) return o.part.motion.range;
    return undefined;
  }

  private chainLinks(obj: PartObj): boolean {
    const info = obj.part.chain!;
    let changed = false;
    if (obj.links?.info !== info) {
      if (obj.links) {
        obj.group.remove(obj.links.object);
        obj.links.dispose();
      }
      obj.links = new ChainLinks(info, obj.mat);
      obj.group.add(obj.links.object);
      changed = true;
    }
    const on = Math.abs(this.angle) > 1e-9 && info.linkRate !== 0;
    if (obj.links.object.visible !== on) {
      obj.links.object.visible = on;
      obj.mesh.visible = !on;
      const d = this.display;
      obj.edges.visible = !on && ((d.edges && !this.photoLookOn) || d.selected.has(obj.id) || d.hovered === obj.id);
      changed = true;
    }
    for (const m of obj.links.meshes) m.layers.mask = obj.mesh.layers.mask;
    // a design whose travel ends runs its drive out and back: the chain follows its sprockets
    if (on && obj.links.update(driveAngle(this.angle, this.driveRange()))) changed = true;
    return changed;
  }

  /**
   * A rope shows its solid while everything it runs on is where it is drawn, and a line laid from where they are
   * once any of them has moved (the motion preview, a drag, "let go"). True when what is drawn changed.
   */
  private ropeLines(): boolean {
    let changed = false;
    const d = this.display;
    for (const obj of this.parts.values()) {
      const info = this.ropes?.get(obj.part.id);
      if (!info && !obj.line) continue;
      let line: [number, number, number][] | null = null;
      if (info) {
        // where each thing it runs on has gone from where it is drawn, the exploded view's spread left out
        let moved = false;
        const poses = info.on.map((id) => {
          const o = id ? this.parts.get(id) : undefined;
          if (!o) return null;
          const m = this.ropeM.makeTranslation(-o.explode.pos.x, -o.explode.pos.y, -o.explode.pos.z).multiply(o.group.matrix).multiply(this.ropeI.copy(o.placement).invert());
          const e = m.elements;
          let off = 0;
          for (let k = 0; k < 16; k++) off = Math.max(off, Math.abs(e[k] - (k % 5 === 0 ? 1 : 0)) * (k >= 12 ? 1 : 100));
          if (off < 1e-3) return null;
          moved = true;
          return [...e];
        });
        if (moved) line = ropeLineAt(info.nodes, info.d, info.length, poses);
      }
      const on = !!line;
      if (on && !obj.line) {
        obj.line = new RopeLine(info!.d, obj.mat);
        obj.group.add(obj.line.mesh);
      }
      if (!obj.line) continue;
      if (obj.line.mesh.visible !== on) {
        obj.line.mesh.visible = on;
        obj.mesh.visible = !on;
        obj.edges.visible = !on && ((d.edges && !this.photoLookOn) || d.selected.has(obj.id) || d.hovered === obj.id);
        changed = true;
      }
      if (on) {
        obj.line.mesh.layers.mask = obj.mesh.layers.mask;
        // the line is laid in the design's own frame: the rope's group carries it out with the exploded view only
        const m = this.ropeM.copy(obj.group.matrix).invert().multiply(this.ropeI.makeTranslation(obj.explode.pos.x, obj.explode.pos.y, obj.explode.pos.z));
        if (!m.equals(obj.line.mesh.matrix)) {
          obj.line.mesh.matrix.copy(m);
          obj.line.mesh.matrixWorldNeedsUpdate = true;
          changed = true;
        }
        if (obj.line.update(line!)) changed = true;
      }
      if (!info) {
        obj.group.remove(obj.line.mesh);
        obj.line.dispose();
        obj.line = null;
      }
    }
    return changed;
  }
  private readonly ropeM = new THREE.Matrix4();
  private readonly ropeI = new THREE.Matrix4();

  private disposePart(obj: PartObj) {
    if (obj.links) {
      obj.group.remove(obj.links.object);
      obj.links.dispose();
      obj.links = null;
    }
    if (obj.line) {
      obj.group.remove(obj.line.mesh);
      obj.line.dispose();
      obj.line = null;
    }
    this.undecorate(obj);
    this.root.remove(obj.group);
    this.retire(obj.mat);
    obj.cap$.mat.dispose();
    obj.edgeMat.dispose();
    this.release(obj.geoKey);
    this.parts.delete(obj.id);
  }

  /** Keep the old geometry of a rebuilt part on screen, dissolving away. */
  private spawnGhost(obj: PartObj, now: number): Ghost | null {
    const g = this.geos.get(obj.geoKey);
    if (!g) return null;
    g.users++;
    const { mat, u } = this.newPartMaterial(obj.look);
    u.uNoiseScale.value = obj.u.uNoiseScale.value;
    u.uDetail.value.copy(obj.u.uDetail.value);
    u.uPly.value.copy(obj.u.uPly.value);
    u.uThreads.value = obj.u.uThreads.value;
    u.uMake.value.copy(obj.u.uMake.value);
    u.uKBox0.value.copy(obj.u.uKBox0.value);
    u.uKBox1.value.copy(obj.u.uKBox1.value);
    mat.anisotropy = obj.mat.anisotropy;
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
    const ghost: Ghost = { group, mesh, mat, u, edgeMat, edgeAlpha: edgeMat.opacity, geoKey: obj.geoKey, t0: now, dur: 520, fade: 520, change: false, sweep: false };
    this.ghosts.push(ghost);
    return ghost;
  }

  /**
   * A rebuilt part shows what changed: its new surfaces light up, the surfaces it lost dissolve away, and what stayed
   * where it was stays still. Which is which is told per pixel, from the two meshes' depth (drawChangeDepth).
   */
  private startChange(obj: PartObj, ghost: Ghost, oldKey: string, now: number, sweep: Sweep | null = null) {
    const tol = (meshTolerance(oldKey) + meshTolerance(obj.geoKey)) * 1.3 + 0.02;
    this.endReveal(obj);
    this.endArrival(obj);
    obj.dissolve = null;
    obj.u.uDissolve.value = 0;
    obj.flash = null;
    obj.change = { t0: now, dur: sweep ? SWEEP_MS : CHANGE_MS, sweep, ghost };
    obj.u.uChange.value.set(1, tol, 0, 0);
    obj.u.uFlash.value = 0;
    ghost.change = true;
    ghost.sweep = !!sweep;
    ghost.dur = obj.change.dur;
    ghost.fade = CHANGE_FADE_MS;
    ghost.u.uChange.value.set(2, tol, 0, 0);
    for (const u of [obj.u, ghost.u]) {
      u.uSweep.value.w = 0;
      u.uSweepFront.value.set(0, 0.12);
    }
    if (sweep) this.placeSweep(obj);
  }

  /** The change's sweep where the part is now (world), for its shader and its old shape's. */
  private placeSweep(obj: PartObj) {
    const sw = obj.change?.sweep;
    if (!sw) return;
    const m = obj.group.matrix;
    const o = new THREE.Vector3(...sw.origin).applyMatrix4(m);
    const d = new THREE.Vector3(...sw.dir).transformDirection(m);
    const mode = sw.mode === "out" ? 2 : 1;
    for (const u of [obj.u, obj.change!.ghost.u]) {
      u.uSweep.value.set(o.x, o.y, o.z, mode);
      u.uSweepDir.value.set(d.x, d.y, d.z, sw.range);
    }
  }

  /** Before a sample, while parts show what changed: the depth their shaders test against. */
  private drawChangeDepth() {
    const news: PartObj[] = [];
    for (const o of this.parts.values()) if (o.change) news.push(o);
    const olds = this.ghosts.filter((g) => g.change);
    if (!news.length && !olds.length) return;
    this.changeDepth ??= new ChangeDepth(this.renderer);
    const { width, height } = this.pipe;
    const depth = this.changeDepth.draw(
      this.camera,
      width,
      height,
      olds.filter((g) => g.group.visible).map((g) => g.mesh),
      news.filter((o) => o.group.visible && o.mesh.visible).map((o) => o.mesh),
    );
    const view = (u: PartUniforms, t: THREE.Texture) => {
      u.tChange.value = t;
      u.uChangeView.value.set(1 / width, 1 / height, this.camera.near, this.camera.far);
    };
    for (const o of news) view(o.u, depth.old);
    for (const g of olds) view(g.u, depth.new);
  }

  /**
   * End every effect now: parts arriving, changes sweeping, ripples and pulses (captures and films draw with buffers
   * of their own, and Esc skips them). A part fading out on its way out stays on its way.
   */
  private finishEffects() {
    for (const o of this.parts.values()) {
      if (o.change) {
        o.change = null;
        o.u.uChange.value.x = 0;
        o.u.uFlash.value = 0;
        o.u.uSweep.value.w = 0;
      }
      if (o.ripple) {
        o.ripple = null;
        o.u.uRippleAmt.value.x = 0;
      }
      this.endReveal(o);
      this.endArrival(o);
      if (o.pulse) {
        o.pulse = null;
        o.u.uPulse.value.w = 0;
      }
      if (o.dissolve && !o.removing) {
        o.dissolve = null;
        o.u.uDissolve.value = 0;
      }
      if (o.flash) {
        o.flash = null;
        o.u.uFlash.value = 0;
      }
    }
    for (const g of [...this.ghosts]) this.disposeGhost(g);
  }

  /** Whether any part is still arriving, changing, rippling or pulsing. */
  effectsRunning(): boolean {
    if (this.ghosts.length) return true;
    for (const o of this.parts.values()) if (o.reveal || o.arrive || o.change || o.ripple || o.pulse || o.flash || (o.dissolve && !o.removing)) return true;
    return false;
  }

  /** Skip what is playing (Esc): every effect jumps to its end, and a camera gone to see a change comes back at once. */
  skipEffects(): boolean {
    const any = this.effectsRunning() || !!this.visit;
    if (!any) return false;
    this.finishEffects();
    if (this.visit) {
      const v = this.visit;
      this.visit = null;
      this.camAnim = null;
      this.camera.position.copy(v.home.pos);
      this.controls.target.copy(v.home.target);
      this.controls.update();
    }
    this.changed = true;
    return true;
  }

  /** A check's result lands on these parts: one pulse, red for a new failure, green for one put right. */
  pulseParts(ids: Iterable<string>, kind: "fail" | "fixed") {
    if (this.display.reduceMotion) return;
    const c = kind === "fail" ? new THREE.Color(0xff4d5e).multiplyScalar(1.8) : new THREE.Color(0x3ddc97).multiplyScalar(1.4);
    const now = performance.now();
    let i = 0;
    for (const id of ids) {
      const o = this.parts.get(id);
      if (!o || o.removing) continue;
      o.pulse = { t0: now + Math.min(i++ * 30, 300), dur: PULSE_MS };
      o.u.uPulse.value.set(c.r, c.g, c.b, 0);
    }
    this.changed = true;
  }

  /** A ring of light runs out over the part from the spot clicked. */
  private startRipple(id: string, at: THREE.Vector3) {
    const obj = this.parts.get(id);
    if (!obj || this.display.reduceMotion) return;
    // it runs out to the part's farthest corner
    const box = obj.mesh.geometry.boundingBox;
    if (!box) return;
    const c = new THREE.Vector3();
    let reach = 1;
    for (let k = 0; k < 8; k++) {
      c.set(k & 1 ? box.max.x : box.min.x, k & 2 ? box.max.y : box.min.y, k & 4 ? box.max.z : box.min.z).applyMatrix4(obj.group.matrixWorld);
      reach = Math.max(reach, c.distanceTo(at));
    }
    obj.ripple = { t0: performance.now(), dur: 900, reach };
    obj.u.uRipple.value.set(at.x, at.y, at.z, 0);
    obj.u.uRippleAmt.value.set(0, Math.max(0.5, reach * 0.07));
    this.changed = true;
  }

  private disposeGhost(g: Ghost) {
    this.root.remove(g.group);
    this.retire(g.mat);
    g.edgeMat.dispose();
    this.release(g.geoKey);
    this.ghosts = this.ghosts.filter((x) => x !== g);
  }

  /** A new part arrives: made in place (its outline traces, then it fills the way it is made), dropped in, or screwed in. */
  private startReveal(obj: PartObj, t0: number) {
    const kind = arrivalKind(obj.part);
    if (kind !== "make") return this.startArrival(obj, t0, kind);
    const geo = obj.mesh.geometry;
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    geo.boundingBox ?? geo.computeBoundingBox();
    const bb = geo.boundingBox!;
    const fill = fillAxis(obj.part, geo.index ? { positions: pos.array, indices: geo.index.array } : null, { min: bb.min.toArray(), max: bb.max.toArray() });
    const dir = new THREE.Vector3(...fill.axis);
    if (fill.frame === "part") dir.transformDirection(obj.placement);
    // how far the part reaches along that way: D·(M p) = (Mᵀ D)·p + D·t
    const e = obj.placement.elements;
    const ax = dir.x * e[0] + dir.y * e[1] + dir.z * e[2];
    const ay = dir.x * e[4] + dir.y * e[5] + dir.z * e[6];
    const az = dir.x * e[8] + dir.y * e[9] + dir.z * e[10];
    const a0 = dir.x * e[12] + dir.y * e[13] + dir.z * e[14];
    const P = pos.array;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i + 2 < P.length; i += 3) {
      const v = ax * P[i] + ay * P[i + 1] + az * P[i + 2];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!Number.isFinite(lo)) return;
    lo += a0;
    hi += a0;
    const pad = Math.max(0.5, (hi - lo) * 0.02);
    obj.reveal = { t0, dur: ARRIVE_MS.make, sMin: lo - pad, sMax: hi + pad, dir, plane: new THREE.Plane(dir.clone().negate(), lo - pad) };
    obj.u.uScan.value.set(1, lo - pad, Math.max(0.6, (hi - lo) * 0.06));
    // a printed part's band shows its layers, coarser than they are when they would be too fine to make out
    obj.u.uScanDir.value.set(dir.x, dir.y, dir.z, fill.layer > 0 ? Math.max(fill.layer, (hi - lo) / 36) : 0);
    // the outline draws itself in first
    this.traceOrderFor(obj.geoKey);
    obj.u.uTrace.value.set(-0.01, 1, lo - pad, hi - lo + 2 * pad);
    this.applyMaterial(obj);
  }

  /** A bought part drops into place; a screw spins down its thread. Both fade in as they come. */
  private startArrival(obj: PartObj, t0: number, kind: "drop" | "screw") {
    const box = this.worldBox(obj);
    const f = obj.part.fastener;
    if (kind === "screw" && f) {
      const { travel, turns } = screwTravel(f.length, f.headD);
      obj.arrive = { t0, dur: ARRIVE_MS.screw, kind, travel, axis: new THREE.Vector3(...f.outward).normalize(), pivot: new THREE.Vector3(...f.headTop), turns, landed: false };
    } else {
      const size = box.getSize(new THREE.Vector3()).length();
      obj.arrive = { t0, dur: ARRIVE_MS.drop, kind: "drop", travel: Math.min(120, Math.max(10, size * 0.9)), axis: new THREE.Vector3(0, 0, 1), pivot: new THREE.Vector3(), turns: 0, landed: false };
    }
    obj.dissolve = { t0, dur: kind === "screw" ? 220 : 280, out: false };
    obj.u.uDissolve.value = 1;
    obj.edgeMat.opacity = 0;
  }

  /** The order a mesh's outline draws in, worked out the first time one of its parts arrives. */
  private traceOrderFor(key: string) {
    const g = this.geos.get(key);
    if (!g || g.edges.getAttribute("aOrder")) return;
    const E = g.edges.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (E) g.edges.setAttribute("aOrder", new THREE.BufferAttribute(traceOrder(E.array, g.edgeGroups), 1));
  }

  private endReveal(obj: PartObj) {
    if (!obj.reveal && obj.u.uTrace.value.y === 0) return;
    obj.reveal = null;
    obj.u.uScan.value.x = 0;
    obj.u.uTrace.value.y = 0;
    this.applyMaterial(obj);
  }

  private endArrival(obj: PartObj) {
    if (!obj.arrive) return;
    obj.arrive = null;
    this.applyMaterial(obj);
  }

  private startDissolveIn(obj: PartObj, now: number) {
    this.endReveal(obj);
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
    // plywood's plies run through the sheet's thickness, which its box tells
    const bb = look.detail === Detail.Plywood ? obj.mesh.geometry.boundingBox : null;
    if (bb) obj.u.uPly.value.fromArray(plyLayout(bb.min.toArray(), bb.max.toArray()));
    // the marks of how it was made: a print's seam, a mill's arcs, a lathe's rings, a moulding's parting line
    const [make, makeValue] = makeFor(p.process);
    applyMake(obj.mat, obj.u, look, make, makeValue, obj.mesh.geometry.boundingBox);
    const selected = d.selected.has(obj.id);
    const hovered = d.hovered === obj.id;
    const focusSet = d.focus.size ? d.focus : d.isolate && d.selected.size ? d.selected : null;
    const ghost = (focusSet && !focusSet.has(obj.id)) || (d.xray && !selected);
    obj.opacityTarget = ghost ? (d.xray ? 0.2 : 0.08) : (this.ghosted.get(obj.id) ?? 1);
    if (d.reduceMotion) obj.opacity = obj.opacityTarget;
    const visible = !d.hidden.has(obj.id) && !p.hidden && !this.replaced.has(obj.id);
    obj.group.visible = visible;
    // the outline of a part being made shows whatever the edges setting is: it draws the part in
    obj.edges.visible = ((d.edges && !this.photoLookOn) || selected || hovered || obj.u.uTrace.value.y > 0) && !obj.links?.object.visible && !obj.line?.mesh.visible;
    obj.mesh.layers.set(0);
    if (visible && obj.opacityTarget >= 1 && !obj.removing) {
      // a part still arriving leaves no contact shadow where it hasn't got to yet
      if (!obj.reveal && !obj.arrive) obj.mesh.layers.enable(L_OPAQUE);
      if (selected) obj.mesh.layers.enable(L_SEL);
      if (hovered && !selected) obj.mesh.layers.enable(L_HOVER);
    }
    if (obj.decor) for (const m of obj.decor.meshes) m.layers.mask = obj.mesh.layers.mask;
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
    obj.mesh.castShadow = !transparent && !obj.removing && !obj.arrive;
    // a see-through part's bands would show as lines over its faces
    if (obj.bevel) obj.bevel.visible = !transparent && !!this.geos.get(obj.geoKey)?.bevel;
    if (obj.decor) {
      for (const mat of obj.decor.mats) {
        const t = transparent || !!mat.userData.decal;
        if (mat.transparent !== t) {
          mat.transparent = t;
          mat.needsUpdate = true;
        }
        mat.opacity = o;
        mat.depthWrite = !t;
      }
      for (const m of obj.decor.meshes) m.castShadow = !transparent && !obj.removing && m.userData.shadow !== false;
    }
    obj.edgeMat.opacity = this.preset.edge.alpha * (transparent ? Math.min(1, o * 1.4) : 1);
  }

  private updateClipping(obj: PartObj) {
    const planes: THREE.Plane[] = [];
    if (this.sectionAnim.on) planes.push(this.sectionPlane);
    if (obj.reveal) planes.push(obj.reveal.plane);
    // the shadow of a part filling in fills in with it
    const clipShadows = !!obj.reveal;
    const changed = (obj.mat.clippingPlanes?.length ?? 0) !== planes.length || obj.mat.clipShadows !== clipShadows;
    obj.mat.clippingPlanes = planes.length ? planes : null;
    obj.mat.clipShadows = clipShadows;
    // the outline shows above the fill: only the section cuts it
    const edgePlanes = this.sectionAnim.on ? [this.sectionPlane] : null;
    const edgesChanged = (obj.edgeMat.clippingPlanes?.length ?? 0) !== (edgePlanes?.length ?? 0);
    obj.edgeMat.clippingPlanes = edgePlanes;
    if (obj.decor) for (const mat of obj.decor.mats) mat.clippingPlanes = planes.length ? planes : null;
    obj.cap$.mat.clippingPlanes = planes.length ? planes : null;
    obj.cap.visible = (this.sectionAnim.on || !!obj.reveal) && obj.opacity >= 0.999;
    obj.cap$.uGlowAmt.value = obj.reveal ? 1 : 0;
    obj.cap$.mat.color.set(obj.look.color).multiplyScalar(0.85);
    if (changed) {
      obj.mat.needsUpdate = true;
      obj.cap$.mat.needsUpdate = true;
    }
    if (changed || edgesChanged) obj.edgeMat.needsUpdate = true;
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

  /** An overlay changed which parts it replaces or fades. */
  overlaysChanged() {
    this.syncOverlays();
  }

  // ---------- machine pose ----------

  private pose: Map<string, [number, number, number] | THREE.Matrix4> | null = null;

  /**
   * Move parts from where the design shows them, e.g. a printer's axes through their travel, or a part carried on one
   * that bends under load (an offset, or a motion in world space; null: as designed).
   */
  setPose(offsets: Map<string, [number, number, number] | THREE.Matrix4> | null) {
    if (!offsets && !this.pose) return;
    this.pose = offsets;
    this.changed = true;
  }

  private fallen: Map<string, THREE.Matrix4> | null = null;

  /**
   * Where "let go" has taken parts from where they are drawn (a motion in world space, by part id; null: as
   * designed). Kept apart from setPose, so a drag or an overlay that poses the machine does not put them back.
   */
  setLetGo(poses: Map<string, THREE.Matrix4> | null) {
    if (!poses && !this.fallen) return;
    this.fallen = poses;
    this.changed = true;
  }

  // ---------- fastenings ----------

  private carried: Map<string, { motion: Motion }> | null = null;
  private loose: Map<string, { axis: [number, number, number]; play: number }> | null = null;

  /** Motions carried through fastenings (a screw and its nut turn with the part they hold) and loose fasteners that rattle; null for none. */
  setHolds(h: { carried: Map<string, { motion: Motion }>; loose: Map<string, { axis: [number, number, number]; play: number }> } | null) {
    if (!h && !this.carried && !this.loose) return;
    this.carried = h?.carried ?? null;
    this.loose = h?.loose?.size ? h.loose : null;
    this.changed = true;
  }

  private ropes: Map<string, RopeDraw> | null = null;
  /** ropes were drawn as lines last frame: one more pass puts their solids back when the ropes go */
  private hasRopeLines = false;

  /** The design's ropes, by the id of the part each is drawn as, so they can be drawn moving with what they run on; null for none. */
  setRopes(r: Map<string, RopeDraw> | null) {
    if (!r?.size && !this.ropes) return;
    this.ropes = r?.size ? r : null;
    this.changed = true;
  }

  // ---------- decorations ----------

  /** Draw extra detail with the parts the decorator knows (null for none). */
  setDecorator(d: Decorator | null) {
    this.decorator = d;
    this.redecorate();
  }

  /** Ask the decorator again for every part, after what it draws from has changed. */
  redecorate() {
    for (const obj of this.parts.values()) if (!obj.removing) this.decorate(obj);
    this.syncOverlays();
    this.changed = true;
  }

  private decorate(obj: PartObj) {
    const surface: PartSurface = { key: obj.geoKey, geometry: obj.mesh.geometry };
    const key = this.decorator?.key(obj.part, surface) ?? null;
    if ((obj.decor?.key ?? null) === key) return;
    if (key === null) return this.undecorate(obj);
    // not ready yet: keep showing the one it has until the new one is
    const d = this.decorator!.make(obj.part, surface);
    if (!d) return;
    this.undecorate(obj);
    const meshes: THREE.Mesh[] = [];
    const mats = new Set<THREE.Material>();
    d.object.traverse((o) => {
      if (!(o as THREE.Mesh).isMesh) return;
      const m = o as THREE.Mesh;
      m.userData.partId = obj.id;
      meshes.push(m);
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        mat.userData.decal ??= mat.transparent;
        mats.add(mat);
      }
    });
    obj.group.add(d.object);
    obj.decor = { d, key, meshes, mats: [...mats] };
    for (const id of d.hides ?? []) this.decorHidden.add(id);
    this.decorHiddenDirty ||= !!d.hides?.length;
  }

  private undecorate(obj: PartObj) {
    const dc = obj.decor;
    if (!dc) return;
    obj.group.remove(dc.d.object);
    dc.d.dispose();
    obj.decor = null;
    if (dc.d.hides?.length) {
      this.decorHidden = new Set([...this.parts.values()].flatMap((p) => [...(p.decor?.d.hides ?? [])]));
      this.decorHiddenDirty = true;
    }
    this.changed = true;
  }

  private syncOverlays() {
    this.decorHiddenDirty = false;
    this.replaced = new Set([...[...this.overlays].flatMap((o) => [...o.replaces]), ...this.decorHidden]);
    this.ghosted = new Map([...this.overlays].flatMap((o) => [...(o.ghosts ?? [])]));
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
  private overlayDepth(cam: THREE.PerspectiveCamera = this.camera) {
    const r = this.renderer;
    // the view's own depth, kept from its first sample: no pass over every part each frame an analysis shows
    if (cam === this.camera && this.pipe.writeViewDepth(r.getRenderTarget(), cam)) return;
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
    const plan = f > 0 || this.explodeShown > 0 ? this.explodePlan() : null;
    if (big) this.frameExploded(f, plan);
    if (big && !this.display.reduceMotion && plan?.stages) {
      // switched on or off: play the steps in turn (fasteners first going out, last coming back)
      this.explodeTween = { from: this.explodeShown, to: f, t0: performance.now(), dur: 1000 * Math.min(2.4, 0.5 + 0.22 * plan.stages) * Math.abs(f - this.explodeShown) };
    } else {
      this.explodeTween = null;
      this.explodeShown = f;
      if (big && !this.display.reduceMotion) this.staggerExplode(f > 0);
    }
    this.changed = true;
  }

  /** the camera backed off to show an exploded view; it comes back in when the view closes */
  private explodeFitted = false;

  /** Back the camera off when the parts would come apart off screen, and in again when they go back together. */
  private frameExploded(f: number, plan: ExplodePlan | null) {
    if (f <= 0) {
      if (this.explodeFitted) this.fit("current", true);
      this.explodeFitted = false;
      return;
    }
    if (!plan) return;
    const at = explodeOffsets(plan, f);
    const box = new THREE.Box3();
    const b = new THREE.Box3();
    for (const [id, o] of this.parts) {
      if (o.removing || this.display.hidden.has(id)) continue;
      b.setFromObject(o.group).translate(o.explode.pos.clone().negate());
      const v = at.get(o.part.id);
      if (v) b.translate(new THREE.Vector3(v[0], v[1], v[2]));
      box.union(b);
    }
    if (box.isEmpty()) return;
    this.camera.updateMatrixWorld();
    const p = new THREE.Vector3();
    let off = false;
    for (let i = 0; i < 8 && !off; i++) {
      p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(this.camera);
      off = p.z > 1 || Math.abs(p.x) > 0.96 || Math.abs(p.y) > 0.9;
    }
    if (!off) return;
    this.fit("current", true, box.union(this.bounds));
    this.explodeFitted = true;
  }

  /** How to work out the exploded view of what is shown; called when it is first needed after each change. */
  setExplodePlanner(fn: (() => ExplodePlan | null) | null) {
    this.explodePlanner = fn;
    this.planStale = true;
    if (this.explodeAmt > 0 || this.assembly) this.changed = true;
  }

  /** The exploded view's plan, worked out now if the design changed since. */
  explodePlan(): ExplodePlan | null {
    if (this.planStale) {
      this.planStale = false;
      try {
        this.plan = this.explodePlanner?.() ?? null;
      } catch (e) {
        console.warn("exploded view plan failed", e);
        this.plan = null;
      }
    }
    return this.plan;
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
    const here = [...this.parts.values()].filter((o) => !o.removing);
    if (!here.length) return;
    // in the order it goes together: each part after what it sits on, its screws once both sides are on
    const plan = this.explodePlan();
    const ids = new Set(here.map((o) => o.id));
    const planned = plan ? plan.order.filter((id) => ids.has(id)) : [];
    const order = [...planned, ...here.map((o) => o.id).filter((id) => !planned.includes(id))];
    const now = performance.now();
    for (const o of this.parts.values()) o.explode.hold = 0;
    this.explodeTween = null;
    this.explodeShown = this.explodeAmt;
    this.assembly = { t0: now + 450, order, at: new Map(order.map((id, i) => [id, i])) };
    this.changed = true;
  }

  setMotion(playing: boolean, speed: number) {
    this.playing = playing;
    this.speed = speed;
    this.changed = true;
  }

  /** The mechanism's driver angle (degrees) the view shows. */
  get motionAngle() {
    return this.angle;
  }

  /** Show the mechanism at a driver angle (degrees): a part the mechanism moves, dragged by hand. */
  setMotionAngle(deg: number) {
    if (!Number.isFinite(deg) || deg === this.angle) return;
    this.angle = deg;
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
    this.floorZ = zFloor;
    this.groundLit.layout(center, zFloor - Math.max(0.01, r * 0.0002), r * 1.6, r * 5);
    this.mirrorPlane.mesh.scale.set(r * 8, r * 8, 1);
    this.mirrorPlane.mesh.position.set(center.x, center.y, zFloor + 0.005);
    this.mirrorPlane.fade.value.set(center.x, center.y, r * 0.4, r * 2.2);
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
    for (const l of this.casters) {
      const cc = l.shadow.camera as THREE.OrthographicCamera;
      cc.left = sc.left;
      cc.right = sc.right;
      cc.top = sc.top;
      cc.bottom = sc.bottom;
      cc.near = sc.near;
      cc.far = sc.far;
      cc.updateProjectionMatrix();
      l.shadow.normalBias = this.key.shadow.normalBias;
    }
    this.placeKey(0);
    this.pipe.look.aoRadius = THREE.MathUtils.clamp(r * 0.06, 0.8, 60);
    // contact shadow: surfaces up to a third of the model's size above the floor darken it, the closest the most
    const reach = r * 0.3;
    this.contact.layout(center, zFloor, Math.max(size.x, size.y) * 0.5 + reach * 1.2, reach, new THREE.Vector2(size.x * 0.5, size.y * 0.5));
    this.shadowStamp++;
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

  /**
   * Depth of field on the selection while the view is still: the parts nearer and farther soften a little as the
   * image refines, which reads as the camera pulling focus. The lens is sized so the selection itself stays sharp
   * (its far side blurs by under a pixel). None in draft quality, under the photoreal view, or when turned off.
   */
  private focusLens(): { radius: number; focus: number } | null {
    if (this.render$.focusBlur === false || this.render$.quality === "draft" || this.photoLookOn) return null;
    const sel = this.display.selected;
    if (!sel.size) return null;
    const box = new THREE.Box3();
    for (const id of sel) {
      const o = this.parts.get(id);
      if (o && !o.removing && o.group.visible) box.expandByObject(o.mesh);
    }
    if (box.isEmpty()) return null;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const ahead = this.camera.getWorldDirection(new THREE.Vector3());
    const focus = sphere.center.clone().sub(this.camera.position).dot(ahead);
    if (focus <= this.camera.near * 4) return null;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const d = Math.max(sphere.radius, 1e-3);
    const sharp = (0.75 * 2 * focus * tanHalf * (focus + d)) / (d * Math.max(1, this.pipe.height));
    const radius = Math.min(focus * 0.007, sharp);
    return radius > focus * 1e-4 ? { radius, focus } : null;
  }

  /** Called when a build completes: frames the whole model once, unless the user already moved the camera. */
  settle() {
    if (!this.autoFit || !this.parts.size) return;
    this.autoFit = false;
    this.fit("iso", true);
  }

  /**
   * The section that best shows the inside at a spot on a face: through the spot, across the axis the view looks
   * along most (other than the face's own, which would only skim the surface), cutting away the side nearest the camera.
   */
  sectionThrough(point: [number, number, number], normal: [number, number, number]): { axis: "x" | "y" | "z"; t: number; flip: boolean } {
    const view = this.camera.position.clone().sub(this.controls.target);
    const own = [0, 1, 2].reduce((a, b) => (Math.abs(normal[b]) > Math.abs(normal[a]) ? b : a), 0);
    const ax = [0, 1, 2].filter((k) => k !== own).reduce((a, b) => (Math.abs(view.getComponent(b)) > Math.abs(view.getComponent(a)) ? b : a));
    const lo = this.bounds.min.getComponent(ax);
    const hi = this.bounds.max.getComponent(ax);
    // as placeSection() maps t to a position
    const pad = (hi - lo) * 0.002 + 0.01;
    const t = THREE.MathUtils.clamp((point[ax] - lo + pad) / (hi - lo + 2 * pad), 0, 1);
    return { axis: (["x", "y", "z"] as const)[ax], t, flip: this.camera.position.getComponent(ax) < point[ax] };
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

  fit(p: ViewPreset | "current" = "current", animate = true, box?: THREE.Box3, dir?: THREE.Vector3) {
    this.growTo = null;
    const { pos, target } = this.framing(p, this.camera.aspect, box, dir);
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

  /** The user has taken the camera: stop any move towards a view, the first framing and the turntable. */
  takeCamera() {
    this.camAnim = null;
    this.growTo = null;
    this.visit = null;
    this.autoFit = false;
    if (this.turntable) {
      this.turntable = false;
      this.controls.autoRotate = false;
      this.onTurntableStop();
    }
  }

  /** Look at the model from a direction (an edge or corner of the view cube), framing it. */
  lookFrom(dir: [number, number, number]) {
    const d = new THREE.Vector3(...dir);
    if (d.lengthSq() < 1e-12) return;
    d.normalize();
    // straight down or up: lean a hair towards the front so up stays defined, as the top and bottom views do
    if (Math.abs(d.z) > 0.99999) d.set(0, -0.0001, Math.sign(d.z)).normalize();
    this.fit("current", true, undefined, d);
  }

  /** Turn the camera round its target as dragging the view cube does: across turns about Z, up and down tips it over the top. */
  orbitBy(dx: number, dy: number) {
    this.takeCamera();
    const t = this.controls.target;
    const off = this.camera.position.clone().sub(t);
    const r = off.length();
    if (r < 1e-9) return;
    const theta = Math.atan2(off.y, off.x) - dx * ORBIT_PER_PX;
    const phi = THREE.MathUtils.clamp(Math.acos(THREE.MathUtils.clamp(off.z / r, -1, 1)) - dy * ORBIT_PER_PX, 1e-4, Math.PI - 1e-4);
    this.camera.position.set(t.x + r * Math.sin(phi) * Math.cos(theta), t.y + r * Math.sin(phi) * Math.sin(theta), t.z + r * Math.cos(phi));
    this.camera.lookAt(t);
    this.controls.update();
    this.changed = true;
  }

  // ---------- picking ----------

  private pick(e: MouseEvent): string | null {
    return this.rayHit(e.clientX, e.clientY)?.object.userData.partId ?? null;
  }

  private rayHit(clientX: number, clientY: number, ghosts = false): THREE.Intersection | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    // parts drawn by an overlay (analysis results) are hidden but still pickable; see-through parts only when asked
    const pickable = (p: PartObj) => p.group.visible || (this.replaced.has(p.id) && !this.display.hidden.has(p.id) && !p.part.hidden);
    const meshes = [...this.parts.values()].filter((p) => pickable(p) && !p.removing && (ghosts || p.opacityTarget > 0.5)).map((p) => p.mesh);
    prepareRay(this.raycaster.ray, meshes);
    const hits = this.raycaster.intersectObjects(meshes, false);
    for (const h of hits) {
      if (this.sectionAnim.on && this.sectionPlane.distanceToPoint(h.point) < 0) continue;
      if (h.object.userData.partId) return h;
    }
    return null;
  }

  /** The nearest overlay hit in front of a part hit `before` mm along the ray, if any. */
  private overlayHit(clientX: number, clientY: number, before = Infinity): { o: SceneOverlay; hit: OverlayHit } | null {
    let best: { o: SceneOverlay; hit: OverlayHit } | null = null;
    for (const o of this.overlays) {
      if (!o.hitTest || !o.object.visible) continue;
      const hit = o.hitTest(this.raycasterAt(clientX, clientY));
      if (hit && hit.distance < before && (!best || hit.distance < best.hit.distance)) best = { o, hit };
    }
    return best;
  }

  /** The part and spot under a screen position. With ghosts, parts shown see-through (x-ray, sketching) count too. */
  hitAt(clientX: number, clientY: number, opts: { ghosts?: boolean } = {}): Hit | null {
    const h = this.rayHit(clientX, clientY, opts.ghosts);
    const obj = h && this.parts.get(h.object.userData.partId as string);
    if (!h || !obj) return null;
    const local = h.point.clone().applyMatrix4(h.object.matrixWorld.clone().invert());
    const n = (h.face?.normal ?? new THREE.Vector3(0, 0, 1)).clone();
    const localNormal = tuple(n);
    return { id: obj.id, local: tuple(local), point: tuple(local.clone().applyMatrix4(obj.placement)), normal: tuple(n.transformDirection(obj.placement)), localNormal };
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

    // a wheel notch, a fraction each frame, towards the pointer: zoom is
    // multiplicative, so the pieces add up to exactly the notch's zoom
    if (this.zoomGlide && !this.camAnim) {
      const g = this.zoomGlide;
      const part = Math.abs(g.left) < 3 ? g.left : g.left * Math.min(1, dt * 16);
      g.left -= part;
      (this.controls as unknown as { _handleMouseWheel(e: { deltaY: number; clientX: number; clientY: number }): void })._handleMouseWheel({ deltaY: part, clientX: g.x, clientY: g.y });
      if (Math.abs(g.left) < 0.01) this.zoomGlide = null;
      moving = true;
    } else this.zoomGlide = null;

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
    } else if (this.growTo) {
      const g = this.growTo;
      // by the time passed, not the capped frame step: a design still building can hold frames up for a while
      const k = rm ? 1 : 1 - Math.exp(-Math.min(1, (now - g.at) / 1000) * 3.2);
      g.at = now;
      this.camera.position.lerp(g.pos, k);
      this.controls.target.lerp(g.target, k);
      this.controls.update();
      if (this.camera.position.distanceTo(g.pos) < 1e-3 * g.pos.distanceTo(g.target)) this.growTo = null;
      moving = true;
    }

    // a visit to a change: back where the camera was once it has stayed a moment
    if (this.visit && !this.camAnim) {
      const v = this.visit;
      if (v.back) this.visit = null;
      else if (now >= v.backAt) {
        v.back = true;
        this.moveCamera(v.home.pos, v.home.target, VISIT_BACK_MS, true);
        moving = true;
      }
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
    // exploded view: where each part sits along the plan, carried by what it comes off
    const tw = this.explodeTween;
    if (tw) {
      const k = (now - tw.t0) / Math.max(1, tw.dur);
      this.explodeShown = k >= 1 ? tw.to : tw.from + (tw.to - tw.from) * k;
      if (k >= 1) this.explodeTween = null;
      moving = true;
    }
    const shown = this.explodeShown;
    const plan = shown > 0 || asm ? this.explodePlan() : null;
    const asmStep = asm ? Math.min(160, 2600 / Math.max(1, asm.order.length)) : 0;
    const homeAt = (id: string) => asm!.t0 + Math.max(0, asm!.at.get(id) ?? 0) * asmStep;
    const planned = plan ? (asm ? explodeOffsets(plan, shown, (m) => (now < homeAt(m.id) ? 1 : stepProgress(m.stage, plan.stages, shown))) : explodeOffsets(plan, shown)) : null;
    for (const obj of [...this.parts.values()]) {
      // a part made in place: its outline traces, then it fills the way it is made
      if (obj.reveal) {
        const r = obj.reveal;
        const k = (now - r.t0) / r.dur;
        if (k >= 1) this.endReveal(obj);
        else {
          obj.u.uTrace.value.x = k <= 0 ? -0.01 : traceAt(k) * 1.02;
          const at = r.sMin + (r.sMax - r.sMin) * fillAt(k);
          r.plane.constant = at;
          obj.u.uScan.value.y = at;
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
          // its outline comes and goes with it
          obj.edgeMat.opacity = this.preset.edge.alpha * (1 - obj.u.uDissolve.value);
        }
        if (!obj.dissolve) this.applyOpacity(obj);
        moving = true;
      }
      if (obj.flash) {
        const k = (now - obj.flash.t0) / obj.flash.dur;
        obj.u.uFlash.value = k < 0 ? 0 : k >= 1 ? 0 : Math.sin(Math.PI * Math.min(1, k * 1.6)) * (1 - k);
        if (k >= 1) obj.flash = null;
        moving = true;
      }
      // new surfaces glow at once and cool off; a sweeping change brings them in behind its front
      if (obj.change) {
        const c = obj.change;
        const k = (now - c.t0) / c.dur;
        if (k >= 1) {
          obj.change = null;
          obj.u.uChange.value.x = 0;
          obj.u.uFlash.value = 0;
          obj.u.uSweep.value.w = 0;
        } else if (c.sweep) {
          const f = easeInOut(Math.min(1, (now - c.t0) / SWEEP_FRONT_MS));
          const front = f * (1 + obj.u.uSweepFront.value.y);
          obj.u.uSweepFront.value.x = front;
          c.ghost.u.uSweepFront.value.x = front;
          obj.u.uFlash.value = Math.min(1, k * 6) * Math.pow(1 - k, 1.4) * 0.85;
          this.placeSweep(obj);
        } else obj.u.uFlash.value = Math.min(1, k * 8) * (1 - k) * (1 - k);
        moving = true;
      }
      // a check's result lands: one pulse, quick up and slow down
      if (obj.pulse) {
        const k = (now - obj.pulse.t0) / obj.pulse.dur;
        if (k >= 1) {
          obj.pulse = null;
          obj.u.uPulse.value.w = 0;
        } else obj.u.uPulse.value.w = k < 0 ? 0 : k < 0.16 ? Math.sin((Math.PI / 2) * (k / 0.16)) : Math.pow((1 - k) / 0.84, 2.2);
        moving = true;
      }
      if (obj.ripple) {
        const k = (now - obj.ripple.t0) / obj.ripple.dur;
        if (k >= 1) {
          obj.ripple = null;
          obj.u.uRippleAmt.value.x = 0;
        } else {
          obj.u.uRipple.value.w = obj.ripple.reach * (1 - (1 - k) ** 2);
          obj.u.uRippleAmt.value.x = 1.6 * Math.min(1, k * 10) * (1 - k) ** 1.5;
        }
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
      let amount = shown;
      if (asm) {
        const home = homeAt(obj.id);
        amount = now < home ? Math.max(shown, 0.6) : shown;
        if (now < home) assemblyDone = false;
      }
      const target = new THREE.Vector3();
      const at = planned?.get(obj.part.id);
      if (at) target.set(at[0], at[1], at[2]);
      else if (amount > 0) {
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

      // motion about the part's axis, after the machine's pose
      const po = this.pose?.get(obj.part.id);
      const m = po instanceof THREE.Matrix4 ? new THREE.Matrix4().makeTranslation(sp.pos.x, sp.pos.y, sp.pos.z).multiply(po) : new THREE.Matrix4().makeTranslation(sp.pos.x + (po?.[0] ?? 0), sp.pos.y + (po?.[1] ?? 0), sp.pos.z + (po?.[2] ?? 0));
      // its own motion or the one it is fastened to (a screw turns with the part it holds), riding on its carrier
      const mo = turns(obj.part.motion) ? obj.part.motion : this.carried?.get(obj.part.id)?.motion;
      // let go, gravity has it: where the run put it, not where the drive would
      const fell = this.fallen?.get(obj.part.id);
      if (fell) m.multiply(fell);
      else if (mo && Math.abs(this.angle) > 1e-9 && turns(mo)) m.multiply(new THREE.Matrix4().fromArray(motionPose(mo, this.angle)));
      // a loose screw, nut or washer rattles along its axis as the parts move
      const lo = this.loose?.get(obj.part.id);
      if (lo && Math.abs(this.angle) > 1e-9) {
        const k = (lo.play / 2) * Math.sin(THREE.MathUtils.degToRad(this.angle * 8));
        m.multiply(new THREE.Matrix4().makeTranslation(lo.axis[0] * k, lo.axis[1] * k, lo.axis[2] * k));
      }
      // dropping in, or spinning down its thread
      if (obj.arrive) {
        const a = obj.arrive;
        const k = (now - a.t0) / a.dur;
        if (k >= 1) {
          obj.arrive = null;
          this.applyMaterial(obj);
        } else if (a.kind === "drop") {
          m.multiply(new THREE.Matrix4().makeTranslation(0, 0, a.travel * dropHeight(k)));
          // it lands with a little light
          if (!a.landed && k >= DROP_LAND) {
            a.landed = true;
            obj.flash = { t0: now, dur: 520 };
          }
        } else {
          const left = screwLeft(k);
          const d = a.axis.clone().multiplyScalar(a.travel * left);
          m.multiply(new THREE.Matrix4().makeTranslation(d.x + a.pivot.x, d.y + a.pivot.y, d.z + a.pivot.z));
          m.multiply(new THREE.Matrix4().makeRotationAxis(a.axis, a.turns * Math.PI * 2 * left));
          m.multiply(new THREE.Matrix4().makeTranslation(-a.pivot.x, -a.pivot.y, -a.pivot.z));
          if (!a.landed && k >= 0.86) {
            a.landed = true;
            obj.flash = { t0: now, dur: 420 };
          }
        }
        moving = true;
      }
      m.multiply(obj.placement);
      if (obj.part.chain && this.chainLinks(obj)) moving = true;
      if (!m.equals(obj.group.matrix)) {
        obj.group.matrix.copy(m);
        obj.group.matrixWorldNeedsUpdate = true;
        moving = true;
      }
    }
    if (asm && assemblyDone) this.assembly = null;
    if ((this.ropes || this.hasRopeLines) && this.ropeLines()) moving = true;
    this.hasRopeLines = !!this.ropes;

    for (const g of [...this.ghosts]) {
      const age = now - g.t0;
      if (age >= g.dur) this.disposeGhost(g);
      else {
        const f = Math.min(1, age / g.fade);
        // a swept change takes the old shape away with its front, not by dissolving
        g.u.uDissolve.value = g.sweep ? 0 : easeInOut(f);
        g.edgeMat.opacity = g.edgeAlpha * (1 - f);
        // gone, but still drawn into the depth the new mesh tests against
        if (f >= 1) g.mesh.castShadow = false;
      }
      moving = true;
    }
    return moving;
  }

  private frame() {
    // the film maker has the renderer: it draws its own frames
    if (this.filming) return;
    const now = performance.now();
    const frameMs = now - this.last;
    const dt = Math.min(0.05, frameMs / 1000);
    this.last = now;
    const controlsMoved = this.controls.update();
    const animating = this.animate(now, dt);
    const moving = animating || controlsMoved;
    // anything but the camera changed the scene: the contact shadow and the key light's shadow map are drawn again
    if (this.changed || animating) {
      this.contact.dirty = true;
      this.shadowStamp++;
    }
    // Rounded edges found since the last frame: the view's picture starts again with them. They cast no shadow, so
    // the shadows stay as drawn, and so does a picture being drawn between frames (the edges of a large assembly
    // arrive a mesh at a time for seconds, and it would start again at each).
    if (this.edgesCame) {
      this.edgesCame = false;
      this.changed = true;
    }
    if (import.meta.env.DEV && (moving || this.changed)) this.debugReason = `${moving ? "moving " : ""}${controlsMoved ? "controls " : ""}${this.changed ? "changed" : ""}`;
    if (moving) this.changed = true;
    this.camera.updateMatrixWorld();
    if (!this.orient.equals(this.camera.quaternion)) {
      this.orient.copy(this.camera.quaternion);
      this.onOrient(this.orient);
    }
    // the photoreal look hides CAD edges and the grid, but only while it can run
    const look = this.render$.photoreal && !this.photoBlocked();
    if (look !== this.photoLookOn) {
      this.photoLookOn = look;
      for (const o of this.parts.values()) this.applyMaterial(o);
      this.grid.visible = this.display.grid && !look;
      this.changed = true;
      this.repickMeshes();
    }
    if (this.pipe.cameraMoved(this.camera)) {
      if (import.meta.env.DEV) this.debugReason += " camera";
      this.changed = true;
      this.lodDue = now + 200;
    }
    if (this.lodDue && now >= this.lodDue) {
      this.lodDue = 0;
      this.updateCloseUps();
    }
    // a light set that waited for the card goes in place once the card is done; before the first there is nothing to show
    if (this.lightingDue?.()) this.applyLighting(false);
    if (!this.lit) {
      this.shadersHeld ??= now;
      if (!this.shadersTold && now - this.shadersHeld > SHADERS_TOLD_AFTER) this.onShaders((this.shadersTold = true));
      return;
    }
    // What is new in the scene is built by the graphics card before it is drawn, and the picture stays as it is
    // until the card has finished: a draw with a shader it is still building stops the whole page until it is built,
    // which is seconds for the parts' shader with Direct3D (see ShaderGate).
    if ((this.changed || this.needComposite || this.shadersHeld !== null) && !this.shadersBuilt(now)) return;
    // and a draw the card turns out not to be ready for is left out of the frame: such a frame is not shown
    let whole = this.drawWatched(now, frameMs, dt);
    // When the card had the shader for what was left out all along (a new part, drawn with shaders other parts are
    // drawn with), there is nothing to wait for: the frame is drawn again here, whole, instead of the picture
    // missing a turn. While a design is built, a part arrives at most frames.
    if (!whole && this.pipe.ready(this.scene, this.camera, this.overlay)) {
      this.changed = true;
      this.contact.dirty = true;
      this.shadowStamp++;
      whole = this.drawWatched(now, frameMs, 0);
    }
    if (!whole) this.shadersHeld ??= now;
    // the view has had its turn: a picture waiting to be drawn between frames gets a sample
    if (this.shots.length) this.stepShots(now);
  }

  /** Draws a frame of the live view with every draw the card is not ready for left out. False when any was: the frame was not shown. */
  private drawWatched(now: number, frameMs: number, dt: number): boolean {
    let partial = true;
    this.pipe.frameBegins();
    try {
      this.draw(now, frameMs, dt);
    } finally {
      partial = this.pipe.frameDrawn();
    }
    return !partial;
  }

  /** Draw what is due of the live view: the next sample of the image, the selection's mask, the picture on screen. */
  private draw(now: number, frameMs: number, dt: number) {
    let restarted = false;
    if (this.changed) {
      this.changed = false;
      this.pipe.reset();
      this.maskDirty = true;
      restarted = true;
    }
    // the selection in focus: worked out for each new view and each new selection; a change starts the image again
    if (restarted || this.display.selected !== this.lensSel) {
      this.lensSel = this.display.selected;
      const lens = this.focusLens();
      if (!sameLens(lens, this.lens)) {
        this.lens = lens;
        this.pipe.reset();
      }
    }
    if (this.photo && !this.render$.photoreal && now - this.photoOffAt > PHOTO_KEEP && !this.photo.busy) this.dropPhoto();
    let photo = this.photoActive();
    // while the model builds, the trace waits for its final meshes instead of restarting on each
    const held = !!photo && this.settlingSince !== null && now - this.settlingSince < PHOTO_SETTLE_MAX;
    if (photo && !held && (restarted || !photo.samples || this.photoHeld)) {
      const parts = this.photoParts();
      photo.sync(parts, this.photoStage(parts), now);
    }
    this.photoHeld = held;
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
    // Every sample makes the picture finer. With a picture on screen, the next one waits a moment while work done a
    // piece at a time is waiting for the page's turn (the checks after an edit): each sample drawn then holds that
    // work up for as long as a frame takes, which on a large design is most of the time. Never for long: the
    // picture gets a sample a few times a second whatever is waiting.
    const later = this.pipe.samples >= 1 && workWaiting() && now - this.sampledAt < SAMPLE_WAIT_MS;
    if (this.pipe.samples < rasterMax && !later) {
      this.sampledAt = now;
      this.pipe.lens = this.lens;
      this.pipe.renderSample(this.scene, this.camera, (i) => {
        this.beforeSample(i);
        this.drawChangeDepth();
      });
      this.pipe.lens = null;
      this.needComposite = true;
      rastered = true;
    }
    // after the sample: a new view's first sample keeps the depth the mask tests against
    if (this.maskDirty) {
      this.renderMask();
      this.maskDirty = false;
      this.needComposite = true;
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
    // a frame with a draw left out (its shader is not built yet) is not a picture to show: it is drawn again, whole.
    // What showing it draws with is gone through undrawn, so the card builds that too meanwhile.
    if (this.pipe.framePartial) {
      this.pipe.frameUnshown(() => this.present(now));
      return;
    }
    this.needComposite = false;
    if (photo && this.photoMix > 0) this.pipe.photo(photo.texture, { mix: this.photoMix, samples: photo.samples, near: this.camera.near, far: this.camera.far });
    else this.pipe.photo(null);
    this.present(now);
    for (const fn of this.renderListeners) fn();
  }

  /**
   * Whether the next frame is drawn. While the card is building shaders the frame needs, it is not (but for one
   * frame that goes through to meet what else needs building, and is not shown): the picture stays as it is, and
   * after a moment the page is told, so it can say what the view is waiting for.
   */
  private shadersBuilt(now: number): boolean {
    if (this.pipe.ready(this.scene, this.camera, this.overlay)) {
      if (this.shadersHeld !== null) {
        this.shadersHeld = null;
        // what moved while the picture was held is drawn now, and what a frame with draws left out got wrong
        // (shadows without all that casts them) is drawn again
        this.changed = true;
        this.contact.dirty = true;
        this.shadowStamp++;
        if (this.shadersTold) this.onShaders((this.shadersTold = false));
      }
      return true;
    }
    this.shadersHeld ??= now;
    if (!this.shadersTold && now - this.shadersHeld > SHADERS_TOLD_AFTER) this.onShaders((this.shadersTold = true));
    return this.pipe.scoutFrame();
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

  /** The quality setting's photoreal quality, raised to an export's floor while one runs. */
  private photoQuality(): PhotoQuality {
    const q = PHOTO_QUALITY[this.render$.quality](this.renderer.getPixelRatio());
    const f = this.photoFloor;
    return f ? { maxSamples: Math.max(q.maxSamples, f.maxSamples), scale: Math.max(q.scale, f.scale), bounces: Math.max(q.bounces, f.bounces) } : q;
  }

  /** What the photoreal view is doing now. */
  get photoStatus(): PhotoStatus {
    return this.photoNow;
  }

  /** Why the photoreal view couldn't run now, or null when it could. */
  photoBlocker(): string | null {
    return this.photoBlocked();
  }

  /** An export needs at least this quality until it ends (null); the image starts again at the new quality. */
  setPhotoFloor(q: PhotoQuality | null) {
    this.photoFloor = q;
    if (!this.photo) return;
    this.photo.quality = this.photoQuality();
    this.photo.restart(performance.now());
  }

  /** The finished photoreal image on screen, without the selection outline, as a PNG data URL; null until it has converged and fully shows. */
  photoSnapshot(): string | null {
    const photo = this.photo;
    if (!photo || !photo.done || this.photoMix < 0.999) return null;
    const r = this.renderer;
    this.pipe.photo(photo.texture, { mix: this.photoMix, samples: photo.samples, near: this.camera.near, far: this.camera.far });
    this.pipe.composite(null, { time: performance.now() / 1000 });
    r.setRenderTarget(null);
    if (this.overlays.size) {
      this.overlayDepth();
      r.render(this.overlay, this.camera);
    }
    // read back in the same task, before the browser clears the canvas; the next frame puts the outline back
    const url = r.domElement.toDataURL("image/png");
    this.needComposite = true;
    return url;
  }

  /** Photoreal is off: free the image buffers, and keep the path tracer ready for a while (see PHOTO_KEEP). */
  private parkPhoto() {
    this.photoMix = 0;
    this.photoOffAt = performance.now();
    this.photo?.releaseImage();
    this.pipe.releasePhoto();
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
          this.photo.quality = this.photoQuality();
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
      o.decor?.meshes.forEach((m, i) => {
        if (!m.visible) return;
        const mat = Array.isArray(m.material) ? m.material[0] : m.material;
        out.push({ id: `${o.id}~${i}`, geoKey: m.geometry.uuid, geometry: m.geometry, matrix: m.matrixWorld, look: o.look, material: mat });
      });
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
    this.photoNow = s;
    const key = `${s.state}|${s.reason ?? ""}`;
    // state changes go out at once; sample counts at most a few times a second
    if (key === this.photoStatusKey && (now - this.photoStatusAt < 250 || s.state !== "rendering")) return;
    this.photoStatusKey = key;
    this.photoStatusAt = now;
    this.onPhotoStatus(s);
  }

  /** Composite the accumulated image to the canvas, then the overlays. */
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
      if (this.pipe.hasViewDepth(cam)) {
        // the selected and hovered parts alone, each fragment tested against the depth this view's first sample kept
        const u = this.keptMaskU;
        u.tViewDepth.value = this.pipe.viewDepthRT.texture;
        u.uRes.value.set(this.pipe.width, this.pipe.height);
        this.scene.overrideMaterial = this.keptMaskMat;
        u.uHover.value = 0;
        cam.layers.set(L_SEL);
        r.render(this.scene, cam);
        u.uHover.value = 1;
        cam.layers.set(L_HOVER);
        r.render(this.scene, cam);
      } else {
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
      }
      this.scene.overrideMaterial = null;
      r.shadowMap.autoUpdate = saveShadow;
    }
    cam.layers.mask = prevMask;
    r.clippingPlanes = prevClip;
    r.setRenderTarget(null);
  }

  // ---------- capture ----------

  /** Render a finished, converged image of the model at any size, without touching the on-screen view. */
  async capture(opts: { view: ViewPreset | "current"; width: number; height: number; focus?: string[]; frame?: "model" | "focus"; section?: "x" | "y" | "z"; mime?: string; quality?: number; samples?: number; box?: [[number, number, number], [number, number, number]]; dir?: [number, number, number]; overlays?: boolean; explode?: number; only?: string[] }): Promise<string> {
    await this.whenLit();
    // parts still arriving or showing a change get a moment to finish, so the capture doesn't cut them short
    for (let t = 0; t < 1200 && this.effectsRunning() && !this.disposed; t += 50) await new Promise((r) => setTimeout(r, 50));
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
    // what is still arriving or changing ends first
    this.finishEffects();
    // an exploded capture: every part where the plan puts it at that amount, framed to fit
    const unexploded = opts.explode !== undefined ? this.poseExploded(opts.explode) : null;
    const px = new Uint8Array(opts.width * opts.height * 4);
    // the image is read back after the view is put back as it was: the page is not held while the card draws it
    let read: Promise<void>;
    try {
      this.camera.aspect = opts.width / opts.height;
      let box: THREE.Box3 | undefined = opts.box ? new THREE.Box3(new THREE.Vector3(...opts.box[0]), new THREE.Vector3(...opts.box[1])) : undefined;
      // only some parts drawn (a group on its own): the rest hidden, those framed
      if (opts.only?.length) {
        const only = new Set(opts.only);
        this.setDisplay({ ...this.display, hidden: new Set([...this.display.hidden, ...[...this.parts.keys()].filter((id) => !only.has(id))]) });
        if (!box && !(opts.frame === "focus" && opts.focus?.length)) {
          box = new THREE.Box3();
          for (const id of only) {
            const p = this.parts.get(id);
            if (p && !p.removing) box.expandByObject(p.group);
          }
          if (box.isEmpty()) box = undefined;
        }
      }
      if (!box && unexploded && !(opts.frame === "focus" && opts.focus?.length)) {
        box = new THREE.Box3();
        for (const [id, p] of this.parts) if (!p.removing && !this.display.hidden.has(id)) box.expandByObject(p.group);
        if (box.isEmpty()) box = undefined;
      }
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
      for (let i = 0; i < n; i++) pipe.renderSample(this.scene, this.camera, (k) => this.beforeSample(k, true, this.camera, pipe.height));
      pipe.composite(out, { time: 0 });
      this.renderer.setRenderTarget(out);
      if (showOverlays) this.overlayDepth();
      this.renderer.render(this.overlay, this.camera);
      read = readPixelsLater(this.renderer, opts.width, opts.height, px);
    } finally {
      pipe.dispose();
      out.dispose();
      if (unexploded) for (const [o, pos] of unexploded) o.explode.pos.copy(pos);
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
    await read;
    return toDataUrl(px, opts.width, opts.height, opts.mime ?? "image/png", opts.quality ?? 0.9);
  }

  /**
   * A picture of the plain model that the page is not held for: what capture() draws for the same view, size, box
   * and direction with { overlays: false }. capture() draws all its samples in one go, which for a large assembly
   * is half a second or more in which nothing else moves, and the view starts its own picture again after. This
   * draws one sample a frame, after the view's own, from a camera of its own; the view and its camera are left as
   * they are. The view goes first: for `patience` ms the picture waits until the view has finished its own and
   * nothing in it moves, and after that it is drawn alongside (a view being turned stays live, at a lower frame
   * rate for as long as the picture takes). When anything but the camera changes on the way, it starts again from
   * the scene as it then is (rounded edges arriving do not count: they cast no shadow and it carries on), and when
   * that has gone on for two seconds (a mechanism playing) it is drawn at once of the scene as it is. Several are
   * drawn in the order they were asked for, one that has begun before the next, and one with the `key` of another
   * still waiting takes its place. Null when its place was taken, it is no longer `wanted`, or the view went.
   * Where it cannot be drawn this way (the photoreal look is on, or results are drawn in place of parts), it is
   * drawn at once as capture() does.
   */
  async captureBetweenFrames(opts: { view: ViewPreset | "current"; width: number; height: number; box?: [[number, number, number], [number, number, number]]; dir?: [number, number, number]; mime?: string; quality?: number; samples?: number; key?: string; wanted?: () => boolean; patience?: number }): Promise<string | null> {
    await this.whenLit();
    if (this.disposed || this.contextLost) return null;
    if (opts.wanted && !opts.wanted()) return null;
    if (opts.key !== undefined) for (const t of this.shots.filter((t) => t.key === opts.key)) t.done(null);
    return new Promise((resolve) => {
      const t: Shot = {
        view: opts.view,
        width: opts.width,
        height: opts.height,
        box: opts.box && new THREE.Box3(new THREE.Vector3(...opts.box[0]), new THREE.Vector3(...opts.box[1])),
        dir: opts.dir && new THREE.Vector3(...opts.dir),
        samples: opts.samples ?? Math.max(16, Math.min(96, this.pipe.maxSamples)),
        mime: opts.mime ?? "image/png",
        quality: opts.quality ?? 0.9,
        key: opts.key,
        wanted: opts.wanted,
        patience: opts.patience ?? SHOT_PATIENCE_MS,
        asked: performance.now(),
        begun: 0,
        cam: null,
        stamp: -1,
        done: (url) => {
          const i = this.shots.indexOf(t);
          if (i >= 0) this.shots.splice(i, 1);
          resolve(url);
        },
      };
      this.shots.push(t);
      // a film has the renderer and no frames are drawn; the picture is drawn at once, as before
      if (this.filming) this.shotAtOnce(t);
    });
  }

  /** Whether anything drawn over the parts stands in for some of them: a picture of the plain model then needs them put back, which capture() does. */
  private overlaysReplace(): boolean {
    for (const o of this.overlays) if (o.replaces.size) return true;
    return false;
  }

  /** A picture that cannot be drawn between frames, drawn in one go as capture() does. */
  private shotAtOnce(t: Shot) {
    const i = this.shots.indexOf(t);
    if (i >= 0) this.shots.splice(i, 1);
    const box = t.box && ([t.box.min.toArray(), t.box.max.toArray()] as [[number, number, number], [number, number, number]]);
    this.capture({ view: t.view, width: t.width, height: t.height, box, dir: t.dir?.toArray(), mime: t.mime, quality: t.quality, samples: t.samples, overlays: false }).then(t.done, () => t.done(null));
  }

  /** One sample of a picture being drawn between frames: of the first in line whose turn it is. After its last, the picture is read back. */
  private stepShots(now: number) {
    for (const t of [...this.shots]) if (t.wanted && !t.wanted()) t.done(null);
    if (!this.shots.length) return;
    // none can be drawn this way now: each is drawn in one go, as it used to be
    if (this.photoLookOn || this.overlaysReplace()) {
      for (const t of [...this.shots]) this.shotAtOnce(t);
      return;
    }
    // nothing is drawn while the card builds what the view needs
    if (this.shadersHeld !== null) return;
    // The view first: its own picture finished, nothing moving or arriving. Each picture gives it so long
    // (shotTurn).
    const moving = this.effectsRunning();
    const busy = moving || this.changed || this.pipe.samples < this.pipe.maxSamples;
    const turn = shotTurn(this.shots, busy, now, this.shadowStamp);
    if (!turn) return;
    const t = turn.shot;
    if (moving) {
      // as capture() does: what is still arriving or changing ends, and the picture starts from the scene after
      this.finishEffects();
      this.changed = true;
      return;
    }
    // and work waiting for the page's turn goes first too, as it does before the view's own samples
    if (workWaiting() && now - this.shotAt < SAMPLE_WAIT_MS) return;
    this.shotAt = now;
    const r = this.renderer;
    const pipe = (this.shotPipe ??= new RenderPipeline(r));
    // the scene keeps changing under it (a mechanism playing): in one go of the scene as it is now, as it used to be
    if (turn.atOnce) {
      this.shotAtOnce(t);
      return;
    }
    t.begun ||= now;
    if (!t.cam || t.stamp !== this.shadowStamp) {
      // the first sample, or the scene changed since the last one: from the start, framed on the model as it is now
      t.stamp = this.shadowStamp;
      t.cam = this.cameraFor(t.view, t.width / t.height, t.box, t.dir);
      pipe.setSize(t.width, t.height, 1);
      Object.assign(pipe.look, this.pipe.look);
      pipe.reset();
      // (they share the one set of buffers: another that had begun begins again when its turn comes)
      for (const o of this.shots) if (o !== t) o.cam = null;
    }
    const cam = t.cam;
    try {
      pipe.renderSample(this.scene, cam, (k) => this.beforeSample(k, false, cam, pipe.height));
      if (pipe.samples < t.samples) return;
      const px = new Uint8Array(t.width * t.height * 4);
      const out = new THREE.WebGLRenderTarget(t.width, t.height, { type: THREE.UnsignedByteType, depthBuffer: false });
      out.texture.colorSpace = THREE.SRGBColorSpace;
      try {
        pipe.composite(out, { time: 0 });
        r.setRenderTarget(out);
        // the view's own marks, without what is drawn over the parts (cables, results)
        const over = [...this.overlays].filter((o) => o.object.visible);
        for (const o of over) o.object.visible = false;
        try {
          r.render(this.overlay, cam);
        } finally {
          for (const o of over) o.object.visible = true;
        }
        // read back in the card's own time; the next in line is drawn meanwhile
        this.shots.splice(this.shots.indexOf(t), 1);
        readPixelsLater(r, t.width, t.height, px).then(
          () => t.done(toDataUrl(px, t.width, t.height, t.mime, t.quality)),
          () => t.done(null),
        );
      } finally {
        out.dispose();
      }
      // the bevels' width, the floor's mirror and the lights are the view's own again
      r.setRenderTarget(null);
      this.beforeSample(0);
    } catch {
      t.done(null);
    } finally {
      r.setRenderTarget(null);
    }
  }

  /** A camera of its own that frames `box` (the whole model when none) as capture() frames it for that view. The view's camera is left as it was. */
  private cameraFor(view: ViewPreset | "current", aspect: number, box?: THREE.Box3, dir?: THREE.Vector3): THREE.PerspectiveCamera {
    const live = this.camera;
    const was = { pos: live.position.clone(), quat: live.quaternion.clone(), aspect: live.aspect };
    try {
      live.aspect = aspect;
      const { pos, target } = this.framing(view, aspect, box, dir);
      live.position.copy(this.tighten(pos, target, box ?? this.bounds));
      live.lookAt(target);
      live.updateProjectionMatrix();
      live.updateMatrixWorld();
      return live.clone(false);
    } finally {
      live.position.copy(was.pos);
      live.quaternion.copy(was.quat);
      live.aspect = was.aspect;
      live.updateProjectionMatrix();
      live.updateMatrixWorld();
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

  /** Put every part where the exploded view has it at amount f, for a capture; returns where they were. */
  private poseExploded(f: number): Map<PartObj, THREE.Vector3> {
    const was = new Map<PartObj, THREE.Vector3>();
    const plan = f > 0 ? this.explodePlan() : null;
    const at = plan ? explodeOffsets(plan, f) : null;
    const bc = this.bounds.getCenter(new THREE.Vector3());
    const size = this.bounds.getSize(new THREE.Vector3()).length();
    for (const o of this.parts.values()) {
      was.set(o, o.explode.pos.clone());
      const v = at?.get(o.part.id);
      if (v) o.explode.pos.set(v[0], v[1], v[2]);
      else if (f > 0) {
        const c = o.center.clone().applyMatrix4(o.placement);
        const d = c.clone().sub(bc);
        if (d.lengthSq() < 1e-6) d.set(0, 0, 1);
        o.explode.pos.copy(d.normalize().multiplyScalar(f * size * 0.45 * (0.4 + c.distanceTo(bc) / (size || 1))));
      } else o.explode.pos.set(0, 0, 0);
    }
    this.frameMatricesOnly();
    return was;
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

  // ---------- films ----------

  private filming = false;

  /**
   * Hand the renderer to the film maker (src/film/render.ts). The interactive
   * view stops drawing until end(); each picture is drawn from the film's own
   * camera at the film's size, in the photoreal look (no CAD edges or grid),
   * with the design posed as the shot asks: exploded, assembling, turning,
   * cut or focused. Everything is put back as it was by end().
   */
  beginFilm(opts: { width: number; height: number; look?: string; fine?: boolean }): FilmView {
    if (this.filming) throw new Error("A film is already being made");
    this.filming = true;
    // a light set still waiting for the card goes in place now
    if (this.lightingDue) this.applyLighting(false);
    // films show the real threads
    this.repickMeshes();
    const saved = {
      photoLookOn: this.photoLookOn,
      grid: this.grid.visible,
      render: this.render$,
      section: { ...this.section },
      sectionAnim: { ...this.sectionAnim },
      display: this.display,
      angle: this.angle,
      springs: new Map([...this.parts.values()].map((o) => [o, { pos: o.explode.pos.clone(), vel: o.explode.vel.clone() }])),
      shadowSize: this.key.shadow.mapSize.x,
      inter: this.interGroup.visible,
      measure: this.measure.group.visible,
      frameOpacity: (this.sectionFrame.material as THREE.LineBasicMaterial).opacity,
      fillOpacity: (this.sectionFill.material as THREE.MeshBasicMaterial).opacity,
    };
    // finish what was animating: a part still arriving, or fading
    this.finishEffects();
    this.interGroup.visible = false;
    this.measure.group.visible = false;
    // a film's look is the lighting set as it is, whatever the app's theme
    const look = opts.look ?? this.render$.lighting;
    if (look !== this.render$.lighting || this.render$.theme === "light") {
      this.render$ = { ...this.render$, lighting: look, theme: "dark" };
      this.applyLighting(false);
    }
    this.photoLookOn = true;
    this.display = { ...this.display, selected: new Set(), hovered: null, focus: new Set(), isolate: false, xray: false };
    for (const o of this.parts.values()) this.applyMaterial(o);
    this.grid.visible = false;
    // sharper shadows for a film rendered clean (the preview and drafts keep the view's own)
    if (opts.fine && this.key.shadow.mapSize.x < 4096) {
      this.key.shadow.mapSize.setScalar(4096);
      this.key.shadow.map?.dispose();
      this.key.shadow.map = null;
    }

    const cam = new THREE.PerspectiveCamera(32, opts.width / opts.height, 1, 1000);
    cam.up.set(0, 0, 1);
    const pipe = new RenderPipeline(this.renderer);
    Object.assign(pipe.look, this.pipe.look);
    pipe.maxSamples = 4096;
    let out: THREE.WebGLRenderTarget | null = null;
    let width = 0;
    let height = 0;
    let px = new Uint8Array(0);
    const resize = (w: number, h: number) => {
      if (w === width && h === height) return;
      width = w;
      height = h;
      pipe.setSize(w, h, 1);
      out?.dispose();
      out = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: true });
      out.texture.colorSpace = THREE.SRGBColorSpace;
      px = new Uint8Array(w * h * 4);
    };
    resize(opts.width, opts.height);

    const plan = this.explodePlan();
    const orderIdx = new Map((plan?.order ?? []).map((id, i) => [id, i]));
    const bc = this.bounds.getCenter(new THREE.Vector3());
    const size = this.bounds.getSize(new THREE.Vector3()).length();
    const radius = Math.max(size / 2, 10);
    // the shadow's box covers the design exploded too
    const lay = (() => {
      const parts = new Map<string, [[number, number, number], [number, number, number]]>();
      const exploded = new Map<string, [number, number, number]>();
      const at = plan ? explodeOffsets(plan, 1) : null;
      const ebox = new THREE.Box3();
      for (const [id, o] of this.parts) {
        if (o.removing || !o.group.visible) continue;
        const g = o.mesh.geometry;
        if (!g.boundingBox) g.computeBoundingBox();
        const b = g.boundingBox!.clone().applyMatrix4(o.placement);
        parts.set(id, [b.min.toArray() as [number, number, number], b.max.toArray() as [number, number, number]]);
        const v = at?.get(o.part.id);
        const c = b.getCenter(new THREE.Vector3());
        if (v) {
          exploded.set(id, [c.x + v[0], c.y + v[1], c.z + v[2]]);
          ebox.union(b.clone().translate(new THREE.Vector3(v[0], v[1], v[2])));
        } else ebox.union(b);
      }
      return { parts, exploded, ebox: at && exploded.size ? ebox : null };
    })();
    {
      const sc = this.key.shadow.camera as THREE.OrthographicCamera;
      const all = this.bounds.clone();
      if (lay.ebox) all.union(lay.ebox);
      const ext = Math.max(all.getSize(new THREE.Vector3()).length(), 20) * 0.85;
      sc.left = -ext;
      sc.right = ext;
      sc.top = ext;
      sc.bottom = -ext;
      sc.far = Math.max(ext * 5, sc.far);
      sc.updateProjectionMatrix();
    }

    let focusKey = "";
    let overlaysOn = true;
    let clock0 = performance.now();
    let lastTick = -1;
    const ghost = 0.14;
    const T = new THREE.Matrix4();
    const pose = (s: FilmShot) => {
      // camera
      cam.position.set(...s.camera.pos);
      cam.lookAt(new THREE.Vector3(...s.camera.target));
      cam.fov = s.camera.fov;
      cam.aspect = width / height;
      const dist = cam.position.distanceTo(new THREE.Vector3(...s.camera.target));
      cam.near = Math.max(0.05, Math.min(dist * 0.05, Math.max(0.5, dist - radius * 3)));
      cam.far = dist + radius * 40;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
      // where each part is: exploded or on its way home, turned by its motion
      let offsets: Map<string, [number, number, number]> | null = null;
      if (plan && s.build !== null) {
        const n = Math.max(1, plan.order.length);
        offsets = explodeOffsets(plan, 1, (m) => 1 - buildShare(orderIdx.get(m.id) ?? n - 1, n, s.build!));
      } else if (plan && s.explode > 0) offsets = explodeOffsets(plan, s.explode);
      this.angle = s.angle;
      for (const o of this.parts.values()) {
        const v = offsets?.get(o.part.id);
        const p = o.explode.pos;
        if (v) p.set(v[0], v[1], v[2]);
        else if (!plan && (s.explode > 0 || (s.build !== null && s.build < 1))) {
          const f = s.build !== null ? 1 - s.build : s.explode;
          const c = o.center.clone().applyMatrix4(o.placement);
          const d = c.clone().sub(bc);
          if (d.lengthSq() < 1e-6) d.set(0, 0, 1);
          p.copy(d.normalize().multiplyScalar(f * size * 0.45 * (0.4 + c.distanceTo(bc) / (size || 1))));
        } else p.set(0, 0, 0);
        const po = this.pose?.get(o.part.id);
        const m = po instanceof THREE.Matrix4 ? new THREE.Matrix4().makeTranslation(p.x, p.y, p.z).multiply(po) : new THREE.Matrix4().makeTranslation(p.x + (po?.[0] ?? 0), p.y + (po?.[1] ?? 0), p.z + (po?.[2] ?? 0));
        const mo = turns(o.part.motion) ? o.part.motion : this.carried?.get(o.part.id)?.motion;
        const fell = this.fallen?.get(o.part.id);
        if (fell) m.multiply(fell);
        else if (mo && Math.abs(s.angle) > 1e-9 && turns(mo)) m.multiply(T.fromArray(motionPose(mo, s.angle)));
        const lo = this.loose?.get(o.part.id);
        if (lo && Math.abs(s.angle) > 1e-9) {
          const k = (lo.play / 2) * Math.sin(THREE.MathUtils.degToRad(s.angle * 8));
          m.multiply(T.makeTranslation(lo.axis[0] * k, lo.axis[1] * k, lo.axis[2] * k));
        }
        m.multiply(o.placement);
        if (o.part.chain) this.chainLinks(o);
        o.group.matrix.copy(m);
        o.group.matrixWorldNeedsUpdate = true;
      }
      if (this.ropes) this.ropeLines();
      // the section plane
      if (s.section) {
        const was = this.sectionAnim.on;
        this.section = { on: true, axis: s.section.axis, t: s.section.t, flip: s.section.flip };
        this.sectionAnim = { t: s.section.t, on: true, fade: 1 };
        this.placeSection();
        if (!was) {
          for (const o of this.parts.values()) this.updateClipping(o);
          this.clipOverlays();
        }
        (this.sectionFrame.material as THREE.LineBasicMaterial).opacity = 0.5;
        (this.sectionFill.material as THREE.MeshBasicMaterial).opacity = 0.03;
      } else if (this.sectionAnim.on) {
        this.section = { ...this.section, on: false };
        this.sectionAnim = { ...this.sectionAnim, on: false, fade: 0 };
        for (const o of this.parts.values()) this.updateClipping(o);
        this.clipOverlays();
        (this.sectionFrame.material as THREE.LineBasicMaterial).opacity = 0;
        (this.sectionFill.material as THREE.MeshBasicMaterial).opacity = 0;
      }
    };
    const showOverlays = (on: boolean) => {
      if (on === overlaysOn || !this.overlays.size) {
        overlaysOn = on;
        return;
      }
      overlaysOn = on;
      for (const o of this.overlays) o.object.visible = on;
      if (on) this.syncOverlays();
      else {
        this.replaced = new Set(this.decorHidden);
        this.ghosted = new Map();
        for (const o of this.parts.values()) this.applyMaterial(o);
      }
      focusKey = "\u0000";
    };
    const focus = (ids: string[] | null) => {
      const key = ids?.join("|") ?? "";
      if (key === focusKey) return;
      focusKey = key;
      this.display = { ...this.display, focus: new Set(ids ?? []) };
      const keep = ids ? new Set(ids) : null;
      for (const o of this.parts.values()) {
        this.applyMaterial(o);
        if (keep && !keep.has(o.id)) o.opacityTarget = ghost;
        o.opacity = o.opacityTarget;
        this.applyOpacity(o);
        this.updateClipping(o);
      }
    };
    const lerp3 = (a: [number, number, number], b: [number, number, number], k: number): [number, number, number] => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
    const mix = (a: FilmShot, b: FilmShot, k: number): FilmShot => ({
      ...a,
      camera: { pos: lerp3(a.camera.pos, b.camera.pos, k), target: lerp3(a.camera.target, b.camera.target, k), fov: a.camera.fov + (b.camera.fov - a.camera.fov) * k },
      explode: a.explode + (b.explode - a.explode) * k,
      build: a.build !== null && b.build !== null ? a.build + (b.build - a.build) * k : a.build,
      angle: a.angle + (b.angle - a.angle) * k,
      section: a.section && b.section && a.section.axis === b.section.axis ? { ...a.section, t: a.section.t + (b.section.t - a.section.t) * k } : a.section,
    });

    const view: FilmView = {
      get width() {
        return width;
      },
      get height() {
        return height;
      },
      layout: (): FilmLayout => {
        const b = this.bounds;
        let simBox: FilmLayout["simBox"] = null;
        for (const o of this.overlays) {
          const fb = (o as unknown as { frameBox?: (whole?: boolean) => THREE.Box3 }).frameBox?.(true);
          if (fb && !fb.isEmpty()) simBox = [fb.min.toArray() as [number, number, number], fb.max.toArray() as [number, number, number]];
        }
        return {
          box: [b.min.toArray() as [number, number, number], b.max.toArray() as [number, number, number]],
          parts: lay.parts,
          exploded: lay.exploded,
          explodedBox: lay.ebox ? [lay.ebox.min.toArray() as [number, number, number], lay.ebox.max.toArray() as [number, number, number]] : null,
          order: plan?.order ?? [],
          simBox,
        };
      },
      render: (shot, samples, to) => {
        if (!this.filming || !out) throw new Error("The film has ended");
        showOverlays(shot.overlays);
        focus(shot.focus);
        // the overlays' own animations, on the film's clock
        const now = clock0 + shot.clock * 1000;
        const dt = lastTick < 0 ? 0 : Math.min(0.1, Math.max(0, (now - lastTick) / 1000));
        lastTick = now;
        if (shot.overlays) for (const o of this.overlays) o.tick?.(now, dt);
        pipe.reset();
        const n = Math.max(1, Math.round(samples));
        for (let i = 0; i < n; i++) {
          // with a shutter, each sample is a moment a little later: what moves smears
          pose(to ? mix(shot, to, n > 1 ? i / (n - 1) : 0) : shot);
          pipe.renderSample(this.scene, cam, (k) => this.beforeSample(k, i === 0, cam, pipe.height));
        }
        if (to) pose(shot);
        pipe.composite(out, { time: shot.clock });
        this.renderer.setRenderTarget(out);
        if (shot.overlays && this.overlays.size) {
          this.overlayDepth(cam);
          this.renderer.render(this.overlay, cam);
        }
        this.renderer.readRenderTargetPixels(out, 0, 0, width, height, px);
        this.renderer.setRenderTarget(null);
        // rows come bottom first
        const img = new ImageData(width, height);
        const row = width * 4;
        for (let y = 0; y < height; y++) img.data.set(px.subarray((height - 1 - y) * row, (height - y) * row), y * row);
        return img;
      },
      resize,
      simTime: (t) => {
        for (const o of this.overlays) (o as unknown as { setTime?: (t: number) => void }).setTime?.(t);
      },
      restartOverlays: () => {
        clock0 = performance.now();
        lastTick = -1;
      },
      end: () => {
        if (!this.filming) return;
        pipe.dispose();
        out?.dispose();
        out = null;
        this.renderer.setRenderTarget(null);
        if (!overlaysOn) {
          for (const o of this.overlays) o.object.visible = true;
        }
        this.interGroup.visible = saved.inter;
        this.measure.group.visible = saved.measure;
        for (const [o, sp] of saved.springs) {
          o.explode.pos.copy(sp.pos);
          o.explode.vel.copy(sp.vel);
        }
        this.angle = saved.angle;
        this.section = saved.section;
        this.sectionAnim = saved.sectionAnim;
        (this.sectionFrame.material as THREE.LineBasicMaterial).opacity = saved.frameOpacity;
        (this.sectionFill.material as THREE.MeshBasicMaterial).opacity = saved.fillOpacity;
        this.placeSection();
        if (this.key.shadow.mapSize.x !== saved.shadowSize) {
          this.key.shadow.mapSize.setScalar(saved.shadowSize);
          this.key.shadow.map?.dispose();
          this.key.shadow.map = null;
        }
        if (this.render$.lighting !== saved.render.lighting || this.render$.theme !== saved.render.theme) {
          this.render$ = { ...this.render$, lighting: saved.render.lighting, theme: saved.render.theme };
          this.applyLighting(false);
        }
        this.photoLookOn = saved.photoLookOn;
        this.filming = false;
        this.repickMeshes();
        this.layoutStage();
        this.syncOverlays();
        this.setDisplay(saved.display);
        for (const o of this.parts.values()) {
          o.opacity = o.opacityTarget;
          this.applyOpacity(o);
          this.updateClipping(o);
        }
        this.clipOverlays();
        this.grid.visible = saved.grid;
        this.changed = true;
        this.needComposite = true;
      },
    };
    return view;
  }

  // ---------- material swatches ----------

  /** The material ball's scene, built on first use and kept like its pipeline and materials. */
  private stageSwatch() {
    if (this.swatchStage) return this.swatchStage;
    const scene = new THREE.Scene();
    const ball = new THREE.Mesh(new THREE.SphereGeometry(10, 64, 48));
    // turn the ball so printed layers and brushing run across the view
    ball.rotation.set(0.35, 0, 0.6);
    const key = new THREE.DirectionalLight();
    // something behind a clear material to see through it
    const backdrop = new THREE.Group();
    const back = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshBasicMaterial({ color: 0x8a93a6 }));
    back.position.set(0, 30, 0);
    back.rotation.x = Math.PI / 2;
    const checker = new THREE.Mesh(new THREE.PlaneGeometry(8, 60), new THREE.MeshBasicMaterial({ color: 0x2a2f3a }));
    checker.position.set(0, 29.9, 0);
    checker.rotation.x = Math.PI / 2;
    backdrop.add(back, checker);
    scene.add(ball, key, backdrop);
    const cam = new THREE.PerspectiveCamera(24, 1, 1, 400);
    cam.up.set(0, 0, 1);
    cam.position.set(0, -52, 14);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    return (this.swatchStage = { scene, ball, key, backdrop, cam });
  }

  /** The ball's material for a look. Kept, newest last, so a look seen before doesn't compile its shader again. */
  private swatchMaterial(look: Appearance) {
    let mat = this.swatchMats.get(look.key);
    if (mat) this.swatchMats.delete(look.key);
    else {
      const m = this.newPartMaterial(look);
      m.u.uNoiseScale.value = 0.3;
      mat = m.mat;
      if (this.swatchMats.size >= SWATCH_MATS_MAX) {
        const [oldest, m0] = this.swatchMats.entries().next().value!;
        this.swatchMats.delete(oldest);
        this.retire(m0);
      }
    }
    this.swatchMats.set(look.key, mat);
    return mat;
  }

  /**
   * A rendered ball of a material under the current lighting, as a data URL with a transparent background. The page
   * is not held for the graphics card: the ball's shader is built and the image read back in the card's own time.
   * Balls are drawn one at a time, since they share a stage, and a card handed a dozen at once holds up the view.
   */
  swatch(material: string, finish: string | undefined, color: string, size = 96): Promise<string> {
    const look = appearanceFor(material, finish, color);
    const key = `${look.key}|${this.preset.id}|${size}`;
    const hit = this.swatchCache.get(key);
    if (hit) return Promise.resolve(hit);
    let job = this.swatchJobs.get(key);
    if (!job) {
      const mine = this.swatchLine.then(() => this.drawSwatch(look, size));
      const over = () => {
        if (this.swatchJobs.get(key) === mine) this.swatchJobs.delete(key);
      };
      this.swatchLine = mine.then(over, over);
      this.swatchJobs.set(key, (job = mine));
    }
    return job;
  }

  /** The ball on its stage, lit as the view is now. */
  private poseSwatch(look: Appearance) {
    const st = this.stageSwatch();
    const { scene, ball } = st;
    scene.environment = this.scene.environment;
    scene.environmentIntensity = this.scene.environmentIntensity;
    scene.environmentRotation.copy(this.scene.environmentRotation);
    ball.material = this.swatchMaterial(look);
    st.key.color.copy(this.key.color);
    st.key.intensity = this.key.intensity;
    // same angle to the camera as the key light has to the default view
    st.key.position.copy(dirFrom(this.preset.key.az - 36, this.preset.key.el)).multiplyScalar(50);
    st.backdrop.visible = look.transmission > 0;
    return st;
  }

  private async drawSwatch(look: Appearance, size: number): Promise<string> {
    const gone = () => {
      if (this.disposed || this.contextLost) throw new Error("The 3D view is not there to draw a material in");
    };
    await this.whenLit();
    gone();
    const r = this.renderer;
    // one small pipeline reused for every swatch, and kept: its shaders compile once
    const pipe = (this.swatchPipe ??= new RenderPipeline(r));
    pipe.setSize(size, size, 1);
    await this.untilBuilt(
      during(SWATCH_WORK, () => {
        const { scene, cam } = this.poseSwatch(look);
        return pipe.compile(scene, cam);
      }),
    );
    gone();
    // the lighting may have changed while the shader was built: the ball is lit, and kept, as the view is now
    const key = `${look.key}|${this.preset.id}|${size}`;
    const hit = this.swatchCache.get(key);
    if (hit) return hit;
    const { scene, cam } = this.poseSwatch(look);
    const px = new Uint8Array(size * size * 4);
    await during(SWATCH_WORK, () => {
      Object.assign(pipe.look, this.pipe.look);
      pipe.look.ao = 0;
      pipe.look.bloom = 0;
      pipe.reset();
      const out = new THREE.WebGLRenderTarget(size, size, { type: THREE.UnsignedByteType, depthBuffer: false });
      try {
        for (let i = 0; i < 12; i++) pipe.renderSample(scene, cam);
        pipe.composite(out, { transparent: !look.transmission });
        r.setRenderTarget(out);
        return readPixelsLater(r, size, size, px);
      } finally {
        out.dispose();
        r.setRenderTarget(null);
        this.needComposite = true;
      }
    });
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
  }

  /** Resolves once the chosen light set is in place: a picture for a file, or a material's ball, is lit by it. */
  private async whenLit(): Promise<void> {
    while (this.lightingDue && !this.disposed && !this.contextLost && !this.filming) {
      if (this.lightingDue()) this.applyLighting(false);
      else await new Promise((r) => setTimeout(r, 30));
    }
  }

  /** Waits for the card to say shaders are built, but not for a view that has gone: a lost card never says so. */
  private untilBuilt(built: Promise<void>): Promise<void> {
    return new Promise((resolve) => {
      const end = () => {
        clearInterval(watch);
        resolve();
      };
      const watch = setInterval(() => (this.disposed || this.contextLost) && end(), 200);
      built.then(end, end);
    });
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
      // a line of the grid, about a pixel wide, faded out where its cells
      // shrink to a few pixels (far away or seen edge-on), where it would only
      // shimmer as moire
      float line(vec2 p, float cell) {
        vec2 q = p / cell;
        vec2 w = fwidth(q);
        vec2 g = abs(fract(q - 0.5) - 0.5) / w;
        float l = 1.0 - min(min(g.x, g.y), 1.0);
        return l * (1.0 - smoothstep(0.18, 0.45, max(w.x, w.y)));
      }
      void main() {
        vec2 p = vWorld.xy;
        float minor = line(p, uCell);
        float major = line(p, uCell * 10.0);
        float d = length(p - uCenter.xy);
        float fade = 1.0 - smoothstep(uFade * 0.25, uFade, d);
        vec3 col = mix(uMinor, uMajor, major);
        float a = max(minor * 0.5, major * 0.85);
        // the X and Y axes: softer than pure red and green, and gone well before the
        // horizon so they do not slice the backdrop in two
        float ax = 1.0 - min(abs(p.y) / fwidth(p.y) / 1.3, 1.0);
        float ay = 1.0 - min(abs(p.x) / fwidth(p.x) / 1.3, 1.0);
        float axFade = 1.0 - smoothstep(uFade * 0.12, uFade * 0.75, d);
        col = mix(col, vec3(0.86, 0.3, 0.33), ax);
        col = mix(col, vec3(0.32, 0.72, 0.45), ay);
        a = max(a, max(ax, ay) * 0.6 * axFade);
        gl_FragColor = vec4(col, a * fade * uAlpha);
      }`,
  });
}

/**
 * The selection mask drawn without a depth pass: each fragment of a selected part is compared with the depth the
 * view's first sample kept (packed RGBA). Selected: red where it is in front, blue where something hides it; hovered
 * (uHover 1): green where it is in front.
 */
function keptMask(u: Record<string, THREE.IUniform>) {
  const m = new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending, transparent: true, depthTest: false, depthWrite: false });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
#include <packing>
uniform sampler2D tViewDepth;
uniform vec2 uRes;
uniform float uHover;`,
      )
      .replace(
        "vec4 diffuseColor = vec4( diffuse, opacity );",
        `float kept = unpackRGBAToDepth(texture2D(tViewDepth, gl_FragCoord.xy / uRes));
  // the kept depth may be another MSAA sample's of this pixel: allow the surface's slope across it, and a few steps
  float front = gl_FragCoord.z <= kept + fwidth(gl_FragCoord.z) + 2e-7 ? 1.0 : 0.0;
  if (uHover > 0.5 && front < 0.5) discard;
  vec4 diffuseColor = uHover > 0.5 ? vec4(0.0, 1.0, 0.0, 1.0) : vec4(front, 0.0, 1.0 - front, 1.0);`,
      );
  };
  m.customProgramCacheKey = () => "kerf-kept-mask-1";
  return m;
}

function sameLens(a: { radius: number; focus: number } | null, b: { radius: number; focus: number } | null): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.focus - b.focus) <= a.focus * 1e-3 && Math.abs(a.radius - b.radius) <= a.radius * 1e-2;
}
