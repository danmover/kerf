// Starts OpenCASCADE (replicad) and the geometry core in Node so tests can build
// real solids and check them, with the lettering fonts the app's kernel worker loads.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as R from "replicad";
import { loadFontData } from "../../src/kernel/profiles";
import { startGeomCore } from "../../src/geom/core";

let ready: Promise<void> | undefined;

export function initKernel(): Promise<void> {
  ready ??= (async () => {
    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve("replicad-opencascadejs/wasm");
    const mod = await import("replicad-opencascadejs");
    const oc = await (mod.default as unknown as (o: { locateFile: () => string }) => Promise<unknown>)({ locateFile: () => wasmPath });
    R.setOC(oc as never);
    // the geometry core the worker starts beside the kernel
    startGeomCore(readFileSync(new URL("../../src/geom/kerf_geom.wasm", import.meta.url)));
    const buf = (path: string) => {
      const b = readFileSync(require.resolve(path));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    };
    await loadFontData("sans", buf("@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff"));
    await loadFontData("mono", buf("@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff"));
  })();
  return ready;
}
