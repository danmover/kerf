// Shaders built by the graphics card without the page waiting for them.
//
// The renderer builds a material's shader the first time it draws with it, and waits there until the card has
// finished: nothing on the page moves meanwhile. With Direct3D the shader the parts are drawn with takes seconds,
// and there is one build for every way a material can be drawn (see-through or not, cut by a section or not, clear
// or not, into a shadow, as an outline), one after the other. So the first start after an update, the first section
// and the first x-ray each froze the app for as long as the card took.
//
// Two things here keep the page live:
//
// - A scene is looked over before it is drawn (`ready`). Whatever in it is new or changed is handed to the card to
//   build, all of it at once so the card builds side by side.
// - While a frame is drawn (`begin` to `end`), a draw with a material the card has not been handed for that kind of
//   draw, or has not finished, is left out. What was left out is handed to the card after the frame. Such a frame is
//   not a whole picture: the caller shows nothing of it, waits until the card has finished (`busy`), and draws again.
//   This covers what looking a scene over cannot see: the shaders shadows are drawn with, and materials a pass puts
//   in place of the scene's own.
//
// A frame never draws with a shader the card is known to be building, also not one it was handed with nothing
// waiting for it (a part's shader for when a section cuts it, built while the part is whole): the draw that comes
// to need it before it is done is left out like any other, and from then on it is waited for. Only a build the card
// has said nothing about for a long time is given up on (`GIVE_UP_MS`), and drawn with as it used to be.
//
// Nothing here changes what a whole frame looks like. Outside `begin` to `end` (a picture for a file, a film) every
// draw goes through as it always did, waited for at the draw; `late` counts shader builds met that way, and `waits`
// what they cost. Two things keep those few: what a picture for a file draws that the live view does not is handed
// over along with the view's own (`too`), and work that can be put off (baking a light set into its maps) is gone
// through once without drawing, for the card to build what it will draw with (`rehearse`).
//
// What this rests on in the renderer (three.js r169), to look at again when it is upgraded:
// - every draw goes through `renderBufferDirect`, a shadow's and a full-screen pass's among them, and that, `render`
//   and `clear` are properties of the renderer itself, so they can be stood in for;
// - `compile` builds a material's shader for as many clipping planes as the last thing drawn had, and for the lights
//   of the scene it is told the material is in;
// - which shader a material gets depends on the lights it is drawn under even when it is not lit, on what it is
//   drawn into (the screen or a buffer), on its side, and on the shape of the object (instanced, coloured, ...);
// - a shadow is drawn before its draw's lights are gathered, so its shader is the one for the lights of the draw
//   before.
// tests/shaderGate.test.ts holds a stand-in renderer that behaves this way.

import * as THREE from "three";
import { holdingBuilds, shaderQueue, type ShaderQueue } from "./shaderQueue";

type Drawn = THREE.Object3D & { material?: THREE.Material | THREE.Material[]; isMesh?: boolean; isLine?: boolean; isPoints?: boolean; isSprite?: boolean };

interface Program {
  isReady(): boolean;
  /** the card's own program; gone once nothing is drawn with it any more */
  program?: unknown;
}

/** builds given up on: the card said nothing about them for too long */
const gaveUp = new WeakSet<object>();

/** A build is over when the card says so, when its program was let go meanwhile (the part it was for went), and when it was given up on. */
function over(p: Program): boolean {
  try {
    return p.program === undefined || gaveUp.has(p) || p.isReady();
  } catch {
    return true;
  }
}

/**
 * With no build at all finished for this long, the card is taken not to say when one is: the builds it has are given
 * up on, and what needs them is drawn anyway (the page waits at the draw, as it used to). Long, because a card
 * handed everything a large design is drawn with for the first time takes many seconds over each.
 */
const GIVE_UP_MS = 60_000;
/** and one build is given up on after this long whatever else the card finished meanwhile */
const GIVE_UP_ON_ONE_MS = 300_000;

/**
 * Shader builds since the page opened: handed to the card ahead of the draw, or met at a draw and waited for, with
 * what the newest of those were for (when, the material's name or its kind when it has none, and the draw that met
 * it), and every wait for a build of a few milliseconds or more with how long it was. `leftOut`: the draws a frame
 * of the live view went without while the card built for them, by when (seconds since the page opened), what they
 * are drawn into and with what. `gaveUp`: builds the card said nothing about for too long. `atOnce`: how many builds
 * the card is given at a time (shaderQueue.ts) while the design is being built or checked, `atOnceIdle` with nothing
 * else on, `heldBack` how many had to wait their turn, `mostHeld` the most that waited at one time. `built`: every
 * build the card finished, as what it was of (see `told`), when it went to the card (ms since the page opened), how
 * long until it was seen done (ms), and whether a picture waited for it (1 or 0).
 */
export const shaderBuilds = { ahead: 0, late: 0, lateFor: [] as string[], waitedMs: 0, waits: [] as string[], leftOut: [] as string[], gaveUp: 0, atOnce: 0, atOnceIdle: 0, heldBack: 0, mostHeld: 0, built: [] as [string, number, number, number, string][] };

/** the draw being made, for telling what a build met at a draw was for */
const drawing = { on: false, material: null as THREE.Material | null, object: null as THREE.Object3D | null, frame: false, canvas: false, planes: 0, shadow: false };

