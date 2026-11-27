// Shader builds reach the graphics card a few at a time.
//
// The renderer hands the card every shader a design is drawn with as soon as it knows of them (shaderGate.ts): 150
// or so for a large design opened for the first time, after which the browser keeps them. All at once, the browser's
// graphics process builds as many side by side as the PC has processor threads, and its threads go before the
// page's. Measured on an 8-thread PC with a Radeon card (Direct3D): for 15 s it had 5.7 of the 8 threads' time, the
// page's own thread got 2 s of work done in those 15 s and stood still for 8 s in the middle of a frame, and the
// workers building the design's parts took three times as long. So a build is held back here until fewer than a few
// are with the card, those a picture waits for first: a quarter of the processor threads' worth while the design is
// being built or checked, and half of them once nothing else on the PC wants the processor (`buildsYieldTo`).
//
// It is done under the renderer, at the calls it makes to WebGL. The renderer has its program objects as always, and
// one whose build is held back says "not done" like any other the card is still at work on. A held build that is
// needed after all (something draws with it outside a frame, and asks for its uniforms) goes to the card there and
// then, and is waited for as it always was.

type GL = WebGLRenderingContext | WebGL2RenderingContext;
type Fn = (...a: unknown[]) => unknown;

const COMPLETION_STATUS_KHR = 0x91b1;
/** a build the card has said nothing about for this long no longer keeps others back, ms */
const SILENT_MS = 30_000;
/** how soon the card is asked again whether a build is done, while others are held back for it, ms: doubling up to the longest */
const LOOK_FIRST_MS = 2;
const LOOK_LONGEST_MS = 48;

interface Held {
  /** its shaders, not compiled yet */
  shaders: WebGLShader[];
  /** those of them the renderer has let go of meanwhile: let go of for the card once the build has gone to it */
  drop: WebGLShader[];
  /** a picture waits for it */
  urgent: boolean;
}

/** builds asked for now may be held back (they are handed over ahead of the draw: see `holdingBuilds`) */
let holding = 0;
/** builds asked for now are waited for by a picture */
let urgentNow = true;

/** Shader builds asked for inside `work` may be held back until the card has room. `urgent`: a picture waits for them. */
export function holdingBuilds<T>(work: () => T, urgent = urgentNow): T {
  const was = urgentNow;
  holding++;
  urgentNow = urgent;
  try {
    return work();
  } finally {
    holding--;
    urgentNow = was;
  }
}

/** what `kerf.debug.shadersAtOnce` says, if anything: a number, "all", or two of them ("2,4": while the design is worked on, and with nothing else on) */
function setByHand(): [number, number] | null {
  try {
    const set = typeof localStorage !== "undefined" ? localStorage.getItem("kerf.debug.shadersAtOnce") : null;
    if (!set) return null;
    const of = (t: string | undefined) => (t === "all" ? Infinity : Number(t) >= 1 ? Math.floor(Number(t)) : 0);
    const [a, b] = set.split(",").map((t) => t.trim());
    const busy = of(a);
    if (!busy) return null;
    return [busy, Math.max(busy, of(b))];
  } catch {
    return null; // storage blocked
  }
}

/** How many builds the card is given at once on this PC while the design is being built or checked: a quarter of its processor threads, so the page and the workers building parts keep theirs. */
export function buildsAtOnce(threads = typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 0): number {
  return setByHand()?.[0] ?? Math.max(1, Math.min(6, Math.floor((threads || 4) / 4)));
}

/** And with nothing else on: half its threads, which leaves the page's own thread and the browser's theirs. Never fewer than `buildsAtOnce`. */
export function buildsAtOnceIdle(threads = typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 0): number {
  return setByHand()?.[1] ?? Math.max(buildsAtOnce(threads), Math.min(6, Math.floor((threads || 4) / 2)));
}

/** whether something else on the PC wants the processor now: until the app says, always */
let busyElsewhere: () => boolean = () => true;

/** Tells the queues how to find out whether the design is being built or checked now: while it is, the card gets fewer builds at once. */
export function buildsYieldTo(busy: () => boolean) {
  busyElsewhere = busy;
}

const queues = new WeakMap<object, ShaderQueue>();

/** The queue of a WebGL context, put in place the first time it is asked for. */
export function shaderQueue(gl: GL, limit = buildsAtOnce(), idle = buildsAtOnceIdle()): ShaderQueue {
  let q = queues.get(gl);
  if (!q) {
    queues.set(gl, (q = new ShaderQueue(gl, limit)));
    q.idleLimit = Math.max(limit, idle);
  }
  return q;
}

