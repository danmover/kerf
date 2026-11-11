/// <reference lib="webworker" />
// Geometry kernel worker: OpenCASCADE (WASM) runs here, off the UI thread.

import opencascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import * as R from "replicad";
import { KernelCore } from "./core";
import { measure as measurePick, projectView } from "./drawing";
import { dropImport, errMsg, isTrap, registerImport } from "./build";
import { readStep } from "./stepImport";
import type { FromWorker, ToWorker } from "./protocol";
import { fontsIn, type FontName } from "./recipe";
import { fontLoaded, loadFontData } from "./profiles";
import sansUrl from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff?url";
import monoUrl from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff?url";

const FONT_URLS: Record<FontName, string> = { sans: sansUrl, mono: monoUrl };

/** Text profiles need their font loaded before the (synchronous) build. */
async function ensureFonts(names: FontName[]) {
  for (const n of names) {
    if (fontLoaded(n)) continue;
    try {
      const res = await fetch(FONT_URLS[n]);
      await loadFontData(n, await res.arrayBuffer());
    } catch {
      /* the build reports the missing font */
    }
  }
}

const post = (m: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);
const core = new KernelCore();
const cancelled = new Set<number>();
let ready: Promise<void> | null = null;

function init() {
  if (!ready) {
    const t0 = performance.now();
    ready = (opencascade as unknown as (o: { locateFile: () => string }) => Promise<unknown>)({ locateFile: () => wasmUrl })
      .then((OC) => {
        R.setOC(OC as never);
        post({ type: "ready", ms: performance.now() - t0 });
      })
      .catch((e) => {
        post({ type: "init-error", message: e instanceof Error ? e.message : String(e) });
        throw e;
      });
  }
  return ready;
}

const yieldToEvents = () => new Promise((r) => setTimeout(r, 0));

// builds, checks and exports run first; drawing projections wait behind them
const urgent: (() => Promise<void>)[] = [];
const background: (() => Promise<void>)[] = [];
/** jobs queued or running, so a cancel for a finished job is not kept */
const live = new Set<number>();
let pumping = false;
function enqueue(fn: () => Promise<void>, later = false) {
  (later ? background : urgent).push(fn);
  void pump();
}
async function pump() {
  if (pumping) return;
  pumping = true;
  while (urgent.length || background.length) {
    const fn = urgent.shift() ?? background.shift()!;
    try {
      await fn();
    } catch {
      /* each job reports its own errors */
    }
    // let cancels and urgent jobs that arrived meanwhile in before the next job
    await yieldToEvents();
  }
  pumping = false;
}

/** After a WebAssembly trap OpenCASCADE's memory can be corrupt: report it, do nothing more, and wait to be replaced. */
let broken = false;
function fatal(jobId: number, e: unknown, hash?: string) {
  broken = true;
  post({ type: "fatal", jobId, hash, message: errMsg(e) });
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  if (msg.type === "cancel") {
    if (live.has(msg.jobId)) cancelled.add(msg.jobId);
    return;
  }
  if (msg.type === "init") {
    void init();
    return;
  }
  const jobId = "jobId" in msg ? msg.jobId : undefined;
  if (jobId !== undefined) live.add(jobId);
  const later = msg.type === "project";
  enqueue(async () => {
    try {
      // the client times the job the worker is running, and jobs can run out of order
      if (jobId !== undefined && !broken) post({ type: "started", jobId });
      await run(msg);
    } finally {
      if (jobId !== undefined) {
        live.delete(jobId);
        cancelled.delete(jobId);
      }
    }
  }, later);
};

