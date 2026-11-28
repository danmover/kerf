// The real-world fit check in the report: every fit, gear mesh and screw
// pattern judged over thousands of simulated builds. One summary line, a
// line for every gear mesh, and a line for each fit or pattern that fails
// or needs a look. The full list is in the analysis tab ("As made").
// Pure and cached per model, so it runs in every report, sub-agents too. The
// live design works it out between frames first (prepareFits).

import type { Model } from "../../core/model";
import type { CheckItem } from "../../core/checks";
import { inSlices } from "../../core/slices";
import { findFits, findFitsWork } from "./detect";
import { fitsKept, fitWork, fitWorkLeft, rememberFits, simulateFits, type FitOutcome, type FitReport } from "./simulate";
import type { FitsRequest, FitsResponse } from "./fits.worker";

const cache = new WeakMap<Model, FitReport>();
const jobs = new WeakMap<Model, Promise<void>>();

/** Fit results for a model (worked out once per model). */
export function fitReportFor(model: Model): FitReport {
  let r = cache.get(model);
  if (!r) {
    r = simulateFits(findFits(model), model);
    cache.set(model, r);
  }
  return r;
}

/**
 * The most that is worked out on the page itself, in simulated builds of one place (fitWorkLeft): a few milliseconds
 * between frames. More than that goes to the worker.
 */
const PAGE_WORK = 40;
/** A design of up to this many solids has its fits looked for on the page before the worker is thought of. */
const SMALL_DESIGN = 60;

/**
 * Work a model's fits out ahead of the report that asks for them, without stopping the page. On a large assembly
 * the simulated builds take a second or two; the design engine starts them here as soon as it has read the design,
 * so they run while the kernel checks the geometry. Answers from earlier runs are kept (simulate.ts), so after an
 * edit that leaves the fits alone the report is put together on the page between frames, at once; anything more
 * runs in a worker of its own, or where there is none (or it fails), on the page between frames. `wanted` going
 * false (the design changed again) drops the work. The results are the ones fitReportFor gives.
 */
export function prepareFits(model: Model, wanted: () => boolean = () => true): Promise<void> {
  let job = jobs.get(model);
  if (!job) {
    job = (async () => {
      const still = () => wanted() && !cache.has(model);
      let r = cache.get(model);
      // with answers kept from the last design, see how much of this one is new: little or nothing is done here,
      // with no trip to the worker to wait for (a small design is looked at the same way, kept answers or not)
      if (!r && channel.usable() && (fitsKept() || model.parts.length <= SMALL_DESIGN)) {
        const found = await inSlices(findFitsWork(model), still);
        const left = found && (await inSlices(fitWorkLeft(found, model), still));
        if (found && left !== null && left <= PAGE_WORK) r = (await inSlices(fitWork(found, model), still)) ?? undefined;
      }
      if (!r && !cache.has(model) && wanted()) r = await channel.run(model);
      if (!r && !cache.has(model) && wanted()) {
        const found = await inSlices(findFitsWork(model), still);
        r = (found && (await inSlices(fitWork(found, model), still))) ?? undefined;
      }
      if (r && !cache.has(model)) cache.set(model, r);
      // dropped part-way: the next to ask starts again
      else if (!cache.has(model)) jobs.delete(model);
    })();
    jobs.set(model, job);
  }
  return job;
}

/**
 * The fit worker, which only cares about the latest model it was given. It is never stopped part-way: what it works
 * out is kept, there and here, and the design that replaced the one it is on is mostly the same design.
 */
class FitsChannel {
  private w: Worker | null = null;
  private id = 0;
  private busy = false;
  /** the newest model handed over while the worker was on an older one */
  private next: FitsRequest | null = null;
  private waiter: ((r: FitReport | undefined) => void) | null = null;
  /** the worker could not be started or stopped unexpectedly: the page does the work from then on */
  private broken = false;

  /** a page only: tests, and code already in a worker, do the work where they are */
  usable(): boolean {
    return !this.broken && typeof Worker !== "undefined" && typeof document !== "undefined";
  }

