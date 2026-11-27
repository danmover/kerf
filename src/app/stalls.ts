// Records every time the page stops answering for a moment, and what it was doing. A freeze is the page's one
// thread busy for longer than a frame or two: nothing can be clicked and nothing moves until it is done. Which
// work that was differs from machine to machine (a shader that compiles in 20 ms on one graphics card takes a
// second on another), so the record is kept on the machine itself and can be copied out of Settings.
//
// What is recorded: each stretch of 100 ms or more, when it happened, how long it took, the named pieces of Kerf's
// own work that ran inside it (`during`), calls into the graphics card that waited (`watchGl`), and, where the
// browser says, which script and function ran.

/** A stretch of the page's thread this long (ms) is a freeze worth recording. */
export const STALL_MS = 100;
/** A call into the graphics card that takes this long (ms) is recorded as a piece of work. */
const GL_MS = 8;
const KEEP = 200;
const KEEP_SPANS = 400;

export interface StallPiece {
  name: string;
  ms: number;
}

export interface Stall {
  /** when it started, ms since the page opened */
  at: number;
  ms: number;
  /** Kerf's own named work inside it, longest first */
  work: StallPiece[];
  /** what the browser says ran, longest first (empty where it does not say) */
  scripts: StallPiece[];
}

interface Span {
  name: string;
  start: number;
  end: number;
}

const stalls: Stall[] = [];
const spans: Span[] = [];
let total = 0;
let longest = 0;
let started = false;
const listeners = new Set<() => void>();

function note(span: Span) {
  spans.push(span);
  if (spans.length > KEEP_SPANS) spans.splice(0, spans.length - KEEP_SPANS);
}

/** Run a piece of work under a name, so a freeze it causes says so. */
export function during<T>(name: string, work: () => T): T {
  const start = performance.now();
  try {
    return work();
  } finally {
    const end = performance.now();
    if (end - start >= 4) note({ name, start, end });
  }
}

/** Name a piece of work that has already been timed. */
export function noteWork(name: string, start: number, end = performance.now()) {
  if (end - start >= 4) note({ name, start, end });
}

/** The named work that ran inside a stretch of time, merged by name, longest first. */
function workIn(start: number, end: number): StallPiece[] {
  const by = new Map<string, number>();
  for (const s of spans) {
    const ms = Math.min(end, s.end) - Math.max(start, s.start);
    if (ms > 0) by.set(s.name, (by.get(s.name) ?? 0) + ms);
  }
  return [...by].map(([name, ms]) => ({ name, ms: Math.round(ms) })).sort((a, b) => b.ms - a.ms);
}

interface ScriptTiming {
  duration: number;
  invoker?: string;
  sourceFunctionName?: string;
  sourceURL?: string;
}

function scriptsOf(entry: PerformanceEntry): StallPiece[] {
  const list = (entry as unknown as { scripts?: ScriptTiming[] }).scripts;
  if (!list?.length) return [];
  return list
    .filter((s) => s.duration >= 10)
    .map((s) => {
      const file = (s.sourceURL ?? "").split("/").pop()?.split("?")[0] ?? "";
      const fn = s.sourceFunctionName || s.invoker || "";
      return { name: [fn, file].filter(Boolean).join(" in ") || "script", ms: Math.round(s.duration) };
    })
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 4);
}

function record(at: number, ms: number, scripts: StallPiece[]) {
  // a long frame and the long task inside it are one freeze
  const last = stalls[stalls.length - 1];
  if (last && at < last.at + last.ms && at + ms > last.at) {
    if (ms > last.ms) Object.assign(last, { at, ms: Math.round(ms), work: workIn(at, at + ms).slice(0, 6) });
    if (scripts.length && !last.scripts.length) last.scripts = scripts;
    longest = Math.max(longest, ms);
    return;
  }
  total++;
  longest = Math.max(longest, ms);
  stalls.push({ at: Math.round(at), ms: Math.round(ms), work: workIn(at, at + ms).slice(0, 6), scripts });
  if (stalls.length > KEEP) stalls.shift();
  for (const l of listeners) l();
}

/** Start recording. Safe to call more than once, and where the browser cannot tell (nothing is recorded there). */
export function watchStalls() {
  if (started || typeof PerformanceObserver === "undefined") return;
  started = true;
  const kinds = PerformanceObserver.supportedEntryTypes ?? [];
  // a long frame says which script ran; a long task is all older browsers give
  const kind = kinds.includes("long-animation-frame") ? "long-animation-frame" : kinds.includes("longtask") ? "longtask" : "";
  if (!kind) return;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        // of a long frame, the part that held the page up
        const blocked = (e as unknown as { blockingDuration?: number }).blockingDuration;
        const ms = kind === "longtask" ? e.duration : Math.max(blocked ?? 0, e.duration - 16);
        if (ms >= STALL_MS) record(e.startTime, e.duration, scriptsOf(e));
      }
    }).observe({ type: kind, buffered: true });
  } catch {
    started = false;
  }
}

