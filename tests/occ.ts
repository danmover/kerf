// Loads OpenCASCADE (and the text fonts) once for kernel tests in Node.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as R from "replicad";
import { loadFontData } from "../src/kernel/profiles";

let ready: Promise<void> | null = null;

const buf = (path: string) => {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

export function loadOC(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const require = createRequire(import.meta.url);
      const init = require("replicad-opencascadejs");
      const OC = await (init.default ?? init)({ wasmBinary: readFileSync(require.resolve("replicad-opencascadejs/wasm")) });
      R.setOC(OC);
      await loadFontData("sans", buf(require.resolve("@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff")));
      await loadFontData("mono", buf(require.resolve("@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff")));
    })();
  }
  return ready;
}