  /** The model's fit report from the worker; undefined when there is no worker, it failed, or a newer model took its place. */
  run(model: Model): Promise<FitReport | undefined> {
    if (!this.usable()) return Promise.resolve(undefined);
    // whoever was waiting asked about a design that has been replaced
    this.settle(undefined);
    try {
      if (!this.w) {
        this.w = new Worker(new URL("./fits.worker.ts", import.meta.url), { type: "module", name: "kerf-fits" });
        this.w.onmessage = (ev: MessageEvent<FitsResponse>) => this.answered(ev.data);
        this.w.onerror = (ev) => {
          ev.preventDefault();
          this.fail();
        };
      }
      const request: FitsRequest = { id: ++this.id, model };
      return new Promise((resolve) => {
        this.waiter = resolve;
        if (this.busy) this.next = request;
        else this.post(request);
      });
    } catch {
      this.fail();
      return Promise.resolve(undefined);
    }
  }

  private post(request: FitsRequest) {
    this.busy = true;
    try {
      this.w!.postMessage(request);
    } catch {
      // a model that cannot be copied to the worker
      this.fail();
    }
  }

  private answered(m: FitsResponse) {
    this.busy = false;
    // kept whichever design it was for: an answer goes by what it was worked out from
    if (m.learned) rememberFits(m.learned);
    const next = this.next;
    this.next = null;
    if (m.id === this.id) this.settle(m.report);
    else if (next) this.post(next);
  }

  private settle(r: FitReport | undefined) {
    const w = this.waiter;
    this.waiter = null;
    w?.(r);
  }

  private fail() {
    this.broken = true;
    this.busy = false;
    this.next = null;
    this.w?.terminate();
    this.w = null;
    this.settle(undefined);
  }
}

const channel = new FitsChannel();

const KIND_WORD: Record<FitOutcome["kind"], string> = {
  "bearing-seat": "bearing seat",
  "bearing-shaft": "bearing on its shaft",
  "gear-bore": "gear bore",
  screw: "screw clearance",
  head: "screw head",
  locating: "locating spigot",
  pin: "pin or shaft",
  "gear-mesh": "gear mesh",
  "screw-pattern": "screw pattern",
};

export function fitItem(o: FitOutcome): CheckItem {
  return {
    id: `fit:${o.key}`,
    category: "fit",
    basis: "virtual test",
    status: o.status,
    title: o.kind === "gear-mesh" || o.kind === "screw-pattern" ? o.title : `Fit: ${o.title}`,
    detail: o.detail,
    parts: o.parts,
    fix: o.fix,
    margin: o.kind === "screw-pattern" ? o.made.p01 : undefined,
  };
}

/** Report pass: adds the fit checks. */
export function fitItems(items: CheckItem[], ctx: { model: Model }): CheckItem[] {
  const out = items.filter((i) => !i.id.startsWith("fit:"));
  const r = fitReportFor(ctx.model);
  if (!r.outcomes.length) return out;
  const fits = r.outcomes.filter((o) => o.kind !== "gear-mesh" && o.kind !== "screw-pattern");
  const bad = r.outcomes.filter((o) => o.status !== "pass");
  for (const o of r.outcomes) if (o.status !== "pass" || o.kind === "gear-mesh") out.push(fitItem(o));
  const instances = fits.reduce((s, o) => s + o.count, 0);
  const kinds = [...new Set(fits.map((o) => KIND_WORD[o.kind]))];
  const temps = r.temps.length ? `, at 20 °C and at ${r.temps.map((t) => `${t} °C`).join(" and ")} from the brief` : "";
  out.push({
    id: "fit:summary",
    category: "fit",
    basis: "virtual test",
    status: bad.some((o) => o.status === "fail") ? "fail" : bad.length ? "warn" : "pass",
    title: "Real-world fit",
    detail:
      `Built ${r.samples.toLocaleString("en")} times in simulation with every part a little off, the way its process makes it: ${fits.length} fits (${instances} places: ${kinds.join(", ")})` +
      `${r.outcomes.length > fits.length ? `, ${r.outcomes.length - fits.length} gear meshes and screw patterns` : ""}${temps}. ` +
      (bad.length ? `${bad.length} need${bad.length === 1 ? "s" : ""} attention: ${bad.map((o) => o.title).join("; ")}.` : "All of them go together and work in practically every build."),
  });
  return out;
}
