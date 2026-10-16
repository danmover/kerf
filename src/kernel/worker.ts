/// <reference lib="webworker" />
// Geometry kernel worker: OpenCASCADE (WASM) runs here, off the UI thread.

import opencascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import * as R from "replicad";
import { KernelCore } from "./core";
import { errMsg, isTrap } from "./build";
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

let queue: Promise<void> = Promise.resolve();
function enqueue(fn: () => Promise<void>) {
  queue = queue.then(fn).catch(() => undefined);
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
    cancelled.add(msg.jobId);
    return;
  }
  if (msg.type === "init") {
    void init();
    return;
  }
  enqueue(async () => {
    await init();
    if (broken) return;
    switch (msg.type) {
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
            };
            post(
              { type: "part", jobId: msg.jobId, hash: item.hash, quality: msg.quality, mesh: copy, volume: entry.volume, bbox: entry.bbox, ms: performance.now() - t, warnings: entry.warnings.length ? entry.warnings : undefined },
              [copy.positions.buffer, copy.normals.buffer, copy.indices.buffer, copy.edges.buffer],
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
      case "inspect": {
        try {
          await ensureFonts(fontsIn(msg.req.recipe));
          post({ type: "inspected", jobId: msg.jobId, result: core.inspect(msg.req) });
        } catch (e) {
          if (isTrap(e)) return fatal(msg.jobId, e);
          post({ type: "inspect-error", jobId: msg.jobId, message: errMsg(e) });
        }
        return;
      }
      case "evict":
        core.evict(msg.keep);
        return;
    }
  });
};
