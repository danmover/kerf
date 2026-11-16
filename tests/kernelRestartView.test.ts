// A geometry kernel restart (a job that ran too long, or OpenCASCADE crashing) must not take the model off the
// 3D view: the meshes stay, the parts are built again in the new worker, and the view sees no change.

import { beforeAll, describe, expect, it, vi } from "vitest";
import type { BuildItem } from "../src/kernel/protocol";

const k = vi.hoisted(() => {
  type Part = { hash: string; quality: string; mesh: unknown; volume: number; bbox: number[][]; ms: number };
  const mesh = () => ({ positions: new Float32Array(9), normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), edges: new Float32Array() });
  function fake() {
    const resets = new Set<() => void>();
    const listeners = new Set<() => void>();
    const c = {
      status: "ready" as string,
      error: "",
      initMs: 1,
      started: true,
      builds: [] as { quality: string; hashes: string[] }[],
      /** hashes the next builds fail on */
      failing: new Set<string>(),
      start: () => undefined,
      ready: () => Promise.resolve(),
      subscribe: (fn: () => void) => (listeners.add(fn), () => listeners.delete(fn)),
      onReset: (fn: () => void) => (resets.add(fn), () => resets.delete(fn)),
      reset: () => resets.forEach((fn) => fn()),
      evict: () => undefined,
      dropImport: () => undefined,
      isPoisoned: () => false,
      build(items: BuildItem[], quality: string, onPart: (p: Part) => void, onError: (h: string, m: string) => void) {
        c.builds.push({ quality, hashes: items.map((i) => i.hash) });
        const done = Promise.resolve().then(() => {
          for (const it of items) {
            if (c.failing.has(it.hash)) onError(it.hash, "OpenCASCADE crashed");
            else onPart({ hash: it.hash, quality, mesh: mesh(), volume: 1000, bbox: [[0, 0, 0], [10, 10, 10]], ms: 1 });
          }
          return { ms: 1, built: items.length, cached: 0, cancelled: false };
        });
        return { jobId: c.builds.length, done, cancel: () => undefined };
      },
      checks: () => Promise.resolve({ interferences: [], geo: {}, geoErrors: {}, access: [], envelopes: [], ms: 1, pairsTested: 0 }),
      process: () => Promise.resolve([]),
      faceCatalogues: () => Promise.resolve({}),
      inspect: () => Promise.resolve({}),
    };
    return c;
  }
  return { kernel: fake(), detailKernel: fake() };
});

vi.mock("../src/kernel/client", () => ({ kernel: k.kernel, detailKernel: k.detailKernel, STALL_MS: {} }));

const SRC = `design "Two blocks"
part a { body box(10, 10, 10) }
part b { body box(20, 10, 5, at: (30, 0, 0)) }
`;

let E: typeof import("../src/core/engine");

beforeAll(async () => {
  E = await import("../src/core/engine");
  E.startEngine();
});

async function settled() {
  await E.whenRefined(5000);
  // let the last microtasks and the mesh bump land
  await new Promise((r) => setTimeout(r, 30));
}

describe("a kernel restart keeps the model on screen", () => {
  it("rebuilds every part in the new worker without dropping a mesh", async () => {
    E.loadSource(SRC);
    await settled();
    const hashes = [...new Set(E.useDesign.getState().model!.parts.map((p) => p.hash))];
    expect(hashes.length).toBe(2);
    for (const h of hashes) expect(E.meshes.get(h)?.final).toBeTruthy();
    const shown = new Map(hashes.map((h) => [h, E.meshes.get(h)!]));
    const version = E.useDesign.getState().meshVersion;
    const before = k.kernel.builds.length;

    // what is on screen at every moment of the restart and rebuild
    let lowest = Infinity;
    const stop = E.useDesign.subscribe(() => (lowest = Math.min(lowest, hashes.filter((h) => E.meshes.get(h)).length)));
    k.kernel.reset();
    await settled();
    stop();

    // the new worker was asked for every part again, so checks have the solids they need
    const rebuilt = k.kernel.builds.slice(before).filter((b) => b.quality === "preview");
    expect(rebuilt.flatMap((b) => b.hashes).sort()).toEqual([...hashes].sort());
    // nothing left the view, and the meshes it shows are the same objects (no flicker, no new upload)
    expect(lowest).toBe(hashes.length);
    for (const h of hashes) expect(E.meshes.get(h)).toBe(shown.get(h));
    expect(E.useDesign.getState().meshVersion).toBe(version);
    expect(E.useDesign.getState().stage).toBe("done");
    expect(E.useDesign.getState().reportRev).toBe(E.useDesign.getState().rev);
  });

  it("takes a part off the view when the new worker can't build it again", async () => {
    const [a] = E.useDesign.getState().model!.parts;
    k.kernel.failing.add(a.hash);
    try {
      k.kernel.reset();
      await settled();
      expect(E.meshes.has(a.hash)).toBe(false);
      expect(E.useDesign.getState().buildErrors.get(a.hash)).toMatch(/crashed/);
    } finally {
      k.kernel.failing.clear();
    }
  });

  it("builds only what changed once the rebuild is done", async () => {
    E.loadSource(SRC);
    await settled();
    k.kernel.reset();
    await settled();
    const changed = SRC.replace("box(20, 10, 5,", "box(20, 10, 6,");
    E.setSource(changed, { force: true });
    await settled();
    const model = E.useDesign.getState().model!;
    const b = model.parts.find((p) => p.name === "b")!;
    const last = k.kernel.builds.filter((x) => x.quality === "preview").at(-1)!;
    expect(last.hashes).toEqual([b.hash]);
    expect(model.parts.every((p) => E.meshes.get(p.hash)?.final)).toBe(true);
  });
});