type GlCall = (...args: unknown[]) => unknown;

/**
 * Time the calls into the graphics card that can wait for it: asking whether a shader is ready (where a compile is
 * waited for), reading pixels back, and waiting for it to finish. Each one over a few milliseconds is recorded as a
 * piece of work, so a freeze says "compiling a shader" or "reading an image back" where that is what it was.
 */
export function watchGl(gl: WebGL2RenderingContext | WebGLRenderingContext) {
  const names: [string, string][] = [
    ["getProgramParameter", "graphics card: shader compile"],
    ["getShaderParameter", "graphics card: shader compile"],
    ["getProgramInfoLog", "graphics card: shader compile"],
    ["linkProgram", "graphics card: shader compile"],
    ["readPixels", "graphics card: reading an image back"],
    ["getBufferSubData", "graphics card: reading an image back"],
    ["finish", "graphics card: waiting for it to finish"],
    ["clientWaitSync", "graphics card: waiting for it to finish"],
    ["getError", "graphics card: waiting for it to finish"],
    ["texImage2D", "graphics card: sending a picture"],
    ["texSubImage2D", "graphics card: sending a picture"],
    ["texImage3D", "graphics card: sending a picture"],
    ["bufferData", "graphics card: sending a model"],
    ["checkFramebufferStatus", "graphics card: waiting for it to finish"],
  ];
  const target = gl as unknown as Record<string, GlCall | undefined> & { __kerfWatched?: boolean };
  if (target.__kerfWatched) return;
  target.__kerfWatched = true;
  for (const [fn, label] of names) {
    const orig = target[fn];
    if (typeof orig !== "function") continue;
    target[fn] = function (this: unknown, ...args: unknown[]) {
      const start = performance.now();
      try {
        return orig.apply(this, args);
      } finally {
        const end = performance.now();
        if (end - start >= GL_MS) note({ name: label, start, end });
      }
    };
  }
}

export interface StallSummary {
  /** freezes since the page opened */
  count: number;
  longestMs: number;
  /** the newest ones kept, oldest first */
  recent: Stall[];
  /** what the freezes were, by the largest piece of each, most time first */
  causes: { name: string; count: number; ms: number }[];
}

export function stallSummary(): StallSummary {
  const by = new Map<string, { count: number; ms: number }>();
  for (const s of stalls) {
    const name = s.work[0]?.name ?? s.scripts[0]?.name ?? "not named";
    const c = by.get(name) ?? { count: 0, ms: 0 };
    c.count++;
    c.ms += s.ms;
    by.set(name, c);
  }
  return { count: total, longestMs: Math.round(longest), recent: stalls.slice(), causes: [...by].map(([name, c]) => ({ name, ...c })).sort((a, b) => b.ms - a.ms) };
}

/** Told when a freeze is recorded. Returns how to stop being told. */
export function onStall(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The record as text, to paste into a message: what froze, for how long, and what it was doing. */
export function stallReport(about: string[] = []): string {
  const s = stallSummary();
  const lines = [`Kerf freeze record: ${s.count} freeze${s.count === 1 ? "" : "s"} of ${STALL_MS} ms or more, the longest ${s.longestMs} ms, in ${Math.round(performance.now() / 1000)} s.`, ...about];
  if (s.causes.length) {
    lines.push("", "By cause:");
    for (const c of s.causes.slice(0, 12)) lines.push(`  ${c.name}: ${c.count} time${c.count === 1 ? "" : "s"}, ${c.ms} ms in all`);
  }
  if (s.recent.length) {
    lines.push("", "Each one (seconds since Kerf opened, how long, what ran):");
    for (const st of s.recent) {
      const what = [...st.work.map((w) => `${w.name} ${w.ms} ms`), ...st.scripts.map((w) => `[${w.name} ${w.ms} ms]`)].join(", ");
      lines.push(`  ${(st.at / 1000).toFixed(1)} s  ${st.ms} ms  ${what || "not named"}`);
    }
  }
  return lines.join("\n");
}

/** Forget everything recorded (for tests). */
export function clearStalls() {
  stalls.length = 0;
  spans.length = 0;
  total = 0;
  longest = 0;
}

/** For tests: record a freeze as the browser would report it. */
export function recordStallForTest(at: number, ms: number) {
  record(at, ms, []);
}
