// Work that takes longer than a frame, done a few milliseconds at a time: the page draws and answers the mouse in
// between instead of stopping until it is done. The work is written as a generator that yields wherever it can be
// left for a moment.

let port: MessagePort | null = null;
const waiting: (() => void)[] = [];
/** how long the page took over its own turn the last time it was given one, and when that was */
let pageMs = 0;
let pageAt = -Infinity;
/** pieces of work that have let the page have its turn and not been given theirs back yet */
let paused = 0;

/** Let the page handle what is waiting for it (input, a frame), then carry on. */
export function breathe(): Promise<void> {
  const asked = performance.now();
  paused++;
  const back = (ok: () => void) => () => {
    paused--;
    pageAt = performance.now();
    pageMs = pageAt - asked;
    ok();
  };
  // on a page a message to ourselves comes back after input and drawing, without the 4 ms a repeated timer is held to
  if (typeof document !== "undefined" && typeof MessageChannel !== "undefined") {
    if (!port) {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => waiting.shift()?.();
      port = ch.port2;
    }
    return new Promise((ok) => {
      waiting.push(back(ok));
      port!.postMessage(0);
    });
  }
  return new Promise((ok) => setTimeout(back(ok), 0));
}

/** answers from a worker that work on the page is waiting for, each with until when it counts as work waiting */
const awaited = new Set<{ until: number }>();

/**
 * The page is waiting for `answer` from a worker to carry on with (an edit's checks from the kernel): for the next
 * `forMs` at most, that counts as work waiting for the page's turn. Whatever the page does at the moment the answer
 * comes holds it up for as long, and one more sample of a still picture is 50 ms and more on a large design.
 */
export function awaiting<T>(answer: Promise<T>, forMs = 400): Promise<T> {
  const mine = { until: performance.now() + forMs };
  awaited.add(mine);
  return answer.finally(() => {
    awaited.delete(mine);
  });
}

/**
 * True while work done a piece at a time is waiting for the page to have had its turn, or for a worker's answer it
 * goes on from (see awaiting). What the page chooses to do with that turn holds the work up for as long: something
 * that can as well be done a moment later (making a still picture finer) is better left until this says false.
 */
export function workWaiting(): boolean {
  if (paused > 0) return true;
  if (!awaited.size) return false;
  const now = performance.now();
  for (const a of awaited) if (now < a.until) return true;
  return false;
}

/** How long the page took over its last turn, if that was in the last couple of seconds (else 0: not known to be slow). */
function pageTurn(): number {
  return performance.now() - pageAt < 2000 ? pageMs : 0;
}

/** The most of one stretch a piece of sliced work takes, ms, however long the page takes over its own turns. */
const LONGEST_SLICE = 100;

/**
 * Run `work` to its end, letting the page breathe whenever `budgetMs` of it has been done since the last pause.
 * Stops early, with null, once `wanted` says the result is no longer needed.
 *
 * Where the page itself needs a long time for each of its turns (a large design on a slow graphics card, each
 * frame tens of milliseconds or more), a few milliseconds of work between two frames would make the work take many
 * times longer: there it gets half as long as the page's last turn took, up to a tenth of a second. The page is
 * never slowed by more than half, and the work never to less than a third of its speed.
 */
export async function inSlices<T>(work: Generator<void, T>, wanted: () => boolean = () => true, budgetMs = 6): Promise<T | null> {
  let budget = budgetMs;
  for (;;) {
    const t0 = performance.now();
    for (;;) {
      const step = work.next();
      if (step.done) return step.value;
      if (performance.now() - t0 >= budget) break;
    }
    const paused = performance.now();
    await breathe();
    if (!wanted()) return null;
    budget = sliceAfter(performance.now() - paused, budgetMs);
  }
}

/** How long the next stretch of sliced work may take, after the page took `pageMs` over its own turn. */
export function sliceAfter(pageMs: number, budgetMs = 6): number {
  return Math.max(budgetMs, Math.min(LONGEST_SLICE, pageMs / 2));
}

/**
 * For work done in a few larger steps: counts what the steps take, and lets the page breathe before the next one
 * only once they have added up to a stretch the page would feel (`budgetMs`, or more where the page's own turns are
 * slow: see inSlices). Steps that take no time to speak of run one after another with no pause, since every pause
 * costs a frame on a page that is busy drawing.
 */
export function pacer(budgetMs = 30): { step<T>(work: () => T): T; pause(): Promise<void> } {
  let spent = 0;
  return {
    step(work) {
      const t0 = performance.now();
      try {
        return work();
      } finally {
        spent += performance.now() - t0;
      }
    },
    async pause() {
      if (spent < sliceAfter(pageTurn(), budgetMs)) return;
      spent = 0;
      await breathe();
    },
  };
}
