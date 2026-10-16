// Starts OpenCASCADE (replicad) in Node so tests can build real solids.

import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as R from "replicad";

let ready: Promise<void> | undefined;

export function initKernel(): Promise<void> {
  ready ??= (async () => {
    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve("replicad-opencascadejs/wasm");
    const mod = await import("replicad-opencascadejs");
    const oc = await (mod.default as unknown as (o: { locateFile: () => string }) => Promise<unknown>)({ locateFile: () => wasmPath });
    R.setOC(oc as never);
    void fileURLToPath;
  })();
  return ready;
}