async function run(msg: ToWorker) {
  {
    await init();
    if (broken) return;
    switch (msg.type) {
      case "project": {
        if (cancelled.delete(msg.jobId)) {
          post({ type: "job-error", jobId: msg.jobId, message: "cancelled" });
          return;
        }
        try {
          const result = projectView(msg.req, (p) => core.placed(p), (h) => core.mesh(h, "preview"));
          post({ type: "projected", jobId: msg.jobId, result });
        } catch (e) {
          if (isTrap(e)) return fatal(msg.jobId, e);
          post({ type: "job-error", jobId: msg.jobId, message: errMsg(e) });
        }
        return;
      }
      case "pick-measure": {
        try {
          const result = measurePick(msg.req, (h) => core.get(h)?.shape);
          post({ type: "pick-measured", jobId: msg.jobId, result });
        } catch (e) {
          if (isTrap(e)) return fatal(msg.jobId, e);
          post({ type: "job-error", jobId: msg.jobId, message: errMsg(e) });
        }
        return;
      }
      case "build": {
        const t0 = performance.now();
        let built = 0;
        let cached = 0;
        const seen = new Set<string>();
        for (const item of msg.items) {
          if (cancelled.has(msg.jobId)) break;
          if (seen.has(item.hash)) continue;
          seen.add(item.hash);
          const t = performance.now();
          try {
            if (core.has(item.hash)) cached++;
            else built++;
            await ensureFonts(fontsIn(item.recipe));
            const entry = core.build(item, msg.quality);
            const mesh = core.mesh(item.hash, msg.quality);
            // copy so the cached mesh stays usable for later requests
            const copy = {
              positions: mesh.positions.slice(),
              normals: mesh.normals.slice(),
              indices: mesh.indices.slice(),
              edges: mesh.edges.slice(),
              faceGroups: mesh.faceGroups?.slice(),
              edgeGroups: mesh.edgeGroups?.slice(),
              colors: mesh.colors?.slice(),
            };
            const transfer: Transferable[] = [copy.positions.buffer, copy.normals.buffer, copy.indices.buffer, copy.edges.buffer];
            if (copy.faceGroups) transfer.push(copy.faceGroups.buffer);
            if (copy.edgeGroups) transfer.push(copy.edgeGroups.buffer);
            if (copy.colors) transfer.push(copy.colors.buffer);
            post(
              { type: "part", jobId: msg.jobId, hash: item.hash, quality: msg.quality, mesh: copy, volume: entry.volume, bbox: entry.bbox, ms: performance.now() - t, warnings: entry.warnings.length ? entry.warnings : undefined },
              transfer,
            );
          } catch (e) {
            if (isTrap(e)) return fatal(msg.jobId, e, item.hash);
            post({ type: "part-error", jobId: msg.jobId, hash: item.hash, message: errMsg(e) });
          }
          await yieldToEvents();
        }
        post({ type: "built", jobId: msg.jobId, ms: performance.now() - t0, built, cached });
        cancelled.delete(msg.jobId);
        return;
      }
      case "checks": {
        try {
          const result = core.checks(msg.req);
          const transfer: Transferable[] = [];
          for (const i of result.interferences) if (i.mesh) transfer.push(i.mesh.positions.buffer, i.mesh.normals.buffer, i.mesh.indices.buffer, i.mesh.edges.buffer);
          post({ type: "checks", jobId: msg.jobId, result }, transfer);
        } catch (e) {
          if (isTrap(e)) return fatal(msg.jobId, e);
          post({ type: "checks-error", jobId: msg.jobId, message: errMsg(e) });
        }
        return;
      }
      case "export-step": {
        try {
          for (const it of msg.items) if (it.recipe) await ensureFonts(fontsIn(it.recipe));
          const blob = core.exportStep(msg.items);
          const data = await blob.arrayBuffer();
          post({ type: "exported", jobId: msg.jobId, data }, [data]);
        } catch (e) {
          if (isTrap(e)) return fatal(msg.jobId, e);
          post({ type: "export-error", jobId: msg.jobId, message: errMsg(e) });
        }
        return;
      }
      case "inspect-part": {
        try {
          await ensureFonts(fontsIn(msg.req.recipe));
          post({ type: "part-inspected", jobId: msg.jobId, result: core.inspectPart(msg.req) });
        } catch (e) {
          if (isTrap(e)) return fatal(msg.jobId, e);
          post({ type: "inspect-part-error", jobId: msg.jobId, message: errMsg(e) });
        }
        return;
      }
      case "process": {
        try {
          post({ type: "process", jobId: msg.jobId, results: core.process(msg.probes) });
        } catch (e) {
          if (isTrap(e)) return fatal(msg.jobId, e);
          post({ type: "process-error", jobId: msg.jobId, message: errMsg(e) });
        }
        return;
      }
      case "evict":
        core.evict(msg.keep);
        return;
      case "inspect":
        // inspect() reports each part's own error; only a trap gets out
        try {
          post({ type: "inspected", jobId: msg.jobId, result: core.inspect(msg.hashes) });
        } catch (e) {
          if (isTrap(e)) return fatal(msg.jobId, e);
          throw e;
        }
        return;
      case "faces":
        // faces() reports each part's own error; only a trap gets out
        try {
          post({ type: "faces", jobId: msg.jobId, result: core.faces(msg.hashes) });
        } catch (e) {
          if (isTrap(e)) return fatal(msg.jobId, e);
          throw e;
        }
        return;
      case "import-step": {
        try {
          const loaded = readStep(new Uint8Array(msg.data), msg.file, { analyse: msg.analyse, hash: msg.hash });
          registerImport(msg.hash, loaded.bodies, loaded.faceColors);
          post({ type: "imported", jobId: msg.jobId, hash: msg.hash, meta: loaded.meta });
        } catch (e) {
          if (isTrap(e)) return fatal(msg.jobId, e);
          post({ type: "import-error", jobId: msg.jobId, hash: msg.hash, message: e instanceof Error ? e.message : typeof e === "number" ? `OpenCASCADE error ${e}` : String(e) });
        }
        return;
      }
      case "drop-import":
        dropImport(msg.hash);
        return;
      case "measure": {
        try {
          post({ type: "measured", jobId: msg.jobId, result: core.measure(msg.a, msg.b) });
        } catch (e) {
          if (isTrap(e)) return fatal(msg.jobId, e);
          post({ type: "measure-error", jobId: msg.jobId, message: errMsg(e) });
        }
        return;
      }
    }
  }
}