function drawnNow(): string {
  if (!drawing.on) return "not at a draw";
  const o = drawing.object;
  const of = o?.name || o?.parent?.name || o?.parent?.parent?.name || o?.type || "";
  return `${drawing.frame ? "in a frame" : "outside a frame"}, ${drawing.shadow ? "a shadow" : drawing.canvas ? "the screen" : "a buffer"}${drawing.planes ? `, cut by ${drawing.planes}` : ""}${drawing.material?.transparent ? ", see-through" : ""}${of ? `, of ${of}` : ""}`;
}

const watched = new WeakSet<object>();
let ahead = 0;
/** what each of the card's programs is of, for the list of builds */
const told = new WeakMap<object, string>();
/** what the builds handed over just now are for (the scene, the camera's layers, what is drawn into), and each program's */
let askedFor = "";
const asked = new WeakMap<object, string>();
const called = (o: THREE.Object3D) => o.name || o.type || "a list";

/** what of the many things a material can be drawn as a shader is built for, by the defines the renderer gives it */
const DRAWN_AS: [string, string][] = [
  ["OPAQUE", "opaque"],
  ["USE_INSTANCING", "instanced"],
  ["USE_SHADOWMAP", "shadowed"],
  ["DOUBLE_SIDED", "two-sided"],
  ["FLIP_SIDED", "back"],
  ["USE_COLOR", "coloured"],
  ["USE_ENVMAP", "env"],
  ["USE_MAP", "map"],
  ["USE_NORMALMAP", "normals"],
  ["USE_CLEARCOAT", "clearcoat"],
  ["USE_SHEEN", "sheen"],
  ["USE_TRANSMISSION", "transmission"],
  ["USE_IRIDESCENCE", "iridescence"],
  ["USE_ANISOTROPY", "anisotropy"],
];

/**
 * A shader in a few words, from its text: the kind of material and its name, how long the text is, what it is built
 * to be drawn as, under how many lights and shadows, cut by how many planes, this app's own switches, and for one
 * with no name the first things it is given.
 */