export class ShaderQueue {
  /** builds held back, in the order they were asked for */
  private held = new Map<WebGLProgram, Held>();
  /** builds with the card that it has not said are done: when each went, and whether a picture waits for it */
  private flying = new Map<WebGLProgram, { at: number; urgent: boolean }>();
  /** shaders whose compile is held back, each with the program it is attached to (null: none yet) */
  private uncompiled = new Map<WebGLShader, WebGLProgram | null>();
  /** shaders let go of by the renderer between being attached and their program's link */
  private dropped = new Set<WebGLShader>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wait = LOOK_FIRST_MS;
  private real = { compile: (() => undefined) as Fn, link: (() => undefined) as Fn, drop: (() => undefined) as Fn, param: (() => true) as Fn };
  /** builds that had to wait their turn, and the most that waited at one time */
  heldBack = 0;
  most = 0;
  /** how many builds the card has at once while nothing else wants the processor (see `buildsYieldTo`): `limit` unless set higher */
  idleLimit = 0;
  /** told of every build the card has finished: when it went to the card, how long until it was seen done, and whether a picture waited for it */
  onBuilt: ((program: WebGLProgram, sentAt: number, ms: number, urgent: boolean) => void) | null = null;

  constructor(
    gl: GL,
    /** how many builds the card has at once while the design is being built or checked */
    readonly limit: number,
    private now: () => number = () => performance.now(),
    private later: (work: () => void, ms: number) => ReturnType<typeof setTimeout> = (work, ms) => setTimeout(work, ms),
  ) {
    const g = gl as unknown as Record<string, Fn | undefined>;
    /** put `make(real)` in place of a call the context has (a stand-in for a context may not have them all) */
    const wrap = (name: string, make: (real: Fn) => Fn) => {
      const was = g[name];
      if (typeof was !== "function") return;
      g[name] = make((...a) => was.apply(gl, a));
    };
    wrap("compileShader", (real) => {
      this.real.compile = real;
      return (shader) => {
        if (holding > 0 && Number.isFinite(this.limit)) this.uncompiled.set(shader as WebGLShader, null);
        else real(shader);
      };
    });
    wrap("attachShader", (real) => (program, shader) => {
      real(program, shader);
      if (this.uncompiled.has(shader as WebGLShader)) this.uncompiled.set(shader as WebGLShader, program as WebGLProgram);
    });
    wrap("linkProgram", (real) => {
      this.real.link = real;
      return (program) => {
        const p = program as WebGLProgram;
        const shaders = [...this.uncompiled].filter(([, of]) => of === p).map(([s]) => s);
        const h: Held = { shaders, drop: shaders.filter((s) => this.dropped.delete(s)), urgent: urgentNow };
        if (holding > 0 && Number.isFinite(this.limit)) {
          if (this.room(h.urgent)) return this.send(p, h);
          this.held.set(p, h);
          this.heldBack++;
          this.most = Math.max(this.most, this.held.size);
          this.look();
          return;
        }
        // met at a draw (or nothing is ever held back): built now
        for (const s of h.shaders) this.compile(s);
        real(p);
        for (const s of h.drop) this.real.drop(s);
        this.flying.set(p, { at: this.now(), urgent: true });
      };
    });
    wrap("deleteShader", (real) => {
      this.real.drop = real;
      return (shader) => {
        const s = shader as WebGLShader;
        if (!this.uncompiled.has(s)) return real(s);
        const of = this.uncompiled.get(s);
        const h = of ? this.held.get(of) : undefined;
        // its compile is still to come: the card is told to let go of it after that
        if (h) h.drop.push(s);
        else if (of) this.dropped.add(s);
        else {
          this.uncompiled.delete(s);
          real(s);
        }
      };
    });
    wrap("getProgramParameter", (real) => {
      this.real.param = real;
      return (program, pname) => {
        const p = program as WebGLProgram;
        if (pname !== COMPLETION_STATUS_KHR) {
          this.need(p);
          return real(p, pname);
        }
        if (this.held.has(p)) {
          this.pump();
          return false;
        }
        const done = real(p, pname);
        if (done && this.landed(p)) this.pump();
        return done;
      };
    });
    // whatever else asks the card about a program, or draws with it, needs it built
    for (const name of ["useProgram", "getProgramInfoLog", "getUniformLocation", "getActiveUniform", "getActiveAttrib", "getAttribLocation", "getUniform", "validateProgram", "getFragDataLocation", "getUniformIndices", "getActiveUniforms", "getUniformBlockIndex", "getActiveUniformBlockParameter", "getActiveUniformBlockName", "uniformBlockBinding", "getTransformFeedbackVarying"])
      wrap(name, (real) => (program, ...rest) => {
        if (program) this.need(program as WebGLProgram);
        return real(program, ...rest);
      });
    for (const name of ["getShaderParameter", "getShaderInfoLog"])
      wrap(name, (real) => (shader, ...rest) => {
        const s = shader as WebGLShader;
        if (this.uncompiled.has(s)) {
          const of = this.uncompiled.get(s);
          if (of && this.held.has(of)) this.need(of);
          else this.compile(s);
        }
        return real(shader, ...rest);
      });
    wrap("deleteProgram", (real) => (program) => {
      const p = program as WebGLProgram;
      const h = this.held.get(p);
      if (h) {
        // never built: its shaders never were compiled, and those let go of meanwhile go now
        this.held.delete(p);
        for (const s of h.shaders) this.uncompiled.delete(s);
        for (const s of h.drop) this.real.drop(s);
      }
      const flew = this.flying.delete(p);
      real(p);
      if (h || flew) this.pump();
    });
  }

