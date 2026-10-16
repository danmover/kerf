import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelClient, STALL_MS } from "../src/kernel/client";
import type { BuildItem, ChecksRequest, FromWorker, ToWorker } from "../src/kernel/protocol";

/**
 * A stand-in for the kernel worker. Like the real one it works through jobs one at a time. Parts build at once,
 * except "wait<ms>" (takes that long), "slow…" (never finishes) and "trap…" (WebAssembly traps).
 */
class FakeWorker {
  onmessage: ((ev: { data: FromWorker }) => void) | null = null;
  onerror: unknown = null;
  terminated = false;
  builds: string[][] = [];
  private queue = Promise.resolve();

  constructor(private readonly opts: { slowChecks?: (req: ChecksRequest) => boolean }) {}

  postMessage(m: ToWorker) {
    if (m.type === "init") return this.reply({ type: "ready", ms: 1 });
    this.queue = this.queue.then(() => this.run(m));
  }

  terminate() {
    this.terminated = true;
  }

  private reply(r: FromWorker) {
    if (!this.terminated) this.onmessage?.({ data: r });
  }

  private async run(m: ToWorker) {
    const never = () => new Promise<void>(() => undefined);
    if (m.type === "build") {
      this.builds.push(m.items.map((it) => it.hash));
      for (const it of m.items) {
        if (it.hash.startsWith("slow")) return never();
        if (it.hash.startsWith("trap")) return this.reply({ type: "fatal", jobId: m.jobId, hash: it.hash, message: "memory access out of bounds" });
        if (it.hash.startsWith("wait")) await new Promise((r) => setTimeout(r, Number(it.hash.slice(4))));
        this.reply({ type: "part", jobId: m.jobId, hash: it.hash, quality: m.quality, mesh: { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(), edges: new Float32Array() }, volume: 1, bbox: [[0, 0, 0], [1, 1, 1]], ms: 1 });
      }
      this.reply({ type: "built", jobId: m.jobId, ms: 1, built: m.items.length, cached: 0 });
    }
    if (m.type === "checks") {
      if (this.opts.slowChecks?.(m.req)) return never();
      this.reply({ type: "checks", jobId: m.jobId, result: { interferences: [], geo: {}, geoErrors: {}, access: [], envelopes: [], ms: 1, pairsTested: 0 } });
    }
  }
}

const item = (hash: string): BuildItem => ({ hash, recipe: { base: { t: "box", w: 1, d: 1, h: 1, at: [0, 0, 0], r: 0 }, ops: [] }, label: hash });
const checksReq = (id: string): ChecksRequest => ({ placed: [{ id, name: id, label: id, hash: id, xf: [], removable: false, moving: false, density: 1 }], queries: [], access: [], envelopes: [], ignorePairs: [] });

function setup(opts: ConstructorParameters<typeof FakeWorker>[0] = {}) {
  const workers: FakeWorker[] = [];
  const client = new KernelClient("test", () => {
    const w = new FakeWorker(opts);
    workers.push(w);
    return w as unknown as Worker;
  });
  let resets = 0;
  client.onReset(() => resets++);
  client.start();
  const build = (hashes: string[], quality: "preview" | "final" = "preview") => {
    const parts: string[] = [];
    const errors: [string, string][] = [];
    const job = client.build(hashes.map(item), quality, (p) => parts.push(p.hash), (h, msg) => errors.push([h, msg]));
    return { job, parts, errors };
  };
  return { client, workers, build, resets: () => resets };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("kernel watchdog", () => {
  it("stops a part that stalls the worker, reports it, and refuses it from then on", async () => {
    const k = setup();
    await k.client.ready();
    const first = k.build(["a", "slow1", "b"]);
    await vi.advanceTimersByTimeAsync(STALL_MS.preview - 1000);
    expect(first.parts).toEqual(["a"]);
    expect(first.errors).toEqual([]);

    await vi.advanceTimersByTimeAsync(2000);
    expect(first.errors.map((e) => e[0])).toEqual(["slow1"]);
    expect(first.errors[0][1]).toMatch(/stopped building it after 60 s/);
    expect((await first.job.done).cancelled).toBe(true);
    // a fresh worker, and the design asked to rebuild; a stall is not counted as a crash
    expect(k.workers.length).toBe(2);
    expect(k.workers[0].terminated).toBe(true);
    expect(k.resets()).toBe(1);
    expect(k.client.restarts).toBe(0);

    await k.client.ready();
    const again = k.build(["slow1", "b"]);
    const r = await again.job.done;
    expect(r.cancelled).toBe(false);
    expect(again.errors.map((e) => e[0])).toEqual(["slow1"]);
    expect(again.parts).toEqual(["b"]);
    expect(k.workers[1].builds).toEqual([["b"]]);
    // only the quality that stalled is refused
    expect(k.client.isPoisoned("slow1", "preview")).toBe(true);
    expect(k.client.isPoisoned("slow1", "final")).toBe(false);
  });

  it("gives every part its own time, so a long list of slow but finishing parts is not stopped", async () => {
    const k = setup();
    await k.client.ready();
    const job = k.build(["wait40000", "wait41000", "wait42000"]);
    await vi.advanceTimersByTimeAsync(130_000);
    expect(job.errors).toEqual([]);
    expect(job.parts.length).toBe(3);
    expect((await job.job.done).cancelled).toBe(false);
    expect(k.workers.length).toBe(1);
  });

  it("does not run the clock while the worker is still loading or idle", async () => {
    const k = setup();
    await vi.advanceTimersByTimeAsync(10 * STALL_MS.final);
    expect(k.workers.length).toBe(1);
  });

  it("stops checks that stall and refuses the same request again", async () => {
    const k = setup({ slowChecks: (req) => req.placed[0].id === "heavy" });
    await k.client.ready();
    const stuck = k.client.checks(checksReq("heavy"));
    const caught = stuck.catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(STALL_MS.checks + 10);
    expect(await caught).toMatch(/ran for more than 120 s/);
    expect(k.workers.length).toBe(2);
    await k.client.ready();
    await expect(k.client.checks(checksReq("heavy"))).rejects.toThrow(/ran for more than 120 s/);
    await expect(k.client.checks(checksReq("light"))).resolves.toMatchObject({ pairsTested: 0 });
  });

  it("replaces the worker after a WebAssembly trap, and gives up on a part that traps twice", async () => {
    const k = setup();
    await k.client.ready();
    const first = k.build(["trap1"]);
    expect((await first.job.done).cancelled).toBe(true);
    // the first time could be memory running out: no error yet, just a fresh worker
    expect(first.errors).toEqual([]);
    expect(k.workers.length).toBe(2);

    await k.client.ready();
    const second = k.build(["trap1"]);
    await second.job.done;
    expect(second.errors[0][1]).toMatch(/OpenCASCADE crashed \(memory access out of bounds\)/);
    expect(k.workers.length).toBe(3);

    await k.client.ready();
    const third = k.build(["trap1", "ok"]);
    await third.job.done;
    expect(third.errors.map((e) => e[0])).toEqual(["trap1"]);
    expect(third.parts).toEqual(["ok"]);
    expect(k.workers.length).toBe(3);
  });
});