function tell(vertex: string, fragment: string): string {
  const said = (what: string) => new RegExp(`#define ${what} (\\S+)`).exec(fragment)?.[1] ?? "";
  const kind = said("SHADER_TYPE");
  const name = said("SHADER_NAME");
  const has = (define: string) => new RegExp(`#define ${define}\\b`).test(fragment) || new RegExp(`#define ${define}\\b`).test(vertex);
  const many = (what: string) => Number(new RegExp(`${what}\\[ (\\d+) \\]`).exec(fragment)?.[1] ?? 0);
  const lights = many("directionalLights") + many("spotLights") + many("pointLights") + many("hemisphereLights") + many("rectAreaLights");
  const shadows = many("directionalShadowMap") + many("spotShadowMap") + many("pointShadowMap");
  const cut = many("clippingPlanes");
  const own = [...new Set([...fragment.matchAll(/#define (KERF_[A-Z0-9_]+)/g)].map((m) => m[1].slice(5).toLowerCase()))];
  // a shader of this app's own with no name is known by what it is given (tDepth, uRadius, ...)
  const given = name ? [] : [...new Set([...fragment.matchAll(/uniform \w+ ([tu][A-Z]\w*)/g)].map((m) => m[1]))].slice(0, 3);
  return [
    `${kind || "unnamed"}${name && name !== kind ? ` (${name})` : ""}`,
    `${Math.round((vertex.length + fragment.length) / 1000)}k`,
    ...DRAWN_AS.filter(([define]) => has(define)).map(([, as]) => as),
    lights ? `${lights} lights` : "",
    shadows ? `${shadows} shadows` : "",
    cut ? `cut ${cut}` : "",
    ...own,
    given.length ? `[${given.join(" ")}]` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** a wait for the card shorter than this is not written down, ms */
const WAIT_MS = 8;

function keep(list: string[], line: string) {
  list.push(line);
  if (list.length > 40) list.shift();
}

/** Count every shader build by whether it was handed over ahead (inside `handing`) or met at a draw, and time the waits for them. */
function watchBuilds(gl: WebGLRenderingContext | WebGL2RenderingContext) {
  if (watched.has(gl)) return;
  watched.add(gl);
  let name = "";
  // (the renderer gives a program its vertex shader's text, then its fragment shader's, then links it)
  let texts: string[] = [];
  const names = new WeakMap<WebGLProgram, string>();
  const source = gl.shaderSource;
  gl.shaderSource = function (this: unknown, shader: WebGLShader, text: string) {
    name = /#define SHADER_NAME (\S+)/.exec(text)?.[1] ?? /#define SHADER_TYPE (\S+)/.exec(text)?.[1] ?? "";
    texts = [texts[1] ?? "", text];
    return source.call(this, shader, text);
  } as typeof gl.shaderSource;
  const link = gl.linkProgram;
  gl.linkProgram = function (this: unknown, program: WebGLProgram) {
    names.set(program, name || "unnamed");
    told.set(program, tell(texts[0], texts[1]));
    asked.set(program, ahead ? askedFor : `met at a draw (${drawnNow()})`);
    if (ahead) shaderBuilds.ahead++;
    else {
      shaderBuilds.late++;
      keep(shaderBuilds.lateFor, `${(performance.now() / 1000).toFixed(1)} s ${name || "unnamed"} (${drawnNow()})`);
    }
    return link.call(this, program);
  } as typeof gl.linkProgram;
  // the renderer asks for a program's log, then its state, the first time it draws with it: an unfinished build is
  // waited for there
  const timed = <A extends unknown[], R>(call: (this: unknown, program: WebGLProgram, ...rest: A) => R) =>
    function (this: unknown, program: WebGLProgram, ...rest: A): R {
      const start = performance.now();
      try {
        return call.call(this, program, ...rest);
      } finally {
        const ms = performance.now() - start;
        if (ms >= WAIT_MS) {
          shaderBuilds.waitedMs += ms;
          keep(shaderBuilds.waits, `${names.get(program) ?? "unnamed"} ${Math.round(ms)} ms`);
        }
      }
    };
  gl.getProgramInfoLog = timed(gl.getProgramInfoLog as (this: unknown, program: WebGLProgram) => string | null) as typeof gl.getProgramInfoLog;
  gl.getProgramParameter = timed(gl.getProgramParameter as (this: unknown, program: WebGLProgram, what: number) => unknown) as typeof gl.getProgramParameter;
}

/** Shader builds started inside `work` are written down as asked for by `what` (the list of builds says so). */
export function askedBy<T>(what: string, work: () => T): T {
  const was = askedFor;
  askedFor = what;
  try {
    return work();
  } finally {
    askedFor = was;
  }
}

/**
 * Shader builds started inside `work` count as handed to the card ahead of the draw, and reach it a few at a time
 * (shaderQueue.ts). `urgent`: a picture waits for them (false: they go after those, one at a time).
 */
export function handing<T>(work: () => T, urgent?: boolean): T {
  ahead++;
  try {
    return holdingBuilds(work, urgent);
  } finally {
    ahead--;
  }
}

/**
 * What decides which shader a material is drawn with, as far as this app changes it: the material itself, every
 * time it is marked changed, and how many planes cut it.
 */
function variant(m: THREE.Material): number {
  return ((m.id * 1009 + (flips(m) ? 0 : m.version)) * 16 + Math.min(m.clippingPlanes?.length ?? 0, 7) * 2 + (m.clipIntersection ? 1 : 0)) % 9007199254740881;
}

function variantOf(o: Drawn): number {
  const m = o.material!;
  if (!Array.isArray(m)) return variant(m);
  let v = 0;
  for (const x of m) v = (v * 31 + variant(x)) % 9007199254740881;
  return v;
}

/** What of an object, and the geometry it is drawn from, gives the same material a shader of its own. */
function shape(o: THREE.Object3D, g: THREE.BufferGeometry | undefined): number {
  const x = o as { isInstancedMesh?: boolean; isSkinnedMesh?: boolean; isBatchedMesh?: boolean; isPoints?: boolean; instanceColor?: unknown };
  const a = g?.attributes;
  return (
    (x.isInstancedMesh ? 1 : 0) |
    (x.isSkinnedMesh ? 2 : 0) |
    (x.isBatchedMesh ? 4 : 0) |
    (x.isPoints ? 8 : 0) |
    (x.instanceColor ? 16 : 0) |
    (a?.tangent ? 32 : 0) |
    (a?.color ? (a.color.itemSize === 4 ? 192 : 64) : 0) |
    (a?.uv1 ? 256 : 0) |
    (g?.morphAttributes?.position ? 512 : 0)
  );
}

/** How many planes a draw with `m` is cut by, the renderer's own (cutting everything) with it. */
function cutBy(m: THREE.Material, r: THREE.WebGLRenderer, shadow: boolean): number {
  const own = r.localClippingEnabled && (!shadow || m.clipShadows) ? (m.clippingPlanes?.length ?? 0) : 0;
  return own + (shadow ? 0 : (r.clippingPlanes?.length ?? 0));
}

/** One kind of draw with a material: under which lights, into what, cut how, which side, of what shape of object. */
function kind(lit: number, shadow: boolean, canvas: boolean, planes: number, cross: boolean, side: number, shaped: number): number {
  return ((((lit * 2 + (shadow ? 1 : 0)) * 2 + (canvas ? 1 : 0)) * 16 + Math.min(planes, 7) * 2 + (cross ? 1 : 0)) * 4 + side) * 1024 + shaped;
}

/** a draw left out of a frame: what it was of, and what kind of draw */
interface Met {
  material: THREE.Material;
  object: THREE.Object3D;
  /** what was being drawn when it was met: its lights are the ones the shader is built for */
  root: THREE.Object3D;
  /** the layers of the camera those lights were gathered for */
  layers: number;
  shadow: boolean;
  canvas: boolean;
  planes: number;
  cross: boolean;
  kind: number;
}

type Programs = { currentProgram?: Program; programs?: Map<string, Program> };

/**
 * A material's kinds of draw, as it was last made (a material made anew may get other shaders for all of them): for
 * each the builds it is drawn with, as far as known, once the card has been handed it; null for one met in this
 * frame and not handed yet.
 */
type Kinds = Map<number, Program[] | null> & { made: number };

/** see-through two-sided materials seen so far */
const flipping = new WeakSet<THREE.Material>();

/**
 * A see-through two-sided material: the renderer draws its back, then its front, and marks it changed itself for
 * each, so its marks say nothing. While it is being drawn its side says back or front, not both: one seen two-sided
 * before is still taken for two-sided then.
 */
function flips(m: THREE.Material): boolean {
  if (!m.transparent || m.forceSinglePass) {
    flipping.delete(m);
    return false;
  }
  if (m.side === THREE.DoubleSide) {
    flipping.add(m);
    return true;
  }
  return flipping.has(m);
}

function materialsOf(o: Drawn): THREE.Material[] {
  return Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
}

export class ShaderGate {
  /** what each object's shaders were last built for */
  private built = new WeakMap<THREE.Object3D, number>();
  /** the lights and surroundings they were built under: a light more or fewer is a different shader for everything lit */
  private lit = new WeakMap<THREE.Object3D, number>();
  /** the same two, for what is also built to be drawn somewhere else (see `too`) */
  private builtToo = new WeakMap<THREE.Object3D, number>();
  private litToo = new WeakMap<THREE.Object3D, number>();
  /** each material's kinds of draw the card has been handed (or, for this frame, been met and not handed yet) */
  private kinds = new WeakMap<THREE.Material, Kinds>();
  /** every build the card was handed and has not said is done, with when it was handed */
  private pending = new Map<Program, number>();
  /** those of them that a picture waits for */
  private waiting = new Set<Program>();
  /** when the card last finished a build, or was handed one with none in hand */
  private progressAt = 0;
  /** builds not done that a draw gone through without drawing would have drawn with */
  private dryBuilding: Program[] = [];
  private readonly parallel: boolean;
  /** the builds on their way to the card, a few at a time */
  private queue: ShaderQueue | null = null;
  /** drawn, off the picture, to tell the renderer how many planes the next builds are cut by */
  private probe: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private probeCam = new THREE.Camera();
  /** a number for each set of lights and surroundings seen */
  private stamps = new Map<string, number>();
  /** each scene's, as last worked out: good until it is asked about again, or the next frame */
  private stampOf = new WeakMap<THREE.Object3D, { turn: number; ids: Map<number, number> }>();
  private turnNo = 0;
  /** what is being drawn, innermost last, and the camera it is drawn from */
  private roots: THREE.Object3D[] = [];
  private cameras: THREE.Camera[] = [];
  /** stand-ins for scenes, to build the shaders their shadows are drawn with */
  private shades = new WeakMap<THREE.Object3D, THREE.Object3D>();
  /**
   * For each thing drawn, by how deep the draw was nested: the layers of the camera its lights were last gathered
   * for. The renderer draws shadows before it gathers a draw's lights, so their shaders are built for the lights of
   * the draw before (none, when there was none).
   */
  private gathered = new WeakMap<THREE.Object3D, number[]>();
  /** a camera to gather lights for, by layers alone */
  private lightCam = new THREE.Camera();
  private lightLayers = new THREE.Layers();
  /** a frame is being drawn: draws the card is not ready for are left out */
  private watching = false;
  private spoiled = false;
  private met: Met[] = [];
  /** nothing is drawn or cleared at all: draws are only looked at for what the card has yet to build */
  private dry = false;
  /** something new was handed over that no frame has been drawn against yet */
  private unmet = false;
  private undo: (() => void) | null = null;

  constructor(
    private r: THREE.WebGLRenderer,
    /** one pixel to draw the probe into */
    private scratch: THREE.WebGLRenderTarget,
  ) {
    // without the card's say on when a build is done there is nothing to wait on but the build itself
    this.parallel = r.extensions.has("KHR_parallel_shader_compile");
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
    this.probe = new THREE.Mesh(g, new THREE.ShaderMaterial({ name: "kerf-gate-probe", vertexShader: "void main() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }", fragmentShader: "void main() { gl_FragColor = vec4(0.0); }" }));
    this.probe.frustumCulled = false;
    if (!this.parallel) return;
    // (the queue first: the counting and timing below go round its calls)
    this.queue = shaderQueue(r.getContext());
    shaderBuilds.atOnce = this.queue.limit;
    shaderBuilds.atOnceIdle = this.queue.idleLimit;
    this.queue.onBuilt = (program, sentAt, ms, urgent) => {
      shaderBuilds.built.push([told.get(program) ?? "unnamed", Math.round(sentAt), Math.round(ms), urgent ? 1 : 0, asked.get(program) ?? ""]);
      if (shaderBuilds.built.length > 800) shaderBuilds.built.shift();
    };
    watchBuilds(r.getContext());
    // every draw the renderer makes goes through here, a shadow's and a pass's among them
    const draw = r.renderBufferDirect;
    const render = r.render;
    const clear = r.clear;
    r.renderBufferDirect = (camera, scene, geometry, material, object, group) => {
      if (this.watching && !this.admit(camera, scene, geometry, material, object)) return;
      const d = drawing;
      d.on = true;
      d.material = material;
      d.object = object;
      d.frame = this.watching;
      d.canvas = r.getRenderTarget() === null;
      d.shadow = scene === null;
      d.planes = cutBy(material, r, d.shadow);
      try {
        draw.call(r, camera, scene, geometry, material, object, group);
      } finally {
        d.on = false;
        d.material = d.object = null;
      }
    };
    r.render = (scene, camera) => {
      this.roots.push(scene);
      this.cameras.push(camera);
      try {
        render.call(r, scene, camera);
      } finally {
        this.roots.pop();
        this.cameras.pop();
        this.gatheredFor(scene, this.roots.length, camera.layers.mask);
      }
    };
    r.clear = (color, depth, stencil) => {
      if (!this.dry) clear.call(r, color, depth, stencil);
    };
    this.undo = () => {
      r.renderBufferDirect = draw;
      r.render = render;
      r.clear = clear;
    };
  }

  /** Whether builds can be handed over at all here. Where they cannot, every scene is "ready" and is built at its draw. */
  get works(): boolean {
    return this.parallel;
  }

  /** True while builds handed over are not all done. */
  get busy(): boolean {
    return this.waiting.size > 0;
  }

  /** Forget what was built: the card was reset, and everything is built again. */
  reset() {
    this.built = new WeakMap();
    this.lit = new WeakMap();
    this.builtToo = new WeakMap();
    this.litToo = new WeakMap();
    this.kinds = new WeakMap();
    this.gathered = new WeakMap();
    this.pending.clear();
    this.waiting.clear();
    this.met = [];
    this.dryBuilding = [];
    this.progressAt = 0;
    this.unmet = false;
    this.queue?.reset();
  }

  /**
   * Whether everything `scene` is drawn with into `target` is built. Hands the card whatever is new first. When
   * false, show nothing drawn from now on until it is true again. `cuts`: its things get cut by a section or draw
   * themselves in, so the card is also handed each for one plane more or fewer than it has, which nothing waits for.
   */
  ready(scene: THREE.Object3D, camera: THREE.Camera, target: THREE.WebGLRenderTarget | null, cuts = false): boolean {
    if (!this.parallel) return true;
    // lights are looked at afresh
    this.turnNo++;
    const fresh = this.fresh(scene, camera);
    if (fresh.length) {
      const r = this.r;
      const prev = r.getRenderTarget();
      try {
        handing(() => {
          const all = r.clippingPlanes?.length ?? 0;
          for (const [objects, planes, cross] of clipGroups(fresh)) this.hand(objects, planes.length + all, cross, scene, scene, camera, target, true);
          // then one plane more or one fewer: a section, or a part drawing itself in, comes next for most of them,
          // and the card can build for that while nothing waits on it
          if (cuts) for (const [objects, planes, cross] of clipGroups(fresh)) if (planes.length <= 1) this.hand(objects, (planes.length ? 0 : 1) + all, cross, scene, scene, camera, target, false);
        });
      } finally {
        r.setRenderTarget(prev);
      }
      for (const o of fresh) this.built.set(o, variantOf(o));
      this.unmet = true;
    }
    return this.settled();
  }

  /** Whether the card has finished everything handed to it that is waited for. */
  private settled(): boolean {
    this.prune();
    return !this.waiting.size;
  }

  /** Takes the builds the card has finished off the lists, and gives up on those it has said nothing about for too long. */
  private prune() {
    if (!this.pending.size) return;
    const now = performance.now();
    for (const p of this.pending.keys()) if (over(p)) this.done(p, now);
    if (!this.pending.size) return;
    // a card that never says a build is done: what needs it is drawn, and waits for it there as before
    const stuck = now - this.progressAt > GIVE_UP_MS;
    const q = this.queue;
    if (q) {
      shaderBuilds.heldBack = q.heldBack;
      shaderBuilds.mostHeld = q.most;
    }
    for (const [p, at] of this.pending) {
      // (one still waiting its turn has not begun, and one with the card is timed from when it went to it)
      const since = q?.waiting(p.program) ? now : (q?.sentAt(p.program) ?? at);
      if (!stuck && now - since <= GIVE_UP_ON_ONE_MS) continue;
      gaveUp.add(p);
      shaderBuilds.gaveUp++;
      this.pending.delete(p);
      this.waiting.delete(p);
    }
  }

  private done(p: Program, now: number) {
    this.pending.delete(p);
    this.waiting.delete(p);
    this.progressAt = now;
  }

  /** A material's kinds of draw, forgotten when it was made anew since they were noted. */
  private kindsOf(m: THREE.Material): Kinds {
    const made = flips(m) ? 0 : m.version;
    let kinds = this.kinds.get(m);
    if (!kinds || kinds.made !== made) this.kinds.set(m, (kinds = Object.assign(new Map<number, Program[] | null>(), { made })));
    return kinds;
  }

  /**
   * Has the card build what `scene` is drawn with into `target` as well as where `ready` was told: a picture for a
   * file draws the view's marks into a buffer, where the live view draws them on the screen. Nothing waits for
   * these. The picture finds them built, or waits at its draw as it always did.
   */
  too(scene: THREE.Object3D, camera: THREE.Camera, target: THREE.WebGLRenderTarget | null) {
    if (!this.parallel) return;
    const fresh = this.fresh(scene, camera, this.builtToo, this.litToo);
    if (!fresh.length) return;
    const r = this.r;
    const prev = r.getRenderTarget();
    try {
      handing(() => {
        const all = r.clippingPlanes?.length ?? 0;
        for (const [objects, planes, cross] of clipGroups(fresh)) this.hand(objects, planes.length + all, cross, scene, scene, camera, target, false);
      });
    } finally {
      r.setRenderTarget(prev);
    }
    for (const o of fresh) this.builtToo.set(o, variantOf(o));
  }

  /**
   * Goes through `work`, something drawn outside a frame that can be put off, without drawing or clearing anything,
   * and hands the card whatever it would draw with that the card has not built. Null when the card has it all: do
   * the work. Otherwise do it once what is returned says true, and the page is not held for those builds. The live
   * view does not wait for them.
   */
  rehearse(work: () => void): (() => boolean) | null {
    if (!this.parallel || this.watching) return null;
    this.turnNo++;
    this.watching = this.dry = true;
    this.dryBuilding = [];
    let building: Program[] = [];
    try {
      work();
    } finally {
      this.watching = this.dry = false;
      this.spoiled = false;
      // (also when the work failed part of the way: what it met is with the card, or it would never be)
      building = [...this.handMet(false), ...this.dryBuilding];
      this.dryBuilding = [];
    }
    if (!building.length) return null;
    return () => {
      this.prune();
      return building.every(over);
    };
  }

  /**
   * Whether a frame should be drawn through now although the card is still building: once after anything new was
   * handed over, so that whatever else the picture needs built (see `begin`) is met and built alongside.
   */
  scout(): boolean {
    const go = this.unmet;
    this.unmet = false;
    return go;
  }

  /**
   * A frame's drawing starts. Until `end`, a draw the card is not ready for is left out of the frame instead of
   * being waited for.
   */
  begin() {
    if (!this.parallel) return;
    this.turnNo++;
    this.prune();
    this.watching = true;
    this.spoiled = false;
    this.dryBuilding = [];
  }

  /**
   * Go through `work`, a part of the frame that is not to be drawn now (showing a picture that is not whole), with
   * every draw in it left out and nothing cleared: what it would draw with is met all the same, and built with the
   * rest, instead of being met a frame later and waited for again.
   */
  unshown(work: () => void) {
    if (!this.watching) return;
    this.dry = true;
    try {
      work();
    } finally {
      this.dry = false;
    }
  }

  /** True when a draw has been left out of the frame being drawn: it is not a whole picture, and must not be shown. */
  get partial(): boolean {
    return this.spoiled;
  }

  /**
   * The frame's drawing is over. What it left out is handed to the card. True when it left anything out: wait until
   * `ready` is true, then draw everything again, shadows and all.
   */
  end(): boolean {
    if (!this.watching) return false;
    this.watching = false;
    this.unmet = false;
    this.handMet(true);
    this.dryBuilding = [];
    const spoiled = this.spoiled;
    this.spoiled = false;
    // (a frame that left something out when the card had its shader already costs that frame only: `ready` is true
    // straight after, and the caller draws it again)
    return spoiled;
  }

  /**
   * Hands the card the draws met and left out. `wait`: nothing is ready until they are built. Returns the builds
   * this started that are not over.
   */
  private handMet(wait: boolean): Program[] {
    const building: Program[] = [];
    if (!this.met.length) return building;
    const r = this.r;
    const prev = r.getRenderTarget();
    const met = this.met;
    this.met = [];
    const watching = this.watching;
    this.watching = false;
    try {
      handing(() => {
        const groups = new Map<string, Met[]>();
        for (const m of met) {
          const key = `${m.root.id}|${m.layers}|${m.shadow ? 1 : 0}|${m.canvas ? 1 : 0}|${m.planes}|${m.cross ? 1 : 0}`;
          const g = groups.get(key);
          if (g) g.push(m);
          else groups.set(key, [m]);
        }
        for (const g of groups.values()) {
          const m = g[0];
          // the object as that draw had it: with the material drawn with, which a pass or a shadow may have put in place of its own
          const as = g.map((x) => Object.create(x.object, { material: { value: x.material } }) as Drawn);
          this.lightCam.layers.mask = m.layers;
          keep(shaderBuilds.leftOut, `${(performance.now() / 1000).toFixed(1)} s ${m.shadow ? "a shadow" : m.canvas ? "the screen" : "a buffer"}${m.planes ? `, cut by ${m.planes}` : ""}: ${[...new Set(g.map((x) => x.material.name || x.material.type))].join(", ")}`);
          try {
            building.push(...this.hand(as, m.planes, m.cross, m.shadow ? this.shade(m.root) : m.root, m.root, this.lightCam, m.canvas ? null : this.scratch, wait, m.shadow));
          } catch {
            // the renderer could not build these ahead: they are built at their draws
          } finally {
            // Every draw met is with the card from here on, also one the renderer makes a kind of that is not the
            // kind it was met as: it waits for all its material's builds, and would otherwise be left out for good.
            for (const x of g) {
              const kinds = this.kindsOf(x.material);
              if (!kinds.get(x.kind)) kinds.set(x.kind, [...((r.properties.get(x.material) as Programs).programs?.values() ?? [])]);
            }
          }
        }
      });
    } finally {
      this.watching = watching;
      r.setRenderTarget(prev);
    }
    return building;
  }

  /** Whether a draw goes ahead in the frame being drawn. One that does not is noted, to be built after the frame. */
  private admit(camera: THREE.Camera, scene: THREE.Object3D | null, geometry: THREE.BufferGeometry, material: THREE.Material, object: THREE.Object3D): boolean {
    const r = this.r;
    const shadow = scene === null;
    const depth = this.roots.length - 1;
    const root = scene ?? this.roots[depth];
    if (!root) return true;
    // a shadow is drawn before its draw's lights are gathered: its shader is built for those gathered last
    const layers = shadow ? (this.gathered.get(root)?.[depth] ?? 0) : (this.cameras[depth] ?? camera).layers.mask;
    const canvas = r.getRenderTarget() === null;
    const planes = cutBy(material, r, shadow);
    const cross = !!material.clipIntersection && planes > 0;
    const k = kind(this.stamp(root, layers), shadow, canvas, planes, cross, material.side, shape(object, geometry));
    const kinds = this.kindsOf(material);
    const state = kinds.get(k);
    if (state) {
      // with the card: drawn once every build it is drawn with is done, whether or not anything waited for it so far
      if (this.pending.size)
        for (const p of state) {
          if (!this.pending.has(p)) continue;
          if (over(p)) {
            this.done(p, performance.now());
            continue;
          }
          if (this.dry) {
            this.dryBuilding.push(p);
            continue;
          }
          this.waiting.add(p);
          this.queue?.urge(p.program);
          return (this.spoiled = true), false;
        }
      return !this.dry;
    }
    if (state === undefined) {
      kinds.set(k, null);
      this.met.push({ material, object, root, layers, shadow, canvas, planes, cross, kind: k });
    }
    this.spoiled = true;
    return false;
  }

  /** Note that the lights of `root`, drawn `depth` deep, were gathered for a camera of these layers. */
  private gatheredFor(root: THREE.Object3D, depth: number, layers: number) {
    let by = this.gathered.get(root);
    if (!by) this.gathered.set(root, (by = []));
    by[depth] = layers;
  }

  /**
   * A number for the lights and surroundings `root` is drawn under by a camera of these layers: a light more or
   * fewer is a different shader for everything lit.
   */
  private stamp(root: THREE.Object3D, layers: number): number {
    let had = this.stampOf.get(root);
    if (!had || had.turn !== this.turnNo) this.stampOf.set(root, (had = { turn: this.turnNo, ids: new Map() }));
    const known = had.ids.get(layers);
    if (known !== undefined) return known;
    let lights = "";
    const seen = this.lightLayers;
    seen.mask = layers;
    root.traverseVisible((o) => {
      if ((o as THREE.Light).isLight && o.layers.test(seen)) lights += `${o.type}${o.castShadow ? "+" : ""},`;
    });
    const s = root as THREE.Scene;
    const env = (s.isScene ? s.environment : null) as (THREE.Texture & { image?: { height?: number } }) | null | undefined;
    lights += `${env ? `${env.mapping}:${env.image?.height ?? 0}` : "-"}|${s.isScene && s.fog ? 1 : 0}|${this.r.shadowMap.enabled ? this.r.shadowMap.type : "-"}`;
    let id = this.stamps.get(lights);
    if (id === undefined) this.stamps.set(lights, (id = this.stamps.size));
    had.ids.set(layers, id);
    return id;
  }

  /**
   * In place of `root` when building the shaders its shadows are drawn with: its lights, no surroundings, and
   * something casting a shadow, as the renderer has it when it draws a shadow (it only does when something casts
   * one, whatever lights it gathered the draw before).
   */
  private shade(root: THREE.Object3D): THREE.Object3D {
    let s = this.shades.get(root);
    if (!s) {
      const visit = (see: (o: THREE.Object3D) => void) => {
        root.traverseVisible(see);
        see(CASTER);
      };
      this.shades.set(root, (s = { isScene: false, traverseVisible: visit } as unknown as THREE.Object3D));
    }
    return s;
  }

  /** The drawn things in the scene whose shaders have not been built for what they are now. */
  private fresh(scene: THREE.Object3D, camera: THREE.Camera, built = this.built, lit = this.lit): Drawn[] {
    const all: Drawn[] = [];
    const fresh: Drawn[] = [];
    scene.traverseVisible((o) => {
      const d = o as Drawn;
      if (!d.material || !(d.isMesh || d.isLine || d.isPoints || d.isSprite)) return;
      all.push(d);
      if (built.get(d) !== variantOf(d)) fresh.push(d);
    });
    const lights = this.stamp(scene, camera.layers.mask);
    if (lit.get(scene) === lights) return fresh;
    lit.set(scene, lights);
    return all;
  }

  /**
   * Has the card build the shaders `objects` are drawn with when cut by `planes` planes in all (their own and the
   * renderer's), under the lights of `root` (`stage` is what the renderer is told they are drawn in). `wait`:
   * nothing is ready until they are built. Returns the builds of theirs that are not over.
   */
  private hand(objects: Drawn[], planes: number, cross: boolean, stage: THREE.Object3D, root: THREE.Object3D, camera: THREE.Camera, target: THREE.WebGLRenderTarget | null, wait: boolean, shadow = false): Program[] {
    const r = this.r;
    this.cutNext(planes, cross);
    // and which shader a material gets depends on what it is drawn into
    r.setRenderTarget(target);
    const list = listOf(objects);
    // the builds each material has already: one that is new after this is this kind of draw's
    const had = new Map<THREE.Material, Set<Program>>();
    for (const o of objects) for (const mat of materialsOf(o)) if (!had.has(mat)) had.set(mat, new Set((r.properties.get(mat) as Programs).programs?.values()));
    askedFor = `${called(root)}${stage === root ? "" : ` as ${called(stage)}`}, layers ${camera.layers.mask}, into ${target ? `${target.width}x${target.height}` : "the canvas"}${shadow ? ", shadows" : ""}`;
    try {
      holdingBuilds(() => r.compile(list, camera, stage as THREE.Scene), wait);
    } finally {
      askedFor = "";
    }
    // (that gathered the lights of what it was told they are drawn in)
    this.gatheredFor(stage, 0, camera.layers.mask);
    // These kinds of draw are with the card now, each with the builds it is drawn with: the one the renderer
    // settled on for the material, and any made just now. (A see-through two-sided material is drawn back first,
    // then front, each with a shader of its own, and which is which is not told: both kinds wait for all it has.)
    const lit = this.stamp(root, camera.layers.mask);
    const mine = new Map<THREE.Material, Program[]>();
    for (const [mat, before] of had) {
      const props = r.properties.get(mat) as Programs;
      const all = [...(props.programs?.values() ?? [])];
      const own = flips(mat) ? all : all.filter((p) => !before.has(p));
      if (props.currentProgram && !own.includes(props.currentProgram)) own.push(props.currentProgram);
      mine.set(mat, own);
    }
    for (const o of objects) {
      const shaped = shape(o, (o as THREE.Mesh).geometry);
      for (const mat of materialsOf(o)) {
        const kinds = this.kindsOf(mat);
        const sides = flips(mat) ? [THREE.BackSide, THREE.FrontSide] : [mat.side];
        for (const side of sides) kinds.set(kind(lit, shadow, target === null, planes, cross && planes > 0, side, shaped), mine.get(mat)!);
      }
    }
    const building = [...new Set([...mine.values()].flat())].filter((p) => !over(p));
    const now = performance.now();
    for (const p of building) {
      if (!this.pending.size) this.progressAt = now;
      if (!this.pending.has(p)) this.pending.set(p, now);
      if (wait) {
        this.waiting.add(p);
        // (handed over earlier with nothing waiting for it, it may be far down the queue)
        this.queue?.urge(p.program);
      }
    }
    return building;
  }

  /**
   * Draws nothing, cut by `planes` planes in all (the renderer's own among them). The renderer builds the shaders it
   * is next asked to build for as many clipping planes as the last thing it drew had, whatever the materials being
   * built have. Leaves the renderer drawing into a buffer of this gate's own: set the one to build for after.
   */
  cutNext(planes: number, cross = false) {
    const r = this.r;
    const m = this.probe.material;
    // (the renderer's own planes cut the probe as they are: it brings the rest)
    const own = Math.max(0, planes - (r.clippingPlanes?.length ?? 0));
    m.clippingPlanes = own ? PLANES.slice(0, Math.min(own, PLANES.length)) : null;
    m.clipIntersection = cross;
    const watching = this.watching;
    this.watching = false;
    try {
      r.setRenderTarget(this.scratch);
      r.render(this.probe, this.probeCam);
    } finally {
      this.watching = watching;
    }
  }

  dispose() {
    this.undo?.();
    this.probe.geometry.dispose();
    this.probe.material.dispose();
    this.pending.clear();
    this.waiting.clear();
    this.met = [];
  }
}

/** These objects as something the renderer can be told to build the shaders of, as if they were all a scene holds. */
export function listOf(objects: THREE.Object3D[]): THREE.Object3D {
  return {
    traverse: (visit: (o: THREE.Object3D) => void) => objects.forEach(visit),
    traverseVisible: (visit: (o: THREE.Object3D) => void) => objects.forEach(visit),
  } as unknown as THREE.Object3D;
}

/** to the renderer a light of no kind it counts, that casts a shadow: with it, shadows are being drawn */
const CASTER = { isLight: true, castShadow: true, layers: { test: () => true } } as unknown as THREE.Object3D;

/** planes that cut nothing, as many as a probe may need */
const PLANES = Array.from({ length: 8 }, () => new THREE.Plane(new THREE.Vector3(0, 0, 1), 1e9));

/** Objects by how their first material is cut: the count of planes, and whether they cut together. */
function clipGroups(objects: Drawn[]): [Drawn[], THREE.Plane[], boolean][] {
  const groups = new Map<string, [Drawn[], THREE.Plane[], boolean]>();
  for (const o of objects) {
    const m = Array.isArray(o.material) ? o.material[0] : o.material!;
    const planes = m?.clippingPlanes ?? [];
    const cross = !!m?.clipIntersection && planes.length > 0;
    const key = `${planes.length}|${cross ? 1 : 0}`;
    const g = groups.get(key);
    if (g) g[0].push(o);
    else groups.set(key, [[o], planes as THREE.Plane[], cross]);
  }
  return [...groups.values()];
}