  /** True while the build of this program is held back, waiting its turn. */
  waiting(program: unknown): boolean {
    return this.held.has(program as WebGLProgram);
  }

  /** When this program's build went to the card, if it is with it now and not said to be done. */
  sentAt(program: unknown): number | undefined {
    return this.flying.get(program as WebGLProgram)?.at;
  }

  /** How many builds are held back now. */
  get size(): number {
    return this.held.size;
  }

  /** A picture waits for this program after all: its build goes ahead of those nothing waits for. */
  urge(program: unknown) {
    const p = program as WebGLProgram;
    const h = this.held.get(p);
    const f = this.flying.get(p);
    if (f) f.urgent = true;
    if (!h || h.urgent) return;
    h.urgent = true;
    this.pump();
  }

  /** Forget everything: the context was lost, and its programs with it. */
  reset() {
    this.held.clear();
    this.flying.clear();
    this.uncompiled.clear();
    this.dropped.clear();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.wait = LOOK_FIRST_MS;
  }

  private compile(s: WebGLShader) {
    if (this.uncompiled.delete(s)) this.real.compile(s);
  }

  /** The card has finished this build. False when it was not known to be with the card. */
  private landed(p: WebGLProgram): boolean {
    const f = this.flying.get(p);
    if (!f) return false;
    this.flying.delete(p);
    this.onBuilt?.(p, f.at, this.now() - f.at, f.urgent);
    return true;
  }

  /** How many builds the card may have now. */
  private atOnce(): number {
    return this.idleLimit > this.limit && !busyElsewhere() ? this.idleLimit : this.limit;
  }

  /** The build goes to the card: its shaders compiled, the program linked, as the renderer asked, only later. */
  private send(p: WebGLProgram, h: Held) {
    this.held.delete(p);
    for (const s of h.shaders) this.compile(s);
    this.real.link(p);
    for (const s of h.drop) this.real.drop(s);
    this.flying.set(p, { at: this.now(), urgent: h.urgent });
  }

  /** This program is about to be used or asked about: its build cannot wait any longer. */
  private need(p: WebGLProgram) {
    const h = this.held.get(p);
    if (h) this.send(p, h);
  }

  /**
   * Whether the card can be given another build now. One nothing waits for goes after all that are waited for, and
   * alone, or a few together once nothing else wants the processor.
   */
  private room(urgent: boolean): boolean {
    const now = this.now();
    let busy = 0;
    let spare = 0;
    for (const [p, f] of this.flying) {
      if (this.real.param(p, COMPLETION_STATUS_KHR)) {
        this.landed(p);
        continue;
      }
      if (now - f.at > SILENT_MS) continue;
      busy++;
      if (!f.urgent) spare++;
    }
    const most = this.atOnce();
    if (busy >= most) return false;
    if (urgent) return true;
    if (spare >= (most > this.limit ? Math.max(1, Math.floor(most / 2)) : 1)) return false;
    for (const h of this.held.values()) if (h.urgent) return false;
    return true;
  }

  /** Gives the card the builds held back that it has room for: those a picture waits for first, each kind in the order asked. True when any went. */
  private give(): boolean {
    let went = false;
    for (;;) {
      let next: [WebGLProgram, Held] | undefined;
      for (const e of this.held) {
        if (e[1].urgent) {
          next = e;
          break;
        }
        next ??= e;
      }
      if (!next || !this.room(next[1].urgent)) break;
      this.send(next[0], next[1]);
      went = true;
    }
    return went;
  }

  private pump() {
    if (this.give()) this.wait = LOOK_FIRST_MS;
    this.look();
  }

  /** While builds are held back, the card is asked again and again whether it has room: soon after it had, later and later while it has not. */
  private look() {
    if (this.timer !== null || !this.held.size) return;
    this.timer = this.later(() => {
      this.timer = null;
      this.wait = this.give() ? LOOK_FIRST_MS : Math.min(LOOK_LONGEST_MS, this.wait * 2);
      this.look();
    }, this.wait);
  }
}
